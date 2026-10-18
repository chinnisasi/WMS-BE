import { and, eq, inArray, sql } from 'drizzle-orm';
import { returnAuthorizations } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { windDownBlocker, type WindDownBlocker } from '../../shared/primitives/wind-down';

/**
 * Story 1-2a — the returns-owned wind-down blocker of one client: return
 * authorizations still receivable (`open` or `partially_received` — the
 * receipt command's `RECEIVABLE_RMA_STATUSES`, pinned equal by
 * `test/client-master.spec.ts`). A file-level read that imports nothing from
 * `modules/clients` (pinned by `test/architecture.spec.ts`), and no sibling
 * table (the returns module's own rule).
 */
export const RMA_OPEN_STATUSES = ['open', 'partially_received'] as const;

export async function clientWindDownBlockersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<WindDownBlocker[]> {
  const rows = await tx
    .select({
      n: sql<string>`count(*)::bigint`,
      codes: sql<string[] | null>`(array_agg(${returnAuthorizations.code} order by ${returnAuthorizations.code}))[1:5]`,
    })
    .from(returnAuthorizations)
    .where(
      and(
        eq(returnAuthorizations.tenantId, tenantId),
        eq(returnAuthorizations.clientId, clientId),
        inArray(returnAuthorizations.status, [...RMA_OPEN_STATUSES]),
      ),
    );
  return windDownBlocker('open-rmas', rows[0]?.n ?? 0, rows[0]?.codes ?? []);
}
