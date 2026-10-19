import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * Story 1-5a — the staff lists' optional client filter, as SQL predicates.
 *
 * Every staff list that takes `?clientId=` narrows INSIDE its tenant
 * transaction and BEFORE its page limit (a filter over the loaded page would
 * miss a client whose rows are all older than page 1). Absent → `undefined`,
 * which `and(...)` drops: the list's SQL is byte for byte what it was. An
 * unknown or another tenant's client id matches nothing — an empty page,
 * never a 404 (the ASN-list precedent).
 *
 * The shapes, one per kind of row (spec 1-5a, "Predicate per list"):
 *  - own `client_id` column → the caller's `eq(t.clientId, $c)`;
 *  - a row with a SKU and no client of its own → {@link skuOfClient};
 *  - a row reaching its client through orders → {@link anyOrderOfClient}
 *    over the caller's own subquery of order ids.
 */

/**
 * `<skuColumn> in (the client's SKUs)`. The SKU is the source of truth for
 * ownership (AD-23, guide §7b), so a row that carries only a SKU — stock, a
 * putaway, a hold, a variance, a breach — belongs to its SKU's client.
 */
export function skuOfClient(skuColumn: SQLWrapper, tenantId: string, clientId: string): SQL {
  return sql`${skuColumn} in (
    select s.id from skus s
    where s.tenant_id = ${tenantId}::uuid and s.client_id = ${clientId}::uuid
  )`;
}

/**
 * `exists (an order of the client among <orderIds>)` — the any-match rule
 * for a mixed row (decision 4): a wave or manifest holding one order of each
 * of two clients appears under both. `orderIds` is a correlated subquery
 * yielding the row's order ids; a row with none matches no client.
 */
export function anyOrderOfClient(orderIds: SQL, tenantId: string, clientId: string): SQL {
  return sql`exists (
    select 1 from orders o
    where o.tenant_id = ${tenantId}::uuid
      and o.client_id = ${clientId}::uuid
      and o.id in (${orderIds})
  )`;
}

/** `<orderColumn>`'s order is the client's — a row of exactly one order (an invoice, a picklist line). */
export function orderOfClient(orderColumn: SQLWrapper, tenantId: string, clientId: string): SQL {
  return sql`${orderColumn} in (
    select o.id from orders o
    where o.tenant_id = ${tenantId}::uuid and o.client_id = ${clientId}::uuid
  )`;
}
