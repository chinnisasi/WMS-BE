/**
 * Tenant-namespaced, hash-tagged key builders for the reservation counters
 * (story 2.3, AD-3): every key carries the tenant id FIRST inside a hash tag
 * `{...}` so a Valkey cluster co-locates one tenant's atomic-decision keys in
 * the same slot — multi-key scripts never cross slots, and the namespace is
 * uniform:
 *
 *   `wms:{tenantId}:wh:{warehouseId}:res:{skuId}`   — the (warehouse, sku)
 *                                                     reserved counter
 *   `wms:{tenantId}:wh:{warehouseId}:res:__ready__` — the warehouse's ready
 *                                                     marker (see below)
 *
 * The ready marker is the fail-closed gate: it is present ONLY while the
 * warehouse's counters are loaded and agree with the journal's last rebuild.
 * A cold (or restarted, or diverged) Valkey has no marker → every grant and
 * ATP read fails closed until a rebuild from the Postgres journal re-arms it.
 */

/** The reserved counter for one (tenant, warehouse, sku) scope. */
export function reservationCounterKey(tenantId: string, warehouseId: string, skuId: string): string {
  return `wms:{${tenantId}}:wh:${warehouseId}:res:${skuId}`;
}

/** The ready marker for one warehouse's counters (fail-closed rebuild gate). */
export function reservationReadyKey(tenantId: string, warehouseId: string): string {
  return `wms:{${tenantId}}:wh:${warehouseId}:res:__ready__`;
}
