import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  PARTNER_LINK_ROLES,
  PARTNER_ROLES,
  PARTNER_STATUSES,
  auditEvents,
  businessPartners,
  idempotencyKeys,
  partnerClientLinks,
  type BusinessPartner,
  type PartnerClientLink,
  type PartnerLinkRole,
  type PartnerStatus,
} from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { GSTIN_RE, gstinPrefixProblem, normalizeGstinInput } from '../../shared/primitives/gstin';
import { ADDRESS_FIELD_LENGTHS } from '../../shared/primitives/address';
import { isEmailAddress, normalizeEmailAddress } from '../../shared/primitives/email';
import {
  assertRegisteredAddress,
  normalizeRegisteredAddress,
  type NormalizedRegisteredAddress,
  type RegisteredAddressInput,
} from '../../shared/primitives/registered-address';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertClientTakesWorkInTx, clientNotFound, lockClientInTx } from '../clients/clients.facade';
import { linksOfInTx, toPartnerSnapshot, type PartnerMutationSnapshot } from './partners.facade';

/** The PAN shape: five letters, four digits, a letter (the 0079 CHECK). */
export const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
export const PARTNER_CODE_MAX = 64;
export const PARTNER_NAME_MAX = 200;
export const PARTNER_CONTACT_NAME_MAX = 120;
export const PARTNER_REASON_MAX = 200;
export const LINK_CLIENT_CODE_MAX = 64;

/** The partner fields a create sets and a PATCH may change (absent = unchanged; null clears). */
export interface PartnerFieldsInput {
  readonly code?: string | undefined;
  readonly name?: string | undefined;
  readonly legalName?: string | null | undefined;
  readonly gstin?: string | null | undefined;
  readonly pan?: string | null | undefined;
  readonly roles?: readonly string[] | undefined;
  readonly registeredAddress?: RegisteredAddressInput | null | undefined;
  readonly dispatchAddress?: RegisteredAddressInput | null | undefined;
  readonly contactName?: string | null | undefined;
  readonly contactPhone?: string | null | undefined;
  readonly contactEmail?: string | null | undefined;
}

export interface CreatePartnerCommand extends PartnerFieldsInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly code: string;
  readonly name: string;
  readonly roles: readonly string[];
}

export interface UpdatePartnerCommand extends PartnerFieldsInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly partnerId: string;
}

export interface UpdatePartnerStatusCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly partnerId: string;
  readonly status: string;
  readonly reason?: string | null | undefined;
}

export interface CreatePartnerLinkCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly partnerId: string;
  readonly clientId: string;
  readonly role: string;
  readonly clientCode?: string | null | undefined;
  readonly isDefault?: boolean | undefined;
}

export interface UpdatePartnerLinkCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly partnerId: string;
  readonly linkId: string;
  readonly clientCode?: string | null | undefined;
  readonly active?: boolean | undefined;
  readonly isDefault?: boolean | undefined;
}

/** The fields in their fixed order — the hash and the merge both use it. */
const PARTNER_FIELDS = [
  'code',
  'name',
  'legalName',
  'gstin',
  'pan',
  'roles',
  'registeredAddress',
  'dispatchAddress',
  'contactName',
  'contactPhone',
  'contactEmail',
] as const;
type PartnerField = (typeof PARTNER_FIELDS)[number];

/** One partner's editable fields, normalized. */
interface PartnerFields {
  code: string;
  name: string;
  legalName: string | null;
  gstin: string | null;
  pan: string | null;
  roles: string[];
  registeredAddress: NormalizedRegisteredAddress | null;
  dispatchAddress: NormalizedRegisteredAddress | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
}

type PartnerPatch = Partial<PartnerFields>;

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const PARTNER_CODE_UNIQUE = 'business_partners_tenant_id_code_unique';
const PARTNER_GSTIN_UNIQUE = 'business_partners_tenant_gstin_unique';
const LINK_TRIPLE_UNIQUE = 'partner_client_links_partner_client_role_unique';
const LINK_CLIENT_CODE_UNIQUE = 'partner_client_links_client_code_unique';
const LINK_ONE_DEFAULT_UNIQUE = 'partner_client_links_one_default_unique';

/** Trim; a blank string reads as null (clear). Non-strings pass through for the shape check. */
function trimOrNull(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return raw;
  const value = raw.trim();
  return value === '' ? null : value;
}

function normalizeRoles(raw: readonly string[]): string[] {
  if (!Array.isArray(raw)) return raw as unknown as string[];
  // A role in the vocabulary is placed in canonical order (so `[consignee,
  // vendor]` and `[vendor, consignee]` hash and compare equal); anything else
  // keeps its position at the end for the shape check to name.
  const known = PARTNER_ROLES.filter((role) => raw.includes(role));
  const unknown = raw.filter((role) => !(PARTNER_ROLES as readonly string[]).includes(role));
  const repeated = raw.length !== new Set(raw).size;
  return repeated ? [...raw] : [...known, ...unknown];
}

/**
 * The LENIENT normalize of the patchable fields (never throws — it is what
 * the idempotency hash fingerprints). Absent keys stay absent; the keys come
 * out in `PARTNER_FIELDS` order.
 */
export function normalizePartnerPatch(input: PartnerFieldsInput): PartnerPatch {
  const patch: PartnerPatch = {};
  for (const field of PARTNER_FIELDS) {
    const raw = input[field];
    if (raw === undefined) continue;
    switch (field) {
      case 'code':
      case 'name':
        patch[field] = typeof raw === 'string' ? raw.trim() : (raw as unknown as string);
        break;
      case 'legalName':
      case 'contactName':
      case 'contactPhone':
        patch[field] = trimOrNull(raw as string | null);
        break;
      case 'contactEmail': {
        const value = trimOrNull(raw as string | null);
        patch.contactEmail = typeof value === 'string' ? normalizeEmailAddress(value) : value;
        break;
      }
      case 'gstin':
        patch.gstin = typeof raw === 'string' || raw === null ? normalizeGstinInput(raw as string | null) : (raw as unknown as string);
        break;
      case 'pan': {
        const value = trimOrNull(raw as string | null);
        patch.pan = typeof value === 'string' ? value.toUpperCase() : value;
        break;
      }
      case 'roles':
        patch.roles = normalizeRoles(raw as readonly string[]);
        break;
      case 'registeredAddress':
      case 'dispatchAddress':
        patch[field] = normalizeRegisteredAddress(raw as RegisteredAddressInput | null);
        break;
    }
  }
  return patch;
}

function fieldsOf(row: BusinessPartner): PartnerFields {
  const address = (
    line1: string | null,
    line2: string | null,
    city: string | null,
    stateCode: string | null,
    pincode: string | null,
  ): NormalizedRegisteredAddress | null =>
    line1 === null || city === null || stateCode === null || pincode === null
      ? null
      : { line1, line2: line2 ?? undefined, city, stateCode, pincode };
  return {
    code: row.code,
    name: row.name,
    legalName: row.legalName,
    gstin: row.gstin,
    pan: row.pan,
    roles: [...row.roles],
    registeredAddress: address(row.registeredLine1, row.registeredLine2, row.registeredCity, row.registeredStateCode, row.registeredPincode),
    dispatchAddress: address(row.dispatchLine1, row.dispatchLine2, row.dispatchCity, row.dispatchStateCode, row.dispatchPincode),
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
  };
}

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid partner', detail);
}

function codePoints(value: string): number {
  return [...value].length;
}

/**
 * Every rule a partner's MERGED fields must satisfy (story 1-3 — create and
 * PATCH alike run on the merged row), in a fixed order. Returns the fields
 * with the PAN derived from the GSTIN (characters 3–12) when absent.
 * 400 `validation-failed` naming the field, `pan-gstin-mismatch`, or
 * `gstin-state-mismatch`.
 */
export function assertPartnerFields(merged: PartnerFields): PartnerFields {
  if (typeof merged.code !== 'string' || merged.code === '' || codePoints(merged.code) > PARTNER_CODE_MAX) {
    throw invalid(`code is required, 1-${PARTNER_CODE_MAX} characters once trimmed.`);
  }
  if (typeof merged.name !== 'string' || merged.name === '' || codePoints(merged.name) > PARTNER_NAME_MAX) {
    throw invalid(`name is required, 1-${PARTNER_NAME_MAX} characters once trimmed.`);
  }
  if (merged.legalName !== null && (typeof merged.legalName !== 'string' || codePoints(merged.legalName) > PARTNER_NAME_MAX)) {
    throw invalid(`legalName is at most ${PARTNER_NAME_MAX} characters.`);
  }
  if (!Array.isArray(merged.roles) || merged.roles.length === 0) {
    throw invalid(`roles must name at least one of ${JSON.stringify(PARTNER_ROLES)}.`);
  }
  for (const role of merged.roles) {
    if (!(PARTNER_ROLES as readonly string[]).includes(role)) {
      throw invalid(`roles must be drawn from ${JSON.stringify(PARTNER_ROLES)} (got ${JSON.stringify(role)}).`);
    }
  }
  if (new Set(merged.roles).size !== merged.roles.length) {
    throw invalid('roles must not repeat a role.');
  }
  if (merged.gstin !== null) {
    if (typeof merged.gstin !== 'string' || !GSTIN_RE.test(merged.gstin)) {
      throw invalid(`gstin must be a 15-character GSTIN — two digits, then thirteen letters or digits (got "${String(merged.gstin)}").`);
    }
    const prefix = gstinPrefixProblem(merged.gstin);
    if (prefix !== null) throw invalid(`gstin ${prefix}.`);
  }
  if (merged.pan !== null && (typeof merged.pan !== 'string' || !PAN_RE.test(merged.pan))) {
    throw invalid(`pan must be five letters, four digits and a letter (got "${String(merged.pan)}").`);
  }
  let pan = merged.pan;
  if (merged.gstin !== null) {
    const derived = merged.gstin.slice(2, 12);
    if (pan === null) {
      if (!PAN_RE.test(derived)) {
        throw invalid(`gstin ${merged.gstin} does not carry a PAN in characters 3-12 ("${derived}").`);
      }
      pan = derived;
    } else if (pan !== derived) {
      throw new ProblemException(
        'pan-gstin-mismatch',
        400,
        'PAN does not match the GSTIN',
        `pan ${pan} differs from the PAN inside gstin ${merged.gstin} (${derived}) — a GSTIN carries its holder's PAN in characters 3-12. Clear the PAN to take the GSTIN's.`,
      );
    }
  }
  const registeredAddress =
    merged.registeredAddress === null ? null : assertRegisteredAddress(merged.registeredAddress, 'registeredAddress');
  const dispatchAddress =
    merged.dispatchAddress === null ? null : assertRegisteredAddress(merged.dispatchAddress, 'dispatchAddress');
  if (merged.gstin !== null && registeredAddress !== null && merged.gstin.slice(0, 2) !== registeredAddress.stateCode) {
    throw new ProblemException(
      'gstin-state-mismatch',
      400,
      'GSTIN registered in another state',
      `gstin ${merged.gstin} is registered in state ${merged.gstin.slice(0, 2)}, but registeredAddress.stateCode is ${registeredAddress.stateCode} — one partner is one GST registration, at its registered address.`,
    );
  }
  if (merged.contactName !== null && (typeof merged.contactName !== 'string' || codePoints(merged.contactName) > PARTNER_CONTACT_NAME_MAX)) {
    throw invalid(`contactName is at most ${PARTNER_CONTACT_NAME_MAX} characters.`);
  }
  if (merged.contactPhone !== null && (typeof merged.contactPhone !== 'string' || merged.contactPhone.length > ADDRESS_FIELD_LENGTHS.phone)) {
    throw invalid(`contactPhone is at most ${ADDRESS_FIELD_LENGTHS.phone} characters.`);
  }
  if (merged.contactEmail !== null && (typeof merged.contactEmail !== 'string' || !isEmailAddress(merged.contactEmail))) {
    throw invalid(`contactEmail must be an email address (got "${String(merged.contactEmail)}").`);
  }
  return { ...merged, pan, registeredAddress, dispatchAddress };
}

/** The column values of a validated field set. */
function columnsOf(fields: PartnerFields): Omit<typeof businessPartners.$inferInsert, 'id' | 'tenantId'> {
  const reg = fields.registeredAddress;
  const dis = fields.dispatchAddress;
  return {
    code: fields.code,
    name: fields.name,
    legalName: fields.legalName,
    gstin: fields.gstin,
    pan: fields.pan,
    roles: fields.roles,
    registeredLine1: reg?.line1 ?? null,
    registeredLine2: reg?.line2 ?? null,
    registeredCity: reg?.city ?? null,
    registeredStateCode: reg?.stateCode ?? null,
    registeredPincode: reg?.pincode ?? null,
    dispatchLine1: dis?.line1 ?? null,
    dispatchLine2: dis?.line2 ?? null,
    dispatchCity: dis?.city ?? null,
    dispatchStateCode: dis?.stateCode ?? null,
    dispatchPincode: dis?.pincode ?? null,
    contactName: fields.contactName,
    contactPhone: fields.contactPhone,
    contactEmail: fields.contactEmail,
  };
}

function sameColumns(a: ReturnType<typeof columnsOf>, b: ReturnType<typeof columnsOf>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Story 1-3 — the business partner master's commands (`vendor.manage`, the
 * Story 3.1 capability kept — decision 4). Every command is keyed, its hash
 * carries an `arm:` discriminator, it audits (`partner.*`, target `partner`
 * or `partner_link`) and stores its key LAST. Lock order, always: client →
 * partner → link. Nothing is ever deleted.
 */
@Injectable()
export class PartnersCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  /**
   * `POST /partners`. Takes no row lock and replays once (a concurrent
   * duplicate code or GSTIN is settled by the unique index). Emits the
   * `vendor.created` outbox event when — and only when — the partner is
   * created holding the vendor role (adding the role later emits nothing).
   */
  async create(command: CreatePartnerCommand, idempotencyKey: string): Promise<PartnerMutationSnapshot> {
    const patch = normalizePartnerPatch(command);
    const payloadHash = hashCommandPayload({
      arm: 'partner-create',
      tenantId: command.tenantId,
      code: patch.code ?? null,
      name: patch.name ?? null,
      legalName: patch.legalName ?? null,
      gstin: patch.gstin ?? null,
      pan: patch.pan ?? null,
      roles: patch.roles ?? null,
      registeredAddress: patch.registeredAddress ?? null,
      dispatchAddress: patch.dispatchAddress ?? null,
      contactName: patch.contactName ?? null,
      contactPhone: patch.contactPhone ?? null,
      contactEmail: patch.contactEmail ?? null,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'vendor.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      const fields = assertPartnerFields({
        code: patch.code ?? '',
        name: patch.name ?? '',
        legalName: patch.legalName ?? null,
        gstin: patch.gstin ?? null,
        pan: patch.pan ?? null,
        roles: patch.roles ?? [],
        registeredAddress: patch.registeredAddress ?? null,
        dispatchAddress: patch.dispatchAddress ?? null,
        contactName: patch.contactName ?? null,
        contactPhone: patch.contactPhone ?? null,
        contactEmail: patch.contactEmail ?? null,
      });
      await this.assertUniqueInTx(tx, command.tenantId, null, fields);

      let row: BusinessPartner;
      try {
        const rows = await tx
          .insert(businessPartners)
          .values({ id: uuidv7(), tenantId: command.tenantId, ...columnsOf(fields), status: 'active', inactiveReason: null })
          .returning();
        row = rows[0]!;
      } catch (err) {
        throw this.mapPartnerUniqueViolation(err, fields);
      }
      const snapshot: PartnerMutationSnapshot = { partner: toPartnerSnapshot(row, []) };

      if (fields.roles.includes('vendor')) {
        // The Story 3.1 integration event, kept (story 1-3 — the outbox
        // vocabulary stays): emitted at creation in the vendor role only.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'vendor.created',
          occurredAt: nowIso(),
          payload: {
            vendor: { id: row.id, tenantId: row.tenantId, code: row.code, name: row.name, createdAt: snapshot.partner.createdAt },
          },
        });
      }
      await this.audit(tx, command.tenantId, command.actorUserId, 'partner.created', 'partner', row.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * `PATCH /partners/{id}` — tri-state: an absent key is unchanged, `null`
   * clears (legal name, GSTIN, PAN, contact, each address group). Locks the
   * partner `FOR NO KEY UPDATE` (a rename never queues a PO's `FOR KEY
   * SHARE`), replays again under it, validates the MERGED row, refuses
   * removing a link role still carried by an active link (409
   * `partner-role-in-use` — under the same partner lock link create and
   * update take, so they serialise). An unchanged patch stores the key and
   * writes nothing (`partners.update:unchanged`).
   */
  async update(command: UpdatePartnerCommand, idempotencyKey: string): Promise<PartnerMutationSnapshot> {
    const patch = normalizePartnerPatch(command);
    const payloadHash = hashCommandPayload({
      arm: 'partner-update',
      tenantId: command.tenantId,
      partnerId: command.partnerId,
      ...patch,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'vendor.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const current = await this.lockPartner(tx, command.tenantId, command.partnerId, 'no key update');
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;

      const before = fieldsOf(current);
      const merged: PartnerFields = { ...before };
      for (const field of PARTNER_FIELDS) {
        if (patch[field] !== undefined) (merged as Record<PartnerField, unknown>)[field] = patch[field];
      }
      const fields = assertPartnerFields(merged);

      const removed = before.roles.filter((role) => !fields.roles.includes(role));
      for (const role of removed) {
        if (!(PARTNER_LINK_ROLES as readonly string[]).includes(role)) continue;
        const inUse = await tx
          .select({ id: partnerClientLinks.id })
          .from(partnerClientLinks)
          .where(
            and(
              eq(partnerClientLinks.tenantId, command.tenantId),
              eq(partnerClientLinks.partnerId, current.id),
              eq(partnerClientLinks.role, role),
              eq(partnerClientLinks.active, true),
            ),
          );
        if (inUse.length > 0) {
          throw new ProblemException(
            'partner-role-in-use',
            409,
            'Role still in use',
            `Partner "${current.code}" still has ${inUse.length} active ${role} link(s) — deactivate them before removing the ${role} role.`,
          );
        }
      }

      const after = columnsOf(fields);
      if (sameColumns(after, columnsOf(before))) {
        const unchanged = await this.snapshotInTx(tx, command.tenantId, current);
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, unchanged);
        return unchanged;
      }
      await this.assertUniqueInTx(tx, command.tenantId, current.id, fields);
      let row: BusinessPartner;
      try {
        const rows = await tx
          .update(businessPartners)
          .set({ ...after, updatedAt: nowIso() })
          .where(and(eq(businessPartners.tenantId, command.tenantId), eq(businessPartners.id, current.id)))
          .returning();
        row = rows[0]!;
      } catch (err) {
        throw this.mapPartnerUniqueViolation(err, fields);
      }
      const snapshot = await this.snapshotInTx(tx, command.tenantId, row);
      await this.audit(tx, command.tenantId, command.actorUserId, 'partner.updated', 'partner', row.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * `PATCH /partners/{id}/status` — deactivate (with an optional reason) or
   * reactivate. The partner `FOR UPDATE` (it conflicts with the PO guard's
   * `FOR KEY SHARE`, so a deactivation and a PO create serialise). Deactivating
   * clears `is_default` on every link of the partner; reactivating clears the
   * reason and never brings a default back. The same status (and, inactive,
   * the same reason) stores the key and writes nothing
   * (`partners.status:unchanged`); a new reason on an inactive partner is a
   * `partner.updated`.
   */
  async updateStatus(command: UpdatePartnerStatusCommand, idempotencyKey: string): Promise<PartnerMutationSnapshot> {
    const reason = trimOrNull(command.reason);
    const payloadHash = hashCommandPayload({
      arm: 'partner-status',
      tenantId: command.tenantId,
      partnerId: command.partnerId,
      status: command.status,
      reason,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'vendor.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const current = await this.lockPartner(tx, command.tenantId, command.partnerId, 'update');
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;

      if (!(PARTNER_STATUSES as readonly string[]).includes(command.status)) {
        throw invalid(`status must be one of ${JSON.stringify(PARTNER_STATUSES)} (got ${JSON.stringify(command.status)}).`);
      }
      const status = command.status as PartnerStatus;
      if (reason !== null && (typeof reason !== 'string' || status === 'active')) {
        throw invalid('reason is given only when deactivating — reactivating clears it.');
      }
      if (reason !== null && codePoints(reason) > PARTNER_REASON_MAX) {
        throw invalid(`reason is at most ${PARTNER_REASON_MAX} characters.`);
      }
      if (current.status === status && current.inactiveReason === reason) {
        const unchanged = await this.snapshotInTx(tx, command.tenantId, current);
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, unchanged);
        return unchanged;
      }
      const rows = await tx
        .update(businessPartners)
        .set({ status, inactiveReason: status === 'active' ? null : reason, updatedAt: nowIso() })
        .where(and(eq(businessPartners.tenantId, command.tenantId), eq(businessPartners.id, current.id)))
        .returning();
      if (status === 'inactive') {
        await tx
          .update(partnerClientLinks)
          .set({ isDefault: false, updatedAt: nowIso() })
          .where(
            and(
              eq(partnerClientLinks.tenantId, command.tenantId),
              eq(partnerClientLinks.partnerId, current.id),
              eq(partnerClientLinks.isDefault, true),
            ),
          );
      }
      const snapshot = await this.snapshotInTx(tx, command.tenantId, rows[0]!);
      const action =
        current.status === status ? 'partner.updated' : status === 'inactive' ? 'partner.deactivated' : 'partner.reactivated';
      await this.audit(tx, command.tenantId, command.actorUserId, action, 'partner', current.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * `POST /partners/{id}/links` — link a vendor or consignee to a client.
   * Order: client (`FOR KEY SHARE`, 409 `client-departed`; a default also
   * `FOR NO KEY UPDATE`) → partner `FOR NO KEY UPDATE` → replay again → role
   * (400 `link-role-invalid`: a transporter, or a role the partner lacks) →
   * active partner (409 `partner-inactive`) → the triple is new (409
   * `link-exists` naming the link) → the client code is free (409
   * `link-client-code-taken`) → a default clears the client's previous one →
   * insert → audit `partner.linked` (target `partner_link`) → key.
   */
  async createLink(command: CreatePartnerLinkCommand, idempotencyKey: string): Promise<PartnerMutationSnapshot> {
    const clientCode = trimOrNull(command.clientCode);
    const isDefault = command.isDefault ?? false;
    const payloadHash = hashCommandPayload({
      arm: 'link-create',
      tenantId: command.tenantId,
      partnerId: command.partnerId,
      clientId: command.clientId,
      role: command.role,
      clientCode,
      isDefault,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'vendor.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      if (!(PARTNER_LINK_ROLES as readonly string[]).includes(command.role)) {
        throw linkRoleInvalid(`A ${command.role} is not linked to clients — only vendors and consignees are.`);
      }
      const role = command.role as PartnerLinkRole;
      if (isDefault && role !== 'vendor') {
        throw invalid('isDefault applies only to a vendor link — a client has a default vendor, not a default consignee.');
      }
      assertLinkClientCode(clientCode);
      if (!UUID_RE.test(command.clientId)) throw clientNotFound(command.clientId);
      // Lock order: client → partner → link.
      await assertClientTakesWorkInTx(tx, command.tenantId, command.clientId);
      if (isDefault) await lockClientInTx(tx, command.tenantId, command.clientId);
      const partner = await this.lockPartner(tx, command.tenantId, command.partnerId, 'no key update');
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;

      if (!partner.roles.includes(role)) {
        throw linkRoleInvalid(`Partner "${partner.code}" does not have the ${role} role — add it first.`);
      }
      if (partner.status !== 'active') throw partnerInactive(partner.code);
      const existing = await tx
        .select({ id: partnerClientLinks.id })
        .from(partnerClientLinks)
        .where(
          and(
            eq(partnerClientLinks.tenantId, command.tenantId),
            eq(partnerClientLinks.partnerId, partner.id),
            eq(partnerClientLinks.clientId, command.clientId),
            eq(partnerClientLinks.role, role),
          ),
        )
        .limit(1);
      if (existing[0] !== undefined) throw linkExists(partner.code, role, existing[0].id);
      await this.assertClientCodeFree(tx, command.tenantId, command.clientId, role, clientCode, null);
      if (isDefault) await this.clearClientDefault(tx, command.tenantId, command.clientId, null);

      const linkId = uuidv7();
      try {
        await tx.insert(partnerClientLinks).values({
          id: linkId,
          tenantId: command.tenantId,
          partnerId: partner.id,
          clientId: command.clientId,
          role,
          clientCode,
          active: true,
          isDefault,
        });
      } catch (err) {
        throw mapLinkUniqueViolation(err, partner.code, role, clientCode);
      }
      const snapshot = await this.snapshotInTx(tx, command.tenantId, partner);
      await this.audit(tx, command.tenantId, command.actorUserId, 'partner.linked', 'partner_link', linkId, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * `PATCH /partners/{id}/links/{linkId}` — the client code (absent
   * unchanged, null clears), `active` (a link is switched off, never
   * deleted; switching off clears the default) and `isDefault`. Locks:
   * client first (`FOR KEY SHARE` when reactivating — 409 `client-departed`;
   * `FOR NO KEY UPDATE` when setting the default), the partner `FOR NO KEY
   * UPDATE`, then the link — `FOR UPDATE` when the request names `active` or
   * `isDefault` (it conflicts with the PO guard's `FOR KEY SHARE`), else
   * `FOR NO KEY UPDATE`. Unchanged: the key stored, nothing written
   * (`partners.linkUpdate:unchanged`).
   */
  async updateLink(command: UpdatePartnerLinkCommand, idempotencyKey: string): Promise<PartnerMutationSnapshot> {
    const clientCode = command.clientCode === undefined ? undefined : trimOrNull(command.clientCode);
    const payloadHash = hashCommandPayload({
      arm: 'link-update',
      tenantId: command.tenantId,
      partnerId: command.partnerId,
      linkId: command.linkId,
      ...(clientCode === undefined ? {} : { clientCode }),
      ...(command.active === undefined ? {} : { active: command.active }),
      ...(command.isDefault === undefined ? {} : { isDefault: command.isDefault }),
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'vendor.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      if (clientCode !== undefined) assertLinkClientCode(clientCode);
      if (command.isDefault === true && command.active === false) {
        throw invalid('A link being switched off cannot become the default vendor.');
      }

      // An unlocked read learns the link's client (lock order: client first).
      const seen = await this.readLink(tx, command.tenantId, command.partnerId, command.linkId, null);
      if (command.active === true) await assertClientTakesWorkInTx(tx, command.tenantId, seen.clientId);
      if (command.isDefault === true) await lockClientInTx(tx, command.tenantId, seen.clientId);
      const partner = await this.lockPartner(tx, command.tenantId, command.partnerId, 'no key update');
      const flips = command.active !== undefined || command.isDefault !== undefined;
      const link = await this.readLink(tx, command.tenantId, partner.id, command.linkId, flips ? 'update' : 'no key update');
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;

      const active = command.active ?? link.active;
      const isDefault = active && (command.isDefault ?? link.isDefault);
      const nextCode = clientCode === undefined ? link.clientCode : clientCode;
      const reactivating = active && !link.active;
      const settingDefault = isDefault && !link.isDefault;
      if (reactivating && !partner.roles.includes(link.role)) {
        throw linkRoleInvalid(`Partner "${partner.code}" no longer has the ${link.role} role — add it back before reactivating the link.`);
      }
      if ((reactivating || settingDefault) && partner.status !== 'active') throw partnerInactive(partner.code);
      if (settingDefault && link.role !== 'vendor') {
        throw invalid('isDefault applies only to a vendor link — a client has a default vendor, not a default consignee.');
      }
      if (!active && command.isDefault === true) {
        throw invalid('Only an active link can be the default vendor — reactivate it first.');
      }
      if (active === link.active && isDefault === link.isDefault && nextCode === link.clientCode) {
        const unchanged = await this.snapshotInTx(tx, command.tenantId, partner);
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, unchanged);
        return unchanged;
      }
      if (nextCode !== link.clientCode) {
        await this.assertClientCodeFree(tx, command.tenantId, link.clientId, link.role as PartnerLinkRole, nextCode, link.id);
      }
      if (settingDefault) await this.clearClientDefault(tx, command.tenantId, link.clientId, link.id);
      try {
        await tx
          .update(partnerClientLinks)
          .set({ active, isDefault, clientCode: nextCode, updatedAt: nowIso() })
          .where(and(eq(partnerClientLinks.tenantId, command.tenantId), eq(partnerClientLinks.id, link.id)));
      } catch (err) {
        throw mapLinkUniqueViolation(err, partner.code, link.role as PartnerLinkRole, nextCode);
      }
      const snapshot = await this.snapshotInTx(tx, command.tenantId, partner);
      const action =
        active === link.active ? 'partner.link_updated' : active ? 'partner.link_reactivated' : 'partner.link_deactivated';
      await this.audit(tx, command.tenantId, command.actorUserId, action, 'partner_link', link.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /** The partner row locked in `mode`, 404 when absent (a lock helper checks no state — 21-11a). */
  private async lockPartner(
    tx: TenantTx,
    tenantId: string,
    partnerId: string,
    mode: 'update' | 'no key update',
  ): Promise<BusinessPartner> {
    if (!UUID_RE.test(partnerId)) throw partnerNotFound(partnerId);
    const rows = await tx
      .select()
      .from(businessPartners)
      .where(and(eq(businessPartners.tenantId, tenantId), eq(businessPartners.id, partnerId)))
      .limit(1)
      .for(mode);
    const row = rows[0];
    if (row === undefined) throw partnerNotFound(partnerId);
    return row;
  }

  /** One link of the partner, locked in `mode` (or unlocked), 404 when absent. */
  private async readLink(
    tx: TenantTx,
    tenantId: string,
    partnerId: string,
    linkId: string,
    mode: 'update' | 'no key update' | null,
  ): Promise<PartnerClientLink> {
    if (!UUID_RE.test(partnerId)) throw partnerNotFound(partnerId);
    if (!UUID_RE.test(linkId)) throw linkNotFound(linkId);
    const query = tx
      .select()
      .from(partnerClientLinks)
      .where(
        and(
          eq(partnerClientLinks.tenantId, tenantId),
          eq(partnerClientLinks.partnerId, partnerId),
          eq(partnerClientLinks.id, linkId),
        ),
      )
      .limit(1);
    const rows = mode === null ? await query : await query.for(mode);
    const row = rows[0];
    if (row === undefined) throw linkNotFound(linkId);
    return row;
  }

  private async snapshotInTx(tx: TenantTx, tenantId: string, row: BusinessPartner): Promise<PartnerMutationSnapshot> {
    const links = await linksOfInTx(tx, tenantId, [row.id]);
    return { partner: toPartnerSnapshot(row, links.get(row.id) ?? []) };
  }

  /** The code and GSTIN pre-checks (a 409 naming the holder); the unique indexes are the race backstop. */
  private async assertUniqueInTx(tx: TenantTx, tenantId: string, selfId: string | null, fields: PartnerFields): Promise<void> {
    const codeHolder = await tx
      .select({ id: businessPartners.id })
      .from(businessPartners)
      .where(
        and(
          eq(businessPartners.tenantId, tenantId),
          eq(businessPartners.code, fields.code),
          selfId === null ? undefined : ne(businessPartners.id, selfId),
        ),
      )
      .limit(1);
    if (codeHolder[0] !== undefined) throw partnerCodeTaken(fields.code);
    if (fields.gstin !== null) {
      const gstinHolder = await tx
        .select({ code: businessPartners.code })
        .from(businessPartners)
        .where(
          and(
            eq(businessPartners.tenantId, tenantId),
            eq(businessPartners.gstin, fields.gstin),
            selfId === null ? undefined : ne(businessPartners.id, selfId),
          ),
        )
        .limit(1);
      if (gstinHolder[0] !== undefined) throw partnerGstinTaken(fields.gstin, gstinHolder[0].code);
    }
  }

  private mapPartnerUniqueViolation(err: unknown, fields: PartnerFields): unknown {
    if (isUniqueViolationOn(err, PARTNER_CODE_UNIQUE)) return partnerCodeTaken(fields.code);
    if (isUniqueViolationOn(err, PARTNER_GSTIN_UNIQUE)) return partnerGstinTaken(fields.gstin ?? '', null);
    return err;
  }

  /** The client's own code is unique per (client, role) across every link, inactive ones included. */
  private async assertClientCodeFree(
    tx: TenantTx,
    tenantId: string,
    clientId: string,
    role: PartnerLinkRole,
    clientCode: string | null,
    selfLinkId: string | null,
  ): Promise<void> {
    if (clientCode === null) return;
    const holder = await tx
      .select({ id: partnerClientLinks.id })
      .from(partnerClientLinks)
      .where(
        and(
          eq(partnerClientLinks.tenantId, tenantId),
          eq(partnerClientLinks.clientId, clientId),
          eq(partnerClientLinks.role, role),
          eq(partnerClientLinks.clientCode, clientCode),
          selfLinkId === null ? undefined : ne(partnerClientLinks.id, selfLinkId),
        ),
      )
      .limit(1);
    if (holder[0] !== undefined) throw linkClientCodeTaken(clientCode, role);
  }

  /** Clears the client's current default vendor link (another link than `keepId`), under the client lock. */
  private async clearClientDefault(tx: TenantTx, tenantId: string, clientId: string, keepId: string | null): Promise<void> {
    await tx
      .update(partnerClientLinks)
      .set({ isDefault: false, updatedAt: nowIso() })
      .where(
        and(
          eq(partnerClientLinks.tenantId, tenantId),
          eq(partnerClientLinks.clientId, clientId),
          eq(partnerClientLinks.isDefault, true),
          keepId === null ? undefined : ne(partnerClientLinks.id, keepId),
        ),
      );
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<PartnerMutationSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot as PartnerMutationSnapshot;
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    actorUserId: string,
    action:
      | 'partner.created'
      | 'partner.updated'
      | 'partner.deactivated'
      | 'partner.reactivated'
      | 'partner.linked'
      | 'partner.link_updated'
      | 'partner.link_deactivated'
      | 'partner.link_reactivated',
    targetType: 'partner' | 'partner_link',
    targetId: string,
    reference: string,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId,
      action,
      targetType,
      targetId,
      reference,
      occurredAt: nowIso(),
    });
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: PartnerMutationSnapshot,
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({
        id: uuidv7(),
        tenantId,
        key: idempotencyKey,
        payloadHash,
        responseSnapshot: snapshot,
      });
    } catch (err) {
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        throw new ProblemException(
          'conflict',
          409,
          'Concurrent idempotent request',
          'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
        );
      }
      throw err;
    }
  }
}

function assertLinkClientCode(clientCode: string | null): void {
  if (clientCode !== null && (typeof clientCode !== 'string' || codePoints(clientCode) > LINK_CLIENT_CODE_MAX)) {
    throw invalid(`clientCode is at most ${LINK_CLIENT_CODE_MAX} characters.`);
  }
}

function mapLinkUniqueViolation(err: unknown, partnerCode: string, role: PartnerLinkRole, clientCode: string | null): unknown {
  if (isUniqueViolationOn(err, LINK_CLIENT_CODE_UNIQUE)) return linkClientCodeTaken(clientCode ?? '', role);
  if (isUniqueViolationOn(err, LINK_ONE_DEFAULT_UNIQUE)) {
    return new ProblemException(
      'default-vendor-conflict',
      409,
      'Default vendor changed concurrently',
      'Another default vendor was set for this client at the same time — reload and try again.',
    );
  }
  if (isUniqueViolationOn(err, LINK_TRIPLE_UNIQUE)) {
    return new ProblemException(
      'link-exists',
      409,
      'Link already exists',
      `Partner "${partnerCode}" is already linked to this client as a ${role}.`,
    );
  }
  return err;
}

export function partnerNotFound(partnerId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Partner not found', `No partner with id "${partnerId}" exists in this tenant.`);
}

function linkNotFound(linkId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Link not found', `No link with id "${linkId}" exists on this partner.`);
}

function partnerCodeTaken(code: string): ProblemException {
  return new ProblemException('partner-code-taken', 409, 'Partner code already in use', `Partner code "${code}" is already used by another partner of this tenant.`);
}

function partnerGstinTaken(gstin: string, holderCode: string | null): ProblemException {
  return new ProblemException(
    'partner-gstin-taken',
    409,
    'GSTIN already registered',
    holderCode === null
      ? `GSTIN ${gstin} already belongs to another partner of this tenant — one partner is one GST registration.`
      : `GSTIN ${gstin} already belongs to partner "${holderCode}" — one partner is one GST registration.`,
  );
}

function partnerInactive(code: string): ProblemException {
  return new ProblemException(
    'partner-inactive',
    409,
    'Partner is inactive',
    `Partner "${code}" is inactive — reactivate it before linking it or setting it as a default.`,
  );
}

function linkRoleInvalid(detail: string): ProblemException {
  return new ProblemException('link-role-invalid', 400, 'Role cannot be linked', detail);
}

function linkExists(partnerCode: string, role: PartnerLinkRole, linkId: string): ProblemException {
  return new ProblemException(
    'link-exists',
    409,
    'Link already exists',
    `Partner "${partnerCode}" is already linked to this client as a ${role} (link ${linkId}) — switch that link on instead.`,
    { linkId },
  );
}

function linkClientCodeTaken(clientCode: string, role: PartnerLinkRole): ProblemException {
  return new ProblemException(
    'link-client-code-taken',
    409,
    'Client code already in use',
    `The client already uses code "${clientCode}" for another ${role} — client codes are unique per client and role, inactive links included.`,
  );
}

