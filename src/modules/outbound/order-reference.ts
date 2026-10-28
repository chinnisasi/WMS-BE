import { sql, type SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import { stripFollowOnSuffix } from './follow-on';

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
  // Story 4-2c (A10) — a printed follow-on label (`1042-BO1`) is searched as
  // typed: the reference AND, when it ends in `-BO{n}`, the reference without
  // it. A follow-on carries its root's number, so the stripped value finds the
  // whole chain (root and every follow-on); the raw value still finds a client
  // number that genuinely ends in `-BO1`. Each arm stays an index probe
  // (an equality, or an `in` of the two, on the leading column).
  const stripped = stripFollowOnSuffix(reference);
  const matches = (column: SQL): SQL =>
    stripped === null ? sql`${column} = ${reference}::text` : sql`${column} in (${reference}::text, ${stripped}::text)`;
  return sql`${idColumn} = any(array(
    select r.id from orders r
     where r.tenant_id = ${tenantId}::uuid and ${matches(sql`r.client_order_ref`)}${client}
    union all
    select r.id from orders r
     where r.tenant_id = ${tenantId}::uuid and ${matches(sql`r.external_event_id`)}${client}
  ))`;
}
