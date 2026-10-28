/**
 * Story 2-8b (A3) — THE advisory lock over one warehouse's DAMAGED pool. Every
 * document that CLAIMS units of the system DAMAGED bin takes it before it
 * reads the open claims and the on-hand: a return-to-vendor create and its
 * dispatch today, and 4-7c's return-to-client create and dispatch tomorrow —
 * one lock, so two documents of either kind can never each pass a pool check
 * against the other's uncommitted claim (4-7c decision 6). Taken as
 * `pg_advisory_xact_lock(hashtextextended(<this>, 0))`.
 *
 * Lock order: a document's own row (`FOR UPDATE`, dispatch only) → this →
 * the per-warehouse ledger advisory (`lockWarehouseInTx`, re-entrant with the
 * append's own). Nothing that holds the warehouse advisory waits on this.
 *
 * The key bytes are pinned by `test/vendor-returns.spec.ts`: renaming the
 * function is free, changing the text would let a build mid-deploy run two
 * pools side by side.
 */
export function damagedPoolLockKey(tenantId: string, warehouseId: string): string {
  return `${tenantId}:damaged-pool:${warehouseId}`;
}
