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

export async function withTenantTransaction<T>(
  db: TenantDb,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setTenantScope(tx, tenantId);
    return fn(tx);
  });
}