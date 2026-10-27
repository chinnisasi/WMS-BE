import { and, asc, eq, inArray } from 'drizzle-orm';
import { batchRecallLines, batchRecalls } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';

/**
 * Story 3-7a (A1) — the ONE cross-module read of recall lines: which of these
 * batches sit on an OPEN LIVE recall, and which one. A free-function seam over
 * the caller's transaction (IMPLEMENTATION-GUIDE §7h, the 1-6d pattern): it
 * imports only `drizzle-orm` and `shared/`, so outbound (pick, dispatch),
 * catalog (unblock, the lifecycle view) and inbound (receive) import THIS
 * file — never the recalls module, which depends on all three (a Nest import
 * back would cycle). Pinned by `test/architecture.spec.ts`.
 *
 * A MOCK recall is never returned: a drill has no stock-side or order-side
 * effect (A16). A batch is on at most one open live recall (the open and
 * add-batches guards refuse a second), so the answer has at most one row per
 * batch; ordered by batch id for a stable refusal text.
 */
export interface OpenRecallLine {
  readonly batchId: string;
  readonly recallId: string;
  readonly recallCode: string;
}

export async function openLiveRecallLinesForBatchesInTx(
  tx: TenantTx,
  tenantId: string,
  batchIds: readonly string[],
): Promise<OpenRecallLine[]> {
  const ids = [...new Set(batchIds)];
  if (ids.length === 0) return [];
  return tx
    .select({ batchId: batchRecallLines.batchId, recallId: batchRecalls.id, recallCode: batchRecalls.code })
    .from(batchRecallLines)
    .innerJoin(batchRecalls, and(eq(batchRecalls.tenantId, batchRecallLines.tenantId), eq(batchRecalls.id, batchRecallLines.recallId)))
    .where(
      and(
        eq(batchRecallLines.tenantId, tenantId),
        inArray(batchRecallLines.batchId, ids),
        eq(batchRecalls.status, 'open'),
        eq(batchRecalls.mode, 'live'),
      ),
    )
    .orderBy(asc(batchRecallLines.batchId), asc(batchRecalls.code));
}
