import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { MAX_CLIENT_LIST, clients, type ClientStatus } from './clients.schema';
import type { UserRole, UserStatus } from '../../shared/db/schema';
import { getMemberPortalFactsIn } from '../tenancy/tenancy.service';

/** One client as every read of this module returns it. */
export interface ClientSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly status: ClientStatus;
  /** True only for the tenant's own `self` client (its goods, its invoices). */
  readonly systemOwned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Story 21-5 — the tax details a services tax invoice names the recipient
   * by. All nullable (never required at create); written only by
   * `ClientsCommand.updateTaxDetails`.
   */
  readonly taxDetails: ClientTaxDetails;
}

/** Story 21-5 — a client's tax details (every field nullable). */
export interface ClientTaxDetails {
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly billingLine1: string | null;
  readonly billingLine2: string | null;
  readonly billingCity: string | null;
  /** A two-digit GST registration state code. */
  readonly billingStateCode: string | null;
  readonly billingPincode: string | null;
}

/** The facts the attribution rules need about one client (bulk read). */
export interface ClientFacts {
  readonly id: string;
  readonly code: string;
  readonly systemOwned: boolean;
}

export function toClientSnapshot(row: typeof clients.$inferSelect): ClientSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    status: row.status as ClientStatus,
    systemOwned: row.systemOwned,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    taxDetails: {
      legalName: row.legalName,
      gstin: row.gstin,
      billingLine1: row.billingLine1,
      billingLine2: row.billingLine2,
      billingCity: row.billingCity,
      billingStateCode: row.billingStateCode,
      billingPincode: row.billingPincode,
    },
  };
}

/**
 * The clients module's read seam (story 21-2b). Sibling modules reach the
 * `clients` table ONLY through this file and `ensure-self-client.ts` — the
 * file-level `…InTx` functions run on the CALLER's transaction (the
 * `ensureSelfClientInTx` seam shape), the injectable facade owns its own.
 */
@Injectable()
export class ClientsFacade {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Every client of the tenant, any status — the system-owned `self` client
   * first, then by code. Bounded at `MAX_CLIENT_LIST` (unpaginated by
   * design: the list feeds pickers that need the whole set). A read —
   * member-open, never capability-gated.
   */
  async listClients(tenantId: string): Promise<ClientSnapshot[]> {
    return withTenantTransaction(this.db, tenantId, (tx) => listClientsInTx(tx, tenantId));
  }

  /**
   * Story 1-1 — the device catalog snapshot's `clients` arm: the named
   * clients (every client a SKU or an open document of the snapshot
   * references), `{id, code, name, active}`, in the `listClients` order. An
   * id the tenant does not hold is absent. A read in its own transaction —
   * the api shell composes it beside the other arms, never nested.
   */
  async snapshotClients(
    tenantId: string,
    clientIds: readonly string[],
  ): Promise<{ id: string; code: string; name: string; active: boolean }[]> {
    const wanted = new Set(clientIds);
    if (wanted.size === 0) {
      return [];
    }
    const all = await this.listClients(tenantId);
    return all
      .filter((client) => wanted.has(client.id))
      .map((client) => ({ id: client.id, code: client.code, name: client.name, active: client.status === 'active' }));
  }

  /** Story 21-7 — `GET …/portal/me` (see `portalMeIn`). */
  async portalMe(tenantId: string, userId: string, clientId: string): Promise<PortalMe> {
    return portalMeIn(this.db, tenantId, userId, clientId);
  }
}

export async function listClientsInTx(tx: TenantTx, tenantId: string): Promise<ClientSnapshot[]> {
  const rows = await tx
    .select()
    .from(clients)
    .where(eq(clients.tenantId, tenantId))
    .orderBy(desc(clients.systemOwned), asc(clients.code))
    .limit(MAX_CLIENT_LIST);
  return rows.map(toClientSnapshot);
}

/**
 * The client must exist in this tenant — 404 `not-found` otherwise (a
 * foreign tenant's client is indistinguishable from an unknown id). Returns
 * the row's facts.
 */
export async function assertClientInTenantInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<ClientFacts> {
  const rows = await tx
    .select({ id: clients.id, code: clients.code, systemOwned: clients.systemOwned })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw clientNotFound(clientId);
  }
  return row;
}

/**
 * Story 21-5 — one client's full snapshot (its tax details included), 404
 * `not-found` when absent. Billing's client invoice reads the recipient
 * through it (after locking the row with `lockClientInTx`).
 */
export async function getClientInTx(tx: TenantTx, tenantId: string, clientId: string): Promise<ClientSnapshot> {
  const rows = await tx
    .select()
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw clientNotFound(clientId);
  }
  return toClientSnapshot(row);
}

/** A client's facts plus its status — what a priced relationship checks (21-3). */
export interface LockedClientFacts extends ClientFacts {
  readonly status: ClientStatus;
}

/**
 * Story 21-3 — lock the client row (`FOR UPDATE`) on the caller's
 * transaction and return its facts, 404 `not-found` when absent. The rate-card
 * activation and cancel commands serialise on it: every card transition of
 * one client runs under this one row lock, so two activations can never
 * interleave. A lock, never a write — the clients module still owns the table.
 */
export async function lockClientInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<LockedClientFacts> {
  const rows = await tx
    .select({ id: clients.id, code: clients.code, systemOwned: clients.systemOwned, status: clients.status })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1)
    .for('update');
  const row = rows[0];
  if (row === undefined) {
    throw clientNotFound(clientId);
  }
  return { ...row, status: row.status as ClientStatus };
}

/**
 * Story 21-10 — the client's facts under a `FOR SHARE` row lock on the
 * caller's transaction, 404 `not-found` when absent. The gates that refuse a
 * non-active client while CREATING something under it (the rate-card draft,
 * the portal ASN announce, the portal-user invite) read status through this,
 * so a suspend (`ClientsCommand.updateStatus`, which takes `FOR UPDATE`)
 * cannot commit between the gate's read and its insert: a gate already
 * holding the share lock makes the suspend wait, and a gate arriving behind
 * a committing suspend waits and — READ COMMITTED — re-reads the committed
 * `suspended`. Lock order: the client first, then documents; nothing locks a
 * card or an ASN before its client, so there is no cycle. Share locks do not
 * conflict with each other, so concurrent gates never serialise.
 */
export async function shareLockClientInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<LockedClientFacts> {
  const rows = await tx
    .select({ id: clients.id, code: clients.code, systemOwned: clients.systemOwned, status: clients.status })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1)
    .for('share');
  const row = rows[0];
  if (row === undefined) {
    throw clientNotFound(clientId);
  }
  return { ...row, status: row.status as ClientStatus };
}

/** Bulk facts for a set of client ids (one query; unknown ids are absent). */
export async function getClientsInTx(
  tx: TenantTx,
  tenantId: string,
  clientIds: readonly string[],
): Promise<Map<string, ClientFacts>> {
  const distinct = [...new Set(clientIds)];
  if (distinct.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: clients.id, code: clients.code, systemOwned: clients.systemOwned })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), inArray(clients.id, distinct)));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The ASN import (2026-10-17) — clients named BY CODE in a file, in bulk, in
 * the caller's transaction. Matched case-insensitively on `upper(code)`:
 * codes are stored upper-case except the tenant's own `self`, and `SELF` is
 * reserved for it (`clients_self_code_reserved`), so the upper-cased match
 * is unambiguous and also lets a file name the tenant's own goods `self`.
 * The map is keyed by the UPPER-CASED code; an unknown code is absent.
 */
export async function getClientsByCodesInTx(
  tx: TenantTx,
  tenantId: string,
  codes: readonly string[],
): Promise<Map<string, ClientFacts & { readonly label: string }>> {
  const upper = [...new Set(codes.map((code) => code.trim().toUpperCase()).filter((code) => code !== ''))];
  if (upper.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: clients.id, code: clients.code, name: clients.name, systemOwned: clients.systemOwned })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), inArray(sql`upper(${clients.code})`, upper)));
  return new Map(
    rows.map((row) => [
      row.code.toUpperCase(),
      { id: row.id, code: row.code, systemOwned: row.systemOwned, label: clientLabel(row) },
    ]),
  );
}

/**
 * Bulk id → the label a refusal prints (story 21-2b): another client by its
 * code; the tenant's own client as "<tenant name> (your company)" — never
 * the internal `self` code, which means nothing to an operator. (The self
 * client's name mirrors the tenant name.) Unknown ids are absent.
 */
export async function getClientLabelsInTx(
  tx: TenantTx,
  tenantId: string,
  clientIds: readonly string[],
): Promise<Map<string, string>> {
  const distinct = [...new Set(clientIds)];
  if (distinct.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: clients.id, code: clients.code, name: clients.name, systemOwned: clients.systemOwned })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), inArray(clients.id, distinct)));
  return new Map(rows.map((row) => [row.id, clientLabel(row)]));
}

/**
 * Story 1-1 — operator-facing SKU code labels for a refusal that lists codes.
 * A SKU code is unique per (tenant, client) only, so once the tenant holds
 * more than one client each code is labelled `CODE (client)`; a one-client
 * tenant reads the bare code, as before. Distinct, in input order.
 */
export async function skuCodeLabelsInTx(
  tx: TenantTx,
  tenantId: string,
  refs: readonly { readonly code: string; readonly clientId: string }[],
): Promise<string[]> {
  if (refs.length === 0) {
    return [];
  }
  const all = await tx
    .select({ id: clients.id, code: clients.code, name: clients.name, systemOwned: clients.systemOwned })
    .from(clients)
    .where(eq(clients.tenantId, tenantId));
  const labels = new Map(all.map((row) => [row.id, clientLabel(row)]));
  const out = refs.map((ref) =>
    all.length > 1 ? `${ref.code} (${labels.get(ref.clientId) ?? ref.clientId})` : ref.code,
  );
  return [...new Set(out)];
}

/** One client's refusal label (see `getClientLabelsInTx`). */
export function clientLabel(row: { code: string; name: string; systemOwned: boolean }): string {
  return row.systemOwned ? `${row.name} (your company)` : row.code;
}

/**
 * The ONE attribution rule for a document derived from its SKUs (an order,
 * a PO, a kit, a product's variants): every SKU's client must be the same
 * one, or the document is refused 409 `mixed-client` naming the client
 * codes. Returns the single client id. State-dependent (it depends on the
 * SKUs' stored clients), hence 409 — the `kit-sku-holds-stock` precedent.
 */
export async function assertSingleClientInTx(
  tx: TenantTx,
  tenantId: string,
  clientIds: readonly string[],
  subject: string,
): Promise<string> {
  const distinct = [...new Set(clientIds)];
  if (distinct.length === 0) {
    throw new Error(`assertSingleClientInTx: no client ids for ${subject}`);
  }
  if (distinct.length === 1) {
    return distinct[0]!;
  }
  const labels = await getClientLabelsInTx(tx, tenantId, distinct);
  throw mixedClient(
    subject,
    distinct.map((id) => labels.get(id) ?? id),
  );
}

/** 409 `mixed-client` — a document whose SKUs belong to more than one client. */
export function mixedClient(subject: string, labels: readonly string[]): ProblemException {
  const named = [...new Set(labels)].sort().join(', ');
  return new ProblemException(
    'mixed-client',
    409,
    'SKUs belong to more than one client',
    `${subject} mixes SKUs of clients ${named} — one document is for one client; split it per client.`,
  );
}

export function clientNotFound(clientId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Client not found',
    `No client with id "${clientId}" exists in this tenant.`,
  );
}

/** Story 21-7 — what a client-portal session knows about its client. */
export interface SessionClientFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: ClientStatus;
}

/**
 * Story 21-7 — the client a portal user belongs to, read by tenant AND id,
 * on whichever runner the caller holds: sign-in's auth-time connection (it
 * has no tenant transaction yet — the tenant read beside it is the same
 * shape) or a tenant transaction. Null when absent. A read, never a lock.
 */
export async function readSessionClientIn(
  runner: Pick<TenantTx, 'select'> | Pick<Database, 'select'>,
  tenantId: string,
  clientId: string,
): Promise<SessionClientFacts | null> {
  const rows = await (runner as Pick<TenantTx, 'select'>)
    .select({ id: clients.id, code: clients.code, name: clients.name, status: clients.status })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { ...row, status: row.status as ClientStatus };
}

/**
 * Story 21-7 — 403 `client-suspended`: a client-portal user whose client is
 * not `active` (suspended or departed). Sign-in answers it AFTER the password
 * check (a wrong password stays 401); the portal guard answers it on every
 * request, so suspension bites before the 15-minute token expires. Distinct
 * from 409 `client-not-active` (a state conflict on a command's target).
 */
export function clientSuspended(): ProblemException {
  return new ProblemException(
    'client-suspended',
    403,
    'Client portal access is suspended',
    'This client brand’s portal access is suspended — contact the warehouse.',
  );
}

/** Story 21-7 — `GET …/portal/me`: the portal user and its client, exact keys. */
export interface PortalMe {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly role: UserRole;
    readonly status: UserStatus;
    readonly clientId: string;
  };
  readonly client: { readonly id: string; readonly code: string; readonly name: string };
}

/**
 * Story 21-7 — the portal's own `me` (the operator `/me` stays behind the
 * operator fence): re-read in a transaction stamped with the client, after
 * `PortalSessionGuard` already confirmed both rows. A row gone between the
 * guard and here reads as the guard's own refusals.
 */
export async function portalMeIn(db: Database, tenantId: string, userId: string, clientId: string): Promise<PortalMe> {
  return withTenantTransaction(
    db,
    tenantId,
    async (tx) => {
      const user = await getMemberPortalFactsIn(tx, tenantId, userId);
      if (user === null || user.status !== 'active' || user.clientId !== clientId) {
        throw new ProblemException('unauthenticated', 401, 'Authentication required', 'The session no longer describes a client-portal user — sign in again.');
      }
      const client = await readSessionClientIn(tx, tenantId, clientId);
      if (client === null || client.status !== 'active') {
        throw clientSuspended();
      }
      return {
        user: { id: user.id, email: user.email, role: user.role, status: user.status as UserStatus, clientId },
        client: { id: client.id, code: client.code, name: client.name },
      };
    },
    { clientId },
  );
}
