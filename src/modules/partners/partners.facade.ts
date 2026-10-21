import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import {
  businessPartners,
  partnerClientLinks,
  type BusinessPartner,
  type PartnerClientLink,
  type PartnerLinkRole,
  type PartnerRole,
  type PartnerStatus,
} from '../../shared/db/schema';
import { UUID_RE } from '../../shared/primitives/ids';
import { canonicalInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import type { RegisteredAddressSnapshot } from '../../shared/primitives/registered-address';
import { getClientLabelsInTx } from '../clients/clients.facade';

/**
 * The partners module's public seam (story 1-3). Siblings reach the
 * `business_partners` / `partner_client_links` tables ONLY through this file:
 * the injectable `PartnersFacade` (the list read) and the file-level `…InTx`
 * functions that run on the caller's transaction (the `clients.facade`
 * shape) — the PO guard and the replenishment sweep's default-vendor pick.
 * Only `src/modules/partners` writes either table (test/architecture.spec.ts).
 */

/** One client link as every read returns it. */
export interface PartnerLinkSnapshot {
  readonly id: string;
  readonly clientId: string;
  readonly role: PartnerLinkRole;
  readonly active: boolean;
  readonly isDefault: boolean;
  readonly clientCode: string | null;
}

/** One partner as every read and mutation returns it — its links inline. */
export interface PartnerSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly pan: string | null;
  readonly roles: readonly PartnerRole[];
  readonly registeredAddress: RegisteredAddressSnapshot | null;
  readonly dispatchAddress: RegisteredAddressSnapshot | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly status: PartnerStatus;
  readonly inactiveReason: string | null;
  readonly links: readonly PartnerLinkSnapshot[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Every partner mutation's response (the idempotency snapshot). */
export interface PartnerMutationSnapshot {
  readonly partner: PartnerSnapshot;
}

/**
 * The vendor as a purchase order freezes it (story 1-3, shape v1). EVERY key
 * is always present, null where empty — the readers that print it (the 2.9
 * GRN header, the inward e-way bill, return-to-vendor) handle exactly one
 * shape. `stateCode` is the registered address's state, else the GSTIN's
 * prefix (they agree when both are set — `gstin-state-mismatch`).
 */
export interface VendorSnapshotV1 {
  readonly v: 1;
  readonly code: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  readonly registeredAddress: RegisteredAddressSnapshot | null;
  readonly dispatchAddress: RegisteredAddressSnapshot | null;
}

export interface ListPartnersQuery {
  readonly role?: PartnerRole | undefined;
  readonly clientId?: string | undefined;
  readonly status?: PartnerStatus | undefined;
  readonly q?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const DEFAULT_PARTNER_PAGE_SIZE = 50;

export interface PartnerPage {
  readonly items: readonly PartnerSnapshot[];
  readonly nextCursor: string | null;
}

/** The registered-shape address of one group of columns, or null when the group is empty. */
function addressOf(
  line1: string | null,
  line2: string | null,
  city: string | null,
  stateCode: string | null,
  pincode: string | null,
): RegisteredAddressSnapshot | null {
  if (line1 === null || city === null || stateCode === null || pincode === null) return null;
  return { line1, line2, city, stateCode, pincode };
}

export function registeredAddressOf(row: BusinessPartner): RegisteredAddressSnapshot | null {
  return addressOf(row.registeredLine1, row.registeredLine2, row.registeredCity, row.registeredStateCode, row.registeredPincode);
}

export function dispatchAddressOf(row: BusinessPartner): RegisteredAddressSnapshot | null {
  return addressOf(row.dispatchLine1, row.dispatchLine2, row.dispatchCity, row.dispatchStateCode, row.dispatchPincode);
}

export function toLinkSnapshot(row: PartnerClientLink): PartnerLinkSnapshot {
  return {
    id: row.id,
    clientId: row.clientId,
    role: row.role as PartnerLinkRole,
    active: row.active,
    isDefault: row.isDefault,
    clientCode: row.clientCode,
  };
}

export function toPartnerSnapshot(row: BusinessPartner, links: readonly PartnerClientLink[]): PartnerSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    legalName: row.legalName,
    gstin: row.gstin,
    pan: row.pan,
    roles: row.roles as PartnerRole[],
    registeredAddress: registeredAddressOf(row),
    dispatchAddress: dispatchAddressOf(row),
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    status: row.status as PartnerStatus,
    inactiveReason: row.inactiveReason,
    links: links.map(toLinkSnapshot),
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

/** The v1 vendor snapshot of a partner row (every key present). */
export function vendorSnapshotOf(row: BusinessPartner): VendorSnapshotV1 {
  return {
    v: 1,
    code: row.code,
    name: row.name,
    legalName: row.legalName,
    gstin: row.gstin,
    stateCode: row.registeredStateCode ?? (row.gstin === null ? null : row.gstin.slice(0, 2)),
    registeredAddress: registeredAddressOf(row),
    dispatchAddress: dispatchAddressOf(row),
  };
}

/** A partner's links, oldest first (the order every read returns). */
export async function linksOfInTx(
  tx: TenantTx,
  tenantId: string,
  partnerIds: readonly string[],
): Promise<Map<string, PartnerClientLink[]>> {
  const byPartner = new Map<string, PartnerClientLink[]>();
  if (partnerIds.length === 0) return byPartner;
  const rows = await tx
    .select()
    .from(partnerClientLinks)
    .where(and(eq(partnerClientLinks.tenantId, tenantId), inArray(partnerClientLinks.partnerId, [...new Set(partnerIds)])))
    .orderBy(asc(partnerClientLinks.createdAt), asc(partnerClientLinks.id));
  for (const row of rows) {
    const list = byPartner.get(row.partnerId) ?? [];
    list.push(row);
    byPartner.set(row.partnerId, list);
  }
  return byPartner;
}

/**
 * Story 1-3 — THE vendor guard of a new purchase order (PO create and the
 * suggested-PO submit, through `createInTx`), on the caller's transaction,
 * AFTER the PO's client is derived and `assertClientTakesWorkInTx` ran (lock
 * order client → partner → link). Takes the partner row and the link row
 * `FOR KEY SHARE`: that conflicts only with `FOR UPDATE`, which the status
 * flip and a link's active/default flip take — so a deactivation and a PO
 * create serialise (the PO commits first, or it reads the inactive row and
 * is refused). An edit of non-key columns (name, addresses, contact) takes
 * `FOR NO KEY UPDATE` and never queues a PO; a CODE change rewrites a column
 * of a unique index, which Postgres locks as `FOR UPDATE`, so a code rename
 * does queue behind (and block) an in-flight PO create — briefly, by design.
 *
 * Refusals, in order: unknown vendor 404 · no vendor role 409
 * `partner-not-vendor` · inactive 409 `vendor-inactive` · no ACTIVE vendor
 * link to the client 409 `vendor-not-linked` naming the client. Returns the
 * v1 snapshot the PO freezes.
 */
export async function assertVendorLinkedInTx(
  tx: TenantTx,
  tenantId: string,
  vendorId: string,
  clientId: string,
): Promise<VendorSnapshotV1> {
  const partnerRows = UUID_RE.test(vendorId)
    ? await tx
        .select()
        .from(businessPartners)
        .where(and(eq(businessPartners.tenantId, tenantId), eq(businessPartners.id, vendorId)))
        .limit(1)
        .for('key share')
    : [];
  const partner = partnerRows[0];
  if (partner === undefined) {
    throw new ProblemException('not-found', 404, 'Vendor not found', 'No vendor with this id exists in this tenant.');
  }
  if (!partner.roles.includes('vendor')) {
    throw new ProblemException(
      'partner-not-vendor',
      409,
      'Partner is not a vendor',
      `Partner "${partner.code}" does not have the vendor role — add the role in Settings → Partners, or choose a vendor.`,
    );
  }
  if (partner.status !== 'active') {
    throw new ProblemException(
      'vendor-inactive',
      409,
      'Vendor is inactive',
      `Vendor "${partner.code}" is inactive — it cannot go on a new purchase order. Reactivate it in Settings → Partners, or choose another vendor.`,
    );
  }
  const linkRows = await tx
    .select({ id: partnerClientLinks.id, active: partnerClientLinks.active })
    .from(partnerClientLinks)
    .where(
      and(
        eq(partnerClientLinks.tenantId, tenantId),
        eq(partnerClientLinks.partnerId, partner.id),
        eq(partnerClientLinks.clientId, clientId),
        eq(partnerClientLinks.role, 'vendor'),
      ),
    )
    .limit(1)
    .for('key share');
  const link = linkRows[0];
  if (link === undefined || !link.active) {
    const label = (await getClientLabelsInTx(tx, tenantId, [clientId])).get(clientId) ?? clientId;
    throw new ProblemException(
      'vendor-not-linked',
      409,
      'Vendor not linked to the client',
      `Vendor "${partner.code}" is not an active vendor of client ${label} — link it to that client in Settings → Partners, or choose one of the client's vendors.`,
    );
  }
  return vendorSnapshotOf(partner);
}

/**
 * Story 2-3a — a transporter as a gate-in freezes it: the vendor snapshot's
 * v1 shape (`vendorSnapshotOf`), every key present, null where empty. Frozen
 * at record time (and re-frozen only when an amend names another
 * transporter); a partner edit never rewrites it.
 */
export type TransporterSnapshotV1 = VendorSnapshotV1;

/**
 * Story 2-3a (decision 4) — THE transporter guard of a gate-in (its create,
 * and an amend that names a different transporter), on the caller's
 * transaction. A transporter is never linked to a client (`PARTNER_LINK_ROLES`
 * — shared by every client), so this reads only the partner row, `FOR KEY
 * SHARE` — the PO guard's mode: it conflicts only with the status flip's
 * `FOR UPDATE`, so a deactivation and a gate-in serialise, while an edit of
 * the partner's non-key columns never queues the gate desk.
 *
 * Refusals, in order: unknown partner 404 · no transporter role 409
 * `partner-not-transporter` · inactive 409 `transporter-inactive`. Returns
 * the v1 snapshot the gate-in freezes.
 */
export async function assertTransporterInTx(
  tx: TenantTx,
  tenantId: string,
  partnerId: string,
): Promise<TransporterSnapshotV1> {
  const partnerRows = UUID_RE.test(partnerId)
    ? await tx
        .select()
        .from(businessPartners)
        .where(and(eq(businessPartners.tenantId, tenantId), eq(businessPartners.id, partnerId)))
        .limit(1)
        .for('key share')
    : [];
  const partner = partnerRows[0];
  if (partner === undefined) {
    throw new ProblemException('not-found', 404, 'Transporter not found', 'No transporter partner with this id exists in this tenant.');
  }
  if (!partner.roles.includes('transporter')) {
    throw new ProblemException(
      'partner-not-transporter',
      409,
      'Partner is not a transporter',
      `Partner "${partner.code}" does not have the transporter role — add the role in Settings → Partners, choose a transporter, or type the transporter's name.`,
    );
  }
  if (partner.status !== 'active') {
    throw new ProblemException(
      'transporter-inactive',
      409,
      'Transporter is inactive',
      `Transporter "${partner.code}" is inactive — it cannot go on a new gate-in. Reactivate it in Settings → Partners, choose another transporter, or type the name.`,
    );
  }
  return vendorSnapshotOf(partner);
}

/**
 * Story 1-3 — the client's DEFAULT vendor (decision 2): the active partner
 * holding the vendor role whose ACTIVE vendor link to the client is the
 * default (at most one — the partial unique). Null when the client has none:
 * the sweep then drafts with `vendorId: null` and a person picks one.
 * Unlocked read; the submit re-runs the full guard.
 */
export async function findDefaultVendorForClientInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<{ id: string; code: string; name: string } | null> {
  const rows = await tx
    .select({ id: businessPartners.id, code: businessPartners.code, name: businessPartners.name })
    .from(partnerClientLinks)
    .innerJoin(
      businessPartners,
      and(eq(businessPartners.tenantId, partnerClientLinks.tenantId), eq(businessPartners.id, partnerClientLinks.partnerId)),
    )
    .where(
      and(
        eq(partnerClientLinks.tenantId, tenantId),
        eq(partnerClientLinks.clientId, clientId),
        eq(partnerClientLinks.isDefault, true),
        eq(partnerClientLinks.active, true),
        eq(partnerClientLinks.role, 'vendor'),
        eq(businessPartners.status, 'active'),
        sql`'vendor' = any(${businessPartners.roles})`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** The vendor display names of `partnerIds` (id → name) — the device snapshot's `vendorName`. */
export async function partnerNamesInTx(
  tx: TenantTx,
  tenantId: string,
  partnerIds: readonly string[],
): Promise<Map<string, string>> {
  const distinct = [...new Set(partnerIds)];
  if (distinct.length === 0) return new Map();
  const rows = await tx
    .select({ id: businessPartners.id, name: businessPartners.name })
    .from(businessPartners)
    .where(and(eq(businessPartners.tenantId, tenantId), inArray(businessPartners.id, distinct)));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** The list cursor: the last row's `(code, id)` — the list's own order. */
interface PartnerCursor {
  readonly code: string;
  readonly id: string;
}

export function encodePartnerCursor(cursor: PartnerCursor): string {
  return Buffer.from(JSON.stringify({ code: cursor.code, id: cursor.id }), 'utf8').toString('base64url');
}

function decodePartnerCursor(cursor: string): PartnerCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as PartnerCursor).code === 'string' &&
      typeof (parsed as PartnerCursor).id === 'string' &&
      UUID_RE.test((parsed as PartnerCursor).id)
    ) {
      return { code: (parsed as PartnerCursor).code, id: (parsed as PartnerCursor).id };
    }
  } catch {
    // fall through to the 400
  }
  throw new ProblemException('invalid-cursor', 400, 'Malformed pagination cursor', 'The cursor parameter is not a valid opaque page cursor.');
}

/** `ILIKE` with the pattern characters escaped — `q` matches literally. */
export function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

@Injectable()
export class PartnersFacade {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * `GET /partners` — a keyset page ordered by `(code, id)`, each partner
   * with its links inline. `role` keeps partners holding that role;
   * `clientId` keeps partners with an ACTIVE link to the client (in `role`
   * when given, else in any link role) — an `EXISTS`, so a partner appears
   * once; `status` filters; `q` is an escaped `ILIKE` over code, name, legal
   * name and GSTIN. A read — open to every staff member.
   */
  async list(tenantId: string, query: ListPartnersQuery = {}): Promise<PartnerPage> {
    const pageSize = query.limit ?? DEFAULT_PARTNER_PAGE_SIZE;
    const after = query.cursor === undefined ? undefined : decodePartnerCursor(query.cursor);
    const q = query.q?.trim();
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(businessPartners.tenantId, tenantId),
        query.role === undefined ? undefined : sql`${query.role} = any(${businessPartners.roles})`,
        query.status === undefined ? undefined : eq(businessPartners.status, query.status),
        query.clientId === undefined
          ? undefined
          : sql`exists (
              select 1 from partner_client_links l
              where l.tenant_id = ${businessPartners.tenantId}
                and l.partner_id = ${businessPartners.id}
                and l.client_id = ${query.clientId}::uuid
                and l.active
                ${query.role === undefined ? sql`` : sql`and l.role = ${query.role}`}
            )`,
        q === undefined || q === ''
          ? undefined
          : sql`(${businessPartners.code} ilike ${likeContains(q)}
                 or ${businessPartners.name} ilike ${likeContains(q)}
                 or ${businessPartners.legalName} ilike ${likeContains(q)}
                 or ${businessPartners.gstin} ilike ${likeContains(q)})`,
        after === undefined
          ? undefined
          : sql`(${businessPartners.code}, ${businessPartners.id}) > (${after.code}, ${after.id}::uuid)`,
      ];
      const rows = await tx
        .select()
        .from(businessPartners)
        .where(and(...where))
        .orderBy(asc(businessPartners.code), asc(businessPartners.id))
        .limit(pageSize + 1);
      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      const links = await linksOfInTx(
        tx,
        tenantId,
        page.map((row) => row.id),
      );
      const last = page.at(-1);
      return {
        items: page.map((row) => toPartnerSnapshot(row, links.get(row.id) ?? [])),
        nextCursor: hasMore && last !== undefined ? encodePartnerCursor({ code: last.code, id: last.id }) : null,
      };
    });
  }

}
