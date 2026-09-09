import { sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase, PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import type * as schema from './schema';

export type TenantDb = PostgresJsDatabase<typeof schema>;
export type TenantTx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Tenant scoping (AD-3 / Design Notes): every query path runs inside a
 * transaction that stamps `app.tenant_id` — the Postgres RLS policies
 * (`tenant_id = current_setting('app.tenant_id'::uuid)`) are the verified
 * backstop, the app-layer `WHERE tenant_id` filters stay authoritative.
 * `set_config(..., true)` is transaction-local (`SET LOCAL` semantics), so
 * the scope dies with the transaction and cannot leak across requests.
 *
 * Lives in `shared/db` (moved from the tenancy module in Story 1.4) because
 * tenant-scoped transactions are a spine primitive, not a tenancy feature —
 * the catalog module (and every later module that owns tables) needs the same
 * seam without importing from tenancy.
 */
export async function setTenantScope(tx: TenantTx, tenantId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
}

/** Isolation the caller may pin for one tenant transaction (default: DB's). */
export interface TenantTransactionOptions {
  /**
   * Drizzle passes this into `begin isolation level …`. A multi-statement
   * read that must see ONE snapshot (the reconciliation scan: watermark →
   * event fold → projection compare under MVCC, so a movement committing
   * mid-read is either fully visible or fully invisible — never half) pins
   * `repeatable read` here. Every other caller keeps the default.
   */
  readonly isolationLevel?: 'repeatable read';
}

export async function withTenantTransaction<T>(
  db: TenantDb,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options: TenantTransactionOptions = {},
): Promise<T> {
  const scoped = async (tx: TenantTx): Promise<T> => {
    await setTenantScope(tx, tenantId);
    return fn(tx);
  };
  return options.isolationLevel === undefined
    ? db.transaction(scoped)
    : db.transaction(scoped, { isolationLevel: options.isolationLevel });
}
