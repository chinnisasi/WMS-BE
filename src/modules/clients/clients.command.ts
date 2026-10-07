import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { CLIENT_CODE_RE, CLIENT_NAME_MAX, SELF_CLIENT_CODE, clients } from './clients.schema';
import { clientNotFound, toClientSnapshot, type ClientSnapshot, type ClientTaxDetails } from './clients.facade';
import { ADDRESS_FIELD_LENGTHS, PINCODE_RE } from '../../shared/primitives/address';
import { GSTIN_RE, gstinPrefixProblem, isGstinStateCode } from '../../shared/primitives/gstin';

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

/** The API response body for a client mutation (the idempotency snapshot). */
export interface ClientMutationSnapshot {
  readonly client: ClientSnapshot;
}

const CLIENTS_TENANT_CODE = 'clients_tenant_id_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** Trim + uppercase — the stored form (the warehouse-code convention). */
export function normalizeClientCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Client admin (story 21-2b): an owner registers a client brand and renames
 * it. The house skeleton (IMPLEMENTATION-GUIDE §1): the payload is
 * normalized and hashed BEFORE the transaction; inside it, authority
 * (`clients.manage`, owner-only, re-read from the DB) → replay → shape
 * validation → the write → the audit row → the idempotency key LAST. No
 * outbox event — nothing downstream consumes a client's existence yet.
 *
 * Deliberately absent (the story's Never list): status transitions,
 * deletion, and any write to the system-owned `self` client — it is created
 * only by registration (`ensureSelfClientInTx`) and its name mirrors the
 * tenant's, so a rename of it is refused 400.
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
        .for('update');
      const current = lockedRows[0];
      if (current === undefined) {
        throw clientNotFound(command.clientId);
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
    action: 'client.created' | 'client.renamed' | 'client.tax-details-updated',
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
    snapshot: ClientMutationSnapshot,
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
