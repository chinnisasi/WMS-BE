import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { revokeSessionsInTx } from '../tenancy/sessions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import {
  CLIENT_CODE_RE,
  CLIENT_CONTACT_NAME_MAX,
  CLIENT_CONTACT_ROLES,
  CLIENT_NAME_MAX,
  MAX_CLIENT_CONTACTS,
  MIN_SHELF_LIFE_DAYS_MAX,
  MIN_SHELF_LIFE_DAYS_MIN,
  RECEIVING_TOLERANCE_BPS_MAX,
  SELF_CLIENT_CODE,
  clientContacts,
  clients,
  type ClientContactRole,
  type ClientStatus,
} from './clients.schema';
import {
  clientNotFound,
  toClientContactSnapshot,
  toClientSnapshot,
  type ClientContactSnapshot,
  type ClientSnapshot,
  type ClientTaxDetails,
} from './clients.facade';
import {
  ADDRESS_FIELD_LENGTHS,
  PINCODE_RE,
  assertAddress,
  assertPhone,
  normalizeAddressInput,
  type AddressInput,
} from '../../shared/primitives/address';
import { GSTIN_RE, gstinPrefixProblem, isGstinStateCode } from '../../shared/primitives/gstin';
// Story 1-3 — the registered-address rule moved to `shared/` so business
// partners share it; re-exported so this module's import paths still hold.
import {
  assertRegisteredAddress,
  normalizeRegisteredAddress,
  type RegisteredAddressInput,
} from '../../shared/primitives/registered-address';
export { assertRegisteredAddress, normalizeRegisteredAddress, type RegisteredAddressInput };
import { EMAIL_MAX_LENGTH, isEmailAddress, normalizeEmailAddress } from '../../shared/primitives/email';
import { WIND_DOWN_BLOCKER_KINDS, type WindDownBlocker } from '../../shared/primitives/wind-down';
// Story 1-2a — the wind-down reads, one file per owning module. Each imports
// nothing from `modules/clients` (pinned by test/architecture.spec.ts), so
// composing them here makes no import cycle.
import { clientWindDownBlockersInTx as inventoryBlockersInTx } from '../inventory/client-wind-down';
import { clientWindDownBlockersInTx as inboundBlockersInTx } from '../inbound/client-wind-down';
import { clientWindDownBlockersInTx as outboundBlockersInTx } from '../outbound/client-wind-down';
import { clientWindDownBlockersInTx as returnsBlockersInTx } from '../returns/client-wind-down';
import { clientWindDownBlockersInTx as tenancyBlockersInTx } from '../tenancy/client-wind-down';
import { clientWindDownBlockersInTx as billingBlockersInTx } from '../billing/client-wind-down';
import { clientWindDownBlockersInTx as channelsBlockersInTx } from '../channels/client-wind-down';

export interface CreateClientCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly code: string;
  readonly name: string;
}

export interface RenameClientCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  readonly name: string;
}

/**
 * Story 21-10 — the statuses an owner may move a client between. One tuple,
 * used by the command's own shape check, the DTO's `@IsIn` and its OpenAPI
 * enum. Story 1-2a adds `departed` (offboarding): active → departed and
 * suspended → departed once the client is wound down, departed → active
 * (reactivation); departed → suspended is refused 409.
 */
export const CLIENT_STATUS_TARGETS = ['active', 'suspended', 'departed'] as const satisfies readonly ClientStatus[];
export type ClientStatusTarget = (typeof CLIENT_STATUS_TARGETS)[number];

export interface UpdateClientStatusCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  readonly status: string;
}

/**
 * Story 21-5 — the tax-details patch. Each field is optional: ABSENT leaves
 * it unchanged, `null` (or a blank string) clears it, a value sets it.
 */
export interface UpdateClientTaxDetailsCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  readonly legalName?: string | null | undefined;
  readonly gstin?: string | null | undefined;
  readonly billingLine1?: string | null | undefined;
  readonly billingLine2?: string | null | undefined;
  readonly billingCity?: string | null | undefined;
  readonly billingStateCode?: string | null | undefined;
  readonly billingPincode?: string | null | undefined;
}

/** The tax-detail fields in their fixed order (the hash and the write both use it). */
export const TAX_DETAIL_FIELDS = [
  'legalName',
  'gstin',
  'billingLine1',
  'billingLine2',
  'billingCity',
  'billingStateCode',
  'billingPincode',
] as const satisfies readonly (keyof ClientTaxDetails)[];

type TaxDetailPatch = { -readonly [K in keyof ClientTaxDetails]?: string | null };

/** The legal-name ceiling — the client name's own (the 0062 CHECK). */
export const CLIENT_LEGAL_NAME_MAX = 200;

/**
 * The LENIENT normalize step of the tax-details patch (never throws — it is
 * what the idempotency hash fingerprints): trim, a blank string reads as
 * `null` (clear), the GSTIN uppercased; an ABSENT field stays absent. The
 * keys come out in `TAX_DETAIL_FIELDS` order, absent ones omitted — so a
 * patch of one field hashes as exactly that field.
 */
export function normalizeTaxDetailPatch(command: UpdateClientTaxDetailsCommand): TaxDetailPatch {
  const patch: TaxDetailPatch = {};
  for (const field of TAX_DETAIL_FIELDS) {
    const raw = command[field];
    if (raw === undefined) continue;
    if (raw === null || typeof raw !== 'string') {
      patch[field] = raw === null ? null : (raw as unknown as string);
      continue;
    }
    const trimmed = raw.trim();
    patch[field] = trimmed === '' ? null : field === 'gstin' ? trimmed.toUpperCase() : trimmed;
  }
  return patch;
}

/** Every rule a tax-details patch (merged over the stored values) must satisfy, as named problems. */
export function taxDetailProblems(merged: ClientTaxDetails): string[] {
  const problems: string[] = [];
  const tooLong = (field: string, value: string | null, max: number): void => {
    if (value !== null && [...value].length > max) problems.push(`${field} must be at most ${max} characters (got ${[...value].length})`);
  };
  for (const [field, value] of Object.entries(merged)) {
    if (value !== null && typeof value !== 'string') problems.push(`${field} must be a string or null`);
  }
  if (problems.length > 0) return problems;
  tooLong('legalName', merged.legalName, CLIENT_LEGAL_NAME_MAX);
  if (merged.gstin !== null) {
    if (!GSTIN_RE.test(merged.gstin)) {
      problems.push(`gstin must be a 15-character GSTIN (two digits, thirteen alphanumeric characters; got "${merged.gstin}")`);
    } else {
      const prefix = gstinPrefixProblem(merged.gstin);
      if (prefix !== null) problems.push(`gstin ${prefix}`);
    }
  }
  tooLong('billingLine1', merged.billingLine1, ADDRESS_FIELD_LENGTHS.line1);
  tooLong('billingLine2', merged.billingLine2, ADDRESS_FIELD_LENGTHS.line2);
  tooLong('billingCity', merged.billingCity, ADDRESS_FIELD_LENGTHS.city);
  if (merged.billingStateCode !== null && !isGstinStateCode(merged.billingStateCode)) {
    problems.push(`billingStateCode must be a GST registration state code (got "${merged.billingStateCode}")`);
  }
  if (merged.billingPincode !== null && !PINCODE_RE.test(merged.billingPincode)) {
    problems.push(`billingPincode must be six digits (got "${merged.billingPincode}")`);
  }
  if (
    problems.length === 0 &&
    merged.gstin !== null &&
    merged.billingStateCode !== null &&
    merged.gstin.slice(0, 2) !== merged.billingStateCode
  ) {
    problems.push(
      `gstin ${merged.gstin} is registered in state ${merged.gstin.slice(0, 2)}, but billingStateCode is ${merged.billingStateCode} — a registered client is billed in its GSTIN's state`,
    );
  }
  return problems;
}

/**
 * Story 1-2a — the address patch. Each group: ABSENT (undefined) leaves it
 * unchanged, `null` clears it, a value replaces it whole.
 */
export interface UpdateClientAddressesCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  readonly registered?: RegisteredAddressInput | null | undefined;
  readonly returnAddress?: AddressInput | null | undefined;
}

/**
 * Story 1-2b — the receiving policy write: a FULL replace of the four fields
 * (never the addresses DTO's "omitted = unchanged"). The tolerance is in
 * basis points (the web converts a percent by string arithmetic).
 */
export interface UpdateReceivingPolicyCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  readonly receivingToleranceBps: number;
  readonly qcOnReceipt: boolean;
  readonly expiryRequired: boolean;
  readonly minShelfLifeDays: number | null;
}

export interface AddClientContactCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  readonly name: string;
  readonly email: string;
  readonly phone?: string | null | undefined;
  readonly roles?: readonly string[] | undefined;
}

/** Story 1-2a — a contact patch: an ABSENT field is unchanged; `phone: null` clears it. */
export interface EditClientContactCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  readonly contactId: string;
  readonly name?: string | undefined;
  readonly email?: string | undefined;
  readonly phone?: string | null | undefined;
  readonly roles?: readonly string[] | undefined;
  readonly isPrimary?: boolean | undefined;
}

export interface RemoveClientContactCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  readonly contactId: string;
}

/** Story 1-2a — the response body of a contact write (the idempotency snapshot). */
export interface ClientContactMutationSnapshot {
  readonly contact: ClientContactSnapshot;
}

/** The API response body for a client mutation (the idempotency snapshot). */
export interface ClientMutationSnapshot {
  readonly client: ClientSnapshot;
}

const CLIENTS_TENANT_CODE = 'clients_tenant_id_code_unique';
const CONTACT_EMAIL_UNIQUE = 'client_contacts_client_email_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** Trim + uppercase — the stored form (the warehouse-code convention). */
export function normalizeClientCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Client admin (story 21-2b): an owner registers a client brand and renames
 * it. The house skeleton (IMPLEMENTATION-GUIDE §1): the payload is
 * normalized and hashed BEFORE the transaction; inside it, authority
 * (`clients.manage`, owner-only, re-read from the DB; `billing.invoice` for
 * the tax details) → replay → shape validation → the write → the audit row →
 * the idempotency key LAST. `create` takes no row lock and replays once;
 * `rename`, `updateTaxDetails` and `updateStatus` lock the client row
 * `FOR UPDATE` after the first replay and replay AGAIN under the lock
 * before any guard (the same-key race step — rename's since 21-11a). No
 * outbox event — nothing downstream consumes a client's existence yet.
 *
 * Deliberately absent (the story's Never list): departure, deletion, and
 * any write to the system-owned `self` client — it is created only by
 * registration (`ensureSelfClientInTx`) and its name mirrors the tenant's,
 * so a rename of it is refused 400. Story 21-10 adds `updateStatus`
 * (suspend / reactivate, `active` ⇄ `suspended` only).
 */
@Injectable()
export class ClientsCommand {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(command: CreateClientCommand, idempotencyKey: string): Promise<ClientMutationSnapshot> {
    const code = normalizeClientCode(command.code);
    const name = command.name.trim();
    const payloadHash = hashCommandPayload({ tenantId: command.tenantId, code, name });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'clients.manage',
      );
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }

      // The command is the boundary (a non-HTTP caller skips the DTO): the
      // same rules the 0059 CHECKs enforce, answered as a named 400 rather
      // than a raw 23514.
      assertClientCode(code);
      assertClientName(name);

      let snapshot: ClientMutationSnapshot;
      try {
        const rows = await tx
          .insert(clients)
          .values({
            id: uuidv7(),
            tenantId: command.tenantId,
            code,
            name,
            status: 'active',
            systemOwned: false,
          })
          .returning();
        snapshot = { client: toClientSnapshot(rows[0]!) };
      } catch (err) {
        // The unique (tenant_id, code) index is the arbiter — a sequential
        // duplicate and a concurrent one both land here.
        if (isUniqueViolationOn(err, CLIENTS_TENANT_CODE)) {
          throw duplicateClientCode(code);
        }
        throw err;
      }

      await this.audit(tx, command.tenantId, command.actorUserId, 'client.created', snapshot.client.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  async rename(command: RenameClientCommand, idempotencyKey: string): Promise<ClientMutationSnapshot> {
    const name = command.name.trim();
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      clientId: command.clientId,
      name,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'clients.manage',
      );
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }

      // A non-uuid id names nothing — 404, never a raw 22P02 (the controller
      // refuses the malformed path param 400 first; this is the non-HTTP
      // boundary).
      if (!UUID_RE.test(command.clientId)) {
        throw clientNotFound(command.clientId);
      }
      const lockedRows = await tx
        .select()
        .from(clients)
        .where(and(eq(clients.tenantId, command.tenantId), eq(clients.id, command.clientId)))
        .limit(1)
        .for('no key update');
      const current = lockedRows[0];
      if (current === undefined) {
        throw clientNotFound(command.clientId);
      }
      // Replay again UNDER the lock — the skeleton's same-key race step
      // (story 21-11a). Here it is for consistency only: a parked same-key
      // duplicate would otherwise take the no-op arm below, which already
      // answers the winner's body and writes nothing.
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }
      if (current.systemOwned) {
        throw new ProblemException(
          'validation-failed',
          400,
          'The self client cannot be renamed',
          "The tenant's own client mirrors the tenant name — it is not renamed here.",
        );
      }
      assertClientName(name);
      // An unchanged name is a no-op: nothing is written, nothing audited.
      if (current.name === name) {
        return { client: toClientSnapshot(current) };
      }

      const rows = await tx
        .update(clients)
        .set({ name, updatedAt: nowIso() })
        .where(and(eq(clients.tenantId, command.tenantId), eq(clients.id, current.id)))
        .returning();
      const snapshot: ClientMutationSnapshot = { client: toClientSnapshot(rows[0]!) };

      await this.audit(tx, command.tenantId, command.actorUserId, 'client.renamed', current.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 21-5 — set a client brand's tax details (the recipient a services
   * tax invoice names). `billing.invoice` (owner + accountant): the person
   * who clears an invoice's recipient gaps fixes them here. The house
   * skeleton: normalize + hash before the tx (absent fields omitted — the
   * conditional-key shape), authority → replay → lock the client row →
   * replay again → the shape rules over the MERGED values (400
   * `validation-failed`: a malformed GSTIN, a state code off the
   * registration list, a GSTIN in another state than the billing state, a
   * bad pincode, an over-long field) → the write → audit
   * `client.tax-details-updated` → the key LAST. The tenant's own `self`
   * client is never invoiced — 400. An unchanged patch writes and audits
   * nothing (the rename precedent).
   */
  async updateTaxDetails(command: UpdateClientTaxDetailsCommand, idempotencyKey: string): Promise<ClientMutationSnapshot> {
    const patch = normalizeTaxDetailPatch(command);
    const payloadHash = hashCommandPayload({ arm: 'tax-details', tenantId: command.tenantId, clientId: command.clientId, ...patch });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      if (!UUID_RE.test(command.clientId)) {
        throw clientNotFound(command.clientId);
      }
      const lockedRows = await tx
        .select()
        .from(clients)
        .where(and(eq(clients.tenantId, command.tenantId), eq(clients.id, command.clientId)))
        .limit(1)
        .for('no key update');
      const current = lockedRows[0];
      if (current === undefined) {
        throw clientNotFound(command.clientId);
      }
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }
      if (current.systemOwned) {
        throw new ProblemException(
          'validation-failed',
          400,
          'The self client has no tax details',
          "The tenant's own client is never invoiced — tax details belong to a client brand.",
        );
      }
      const before = toClientSnapshot(current).taxDetails;
      const merged: ClientTaxDetails = { ...before, ...patch };
      const problems = taxDetailProblems(merged);
      if (problems.length > 0) {
        throw new ProblemException('validation-failed', 400, 'Invalid client tax details', problems.join('; '));
      }
      if (TAX_DETAIL_FIELDS.every((field) => before[field] === merged[field])) {
        return { client: toClientSnapshot(current) };
      }

      const rows = await tx
        .update(clients)
        .set({ ...merged, updatedAt: nowIso() })
        .where(and(eq(clients.tenantId, command.tenantId), eq(clients.id, current.id)))
        .returning();
      const snapshot: ClientMutationSnapshot = { client: toClientSnapshot(rows[0]!) };

      await this.audit(tx, command.tenantId, command.actorUserId, 'client.tax-details-updated', current.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 21-10 — suspend or reactivate a client brand (`active` ⇄
   * `suspended`); story 1-2a — depart it (offboarding) and reactivate a
   * departed one. Owner-only (`clients.manage`). The house skeleton: the
   * status shape check (400) and the hash (`arm: 'status'` first — pinned by
   * a golden, unchanged by 1-2a) before the tx; inside it, authority →
   * replay → the id shape → lock the client row `FOR UPDATE` (404) → replay
   * AGAIN under the lock → the self client (400) → departed → suspended
   * (409 `client-not-active`) → a same-status no-op → (departure only) the
   * wind-down check (409 `client-not-wound-down`, every blocker listed) →
   * the write → the portal sessions end (suspend: `client-suspended`; depart:
   * `client-departed`) → audit `client.suspended` / `client.reactivated` /
   * `client.departed` → the key LAST. No outbox event.
   *
   * The no-op DOES write the key, unlike rename: a status is not idempotent
   * in value. After someone else reactivates, a late retry of a stored
   * no-op "suspend" must replay the stored answer, never suspend again. A
   * REFUSED departure writes no key (the transaction rolls back), so a retry
   * after winding down re-runs the check.
   *
   * The lock stays `FOR UPDATE` (1-2a): it conflicts with the `FOR KEY SHARE`
   * every work creator takes through `assertClientTakesWorkInTx`, so a
   * departure and a creation serialise — the wind-down check below sees
   * every creation that committed first, and every creation after it reads
   * `departed`.
   */
  async updateStatus(command: UpdateClientStatusCommand, idempotencyKey: string): Promise<ClientMutationSnapshot> {
    // The command is the boundary (a non-HTTP caller skips the DTO): a
    // request-shape check, above the transaction (IMPLEMENTATION-GUIDE §1).
    if (!(CLIENT_STATUS_TARGETS as readonly string[]).includes(command.status)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Invalid client status',
        `status must be one of ${JSON.stringify(CLIENT_STATUS_TARGETS)} (got ${JSON.stringify(command.status)}).`,
      );
    }
    const status = command.status as ClientStatusTarget;
    const payloadHash = hashCommandPayload({ arm: 'status', tenantId: command.tenantId, clientId: command.clientId, status });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'clients.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      if (!UUID_RE.test(command.clientId)) {
        throw clientNotFound(command.clientId);
      }
      const lockedRows = await tx
        .select()
        .from(clients)
        .where(and(eq(clients.tenantId, command.tenantId), eq(clients.id, command.clientId)))
        .limit(1)
        .for('update');
      const current = lockedRows[0];
      if (current === undefined) {
        throw clientNotFound(command.clientId);
      }
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }
      if (current.systemOwned) {
        throw new ProblemException(
          'validation-failed',
          400,
          'The self client cannot change status',
          "The tenant's own client has no portal and never departs — the self client cannot be suspended, departed or reactivated.",
        );
      }
      if (current.status === 'departed' && status === 'suspended') {
        throw new ProblemException(
          'client-not-active',
          409,
          'Client is not active',
          `Client "${current.code}" has departed — a departed client can only be reactivated.`,
        );
      }
      if (current.status === status) {
        // A no-op writes and audits nothing — but the key IS stored (see above).
        const unchanged: ClientMutationSnapshot = { client: toClientSnapshot(current) };
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, unchanged);
        return unchanged;
      }
      if (status === 'departed') {
        // Story 1-2a decision 1 — departure only once wound down. Under the
        // row's FOR UPDATE: every creation that committed first is counted.
        const blockers = await clientWindDownBlockersInTx(tx, command.tenantId, current.id);
        if (blockers.length > 0) {
          throw clientNotWoundDown(current.code, blockers);
        }
      }

      const rows = await tx
        .update(clients)
        .set({ status, updatedAt: nowIso() })
        .where(and(eq(clients.tenantId, command.tenantId), eq(clients.id, current.id)))
        .returning();
      const snapshot: ClientMutationSnapshot = { client: toClientSnapshot(rows[0]!) };
      // Story 6-1a — a suspension ends the client's portal sessions now (the
      // portal guard's per-request client read stays the second check);
      // story 1-2a — so does a departure. A reactivation restores none: the
      // portal user signs in again.
      if (status === 'suspended') {
        await revokeSessionsInTx(tx, command.tenantId, { clientId: current.id, kinds: ['portal'] }, 'client-suspended');
      } else if (status === 'departed') {
        await revokeSessionsInTx(tx, command.tenantId, { clientId: current.id, kinds: ['portal'] }, 'client-departed');
      }

      await this.audit(
        tx,
        command.tenantId,
        command.actorUserId,
        status === 'suspended' ? 'client.suspended' : status === 'departed' ? 'client.departed' : 'client.reactivated',
        current.id,
        idempotencyKey,
      );
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 1-2a — the client's registered and return addresses. `clients.manage`
   * (owner-only). Each group: ABSENT leaves it unchanged, `null` clears it, a
   * value replaces it whole. The house skeleton: normalize + hash before the
   * tx (`arm: 'addresses'`, absent groups omitted — the conditional-key
   * shape), authority → replay → lock the client `FOR NO KEY UPDATE` (404) →
   * replay again → the shape rules (400 `validation-failed` naming the field)
   * → an unchanged patch is a no-op that STORES the key (the
   * `clients.addresses:unchanged` arm) → the write → audit
   * `client.addresses_updated` → the key LAST. Allowed on the self client and
   * on a departed one (an address is not work).
   */
  async updateAddresses(command: UpdateClientAddressesCommand, idempotencyKey: string): Promise<ClientMutationSnapshot> {
    const registered = command.registered === undefined ? undefined : normalizeRegisteredAddress(command.registered);
    const returnAddress = command.returnAddress === undefined ? undefined : normalizeReturnAddress(command.returnAddress);
    const payloadHash = hashCommandPayload({
      arm: 'addresses',
      tenantId: command.tenantId,
      clientId: command.clientId,
      ...(registered === undefined ? {} : { registered }),
      ...(returnAddress === undefined ? {} : { return: returnAddress }),
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'clients.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      const current = await this.lockClientForEdit(tx, command.tenantId, command.clientId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }

      const patch: Partial<typeof clients.$inferInsert> = {};
      if (registered !== undefined) {
        const valid = registered === null ? null : assertRegisteredAddress(registered);
        patch.registeredLine1 = valid?.line1 ?? null;
        patch.registeredLine2 = valid?.line2 ?? null;
        patch.registeredCity = valid?.city ?? null;
        patch.registeredStateCode = valid?.stateCode ?? null;
        patch.registeredPincode = valid?.pincode ?? null;
      }
      if (returnAddress !== undefined) {
        const valid = returnAddress === null ? null : assertAddress(returnAddress, 'returnAddress');
        patch.returnContactName = valid?.contactName ?? null;
        patch.returnPhone = valid?.phone ?? null;
        patch.returnLine1 = valid?.line1 ?? null;
        patch.returnLine2 = valid === null ? null : (valid.line2 ?? null);
        patch.returnCity = valid?.city ?? null;
        patch.returnState = valid?.state ?? null;
        patch.returnPincode = valid?.pincode ?? null;
      }
      const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((field) => patch[field] !== current[field as keyof typeof current]);
      if (!changed) {
        // A declared no-op (`clients.addresses:unchanged`): nothing written or
        // audited, the key stored — the status precedent, so a late retry
        // after another edit replays this answer rather than reverting it.
        const unchanged: ClientMutationSnapshot = { client: toClientSnapshot(current) };
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, unchanged);
        return unchanged;
      }
      const rows = await tx
        .update(clients)
        .set({ ...patch, updatedAt: nowIso() })
        .where(and(eq(clients.tenantId, command.tenantId), eq(clients.id, current.id)))
        .returning();
      const snapshot: ClientMutationSnapshot = { client: toClientSnapshot(rows[0]!) };
      await this.audit(tx, command.tenantId, command.actorUserId, 'client.addresses_updated', current.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 1-2b — a client's receiving policy (`clients.manage`, owner-only).
   * A FULL replace of the four fields. The `updateAddresses` skeleton: hash
   * before the tx (`arm: 'receiving-policy'`, the tolerance as its bps
   * integer) → authority → replay → lock the client `FOR NO KEY UPDATE`
   * (404) → replay again under the lock → the shape rules (400
   * `validation-failed` naming the field) → an unchanged policy is a no-op
   * that STORES the key (`clients.receivingPolicy:unchanged`) and writes
   * nothing else → the write → audit `client.receiving_policy_updated` → the
   * key LAST. Allowed on the self client and on a departed one (a policy is
   * not work).
   */
  async updateReceivingPolicy(
    command: UpdateReceivingPolicyCommand,
    idempotencyKey: string,
  ): Promise<ClientMutationSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'receiving-policy',
      tenantId: command.tenantId,
      clientId: command.clientId,
      receivingToleranceBps: command.receivingToleranceBps,
      qcOnReceipt: command.qcOnReceipt,
      expiryRequired: command.expiryRequired,
      minShelfLifeDays: command.minShelfLifeDays,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'clients.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      const current = await this.lockClientForEdit(tx, command.tenantId, command.clientId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }
      const valid = assertReceivingPolicy(command);
      const changed =
        valid.receivingToleranceBps !== current.receivingToleranceBps ||
        valid.qcOnReceipt !== current.qcOnReceipt ||
        valid.expiryRequired !== current.expiryRequired ||
        valid.minShelfLifeDays !== current.minShelfLifeDays;
      if (!changed) {
        // A declared no-op (`clients.receivingPolicy:unchanged`): nothing
        // written or audited, the key stored — so a late retry after another
        // edit replays this answer rather than reverting it.
        const unchanged: ClientMutationSnapshot = { client: toClientSnapshot(current) };
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, unchanged);
        return unchanged;
      }
      const rows = await tx
        .update(clients)
        .set({ ...valid, updatedAt: nowIso() })
        .where(and(eq(clients.tenantId, command.tenantId), eq(clients.id, current.id)))
        .returning();
      const snapshot: ClientMutationSnapshot = { client: toClientSnapshot(rows[0]!) };
      await this.audit(tx, command.tenantId, command.actorUserId, 'client.receiving_policy_updated', current.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 1-2a — add a contact to a client (`clients.manage`). The house
   * skeleton: normalize + hash (`arm: 'contact-add'`) → authority → replay →
   * lock the client `FOR NO KEY UPDATE` (404) → replay again → the shape
   * rules (400 naming the field) → at most `MAX_CLIENT_CONTACTS` (409
   * `contact-limit`) → the email unique per client (409
   * `duplicate-contact-email`, the unique index the arbiter) → the insert
   * (the FIRST contact becomes primary) → audit `client.contact_added` → key.
   */
  async addContact(command: AddClientContactCommand, idempotencyKey: string): Promise<ClientContactMutationSnapshot> {
    const fields = normalizeContactFields(command);
    const payloadHash = hashCommandPayload({
      arm: 'contact-add',
      tenantId: command.tenantId,
      clientId: command.clientId,
      name: fields.name,
      email: fields.email,
      phone: fields.phone ?? null,
      roles: fields.roles ?? [],
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'clients.manage');
      const replayed = await this.replayContact(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      const client = await this.lockClientForEdit(tx, command.tenantId, command.clientId);
      const replayedUnderLock = await this.replayContact(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }
      const valid = assertContactFields({
        name: fields.name,
        email: fields.email,
        phone: fields.phone ?? null,
        roles: fields.roles ?? [],
      });
      const existing = await tx
        .select({ id: clientContacts.id, email: clientContacts.email })
        .from(clientContacts)
        .where(and(eq(clientContacts.tenantId, command.tenantId), eq(clientContacts.clientId, client.id)));
      if (existing.length >= MAX_CLIENT_CONTACTS) {
        throw new ProblemException(
          'contact-limit',
          409,
          'Too many contacts',
          `Client "${client.code}" already has ${MAX_CLIENT_CONTACTS} contacts — remove one before adding another.`,
        );
      }
      if (existing.some((row) => row.email === valid.email)) {
        throw duplicateContactEmail(valid.email);
      }
      let inserted: typeof clientContacts.$inferSelect;
      try {
        const rows = await tx
          .insert(clientContacts)
          .values({
            id: uuidv7(),
            tenantId: command.tenantId,
            clientId: client.id,
            name: valid.name,
            email: valid.email,
            phone: valid.phone,
            roles: [...valid.roles],
            isPrimary: existing.length === 0,
          })
          .returning();
        inserted = rows[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, CONTACT_EMAIL_UNIQUE)) {
          throw duplicateContactEmail(valid.email);
        }
        throw err;
      }
      const snapshot: ClientContactMutationSnapshot = { contact: toClientContactSnapshot(inserted) };
      await this.audit(tx, command.tenantId, command.actorUserId, 'client.contact_added', client.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 1-2a — edit a contact (`clients.manage`). A patch: an ABSENT field
   * is unchanged, `phone: null` clears the phone; `isPrimary: true` makes it
   * the primary (`false` is a 400 above the transaction — the primary moves
   * only by naming the new one). Moving the primary is TWO statements in this
   * one transaction — clear the old, then set the new — because the partial
   * unique index is not deferrable and a one-statement swap would trip it.
   * An unchanged edit is a declared no-op that stores the key
   * (`clients.contactEdit:unchanged`).
   */
  async editContact(command: EditClientContactCommand, idempotencyKey: string): Promise<ClientContactMutationSnapshot> {
    if (command.isPrimary === false) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Invalid contact edit',
        'isPrimary may only be true — make another contact primary to move the primary.',
      );
    }
    const fields = normalizeContactFields(command);
    const payloadHash = hashCommandPayload({
      arm: 'contact-edit',
      tenantId: command.tenantId,
      clientId: command.clientId,
      contactId: command.contactId,
      ...(fields.name === undefined ? {} : { name: fields.name }),
      ...(fields.email === undefined ? {} : { email: fields.email }),
      ...(fields.phone === undefined ? {} : { phone: fields.phone }),
      ...(fields.roles === undefined ? {} : { roles: fields.roles }),
      ...(command.isPrimary === undefined ? {} : { isPrimary: command.isPrimary }),
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'clients.manage');
      const replayed = await this.replayContact(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      const client = await this.lockClientForEdit(tx, command.tenantId, command.clientId);
      const replayedUnderLock = await this.replayContact(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }
      const current = await this.readContact(tx, command.tenantId, client.id, command.contactId);
      const valid = assertContactFields({
        name: fields.name ?? current.name,
        email: fields.email ?? current.email,
        phone: fields.phone === undefined ? current.phone : fields.phone,
        roles: fields.roles ?? (current.roles as ClientContactRole[]),
      });
      const makePrimary = command.isPrimary === true && !current.isPrimary;
      const unchanged =
        !makePrimary &&
        valid.name === current.name &&
        valid.email === current.email &&
        valid.phone === current.phone &&
        sameRoles(valid.roles, current.roles);
      if (unchanged) {
        const snapshot: ClientContactMutationSnapshot = { contact: toClientContactSnapshot(current) };
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }
      if (valid.email !== current.email) {
        const clash = await tx
          .select({ id: clientContacts.id })
          .from(clientContacts)
          .where(
            and(
              eq(clientContacts.tenantId, command.tenantId),
              eq(clientContacts.clientId, client.id),
              eq(clientContacts.email, valid.email),
              ne(clientContacts.id, current.id),
            ),
          )
          .limit(1);
        if (clash.length > 0) {
          throw duplicateContactEmail(valid.email);
        }
      }
      if (makePrimary) {
        // Two statements, one transaction: clear the old primary FIRST.
        await tx
          .update(clientContacts)
          .set({ isPrimary: false, updatedAt: nowIso() })
          .where(
            and(
              eq(clientContacts.tenantId, command.tenantId),
              eq(clientContacts.clientId, client.id),
              eq(clientContacts.isPrimary, true),
            ),
          );
      }
      let updated: typeof clientContacts.$inferSelect;
      try {
        const rows = await tx
          .update(clientContacts)
          .set({
            name: valid.name,
            email: valid.email,
            phone: valid.phone,
            roles: [...valid.roles],
            ...(makePrimary ? { isPrimary: true } : {}),
            updatedAt: nowIso(),
          })
          .where(and(eq(clientContacts.tenantId, command.tenantId), eq(clientContacts.id, current.id)))
          .returning();
        updated = rows[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, CONTACT_EMAIL_UNIQUE)) {
          throw duplicateContactEmail(valid.email);
        }
        throw err;
      }
      const snapshot: ClientContactMutationSnapshot = { contact: toClientContactSnapshot(updated) };
      await this.audit(tx, command.tenantId, command.actorUserId, 'client.contact_edited', client.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 1-2a — remove a contact (`clients.manage`). The primary cannot be
   * removed while other contacts remain (409 `primary-contact-required` —
   * make another primary first); the last contact can. Audited
   * `client.contact_removed`; the answer is the removed contact.
   */
  async removeContact(command: RemoveClientContactCommand, idempotencyKey: string): Promise<ClientContactMutationSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'contact-remove',
      tenantId: command.tenantId,
      clientId: command.clientId,
      contactId: command.contactId,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'clients.manage');
      const replayed = await this.replayContact(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      const client = await this.lockClientForEdit(tx, command.tenantId, command.clientId);
      const replayedUnderLock = await this.replayContact(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }
      const current = await this.readContact(tx, command.tenantId, client.id, command.contactId);
      if (current.isPrimary) {
        const others = await tx
          .select({ id: clientContacts.id })
          .from(clientContacts)
          .where(
            and(
              eq(clientContacts.tenantId, command.tenantId),
              eq(clientContacts.clientId, client.id),
              ne(clientContacts.id, current.id),
            ),
          )
          .limit(1);
        if (others.length > 0) {
          throw new ProblemException(
            'primary-contact-required',
            409,
            'The primary contact cannot be removed',
            `${current.name} is the primary contact of client "${client.code}" — make another contact primary first.`,
          );
        }
      }
      await tx
        .delete(clientContacts)
        .where(and(eq(clientContacts.tenantId, command.tenantId), eq(clientContacts.id, current.id)));
      const snapshot: ClientContactMutationSnapshot = { contact: toClientContactSnapshot(current) };
      await this.audit(tx, command.tenantId, command.actorUserId, 'client.contact_removed', client.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /** Story 1-2a — the client row `FOR NO KEY UPDATE` (the non-status writers' lock), 404 when absent. */
  private async lockClientForEdit(
    tx: TenantTx,
    tenantId: string,
    clientId: string,
  ): Promise<typeof clients.$inferSelect> {
    if (!UUID_RE.test(clientId)) {
      throw clientNotFound(clientId);
    }
    const rows = await tx
      .select()
      .from(clients)
      .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
      .limit(1)
      .for('no key update');
    const row = rows[0];
    if (row === undefined) {
      throw clientNotFound(clientId);
    }
    return row;
  }

  /** One contact of the (locked) client, 404 `not-found` otherwise (another client's is the same 404). */
  private async readContact(
    tx: TenantTx,
    tenantId: string,
    clientId: string,
    contactId: string,
  ): Promise<typeof clientContacts.$inferSelect> {
    if (!UUID_RE.test(contactId)) {
      throw contactNotFound(contactId);
    }
    const rows = await tx
      .select()
      .from(clientContacts)
      .where(
        and(eq(clientContacts.tenantId, tenantId), eq(clientContacts.clientId, clientId), eq(clientContacts.id, contactId)),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw contactNotFound(contactId);
    }
    return row;
  }

  private async replayContact(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<ClientContactMutationSnapshot | null> {
    return (await this.replay(tx, tenantId, idempotencyKey, payloadHash)) as ClientContactMutationSnapshot | null;
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<ClientMutationSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (row === undefined) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return row.responseSnapshot as ClientMutationSnapshot;
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    actorUserId: string,
    action:
      | 'client.created'
      | 'client.renamed'
      | 'client.tax-details-updated'
      | 'client.suspended'
      | 'client.reactivated'
      | 'client.departed'
      | 'client.addresses_updated'
      | 'client.receiving_policy_updated'
      | 'client.contact_added'
      | 'client.contact_edited'
      | 'client.contact_removed',
    clientId: string,
    reference: string,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId,
      action,
      targetType: 'client',
      targetId: clientId,
      reference,
      occurredAt: nowIso(),
    });
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: ClientMutationSnapshot | ClientContactMutationSnapshot,
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

/** The created-client code rule (the 0059 CHECKs, answered as a 400). */
export function assertClientCode(code: string): void {
  if (code === SELF_CLIENT_CODE.toUpperCase()) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Client code is reserved',
      `Client code "${code}" is reserved for the tenant's own client — choose another code.`,
    );
  }
  if (!CLIENT_CODE_RE.test(code)) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Invalid client code',
      `Client code "${code}" must be 2-32 characters of A-Z, 0-9 and "-", starting with a letter or digit.`,
    );
  }
}

export function assertClientName(name: string): void {
  const length = [...name].length;
  if (length < 1 || length > CLIENT_NAME_MAX) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Invalid client name',
      `Client name must be 1-${CLIENT_NAME_MAX} characters once trimmed (got ${length}).`,
    );
  }
}

function duplicateClientCode(code: string): ProblemException {
  return new ProblemException(
    'duplicate-client-code',
    409,
    'Client code already in use',
    `Client code "${code}" already exists for this tenant.`,
  );
}

/**
 * Story 1-2a — every wind-down blocker of one client, composed from the
 * owning modules' file-level reads, in `WIND_DOWN_BLOCKER_KINDS` order.
 * Empty = the client may depart.
 */
export async function clientWindDownBlockersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<WindDownBlocker[]> {
  const all = [
    ...(await inventoryBlockersInTx(tx, tenantId, clientId)),
    ...(await inboundBlockersInTx(tx, tenantId, clientId)),
    ...(await outboundBlockersInTx(tx, tenantId, clientId)),
    ...(await returnsBlockersInTx(tx, tenantId, clientId)),
    ...(await tenancyBlockersInTx(tx, tenantId, clientId)),
    ...(await billingBlockersInTx(tx, tenantId, clientId)),
    ...(await channelsBlockersInTx(tx, tenantId, clientId)),
  ];
  return [...all].sort((a, b) => WIND_DOWN_BLOCKER_KINDS.indexOf(a.kind) - WIND_DOWN_BLOCKER_KINDS.indexOf(b.kind));
}

/** Story 1-2a — 409 `client-not-wound-down`, every blocker in `extensions.blockers`. */
export function clientNotWoundDown(code: string, blockers: readonly WindDownBlocker[]): ProblemException {
  const listed = blockers.map((blocker) => `${blocker.kind} (${blocker.count})`).join(', ');
  return new ProblemException(
    'client-not-wound-down',
    409,
    'Client is not wound down',
    `Client "${code}" cannot depart while work remains: ${listed}. Finish, cancel or settle each, then depart it again.`,
    { blockers },
  );
}

/**
 * Story 1-2a — the LENIENT normalize step of a contact write (never throws —
 * it is what the hash fingerprints): the name trimmed, the email trimmed and
 * lower-cased, a blank phone read as `null`, the roles sorted into
 * vocabulary order (an unknown role kept, sorted last, for the validator to
 * refuse by name). An absent field stays absent.
 */
export function normalizeContactFields(command: {
  readonly name?: string | undefined;
  readonly email?: string | undefined;
  readonly phone?: string | null | undefined;
  readonly roles?: readonly string[] | undefined;
}): { name?: string; email?: string; phone?: string | null; roles?: string[] } {
  const out: { name?: string; email?: string; phone?: string | null; roles?: string[] } = {};
  if (command.name !== undefined) out.name = typeof command.name === 'string' ? command.name.trim() : command.name;
  if (command.email !== undefined) {
    out.email = typeof command.email === 'string' ? normalizeEmailAddress(command.email) : command.email;
  }
  if (command.phone !== undefined) {
    const phone = typeof command.phone === 'string' ? command.phone.trim() : command.phone;
    out.phone = phone === '' ? null : phone;
  }
  if (command.roles !== undefined) {
    const rank = (role: string): number => {
      const index = (CLIENT_CONTACT_ROLES as readonly string[]).indexOf(role);
      return index === -1 ? CLIENT_CONTACT_ROLES.length : index;
    };
    out.roles = Array.isArray(command.roles)
      ? [...command.roles].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
      : (command.roles as unknown as string[]);
  }
  return out;
}

/** Story 1-2a — a contact's shape rules (400 `validation-failed` naming the field). */
export function assertContactFields(fields: {
  readonly name: unknown;
  readonly email: unknown;
  readonly phone: unknown;
  readonly roles: unknown;
}): { name: string; email: string; phone: string | null; roles: readonly ClientContactRole[] } {
  const invalid = (detail: string): ProblemException =>
    new ProblemException('validation-failed', 400, 'Invalid client contact', detail);
  if (typeof fields.name !== 'string') throw invalid('name must be text.');
  const nameLength = [...fields.name].length;
  if (nameLength < 1 || nameLength > CLIENT_CONTACT_NAME_MAX) {
    throw invalid(`name must be 1-${CLIENT_CONTACT_NAME_MAX} characters once trimmed (got ${nameLength}).`);
  }
  if (typeof fields.email !== 'string' || !isEmailAddress(fields.email)) {
    throw invalid(
      `email must be an ASCII email address of at most ${EMAIL_MAX_LENGTH} characters (got ${JSON.stringify(fields.email)}).`,
    );
  }
  let phone: string | null = null;
  if (fields.phone !== null) {
    if (typeof fields.phone !== 'string') throw invalid('phone must be text or null.');
    phone = assertPhone(fields.phone, 'phone');
  }
  if (!Array.isArray(fields.roles)) throw invalid('roles must be a list.');
  const roles = fields.roles as unknown[];
  for (const role of roles) {
    if (typeof role !== 'string' || !(CLIENT_CONTACT_ROLES as readonly string[]).includes(role)) {
      throw invalid(`roles must each be one of ${JSON.stringify(CLIENT_CONTACT_ROLES)} (got ${JSON.stringify(role)}).`);
    }
  }
  if (new Set(roles).size !== roles.length) {
    throw invalid('roles must not repeat a role.');
  }
  return { name: fields.name, email: fields.email, phone, roles: roles as ClientContactRole[] };
}

function sameRoles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((role, index) => role === b[index]);
}

/** Story 1-2a — the return address's lenient normalize (the shipment shape's own). */
export function normalizeReturnAddress(input: AddressInput | null): AddressInput | null {
  return input === null ? null : (normalizeAddressInput(input) ?? null);
}

/**
 * Story 1-2b — the receiving policy's shape rules (the 0078 CHECKs, answered
 * as a 400 `validation-failed` naming the field): the tolerance an integer
 * 0–10000 basis points; the minimum remaining life null or an integer
 * 1–3650 days, and only beside `expiryRequired`.
 */
export function assertReceivingPolicy(command: {
  readonly receivingToleranceBps: unknown;
  readonly qcOnReceipt: unknown;
  readonly expiryRequired: unknown;
  readonly minShelfLifeDays: unknown;
}): {
  receivingToleranceBps: number;
  qcOnReceipt: boolean;
  expiryRequired: boolean;
  minShelfLifeDays: number | null;
} {
  // The refused field rides as an extension member (`field`), so the web maps
  // the error to its input by name, never by reading the prose.
  const invalid = (field: string, detail: string): ProblemException =>
    new ProblemException('validation-failed', 400, 'Invalid receiving policy', detail, { field });
  const bps = command.receivingToleranceBps;
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > RECEIVING_TOLERANCE_BPS_MAX) {
    throw invalid(
      'receivingToleranceBps',
      `receivingToleranceBps must be a whole number of basis points from 0 to ${RECEIVING_TOLERANCE_BPS_MAX} (got ${JSON.stringify(bps)}).`,
    );
  }
  if (typeof command.qcOnReceipt !== 'boolean') {
    throw invalid('qcOnReceipt', `qcOnReceipt must be true or false (got ${JSON.stringify(command.qcOnReceipt)}).`);
  }
  if (typeof command.expiryRequired !== 'boolean') {
    throw invalid('expiryRequired', `expiryRequired must be true or false (got ${JSON.stringify(command.expiryRequired)}).`);
  }
  const days = command.minShelfLifeDays;
  if (days !== null) {
    if (typeof days !== 'number' || !Number.isInteger(days) || days < MIN_SHELF_LIFE_DAYS_MIN || days > MIN_SHELF_LIFE_DAYS_MAX) {
      throw invalid(
        'minShelfLifeDays',
        `minShelfLifeDays must be null or a whole number of days from ${MIN_SHELF_LIFE_DAYS_MIN} to ${MIN_SHELF_LIFE_DAYS_MAX} (got ${JSON.stringify(days)}).`,
      );
    }
    if (!command.expiryRequired) {
      throw invalid('minShelfLifeDays', 'minShelfLifeDays needs expiryRequired — a minimum remaining life is judged against a required expiry date.');
    }
  }
  return {
    receivingToleranceBps: bps,
    qcOnReceipt: command.qcOnReceipt,
    expiryRequired: command.expiryRequired,
    minShelfLifeDays: days,
  };
}

function duplicateContactEmail(email: string): ProblemException {
  return new ProblemException(
    'duplicate-contact-email',
    409,
    'Contact email already in use',
    `A contact with email "${email}" already exists for this client.`,
  );
}

function contactNotFound(contactId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Contact not found',
    `No contact with id "${contactId}" exists for this client.`,
  );
}
