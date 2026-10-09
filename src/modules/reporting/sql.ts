import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';

/**
 * The reporting module's SQL helpers — moved here from `kpis.ts` by story
 * 21-8 so the per-client service read (`service.ts`) shares them with the
 * Overview tiles. Behaviour unchanged: `test/reporting.spec.ts` pins every
 * tile figure over them.
 */

/** The per-statement ceiling: no tile statement runs longer than this. */
export const TILE_STATEMENT_TIMEOUT_MS = 1500;

/**
 * The runner's overall deadline (epoch ms) for each tile transaction it
 * opened. Every tile statement re-arms the transaction-local
 * `statement_timeout` to `min(1500 ms, time left)` first, so no tile outlives
 * the overview's deadline by more than a round trip. A transaction with no
 * entry (the service read) keeps whatever timeout it set itself.
 */
export const TILE_TX_DEADLINES = new WeakMap<object, number>();

export async function rowsOf<T>(tx: TenantTx, query: SQL): Promise<T[]> {
  const deadlineAt = TILE_TX_DEADLINES.get(tx);
  if (deadlineAt !== undefined) {
    const timeoutMs = Math.max(1, Math.min(TILE_STATEMENT_TIMEOUT_MS, deadlineAt - Date.now()));
    await tx.execute(sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`);
  }
  return (await tx.execute(query)) as unknown as T[];
}

/** `count(*)::bigint` arrives as a STRING through postgres.js (the int8 boundary) — coerce here. */
export function n(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/** A nullable float aggregate (a median) — null stays null ("no data"), never 0. */
export function nf(value: string | number | null | undefined, decimals = 1): number | null {
  if (value === null || value === undefined) return null;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

/** A ratio, null when the denominator is zero ("no data", never a fake 0). */
export function ratio(numerator: number, denominator: number, decimals = 4): number | null {
  if (denominator === 0) return null;
  const factor = 10 ** decimals;
  return Math.round((numerator / denominator) * factor) / factor;
}

export function ts(value: string): SQL {
  return sql`${value}::timestamptz`;
}

/**
 * When the 0058 facts began to be recorded. `app_metadata` is
 * infrastructure (no tenant, no RLS); the value is a JSON string holding a
 * timestamptz rendering, normalized to canonical ISO here.
 */
export async function countingSinceInTx(tx: TenantTx): Promise<string | null> {
  const rows = await rowsOf<{ value: unknown }>(
    tx,
    sql`select value from app_metadata where key = 'reporting_facts_since' limit 1`,
  );
  const raw = rows[0]?.value;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
