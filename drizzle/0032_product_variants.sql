-- Story 11.3 — PRODUCT VARIANTS (FR-37, AD-19): the grouping layer ABOVE skus.
--
-- SKUs are a flat list: a size×colour range renders as N unrelated rows, and
-- Epic 7's Shopify product→variant mapping is lossy by construction. A
-- `products` table carrying IDENTITY ONLY (name + declared axes) closes it:
-- `skus` gains a nullable `product_id` (a bare uuid column, no FK — the repo
-- convention, validated in the command transaction) and a nullable
-- `variant_values` jsonb object keyed by the product's declared axes.
--
-- AD-19 HELD EXACTLY: `products` carries no UoM, no tracking flags, no stock
-- concept — a SKU remains every ledger event's unit. NOTHING below the
-- catalog learns what a variant is: no ledger change, no reservation change,
-- no table below the catalog touched. Axes are presentation — a normalized
-- axis table would buy nothing no consumer needs (the 11-6 matrix, the 11-7
-- announcement and Epic 7's mapping all read the whole object).
--
-- THE PAIRING CHECK IS ROW-LOCAL, MIGRATION-SQL-ONLY (the 0031 pattern —
-- drizzle-orm 0.45 can model neither a CHECK nor an RLS policy, and a copy in
-- `schema.ts` would make every future `db:generate` emit conflicting DDL):
-- `variant_values` is an object iff `product_id` is set. The command layer
-- enforces the stronger rules (values cover the product's axes EXACTLY; no
-- two SKUs in one product carrying identical values) in its transaction; the
-- CHECK is the backstop that keeps a detached row from carrying orphaned
-- values by any path, including a future one.
--
-- ADDITIVE ONLY: one CREATE TABLE, two ADD COLUMNs, indexes. No data
-- statement, nothing to back-fill — every pre-11.3 SKU reads
-- `product_id = NULL`, `variant_values = NULL`, and every pre-11.3 code path
-- behaves exactly as it did. The appended CONSTRAINT/POLICY are NOT hand
-- re-runnable, and none of this needs to be: the drizzle journal is the
-- re-run guard — each statement is applied exactly once (the 0028/0031
-- pattern).

CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"axes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "variant_values" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_id_name_unique" ON "products" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "products_created_at_id_idx" ON "products" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "products_tenant_id_idx" ON "products" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "skus_product_id_idx" ON "skus" USING btree ("product_id");--> statement-breakpoint
-- ── hand-appended: RLS + the pairing CHECK (the 0028/0031 pattern) ─────────
-- The same fail-closed SINGLE-DIMENSION tenant_isolation policy every
-- tenant-scoped table carries. The `NULLIF(current_setting(..., true), '')`
-- guard is load-bearing: Postgres returns '' once a transaction-local setting
-- expires, so an un-scoped session sees ZERO rows rather than erroring.
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "products_tenant_isolation" ON "products"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- `variant_values` is an object iff `product_id` is set. Both nullable — an
-- unattached SKU (every pre-11.3 row, every import row without the
-- `product` column) is legal and must stay storable.
ALTER TABLE "skus" ADD CONSTRAINT "skus_variant_values_pairing"
	CHECK (
		("product_id" IS NULL AND "variant_values" IS NULL)
		OR (
			"product_id" IS NOT NULL
			AND "variant_values" IS NOT NULL
			AND jsonb_typeof("variant_values") = 'object'
		)
	);
