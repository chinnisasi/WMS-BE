import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, BATCH_BLOCK_REASONS, batches, idempotencyKeys, type BatchBlockReason } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { batchExpiryClock, isBatchExpiredAt } from '../../shared/primitives/batch-expiry';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn, memberDisplayNamesInTx, userEmailsInTx } from '../tenancy/tenancy.service';

/** Story 3-3a (decision 4) — the reason vocabulary lives beside the table (`schema.ts`). */
export { BATCH_BLOCK_REASONS, type BatchBlockReason };

/** The block / unblock note's ceiling, in characters (code points). */
export const BATCH_BLOCK_NOTE_MAX = 500;

export interface BlockBatchCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly batchId: string;
  readonly reason: BatchBlockReason;
  readonly note?: string | null | undefined;
}

export interface UnblockBatchCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly batchId: string;
  readonly note?: string | null | undefined;
}

/**
 * A batch's identity plus its lifecycle facts, as the block verbs answer it
 * and the batch reads carry it (story 3-3a, A9). `expired` is judged by the
 * SERVER's one predicate (`isBatchExpiredAt` at `batchExpiryClock.now()`), so
 * a client never re-derives it.
 */
export interface BatchLifecycleView {
  readonly id: string;
  readonly skuId: string;
  readonly code: string;
  readonly mfgDate: string | null;
  readonly expiryDate: string | null;
  readonly status: 'active' | 'blocked';
  readonly blockedReason: BatchBlockReason | null;
  /** The block's note (trimmed), null when none was given or the batch is not blocked. */
  readonly blockedNote: string | null;
  readonly blockedAt: string | null;
  readonly blockedBy: string | null;
  /** The blocker's display name (the member's email local part — `memberDisplayNamesInTx`), null when not blocked or the blocker is no longer a member. */
  readonly blockedByName: string | null;
  readonly expired: boolean;
}

/** The block / unblock answer — the stored idempotency snapshot. */
export interface BatchBlockSnapshot {
  readonly batch: BatchLifecycleView;
}

type BatchRow = typeof batches.$inferSelect;

/** ISO-8601 UTC — the read contract (Postgres's own text shape never reaches the wire). */
function canonical(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** The lifecycle view of batch rows, names resolved in ONE read on the caller's transaction. */
export async function batchLifecycleViewsInTx(
  tx: TenantTx,
  tenantId: string,
  rows: readonly Pick<BatchRow, 'id' | 'skuId' | 'code' | 'mfgDate' | 'expiryDate' | 'status' | 'blockedReason' | 'blockedAt' | 'blockedBy' | 'blockedNote'>[],
): Promise<BatchLifecycleView[]> {
  const blockers = rows.map((row) => row.blockedBy).filter((id): id is string => id !== null);
  // A blocker who is no longer a member of the tenant (no user row) reads
  // null — never the `user-<tail>` placeholder (code review).
  const members = blockers.length === 0 ? new Map<string, string>() : await userEmailsInTx(tx, tenantId, blockers);
  const names = members.size === 0 ? new Map<string, string>() : await memberDisplayNamesInTx(tx, tenantId, [...members.keys()]);
  const at = batchExpiryClock.now();
  return rows.map((row) => ({
    id: row.id,
    skuId: row.skuId,
    code: row.code,
    mfgDate: canonical(row.mfgDate),
    expiryDate: canonical(row.expiryDate),
    // The `batches_status_check` / `batches_blocked_pairing` CHECKs hold these vocabularies.
    status: row.status as BatchLifecycleView['status'],
    blockedReason: row.blockedReason as BatchBlockReason | null,
    blockedNote: row.blockedNote,
    blockedAt: canonical(row.blockedAt),
    blockedBy: row.blockedBy,
    blockedByName: row.blockedBy === null ? null : (names.get(row.blockedBy) ?? null),
    expired: isBatchExpiredAt(row.expiryDate, at),
  }));
}

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid batch block', detail);
}

function batchNotFound(batchId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Batch not found', `No batch with id "${batchId}" exists in this tenant.`);
}

/** Trimmed; blank after trimming is absent (null). */
function normaliseNote(note: string | null | undefined): string | null {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Story 3-3a — block / unblock a batch (a lot), with a reason, who and when.
 *
 * A block is LOT-WIDE (A10): a batch is unique per (tenant, SKU, code), so it
 * covers every warehouse — the shape a recall or a failed QC of a lot takes. A
 * single-site hold is a QC hold, or (3-3b) a bin block. A block never moves
 * stock: the units stay on hand, and the inventory core stops PROMISING them
 * (`unpromisableBatchUnits` — ATP, the grant ceiling, and through them order
 * create, channel publish and replenishment) while the draw side (wave,
 * re-plan, pick, the adjustment's FEFO default) already never draws them.
 * Reservations granted before the block stand (decision 8): ATP clamps at 0
 * and those lines short at the wave.
 *
 * The skeleton (guide §1; decision 6 + A11): `qc.manage` → the shape checks
 * (vocabulary, `other` needs a note, the note's bounds — none reads a row) →
 * replay → the batch row `FOR UPDATE` in the tenant (404) → replay again
 * UNDER the lock (the same-key race) → the state check (409
 * `batch-already-blocked` / `batch-not-blocked`) → the conditional update →
 * outbox `batch.blocked` / `batch.unblocked` → audit (with `changes`, so the
 * history survives the unblock clearing the row) → the idempotency key LAST.
 * The fingerprint is `{command, tenantId, batchId, reason, note}` with the
 * note normalised (trimmed, blank = absent).
 */
@Injectable()
export class BatchBlockCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async block(command: BlockBatchCommand, idempotencyKey: string): Promise<BatchBlockSnapshot> {
    const note = normaliseNote(command.note);
    const payloadHash = hashCommandPayload({
      command: 'batch.block',
      tenantId: command.tenantId,
      batchId: command.batchId,
      reason: command.reason,
      note,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'qc.manage');
      if (!(BATCH_BLOCK_REASONS as readonly string[]).includes(command.reason)) {
        throw invalid(`reason must be one of ${JSON.stringify(BATCH_BLOCK_REASONS)} (got ${JSON.stringify(command.reason)}).`);
      }
      if (command.reason === 'other' && note === null) {
        throw invalid('A block for reason "other" must say why — supply a note.');
      }
      if (note !== null && [...note].length > BATCH_BLOCK_NOTE_MAX) {
        throw invalid(`note is at most ${BATCH_BLOCK_NOTE_MAX} characters.`);
      }
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      const locked = await this.lockBatch(tx, command.tenantId, command.batchId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (locked.status === 'blocked') {
        throw new ProblemException(
          'batch-already-blocked',
          409,
          'Batch already blocked',
          `Batch "${locked.code}" is already blocked (${locked.blockedReason ?? 'no reason'}) — unblock it first to change the reason.`,
        );
      }

      const blockedAt = nowIso();
      const updated = await tx
        .update(batches)
        .set({
          status: 'blocked',
          blockedReason: command.reason,
          blockedAt,
          blockedBy: command.actorUserId,
          blockedNote: note,
          updatedAt: blockedAt,
        })
        .where(and(eq(batches.tenantId, command.tenantId), eq(batches.id, locked.id), eq(batches.status, 'active')))
        .returning();
      const row = updated[0]!;
      const snapshot: BatchBlockSnapshot = { batch: (await batchLifecycleViewsInTx(tx, command.tenantId, [row]))[0]! };

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'batch.blocked',
        occurredAt: blockedAt,
        payload: { batchId: row.id, skuId: row.skuId, code: row.code, reason: command.reason, note },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'batch.blocked',
        targetType: 'batch',
        targetId: row.id,
        reference: idempotencyKey,
        changes: {
          status: { before: locked.status, after: 'blocked' },
          reason: { before: null, after: command.reason },
          note: { before: null, after: note },
        },
        occurredAt: nowIso(),
      });
      await this.storeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  async unblock(command: UnblockBatchCommand, idempotencyKey: string): Promise<BatchBlockSnapshot> {
    const note = normaliseNote(command.note);
    const payloadHash = hashCommandPayload({
      command: 'batch.unblock',
      tenantId: command.tenantId,
      batchId: command.batchId,
      note,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'qc.manage');
      // A8 — lifting a recall is the riskier direction: it always says why.
      if (note === null) {
        throw invalid('Unblocking a batch must say why — supply a note (1–500 characters).');
      }
      if ([...note].length > BATCH_BLOCK_NOTE_MAX) {
        throw invalid(`note is at most ${BATCH_BLOCK_NOTE_MAX} characters.`);
      }
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      const locked = await this.lockBatch(tx, command.tenantId, command.batchId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (locked.status !== 'blocked') {
        throw new ProblemException(
          'batch-not-blocked',
          409,
          'Batch not blocked',
          `Batch "${locked.code}" is not blocked (status "${locked.status}") — there is nothing to unblock.`,
        );
      }

      const at = nowIso();
      const updated = await tx
        .update(batches)
        .set({ status: 'active', blockedReason: null, blockedAt: null, blockedBy: null, blockedNote: null, updatedAt: at })
        .where(and(eq(batches.tenantId, command.tenantId), eq(batches.id, locked.id), eq(batches.status, 'blocked')))
        .returning();
      const row = updated[0]!;
      // An unblocked batch that is past its expiry stays unpromisable — the
      // view's `expired` says so (A8).
      const snapshot: BatchBlockSnapshot = { batch: (await batchLifecycleViewsInTx(tx, command.tenantId, [row]))[0]! };

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'batch.unblocked',
        occurredAt: at,
        payload: { batchId: row.id, skuId: row.skuId, code: row.code, reason: locked.blockedReason, note },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'batch.unblocked',
        targetType: 'batch',
        targetId: row.id,
        reference: idempotencyKey,
        changes: {
          status: { before: 'blocked', after: 'active' },
          reason: { before: locked.blockedReason, after: null },
          // `before` is the block's own note (cleared from the row now);
          // `after` is why the block was lifted.
          note: { before: locked.blockedNote, after: note },
          blockedAt: { before: canonical(locked.blockedAt), after: null },
          blockedBy: { before: locked.blockedBy, after: null },
        },
        occurredAt: nowIso(),
      });
      await this.storeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /** Lock the batch row in the tenant, 404 when absent — nothing else (guide §1, the `loadOpenPo` lesson). */
  private async lockBatch(tx: TenantTx, tenantId: string, batchId: string): Promise<BatchRow> {
    if (!UUID_RE.test(batchId)) throw batchNotFound(batchId);
    const rows = await tx
      .select()
      .from(batches)
      .where(and(eq(batches.tenantId, tenantId), eq(batches.id, batchId)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (row === undefined) throw batchNotFound(batchId);
    return row;
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<BatchBlockSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    if (existing[0] === undefined) return null;
    if (existing[0].payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return existing[0].responseSnapshot as BatchBlockSnapshot;
  }

  private async storeKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: BatchBlockSnapshot,
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key: idempotencyKey, payloadHash, responseSnapshot: snapshot });
    } catch (err) {
      if (isUniqueViolationOn(err, 'idempotency_keys_tenant_id_key_unique')) {
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
