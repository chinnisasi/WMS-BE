import { and, eq, sql } from 'drizzle-orm';
import { batchRecalls } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { windDownBlocker, type WindDownBlocker } from '../../shared/primitives/wind-down';

/**
 * Story 3-7a (A16) — the recalls-owned wind-down blocker of one client: its
 * OPEN LIVE recalls. A client cannot depart while a recall of its goods is
 * still running (its lots are blocked and its brand is owed a close). A mock
 * recall (a drill) never blocks. Named by recall code (up to five). A
 * file-level read that imports nothing from `modules/clients` (pinned by
 * `test/architecture.spec.ts`). Departure keeps every recall row: recall
 * evidence is never purged.
 */
export async function clientWindDownBlockersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<WindDownBlocker[]> {
  const rows = await tx
    .select({
      n: sql<string>`count(*)::bigint`,
      codes: sql<string[] | null>`(array_agg(${batchRecalls.code} order by ${batchRecalls.code}))[1:5]`,
    })
    .from(batchRecalls)
    .where(
      and(
        eq(batchRecalls.tenantId, tenantId),
        eq(batchRecalls.clientId, clientId),
        eq(batchRecalls.status, 'open'),
        eq(batchRecalls.mode, 'live'),
      ),
    );
  return windDownBlocker('open-recalls', rows[0]?.n ?? 0, rows[0]?.codes ?? []);
}
