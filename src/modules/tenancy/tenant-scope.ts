import { sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase, PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import type * as schema from '../../shared/db/schema';

export type TenancyDb = PostgresJsDatabase<typeof schema>;
export type TenancyTx = PgTransaction<
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
 */
export async function setTenantScope(tx: TenancyTx, tenantId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
}

export async function withTenantTransaction<T>(
  db: TenancyDb,
  tenantId: string,
  fn: (tx: TenancyTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setTenantScope(tx, tenantId);
    return fn(tx);
  });
}