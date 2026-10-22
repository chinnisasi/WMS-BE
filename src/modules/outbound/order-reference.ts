import { sql, type SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';

/**
 * Story 4-1b — the `reference` search's one predicate, shared by the staff
 * order list (`OutboundFacade.listOrders`) and the portal's (`portal-orders.ts`):
 * the order whose CLIENT ORDER NUMBER is `reference` (any status — the
 * non-unique `orders_client_order_ref_idx`, so a cancelled order is found by
 * its number too; code review BH5), OR whose CHANNEL REFERENCE
 * (`external_event_id`, any status — `orders_external_event_client_idx`) is.
 * Exact and case-sensitive (decision 2). Several orders can match one number
 * (a cancelled one and the live one that re-used it).
 *
 * Shaped `id = any(array(a union all b))` — the IMPLEMENTATION-GUIDE §7b
 * rule: an `OR` across the two columns inside the list's keyset walk would
 * defeat both partial indexes and scan the warehouse; each arm here is its
 * own index probe (pinned by an `EXPLAIN` in test/order-client-ref.spec.ts).
 * The two arms are disjoint in practice (an ingested order carries no client
 * order number); a duplicate id would be harmless under `= any`.
 *
 * `clientId` (the portal) adds the explicit client predicate inside each arm
 * — the second layer beside the caller's own `client_id` predicate and the
 * transaction's client stamp. The staff list's client filter is the caller's.
 */
export function orderReferenceMatch(
  idColumn: AnyColumn | SQL,
  tenantId: string,
  reference: string,
  clientId?: string,
): SQL {
  const client = clientId === undefined ? sql`` : sql` and r.client_id = ${clientId}::uuid`;
  return sql`${idColumn} = any(array(
    select r.id from orders r
     where r.tenant_id = ${tenantId}::uuid and r.client_order_ref = ${reference}::text${client}
    union all
    select r.id from orders r
     where r.tenant_id = ${tenantId}::uuid and r.external_event_id = ${reference}::text${client}
  ))`;
}
