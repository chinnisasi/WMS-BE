import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { windDownBlockerInTx, type WindDownBlocker } from '../../shared/primitives/wind-down';

/**
 * Story 1-2a — the outbound-owned wind-down blocker of one client: orders
 * still `accepted` or `ready_to_dispatch` (holding reservations or awaiting
 * dispatch). `codes` names each by the order label (story 4-1b — the one
 * rule everywhere an order is named): its client order number, else its
 * channel reference, else its id's last eight characters. A file-level read that
 * imports nothing from `modules/clients` (pinned by
 * `test/architecture.spec.ts`); the status list is pinned against
 * `ORDER_STATUSES` by `test/client-master.spec.ts`.
 */
export const ORDER_OPEN_STATUSES = ['accepted', 'ready_to_dispatch'] as const;

export async function clientWindDownBlockersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<WindDownBlocker[]> {
  return windDownBlockerInTx(
    tx,
    'open-orders',
    sql`select count(*)::bigint as n, (array_agg(label order by label))[1:5] as codes
        from (
          select coalesce(client_order_ref, external_event_id, right(id::text, 8)) as label
          from orders
          where tenant_id = ${tenantId} and client_id = ${clientId} and status in ${[...ORDER_OPEN_STATUSES]}
        ) open_orders`,
    true,
  );
}
