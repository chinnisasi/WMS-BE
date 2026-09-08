import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../primitives/ids';

/**
 * Infrastructure-only table proving the Drizzle migration pipeline (Story 1.1).
 * No tenant scoping applies — it predates the tenancy spine and is not touched
 * by stories that add domain tables.
 */
export const appMetadata = pgTable('app_metadata', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  key: text('key').notNull().unique(),
  value: jsonb('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export type AppMetadata = typeof appMetadata.$inferSelect;

const tenantTimestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
};

/**
 * Tenancy spine (Story 1.2). AD-3: every table carries `tenant_id` (uuid v7,
 * NOT NULL) and Postgres RLS backs the app-layer scoping. **RLS is declared
 * only in the migration SQL** (0001: `ENABLE ROW LEVEL SECURITY` + the
 * `app.tenant_id` policies): drizzle-orm 0.45 cannot model RLS in the schema
 * (no `enableRLS`; `pgPolicy` declarations would make future `generate` runs
 * emit conflicting `CREATE POLICY` against the hand-written DDL), so the
 * drizzle snapshot records `isRLSEnabled: false` — a known, documented gap.
 * Never rely on drizzle-kit for RLS; carry the DDL in migrations by hand.
 * `warehouses` is the first warehouse-scoped pattern: operational tables in
 * later stories add `warehouse_id` alongside `tenant_id`.
 *
 * `tenants.tenant_id` is stamped equal to `id`: the RLS policy is uniform on
 * every table, so the tenant row scopes to itself.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  ...tenantTimestamps,
});

export type Tenant = typeof tenants.$inferSelect;

/**
 * Owner and team users. Emails are globally unique (one account per email —
 * registration of an existing owner email is a 409 `duplicate-email`).
 * Passwords are stored as `node:crypto` scrypt hashes only.
 */
export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  tenantId: uuid('tenant_id').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  ...tenantTimestamps,
});

export type User = typeof users.$inferSelect;

/**
 * Stocking sites. Warehouse codes are unique per tenant — duplicate rejection
 * names the conflicting code (409 `duplicate-warehouse-code`).
 */
export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    ...tenantTimestamps,
  },
  (table) => [uniqueIndex('warehouses_tenant_id_code_unique').on(table.tenantId, table.code)],
);

export type Warehouse = typeof warehouses.$inferSelect;

/**
 * Real idempotency storage (AD-5): unique `(tenant_id, key)` with the payload
 * hash and the response snapshot, de-duped in the same transaction as the
 * write. Rows are written by the tenancy command services.
 *
 * Registration is the one caller with no tenant context yet: its rows are
 * still tenant-scoped (tenant_id = the created tenant), but replay lookup is
 * by key alone — a foreign key replay fails the payload-hash comparison and
 * 422s, so nothing leaks.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    key: text('key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    responseSnapshot: jsonb('response_snapshot').notNull(),
    ...tenantTimestamps,
  },
  (table) => [uniqueIndex('idempotency_keys_tenant_id_key_unique').on(table.tenantId, table.key)],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;