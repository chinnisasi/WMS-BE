import { and, eq } from 'drizzle-orm';
import { auditEvents, batches, type BatchBlockReason } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';

/**
 * Story 3-7a (A1) — the block / unblock WRITE of one locked batch, extracted
 * from 3-3a's `BatchBlockCommand` so a recall blocks (on open) and releases
 * (on close) through the very same statements: the conditional status flip,
 * the `batch.blocked` / `batch.unblocked` outbox event and the audit row with
 * its before/after `changes`. 3-3a's bytes are unchanged (its suite is the
 * golden): the command calls these with no `extraChanges`.
 *
 * Neither helper locks, replays or judges state: the caller has locked the
 * row `FOR UPDATE` and run its own guards. In particular the recall rule
 * `batch-under-recall` lives ONLY in `BatchBlockCommand.unblock` — never
 * here — so a recall's close can still release its own lots (A4).
 */

type BatchRow = typeof batches.$inferSelect;

/** ISO-8601 UTC — Postgres's own text shape never reaches the audit trail. */
function canonical(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export interface ApplyBatchBlockInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  /** The batch row, locked `FOR UPDATE` by the caller and judged `active`. */
  readonly locked: BatchRow;
  readonly reason: BatchBlockReason;
  /** Trimmed; null when absent. */
  readonly note: string | null;
  /** The audit row's `reference` — the caller's idempotency key. */
  readonly reference: string;
  /** Extra audit `changes` keys (a recall names itself); absent for 3-3a. */
  readonly extraChanges?: Readonly<Record<string, unknown>>;
}

/** Block one active batch: flip, outbox `batch.blocked`, audit `batch.blocked`. Answers the updated row. */
export async function applyBatchBlockInTx(tx: TenantTx, outbox: OutboxSink, input: ApplyBatchBlockInput): Promise<BatchRow> {
  const blockedAt = nowIso();
  const updated = await tx
    .update(batches)
    .set({
      status: 'blocked',
      blockedReason: input.reason,
      blockedAt,
      blockedBy: input.actorUserId,
      blockedNote: input.note,
      updatedAt: blockedAt,
    })
    .where(and(eq(batches.tenantId, input.tenantId), eq(batches.id, input.locked.id), eq(batches.status, 'active')))
    .returning();
  const row = updated[0];
  if (row === undefined) {
    // Unreachable beneath the caller's row lock and its `active` guard; kept
    // as the backstop that rolls the whole transaction back.
    throw new Error(`batch ${input.locked.id} was not active under its lock`);
  }
  await outbox.append(tx, {
    messageId: uuidv7(),
    tenantId: input.tenantId,
    type: 'batch.blocked',
    occurredAt: blockedAt,
    payload: { batchId: row.id, skuId: row.skuId, code: row.code, reason: input.reason, note: input.note },
  });
  await tx.insert(auditEvents).values({
    id: uuidv7(),
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: 'batch.blocked',
    targetType: 'batch',
    targetId: row.id,
    reference: input.reference,
    changes: {
      status: { before: input.locked.status, after: 'blocked' },
      reason: { before: null, after: input.reason },
      note: { before: null, after: input.note },
      ...(input.extraChanges ?? {}),
    },
    occurredAt: nowIso(),
  });
  return row;
}

export interface ApplyBatchUnblockInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  /** The batch row, locked `FOR UPDATE` by the caller and judged `blocked`. */
  readonly locked: BatchRow;
  /** Why the block was lifted — trimmed, required by every caller. */
  readonly note: string;
  readonly reference: string;
  readonly extraChanges?: Readonly<Record<string, unknown>>;
}

/** Unblock one blocked batch: clear the four facts, outbox `batch.unblocked`, audit `batch.unblocked`. */
export async function applyBatchUnblockInTx(tx: TenantTx, outbox: OutboxSink, input: ApplyBatchUnblockInput): Promise<BatchRow> {
  const at = nowIso();
  const updated = await tx
    .update(batches)
    .set({ status: 'active', blockedReason: null, blockedAt: null, blockedBy: null, blockedNote: null, updatedAt: at })
    .where(and(eq(batches.tenantId, input.tenantId), eq(batches.id, input.locked.id), eq(batches.status, 'blocked')))
    .returning();
  const row = updated[0];
  if (row === undefined) {
    throw new Error(`batch ${input.locked.id} was not blocked under its lock`);
  }
  await outbox.append(tx, {
    messageId: uuidv7(),
    tenantId: input.tenantId,
    type: 'batch.unblocked',
    occurredAt: at,
    payload: { batchId: row.id, skuId: row.skuId, code: row.code, reason: input.locked.blockedReason, note: input.note },
  });
  await tx.insert(auditEvents).values({
    id: uuidv7(),
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: 'batch.unblocked',
    targetType: 'batch',
    targetId: row.id,
    reference: input.reference,
    changes: {
      status: { before: 'blocked', after: 'active' },
      reason: { before: input.locked.blockedReason, after: null },
      // `before` is the block's own note (cleared from the row now);
      // `after` is why the block was lifted.
      note: { before: input.locked.blockedNote, after: input.note },
      blockedAt: { before: canonical(input.locked.blockedAt), after: null },
      blockedBy: { before: input.locked.blockedBy, after: null },
      ...(input.extraChanges ?? {}),
    },
    occurredAt: nowIso(),
  });
  return row;
}
