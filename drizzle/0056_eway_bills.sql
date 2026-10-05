-- ── hand-amended (the 0053 pattern): story 8-2b, e-way bills ──
-- Four tables, NO foreign keys (house rule — uuid columns validated in the
-- command transaction):
--   eway_national_thresholds — GLOBAL, read-only reference data (no RLS, the
--     gst_state_codes precedent): the ₹50,000 national rule, CGST Rule 138(1),
--     seeded below. A trigger refuses UPDATE and DELETE.
--   eway_state_thresholds    — per-tenant intra-state overrides, APPEND-ONLY
--     (a BEFORE UPDATE trigger raises; deletes are tenant teardown only).
--   eway_gstin_settings      — the per-GSTIN "e-invoicing applies" flag.
--   eway_bills               — one row per issued invoice that needs an EWB.
--
-- drizzle-kit is blind to CHECKs, RLS, triggers and seed data — all four are
-- hand-written below. The journal entry and snapshot are git-added with this
-- file, and `bun run db:generate` afterwards reports "No schema changes".
--
-- No backfill: invoices issued before this deploy get no row (their
-- `invoice.issued` messages already drained). Messages still in the outbox
-- at deploy are consumed by the new subscriber.

DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'eway_bills') <> 0 THEN
		RAISE EXCEPTION 'migration 0056 has already been applied: eway_bills already exists.';
	END IF;
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'invoices' AND column_name = 'issued_at') = 0 THEN
		RAISE EXCEPTION 'migration 0056 is out of order: invoices.issued_at does not exist — 0055 must be applied first.';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "eway_bills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"origin_gstin" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"consignment_value_paise" bigint NOT NULL,
	"threshold_paise" bigint NOT NULL,
	"threshold_rule" text NOT NULL,
	"trans_mode" integer,
	"vehicle_no" text,
	"vehicle_type" text,
	"transporter_id" text,
	"transporter_name" text,
	"trans_doc_no" text,
	"trans_doc_date" date,
	"distance_km" integer,
	"ewb_no" text,
	"ewb_generated_at" timestamp with time zone,
	"ewb_valid_until" timestamp with time zone,
	"source" text,
	"gateway_claimed_at" timestamp with time zone,
	"last_exported_at" timestamp with time zone,
	"last_exported_by" uuid,
	"dismissed_reason" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eway_gstin_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"gstin" text NOT NULL,
	"e_invoice_applies" boolean DEFAULT false NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eway_national_thresholds" (
	"effective_from" date PRIMARY KEY NOT NULL,
	"threshold_paise" bigint NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eway_state_thresholds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"state_code" text NOT NULL,
	"threshold_paise" bigint,
	"effective_from" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "eway_bills_invoice_unique" ON "eway_bills" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eway_bills_tenant_ewb_no_unique" ON "eway_bills" USING btree ("tenant_id","ewb_no") WHERE ewb_no is not null;--> statement-breakpoint
CREATE INDEX "eway_bills_tenant_status_created_at_id_idx" ON "eway_bills" USING btree ("tenant_id","status","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "eway_gstin_settings_tenant_gstin_unique" ON "eway_gstin_settings" USING btree ("tenant_id","gstin");--> statement-breakpoint
CREATE INDEX "eway_state_thresholds_lookup_idx" ON "eway_state_thresholds" USING btree ("tenant_id","state_code","effective_from" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
-- ── hand-amended: CHECKs ──
ALTER TABLE "eway_national_thresholds" ADD CONSTRAINT "eway_national_thresholds_amount_check" CHECK ("threshold_paise" >= 0);--> statement-breakpoint
ALTER TABLE "eway_state_thresholds" ADD CONSTRAINT "eway_state_thresholds_state_code_check" CHECK ("state_code" ~ '^[0-9]{2}$');--> statement-breakpoint
ALTER TABLE "eway_state_thresholds" ADD CONSTRAINT "eway_state_thresholds_amount_check" CHECK ("threshold_paise" IS NULL OR "threshold_paise" >= 0);--> statement-breakpoint
ALTER TABLE "eway_gstin_settings" ADD CONSTRAINT "eway_gstin_settings_gstin_shape_check" CHECK ("gstin" ~ '^[0-9]{2}[A-Za-z0-9]{13}$');--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_status_check" CHECK ("status" IN ('pending', 'generated', 'dismissed'));--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_origin_gstin_shape_check" CHECK ("origin_gstin" ~ '^[0-9]{2}[A-Za-z0-9]{13}$');--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_value_over_threshold_check" CHECK ("threshold_paise" >= 0 AND "consignment_value_paise" > "threshold_paise");--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_threshold_rule_check" CHECK ("threshold_rule" ~ '^(national|state:[0-9]{2})$');--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_trans_mode_check" CHECK ("trans_mode" IS NULL OR "trans_mode" BETWEEN 1 AND 4);--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_vehicle_type_check" CHECK ("vehicle_type" IS NULL OR "vehicle_type" IN ('R', 'O'));--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_vehicle_no_shape_check" CHECK ("vehicle_no" IS NULL OR "vehicle_no" ~ '^[A-Z0-9]{4,15}$');--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_transporter_id_shape_check" CHECK ("transporter_id" IS NULL OR "transporter_id" ~ '^[0-9]{2}[A-Z0-9]{13}$');--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_distance_check" CHECK ("distance_km" IS NULL OR "distance_km" BETWEEN 0 AND 4000);--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_ewb_no_shape_check" CHECK ("ewb_no" IS NULL OR "ewb_no" ~ '^[0-9]{12}$');--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_source_check" CHECK ("source" IS NULL OR "source" IN ('manual', 'gateway'));--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_valid_until_check" CHECK ("ewb_valid_until" IS NULL OR ("ewb_generated_at" IS NOT NULL AND "ewb_valid_until" >= "ewb_generated_at"));--> statement-breakpoint
-- Two-way: generated ⇔ number, date and source are all set (and a
-- non-generated row carries none of the result columns).
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_generated_result_check" CHECK (
	("status" = 'generated' AND "ewb_no" IS NOT NULL AND "ewb_generated_at" IS NOT NULL AND "source" IS NOT NULL)
	OR ("status" <> 'generated' AND "ewb_no" IS NULL AND "ewb_generated_at" IS NULL AND "ewb_valid_until" IS NULL AND "source" IS NULL)
);--> statement-breakpoint
-- Two-way: dismissed ⇔ a reason is set.
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_dismissed_reason_check" CHECK (("status" = 'dismissed') = ("dismissed_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_export_stamp_paired_check" CHECK (("last_exported_at" IS NULL) = ("last_exported_by" IS NULL));--> statement-breakpoint
-- ── hand-amended: append-only / read-only triggers ──
CREATE FUNCTION "eway_refuse_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "eway_state_thresholds_append_only" BEFORE UPDATE ON "eway_state_thresholds"
	FOR EACH ROW EXECUTE FUNCTION "eway_refuse_mutation"();--> statement-breakpoint
CREATE TRIGGER "eway_national_thresholds_read_only" BEFORE UPDATE OR DELETE ON "eway_national_thresholds"
	FOR EACH ROW EXECUTE FUNCTION "eway_refuse_mutation"();--> statement-breakpoint
-- ── hand-amended: seed — the one verified national rule ──
INSERT INTO "eway_national_thresholds" ("effective_from", "threshold_paise", "source") VALUES ('2018-04-01', 5000000, 'CGST Rule 138(1)');--> statement-breakpoint
-- ── hand-amended: RLS — the three tenant tables (the uniform policy) ──
ALTER TABLE "eway_state_thresholds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eway_gstin_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eway_bills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "eway_state_thresholds_tenant_isolation" ON "eway_state_thresholds"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "eway_gstin_settings_tenant_isolation" ON "eway_gstin_settings"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "eway_bills_tenant_isolation" ON "eway_bills"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
