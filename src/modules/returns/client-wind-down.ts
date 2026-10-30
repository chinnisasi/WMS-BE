import { and, eq, inArray, sql } from 'drizzle-orm';
import { clientReturns, returnAuthorizations } from '../../shared/db/schema';
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

/**
 * Story 4-7c (decision 8) — returns to client still `draft` or `picked`: the
 * units are claimed for a shipment back to the brand that a departure would
 * orphan (`codes` = the RTC codes). Pinned against `CLIENT_RETURN_STATUSES`
 * by test/client-master.spec.ts.
 */
export const CLIENT_RETURN_OPEN_STATUSES = ['draft', 'picked'] as const;

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
  const rtcs = await tx
    .select({
      n: sql<string>`count(*)::bigint`,
      codes: sql<string[] | null>`(array_agg(${clientReturns.code} order by ${clientReturns.code}))[1:5]`,
    })
    .from(clientReturns)
    .where(
      and(
        eq(clientReturns.tenantId, tenantId),
        eq(clientReturns.clientId, clientId),
        inArray(clientReturns.status, [...CLIENT_RETURN_OPEN_STATUSES]),
      ),
    );
  return [
    ...windDownBlocker('open-rmas', rows[0]?.n ?? 0, rows[0]?.codes ?? []),
    ...windDownBlocker('open-client-returns', rtcs[0]?.n ?? 0, rtcs[0]?.codes ?? []),
  ];
}
