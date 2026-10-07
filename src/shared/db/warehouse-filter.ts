import { sql, type SQL } from 'drizzle-orm';

/**
 * Story 21-5 — the optional warehouse narrowing of a billing count predicate,
 * on the given warehouse column (`grn.warehouse_id`, `p.warehouse_id`,
 * `le.warehouse_id`). A client invoice meters each supplying GSTIN over ITS
 * warehouses only, so the receipt-line, pick and dispatched-order predicates
 * (21-4 — one per owning module) take the same optional list.
 *
 * Absent → an empty fragment: the 21-4 SQL, byte for byte. Present →
 * `and <column> = any($ids::uuid[])`, the ids bound as ONE uuid[] parameter
 * (never concatenated into text); an EMPTY list matches nothing. Shared so
 * the three filters are one rule.
 */
export function warehouseFilter(column: SQL, warehouseIds: readonly string[] | undefined): SQL {
  if (warehouseIds === undefined) return sql``;
  return sql` and ${column} = any(${sql.param([...warehouseIds])}::uuid[])`;
}

/** A billing count's scope: one client, optionally narrowed to a set of warehouses. */
export interface ClientCountScope {
  readonly tenantId: string;
  readonly clientId: string;
  readonly warehouseIds?: readonly string[] | undefined;
}
