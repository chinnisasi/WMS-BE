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

/**
 * Story 21-2 (AD-24) — the client stamping primitive, the second scoping
 * dimension beside `setTenantScope`. Sets `app.client_id` transaction-local,
 * so the client clause of the RLS policies (`skus`, `orders`,
 * `purchase_orders`, `ledger_events`, `clients`) binds the transaction to
 * exactly one client's rows. Mirrors `setTenantScope` in every respect —
 * same `set_config(..., true)` idiom, scope dies with the transaction.
 */
export async function setClientScope(tx: TenantTx, clientId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.client_id', ${clientId}, true)`);
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
  /**
   * Story 21-2 (AD-24) — the client-portal scoping arm. When set, the
   * transaction stamps `app.client_id` transaction-local and the database
   * makes every other client's rows unreachable (fail-closed: set-but-wrong
   * binds to nothing; an empty string is REJECTED — the policy NULLIF reads
   * it as unset, which would stamp the operator shape silently). Omitted —
   * every existing call site — the variable is
   * NEVER touched: the operator shape, which sees the whole tenant
   * (cross-client waves untouched). There is deliberately no "clear" arm: an
   * unset variable is the operator shape; the caller wanting it simply omits
   * the option.
   */
  readonly clientId?: string;
}

export async function withTenantTransaction<T>(
  db: TenantDb,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options: TenantTransactionOptions = {},
): Promise<T> {
  const scoped = async (tx: TenantTx): Promise<T> => {
    await setTenantScope(tx, tenantId);
    if (options.clientId !== undefined) {
      // Fail closed on the one input that would silently FAIL OPEN: the
      // policies read the variable through NULLIF(…, ''), so an empty string
      // is indistinguishable from UNSET — it stamps the operator shape
      // (whole-tenant visibility) while the caller believes it scoped.
      if (options.clientId === '') {
        throw new Error(
          `withTenantTransaction: clientId ${JSON.stringify(options.clientId)} is rejected — an empty string reads as UNSET at the policy level (the NULLIF idiom), stamping the operator shape; pass a client uuid or omit the option`,
        );
      }
      await setClientScope(tx, options.clientId);
    }
    return fn(tx);
  };
  return options.isolationLevel === undefined
    ? db.transaction(scoped)
    : db.transaction(scoped, { isolationLevel: options.isolationLevel });
}
