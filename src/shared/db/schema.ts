import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
 * Warehouse floor areas (Story 1.3). The first tables beyond `warehouses` to
 * carry `warehouse_id` alongside `tenant_id`: warehouse ownership is enforced
 * in the app layer (`assertWarehouseInTenant` inside the command transaction);
 * RLS stays single-dimension (`tenant_isolation`) — composite (tenant +
 * warehouse) policies are rejected (see spec 1.3 Design Notes). No FK
 * constraints (repo convention): `zones.warehouse_id` → `warehouses.id` is
 * uuid column + index, validated in the command transaction.
 *
 * Zone codes are unique per warehouse — duplicate rejection names the code
 * (409 `duplicate-zone-code`). No editing beyond creation (rename/re-move are
 * later stories).
 */
export const zones = pgTable(
  'zones',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('zones_warehouse_id_code_unique').on(table.warehouseId, table.code),
    index('zones_created_at_id_idx').on(table.createdAt, table.id),
  ],
);

export type Zone = typeof zones.$inferSelect;

/**
 * Putaway/pick locations (Story 1.3) — the first warehouse-scoped operational
 * rows: `warehouse_id` alongside `tenant_id`. Bin codes are unique per
 * warehouse (`bins_warehouse_id_code_unique`); duplicates are rejected naming
 * the conflicting code (409 `duplicate-bin-code`). `capacity` is a positive
 * integer in base-UoM units; `type` is the fixed set shelf/pallet/floor/
 * staging. `blocked` marks broken bins (default false). A created bin is
 * immediately usable downstream — no dormant state. `zone_id` → `zones.id` by
 * uuid column (no FK), validated in the command transaction.
 */
export const bins = pgTable(
  'bins',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    zoneId: uuid('zone_id').notNull(),
    code: text('code').notNull(),
    capacity: integer('capacity').notNull(),
    type: text('type').notNull(),
    blocked: boolean('blocked').notNull().default(false),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('bins_warehouse_id_code_unique').on(table.warehouseId, table.code),
    index('bins_created_at_id_idx').on(table.createdAt, table.id),
  ],
);

export type Bin = typeof bins.$inferSelect;

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
  (table) => [
    uniqueIndex('idempotency_keys_tenant_id_key_unique').on(table.tenantId, table.key),
    // Registration replay looks up by key alone (no tenant context yet) —
    // without this the auth path sequential-scans a table that grows on
    // every mutating request.
    index('idempotency_keys_key_idx').on(table.key),
  ],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;

/**
 * Sellable units (Story 1.4 — the first catalog module tables; the module
 * owns these exclusively). Codes are unique per tenant — duplicate imports
 * are row-level rejections naming the code, never a silent merge. Barcodes
 * are unique per tenant too; a barcode resolving to two SKUs is a row-level
 * rejection naming the conflicting SKU. `barcode` is generated server-side at
 * entry (uuidv7-derived) unless the import/edit supplies one. GST is stored
 * as basis points (integer); `reorderPoint`/`reorderQty` are base-UoM integer
 * defaults. No price/cost fields (spec 1.4 boundary). SKU code is immutable —
 * editing happens through the PATCH fields only.
 */
export const skus = pgTable(
  'skus',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    uom: text('uom').notNull(),
    gstRateBps: integer('gst_rate_bps').notNull(),
    hsn: text('hsn'),
    batchTracked: boolean('batch_tracked').notNull().default(false),
    serialTracked: boolean('serial_tracked').notNull().default(false),
    reorderPoint: integer('reorder_point').notNull().default(0),
    reorderQty: integer('reorder_qty').notNull().default(0),
    barcode: text('barcode').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('skus_tenant_id_code_unique').on(table.tenantId, table.code),
    uniqueIndex('skus_tenant_id_barcode_unique').on(table.tenantId, table.barcode),
    index('skus_created_at_id_idx').on(table.createdAt, table.id),
    index('skus_tenant_id_idx').on(table.tenantId),
  ],
);

export type Sku = typeof skus.$inferSelect;

/**
 * UoM conversions relative to the SKU's base UoM (Story 1.4): `factor` is a
 * **positive integer** — one `uom` equals `factor` base units (a box of 12 is
 * factor 12 against base `pcs`). Owned by catalog; `sku_id` → `skus.id` by
 * uuid column (no FK, repo convention), validated in the command transaction.
 * One conversion per (sku, uom) — a repeated target UoM in the same file is a
 * row-level `validation-failed`.
 */
export const uomConversions = pgTable(
  'uom_conversions',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    uom: text('uom').notNull(),
    factor: integer('factor').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('uom_conversions_sku_id_uom_unique').on(table.skuId, table.uom),
    index('uom_conversions_tenant_id_idx').on(table.tenantId),
  ],
);

export type UomConversion = typeof uomConversions.$inferSelect;

/**
 * One row per import run (Story 1.4): `mode` is `initial` or `fix`, the
 * counts are the response snapshot's counts. **Fix-mode targeting is the
 * latest run** (newest created_at, id tiebreaker): the failed SKU codes of
 * that row's `catalog_import_errors` are the fix set. Imports are synchronous
 * and idempotent (AD-5) — the idempotency record lives in `idempotency_keys`
 * (payload hash over file sha256 + mode), this table is the run ledger.
 */
export const catalogImports = pgTable(
  'catalog_imports',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    mode: text('mode').notNull(),
    committedRows: integer('committed_rows').notNull(),
    failedRows: integer('failed_rows').notNull(),
    skippedRows: integer('skipped_rows').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    index('catalog_imports_tenant_id_created_at_id_idx').on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type CatalogImport = typeof catalogImports.$inferSelect;

/**
 * Row-level import failures (Story 1.4): one row per rejected spreadsheet row
 * — `row_number` is the 1-based data-row index (header excluded), `sku_code`
 * may be absent when the row failed shape validation before a code could be
 * read. `reason_code` is the machine code clients branch on
 * (validation-failed / duplicate-sku-code / duplicate-barcode); `reason_detail`
 * is the human line. The latest run's non-null sku_codes are the fix set.
 */
export const catalogImportErrors = pgTable(
  'catalog_import_errors',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    importId: uuid('import_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    skuCode: text('sku_code'),
    reasonCode: text('reason_code').notNull(),
    reasonDetail: text('reason_detail').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    index('catalog_import_errors_import_id_idx').on(table.importId),
    index('catalog_import_errors_tenant_id_idx').on(table.tenantId),
  ],
);

export type CatalogImportError = typeof catalogImportErrors.$inferSelect;