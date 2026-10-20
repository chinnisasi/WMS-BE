import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, licences, type LicenceRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK, type OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, isIsoDate, istDateOf, nowIso } from '../../shared/primitives/time';
import {
  KINDS_REQUIRING_VALID_UNTIL,
  LICENCE_NOTE_MAX,
  isLicenceKind,
  licenceNumberProblem,
  normalizeLicenceNumber,
  warningState,
  type LicenceKind,
  type LicenceStatus,
  type LicenceWarningState,
} from '../../shared/primitives/licence';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
// Story 1-6c — compliance reads the holder through the clients module's file-level
// seam functions (the `excursion.command.ts` precedent for tenancy's): no Nest
// module import, so the tenancy → compliance import adds no cycle.
import { assertClientInTenantInTx, assertClientTakesWorkInTx } from '../clients/clients.facade';

// ── the clock and the events ─────────────────────────────────────────────────

/**
 * The licence clock (IMPLEMENTATION-GUIDE §7c): "today" for the edit's
 * warning comparison and every read's `asOfDate`. Tests ASSIGN `now` (jest's
 * `restoreMocks` would undo a spy) and restore it after.
 */
export const licenceClock = { now: (): number => Date.now() };

/** The IST calendar date the licence clock reads. */
export function licenceToday(): string {
  return istDateOf(new Date(licenceClock.now()).toISOString());
}

/** Outbox: a warning opens an entry (`licence-expiry`); the clear resolves it. */
export const LICENCE_EXPIRY_UPCOMING_EVENT = 'licence.expiry_upcoming';
export const LICENCE_EXPIRED_EVENT = 'licence.expired';
export const LICENCE_WARNING_CLEARED_EVENT = 'licence.expiry_warning_cleared';
/** Why an open warning cleared (decision 8). */
export const LICENCE_WARNING_OUTCOMES = ['renewed', 'withdrawn', 'expired'] as const;
export type LicenceWarningOutcome = (typeof LICENCE_WARNING_OUTCOMES)[number];

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
/** The family-unique number index (0084, SQL only). */
export const LICENCE_FAMILY_NUMBER_UNIQUE = 'licences_family_number_unique';

// ── command inputs ───────────────────────────────────────────────────────────

export interface AddLicenceCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  /** The client brand holding it; null for a site licence. */
  readonly clientId: string | null;
  /** The site of a site licence, or the premises of a client licence; null = a client's head-office licence. */
  readonly warehouseId: string | null;
  readonly kind: LicenceKind;
  readonly number: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly note: string | null;
}

/** An edit: an ABSENT field (undefined) is kept; null clears (never for `number`). */
export interface EditLicenceCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly licenceId: string;
  readonly number?: string | null | undefined;
  readonly validFrom?: string | null | undefined;
  readonly validUntil?: string | null | undefined;
  readonly note?: string | null | undefined;
}

export interface WithdrawLicenceCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly licenceId: string;
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** One licence as every write answers it (the idempotency snapshot). */
export interface LicenceSnapshot {
  readonly id: string;
  readonly clientId: string | null;
  readonly warehouseId: string | null;
  readonly kind: LicenceKind;
  readonly number: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly note: string | null;
  readonly status: LicenceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LicenceMutationSnapshot {
  readonly licence: LicenceSnapshot;
}

export function toLicenceSnapshot(row: LicenceRow): LicenceSnapshot {
  return {
    id: row.id,
    clientId: row.clientId,
    warehouseId: row.warehouseId,
    kind: row.kind as LicenceKind,
    number: row.number,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    note: row.note,
    status: row.status as LicenceStatus,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

// ── refusals ─────────────────────────────────────────────────────────────────

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid licence', detail);
}

export function licenceNotFound(licenceId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Licence not found', `No licence with id "${licenceId}" exists in this tenant.`);
}

function licenceWithdrawn(): ProblemException {
  return new ProblemException(
    'licence-withdrawn',
    409,
    'The licence is withdrawn',
    'This licence was withdrawn — it can no longer be edited or withdrawn. Add a new licence instead.',
  );
}

function licenceNumberTaken(number: string): ProblemException {
  return new ProblemException(
    'licence-number-taken',
    409,
    'Licence number already recorded',
    `An active licence of this family already carries number "${number}" — withdraw it first, or correct the number.`,
  );
}

/** A note: trimmed; blank is none. Undefined (absent) stays undefined. */
function normalizeNote(note: string | null | undefined): string | null | undefined {
  if (note === undefined || note === null) return note;
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
}

/** A date field: blank is none (null); the shape is checked by `assertDateShape`. */
function normalizeDate(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function assertDateShape(field: string, value: string | null | undefined): void {
  if (value !== undefined && value !== null && !isIsoDate(value)) {
    throw invalid(`${field} must be a calendar date YYYY-MM-DD (got "${value}").`);
  }
}

/**
 * The rules over a whole (merged) row — the CHECKs' first line, each a 400
 * naming the field: the number per kind, `validUntil` required on FSSAI and
 * NDPS, `validUntil ≥ validFrom`, the note's length.
 */
function assertLicenceRow(row: {
  kind: LicenceKind;
  number: string;
  validFrom: string | null;
  validUntil: string | null;
  note: string | null;
}): void {
  const numberProblem = licenceNumberProblem(row.kind, row.number);
  if (numberProblem !== null) {
    throw invalid(`number: ${numberProblem}`);
  }
  if (row.validUntil === null && KINDS_REQUIRING_VALID_UNTIL.includes(row.kind)) {
    throw invalid(`validUntil is required for a ${row.kind} licence — FSSAI and NDPS licences carry a fixed term.`);
  }
  if (row.validFrom !== null && row.validUntil !== null && row.validUntil < row.validFrom) {
    throw invalid(`validUntil (${row.validUntil}) is before validFrom (${row.validFrom}).`);
  }
  if (row.note !== null && [...row.note].length > LICENCE_NOTE_MAX) {
    throw invalid(`note is at most ${LICENCE_NOTE_MAX} characters.`);
  }
}

/** The warning a row has already been warned at: the latest raise (decision 10). */
export function warnedStateOf(row: Pick<LicenceRow, 'upcomingWarnedOn' | 'expiredWarnedOn'>): LicenceWarningState {
  if (row.expiredWarnedOn !== null) return 'expired';
  if (row.upcomingWarnedOn !== null) return 'upcoming';
  return 'none';
}

/**
 * The licence master (story 1-6c): add a client or site licence, edit it,
 * withdraw it — `licences.manage`, owner-only. The keyed-command skeleton
 * (IMPLEMENTATION-GUIDE §1): normalise + hash (`arm: licence-add |
 * licence-edit | licence-withdraw`) above the transaction → authority →
 * replay → holder existence / the licence row lock (404) → replay again
 * under it → the rules on the merged row (400) → the write (the family
 * unique index answers 409 `licence-number-taken`) → outbox (a cleared
 * warning) → audit (`licence.added | edited | withdrawn`, target `licence`)
 * → the key LAST. An unchanged edit is a declared no-op that stores the key
 * (`licences.edit:unchanged`).
 */
@Injectable()
export class LicenceCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async add(command: AddLicenceCommand, idempotencyKey: string): Promise<LicenceMutationSnapshot> {
    // 0. Request shape, no DB row needed.
    if (!isLicenceKind(command.kind)) {
      throw invalid(`kind must be one of the licence kinds (got "${String(command.kind)}").`);
    }
    if (command.clientId === null && command.warehouseId === null) {
      throw invalid('A licence needs a holder: a clientId (a client licence), a warehouseId (a site licence), or both (a client licence for one site).');
    }
    const number = normalizeLicenceNumber(command.number);
    const validFrom = normalizeDate(command.validFrom) ?? null;
    const validUntil = normalizeDate(command.validUntil) ?? null;
    const note = normalizeNote(command.note) ?? null;
    assertDateShape('validFrom', validFrom);
    assertDateShape('validUntil', validUntil);

    // 1. The hash over the normalised fields, fixed key order.
    const payloadHash = hashCommandPayload({
      arm: 'licence-add',
      tenantId: command.tenantId,
      clientId: command.clientId,
      warehouseId: command.warehouseId,
      kind: command.kind,
      number,
      validFrom,
      validUntil,
      note,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'licences.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      // The holder exists in this tenant (404 not-found).
      const client =
        command.clientId === null ? null : await assertClientInTenantInTx(tx, command.tenantId, command.clientId);
      if (command.warehouseId !== null) {
        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      }
      if (client !== null && client.systemOwned) {
        throw invalid(
          'Your own company holds no client licence — its goods are covered by the site licence. Add a site licence (no clientId) instead.',
        );
      }
      // The client row under `FOR KEY SHARE` (the "no new work" gate): a
      // departure cannot commit between this read and the insert; a departed
      // client gains no licence (409 client-departed).
      if (client !== null) {
        await assertClientTakesWorkInTx(tx, command.tenantId, client.id);
      }
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;

      assertLicenceRow({ kind: command.kind, number, validFrom, validUntil, note });

      let inserted: LicenceRow;
      try {
        const rows = await tx
          .insert(licences)
          .values({
            id: uuidv7(),
            tenantId: command.tenantId,
            clientId: command.clientId,
            warehouseId: command.warehouseId,
            kind: command.kind,
            number,
            validFrom,
            validUntil,
            note,
            status: 'active',
          })
          .returning();
        inserted = rows[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, LICENCE_FAMILY_NUMBER_UNIQUE)) throw licenceNumberTaken(number);
        throw err;
      }
      const snapshot: LicenceMutationSnapshot = { licence: toLicenceSnapshot(inserted) };
      await this.audit(tx, command.tenantId, command.actorUserId, 'licence.added', inserted.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  async edit(command: EditLicenceCommand, idempotencyKey: string): Promise<LicenceMutationSnapshot> {
    if (command.number === null) {
      throw invalid('number cannot be cleared — send the corrected number, or withdraw the licence.');
    }
    const number = command.number === undefined ? undefined : normalizeLicenceNumber(command.number);
    const validFrom = normalizeDate(command.validFrom);
    const validUntil = normalizeDate(command.validUntil);
    const note = normalizeNote(command.note);
    assertDateShape('validFrom', validFrom);
    assertDateShape('validUntil', validUntil);

    // Absent keys are omitted (absent = keep); a null is kept (null = clear).
    const payloadHash = hashCommandPayload({
      arm: 'licence-edit',
      tenantId: command.tenantId,
      licenceId: command.licenceId,
      ...(number === undefined ? {} : { number }),
      ...(validFrom === undefined ? {} : { validFrom }),
      ...(validUntil === undefined ? {} : { validUntil }),
      ...(note === undefined ? {} : { note }),
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'licences.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const current = await this.lockLicence(tx, command.tenantId, command.licenceId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (current.status === 'withdrawn') throw licenceWithdrawn();

      const merged = {
        kind: current.kind as LicenceKind,
        number: number ?? current.number,
        validFrom: validFrom === undefined ? current.validFrom : validFrom,
        validUntil: validUntil === undefined ? current.validUntil : validUntil,
        note: note === undefined ? current.note : note,
      };
      assertLicenceRow(merged);

      const unchanged =
        merged.number === current.number &&
        merged.validFrom === current.validFrom &&
        merged.validUntil === current.validUntil &&
        merged.note === current.note;
      if (unchanged) {
        // A declared no-op (`licences.edit:unchanged`): nothing written or audited; the key is stored.
        const snapshot: LicenceMutationSnapshot = { licence: toLicenceSnapshot(current) };
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }

      // Decision 10: a changed `validUntil` whose implied warning differs from
      // the warned one clears the open warning (`renewed`) and resets both
      // warned dates — the sweep then warns afresh for the new term (outcome
      // `expired` when the new date is already past, else `renewed`). A typo
      // fix that stays in the same state changes nothing here.
      let resetWarning = false;
      if (merged.validUntil !== current.validUntil) {
        const implied = warningState(merged.validUntil, licenceToday());
        if (implied !== warnedStateOf(current)) {
          resetWarning = true;
          if (current.openWarningId !== null) {
            // An edit into the past is not a renewal (the sweep then opens the expired entry).
            await this.clearWarning(tx, command.tenantId, current, implied === 'expired' ? 'expired' : 'renewed');
          }
        }
      }

      let updated: LicenceRow;
      try {
        const rows = await tx
          .update(licences)
          .set({
            number: merged.number,
            validFrom: merged.validFrom,
            validUntil: merged.validUntil,
            note: merged.note,
            ...(resetWarning ? { upcomingWarnedOn: null, expiredWarnedOn: null, openWarningId: null } : {}),
            updatedAt: nowIso(),
          })
          .where(and(eq(licences.tenantId, command.tenantId), eq(licences.id, current.id)))
          .returning();
        updated = rows[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, LICENCE_FAMILY_NUMBER_UNIQUE)) throw licenceNumberTaken(merged.number);
        throw err;
      }
      const snapshot: LicenceMutationSnapshot = { licence: toLicenceSnapshot(updated) };
      await this.audit(tx, command.tenantId, command.actorUserId, 'licence.edited', updated.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  async withdraw(command: WithdrawLicenceCommand, idempotencyKey: string): Promise<LicenceMutationSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'licence-withdraw',
      tenantId: command.tenantId,
      licenceId: command.licenceId,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'licences.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const current = await this.lockLicence(tx, command.tenantId, command.licenceId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (current.status === 'withdrawn') throw licenceWithdrawn();

      if (current.openWarningId !== null) {
        await this.clearWarning(tx, command.tenantId, current, 'withdrawn');
      }
      const rows = await tx
        .update(licences)
        .set({ status: 'withdrawn', openWarningId: null, updatedAt: nowIso() })
        .where(and(eq(licences.tenantId, command.tenantId), eq(licences.id, current.id), eq(licences.status, 'active')))
        .returning();
      const updated = rows[0];
      if (updated === undefined) throw licenceWithdrawn(); // backstop — the row lock makes it unreachable
      const snapshot: LicenceMutationSnapshot = { licence: toLicenceSnapshot(updated) };
      await this.audit(tx, command.tenantId, command.actorUserId, 'licence.withdrawn', updated.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /** The open warning's resolve event (the sweep emits the same on an expired raise). */
  private async clearWarning(tx: TenantTx, tenantId: string, row: LicenceRow, outcome: LicenceWarningOutcome): Promise<void> {
    await appendWarningCleared(this.outbox, tx, tenantId, row, outcome);
  }

  /** The licence row `FOR UPDATE`, 404 when absent — a lock helper never checks status (§1). */
  private async lockLicence(tx: TenantTx, tenantId: string, licenceId: string): Promise<LicenceRow> {
    const rows = await tx
      .select()
      .from(licences)
      .where(and(eq(licences.tenantId, tenantId), eq(licences.id, licenceId)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (row === undefined) throw licenceNotFound(licenceId);
    return row;
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<LicenceMutationSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot as LicenceMutationSnapshot;
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    actorUserId: string,
    action: 'licence.added' | 'licence.edited' | 'licence.withdrawn',
    licenceId: string,
    reference: string,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId,
      action,
      targetType: 'licence',
      targetId: licenceId,
      reference,
      occurredAt: nowIso(),
    });
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: LicenceMutationSnapshot,
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

/**
 * `licence.expiry_warning_cleared` for the row's open warning — the edit's
 * `renewed`, the withdraw's `withdrawn`, the sweep's `expired` (before the
 * expired raise). The caller clears `open_warning_id` in its own update.
 */
export async function appendWarningCleared(
  outbox: OutboxSink,
  tx: TenantTx,
  tenantId: string,
  row: Pick<LicenceRow, 'id' | 'warehouseId' | 'openWarningId'>,
  outcome: LicenceWarningOutcome,
): Promise<void> {
  if (row.openWarningId === null) return;
  await outbox.append(tx, {
    messageId: uuidv7(),
    tenantId,
    type: LICENCE_WARNING_CLEARED_EVENT,
    occurredAt: nowIso(),
    payload: {
      warningId: row.openWarningId,
      licenceId: row.id,
      warehouseId: row.warehouseId,
      outcome,
    },
  });
}
