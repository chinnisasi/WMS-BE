-- Story 11.4 — KIT COMPOSITIONS (FR-38, AD-19): a kit is a SKU whose BOM is
-- flat and whose stock is its components'.
--
-- FR-38: kits and bundles are composed of component SKUs; stock is held on
-- the components and a kit allocates by exploding its BOM at order
-- acceptance — a kit is never counted as independent stock. The model is
-- ONE table plus ONE column:
--
--   kit_compositions  — one row per component: `kit_sku_id` (the kit SKU),
--                       `component_sku_id`, `qty` per ONE kit (the
--                       component's base-UoM milli-units).
--   order_lines.parent_line_id — the kit line a component child exploded
--                       from at acceptance (nullable; null on every
--                       pre-11.4 row and on ordinary lines).
--
-- AD-19 HELD EXACTLY, as in 11.3: a kit IS a SKU. Kit-ness is the PRESENCE
-- of composition rows, never a flag (a `skus.is_kit` boolean is a second
-- source of truth that can drift from the rows — the 11-3 relational-identity
-- precedent). NOTHING below the catalog learns what a kit is: the explosion
-- writes ordinary `order_lines` rows holding ordinary `reservations`, so
-- waves, picklists, picks, pack and dispatch work on the children unchanged.
--
-- THE GUARDS ARE MIGRATION-SQL-ONLY (the 0031/0032 pattern — drizzle-orm 0.45
-- can model neither a CHECK nor an RLS policy, and a copy in `schema.ts`
-- would make every future `db:generate` emit conflicting DDL):
--   kit_compositions_qty_positive — a zero/negative component quantity is
--     no composition; the command refuses first, this is the backstop.
--   kit_compositions_no_self — row-local `kit_sku_id <> component_sku_id`;
--     the command's `kit-self-reference` 400 is the first line of defence.
-- The STRONGER rule (a component SKU cannot itself be a kit — flat BOM, no
-- recursion) is cross-row and lives in the command transaction: both SKU
-- rows are locked `.for('update')` in id order, which is what closes the
-- concurrent mutual-composition cycle (A∋B, B∋A) — the loser re-reads
-- committed state and refuses 409 `kit-component-is-kit`.
--
-- ADDITIVE ONLY: one CREATE TABLE, one ADD COLUMN, indexes. No data
-- statement, nothing to back-fill — every pre-11.4 order line reads
-- `parent_line_id = NULL` and behaves exactly as it did. The appended
-- CONSTRAINT/POLICY are NOT hand re-runnable, and none of this needs to
-- be: the drizzle journal is the re-run guard — each statement is applied
-- exactly once (the 0028/0031/0032 pattern).

CREATE TABLE "kit_compositions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kit_sku_id" uuid NOT NULL,
	"component_sku_id" uuid NOT NULL,
	"qty" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "parent_line_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "kit_compositions_kit_component_unique" ON "kit_compositions" USING btree ("tenant_id","kit_sku_id","component_sku_id");--> statement-breakpoint
CREATE INDEX "kit_compositions_kit_sku_id_idx" ON "kit_compositions" USING btree ("kit_sku_id");--> statement-breakpoint
CREATE INDEX "kit_compositions_tenant_id_idx" ON "kit_compositions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "order_lines_parent_line_idx" ON "order_lines" USING btree ("parent_line_id");--> statement-breakpoint
-- ── hand-appended: RLS + the row-local CHECKs (the 0028/0031/0032 pattern) ─
-- The same fail-closed SINGLE-DIMENSION tenant_isolation policy every
-- tenant-scoped table carries. The `NULLIF(current_setting(..., true), '')`
-- guard is load-bearing: Postgres returns '' once a transaction-local setting
-- expires, so an un-scoped session sees ZERO rows rather than erroring.
ALTER TABLE "kit_compositions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "kit_compositions_tenant_isolation" ON "kit_compositions"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- A component quantity must be positive. The command enforces the bound (and
-- the milli-unit precision of the component's UoM); this is the backstop for
-- any path that never met the command.
ALTER TABLE "kit_compositions" ADD CONSTRAINT "kit_compositions_qty_positive"
	CHECK ("qty" > 0);--> statement-breakpoint

-- A kit cannot compose itself. Row-local, so it holds by any path including
-- a future one; the command's `kit-self-reference` names the same fact 400.
ALTER TABLE "kit_compositions" ADD CONSTRAINT "kit_compositions_no_self"
	CHECK ("kit_sku_id" <> "component_sku_id");