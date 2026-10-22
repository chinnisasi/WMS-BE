import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { windDownBlockerInTx, type WindDownBlocker } from '../../shared/primitives/wind-down';

/**
 * Story 1-2a — the inventory-owned wind-down blockers of one client (the
 * departure check, composed by `ClientsCommand.updateStatus`). A file-level
 * read on the caller's transaction that imports nothing from
 * `modules/clients` (pinned by `test/architecture.spec.ts`), so the clients
 * module can compose it without an import cycle.
 *
 * - `stock` — the aggregate stock read: the client's SKUs with a non-zero
 *   balance in ANY bin of any warehouse — the Receiving, QC-HOLD,
 *   IN-TRANSIT, RETURNS and DAMAGED system bins included (they are bins); `count` is
 *   the number of those SKUs, `codes` the first five SKU codes.
 * - `pending-adjustments` — stock adjustments awaiting a decision
 *   (`ADJUSTMENT_PENDING_OPEN_STATUSES`).
 * - `open-counts` — count tasks not completed that count one of its SKUs,
 *   plus count variances not resolved on one of its SKUs.
 */
export const ADJUSTMENT_PENDING_OPEN_STATUSES = ['pending'] as const;
export const COUNT_TASK_OPEN_STATUSES = ['pending'] as const;
export const COUNT_VARIANCE_OPEN_STATUSES = ['open'] as const;

export async function clientWindDownBlockersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<WindDownBlocker[]> {
  const stock = await windDownBlockerInTx(
    tx,
    'stock',
    sql`select count(*)::bigint as n, (array_agg(code order by code))[1:5] as codes
        from (
          select distinct s.id, s.code
          from stock_on_hand soh
          join skus s on s.tenant_id = soh.tenant_id and s.id = soh.sku_id
          where soh.tenant_id = ${tenantId} and s.client_id = ${clientId} and soh.quantity <> 0
        ) held`,
    true,
  );
  const adjustments = await windDownBlockerInTx(
    tx,
    'pending-adjustments',
    sql`select count(*)::bigint as n
        from stock_adjustment_pendings p
        join skus s on s.tenant_id = p.tenant_id and s.id = p.sku_id
        where p.tenant_id = ${tenantId} and s.client_id = ${clientId}
          and p.status in ${[...ADJUSTMENT_PENDING_OPEN_STATUSES]}`,
    false,
  );
  const counts = await windDownBlockerInTx(
    tx,
    'open-counts',
    sql`select count(*)::bigint as n
        from (
          select t.id
          from count_tasks t
          where t.tenant_id = ${tenantId} and t.status in ${[...COUNT_TASK_OPEN_STATUSES]}
            and exists (
              select 1 from count_task_lines l
              join skus s on s.tenant_id = l.tenant_id and s.id = l.sku_id
              where l.tenant_id = t.tenant_id and l.task_id = t.id and s.client_id = ${clientId}
            )
          union all
          select v.id
          from count_variances v
          join skus s on s.tenant_id = v.tenant_id and s.id = v.sku_id
          where v.tenant_id = ${tenantId} and s.client_id = ${clientId}
            and v.status in ${[...COUNT_VARIANCE_OPEN_STATUSES]}
        ) open_counts`,
    false,
  );
  return [...stock, ...adjustments, ...counts];
}
