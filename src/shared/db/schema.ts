import { sql } from 'drizzle-orm';
import { bigint, boolean, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
  /**
   * Story 8-1 — the tenant's GSTIN, the DEFAULT supplier identity invoicing
   * falls back to when a warehouse carries none of its own. Nullable: a
   * tenant may register before it has one, and an invoice whose supplier
   * GSTIN cannot resolve parks `awaiting-data` with a gap (never issues).
   * Stamped at registration only — the settings-edit route is deferred
   * (PENDING, 8-1). Normalized to uppercase at the write edge.
   */
  gstin: text('gstin'),
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
  /**
   * Story 21-1 — the client-portal persona arm (AD-23): null = a member of
   * the tenant's own staff; set = a client-portal user. Nullable BY DESIGN
   * (the attribute, not a scoping column) and INERT until a portal session
   * exists (21-2/21-7 own the persona question and the RLS clause).
   */
  clientId: uuid('client_id'),
  inviteTokenHash: text('invite_token_hash'),
  inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true, mode: 'string' }),
  ...tenantTimestamps,
});

export type User = typeof users.$inferSelect;

/**
 * Story 21-1 — the client dimension (AD-23): one row per client brand whose
 * goods this tenant stores and ships. Every tenant has EXACTLY ONE
 * system-owned `self` client (AD-23), created in the same transaction as the
 * tenant by `ensureSelfClientInTx` (`src/modules/clients/ensure-self-client.ts`)
 * and backfilled for pre-existing tenants by migration 0040 — D2C is the
 * one-client case of the 3PL model, never a mode branch.
 *
 * `code` is the operator-facing short code, unique per tenant. `system_owned`
 * follows the `bins.system_owned` precedent and marks the tenant's own goods;
 * the partial unique index on `(tenant_id) WHERE system_owned` is what makes
 * "exactly one self client per tenant" a DB invariant, not a convention.
 * `status` is the full designed vocabulary frozen at birth (widening a CHECK
 * needs DROP + re-ADD — the 0023/0024 precedent); the
 * `system_owned ⇒ NOT departed` pairing is a CHECK declared ONLY in
 * `drizzle/0040_client_dimension.sql` (CHECKs live only in migration SQL).
 */
export const CLIENT_STATUSES = ['active', 'suspended', 'departed'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** The fixed code the system-owned client always carries. */
export const SELF_CLIENT_CODE = 'self';

export const clients = pgTable(
  'clients',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    systemOwned: boolean('system_owned').notNull().default(false),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('clients_tenant_id_code_unique').on(table.tenantId, table.code),
    // AD-23: exactly one system-owned client per tenant — the partial unique
    // index refuses a second, in any transaction, including a concurrent
    // ensure.
    uniqueIndex('clients_tenant_system_owned_unique')
      .on(table.tenantId)
      .where(sql`system_owned`),
  ],
);

export type Client = typeof clients.$inferSelect;

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
 *
 * Origin address (story 11-1): seven flat, nullable text columns — the point
 * the warehouse ships FROM, rated and labelled from (story 4-6d). Set at
 * create only; the update path is 4-6d's to add. Pre-11.1 rows read back
 * null and are simply unrated. No FKs (repo convention). Column shape is the
 * shared address field set (`src/shared/primitives/address.ts`); pincode is
 * TEXT, never an integer — leading zeros are significant.
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
    /** Origin address (story 11-1) — required at create, null on pre-11.1 rows. */
    originContactName: text('origin_contact_name'),
    originPhone: text('origin_phone'),
    originLine1: text('origin_line1'),
    originLine2: text('origin_line2'),
    originCity: text('origin_city'),
    originState: text('origin_state'),
    originPincode: text('origin_pincode'),
    /**
     * Story 8-1 — the warehouse's GSTIN, the supplier identity invoicing
     * prefers over the tenant default (the dispatch's origin party).
     * Nullable (pre-8-1 rows and tenants without one); uppercase-normalized
     * at the write edge. Set at create only, like the origin address itself.
     */
    gstin: text('gstin'),
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
 *
 * Story 3.3 adds `system_owned` (additive, default false): the tenancy
 * facade's auto-created system Receiving bin per warehouse is flagged here so
 * putaway suggestions (3.5) and picking exclude it. Only the tenancy
 * receiving-bin facade sets it true; user-created bins are always false.
 *
 * Story 3.6 adds the retirement pair (additive, nullable — the devices
 * `revoked_at/revoked_by` pattern): `retired_at/retired_by` are set together
 * by the retire command (the pairing CHECK lives only in the 0016 migration
 * SQL — the 0014 release-pairing pattern) and are never cleared. Retire is
 * terminal — the row stays (the (warehouse_id, code) unique key keeps the
 * code reserved; no bin deletion anywhere).
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
    /**
     * Story 21-1 — the dedicated-storage attribute (AD-23): null = commingled
     * (the default — most 3PLs commingle); set = this bin holds only that
     * client's goods. Nullable BY DESIGN: this is an attribute, not a scoping
     * column, and pre-21.1 bins (all commingled) read null. Inert until 21-2+
     * give it a consumer.
     */
    dedicatedClientId: uuid('dedicated_client_id'),
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    capacity: bigint('capacity', { mode: 'number' }).notNull(),
    /**
     * Story 11-5 — the bin's OPTIONAL physical capacity (FR-39): internal
     * dimensions and a max weight, the bin-side counterpart of 11.2's SKU
     * attributes and the second side of the three new capacity gates
     * (placement, merge, suggestion) that consume them beside the unit gate.
     * Integer storage, WYSIWYG everywhere — millimetres and grams, the 11.2
     * precedent, bins sized a magnitude above SKUs (a floor location is an
     * area): dims ≤ 100,000 mm, weight ≤ 100,000,000 g. All four are
     * nullable = unconstrained = pre-11.5 behavior; a bin without limits is
     * gated by its unit count alone.
     *
     * Tenancy owns the writes (structure — create/grid/editBinCapacity);
     * putaway only reads them in its gates. Bounds are CHECKs declared in
     * `drizzle/0034_bin_dimensional_capacity.sql` (the 0031 pattern — CHECKs
     * live only in migration SQL) and mirrored in `assertBinCapacityAttributes`
     * (`src/modules/tenancy/bin.command.ts`), the one validator all three
     * write paths call.
     */
    /** Positive whole millimetres, ≤ 100,000 — each axis independent. */
    lengthMm: integer('length_mm'),
    widthMm: integer('width_mm'),
    heightMm: integer('height_mm'),
    /** Positive whole grams, ≤ 100,000,000 (100 tonnes). */
    maxWeightGrams: integer('max_weight_grams'),
    /**
     * Story 12-1 — the bin's storage class (FR-40 / AD-18), from the
     * controlled vocabulary in `src/shared/primitives/storage-class.ts`
     * (STORAGE_CLASSES) — never free text (since story 12-4, `type` beside it
     * is a CHECK-backed vocabulary too). The temperature hierarchy and the
     * exact-match classes live in that file's `storageClassSatisfies`, the ONE
     * predicate every conformance gate imports; the DB backstop is a CHECK
     * declared ONLY in `drizzle/0035_storage_class.sql` (the 0034 pattern —
     * CHECKs live only in migration SQL). Defaults to `ambient` — every
     * pre-12.1 bin reads `ambient` and stays conforming (no backfill; no
     * non-conforming state can pre-exist because the vocabulary is new).
     */
    storageClass: text('storage_class').notNull().default('ambient'),
    /**
     * Story 12-4 — the location type, from the controlled vocabulary in
     * `src/shared/primitives/location-type.ts` (LOCATION_TYPES — the four
     * pre-existing bin types first, then the non-bin location types yard,
     * floor-stack, tank, silo; one table, no fork). No longer free text: the
     * DB backstop is a CHECK declared ONLY in
     * `drizzle/0037_location_type_check.sql` (the 0035 pattern — CHECKs live
     * only in migration SQL); the bulk-asset rule (`tank`/`silo`: single-SKU
     * occupancy, weight-defined capacity, never auto-suggested) lives in that
     * primitive and is imported by every placement gate. All pre-12.4 rows
     * conform with zero data mutation — the old four types come first in the
     * tuple unchanged.
     */
    type: text('type').notNull(),
    blocked: boolean('blocked').notNull().default(false),
    systemOwned: boolean('system_owned').notNull().default(false),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'string' }),
    retiredBy: uuid('retired_by'),
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
    /**
     * Story 21-1 (AD-23) — the client whose goods this SKU is (the SOURCE OF
     * TRUTH: everything referencing a SKU inherits the client for free).
     * NOT NULL with no default — a nullable scoping column is where isolation
     * bugs live. Backfilled to the tenant's `self` client by migration 0040.
     */
    clientId: uuid('client_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    uom: text('uom').notNull(),
    gstRateBps: integer('gst_rate_bps').notNull(),
    hsn: text('hsn'),
    batchTracked: boolean('batch_tracked').notNull().default(false),
    serialTracked: boolean('serial_tracked').notNull().default(false),
    /**
     * Story 10.3 — catch weight: the SKU is handled BY UNIT and priced BY
     * WEIGHT (meat, fish, cheese, produce). A case of beef is quantity `1`
     * weighing 18,400 g; the weight lives on `handling_units`, one row per
     * physical unit, and is NEVER a quantity. The flag gates the receipt
     * prompt, the pack scan and the adjustment refusals, and it rides the
     * device catalog snapshot so a handheld can prompt for weight offline.
     *
     * `catch_weight_tracked` and `serial_tracked` are mutually exclusive
     * (refused at catalog entry): two per-unit identity systems over one
     * physical unit is its own change.
     */
    catchWeightTracked: boolean('catch_weight_tracked').notNull().default(false),
    /**
     * Story 11.2 — the SKU's STATIC physical attributes (FR-36): the catalog
     * weight and dimensions carriers rate and print labels from, and the
     * second hard input behind 4-6d and 11-5's capacity checks. Integer
     * storage, WYSIWYG everywhere — grams and millimetres, the
     * `handling_units.weight_grams` precedent (integer + named cap), no
     * decimals and no conversion layer anywhere; carrier adapters convert at
     * their own edge. All five are nullable and never required at create
     * (creation is import-only with a live corpus of files): a SKU without
     * them is simply unrateable — 4-6d refuses rating for it and names the
     * gap, 11-5 skips its capacity check. No backfill.
     *
     * NOT catch weight (AD-22): `weightGrams` is the static catalog weight for
     * rating; Epic 10's per-handling-unit actual weight stays separate.
     *
     * Bounds are CHECKs declared in `drizzle/0031_sku_physical_attributes.sql`
     * (the 0028 pattern — CHECKs live only in migration SQL) and mirrored in
     * `assertSkuAttributes` (`src/modules/catalog/sku-attributes.ts`), the one
     * validator both the edit command and the import row parser call.
     */
    /** Positive whole grams, ≤ 1,000,000 (1 tonne). */
    weightGrams: integer('weight_grams'),
    /** Positive whole millimetres, ≤ 10,000 — each axis independent. */
    lengthMm: integer('length_mm'),
    widthMm: integer('width_mm'),
    heightMm: integer('height_mm'),
    /** ISO 3166-1 alpha-2, uppercase (`IN`, `CN`). India-only system ≠ India-only origin. */
    countryOfOrigin: text('country_of_origin'),
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    reorderPoint: bigint('reorder_point', { mode: 'number' }).notNull().default(0),
    reorderQty: bigint('reorder_qty', { mode: 'number' }).notNull().default(0),
    barcode: text('barcode').notNull(),
    /**
     * Story 11.3 — the product this SKU is a variant of (AD-19). Nullable: a
     * pre-11.3 row and an import row without the `product` column read null.
     * A bare uuid column with no FK (the repo convention), validated in the
     * command transaction. Attach/detach rides the SKU edit PATCH — no
     * second write path.
     */
    productId: uuid('product_id'),
    /**
     * Story 11.3 — this SKU's values on the product's declared axes, keyed by
     * axis name (e.g. `{"size":"M","colour":"Red"}`). Present iff
     * `product_id` is set — the pairing is a row-local CHECK declared ONLY in
     * `drizzle/0032_product_variants.sql` (the 0031 pattern). The command
     * layer requires the values to cover the product's axes EXACTLY (missing
     * key, unknown key or blank value → 400 naming the axis), and refuses a
     * second SKU in one product carrying identical values (409
     * `duplicate-variant-values`).
     */
    variantValues: jsonb('variant_values').$type<Record<string, string>>(),
    /**
     * Story 12-1 — the SKU's storage class (FR-40 / AD-18), from the
     * controlled vocabulary in `src/shared/primitives/storage-class.ts`
     * (STORAGE_CLASSES). The temperature hierarchy (`storageClassSatisfies`)
     * lives there — the ONE predicate behind putaway placement, suggestion,
     * pick draw, wave/replan allocation and bin merge; the DB backstop is a
     * CHECK declared ONLY in `drizzle/0035_storage_class.sql` (the 0031
     * pattern — CHECKs live only in migration SQL). Defaults to `ambient` —
     * every pre-12.1 SKU reads `ambient` and stays conforming (no backfill;
     * a non-conforming state cannot pre-exist because the vocabulary is new).
     */
    storageClass: text('storage_class').notNull().default('ambient'),
    /**
     * Story 12-2 — the SKU's hazard class (FR-41), nullable: most goods carry
     * none. From the controlled vocabulary in
     * `src/shared/primitives/hazard.ts` (HAZARD_CLASSES); the segregation
     * matrix (`hazardClassesCompatible`) lives there — the ONE predicate
     * behind putaway placement, suggestion, bin merge and the hazard-edit
     * guard. The DB backstop is a CHECK declared ONLY in
     * `drizzle/0036_hazard_class.sql` (the 0031/0035 pattern — CHECKs live
     * only in migration SQL). Nullable with NO default: null = "not
     * hazardous" and carries NO rule in either direction of the matrix —
     * unlike `storage_class` there is no sensible ambient default to
     * backfill.
     */
    hazardClass: text('hazard_class'),
    /**
     * Story 5-3 (FR-cycle-count) — the SKU's ABC classification, nullable:
     * most SKUs start unclassified and null = excluded from SCHEDULED count
     * generation (OQ-1 — it is still countable on demand, and its bin still
     * counts when a classed SKU in it is due). From the controlled vocabulary
     * in `src/shared/primitives/abc-class.ts` (ABC_CLASSES); the DB backstop
     * is a CHECK declared ONLY in `drizzle/0045_cycle_counts.sql` (the
     * 0035/0036 pattern). Set through the catalog import's OPTIONAL
     * `abc_class` column and the SKU edit PATCH — no backfill (a guessed
     * class would silently schedule every legacy SKU for counts).
     */
    abcClass: text('abc_class'),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('skus_tenant_id_code_unique').on(table.tenantId, table.code),
    uniqueIndex('skus_tenant_id_barcode_unique').on(table.tenantId, table.barcode),
    index('skus_created_at_id_idx').on(table.createdAt, table.id),
    index('skus_tenant_id_idx').on(table.tenantId),
    // Story 11.3 — the product list's skuCount and the SKU list's productId
    // filter both resolve through this column (uuid + index, no FK).
    index('skus_product_id_idx').on(table.productId),
    // Story 5-4 — the deferred 5-3 scheduler index (drizzle/0046): the
    // scheduled-count generation's "every classed SKU of the warehouse" probe
    // resolves through (tenant, class) instead of scanning the tenant's SKUs.
    index('skus_tenant_id_abc_class_idx').on(table.tenantId, table.abcClass),
  ],
);

export type Sku = typeof skus.$inferSelect;

/**
 * Product identity (Story 11.3 — AD-19): the grouping layer ABOVE `skus`. A
 * product carries name + declared axes only — no UoM, no tracking flags, no
 * stock concept: the SKU remains every ledger event's unit, and no table
 * below the catalog learns what a variant is. Axes are presentation (an
 * 1–3-entry string array); the attached SKUs' axis values live on
 * `skus.variant_values`, validated against these keys in the command
 * transaction. `product_id` on `skus` is a bare uuid column with no FK (the
 * repo convention), validated in the command transaction. Name is unique per
 * tenant (the `skus.code` precedent). No delete command — append-only.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    /**
     * The declared variant axes (e.g. `["size","colour"]`), 1–3 short names.
     * Immutable while the product has variants attached (409
     * `product-has-variants`) — renaming an axis would silently orphan every
     * attached SKU's values. jsonb + `$type<>` (the `responseSnapshot`
     * precedent); axes are presentation, so a normalized axis table buys
     * nothing no consumer needs.
     */
    axes: jsonb('axes').$type<string[]>().notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('products_tenant_id_name_unique').on(table.tenantId, table.name),
    index('products_created_at_id_idx').on(table.createdAt, table.id),
    index('products_tenant_id_idx').on(table.tenantId),
  ],
);

export type Product = typeof products.$inferSelect;

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
 * Kit compositions (Story 11.4 — FR-38, AD-19): one row per component of one
 * kit SKU. **A kit is a SKU** — the kit-ness of a SKU is the PRESENCE of its
 * composition rows, never a flag (the 11.3 relational-identity precedent); a
 * SKU with rows is a kit, a SKU without them is an ordinary stock SKU. The
 * kit itself never holds, receives or adjusts stock (FR-38: stock is held on
 * the components; `kit-cannot-hold-stock` refuses both +stock writers).
 *
 * `kit_sku_id` / `component_sku_id` are bare uuids with no FK (the repo
 * convention), validated in the command transaction. `qty` is the component
 * quantity **per ONE kit**, in the component SKU's base UoM milli-units (the
 * milli-unit rule; the kit's own `uom_conversions` play no part in the
 * explosion — 1 kit = 1 base-UoM unit of the kit SKU). Flat one level: a
 * component SKU cannot itself be a kit (409 `kit-component-is-kit`, both SKU
 * rows locked `.for('update')` in id order — the concurrent mutual-composition
 * cycle is closed by serialization, not by detection).
 *
 * RLS policy + CHECKs live **only in the migration SQL** (0033).
 */
export const kitCompositions = pgTable(
  'kit_compositions',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    kitSkuId: uuid('kit_sku_id').notNull(),
    componentSkuId: uuid('component_sku_id').notNull(),
    /** Milli-units — the component's base UoM × 10³ (AD-9 as amended by 10.1). */
    qty: bigint('qty', { mode: 'number' }).notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('kit_compositions_kit_component_unique').on(
      table.tenantId,
      table.kitSkuId,
      table.componentSkuId,
    ),
    index('kit_compositions_kit_sku_id_idx').on(table.kitSkuId),
    index('kit_compositions_tenant_id_idx').on(table.tenantId),
  ],
);

export type KitComposition = typeof kitCompositions.$inferSelect;

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
    // Story 6.2 (FR-23): provisioned for the expiry-scan family's expiry-range
    // reads on a tenant's batches. No query today consumes it — the scan's
    // identity read rides the pre-existing tenant/sku index above, and the
    // queue's FEFO expiry sort is done in JS — it ships so a future
    // catalog-side expiry-range read never needs a migration of its own.
    index('batches_tenant_expiry_idx').on(table.tenantId, table.expiryDate),
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
 * Handling units (Story 10.3 — catch weight): ONE row per physical unit of a
 * `catch_weight_tracked` SKU, carrying the weight captured when that unit was
 * received. Catalog-owned like `batches` and `serials`, and created only
 * through `CatalogFacade` (AD-6).
 *
 * **It is a relational satellite record, deliberately NOT a ledger-tracked
 * entity.** `ledger_events` gains no column and no event type for it: hashing
 * a new column would change the canonical bytes of every pre-existing event
 * and break `verifyChain` a second time on top of 0026, and NOT hashing it
 * would leave the field that decides what a customer is invoiced outside the
 * tamper-evident chain. Association rides the `handlingUnitIds` key of the
 * already-hashed `reference_doc` of the existing per-line `pack.packed` event
 * instead, which changes no historical event's bytes.
 *
 * **Why this diverges from `serials`.** A serial earns its location from the
 * ledger because putaway and pick fan OUT one event per serial. Nothing here
 * does, so this row must answer from its own columns what a serial answers
 * from the ledger: `warehouse_id` (pack's cross-warehouse guard), `batch_id`
 * (what makes `catch_weight × batch` genuinely usable rather than nominally
 * allowed) and `status` (the lifecycle that keeps pack from failing open on a
 * written-off case). The accepted, documented cost: **a handling unit has no
 * queryable location between receipt and pack.** Mid-life traceability and
 * move-as-unit are epic 15's problem.
 *
 * `weight_grams` is INTEGER GRAMS — never a milli-unit quantity, never scaled,
 * never near the Valkey ATP path. Weight has no reservation, so the 2⁵³
 * Lua/JS ceiling that forced quantity to milli-units does not bind it.
 *
 * It is **captured once, at receipt, and no code path updates it** — which is
 * a property of the code, pinned by a source scan in
 * `test/architecture.spec.ts`, and NOT a database guarantee: there is no
 * trigger, and the ledger does not cover it either (`grn.received` is an
 * aggregate event carrying neither the ids nor the grams, so an out-of-band
 * UPDATE would leave `verifyChain` green). Say "no writer changes it", not
 * "it cannot change".
 *
 * `status` ∈ `active | pending_approval | rejected | packed` and
 * `weight_grams > 0 AND <= MAX_HANDLING_UNIT_WEIGHT_GRAMS` are CHECKs in the
 * migration DDL (repo convention — never in this file), as is the RLS policy,
 * which is single-dimension on `tenant_id` alone like every other one.
 * `packed_order_line_id` is set ONCE, at pack, by a conditional write on
 * `status = 'active'`.
 */
export const handlingUnits = pgTable(
  'handling_units',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    /** Pack's cross-warehouse 404 guard — deliberately NOT part of the RLS predicate. */
    warehouseId: uuid('warehouse_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** Set when the SKU is batch-tracked — a unit's batch, recoverable from its own row. */
    batchId: uuid('batch_id'),
    /** Provenance: the receipt line that produced this unit. */
    grnLineId: uuid('grn_line_id').notNull(),
    /** Integer GRAMS, captured once at receipt. Immutable. Never a quantity. */
    weightGrams: integer('weight_grams').notNull(),
    status: text('status').notNull().default('active'),
    /** Written once, at pack, by the conditional `status = 'active'` write. */
    packedOrderLineId: uuid('packed_order_line_id'),
    ...tenantTimestamps,
  },
  (table) => [
    index('handling_units_tenant_sku_status_idx').on(table.tenantId, table.skuId, table.status),
    index('handling_units_tenant_grn_line_idx').on(table.tenantId, table.grnLineId),
    index('handling_units_tenant_id_idx').on(table.tenantId),
  ],
);

export type HandlingUnit = typeof handlingUnits.$inferSelect;

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
 * - `sku_id` + `quantity_delta` — the movement: a **signed** integer in
 *   milli-units, base UoM × 10³ (`SignedQuantity`, story 10.1); positive
 *   deltas carry `to_bin_id`, negative
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
    /**
     * Story 21-1 (AD-23) — the client whose movement this event records.
     * NOT NULL — billing aggregates over this table constantly, and the join
     * through `skus` on every metering pass is the one denormalisation worth
     * its cost. Backfilled to the tenant's `self` client by migration 0040.
     * NOT part of the event hash: `event_hash` is unchanged, no re-derivation.
     */
    clientId: uuid('client_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    quantityDelta: bigint('quantity_delta', { mode: 'number' }).notNull(),
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
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
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
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
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
 * Per-bin state epoch (Story 4.3b, AD-14): one opaque, monotonic counter per
 * (tenant, warehouse, bin), bumped inside the ledger fold — in the SAME
 * transaction and under the SAME per-warehouse advisory lock as the movement
 * that changed the bin. A device captures the epoch of a pick task's bin at
 * task start and carries it on the queued op; at replay the server compares
 * it for EQUALITY only and, on a mismatch, classifies the conflict by the
 * AD-14 taxonomy instead of rejecting blindly.
 *
 * The value is opaque: never a quantity, never a timestamp, never a global
 * sequence. Its only contract is "a different value means this bin changed".
 * A bin with no row has never been touched by a movement, and an op naming it
 * is treated as a match (there is nothing it could be stale against).
 *
 * The table is INVENTORY-owned, beside the projections it rides with — a
 * column on the tenancy-owned `bins` would have the inventory ledger writing
 * another module's table, which AD-6 forbids. RLS lives only in the migration
 * SQL (0021, the 0006-0010 pattern); the only write path is
 * `modules/inventory/ledger.service.ts` (the architecture test pins it).
 */
export const binStateEpochs = pgTable(
  'bin_state_epochs',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    binId: uuid('bin_id').notNull(),
    /** Monotonic, opaque; compared only for equality. */
    epoch: bigint('epoch', { mode: 'number' }).notNull().default(1),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('bin_state_epochs_scope_unique').on(table.tenantId, table.warehouseId, table.binId),
  ],
);

export type BinStateEpoch = typeof binStateEpochs.$inferSelect;

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
    /**
     * Story 10.4: bounded passes accumulated since the last FULL pass on this
     * partition. The full pass (`replayInTx`) is the bounded scan's blind-spot
     * escape; the counter, not a wall clock, schedules it — deterministic,
     * per-partition by construction, and testable without a fake clock. A
     * bounded pass (clean or divergent) increments; a full pass resets to 0.
     * An EXISTING checkpoint's cycle state (this column included) is never
     * overwritten by the reconcile failure path; its fresh-row INSERT is the
     * deliberate exception, writing the no-checkpoint default 0.
     */
    incrementalCount: integer('incremental_count').notNull().default(0),
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
 * dimensions; Story 2.4 is out of scope here).
 *
 * Story 7.1 (AD-13) — STANDING holds: a channel Safety Buffer IS a hold row
 * (`owner_type: 'buffer'`, `owner_id: <integration id>`) with NO expiry —
 * `expires_at` is nullable since 0050 and NULL is admitted for `buffer`
 * rows ONLY (the CHECK lives in the migration SQL). The reaper's
 * `expires_at IS NOT NULL` predicate (0009 SQL) skips NULL rows naturally —
 * a standing buffer never expires.
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
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
    state: text('state').notNull().default('held'),
    /**
     * The hold's TTL deadline — null ONLY on story 7.1's standing `buffer`
     * holds (never expires; the reaper skips nulls). CHECK in 0050.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
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
    /**
     * Story 21-1 (AD-23) — the client the inbound document is authored for.
     * NOT NULL with no default; backfilled to the tenant's `self` client by
     * migration 0040.
     */
    clientId: uuid('client_id').notNull(),
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
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    orderedQty: bigint('ordered_qty', { mode: 'number' }).notNull(),
    receivedQty: bigint('received_qty', { mode: 'number' }).notNull().default(0),
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

/**
 * Floor devices (Story 3.2 — tenancy-owned device identity): one row per
 * enrolled scanner/handheld, bound to its tenant and badge-in operator.
 *
 * Lifecycle: a minted one-time enrollment code creates the row **pending
 * redemption** — `label` / `operator_user_id` / `pin_hash` / `enrolled_at`
 * are still null and `enrollment_code_hash` is set. The device app redeems
 * the code (one conditional UPDATE — no double-redeem) to bind label +
 * operator + 4-6 digit badge-in PIN; redemption clears the hash (the raw
 * code's only durable store is the mint response / its idempotency snapshot —
 * sha256-hash stored, the users.invite precedent). Enrolled
 * (`enrollment_code_hash IS NULL`) devices are what the Settings device list
 * shows; `status` flips `active → revoked` on revocation (wipe-flagged, one
 * way — re-revoke is idempotent, never un-revoked).
 *
 * `pin_hash` is the badge-in credential (4-6 digit PIN set during
 * enrollment, human decision 2026-09-09) stored as the `node:crypto` scrypt
 * hash only — account passwords never appear on the device. `last_seen_at`
 * is refreshed by device-authenticated requests (badge-in, self-test echo).
 *
 * RLS policy + status CHECK live **only in the migration SQL** (0012, the
 * 0005→0011 pattern).
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    operatorUserId: uuid('operator_user_id'),
    label: text('label'),
    status: text('status').notNull().default('active'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    revokedBy: uuid('revoked_by'),
    wipeFlag: boolean('wipe_flag').notNull().default(false),
    enrollmentCodeHash: text('enrollment_code_hash'),
    enrollmentCodeExpiresAt: timestamp('enrollment_code_expires_at', { withTimezone: true, mode: 'string' }),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true, mode: 'string' }),
    pinHash: text('pin_hash'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }),
    ...tenantTimestamps,
  },
  (table) => [
    // One unredeemed code per hash — redemption is a conditional UPDATE on
    // this index (no double-redeem race).
    uniqueIndex('devices_enrollment_code_hash_unique')
      .on(table.enrollmentCodeHash)
      .where(sql`enrollment_code_hash is not null`),
    // The Settings device list (keyset cursor, newest first).
    index('devices_created_at_id_idx').on(table.createdAt, table.id),
    // Story 3.2 hand-appended in 0012 (the audit_events tenant-led
    // convention) — recorded here so the next generate run no longer diffs it
    // away (drizzle cannot see migration-time hand-appends in old snapshots).
    index('devices_tenant_id_created_at_id_idx').on(table.tenantId, table.createdAt, table.id),
  ],
);

export type Device = typeof devices.$inferSelect;

/**
 * Goods receipt notes (Story 3.3 — the inbound module's receipt path): one
 * row per GRN, the physical-truth record of a delivery. `code` is
 * **server-assigned**, human-readable and unique per tenant
 * (`GRN-<n>` zero-padded sequence — the receive command allocates it under a
 * tenant advisory lock; the unique index is the backstop). `po_id` is null on
 * a blind receipt, which must carry `blind_reason_code` from the fixed enum
 * (the DB CHECK enforces the pairing both ways); the web Inbound surface
 * flags blind GRNs for PO-matching.
 *
 * `occurred_at` is the **device time** the receipt happened; `recorded_at`
 * the server ingest instant (AD-1 — queued receipts replay later). The
 * recording actor is the badge-in operator (`recorded_by`) on the device
 * (`device_id`); uuid columns, no FKs — asserted in the command transaction.
 *
 * RLS policy + status/blind CHECKs live **only in the migration SQL** (0013,
 * the 0005→0012 pattern).
 */
export const goodsReceiptNotes = pgTable(
  'goods_receipt_notes',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    code: text('code').notNull(),
    poId: uuid('po_id'),
    blindReasonCode: text('blind_reason_code'),
    status: text('status').notNull().default('recorded'),
    deviceId: uuid('device_id').notNull(),
    recordedBy: uuid('recorded_by').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'string' }).notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('goods_receipt_notes_tenant_id_code_unique').on(table.tenantId, table.code),
    // GRN-list keyset pagination (the Inbound surface's list read).
    index('goods_receipt_notes_tenant_created_at_id_idx').on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    index('goods_receipt_notes_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type GoodsReceiptNote = typeof goodsReceiptNotes.$inferSelect;

/**
 * GRN lines (Story 3.3): one row per received (sku, batch) line — **physical
 * truth**: `qty` is everything that physically arrived, `applied_qty` the
 * within-open-quantity portion that applied immediately (ledger +
 * `received_qty`); the difference pends as an `over_receipts` row until the
 * Ops Manager decides. `po_line_id` is null on blind lines; `batch_id` is the
 * catalog-owned batch identity (`batches.id` — created through
 * `CatalogFacade.ensureBatches`, never a direct write; null on non-batch-
 * tracked SKUs). Quantities are positive / non-negative integers in base UoM
 * (DB CHECKs in 0013).
 *
 * RLS policy + quantity CHECKs live **only in the migration SQL** (0013).
 */
export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    grnId: uuid('grn_id').notNull(),
    poLineId: uuid('po_line_id'),
    skuId: uuid('sku_id').notNull(),
    batchId: uuid('batch_id'),
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    qty: bigint('qty', { mode: 'number' }).notNull(),
    appliedQty: bigint('applied_qty', { mode: 'number' }).notNull().default(0),
    ...tenantTimestamps,
  },
  (table) => [
    // One GRN's lines, in receipt order (the detail/summary read).
    index('goods_receipt_lines_grn_id_idx').on(table.grnId, table.createdAt, table.id),
    // Tenant-led list scans (RLS sessions filter tenant_id first).
    index('goods_receipt_lines_tenant_id_idx').on(table.tenantId),
  ],
);

export type GoodsReceiptLine = typeof goodsReceiptLines.$inferSelect;

/**
 * Pending over-receipts (Story 3.3): one row per GRN line whose physically
 * received quantity exceeded the PO line's open quantity — the excess held
 * for Ops Manager (or Owner) approval (FR-8). Applied to inventory ONLY on
 * approval (a `grn.received` ledger event + `received_qty` bump, one
 * transaction); rejection leaves it unapplied and audit-trailed. `status` is
 * `pending → approved | rejected` (conditional UPDATE — a second decision is
 * a deterministic 409).
 *
 * RLS policy + status/quantity CHECKs live **only in the migration SQL** (0013).
 */
export const overReceipts = pgTable(
  'over_receipts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    grnId: uuid('grn_id').notNull(),
    grnLineId: uuid('grn_line_id').notNull(),
    poId: uuid('po_id'),
    poLineId: uuid('po_line_id'),
    skuId: uuid('sku_id').notNull(),
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    excessQty: bigint('excess_qty', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('pending'),
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'string' }).notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
    ...tenantTimestamps,
  },
  (table) => [
    // The Conflicts & Reviews queue read (status filter first).
    index('over_receipts_tenant_status_created_at_id_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index('over_receipts_tenant_created_at_id_idx').on(table.tenantId, table.createdAt, table.id),
  ],
);

export type OverReceipt = typeof overReceipts.$inferSelect;

/**
 * QC holds (Story 3.4): one row per Ops-Manager quarantine decision over a
 * (tenant, warehouse, sku, bin) scope — the decision record (reason, who,
 * when), never a stock write (the stock moves through the ledger: `qc.held`
 * movements into the system QC-hold bin at hold time, `qc.released` back to
 * `bin_id` — the origin captured at hold time, never caller-chosen — at
 * release). `status` is `open → released` (conditional UPDATE — a second
 * decision is a deterministic 409); there is no scrap/reject disposition
 * (a failed inspection keeps the hold open — quantity shrinkage is Epic 5's
 * adjustment path) and no partial release (v1 releases the full held scope).
 *
 * One open hold per scope: the partial unique index is the DB backstop
 * behind the command's 409 `qc-hold-open` (the `inventory_quarantines`
 * pattern).
 *
 * RLS policy + status CHECK live **only in the migration SQL** (0014).
 */
export const qcHolds = pgTable(
  'qc_holds',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** The origin bin — captured at hold time; release returns the stock here. */
    binId: uuid('bin_id').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('open'),
    heldBy: uuid('held_by').notNull(),
    heldAt: timestamp('held_at', { withTimezone: true, mode: 'string' }).notNull(),
    releasedBy: uuid('released_by'),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'string' }),
    ...tenantTimestamps,
  },
  (table) => [
    // One open hold per (tenant, warehouse, sku, bin) scope — the DB backstop
    // (the command's 409 `qc-hold-open` checks first; the index catches races).
    uniqueIndex('qc_holds_open_scope_unique')
      .on(table.tenantId, table.warehouseId, table.skuId, table.binId)
      .where(sql`status = 'open'`),
    // The holds-list read (status filter first).
    index('qc_holds_tenant_status_created_at_id_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index('qc_holds_tenant_created_at_id_idx').on(table.tenantId, table.createdAt, table.id),
  ],
);

export type QcHold = typeof qcHolds.$inferSelect;

/**
 * Putaway placements (Story 3.5): one row per completed placement — the
 * decision record a device operator produced by moving received stock from
 * the system Receiving bin into a storage bin. Never a stock write (the
 * stock moves through the ledger: one `putaway.placed` movement per batch
 * arm — or per serial unit on a serial-tracked SKU — from the Receiving bin
 * to the target bin, same transaction). `suggested_bin_id` carries the
 * server's re-derived suggestion at placement time and `reason_code` the
 * fixed mismatch enum value the operator recorded when the actual bin
 * differed (required in the payload whenever it did — the SM-3
 * suggestion-vs-actual report's raw material).
 *
 * There is no claim/state table: tasks are derived (GRN lines + the
 * Receiving bin's on-hand), placements are the only stored rows.
 *
 * RLS policy + quantity CHECK live **only in the migration SQL** (0015).
 */
export const putawayPlacements = pgTable(
  'putaway_placements',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    grnId: uuid('grn_id').notNull(),
    grnLineId: uuid('grn_line_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** The catalog batch identity — null on non-batch-tracked SKUs. */
    batchId: uuid('batch_id'),
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    qty: bigint('qty', { mode: 'number' }).notNull(),
    /** The system Receiving bin the units left (the from-bin identity). */
    fromBinId: uuid('from_bin_id').notNull(),
    /** The target bin the operator placed into. */
    toBinId: uuid('to_bin_id').notNull(),
    /** The server's re-derived suggestion at placement time; null when no bin fit. */
    suggestedBinId: uuid('suggested_bin_id'),
    /** The fixed mismatch-reason enum value; null when the suggestion was followed. */
    reasonCode: text('reason_code'),
    placedBy: uuid('placed_by').notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true, mode: 'string' }).notNull(),
    deviceId: uuid('device_id').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // The placements-list read (warehouse filter first — the story's
    // `(tenant_id, warehouse_id, created_at, id)` index, 0014 pattern).
    index('putaway_placements_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
    index('putaway_placements_tenant_created_at_id_idx').on(table.tenantId, table.createdAt, table.id),
    // One GRN's placements, in placement order (the detail read).
    index('putaway_placements_grn_id_idx').on(table.grnId, table.createdAt, table.id),
  ],
);

export type PutawayPlacement = typeof putawayPlacements.$inferSelect;

/**
 * Orders (Story 4.1 — the outbound module's first tables): the accepted
 * order aggregate. Warehouse-scoped like the PO tables; `status` is the
 * order state machine the outbound module exclusively owns (AD-6) —
 * additive arms `accepted` / `cancelled` today, picking / packed /
 * dispatched arrive with stories 4.3 / 4.5 / 4.6 (text + hand-appended
 * CHECK per the repo convention, no pgEnum).
 *
 * `source` carries the provenance arm (`manual` | `ingested`); the channel
 * arms (`integration_id`, `external_event_id`) are null on a manual order
 * and required together on an ingested one. Channel-order dedup is a
 * DATABASE-level partial unique index on
 * `(tenant_id, integration_id, external_event_id)` — the same payload
 * delivered twice returns the same order; a divergent payload on the same
 * ref is the command layer's 422 `order-source-conflict` (the index is the
 * race backstop). `source_payload_hash` is the ingested payload's
 * fingerprint the dedup comparison reads.
 *
 * No FKs anywhere (repo convention): `warehouse_id` is asserted in the
 * command transaction. `integration_id` is validated only as a uuid — there
 * is no integrations table until Epic 7 brings the channel adapters, so
 * nothing yet proves the id names a real integration; `external_event_id`
 * is an opaque channel ref, length-bounded and never resolved.
 *
 * RLS policy + status CHECKs live **only in the migration SQL** (0017).
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    /**
     * Story 21-1 (AD-23) — the client the order is for (one order, one
     * client, by definition). NOT NULL with no default; backfilled to the
     * tenant's `self` client by migration 0040.
     */
    clientId: uuid('client_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    status: text('status').notNull().default('accepted'),
    source: text('source').notNull().default('manual'),
    /** Channel arms — null on a manual order (Epic 7's adapters plug in here). */
    integrationId: uuid('integration_id'),
    externalEventId: text('external_event_id'),
    /** The ingested payload's fingerprint; null on a manual order. */
    sourcePayloadHash: text('source_payload_hash'),
    /** Destination address (story 11-1) — required at create, null on pre-11.1 rows. */
    destinationContactName: text('destination_contact_name'),
    destinationPhone: text('destination_phone'),
    destinationLine1: text('destination_line1'),
    destinationLine2: text('destination_line2'),
    destinationCity: text('destination_city'),
    destinationState: text('destination_state'),
    destinationPincode: text('destination_pincode'),
    /**
     * Story 8-1 — the consignee's GSTIN when the buyer is registered
     * (optional; channel/manual orders may carry none). Written by the
     * create command ONLY (no edit command); its first two digits are the
     * place-of-supply code invoicing resolves. Uppercase-normalized.
     */
    consigneeGstin: text('consignee_gstin'),
    ...tenantTimestamps,
  },
  (table) => [
    // The warehouse-scoped list's keyset index from day one (the
    // skus-index lesson — no offset pagination, no late migration).
    index('orders_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
    // Channel-order dedup (AD-5): one order per (tenant, integration,
    // external event id) — partial, so manual orders (null channel arms)
    // never participate.
    uniqueIndex('orders_source_event_unique')
      .on(table.tenantId, table.integrationId, table.externalEventId)
      .where(sql`integration_id is not null and external_event_id is not null`),
  ],
);

export type Order = typeof orders.$inferSelect;

/**
 * Order lines (Story 4.1): the per-line ordered / reserved / shortfall
 * truth of one order. Quantities are **positive integers in base UoM**
 * (`qty` > 0 by the hand-appended CHECK); `reserved_qty` is what acceptance
 * actually holds through the reservation journal (≤ qty, per-line ATP
 * split); the shortfall is derived (`qty − reserved_qty`) at every read —
 * never stored. `reservation_id` is the journal hold the line owns (null
 * on a fully-backordered line — an unavailable line gets no reservation);
 * the live reservation STATE is read through the inventory facade, never
 * copied here. `status` is the line's fulfillment arm (`open` when fully
 * reserved, `backordered` when any part is short — the DB CHECK enforces
 * the set).
 *
 * RLS policy + status/quantity CHECKs live **only in the migration SQL**
 * (0017).
 */
export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    qty: bigint('qty', { mode: 'number' }).notNull(),
    reservedQty: bigint('reserved_qty', { mode: 'number' }).notNull().default(0),
    /** The line's reservation hold (null when nothing could be reserved). */
    reservationId: uuid('reservation_id'),
    /**
     * Story 11.4: the kit line this component line exploded from (null on an
     * ordinary line and on the kit parent itself). Bare uuid, no FK — repo
     * convention; the parent is the kit SKU's order line created in the same
     * transaction. Explosion is point-in-time: a later composition edit never
     * re-explodes an accepted order.
     */
    parentLineId: uuid('parent_line_id'),
    status: text('status').notNull().default('open'),
    /**
     * Story 8-1 — the line's selling rate in integer paise per BASE unit,
     * frozen at order acceptance. Nullable: channel-ingested orders arrive
     * without prices (they park `awaiting-data` at invoicing). Written by
     * the create command ONLY — there is no edit command, and invoicing's
     * override path freezes overrides into the invoice document, never
     * touching this column post-dispatch (Design Notes: rate freeze).
     */
    ratePaise: bigint('rate_paise', { mode: 'number' }),
    ...tenantTimestamps,
  },
  (table) => [
    // The detail read's per-line ordering and any per-order roll-up.
    index('order_lines_order_id_idx').on(table.orderId, table.createdAt, table.id),
    index('order_lines_tenant_id_idx').on(table.tenantId),
    // Story 11.4: a kit line's component children (the parent's roll-up read).
    index('order_lines_parent_line_idx').on(table.parentLineId),
  ],
);

export type OrderLine = typeof orderLines.$inferSelect;

/**
 * Wave policies (Story 4.2 — the outbound module owns its own policy table):
 * the configurable grouping rule a wave is generated under. `grouping`
 * decides the picklist shape (`single` — one picklist per order; `batch` —
 * one picklist across the wave's orders, grouped by bin); `priority` orders
 * competing policies for the human eye (never a scheduler — generation is an
 * operator-triggered command in this story); `max_orders` caps how many
 * accepted orders one wave draws; `cutoff_local_time` (`HH:MM`) gates
 * RELEASE, not generation, and is compared in `Asia/Kolkata` (the module
 * constant `WAVE_CUTOFF_TIMEZONE` — `warehouses` carries no timezone column
 * and the product is India-only).
 *
 * `carrier_ref` is a nullable **unvalidated** uuid — exactly the precedent
 * `orders.integration_id` set in 4.1: there is no `carriers` table until
 * story 4.6 / Epic 7, so nothing yet proves the id names a real carrier.
 *
 * RLS policy + the CHECKs live **only in the migration SQL** (0018).
 */
export const wavePolicies = pgTable(
  'wave_policies',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    name: text('name').notNull(),
    /** `single` (one picklist per order) or `batch` (one across the wave). */
    grouping: text('grouping').notNull().default('single'),
    priority: integer('priority').notNull().default(0),
    /**
     * Cap on the orders one wave draws. Null means the policy names no cap
     * of its own and the module's `DEFAULT_WAVE_MAX_ORDERS` applies — never
     * "uncapped": a wave is a unit of floor work.
     */
    maxOrders: integer('max_orders'),
    /** `HH:MM` in Asia/Kolkata; null = release is always allowed. */
    cutoffLocalTime: text('cutoff_local_time'),
    /** Unvalidated carrier ref (no carriers table until 4.6 / Epic 7). */
    carrierRef: uuid('carrier_ref'),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('wave_policies_warehouse_name_unique').on(
      table.tenantId,
      table.warehouseId,
      table.name,
    ),
    // The warehouse-scoped policy list's keyset index from day one.
    index('wave_policies_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type WavePolicy = typeof wavePolicies.$inferSelect;

/**
 * Waves (Story 4.2): the grouping aggregate — accepted orders gathered by
 * policy into picklists. `status` is the wave state machine the outbound
 * module exclusively owns (AD-6): `planned → released` (the floor's work) or
 * `planned|released → cancelled`. Release is the transition that makes a
 * wave the floor's work; picking itself arrives in 4.3 and writes no stock
 * here.
 *
 * RLS policy + the status CHECK live **only in the migration SQL** (0018).
 */
export const waves = pgTable(
  'waves',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    policyId: uuid('policy_id').notNull(),
    status: text('status').notNull().default('planned'),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'string' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'string' }),
    ...tenantTimestamps,
  },
  (table) => [
    // The warehouse-scoped wave list's keyset index from day one (UX-DR25 —
    // no offset pagination, no late migration).
    index('waves_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
    // Story 4.3: the pick-task read's `released` join arm.
    index('waves_tenant_status_idx').on(table.tenantId, table.status),
  ],
);

export type Wave = typeof waves.$inferSelect;

/**
 * Picklists (Story 4.2): one wave's units of floor work. A `single` wave
 * emits one picklist per order (`order_id` set); a `batch` wave emits ONE
 * picklist across the wave's orders (`order_id` null) whose lines are
 * grouped by bin, so each bin is visited at most once. `status` tracks the
 * wave: `planned → ready` at release, `→ cancelled` when the wave is
 * cancelled (or when release leaves the picklist with nothing to pick).
 *
 * RLS policy + the status CHECK live **only in the migration SQL** (0018).
 */
export const picklists = pgTable(
  'picklists',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    waveId: uuid('wave_id').notNull(),
    /** The single order this picklist serves; null on a batch picklist. */
    orderId: uuid('order_id'),
    status: text('status').notNull().default('planned'),
    ...tenantTimestamps,
  },
  (table) => [
    index('picklists_wave_id_idx').on(table.waveId, table.createdAt, table.id),
    index('picklists_tenant_id_idx').on(table.tenantId),
    // Story 4.3: the device snapshot's pick-task read narrows to the ready
    // picklists of one warehouse before it touches any line — this is its
    // driving index. Without it that read seq-scans every picklist the tenant
    // has ever had, on the one endpoint every device hits on every refresh.
    index('picklists_tenant_warehouse_status_idx').on(
      table.tenantId,
      table.warehouseId,
      table.status,
    ),
  ],
);

export type Picklist = typeof picklists.$inferSelect;

/**
 * Picklist lines (Story 4.2): the ordered pick path. One line is ONE slice
 * of an order line — the units to draw from `bin_id` (and, when the SKU
 * carries batch stock, from `batch_id`). `slice_seq` numbers the slices of
 * one order line (an order line whose reserved quantity spans two bins
 * emits two slices); `walk_seq` is the position on the walk, which is
 * `bins.code` ascending — bins carry no spatial data, and the grid
 * generator's `A-01-01` convention sorts naturally, so code order IS the
 * walk (putaway's capacity-only v1 honesty).
 *
 * `bin_id` / `batch_id` are a **suggestion re-derived at pick time** (4.3),
 * never an allocation: a reservation binds to (tenant, warehouse, sku,
 * owner) and carries no bin, so a bin-level claim here would invent a
 * second, weaker reservation the inventory module knows nothing about.
 *
 * `qty` is always drawn from the order line's `reserved_qty` — never `qty`:
 * a backordered line contributes only what acceptance actually held. A line
 * whose reserved quantity exceeds the pickable on-hand emits one trailing
 * `unfulfillable` slice with `bin_id` null and the uncovered units in
 * `shortfall_qty`.
 *
 * The one-open-wave-per-order invariant is the partial unique index on
 * `(tenant_id, order_line_id, slice_seq) WHERE status <> 'cancelled'`:
 * without it two waves plan the same reserved units and the floor picks the
 * same stock twice (the reservation cannot catch it — both picks draw
 * against the same held quantity). A second wave planning the same order
 * always re-emits `slice_seq` 0 for that order line, so the index refuses
 * it, which is what makes the concurrent-generate race deterministic.
 *
 * RLS policy + the CHECKs live **only in the migration SQL** (0018).
 */
export const picklistLines = pgTable(
  'picklist_lines',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    picklistId: uuid('picklist_id').notNull(),
    waveId: uuid('wave_id').notNull(),
    orderId: uuid('order_id').notNull(),
    orderLineId: uuid('order_line_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** The suggested bin; null on an `unfulfillable` slice. */
    binId: uuid('bin_id'),
    /** The suggested bin's code — the walk key, denormalized for the read. */
    binCode: text('bin_code'),
    /** The suggested batch (FEFO within the bin); null when untracked. */
    batchId: uuid('batch_id'),
    /** The order line's journal hold, carried forward (never re-reserved). */
    reservationId: uuid('reservation_id'),
    /** Units to draw at this bin, in milli-units (0 on an `unfulfillable` slice). */
    qty: bigint('qty', { mode: 'number' }).notNull(),
    /**
     * Uncovered units, in milli-units. Non-zero on an `unfulfillable` slice (nothing
     * pickable was ever found for them) and on a `short` one (story 4.4 —
     * the operator drew fewer units than the stop planned, so
     * `qty - shortfall_qty` is what actually moved).
     */
    shortfallQty: bigint('shortfall_qty', { mode: 'number' }).notNull().default(0),
    /**
     * Story 4.4: why this stop came up short — one of
     * `SHORT_PICK_REASON_CODES`, required on every short pick (including a
     * zero-unit one) and null on every other line. The fixed-enum,
     * nullable-column, command-layer-400 shape is putaway's
     * `PUTAWAY_MISMATCH_REASON_CODES` pattern; the CHECK lives in migration
     * 0022. This column IS the SM-3 slotting/accuracy signal — a queryable
     * durable row, with the dashboard left to story 9.1.
     */
    reasonCode: text('reason_code'),
    /** The order line's slice index (0-based) — the claim key. */
    sliceSeq: integer('slice_seq').notNull(),
    /** Position on the walk (`bins.code` ascending), per picklist. */
    walkSeq: integer('walk_seq').notNull(),
    status: text('status').notNull().default('planned'),
    ...tenantTimestamps,
  },
  (table) => [
    // The picklist detail read: lines in walk order.
    index('picklist_lines_picklist_walk_idx').on(table.picklistId, table.walkSeq, table.id),
    // The eligibility read ("is this order already on an open wave?") and
    // the release-time drop of a cancelled order's lines.
    index('picklist_lines_tenant_order_idx').on(table.tenantId, table.orderId),
    index('picklist_lines_tenant_id_idx').on(table.tenantId),
    // The wave-keyed paths: the detail snapshot's line read, the
    // release-time drop and the cancel-time flip all key on `wave_id`.
    index('picklist_lines_tenant_wave_idx').on(table.tenantId, table.waveId),
    // One order belongs to at most one OPEN wave (the design note): the
    // database refuses the second claim, so the concurrent-generate race is
    // deterministic. A cancelled wave's lines drop out of the predicate and
    // its orders become waveable again.
    uniqueIndex('picklist_lines_open_order_line_unique')
      .on(table.tenantId, table.orderLineId, table.sliceSeq)
      .where(sql`status <> 'cancelled'`),
    // Story 4.3: the device snapshot's pick-task read, exactly. PARTIAL on
    // the predicate (still pickable = a planned line that names a bin) so the
    // index holds only open floor work — it does not grow with picking
    // history — and ordered so it also serves the walk-order sort. The
    // snapshot is the one endpoint the offline substrate's latency depends
    // on, so this read is index-only work, not a scan of every line.
    index('picklist_lines_pickable_walk_idx')
      .on(table.tenantId, table.picklistId, table.walkSeq, table.id)
      .where(sql`status = 'planned' and bin_id is not null`),
  ],
);

export type PicklistLine = typeof picklistLines.$inferSelect;

/**
 * Picks (Story 4.3): the settlement record of one scan-verified pick — one
 * row per picked `picklist_lines` slice, written in the SAME transaction as
 * the `pick.picked` ledger draw and the reservation's `held → committed`
 * settlement. The row records what the operator actually scanned
 * (`bin_id`, and the server's re-derived `batch_id`) against what the plan
 * suggested (`suggested_bin_id` / `suggested_batch_id`) — the pick line's
 * bin and batch are a SUGGESTION re-derived server-side at pick time (the
 * 4.2 decision, the putaway precedent), so a scan against a different bin
 * is checked against live stock, never against the plan.
 *
 * `qty` is always the line's whole planned quantity: full-quantity picks
 * only in this story (short-pick is 4.4), and reservations are
 * whole-quantity rows with no partial commit.
 *
 * One pick per line is the DB backstop (`picks_line_unique`): the line's
 * `planned → picked` flip already serializes the command, but a unique
 * index makes a diverged replay a deterministic loser rather than a second
 * draw.
 *
 * No FKs anywhere (repo convention). RLS policy + CHECKs live **only in the
 * migration SQL** (0019, the 0018 pattern).
 */
export const picks = pgTable(
  'picks',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    waveId: uuid('wave_id').notNull(),
    picklistId: uuid('picklist_id').notNull(),
    picklistLineId: uuid('picklist_line_id').notNull(),
    orderId: uuid('order_id').notNull(),
    orderLineId: uuid('order_line_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** The bin the operator actually scanned (the draw's from-bin). */
    binId: uuid('bin_id').notNull(),
    /** The plan's suggested bin — null when the plan named none. */
    suggestedBinId: uuid('suggested_bin_id'),
    /** The batch re-derived FEFO in the scanned bin; null when untracked. */
    batchId: uuid('batch_id'),
    suggestedBatchId: uuid('suggested_batch_id'),
    /** The order line's journal hold; null when the line carried none. */
    reservationId: uuid('reservation_id'),
    /** True when this pick settled the hold (`held → committed`). */
    reservationCommitted: boolean('reservation_committed').notNull().default(false),
    /**
     * The AD-14 conflict classification this pick settled under (Story
     * 4.3b): `none` when the op carried no bin epoch or the epoch matched,
     * `applied` when the bin's epoch had moved and the draw still stood on
     * its own, `settled` when the moved-on bin still covered the draw and
     * THIS pick settled the order line's hold. The two refusal arms
     * (`pick-bin-short`, `pick-unresolvable`) write nothing, so they never
     * reach a row. The CHECK lives in the migration SQL (0021).
     */
    conflictClass: text('conflict_class').notNull().default('none'),
    /** Milli-units — base UoM × 10³ (AD-9 as amended by story 10.1). */
    qty: bigint('qty', { mode: 'number' }).notNull(),
    pickedBy: uuid('picked_by').notNull(),
    /** Device time (AD-1) — the ledger event's and the row's business time. */
    pickedAt: timestamp('picked_at', { withTimezone: true, mode: 'string' }).notNull(),
    deviceId: uuid('device_id').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // One pick per picklist line — the diverged-replay backstop.
    uniqueIndex('picks_line_unique').on(table.tenantId, table.picklistLineId),
    // The picklist's pick history (the walk's settled stops).
    index('picks_tenant_picklist_idx').on(table.tenantId, table.picklistId),
    // The order's picked units (4.5's pack verification reads them).
    index('picks_tenant_order_idx').on(table.tenantId, table.orderId),
    // The warehouse-scoped keyset list from day one (UX-DR25).
    index('picks_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type Pick = typeof picks.$inferSelect;

/**
 * Tenant carrier credentials (Story 4.6b, AD-15): one row per configured
 * carrier account — the *credential vault* half of the carrier substrate.
 * The adapter registry half (`modules/carriers/carrier-registry.ts`) names
 * which `carrier_code` values exist and what credential fields each one
 * requires; this table holds the material for exactly those carriers.
 *
 * `credential_sealed` is the AES-256-GCM envelope blob
 * (`v1:<iv>:<tag>:<ct>`, the `envelope.ts` KMS stand-in) over the canonical
 * credential JSON, sealed under `CARRIER_ENCRYPTION_KEY` — a key of its own,
 * NOT the device key, so carrier secrets and device offline-store keys have
 * independent blast radii. **The blob never leaves the module**: no response
 * DTO, no list row, no outbox payload, no audit row, no log line carries it
 * or the plaintext (the architecture test pins the confinement).
 *
 * Rotation replaces the material IN PLACE — the row id is the stable handle
 * AD-15 means by "referenced by id" (what rating and 4-6c's labels will
 * store), so a rotation that minted a new id would orphan every reference;
 * `credential_version` increments and `rotated_at`/`rotated_by` stamp the
 * row. Disconnect is a hard DELETE (AD-15: "disconnect deletes") — a status
 * flip would leave sealed secret material at rest after the operator asked
 * for it to be gone; the audit row survives to record it.
 *
 * One active connection per (tenant, carrier), enforced by the unique index
 * rather than a read-then-write: a concurrent double-connect is a
 * deterministic constraint violation mapped to 409, never two live
 * credential rows for one account. RLS and the CHECKs live only in the
 * migration SQL (0025, the 0019/0021 pattern); no FKs (repo convention).
 */
export const carrierConnections = pgTable(
  'carrier_connections',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    /** The registry's adapter code (`delhivery`, `blue_dart`, …). */
    carrierCode: text('carrier_code').notNull(),
    /** The operator's name for this account ("Delhivery — Mumbai"). */
    accountLabel: text('account_label').notNull(),
    /** The sealed envelope blob. Never selected onto any wire shape. */
    credentialSealed: text('credential_sealed').notNull(),
    /** 1 at connect, +1 per rotation — the material's generation counter. */
    credentialVersion: integer('credential_version').notNull().default(1),
    connectedBy: uuid('connected_by').notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true, mode: 'string' }),
    rotatedBy: uuid('rotated_by'),
    ...tenantTimestamps,
  },
  (table) => [
    // One live connection per carrier per tenant — re-configuring is
    // `rotate`, and a second `connect` is a 409 off THIS index.
    uniqueIndex('carrier_connections_tenant_carrier_unique').on(table.tenantId, table.carrierCode),
    // The tenant-first keyset list from day one (UX-DR25 — offset is banned).
    index('carrier_connections_tenant_created_at_id_idx').on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type CarrierConnection = typeof carrierConnections.$inferSelect;

/**
 * Temperature excursions (Story 12-5, FR-44): one row per recorded excursion
 * — an operator-captured °C reading against an origin bin, whose affected
 * (sku, bin) scopes were quarantined AT RECORD TIME through the inbound
 * module's ordinary QC-hold semantics (the `hold_ids` array links this queue
 * item to the holds it caused without compliance ever writing `qc_holds`,
 * which stays inbound-exclusive). The affected-stock truth lives in the
 * ledger (`excursion.recorded` events, AD-11) and in the QC holds; this row
 * is the review queue's data — the reading, the note and the resolve state
 * the Conflicts & Reviews surface (12-7) reads. `resolve` is a review-status
 * flip only: it releases nothing (disposition is `qc.manage`'s).
 *
 * `reading_c` is `numeric(6,2)` — a measurement, deliberately not a scaled
 * integer quantity (°C carries no UoM conversion; the story's Never list
 * keeps unit conversion out). `status` is the two-valued review lifecycle
 * `open | resolved`; RLS policy + the status CHECK live **only in the
 * migration SQL** (0038, the 0008/0011 pattern). No scope uniqueness: one row
 * per excursion, history accumulates.
 *
 * No FKs anywhere (repo convention): `warehouse_id` / `bin_id` /
 * `recorded_by` / `resolved_by` are bare uuids validated in the command
 * transaction. `hold_ids` is a uuid array of QC-hold ids, likewise
 * validated by construction (the ids come back from the hold writes).
 */
export const temperatureExcursions = pgTable(
  'temperature_excursions',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    /** The origin bin the reading was taken against (release-capable holds point back at it). */
    binId: uuid('bin_id').notNull(),
    /** The operator-captured reading, °C, two decimal places (bounds −100..200 at the edge). */
    readingC: numeric('reading_c', { precision: 6, scale: 2 }).notNull(),
    /** The operator's free-text context; null when none was given. */
    note: text('note'),
    /** The QC holds this excursion quarantined its affected scopes with. */
    holdIds: uuid('hold_ids').array().notNull(),
    status: text('status').notNull().default('open'),
    recordedBy: uuid('recorded_by').notNull(),
    /** Business time — when the reading was observed (device clock, AD-1). */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    ...tenantTimestamps,
  },
  (table) => [
    // The excursion list's keyset pagination (created_at + id, standard cursor).
    index('temperature_excursions_tenant_created_at_id_idx').on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    // The review queue's open-first read (12-7) and any status-filtered read.
    index('temperature_excursions_tenant_status_idx').on(table.tenantId, table.status),
  ],
);

export type TemperatureExcursion = typeof temperatureExcursions.$inferSelect;

/**
 * Shipments (Story 4.6c): one label per order — the outbound module's
 * record of the carrier's adapter-issued label. A shipment is created by
 * `createShipmentLabel` (the label command) when a `ready_to_dispatch`
 * order is labelled through a carrier connection: the adapter's
 * deterministic label arm answers a tracking number and a document
 * reference, and THIS row is the only durable record of it (no ledger
 * event — a label is a document, not a quantity movement, AD-1).
 *
 * `status` is the shipment's two-arm lifecycle:
 * - `labelled` — the label exists, dispatch may auto-stamp from it, and
 *   the manifest command may pick it up;
 * - `manifested` — the shipment closed onto a manifest (`manifest_id`
 *   names it); it can no longer be picked up.
 *
 * One `labelled` shipment per order is the DATABASE-level partial unique
 * index on `(tenant_id, order_id) where status = 'labelled'` (the race
 * backstop behind the command's 409); a `manifested` shipment stops
 * participating, and its row persists as the order's shipment record.
 * `carrier_name` is the point-in-time registry display name resolved at
 * label time (the 11-1 destination-address precedent) so dispatch's
 * auto-stamp reads it without a carriers-module dependency.
 *
 * `weight_grams` / the three dimension arms are the label request's
 * optional measurements (same bounds as pack — the pack measurements
 * lived only in the ledger reference doc with no read path; the label is
 * the first consumer that needs them on a row). `label_document_ref` is
 * the adapter's opaque handle for the label document (never the bytes).
 *
 * No FKs anywhere (repo convention): `order_id`, `warehouse_id`,
 * `carrier_connection_id`, `labelled_by`, `manifest_id` are bare uuids
 * validated in the command transaction. RLS policy + the status /
 * bounds / pairing CHECKs live **only in the migration SQL** (0042, the
 * 0025/0017 pattern).
 */
export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    orderId: uuid('order_id').notNull(),
    status: text('status').notNull().default('labelled'),
    /** The connection the label was generated through (the manifest groups by it). */
    carrierConnectionId: uuid('carrier_connection_id').notNull(),
    /** The adapter code at label time (`sandbox`, `delhivery`, …). */
    carrierCode: text('carrier_code').notNull(),
    /** The registry display name resolved at label time (point-in-time, 11-1 precedent). */
    carrierName: text('carrier_name').notNull(),
    /** The adapter-issued tracking number — what dispatch auto-stamps. */
    trackingNumber: text('tracking_number').notNull(),
    /** The adapter's opaque handle for the label document — never the bytes. */
    labelDocumentRef: text('label_document_ref').notNull(),
    /** The label request's optional weight (grams), same bounds as pack. */
    weightGrams: integer('weight_grams'),
    /** The label request's optional dimensions (mm), same bounds as pack. */
    lengthMm: integer('length_mm'),
    widthMm: integer('width_mm'),
    heightMm: integer('height_mm'),
    labelledBy: uuid('labelled_by').notNull(),
    labelledAt: timestamp('labelled_at', { withTimezone: true, mode: 'string' }).notNull(),
    /** Set when the shipment closes onto a manifest (status flips to `manifested`). */
    manifestId: uuid('manifest_id'),
    ...tenantTimestamps,
  },
  (table) => [
    // One LABELLED shipment per order — the race backstop behind the
    // command's already-labelled 409. Partial: a manifested shipment stops
    // participating (its row is the order's shipment record).
    uniqueIndex('shipments_tenant_order_labelled_unique')
      .on(table.tenantId, table.orderId)
      .where(sql`status = 'labelled'`),
    // The warehouse-scoped list's keyset index from day one (UX-DR25).
    index('shipments_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
    // The order's shipment read-back (GET .../orders/{orderId}/shipment).
    index('shipments_order_id_idx').on(table.orderId),
    // One manifest's shipments, in labelled order (the detail read).
    index('shipments_manifest_id_idx').on(table.manifestId),
  ],
);

export type Shipment = typeof shipments.$inferSelect;

/**
 * Manifests (Story 4.6c): the carrier hand-over document — one row per
 * `createManifest`, closing a set of `labelled` shipments (all on the SAME
 * carrier connection, same warehouse) onto the carrier. The manifest row
 * is deliberately thin: the connection it closed shipments for and the
 * count; the shipment rows carry the per-shipment truth and point back
 * here through `manifest_id`. No ledger event (AD-1 — a manifest is a
 * document); the outbox `manifest.created` event is the writeback Epic 7
 * subscribes to. No un-manifest (the spec's Never list): the flip is
 * terminal.
 *
 * No FKs anywhere (repo convention): `warehouse_id` /
 * `carrier_connection_id` / `created_by` are bare uuids validated in the
 * command transaction. RLS policy + the shipment-count CHECK live **only
 * in the migration SQL** (0042).
 */
export const manifests = pgTable(
  'manifests',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    /** The one connection every manifested shipment labelled through. */
    carrierConnectionId: uuid('carrier_connection_id').notNull(),
    /** The adapter code at manifest time (mirrors the connection). */
    carrierCode: text('carrier_code').notNull(),
    /** How many shipments the manifest closed (CHECK: ≥ 1). */
    shipmentCount: integer('shipment_count').notNull(),
    createdBy: uuid('created_by').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // The warehouse-scoped list's keyset index from day one (UX-DR25).
    index('manifests_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type Manifest = typeof manifests.$inferSelect;

/**
 * Transfer orders (Story 5-1, FR-18/FR-29): the two-leg relocation state
 * machine the movements module owns. A transfer moves stock Bin→Bin (same
 * warehouse) or Warehouse→Warehouse as TWO confirmed legs — outbound (source
 * bin → the source warehouse's system IN-TRANSIT bin) and inbound (the
 * in-transit units → the destination bin) — each leg writing its own ledger
 * events correlated by `referenceDoc {kind:'transfer', transferId, lineId?}`.
 * In-transit stock physically parks in the system IN-TRANSIT bin (the
 * QC-hold precedent), so the serial-in-exactly-one-bin invariant survives and
 * the ATP exclusion is one subtraction term (`inTransitUnits`, beside
 * `qcHeldUnits`) — structural, not a new state flag.
 *
 * `status` is the four-valued lifecycle `draft | in_transit | completed |
 * cancelled`: the outbound confirm flips draft→in_transit, the inbound confirm
 * in_transit→completed, and cancel (draft-only — reversing an in-transit
 * transfer is deferred) draft→cancelled. Every non-draft transition is
 * refused with 409 `transfer-wrong-state` by the command; lines and
 * quantities are immutable after create (corrections are new compensating
 * orders). The DB backstop is a CHECK declared ONLY in the migration SQL
 * (0043, the 0038/0025 pattern — CHECKs live only in migration SQL).
 *
 * No FKs anywhere (repo convention): `source_warehouse_id` /
 * `dest_warehouse_id` / `created_by` and the lines' `sku_id` / `from_bin_id` /
 * `to_bin_id` are bare uuids validated in the command transaction. RLS
 * policy + the status CHECK live **only in the migration SQL** (0043).
 */
export const TRANSFER_STATUSES = ['draft', 'in_transit', 'completed', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const transferOrders = pgTable(
  'transfer_orders',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    /** The warehouse the stock leaves (its IN-TRANSIT bin parks the units). */
    sourceWarehouseId: uuid('source_warehouse_id').notNull(),
    /** The warehouse the units land in — MAY equal the source (Bin→Bin). */
    destWarehouseId: uuid('dest_warehouse_id').notNull(),
    status: text('status').notNull().default('draft'),
    /** The creator's free-text context; null when none was given. */
    note: text('note'),
    createdBy: uuid('created_by').notNull(),
    /** When the outbound confirm flipped the order to `in_transit`. */
    outboundConfirmedBy: uuid('outbound_confirmed_by'),
    outboundConfirmedAt: timestamp('outbound_confirmed_at', { withTimezone: true, mode: 'string' }),
    /** When the inbound confirm flipped the order to `completed`. */
    inboundConfirmedBy: uuid('inbound_confirmed_by'),
    inboundConfirmedAt: timestamp('inbound_confirmed_at', { withTimezone: true, mode: 'string' }),
    /** When the cancel flipped the order to `cancelled` (draft-only). */
    cancelledBy: uuid('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'string' }),
    ...tenantTimestamps,
  },
  (table) => [
    // The transfer list's keyset pagination (created_at + id, standard cursor).
    index('transfer_orders_tenant_created_at_id_idx').on(table.tenantId, table.createdAt, table.id),
    // The device snapshot's inbound-task feed: in-transit transfers TO this
    // warehouse.
    index('transfer_orders_dest_warehouse_status_idx').on(
      table.destWarehouseId,
      table.status,
    ),
  ],
);

export type TransferOrder = typeof transferOrders.$inferSelect;

/**
 * One line of a transfer order. `quantity` is milli-units (AD-9 as amended by
 * story 10.1; base units cross the wire, milli lives here and inside the
 * commands). `from_bin_id` is the source-side bin the units draw from;
 * `to_bin_id` is the PLANNED destination bin — at inbound confirm the
 * operator's scanned bin (the mobile op's `destBinId`) is authoritative when
 * carried (the pick precedent — the bin a line names is a suggestion
 * re-derived at confirm time), falling back to this planned bin. `batch_ref`
 * is the catalog `batches.id` when the line moves batch-tracked stock
 * (REQUIRED for a batch-tracked SKU — the batch fold needs the identity);
 * serial-tracked lines carry NO stored serial identity — the serials are
 * scanned at outbound confirm and the inbound leg derives its serial arms
 * from the outbound leg's own events (the qc.released precedent).
 */
export const transferOrderLines = pgTable(
  'transfer_order_lines',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    transferId: uuid('transfer_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** Milli-units — base UoM × 10³ (positive; CHECK in the migration). */
    quantity: bigint('quantity_milli', { mode: 'number' }).notNull(),
    fromBinId: uuid('from_bin_id').notNull(),
    toBinId: uuid('to_bin_id').notNull(),
    /** The catalog batch identity for a batch-tracked line; null otherwise. */
    batchRef: text('batch_ref'),
    note: text('note'),
    ...tenantTimestamps,
  },
  (table) => [
    // The transfer detail's line read and the leg-event correlation
    // (`referenceDoc.lineId` names this id).
    index('transfer_order_lines_transfer_id_idx').on(table.transferId, table.id),
    // The line's SKU read (the gate/guard joins).
    index('transfer_order_lines_sku_id_idx').on(table.skuId),
  ],
);

export type TransferOrderLine = typeof transferOrderLines.$inferSelect;

/**
 * The closed adjustment reason vocabulary (story 5-2): the TS side of the
 * three mirrored layers. The API layer (`inventory.dto.ts` `@IsIn`) and the
 * DB CHECK (`stock_adjustment_pendings_reason_code_check`, migration 0044)
 * both enumerate these values; the tuple itself lives beside the owning
 * module in `src/modules/inventory/adjustment-reason.ts` — the
 * standalone-constant rule (story 11-5) — so the DTO import does not pull
 * the command graph.
 */
export const ADJUSTMENT_PENDING_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type AdjustmentPendingStatus = (typeof ADJUSTMENT_PENDING_STATUSES)[number];

/**
 * Adjustment approval policies (story 5-2, FR-19): the per-tenant threshold
 * that turns an over-threshold `stock.adjust` into a PENDING row instead of
 * a ledger event. Config-not-code (epic-5 technical decisions): the row's
 * existence is the opt-in — **with no policy row the approval flow is
 * disabled** and every adjustment applies immediately (default-on would 202
 * every existing adjustment). One row per tenant (the unique index); a null
 * `quantityThreshold` approves nothing either — the threshold branch treats
 * it exactly like an absent row, so the column is nullable without any
 * "require approval always" reading hiding inside it.
 *
 * The value half of the threshold (a cost ceiling beside the quantity one)
 * is deferred to PENDING.md until cost data exists — quantity-only is the
 * human-approved decision (2026-09-28).
 *
 * The policy write is idempotent (PUT with an Idempotency-Key) and gated on
 * the owner-only `adjustments.approve` capability — the same capability the
 * approve/reject decisions carry. Audit row: `stock_adjustment.policy_updated`.
 *
 * RLS policy + the threshold CHECK live **only in the migration SQL** (0044).
 */
export const stockAdjustmentPolicies = pgTable(
  'stock_adjustment_policies',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    /**
     * The |quantityDelta| ceiling in BASE units above which an adjustment
     * pends for Owner approval (strictly greater pends; at-threshold applies
     * immediately). Null disables the flow — the same semantics as a missing
     * row.
     */
    quantityThreshold: integer('quantity_threshold'),
    ...tenantTimestamps,
  },
  (table) => [
    // One policy per tenant — the config row IS the tenant's opt-in.
    uniqueIndex('stock_adjustment_policies_tenant_id_unique').on(table.tenantId),
  ],
);

export type StockAdjustmentPolicy = typeof stockAdjustmentPolicies.$inferSelect;

/**
 * Pending stock adjustments (story 5-2, FR-19): an over-threshold adjustment
 * parks here instead of writing the ledger — no `stock.adjusted` event, no
 * on-hand/ATP change, no Valkey counter touch — until an
 * `adjustments.approve`-capability holder approves (the stored arms apply as
 * ledger events at decision time) or rejects. `status` is
 * `pending → approved | rejected` (conditional UPDATE — a second decision is
 * a deterministic 409 `adjustment-pending-decided`).
 *
 * The row stores the REQUEST's resolved arms so the approval re-executes
 * them byte-identically to what the same request would have produced
 * immediately: the converted signed `quantity_milli`, the reason/note, the
 * resolved batch identity (or null), the resolved serial/handling-unit id
 * lists (jsonb), and — the review-loop-1 finding — the override draw's
 * `batch_override_reason`, which the approved event's `referenceDoc` must
 * carry or the ledger would hold an override draw whose audit field the
 * immediate path always records. `occurred_at` preserves the REQUEST's
 * business time; the approved events themselves carry the DECISION time as
 * their business time (occurredAt = decision time — the apply runs then).
 * `threshold_quantity_at_request` is the threshold context the approval card
 * renders — frozen at request, so a later policy PUT cannot rewrite what the
 * requester was told.
 *
 * RLS policies + the status/reason/quantity CHECKs live **only in the
 * migration SQL** (0044).
 */
export const stockAdjustmentPendings = pgTable(
  'stock_adjustment_pendings',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    binId: uuid('bin_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** Signed milli-units — the converted delta, frozen at request. */
    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull(),
    /** The closed reason vocabulary (CHECK in the migration). */
    reasonCode: text('reason_code').notNull(),
    note: text('note').notNull(),
    /**
     * The override draw's mandatory FEFO-override reason, restored into the
     * approved event's referenceDoc. Null on every other adjustment — the
     * immediate path 400-requires it exactly on override draws, so its
     * presence here means the approval must carry it.
     */
    batchOverrideReason: text('batch_override_reason'),
    /** The resolved catalog batch identity — null when the request had none. */
    batchId: uuid('batch_id'),
    /** The resolved serial identities, request order; null when absent. */
    serialIds: jsonb('serial_ids').$type<string[]>(),
    /** The named handling units (catch-weight arm), request order; null when absent. */
    handlingUnitIds: jsonb('handling_unit_ids').$type<string[]>(),
    /** The REQUEST's business time — preserved; the apply stamps its own. */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'string' }).notNull(),
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
    /** The policy threshold as it read at request time (base units). */
    thresholdQuantityAtRequest: integer('threshold_quantity_at_request').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // The pending-queue read (status filter first — the over-receipts
    // queue's keyset shape).
    index('stock_adjustment_pendings_tenant_status_created_at_id_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
      table.id,
    ),
  ],
);

export type StockAdjustmentPending = typeof stockAdjustmentPendings.$inferSelect;

/**
 * The count task's lifecycle vocabulary (story 5-3): the TS side of the
 * three mirrored layers (DB CHECK in `drizzle/0045_cycle_counts.sql`, DTO
 * `@IsIn` in `src/modules/movements/count.dto.ts`). A task is `pending`
 * until its submit settles it to `completed` — there is no cancel in 5-3
 * (a stale task is simply submitted or superseded by a recount).
 */
export const COUNT_TASK_STATUSES = ['pending', 'completed'] as const;
export type CountTaskStatus = (typeof COUNT_TASK_STATUSES)[number];

/** How a count task came to exist (CHECK + DTO mirror; story 5-3). */
export const COUNT_TASK_ORIGINS = ['on_demand', 'scheduled', 'recount'] as const;
export type CountTaskOrigin = (typeof COUNT_TASK_ORIGINS)[number];

/**
 * Cycle count policies (story 5-3, FR-cycle-count): per-warehouse scheduling
 * config — one row per (tenant, warehouse, ABC class) naming the count
 * interval in days. Config-not-code (the `stockAdjustmentPolicies`
 * precedent): **with no policy row for a class, that class is never
 * scheduled** — no default interval hides in the worker; a warehouse
 * counts only what someone configured it to count.
 *
 * Upsert is PUT (`/warehouses/:id/count-policies`, idempotent, gated on
 * `counts.manage`): one row per key, a race loser 409s on the unique index.
 * RLS policy + the class/interval CHECKs live **only in the migration SQL**
 * (0045).
 */
export const countPolicies = pgTable(
  'count_policies',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    /** The classed vocabulary ('a'|'b'|'c' — CHECK in the migration). */
    abcClass: text('abc_class').notNull(),
    /** Count every due bin holding a SKU of this class at most this often. */
    intervalDays: integer('interval_days').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // One policy per (tenant, warehouse, class) — the row IS the schedule.
    uniqueIndex('count_policies_tenant_wh_class_unique').on(
      table.tenantId,
      table.warehouseId,
      table.abcClass,
    ),
  ],
);

export type CountPolicy = typeof countPolicies.$inferSelect;

/**
 * Stored count tasks (story 5-3): one task per BIN — the movements module's
 * FIRST STORED TASK TABLE (putaway/transfer tasks are derived on read, but a
 * count task must FREEZE its expected quantities and bin epoch at creation;
 * a derived task would recompute them and break "expected = bin state at
 * count start"). The frozen expectations live on `count_task_lines`; the
 * epoch lives here as a scalar snapshot.
 *
 * `binStateEpoch` is the `bin_state_epochs` value read AT TASK START (the
 * inventory facade's read, under the creation tx's locks); null = the bin
 * had no epoch row yet. At submit it is compared for EQUALITY against the
 * live epoch — `null` matches null only in effect via the `?? null`
 * coalescing both sides share; a mismatch flags the variances
 * (`epoch_conflict`) and auto-creates a fresh recount task (OQ-2). It is an
 * OBSERVATION, not a guard against writes: counting never locks stock, and
 * a movement during the count is flagged, not prevented.
 *
 * `createdBy` is the on-demand creator's user id; **null = the scheduler
 * minted the task** (no system-actor uuid exists in this codebase and the
 * reaper precedent writes no actor column — a nullable column with a
 * documented null meaning is the honest shape). `completedBy`/`completedAt`
 * stamp the submit (null while pending). `status` is
 * `pending → completed` — the submit's conditional UPDATE makes a second
 * submit of the same task by a DIFFERENT key a deterministic 409
 * `count-task-completed` (the same ULID replays from the idempotency key
 * instead).
 *
 * RLS policies + the status/origin/epoch CHECKs live **only in the
 * migration SQL** (0045).
 */
export const countTasks = pgTable(
  'count_tasks',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    binId: uuid('bin_id').notNull(),
    /** The closed lifecycle vocabulary (CHECK in the migration). */
    status: text('status').notNull().default('pending'),
    /** How the task was born (CHECK in the migration). */
    origin: text('origin').notNull(),
    /** The bin state frozen at task start — the submit's equality compare. */
    binStateEpoch: bigint('bin_state_epoch', { mode: 'number' }),
    /** The on-demand creator; null = minted by the scheduler worker. */
    createdBy: uuid('created_by'),
    completedBy: uuid('completed_by'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
    ...tenantTimestamps,
  },
  (table) => [
    // The open-task-per-bin rule's enforcement probe (one pending row max)
    // and the scheduler's due/past-interval filters both resolve through
    // this shape.
    index('count_tasks_tenant_wh_bin_status_idx').on(
      table.tenantId,
      table.warehouseId,
      table.binId,
      table.status,
    ),
    // The device snapshot's count feed: pending tasks for a warehouse.
    index('count_tasks_wh_status_idx').on(table.warehouseId, table.status),
  ],
);

export type CountTask = typeof countTasks.$inferSelect;

/**
 * One (SKU, expected, counted) row of a count task. `expectedQuantity` is
 * the bin's on-hand for the SKU AT TASK START in milli-units (AD-9; base
 * units cross the wire), frozen at creation and never recomputed at submit.
 * `countedQuantity` stays null while uncounted; 0 is a valid count only
 * when EXPLICITLY entered (an absent value refuses the submit — 400
 * `count-incomplete`). A SKU found in the bin beyond the task's lines gets
 * a line APPENDED with `expectedQuantity` 0 at submit time.
 *
 * RLS policy + the quantity CHECKs live **only in the migration SQL** (0045).
 */
export const countTaskLines = pgTable(
  'count_task_lines',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    taskId: uuid('task_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** Milli-units — the bin's on-hand at task start (frozen). */
    expectedQuantity: bigint('expected_quantity_milli', { mode: 'number' }).notNull(),
    /** Milli-units — what the operator counted; null = not yet counted. */
    countedQuantity: bigint('counted_quantity_milli', { mode: 'number' }),
    ...tenantTimestamps,
  },
  (table) => [
    // The task detail's line read and the submit's completeness probe.
    index('count_task_lines_task_id_idx').on(table.taskId, table.skuId),
  ],
);

export type CountTaskLine = typeof countTaskLines.$inferSelect;

/**
 * The count variance lifecycle vocabulary (story 5-4): the TS side of the
 * three mirrored layers (DB CHECK in `drizzle/0046_variance_resolution.sql`;
 * statuses filter via the queue-read DTO). 5-3 wrote exactly `open`; 5-4's
 * resolve command transitions a variance to `adjusted` (approve-adjust — the
 * stock correction applied) or `recounted` (the recount arm — the variance's
 * expected basis replaced by the recount snapshot's line).
 */
export const COUNT_VARIANCE_STATUSES = ['open', 'adjusted', 'recounted'] as const;
export type CountVarianceStatus = (typeof COUNT_VARIANCE_STATUSES)[number];

/**
 * Count variances (story 5-3): written AT SUBMIT, one row per SKU whose
 * counted ≠ expected — never a stock write, never a ledger event (5-3
 * inserts and NEVER touches a variance row afterwards; resolution states
 * are 5-4's vocabulary). `expectedQuantity`/`countedQuantity` are
 * milli-units as frozen/entered; `deltaMilli` is the signed difference
 * (counted − expected). `epochConflict` marks the whole task's baseline as
 * having moved during the count (the epoch compare failed) — every variance
 * row of such a submit carries the flag, and the fresh recount task the
 * same transaction creates is 5-4's re-plan input (AD-14 case-3 shape).
 *
 * `status` is exactly `open` in 5-3 — the single-value vocabulary the
 * module doc names, CHECK-pinned so 5-4's states arrive as their own
 * migration. RLS policies + the CHECKs live **only in the migration SQL**
 * (0045).
 *
 * Story 5-4 additions (all written by the resolution, never by 5-3's
 * insert except the threshold stamp): `thresholdQuantityMilli` is the
 * tenant policy threshold frozen AT SUBMIT (the
 * `threshold_quantity_at_request` precedent — a later policy PUT cannot
 * re-write what the submit compared against; null = the tenant had no
 * threshold policy, the disabled shape); `resolvedBy`/`resolvedAt` stamp
 * the resolution; `recountTaskId` is the recount arm's minted task (bare
 * uuid, no FK — the repo convention, validated in the command
 * transaction); `consideredEventSeqs` is the ledger seq list the
 * resolution states it consulted (jsonb, echoed in the audit + outbox
 * events). Row states, RLS additions and the widened status CHECK live
 * **only in the migration SQL** (0045/0046).
 */
export const countVariances = pgTable(
  'count_variances',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    taskId: uuid('task_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    binId: uuid('bin_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** Milli-units — the task line's frozen expectation. */
    expectedQuantity: bigint('expected_quantity_milli', { mode: 'number' }).notNull(),
    /** Milli-units — what the operator counted. */
    countedQuantity: bigint('counted_quantity_milli', { mode: 'number' }).notNull(),
    /** Signed difference (counted − expected), milli-units. */
    deltaMilli: bigint('delta_milli', { mode: 'number' }).notNull(),
    /** A movement moved the bin between task start and submit (OQ-2). */
    epochConflict: boolean('epoch_conflict').notNull().default(false),
    /** Exactly `open` in 5-3 — 5-4 owns every later state. */
    status: text('status').notNull().default('open'),
    /**
     * Story 5-4 — the tenant threshold policy's value (milli) frozen at
     * submit; null = no policy row (disabled). The resolve command's
     * owner-only guard compares |delta| against THIS frozen value.
     */
    thresholdQuantityMilli: integer('threshold_quantity_milli'),
    /** The resolver's user id (5-4; null while open). */
    resolvedBy: uuid('resolved_by'),
    /** The resolution's instant (5-4; null while open). */
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    /** The recount arm's minted task id (5-4; null on the approve arm). */
    recountTaskId: uuid('recount_task_id'),
    /** The ledger seqs the resolution states it consulted (5-4; null = none stated). */
    consideredEventSeqs: jsonb('considered_event_seqs').$type<number[]>(),
    ...tenantTimestamps,
  },
  (table) => [
    // The variance queue read (5-4's resolution surface; status filter
    // first — the pendings queue's keyset shape).
    index('count_variances_tenant_status_created_at_id_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
      table.id,
    ),
    // The variance list's warehouse filter.
    index('count_variances_warehouse_id_idx').on(table.warehouseId),
    // Story 5-4 (drizzle/0046) — the variances-by-task reads: the
    // resolution surface's task→variance lookups (the submit response's
    // variance card, the replay reads) resolve through the task id.
    index('count_variances_task_id_idx').on(table.taskId),
  ],
);

export type CountVariance = typeof countVariances.$inferSelect;

/**
 * Variance threshold policies (story 5-4): the PER-TENANT config routing a
 * count variance to resolution — `quantityThresholdMilli` (null = disabled,
 * mirroring `stockAdjustmentPolicies`; milli-units so the submit freezes it
 * straight onto every variance row that submits under it). A submit under
 * the policy stamps the value on EVERY variance row it mints; a row whose
 * |delta| exceeds the FROZEN stamp additionally emits the
 * owner-notification outbox event (`count.variance.threshold_exceeded`);
 * such a variance resolves ONLY by owner, every other variance by owner or
 * ops_manager (`variances.resolve`).
 *
 * One row per tenant (`unique(tenant_id)`); upsert is PUT (gated on
 * `variances.resolve` — the pen is the resolver set's, the `counts.manage`
 * rationale); a GET of the unset row answers 404, mirroring
 * adjustment-policies. No delete verb (PUT is upsert). Audit:
 * `count.variance_policy_updated`. RLS policy
 * `count_variance_policies_tenant_isolation` + the threshold CHECK live
 * **only in the migration SQL** (0046).
 */
export const countVariancePolicies = pgTable(
  'count_variance_policies',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    /**
     * The |delta| ceiling in MILLI-units above which a variance is
     * owner-only (strictly greater marks over-threshold; at-threshold does
     * not). Null disables the routing — the same semantics as a missing
     * row.
     */
    quantityThresholdMilli: integer('quantity_threshold_milli'),
    ...tenantTimestamps,
  },
  (table) => [
    // One policy per tenant — the config row IS the tenant's opt-in.
    uniqueIndex('count_variance_policies_tenant_id_unique').on(table.tenantId),
  ],
);

export type CountVariancePolicy = typeof countVariancePolicies.$inferSelect;

/**
 * The AD-14 dropped-op vocabulary (story 5-6): which replay fate a reported
 * row came from — the two terminal fates the outbox walk deletes, retained
 * under story 5-6 instead of vanishing. The mobile
 * `replay-classification` fate map is the client side of this vocabulary;
 * the server consumes refusals, it does not re-classify them (the
 * `classification` rides each uploaded row verbatim).
 */
export const REJECTED_OP_CLASSIFICATIONS = ['rejected', 'quarantined'] as const;
export type RejectedOpClassification = (typeof REJECTED_OP_CLASSIFICATIONS)[number];

/**
 * The rejected-op resolution vocabulary (story 5-6): `open` while the
 * uploaded row awaits review; `applied` (the apply arm — the stored payload
 * re-executed through its own guarded command), `recounted` (the recount
 * arm — a count task minted on the payload's bin via the movement recount
 * core) or `discarded` (the row carried only to the audit trail). The DB
 * CHECK lives **only in the migration SQL** (0047, the 0046 pattern).
 */
export const REJECTED_OP_STATUSES = ['open', 'applied', 'recounted', 'discarded'] as const;
export type RejectedOpStatus = (typeof REJECTED_OP_STATUSES)[number];

/**
 * Rejected sync-report ops (story 5-6, `rejected_ops`): one row per dropped
 * terminal op a device's replay pass reported — the durable end of the
 * mobile `rejected`/AD-14 case-4 `quarantined` fates. Module ownership is
 * **tenancy deliberately** (the spec's Design Notes): the resource is a
 * report of a device sync outcome, op-type-generic across
 * receive/pick/putaway/pack/count/transfer, and tenancy owns the device
 * contract the upload rides.
 *
 * Columns: `deviceId`/`operatorUserId` are the badge-in attribution ids (bare
 * uuid, no FK — the repo convention, scope-validated server-side;
 * `operatorUserId` rides the device session that reported); `opId` is the
 * mobile op's own ULID (text, UNIQUE per tenant — the per-row dedupe key
 * that makes at-least-once uploads safe); `opType` is the mobile OpType;
 * `classification`/`problemCode`/`problemDetail` are the replay refusal
 * verbatim; `payload` is the op's payload as uploaded (the apply arm
 * re-executes it; `binStateEpoch` is stripped at APPLY time, never at store
 * time); `attribution` is the badge-in device name + operator id/email
 * jsonb; `opEnqueuedAt`/`opOccurredAt` are the op's own timestamps; the
 * resolution columns stamp the arm (`resolvedOutcome` is the arm's outcome
 * jsonb — the applied snapshot / minted count task id / the discard note).
 *
 * RLS policy `rejected_ops_tenant_isolation` + the classification/status
 * CHECKs live **only in the migration SQL** (0047). Never uploaded:
 * `self-test.echo` ops (device diagnostics, not reviewable).
 */
export const rejectedOps = pgTable(
  'rejected_ops',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    /** The reporting device's id (badge-in session; bare uuid, no FK). */
    deviceId: uuid('device_id').notNull(),
    /** The attributed operator's user id (badge-in session; bare uuid, no FK). */
    operatorUserId: uuid('operator_user_id').notNull(),
    /** The mobile op's ULID — the (tenant, op_id) dedupe key. */
    opId: text('op_id').notNull(),
    opType: text('op_type').notNull(),
    /** Which replay fate reported it — the upload carries it verbatim. */
    classification: text('classification').notNull(),
    /** The refusal code + server detail, verbatim from the replay. */
    problemCode: text('problem_code').notNull(),
    problemDetail: text('problem_detail'),
    /** The op's payload as uploaded (base units; re-executed by the apply arm). */
    payload: jsonb('payload').notNull(),
    /** Device name + operator id/email + queued-at, the badge-in attribution. */
    attribution: jsonb('attribution').notNull(),
    /** The op's own timestamps from the device. */
    opEnqueuedAt: timestamp('op_enqueued_at', { withTimezone: true, mode: 'string' }).notNull(),
    opOccurredAt: timestamp('op_occurred_at', { withTimezone: true, mode: 'string' }),
    /** Exactly `open` at upload — the resolution arms own every later state. */
    status: text('status').notNull().default('open'),
    /** The resolver's user id (null while open). */
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    /** The arm's outcome (snapshot fragments / minted task id), jsonb. */
    resolvedOutcome: jsonb('resolved_outcome'),
    ...tenantTimestamps,
  },
  (table) => [
    // The per-row dedupe that makes at-least-once uploads safe: a re-posted
    // row updates nothing (the unique pair absorbs the retry).
    uniqueIndex('rejected_ops_tenant_id_op_id_unique').on(table.tenantId, table.opId),
    // The review queue's keyset read (status filter first — the pendings
    // queue's keyset shape).
    index('rejected_ops_tenant_status_created_at_id_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
      table.id,
    ),
  ],
);

export type RejectedOp = typeof rejectedOps.$inferSelect;

/**
 * ── Replenishment module (story 6.1) ──────────────────────────────────────
 *
 * Reorder points, breach alerts, and suggested POs (FR-22). The replenishment
 * module is a CONSUMER of derived state, never a second balance book: breach
 * detection reads ATP through the inventory facade and mints these rows; the
 * real PO is written only by the human-triggered submit riding the inbound
 * PO-creation path.
 *
 * `reorder_policies` — the per-warehouse override on top of the SKU columns'
 * tenant-wide defaults (`skus.reorder_point` / `reorder_qty`, editable in the
 * SKU table; zero there disables breach evaluation unless a policy row
 * overrides the warehouse). Effective point = policy row ?? SKU column.
 *
 * `reorder_breaches` — one alert row per breach EVENT: a re-breach opens a
 * NEW row (the partial unique pins exactly one ACTIVE breach per scope);
 * `point_milli` / `atp_milli` are frozen at detection, so the alert never
 * re-reads stock. The breach instant lives in the shared `created_at`
 * (the event payload and audit trail name it `breachAt`); `status` is the
 * lifecycle `open → recovered | actioned | dismissed` — all three terminal.
 * No event on recovery (a surface-visible state change only).
 *
 * `suggested_pos` — the draft PO artifact: minted exactly when a breach
 * OPENS (`draft` → editable vendor/quantity on the surface), submitted only
 * by the human-triggered submit command (`submitted`, `submitted_po_id`
 * naming the real PO), or dismissed. A standing draft is system-fresh: a
 * later re-breach REPOINTS it (the fresh breach's vendor/quantity replace
 * whatever a planner had left on it). NO FK anywhere (repo convention),
 * scope-validated in the command transaction.
 *
 * The status CHECKs (both vocabularies below), the positive-point CHECKs on
 * the milli columns, and the fail-closed RLS policies live **only in the
 * migration SQL** (0048 — drizzle-kit generate is blind to CHECKs and RLS,
 * and the snapshot records `isRLSEnabled: false`, so the next generate must
 * not re-emit any of them). The partial uniques are drizzle-declared here
 * (the 0009-0011 snapshots record `where` clauses fine); their CHECK
 * companions read columns declared below.
 */
export const REPLENISHMENT_BREACH_STATUSES = ['open', 'recovered', 'actioned', 'dismissed'] as const;
export type ReplenishmentBreachStatus = (typeof REPLENISHMENT_BREACH_STATUSES)[number];

export const SUGGESTED_PO_STATUSES = ['draft', 'submitted', 'dismissed'] as const;
export type SuggestedPoStatus = (typeof SUGGESTED_PO_STATUSES)[number];

export const reorderPolicies = pgTable(
  'reorder_policies',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** Milli-units (AD-9 / 10.1) — strictly positive (CHECK in 0048). */
    reorderPointMilli: bigint('reorder_point_milli', { mode: 'number' }).notNull(),
    reorderQtyMilli: bigint('reorder_qty_milli', { mode: 'number' }).notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // One override per (warehouse, sku); the SKU columns are the fallback.
    uniqueIndex('reorder_policies_tenant_warehouse_sku_unique').on(
      table.tenantId,
      table.warehouseId,
      table.skuId,
    ),
    // The keyset list reads (warehouse-filtered + unfiltered).
    index('reorder_policies_tenant_created_at_id_idx').on(table.tenantId, table.createdAt, table.id),
    index('reorder_policies_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type ReorderPolicy = typeof reorderPolicies.$inferSelect;

export const reorderBreaches = pgTable(
  'reorder_breaches',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** Exactly `open` at detection — the transitions own every later state. */
    status: text('status').notNull().default('open'),
    /** Frozen at detection — the alert never re-reads stock. */
    pointMilli: bigint('point_milli', { mode: 'number' }).notNull(),
    atpMilli: bigint('atp_milli', { mode: 'number' }).notNull(),
    /** The resolver's user id (null while open and on worker recovery). */
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    ...tenantTimestamps,
  },
  (table) => [
    // One ACTIVE breach per (tenant, warehouse, sku): a re-breach opens a NEW
    // row because the unique covers only the open state (the reservations/
    // quarantines open-scope precedent).
    uniqueIndex('reorder_breaches_open_tenant_warehouse_sku_unique')
      .on(table.tenantId, table.warehouseId, table.skuId)
      .where(sql`status = 'open'`),
    // The breach list's keyset read (status filter first — the tabs).
    index('reorder_breaches_tenant_status_created_at_id_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index('reorder_breaches_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type ReorderBreach = typeof reorderBreaches.$inferSelect;

export const suggestedPos = pgTable(
  'suggested_pos',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** The breach whose opening minted the draft (bare uuid, no FK). */
    breachId: uuid('breach_id').notNull(),
    /** Null when the tenant carries no default vendor — submit refuses (400). */
    vendorId: uuid('vendor_id'),
    /** Milli-units — the fillable quantity (default qty or the recovery gap). */
    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull(),
    /** Exactly `draft` at mint — submit/dismiss own every later state. */
    status: text('status').notNull().default('draft'),
    /** The real PO's id once submitted (the inbound path minted it). */
    submittedPoId: uuid('submitted_po_id'),
    ...tenantTimestamps,
  },
  (table) => [
    // One DRAFT per (tenant, warehouse, sku) — the partial unique absorbs the
    // re-breach repoint (the draft is re-pointed, never duplicated).
    uniqueIndex('suggested_pos_draft_tenant_warehouse_sku_unique')
      .on(table.tenantId, table.warehouseId, table.skuId)
      .where(sql`status = 'draft'`),
    // The drafts queue's keyset read (status filter first — the tabs).
    index('suggested_pos_tenant_status_created_at_id_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index('suggested_pos_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type SuggestedPo = typeof suggestedPos.$inferSelect;

/**
 * ── Alert config + batch alerts (story 6.2, FR-23) ────────────────────────
 *
 * The expiry/aging half of the replenishment module: a per-TENANT config row
 * (config-not-code — a tenant with no row has expiry/aging alerting DISABLED;
 * no default lead/threshold days hide in code), driving the scheduler tick's
 * second evaluation (the expiry scan, a sibling of the breach sweep), which
 * opens per-SCOPE batch alerts.
 *
 * `expiry_alert_policies` — one row per tenant (unique `tenant_id`):
 * `expiry_lead_days` — a batch whose `expiry_date` falls within this many
 * days of now (or is already past it) raises an expiry alert while it carries
 * on-hand; `aging_threshold_days` — a batch whose age since INTAKE
 * (`batches.created_at`) reaches this many days raises an aging alert. Both
 * ≥ 0 (CHECK in 0049); no DELETE command — "GET 404 when absent" is the
 * family's existing-shape (absence IS the disable mechanism this side of the
 * API).
 *
 * `batch_alerts` — one row per (tenant, warehouse, sku, batch, kind) alert
 * EVENT-scope: the kind vocabulary `expiry_upcoming | aged` (a batch that
 * triggers both carries TWO rows — the queue filters by kind); at most ONE
 * OPEN row per scope+kind (partial unique, the `reorder_breaches` shape).
 * `age_days` is FROZEN at detection (age moves; the alert records what it
 * saw) and only on `aged` rows; expiry itself is never frozen (the catalog
 * froze dates at intake). Lifecycle `open → resolved` (the batch's on-hand
 * read 0 on a later scan; `resolved_by` null — nobody acted; NO event) |
 * `open → dismissed` (human, `resolved_by/at` stamped). No batch code or
 * expiry column: identity and dates are catalog-owned and read fresh (or
 * joined client-side); the ONLY stock number the queue read carries is the
 * LIVE on-hand stitched in at read time — never a stored one (AD-1).
 *
 * The status/kind CHECKs below, the >= 0 CHECKs on the config ints, and the
 * fail-closed RLS policies live **only in the migration SQL** (0049 — the
 * drizzle-blindness rule; the snapshot records `isRLSEnabled: false`). The
 * partial open-scope unique is drizzle-declared here.
 */
export const BATCH_ALERT_KINDS = ['expiry_upcoming', 'aged'] as const;
export type BatchAlertKind = (typeof BATCH_ALERT_KINDS)[number];

export const BATCH_ALERT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type BatchAlertStatus = (typeof BATCH_ALERT_STATUSES)[number];

/** The config ints' storage bound — int4 (the DTO validates against the same bound). */
export const MAX_ALERT_CONFIG_DAYS = 2147483647;

export const expiryAlertPolicies = pgTable(
  'expiry_alert_policies',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    /** Days of lead time before `batches.expiry_date` an alert opens (≥ 0; CHECK in 0049). */
    expiryLeadDays: integer('expiry_lead_days').notNull(),
    /** Batch age since intake that raises an `aged` alert (≥ 0; CHECK in 0049). */
    agingThresholdDays: integer('aging_threshold_days').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // One config row per tenant — last-write-wins upsert (the variance-policy
    // family's shape).
    uniqueIndex('expiry_alert_policies_tenant_unique').on(table.tenantId),
  ],
);

export type ExpiryAlertPolicy = typeof expiryAlertPolicies.$inferSelect;

export const batchAlerts = pgTable(
  'batch_alerts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    /** Exactly per the detection that opened it — a scope+kind row never re-kinds. */
    kind: text('kind').notNull(),
    /** Exactly `open` at detection — the transitions own every later state. */
    status: text('status').notNull().default('open'),
    /** FROZEN at detection — days since intake, `aged` rows only (null on `expiry_upcoming`). */
    ageDays: integer('age_days'),
    /** The dismisser's user id (null while open and on auto-resolve). */
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    ...tenantTimestamps,
  },
  (table) => [
    // At most ONE OPEN alert per (tenant, warehouse, sku, batch, kind): the
    // partial unique absorbs a racing double-open (the loser's 23505 is
    // swallowed as another tick's already-open verdict — the breach shape).
    uniqueIndex('batch_alerts_open_tenant_warehouse_sku_batch_kind_unique')
      .on(table.tenantId, table.warehouseId, table.skuId, table.batchId, table.kind)
      .where(sql`status = 'open'`),
    // The queue's keyset reads (status filter first — the tabs, then kind).
    index('batch_alerts_tenant_status_created_at_id_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index('batch_alerts_tenant_kind_created_at_id_idx').on(
      table.tenantId,
      table.kind,
      table.createdAt,
      table.id,
    ),
    index('batch_alerts_tenant_warehouse_created_at_id_idx').on(
      table.tenantId,
      table.warehouseId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type BatchAlert = typeof batchAlerts.$inferSelect;

/**
 * ── Channels: integrations, credential vault, mappings, metering ──────────
 * (story 7.1, AD-13/AD-15) — the channels module's spine tables.
 *
 * `integrations` — one connected sales channel per (tenant, provider): the
 * identity 7.2's ingestion references (`orders.source = 'ingested'` carries
 * this row's id), the credential vault row, and the sync-health +
 * circuit-breaker state. No FKs (repo convention); the provider vocabulary
 * is the three frozen channels. `credential_sealed` is the AES-256-GCM
 * envelope blob over the canonical credential JSON, sealed under
 * `CHANNEL_ENCRYPTION_KEY` — a key of its own, independent of
 * `CARRIER_ENCRYPTION_KEY` (independent blast radii, the 4.6b rationale).
 * **The blob never leaves the module** — no response DTO, no list row, no
 * outbox payload, no audit row, no log line carries it or the plaintext.
 * Rotation replaces the material IN PLACE (version bump); disconnect is a
 * hard DELETE (AD-15: "disconnect deletes") and the audit row survives to
 * record it.
 *
 * `channel_mappings` — the SKU binding every sync publishes through and
 * every 7.2 webhook resolves through: one SKU per external ref per
 * connection. Sync publishes ONLY mapped scopes; a connection with no
 * mappings publishes nothing.
 *
 * `integration_calls` — the append-only meter (AD-7 companion): one row per
 * outbound integration call (sync deliveries, revoke attempts). No update or
 * delete command exists for it.
 *
 * The vocabularies' DB-side CHECKs and the fail-closed RLS policies live
 * **only in the migration SQL** (0050, the 0048/0049 pattern — CHECKs and
 * RLS are drizzle-blind); the uniques are drizzle-declared below.
 */
export const CHANNEL_PROVIDERS = ['shopify', 'amazon-in', 'flipkart'] as const;
export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];

export const INTEGRATION_STATUSES = ['connected', 'disconnected'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const INTEGRATION_BREAKER_STATES = ['closed', 'open', 'half-open'] as const;
export type IntegrationBreakerState = (typeof INTEGRATION_BREAKER_STATES)[number];

export const BACKORDER_POLICIES = ['accept', 'reject'] as const;
export type BackorderPolicy = (typeof BACKORDER_POLICIES)[number];

/**
 * The integration-call vocabulary across the module's three delivery
 * families (7.1: `availability-sync` outbound; `credential-revoke` the
 * disconnect attempt). Story 7.2 adds `order-ingest` (the webhook ingest's
 * per-delivery decision rows — see RD-9/meter contract) and
 * `order-writeback` (RD-7), mirroring 0051's widened CHECK.
 */
export const INTEGRATION_CALL_KINDS = [
  'availability-sync',
  'credential-revoke',
  'order-ingest',
  'order-writeback',
] as const;
export type IntegrationCallKind = (typeof INTEGRATION_CALL_KINDS)[number];

/**
 * The call-row status. `ok`/`failed` are the transport verdicts (the sync
 * delivery and the revoke attempt). The ingest/writeback families meter
 * OUTCOME statuses — a refused ingest is a status, never a "failure" (RD-9:
 * refused outcomes never move connection health, the breaker or the sync
 * stamps), mirroring 0051's widened CHECK.
 */
export const INTEGRATION_CALL_STATUSES = [
  'ok',
  'failed',
  // order-ingest outcome statuses (RD-9):
  'accepted',
  'backordered',
  'replayed',
  'rejected',
  'conflict',
  'unmapped',
  'validation-failed',
  'warehouse-unset',
  'config-invalid',
  'verification-failed',
  'actor-unprivileged',
  // availability-sync outcome status (7-2 RD-6, amended: the variant-lookup
  // arm could not resolve every mapped ref — a meted refusal, no breaker):
  'item-unresolved',
  // cancellation-ingest outcome statuses (RD-8):
  'released',
  'ignored',
  'cancellation-unresolved',
] as const;
export type IntegrationCallStatus = (typeof INTEGRATION_CALL_STATUSES)[number];

export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    provider: text('provider').notNull(),
    /** `connected` live; `disconnected` is transitional — disconnect deletes the row. */
    status: text('status').notNull().default('connected'),
    /** The sealed envelope blob. Never selected onto any wire shape. */
    credentialSealed: text('credential_sealed'),
    /** 1 at connect, +1 per rotation — the material's generation counter. */
    credentialVersion: integer('credential_version').notNull().default(1),
    /** Consumed by 7.2's ingestion acceptance (stored now, read then). */
    backorderPolicy: text('backorder_policy').notNull().default('accept'),
    /**
     * Story 7.2 (RD-4): the ONE ingest warehouse every webhook-created order
     * for this connection lands on. Nullable — ingestion refuses its typed
     * `422 ingest-warehouse-unset` until the config PUT sets it. No FK (the
     * repo convention); an ingest naming a since-deleted warehouse refuses
     * `422 ingest-config-invalid` (NACK — remediation is the config PUT).
     */
    ingestWarehouseId: uuid('ingest_warehouse_id'),
    connectedBy: uuid('connected_by').notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true, mode: 'string' }),
    rotatedBy: uuid('rotated_by'),
    // ── sync health + circuit breaker (RN-5) ──
    /** The last successfully DELIVERED availability publication (lag = now − this). */
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'string' }),
    /** The last delivery ATTEMPT, successful or not (health's "last effort"). */
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'string' }),
    /** The last documented delivery failure's reason string (never a secret). */
    lastError: text('last_error'),
    /** Consecutive delivery failures — the breaker's counter (threshold const in the sync worker). */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** The breaker state: `open` refuses sync appends; retry half-opens. */
    breakerState: text('breaker_state').notNull().default('closed'),
    ...tenantTimestamps,
  },
  (table) => [
    // One connection per provider per tenant — re-configuring is `rotate`,
    // and a second `connect` is the 409 off THIS index (the 4.6b shape).
    uniqueIndex('integrations_tenant_provider_unique').on(table.tenantId, table.provider),
    // The module's list read and the sync worker's cross-tenant enumeration
    // (created_at + id, the standard keyset shape).
    index('integrations_tenant_created_at_id_idx').on(table.tenantId, table.createdAt, table.id),
  ],
);

export type Integration = typeof integrations.$inferSelect;

export const channelMappings = pgTable(
  'channel_mappings',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    integrationId: uuid('integration_id').notNull(),
    /** The channel's own external identifier for the SKU (its listing id). */
    externalRef: text('external_ref').notNull(),
    /** The WMS SKU the ref resolves to (validated in the command transaction; the variant IS a SKU row — AD-19). */
    skuId: uuid('sku_id').notNull(),
    /**
     * 7-2 RD-6 (amended): the resolved numeric Shopify inventory_item_id the
     * availability-publish arm last looked the ref up as, cached so a publish
     * cycle does not re-query the variant for every scope. Nullable — set
     * only by the publish arm's resolution write-back; a mapping PUT clears
     * it (a re-mapped ref's cached id belongs to the old ref, never reusable).
     */
    inventoryItemId: bigint('inventory_item_id', { mode: 'number' }),
    ...tenantTimestamps,
  },
  (table) => [
    // One ref per connection (re-mapping a ref repoints the row); 7-2's
    // webhook ingestion resolves its lines through exactly this key.
    uniqueIndex('channel_mappings_integration_ref_unique').on(
      table.tenantId,
      table.integrationId,
      table.externalRef,
    ),
    // The sync's mapped-scope enumeration reads by connection.
    index('channel_mappings_tenant_integration_idx').on(table.tenantId, table.integrationId),
  ],
);

export type ChannelMapping = typeof channelMappings.$inferSelect;

export const integrationCalls = pgTable(
  'integration_calls',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    integrationId: uuid('integration_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    /** Round-trip latency in milliseconds (null when the call never left). */
    latencyMs: integer('latency_ms'),
    /** The documented failure reason (never credential material). */
    error: text('error'),
    at: timestamp('at', { withTimezone: true, mode: 'string' }).notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // The per-tenant integration-call meter's reads filter by integration.
    index('integration_calls_tenant_integration_at_idx').on(
      table.tenantId,
      table.integrationId,
      table.at,
    ),
  ],
);

export type IntegrationCall = typeof integrationCalls.$inferSelect;

/** A connection's standing-buffer buckets, as the list read and the editor carry them. */
export interface ChannelBufferBucket {
  readonly warehouseId: string;
  readonly skuId: string;
  readonly bufferMilli: number;
}

/**
 * Invoice core (Story 8-1 — `src/modules/invoicing/`): ONE invoice per
 * (`tenant_id`, `order_id`), derived from persisted dispatch facts over the
 * outbox `order.dispatched` event (plus the manual generate/regenerate
 * command). The module-exclusive writer is the invoicing module; sibling
 * modules read through its facade. Rows start `awaiting-data` (unpriced
 * lines, unresolvable place of supply) and flip `issued` with an FY-stamped
 * number; `voided` exists in the vocabulary only — the void command is
 * deferred (PENDING).
 *
 * `invoice_no` carries a partial unique (one number per tenant) because
 * `awaiting-data` rows are unnumbered. `origin_gstin`/`consignee_gstin`/
 * `place_of_supply` are SNAPSHOT columns — the parties as they stood at
 * issuance, never re-joined on reads. Money columns are integer paise; the
 * `subtotal + gst = total` CHECK lives in the migration SQL (hand-appended,
 * repo convention). RLS policy also lives only in the migration SQL.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    /** The FY-stamped number, null until first issuance. */
    invoiceNo: text('invoice_no'),
    fyLabel: text('fy_label'),
    seriesSeq: bigint('series_seq', { mode: 'number' }),
    status: text('status').notNull().default('awaiting-data'),
    /** Party snapshots — as they stood at issuance (null while awaiting). */
    originGstin: text('origin_gstin'),
    consigneeGstin: text('consignee_gstin'),
    /** The two-digit state code (or the '99' Other Country arm). */
    placeOfSupply: text('place_of_supply'),
    supplyType: text('supply_type'),
    subtotalPaise: bigint('subtotal_paise', { mode: 'number' }).notNull().default(0),
    gstPaise: bigint('gst_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull().default(0),
    /**
     * Story 8-1b: the rupee-rounded payable (`⌊(total + 50) / 100⌋ × 100`,
     * half-up at 50 paise) and its signed round-off (`payable − total`, in
     * −49…+50). Stored, never re-derived on read — e-way and the GSTR-1
     * invoice value read these. No DEFAULT: every write states them. The
     * rounding CHECKs live in migration 0054.
     */
    payablePaise: bigint('payable_paise', { mode: 'number' }).notNull(),
    roundOffPaise: bigint('round_off_paise', { mode: 'number' }).notNull(),
    /** Bumped only when a regenerate changes the document content. */
    revision: integer('revision').notNull().default(1),
    /** The pinned client-agnostic document snapshot (Design Notes shape). */
    document: jsonb('document').notNull(),
    /**
     * Story 8-2a: the issuance instant — the SAME value as
     * `document.header.issuedAt` (one clock read writes both). NULL while
     * `awaiting-data`; set on every issued/voided row (the two-way CHECK in
     * migration 0055). A READ-MODEL column for the HSN summary's period
     * filter: never on a view, a DTO or the idempotency snapshot.
     */
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }),
    ...tenantTimestamps,
  },
  (table) => [
    // The ONE invoice per dispatched order — the concurrent-race guarantee.
    uniqueIndex('invoices_tenant_order_unique').on(table.tenantId, table.orderId),
    // Story 8-1b: the number is unique per (tenant, supplier GSTIN) once
    // stamped — each GSTIN is its own registrant with its own series, so two
    // same-state GSTINs legitimately print the same `29/2627/000001`.
    uniqueIndex('invoices_tenant_gstin_invoice_no_unique')
      .on(table.tenantId, table.originGstin, table.invoiceNo)
      .where(sql`invoice_no is not null`),
    // The list read's keyset cursor.
    index('invoices_tenant_created_at_id_idx').on(table.tenantId, table.createdAt, table.id),
    // Story 8-2a: the HSN summary's per-(GSTIN, period) scan over issued rows.
    index('invoices_tenant_gstin_issued_at_idx')
      .on(table.tenantId, table.originGstin, table.issuedAt)
      .where(sql`status = 'issued'`),
  ],
);

export type Invoice = typeof invoices.$inferSelect;

/**
 * The priced lines of one invoice. Unpriced lines are NOT rows here — they
 * live only in the document's `gaps` list (a line that has no rate has no
 * tax math to store). `rate_source` says where the rate came from:
 * `order_line` (the frozen `order_lines.rate_paise`) or `manual` (an
 * operator override frozen into the document). `hsn_gap` marks a line that
 * issued with a blank HSN (never blocks issuance).
 */
export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    orderLineId: uuid('order_line_id').notNull(),
    /** Per-line SKU snapshots — the catalog row as it stood at issuance. */
    skuCode: text('sku_code').notNull(),
    skuName: text('sku_name').notNull(),
    hsn: text('hsn'),
    qtyMilli: bigint('qty_milli', { mode: 'number' }).notNull(),
    ratePaise: bigint('rate_paise', { mode: 'number' }).notNull(),
    rateSource: text('rate_source').notNull(),
    taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
    gstBps: integer('gst_bps').notNull(),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull().default(0),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull().default(0),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull().default(0),
    hsnGap: boolean('hsn_gap').notNull().default(false),
    /**
     * Story 8-2a: the SKU's base UoM as it stood at generation (the
     * document line's `uom`). Deliberately NO vocabulary CHECK — a frozen
     * snapshot must survive a later vocabulary change. Read-model only (the
     * HSN summary's UQC grouping): never on a view, a DTO or a snapshot.
     */
    uom: text('uom').notNull(),
    ...tenantTimestamps,
  },
  (table) => [
    // The detail read's per-line ordering.
    index('invoice_lines_tenant_invoice_idx').on(table.tenantId, table.invoiceId),
    // Story 8-2a: one row per order line per invoice — the key 0055's uom
    // backfill joins the document on.
    uniqueIndex('invoice_lines_invoice_order_line_unique').on(table.invoiceId, table.orderLineId),
  ],
);

export type InvoiceLine = typeof invoiceLines.$inferSelect;

/**
 * The FY numbering series: one row per (tenant, supplier GSTIN, financial
 * year) — April 1 – March 31, Asia/Kolkata (story 8-1b: each GSTIN is a
 * separate registrant). `last_seq` allocates under the row's FOR UPDATE lock
 * inside the issuance transaction — the concurrency guarantee behind gap-free
 * numbering. Written by the invoicing command only.
 *
 * `origin_gstin` is NULL only on the legacy 8-1 per-tenant rows (the
 * `FY-2627-000001` format): they are a frozen historical series, kept and
 * never allocated from again (issuance always has a GSTIN — the invoices
 * CHECK makes that structural). The unique is partial over the non-NULL
 * rows, so `ON CONFLICT` must name its predicate to infer it.
 */
export const invoiceSeries = pgTable(
  'invoice_series',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    fyLabel: text('fy_label').notNull(),
    /** The supplier GSTIN this series numbers for; NULL = a legacy 8-1 per-tenant series. */
    originGstin: text('origin_gstin'),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('invoice_series_tenant_gstin_fy_unique')
      .on(table.tenantId, table.originGstin, table.fyLabel)
      .where(sql`origin_gstin is not null`),
  ],
);

export type InvoiceSeries = typeof invoiceSeries.$inferSelect;

/**
 * The CBIC GST state-code list (story 8-1) — the 38 official two-digit
 * state codes (01 Jammu & Kashmir … 37 Andhra Pradesh, 38 Ladakh, 97 Other
 * Territory, 99 Other Country), hand-seeded in migration SQL 0053. A GLOBAL
 * reference table like `app_metadata`: no `tenant_id`, no RLS — the codes
 * are India-wide law, not tenant data.
 */
export const gstStateCodes = pgTable('gst_state_codes', {
  /** The two-digit code itself (the table's natural key). */
  stateCode: text('state_code').primaryKey(),
  stateName: text('state_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export type GstStateCode = typeof gstStateCodes.$inferSelect;

// ── E-way bills (story 8-2b) ─────────────────────────────────────────────────

/**
 * The national e-way threshold (story 8-2b) — CGST Rule 138(1)'s ₹50,000,
 * versioned by `effective_from`. GLOBAL reference data like `gst_state_codes`:
 * no `tenant_id`, no RLS, seeded and guarded read-only in migration 0056.
 * Thresholds are never code literals (AD-9): the one in force on an
 * invoice's IST issue date is read from here.
 */
export const ewayNationalThresholds = pgTable('eway_national_thresholds', {
  effectiveFrom: date('effective_from', { mode: 'string' }).primaryKey(),
  thresholdPaise: bigint('threshold_paise', { mode: 'number' }).notNull(),
  /** The legal source of the figure (e.g. `CGST Rule 138(1)`). */
  source: text('source').notNull(),
});

export type EwayNationalThreshold = typeof ewayNationalThresholds.$inferSelect;

/**
 * A tenant's intra-state threshold override for one state (story 8-2b),
 * APPEND-ONLY: a BEFORE UPDATE trigger raises (0056), and no command
 * deletes. The newest `effective_from` on or before the issue date wins;
 * among same-date rows the newest `created_at` (a correction). A NULL
 * `threshold_paise` means "no e-way bill required" for intra-state supply
 * in that state. CHECKs and RLS live in migration 0056.
 */
export const ewayStateThresholds = pgTable(
  'eway_state_thresholds',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    stateCode: text('state_code').notNull(),
    thresholdPaise: bigint('threshold_paise', { mode: 'number' }),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('eway_state_thresholds_lookup_idx').on(
      table.tenantId,
      table.stateCode,
      table.effectiveFrom.desc(),
      table.createdAt.desc(),
    ),
  ],
);

export type EwayStateThreshold = typeof ewayStateThresholds.$inferSelect;

/**
 * Per supplier GSTIN e-way settings (story 8-2b): today only the
 * "e-invoicing applies" flag, which holds that GSTIN's B2B bills as the
 * computed `needs-irn` blocker (NIC refuses them without an IRN).
 */
export const ewayGstinSettings = pgTable(
  'eway_gstin_settings',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    gstin: text('gstin').notNull(),
    eInvoiceApplies: boolean('e_invoice_applies').notNull().default(false),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('eway_gstin_settings_tenant_gstin_unique').on(table.tenantId, table.gstin)],
);

export type EwayGstinSetting = typeof ewayGstinSettings.$inferSelect;

/**
 * One e-way bill per issued invoice whose consignment value exceeds the
 * threshold in force (story 8-2b). Queued `pending` by the `invoice.issued`
 * delivery; `generated` once an EWB number is recorded (manually, after the
 * NIC bulk upload) or returned by the gateway; `dismissed` with a reason.
 * Part B columns are the transport details finance enters at e-way time.
 * The two-way status CHECKs, the vocabulary CHECKs, the value > threshold
 * CHECK and RLS live in migration 0056. No FKs (house rule).
 */
export const ewayBills = pgTable(
  'eway_bills',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    originGstin: text('origin_gstin').notNull(),
    status: text('status').notNull().default('pending'),
    consignmentValuePaise: bigint('consignment_value_paise', { mode: 'number' }).notNull(),
    thresholdPaise: bigint('threshold_paise', { mode: 'number' }).notNull(),
    thresholdRule: text('threshold_rule').notNull(),
    // Part B (transport) — null until entered.
    transMode: integer('trans_mode'),
    vehicleNo: text('vehicle_no'),
    vehicleType: text('vehicle_type'),
    transporterId: text('transporter_id'),
    transporterName: text('transporter_name'),
    transDocNo: text('trans_doc_no'),
    transDocDate: date('trans_doc_date', { mode: 'string' }),
    distanceKm: integer('distance_km'),
    // The result — set together on `generated`.
    ewbNo: text('ewb_no'),
    ewbGeneratedAt: timestamp('ewb_generated_at', { withTimezone: true, mode: 'string' }),
    ewbValidUntil: timestamp('ewb_valid_until', { withTimezone: true, mode: 'string' }),
    source: text('source'),
    // Tracking.
    gatewayClaimedAt: timestamp('gateway_claimed_at', { withTimezone: true, mode: 'string' }),
    lastExportedAt: timestamp('last_exported_at', { withTimezone: true, mode: 'string' }),
    lastExportedBy: uuid('last_exported_by'),
    dismissedReason: text('dismissed_reason'),
    lastError: text('last_error'),
    ...tenantTimestamps,
  },
  (table) => [
    uniqueIndex('eway_bills_invoice_unique').on(table.invoiceId),
    uniqueIndex('eway_bills_tenant_ewb_no_unique')
      .on(table.tenantId, table.ewbNo)
      .where(sql`ewb_no is not null`),
    index('eway_bills_tenant_status_created_at_id_idx').on(table.tenantId, table.status, table.createdAt, table.id),
  ],
);

export type EwayBill = typeof ewayBills.$inferSelect;
