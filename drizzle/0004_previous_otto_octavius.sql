CREATE TABLE "catalog_import_errors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"sku_code" text,
	"reason_code" text NOT NULL,
	"reason_detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"committed_rows" integer NOT NULL,
	"failed_rows" integer NOT NULL,
	"skipped_rows" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"uom" text NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"hsn" text,
	"batch_tracked" boolean DEFAULT false NOT NULL,
	"serial_tracked" boolean DEFAULT false NOT NULL,
	"reorder_point" integer DEFAULT 0 NOT NULL,
	"reorder_qty" integer DEFAULT 0 NOT NULL,
	"barcode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uom_conversions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"uom" text NOT NULL,
	"factor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "catalog_import_errors_import_id_idx" ON "catalog_import_errors" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "catalog_import_errors_tenant_id_idx" ON "catalog_import_errors" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "catalog_imports_tenant_id_created_at_id_idx" ON "catalog_imports" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "skus_tenant_id_code_unique" ON "skus" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "skus_tenant_id_barcode_unique" ON "skus" USING btree ("tenant_id","barcode");--> statement-breakpoint
CREATE INDEX "skus_created_at_id_idx" ON "skus" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "skus_tenant_id_idx" ON "skus" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uom_conversions_sku_id_uom_unique" ON "uom_conversions" USING btree ("sku_id","uom");--> statement-breakpoint
CREATE INDEX "uom_conversions_tenant_id_idx" ON "uom_conversions" USING btree ("tenant_id");
-- AD-3 defense-in-depth (Story 1.4): RLS on the four new catalog tables, the
-- same fail-closed single-dimension policy as 0001/0003 (`tenant_isolation`).
-- SKU ownership is app-layer (`sku_id` lookups scoped by tenant inside the
-- command transaction); the RLS session state carries only `app.tenant_id`.
-- The `current_setting(..., true)` empty-string NULLIF guard is load-bearing
-- (Postgres 18 returns '' after a transaction-local value expires) so an
-- un-scoped session fails closed (sees zero rows) instead of erroring.
ALTER TABLE "skus" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "uom_conversions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_imports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_import_errors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "skus_tenant_isolation" ON "skus"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "uom_conversions_tenant_isolation" ON "uom_conversions"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "catalog_imports_tenant_isolation" ON "catalog_imports"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "catalog_import_errors_tenant_isolation" ON "catalog_import_errors"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);