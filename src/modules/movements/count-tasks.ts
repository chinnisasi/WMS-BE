import { and, asc, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
import { auditEvents, countTaskLines, countTasks, countVariances } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import type { InventoryFacade } from '../inventory/inventory.facade';

/**
 * Story 3-5b (design review A4) — the recount mint, a free function over the
 * caller's transaction so both `CountService` (the submit's epoch-conflict
 * recount, the resolve's recount arm, the review queue's recount) and
 * `StockTakeCommand` (a supervisor's requested recount) mint through ONE
 * core. It was `CountService.createRecountTaskInTx` (private) before 3-5b.
 *
 * The task's expectations are the bin's CURRENT on-hand and its epoch the
 * LIVE one — both read under the locks the caller holds (bin row →
 * warehouse advisory, the canonical order). `createdBy` is null (the system
 * re-planned). The caller enforces the open-task-per-bin rule.
 *
 * The stock-take stamp is the FREEZE's truth, never the source task's: a
 * task minted for a frozen bin carries that take's id and `bulk: true` (so
 * its `count.created` is never pushed — `push.enqueue.ts` skips `bulk`); a
 * task for a bin no take freezes carries neither, whatever its source task
 * counted for (a closed take's variance resolved later re-counts as a cycle
 * count).
 */
export interface RecountTaskInput {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly binId: string;
  /** The completed task this recount supersedes (null for the review queue's recount). */
  readonly supersededTaskId: string | null;
  readonly occurredAt: string;
  /** Stamped `created_at` (the submit's conflict recount uses its source's `completed_at`). */
  readonly createdAt?: string | undefined;
}

export async function createRecountTaskInTx(
  tx: TenantTx,
  inventory: InventoryFacade,
  outbox: OutboxSink,
  input: RecountTaskInput,
): Promise<{ taskId: string; stockTakeId: string | null }> {
  const frozen = (await inventory.frozenBinsInTx(tx, input.tenantId, input.warehouseId, [input.binId])).get(input.binId);
  const stockTakeId = frozen?.stockTakeId ?? null;
  const expected = await inventory.onHandInBinInTx(tx, input.tenantId, input.warehouseId, input.binId);
  const epochs = await inventory.binStateEpochsInTx(tx, input.tenantId, input.warehouseId, [input.binId]);
  const epoch = epochs.get(input.binId) ?? null;

  const taskId = uuidv7();
  await tx.insert(countTasks).values({
    id: taskId,
    tenantId: input.tenantId,
    warehouseId: input.warehouseId,
    binId: input.binId,
    status: 'pending',
    origin: 'recount',
    binStateEpoch: epoch,
    createdBy: null,
    stockTakeId,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  });
  const lineValues = expected
    .filter((arm) => arm.quantity !== 0)
    .map((arm) => ({
      id: uuidv7(),
      tenantId: input.tenantId,
      taskId,
      skuId: arm.skuId,
      expectedQuantity: arm.quantity,
    }));
  if (lineValues.length > 0) {
    await tx.insert(countTaskLines).values(lineValues);
  }

  await outbox.append(tx, {
    messageId: uuidv7(),
    tenantId: input.tenantId,
    type: 'count.created',
    occurredAt: input.occurredAt,
    payload: {
      taskId,
      binId: input.binId,
      warehouseId: input.warehouseId,
      origin: 'recount',
      ...(input.supersededTaskId === null ? {} : { supersededTaskId: input.supersededTaskId }),
      // Story 3-5b (A4) — a take's recount is never pushed.
      ...(stockTakeId === null ? {} : { stockTakeId, bulk: true }),
    },
  });
  return { taskId, stockTakeId };
}

/**
 * Story 3-5b (decision 6, A5, A6) — supersede open variances by a recount:
 * each named variance still `open` becomes `recounted` against its recount
 * task, its basis rewritten to that task's line expectation (0 when the line
 * is absent — the resolve's recount arm, `count.command.ts`), the delta
 * recomputed in the same UPDATE. Each emits the FULL `count.variance.resolved`
 * (the 9-2 owner panel resolves a row its submit raised) and writes one audit
 * row `count.variance.resolved` under the caller's key. The caller holds the
 * locks (the variance rows, then the bins, then the warehouse advisory) and
 * writes its own idempotency key. A variance no longer open is skipped.
 */
export async function supersedeVariancesInTx(
  tx: TenantTx,
  outbox: OutboxSink,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly at: string;
    readonly entries: readonly { readonly varianceId: string; readonly recountTaskId: string }[];
  },
): Promise<number> {
  if (input.entries.length === 0) return 0;
  const recountByVariance = new Map(input.entries.map((entry) => [entry.varianceId, entry.recountTaskId]));
  const rows = await tx
    .select()
    .from(countVariances)
    .where(
      and(
        eq(countVariances.tenantId, input.tenantId),
        inArray(countVariances.id, [...recountByVariance.keys()]),
        eq(countVariances.status, 'open'),
      ),
    )
    .orderBy(asc(countVariances.id));
  if (rows.length === 0) return 0;
  const recountIds = [...new Set(rows.map((row) => recountByVariance.get(row.id)!))];
  const lineRows = await tx
    .select({ taskId: countTaskLines.taskId, skuId: countTaskLines.skuId, expected: countTaskLines.expectedQuantity })
    .from(countTaskLines)
    .where(and(eq(countTaskLines.tenantId, input.tenantId), inArray(countTaskLines.taskId, recountIds)));
  const expectedOf = new Map(lineRows.map((line) => [`${line.taskId}:${line.skuId}`, line.expected]));
  let superseded = 0;
  const auditValues: (typeof auditEvents.$inferInsert)[] = [];
  for (const row of rows) {
    const recountTaskId = recountByVariance.get(row.id)!;
    const finalExpected = expectedOf.get(`${recountTaskId}:${row.skuId}`) ?? 0;
    const finalDelta = row.countedQuantity - finalExpected;
    const updated = await tx
      .update(countVariances)
      .set({
        status: 'recounted',
        expectedQuantity: finalExpected,
        deltaMilli: finalDelta,
        resolvedBy: input.actorUserId,
        resolvedAt: input.at,
        recountTaskId,
        consideredEventSeqs: null,
        updatedAt: input.at,
      })
      .where(
        and(eq(countVariances.tenantId, input.tenantId), eq(countVariances.id, row.id), eq(countVariances.status, 'open')),
      )
      .returning({ id: countVariances.id });
    if (updated[0] === undefined) continue;
    superseded += 1;
    await outbox.append(tx, {
      messageId: uuidv7(),
      tenantId: input.tenantId,
      type: 'count.variance.resolved',
      occurredAt: input.at,
      payload: {
        varianceId: row.id,
        taskId: row.taskId,
        warehouseId: row.warehouseId,
        binId: row.binId,
        skuId: row.skuId,
        decision: 'recount',
        status: 'recounted',
        expectedQuantity: fromMilli(finalExpected),
        countedQuantity: fromMilli(row.countedQuantity),
        delta: fromMilli(finalDelta),
        thresholdQuantity: row.thresholdQuantityMilli === null ? null : fromMilli(row.thresholdQuantityMilli),
        // The submit-time predicate over the frozen stamp and the row's
        // submit-time delta (read before the rewrite) — 9-2's contract.
        overThreshold:
          row.thresholdQuantityMilli !== null && Math.abs(row.deltaMilli) > row.thresholdQuantityMilli,
        consideredEventSeqs: null,
        resolvedBy: input.actorUserId,
        resolvedAt: input.at,
        recountTaskId,
      },
    });
    auditValues.push({
      id: uuidv7(),
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'count.variance.resolved',
      targetType: 'count_variance',
      targetId: row.id,
      reference: input.idempotencyKey,
      occurredAt: input.at,
    });
  }
  if (auditValues.length > 0) {
    await tx.insert(auditEvents).values(auditValues);
  }
  return superseded;
}
