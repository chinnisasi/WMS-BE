-- ── hand-amended (the 0049/0052 pattern): story 8-1, GST-compliant invoicing ──
-- drizzle-kit generate is blind to CHECKs, RLS policies and seed data — all
-- three are hand-written below (the snapshot records isRLSEnabled: false, a
-- known, documented gap). Migration + journal entry + snapshot are
-- git-added together; `bun run db:generate` after this reports
-- "No schema changes".
--
-- The CBIC seed below carries the OFFICIAL 38-entry state-code list (26 is
-- Dadra & Nagar Haveli and Daman & Diu, 37 Andhra Pradesh, 38 Ladakh, 97
-- Other Territory, 99 Other Country). The spec's parenthetical example
-- ("26-Ladakh, 38-Other-Territory") transposed them — the official
-- CBIC/e-way-bill list wins; recorded in the spec's Implementation Notes.

DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'invoice_series') <> 0 THEN
		RAISE EXCEPTION 'migration 0053 has already been applied: invoice_series already exists. Re-running would half-land.';
	END IF;
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'orders') = 0 THEN
		RAISE EXCEPTION 'migration 0053 is out of order: the orders table does not exist — 0017 must be applied first.';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "gst_state_codes" (
	"state_code" text PRIMARY KEY NOT NULL,
	"state_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"sku_code" text NOT NULL,
	"sku_name" text NOT NULL,
	"hsn" text,
	"qty_milli" bigint NOT NULL,
	"rate_paise" bigint NOT NULL,
	"rate_source" text NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"gst_bps" integer NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"hsn_gap" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"fy_label" text NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"invoice_no" text,
	"fy_label" text,
	"series_seq" bigint,
	"status" text DEFAULT 'awaiting-data' NOT NULL,
	"origin_gstin" text,
	"consignee_gstin" text,
	"place_of_supply" text,
	"supply_type" text,
	"subtotal_paise" bigint DEFAULT 0 NOT NULL,
	"gst_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "rate_paise" bigint;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "consignee_gstin" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "gstin" text;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "gstin" text;--> statement-breakpoint
CREATE INDEX "invoice_lines_tenant_invoice_idx" ON "invoice_lines" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_series_tenant_fy_unique" ON "invoice_series" USING btree ("tenant_id","fy_label");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_order_unique" ON "invoices" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_invoice_no_unique" ON "invoices" USING btree ("tenant_id","invoice_no") WHERE invoice_no is not null;--> statement-breakpoint
CREATE INDEX "invoices_tenant_created_at_id_idx" ON "invoices" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
-- ── hand-amended: the vocabulary/CHECK set (drizzle-kit is blind to these) ──
-- The invoices status vocabulary mirrors the TS `INVOICE_STATUSES` tuple; the
-- two-sum CHECK pins FR-26's exact reconciliation at the storage layer, not
-- just in arith.ts.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_status_check" CHECK ("status" IN ('awaiting-data', 'issued', 'voided'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_supply_type_check" CHECK ("supply_type" IN ('intra', 'inter'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_totals_balance_check" CHECK ("subtotal_paise" + "gst_paise" = "total_paise");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_money_non_negative_check" CHECK ("subtotal_paise" >= 0 AND "gst_paise" >= 0 AND "total_paise" >= 0);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_gstin_shape_check" CHECK (("origin_gstin" IS NULL OR "origin_gstin" ~ '^[0-9]{2}[A-Za-z0-9]{13}$') AND ("consignee_gstin" IS NULL OR "consignee_gstin" ~ '^[0-9]{2}[A-Za-z0-9]{13}$'));--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_rate_source_check" CHECK ("rate_source" IN ('order_line', 'manual'));--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_gst_bps_check" CHECK ("gst_bps" >= 0 AND "gst_bps" <= 10000);--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_money_non_negative_check" CHECK ("taxable_paise" >= 0 AND "cgst_paise" >= 0 AND "sgst_paise" >= 0 AND "igst_paise" >= 0);--> statement-breakpoint
ALTER TABLE "invoice_series" ADD CONSTRAINT "invoice_series_last_seq_check" CHECK ("last_seq" >= 0);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_gstin_shape_check" CHECK ("gstin" IS NULL OR "gstin" ~ '^[0-9]{2}[A-Za-z0-9]{13}$');--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_gstin_shape_check" CHECK ("gstin" IS NULL OR "gstin" ~ '^[0-9]{2}[A-Za-z0-9]{13}$');--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_consignee_gstin_shape_check" CHECK ("consignee_gstin" IS NULL OR "consignee_gstin" ~ '^[0-9]{2}[A-Za-z0-9]{13}$');--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_rate_paise_check" CHECK ("rate_paise" IS NULL OR "rate_paise" >= 0);--> statement-breakpoint
-- ── hand-amended: RLS — tenant-scoped tables only (the uniform policy) ──
-- RLS lives ONLY in migration SQL (the schema-file convention). The three
-- tenant-scoped tables get the standard single-dimension policy; the global
-- `gst_state_codes` reference table does not (like `app_metadata` — India-wide
-- law, not tenant data). Fail-closed: an unset `app.tenant_id` binds nothing.
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "invoices_tenant_isolation" ON "invoices"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "invoice_lines_tenant_isolation" ON "invoice_lines"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "invoice_series_tenant_isolation" ON "invoice_series"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- ── hand-amended: the CBIC GST state-code seed — EXACTLY 38 rows ──
-- The official two-digit state codes (the list on the e-way-bill API docs
-- portal). Hand-seeded, ON CONFLICT DO NOTHING (idempotent); the count is
-- pinned by test/invoicing.spec.ts's seed proof. Codes 25 and 28 are
-- deliberately absent — they named Daman & Diu / Dadra & Nagar Haveli
-- separately before the 2020 merger, which is now code 26.
INSERT INTO "gst_state_codes" ("state_code", "state_name") VALUES
	('01', 'Jammu and Kashmir'),
	('02', 'Himachal Pradesh'),
	('03', 'Punjab'),
	('04', 'Chandigarh'),
	('05', 'Uttarakhand'),
	('06', 'Haryana'),
	('07', 'Delhi'),
	('08', 'Rajasthan'),
	('09', 'Uttar Pradesh'),
	('10', 'Bihar'),
	('11', 'Sikkim'),
	('12', 'Arunachal Pradesh'),
	('13', 'Nagaland'),
	('14', 'Manipur'),
	('15', 'Mizoram'),
	('16', 'Tripura'),
	('17', 'Meghalaya'),
	('18', 'Assam'),
	('19', 'West Bengal'),
	('20', 'Jharkhand'),
	('21', 'Odisha'),
	('22', 'Chhattisgarh'),
	('23', 'Madhya Pradesh'),
	('24', 'Gujarat'),
	('26', 'Dadra and Nagar Haveli and Daman and Diu'),
	('27', 'Maharashtra'),
	('29', 'Karnataka'),
	('30', 'Goa'),
	('31', 'Lakshadweep'),
	('32', 'Kerala'),
	('33', 'Tamil Nadu'),
	('34', 'Puducherry'),
	('35', 'Andaman and Nicobar Islands'),
	('36', 'Telangana'),
	('37', 'Andhra Pradesh'),
	('38', 'Ladakh'),
	('97', 'Other Territory'),
	('99', 'Other Country')
ON CONFLICT ("state_code") DO NOTHING;--> statement-breakpoint
-- (no data statements follow — the owned columns are additive-nullable, so
-- existing tenants/orders/lines are untouched: pre-8-1 orders simply carry
-- null rates/GSTINs and receive invoices only through the manual path)
