import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
 * The four coarse roles (Story 1.5): Owner, Ops Manager, Operator, Accountant.
 * Authority is a per-command DB read of this column — never a JWT claim.
 */
export const userRoleEnum = pgEnum('user_role', ['owner', 'ops_manager', 'operator', 'accountant']);

export type UserRole = (typeof userRoleEnum.enumValues)[number];

/**
 * Invite lifecycle status: `invited` (credentials not yet set) → `active`.
 * Sign-in rejects `invited` users with 403 `invite-pending`.
 */
export const USER_STATUSES = ['invited', 'active'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Owner and team users. Emails are globally unique (one account per email —
 * registration of an existing owner email is a 409 `duplicate-email`, and
 * inviting one is a 409 `email-exists`).
 * Passwords are stored as `node:crypto` scrypt hashes only.
 *
 * Story 1.5: `role` gates mutations (capability→role map in
 * `modules/tenancy/permissions.ts`, re-read from the DB at every command
 * service entry); `status` carries the invite lifecycle; `invite_token_hash`
 * + `invite_expires_at` carry the one-time invite (sha256 hash of the raw
 * token — the raw token is only ever in the invite API response, never
 * stored; 7-day expiry).
 */
export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  tenantId: uuid('tenant_id').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRoleEnum('role').notNull().default('operator'),
  status: text('status').notNull().default('active'),
  inviteTokenHash: text('invite_token_hash'),
  inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true, mode: 'string' }),
  ...tenantTimestamps,
});

export type User = typeof users.$inferSelect;

/**
 * Append-only audit trail for user/role actions (Story 1.5): one row per
 * invitation and role change, written in the same transaction as the
 * mutation. `reference` stores the request's idempotency key so retried
 * commands dedupe visibly. Rows are never updated or deleted (append-only by
 * convention; no update/delete code path exists).
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    reference: text('reference'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    ...tenantTimestamps,
  },
  (table) => [
    index('audit_events_tenant_id_occurred_at_idx').on(table.tenantId, table.occurredAt),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;

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
 * Batch identity (Story 2.4 — catalog-owned, beside `skus`): one row per
 * (tenant, sku, code) batch of a batch-tracked SKU, carrying the intake
 * master data — `mfg_date` / `expiry_date` (nullable; expiry is optional at
 * intake, and FEFO orders by expiry ASC with nulls last). Created
 * **idempotently** through the catalog facade's `ensureBatches` — never by a
 * direct table write from another module (AD-6: catalog owns batch identity).
 *
 * `status` is the lifecycle flag ('active' | 'blocked'); a DB CHECK in the
 * migration DDL enforces the set. The batch's *location and quantity* live in
 * the inventory module's `batch_on_hand` projection — never here (AD-6:
 * identity in catalog, stock state in inventory), and no location column
 * exists on this table by design.
 */
export const batches = pgTable(
  'batches',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    code: text('code').notNull(),
    mfgDate: timestamp('mfg_date', { withTimezone: true, mode: 'string' }),
    expiryDate: timestamp('expiry_date', { withTimezone: true, mode: 'string' }),
    status: text('status').notNull().default('active'),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('batches_tenant_sku_code_unique').on(table.tenantId, table.skuId, table.code),
    index('batches_tenant_sku_idx').on(table.tenantId, table.skuId),
  ],
);

export type Batch = typeof batches.$inferSelect;

/**
 * Serial identity (Story 2.4 — catalog-owned, beside `skus`): one row per
 * (tenant, sku, serial_number) unit of a serial-tracked SKU. Created
 * idempotently through the catalog facade's `ensureSerials` (AD-6).
 *
 * Like batches, **no location column exists here by design**: a serial's
 * current location is *derived* from its latest `ledger_events` row (the
 * inventory module's `(tenant_id, serial_ref, seq)` index) — the ledger is
 * the only source of serial location and history, so there is nothing to
 * reconcile. `status` is the lifecycle flag ('active' | 'blocked'), CHECK in
 * the migration DDL.
 */
export const serials = pgTable(
  'serials',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    serialNumber: text('serial_number').notNull(),
    status: text('status').notNull().default('active'),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('serials_tenant_sku_serial_unique').on(
      table.tenantId,
      table.skuId,
      table.serialNumber,
    ),
    index('serials_tenant_sku_idx').on(table.tenantId, table.skuId),
  ],
);

export type Serial = typeof serials.$inferSelect;

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

/**
 * The append-only inventory ledger (Story 2.1, AD-11/AD-16) — the **only
 * stock truth** in the system. Every stock movement is exactly one row here,
 * immutable at the database (the `ledger_events_append_only` trigger in the
 * migration DDL rejects UPDATE/DELETE — corrections are new compensating
 * events, never edits). One row per movement, committed in the same
 * transaction as the `stock_on_hand` projection it drives.
 *
 * Columns:
 * - `tenant_id` + `warehouse_id` + `seq` — seq is the per-warehouse replay
 *   order, gap-free and unique (unique index + `pg_advisory_xact_lock` per
 *   warehouse inside the append transaction).
 * - `type` + `schema_version` — the versioned event grammar: event types
 *   exist only by registration in `modules/inventory/ledger-registry.ts`
 *   (additive changes only — arms are never renumbered or repurposed).
 * - `sku_id` + `quantity_delta` — the movement: a **signed** base-UoM
 *   integer (`SignedQuantity`); positive deltas carry `to_bin_id`, negative
 *   deltas `from_bin_id` (both nullable — a transfer later story carries
 *   both).
 * - `batch_ref` / `serial_ref` — the Story 2.4 batch/serial arms: the
 *   catalog-owned `batches.id` / `serials.id` identity (as text), opened on
 *   `stock.adjusted` by the registry; a serial-tracked movement is exactly
 *   one event per unit (one `serial_ref` each). Old events with both null
 *   verify identically — the arms are additive.
 * - `actor_user_id`, `occurred_at` (business time, client-supplied),
 *   `recorded_at` (commit time, server), `reference_doc` (the typed
 *   reference union arm as jsonb).
 * - `prev_hash` / `event_hash` — the hash chain (AD-16): per tenant+warehouse
 *   chain, `event_hash` is sha256 over the canonical event bytes (fixed key
 *   order), `prev_hash` the predecessor's `event_hash` (64 zeros for the
 *   genesis event). The head is anchored via `ledger_anchors`.
 *
 * RLS policy + append-only trigger live **only in the migration SQL**
 * (0006), the established pattern.
 */
export const ledgerEvents = pgTable(
  'ledger_events',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    skuId: uuid('sku_id').notNull(),
    quantityDelta: integer('quantity_delta').notNull(),
    fromBinId: uuid('from_bin_id'),
    toBinId: uuid('to_bin_id'),
    batchRef: text('batch_ref'),
    serialRef: text('serial_ref'),
    actorUserId: uuid('actor_user_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'string' }).notNull(),
    referenceDoc: jsonb('reference_doc').notNull(),
    prevHash: text('prev_hash').notNull(),
    eventHash: text('event_hash').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // Gap-free, unique replay order per tenant+warehouse; also the
    // concurrency backstop behind the per-warehouse advisory lock.
    uniqueIndex('ledger_events_tenant_warehouse_seq_unique').on(
      table.tenantId,
      table.warehouseId,
      table.seq,
    ),
    // Replay of one SKU (across its bins) walks this index in seq order.
    index('ledger_events_tenant_warehouse_sku_seq_idx').on(
      table.tenantId,
      table.warehouseId,
      table.skuId,
      table.seq,
    ),
    // Event-timeline keyset pagination (created_at + id, standard cursor).
    // Event-timeline keyset pagination (created_at + id, standard
    // cursor) — warehouse-prefixed so one index also serves per-warehouse
    // timeline scans.
    index('ledger_events_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
    // Story 2.4 traceability reads: one query per serial (full movement
    // history, latest event = current location) and per batch — tenant-scoped
    // (a serial's location can cross warehouses), seq-ordered.
    index('ledger_events_tenant_serial_ref_seq_idx').on(
      table.tenantId,
      table.serialRef,
      table.seq,
    ),
    index('ledger_events_tenant_batch_ref_seq_idx').on(
      table.tenantId,
      table.batchRef,
      table.seq,
    ),
  ],
);

export type LedgerEvent = typeof ledgerEvents.$inferSelect;

/**
 * Derived on-hand projection (Story 2.1): one row per (tenant, warehouse,
 * SKU, bin), **maintained in the same transaction as the ledger event** that
 * moves the stock — never independently. `quantity` is a non-negative
 * integer in base UoM (the DB CHECK `stock_on_hand_quantity_nonnegative` in
 * the migration DDL is the backstop; the projection updater rejects an
 * over-draw naming the bin and current on-hand first). This table is the
 * only mutable stock table; `ledger_events` is immutable. Consumers read it
 * through `InventoryFacade`.
 */
export const stockOnHand = pgTable(
  'stock_on_hand',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    binId: uuid('bin_id').notNull(),
    quantity: integer('quantity').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('stock_on_hand_scope_unique').on(
      table.tenantId,
      table.warehouseId,
      table.skuId,
      table.binId,
    ),
    index('stock_on_hand_tenant_warehouse_sku_idx').on(
      table.tenantId,
      table.warehouseId,
      table.skuId,
    ),
  ],
);

export type StockOnHand = typeof stockOnHand.$inferSelect;

/**
 * Derived per-batch on-hand projection (Story 2.4): one row per
 * (tenant, warehouse, SKU, bin, **batch**) — the batch-arm sibling of
 * `stock_on_hand`, maintained in the SAME transaction as the ledger event
 * that moves the batch (and re-derived by rebuild/reconcile exactly from the
 * ledger). `batch_ref` on the event carries the `batches.id` identity; this
 * table carries the quantity. Non-negative (the DB CHECK
 * `batch_on_hand_quantity_nonnegative` in the migration DDL is the backstop;
 * the fold rejects a batch over-draw first, naming the batch).
 *
 * RLS policy lives **only in the migration SQL** (0010, the 0006-0009
 * pattern). Like `stock_on_hand`, this is a mutable projection: the only
 * write paths are the append fold and the rebuild, both inside
 * `modules/inventory/ledger.service.ts` (the architecture test pins it).
 */
export const batchOnHand = pgTable(
  'batch_on_hand',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    binId: uuid('bin_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    quantity: integer('quantity').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('batch_on_hand_scope_unique').on(
      table.tenantId,
      table.warehouseId,
      table.skuId,
      table.binId,
      table.batchId,
    ),
    index('batch_on_hand_tenant_warehouse_sku_idx').on(
      table.tenantId,
      table.warehouseId,
      table.skuId,
    ),
  ],
);

export type BatchOnHand = typeof batchOnHand.$inferSelect;

/**
 * Chain anchors (Story 2.1, AD-16 — the human Option A decision): chain
 * heads anchor to this append-only Postgres table — `digest` over the
 * event-hash range, `from_seq`..`to_seq` inclusive, `anchored_at` the
 * commitment instant. The anchor *target* is the `LedgerAnchorStore`
 * interface in the inventory module; a real external WORM store swaps in
 * behind it without touching the chain. Append-only like the ledger itself
 * (same trigger pattern in the migration DDL).
 */
export const ledgerAnchors = pgTable(
  'ledger_anchors',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    fromSeq: integer('from_seq').notNull(),
    toSeq: integer('to_seq').notNull(),
    digest: text('digest').notNull(),
    anchoredAt: timestamp('anchored_at', { withTimezone: true, mode: 'string' }).notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // One anchor per (tenant, warehouse, toSeq) — the DB backstop behind
    // the advisory lock against two overlapping anchor ranges.
    uniqueIndex('ledger_anchors_tenant_warehouse_to_seq_unique').on(
      table.tenantId,
      table.warehouseId,
      table.toSeq,
    ),
  ],
);

export type LedgerAnchor = typeof ledgerAnchors.$inferSelect;

/**
 * Transactional outbox (story outbox-relay, AD-7): one pending row per domain
 * event, inserted in the SAME transaction as the domain write it rides (see
 * `shared/events/outbox.ts` — the `PostgresOutboxSink`/`PostgresOutboxRelay`
 * pair). The relay drains pending rows oldest-first, publishes them through
 * `EVENT_BUS`, and deletes each on ack — **there is no `delivered` state**:
 * delete-on-ack is the v1 disposition, and the append-only ledger + committed
 * state can always re-derive an event if delivery must be replayed.
 *
 * Columns:
 * - `status` — `pending` (due per `next_attempt_at`) or `quarantined` (past
 *   the retry budget; re-drains only by operator action).
 * - `attempts` / `next_attempt_at` / `last_error` — the retry substrate the
 *   relay maintains (exponential backoff, `min(2^(attempts-1)·5s, 5min)`;
 *   IN-07 observability reads these later — no dashboards yet).
 *
 * RLS policy lives **only in the migration SQL** (0007, the 0006 pattern):
 * fail-closed single-dimension `tenant_isolation` — a session without
 * `app.tenant_id` sees zero rows. The relay's one cross-tenant read (tenant
 * discovery) runs on the BYPASSRLS connection (see outbox.ts); every row
 * mutation goes through an explicitly tenant-scoped transaction.
 */
export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    type: text('type').notNull(),
    // The event grammar rides as jsonb unchanged (no per-subscriber shape).
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    // Business time — the instant the event says it happened (command
    // commit for most), never the relay's publish clock.
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    // Due time for the next drain attempt (now() for a fresh row; null is
    // never stored — quarantined rows keep their last computed value and are
    // excluded by status).
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    lastError: text('last_error'),
    ...tenantTimestamps,
  },
  (table) => [
    // Per-tenant batch select (the relay's only hot read): tenant first, then
    // the due filter, oldest-first by (created_at).
    index('outbox_messages_tenant_status_next_attempt_idx').on(
      table.tenantId,
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
  ],
);

export type OutboxMessageRow = typeof outboxMessages.$inferSelect;

/**
 * Continuous reconciliation state (Story 2.2): one row per (tenant, warehouse)
 * partition — `last_seq` is the watermark through which the projection has
 * been verified, `invalid_attempts` the consecutive checkpoint-validation
 * failures (a checkpoint that fails twice is discarded, and the DISCARDING
 * cycle itself replays from seq 1 immediately), and `last_divergences` the
 * scopes flagged by the most
 * recent non-advanced pass (the "repeat within the window" memory: a scope
 * flagged again before the checkpoint advances is a REPEAT divergence —
 * quarantined and re-alerted, not silently rebuilt a second time). Cleared on
 * a clean advance and on discard.
 *
 * RLS policy lives **only in the migration SQL** (0008, the 0006/0007
 * pattern): fail-closed single-dimension `tenant_isolation`. The worker's one
 * cross-tenant read (partition discovery, oldest-checkpoint-first) runs on the
 * BYPASSRLS connection like the relay's tenant discovery; every row write
 * stays in a tenant-scoped transaction.
 */
export const reconciliationCheckpoints = pgTable(
  'reconciliation_checkpoints',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    lastSeq: integer('last_seq').notNull().default(0),
    invalidAttempts: integer('invalid_attempts').notNull().default(0),
    lastDivergences: jsonb('last_divergences').$type<Record<string, unknown>[] | null>(),
    ...tenantTimestamps,
  },
  (table) => [
    // One checkpoint per (tenant, warehouse) partition.
    uniqueIndex('reconciliation_checkpoints_tenant_warehouse_unique').on(
      table.tenantId,
      table.warehouseId,
    ),
    // Partition discovery orders by the oldest checkpoint first (fairness:
    // no partition starves).
    index('reconciliation_checkpoints_tenant_updated_at_idx').on(
      table.tenantId,
      table.updatedAt,
    ),
  ],
);

export type ReconciliationCheckpoint = typeof reconciliationCheckpoints.$inferSelect;

/**
 * Durable quarantine of a stock scope (Story 2.2): a (tenant, warehouse,
 * sku, bin) whose projection diverged REPEATEDLY within one checkpoint window
 * — first divergence is rebuilt+alerted, a repeat is quarantined and
 * re-alerted before it is rebuilt again. `from_seq`/`to_seq` name the
 * divergent event range, `reason` the machine cause. The flag gates nothing
 * in this story (2.3's reservation path enforces it); surfaced here only as
 * data. One OPEN row per scope (partial unique index) — history accumulates
 * as rows move to `resolved`.
 *
 * RLS policy + status CHECK live **only in the migration SQL** (0008).
 */
export const inventoryQuarantines = pgTable(
  'inventory_quarantines',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    binId: uuid('bin_id').notNull(),
    fromSeq: integer('from_seq').notNull(),
    toSeq: integer('to_seq').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('open'),
    ...tenantTimestamps,
  },
  (table) => [
    // The scan's repeat check: one open quarantine per scope.
    uniqueIndex('inventory_quarantines_open_scope_unique')
      .on(table.tenantId, table.warehouseId, table.skuId, table.binId)
      .where(sql`status = 'open'`),
    index('inventory_quarantines_tenant_warehouse_status_idx').on(
      table.tenantId,
      table.warehouseId,
      table.status,
    ),
  ],
);

export type InventoryQuarantine = typeof inventoryQuarantines.$inferSelect;

/**
 * Reservation journal (Story 2.3, AD-12): the durable truth for sellable-stock
 * holds — Valkey's per-(warehouse, sku) reserved counters are a mirror of
 * `state IN ('held','committed')` sums, rebuilt from this table on divergence
 * (Postgres wins; the journal never repairs toward the mirror). One row per
 * owner hold:
 *
 * - `owner_type` / `owner_id` — who holds it (Epic 4's order lines are the
 *   first writers); grant is idempotent per (owner, warehouse, sku) while
 *   held — the partial unique index is the DB backstop.
 * - `state` — `held → committed → released/expired`; terminal transitions
 *   serialize through a conditional UPDATE (`… WHERE state = 'held'`), so
 *   exactly one caller wins and a second terminal write is a deterministic
 *   conflict (rowcount = 0). `committed` units stay deducted until the
 *   consuming ledger movement (Epic 4's dispatch); `released`/`expired`
 *   restore the counter.
 * - `expires_at` — the hold's TTL; the sheddable reaper (jobs shell)
 *   transitions past-TTL rows to `expired` exactly once and restores the
 *   counter. Valkey key TTLs are a backstop only.
 *
 * Scope is (tenant, warehouse, sku) — never bin-level (no batch/serial
 * dimensions; Story 2.4 and Epic 7 are out of scope here).
 *
 * RLS policy + state/quantity CHECKs live **only in the migration SQL**
 * (0009, the 0006/0007/0008 pattern).
 */
export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    quantity: integer('quantity').notNull(),
    state: text('state').notNull().default('held'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // The reaper's scan (held rows past TTL) and any state-filtered read.
    index('reservations_tenant_state_expires_at_idx').on(table.tenantId, table.state, table.expiresAt),
    // Grant idempotency (AD-5 adjacency): one OPEN hold per owner scope —
    // a repeat grant while held returns the existing row.
    uniqueIndex('reservations_open_owner_scope_unique')
      .on(table.tenantId, table.warehouseId, table.skuId, table.ownerType, table.ownerId)
      .where(sql`state = 'held'`),
    // Reserved-counter rebuild: per-scope sums over the live states.
    index('reservations_tenant_warehouse_sku_state_idx').on(
      table.tenantId,
      table.warehouseId,
      table.skuId,
      table.state,
    ),
  ],
);

export type Reservation = typeof reservations.$inferSelect;

/**
 * Vendors (Story 3.1 — the inbound module's first tables): purchase-order
 * counterparties as a **real entity** (not a free-text field) — Epic 6's
 * suggested-PO drafts read default vendors (`is_default`). Codes are unique
 * per tenant (the SKU-code convention); a duplicate create is a 409 naming
 * the conflicting code. No editing beyond creation (vendor edit is a later
 * story).
 *
 * RLS policy lives **only in the migration SQL** (0011, the 0005→0010
 * pattern). `vendors` is tenant-scoped, NOT warehouse-scoped — a vendor is
 * commercial master data; the PO carries the warehouse.
 */
export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('vendors_tenant_id_code_unique').on(table.tenantId, table.code),
    // Vendor-list keyset pagination (created_at + id, standard cursor).
    index('vendors_created_at_id_idx').on(table.createdAt, table.id),
  ],
);

export type Vendor = typeof vendors.$inferSelect;

/**
 * Purchase orders (Story 3.1): warehouse-scoped upstream documents —
 * receiving (3.3) and open-quantity tracking are per-warehouse, so
 * `warehouse_id` is required from day one (no later re-scoping migration).
 * Codes are client-supplied and unique per tenant — a duplicate is a 409
 * naming the conflicting code (the SKU-code convention).
 *
 * `status` is the deliberately two-valued lifecycle (`open` → `closed` with
 * close as an explicit command; text + hand-appended CHECK per the repo
 * convention, no pgEnum). `carried_from_po_id` references the PO whose open
 * quantities this row carries at close (a close with ≥1 carried line
 * auto-creates this successor; uuid column, no FK — validated in-command).
 * No FKs anywhere (repo convention): `vendor_id` / `warehouse_id` /
 * `carried_from_po_id` are uuid columns asserted in the command transaction.
 *
 * RLS policy + status CHECK live **only in the migration SQL** (0011).
 */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    vendorId: uuid('vendor_id').notNull(),
    code: text('code').notNull(),
    status: text('status').notNull().default('open'),
    carriedFromPoId: uuid('carried_from_po_id'),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('purchase_orders_tenant_id_code_unique').on(table.tenantId, table.code),
    // PO-list keyset pagination (the status filter composes on top).
    index('purchase_orders_tenant_created_at_id_idx').on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    // The list is warehouse-scoped — keyset within one warehouse.
    index('purchase_orders_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
    // The carried-from chain: from a closed PO to its successor(s).
    index('purchase_orders_tenant_carried_from_idx').on(
      table.tenantId,
      table.carriedFromPoId,
    ),
  ],
);

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;

/**
 * Purchase-order lines (Story 3.1): the per-line ordered / received / open
 * truth. Quantities are **positive integers in base UoM** (`ordered_qty` > 0
 * by the hand-appended CHECK); `received_qty` ships defaulting to 0 and
 * is updated transactionally by 3.3's GRN commands — never derived from the
 * ledger; `open_qty` is ALWAYS derived (`ordered − received`), never stored.
 * `unit_cost_paise` is the per-line price carrier (integer paise, AD-9).
 * `status` carries the close disposition (`open` | `cancelled` | `carried`).
 *
 * RLS policy + status/non-negative CHECKs live **only in the migration SQL**
 * (0011, the 0010 pattern). The `open_qty ≥ 0` CHECK (received ≤ ordered)
 * lands with the 3.3 receipt path — shipping it now would block over-receipt
 * approval (3.3's mid-receive gate allows receipts past the ordered qty).
 */
export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    poId: uuid('po_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    orderedQty: integer('ordered_qty').notNull(),
    receivedQty: integer('received_qty').notNull().default(0),
    unitCostPaise: integer('unit_cost_paise').notNull(),
    expectedDate: timestamp('expected_date', { withTimezone: true, mode: 'string' }),
    status: text('status').notNull().default('open'),
    ...tenantTimestamps,
  },
  (table) => [
    // The detail read's per-line ordering and any per-PO quantity roll-up.
    index('purchase_order_lines_po_id_idx').on(table.poId, table.createdAt, table.id),
  ],
);

export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;
