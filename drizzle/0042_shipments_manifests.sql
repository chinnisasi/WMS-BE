CREATE TABLE "manifests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"carrier_connection_id" uuid NOT NULL,
	"carrier_code" text NOT NULL,
	"shipment_count" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text DEFAULT 'labelled' NOT NULL,
	"carrier_connection_id" uuid NOT NULL,
	"carrier_code" text NOT NULL,
	"carrier_name" text NOT NULL,
	"tracking_number" text NOT NULL,
	"label_document_ref" text NOT NULL,
	"weight_grams" integer,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"labelled_by" uuid NOT NULL,
	"labelled_at" timestamp with time zone NOT NULL,
	"manifest_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "manifests_tenant_warehouse_created_at_id_idx" ON "manifests" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_tenant_order_labelled_unique" ON "shipments" USING btree ("tenant_id","order_id") WHERE status = 'labelled';--> statement-breakpoint
CREATE INDEX "shipments_tenant_warehouse_created_at_id_idx" ON "shipments" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE INDEX "shipments_order_id_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_manifest_id_idx" ON "shipments" USING btree ("manifest_id");-- Story 4.6c hand-append (the 0025/0017 RLS + CHECK pattern): RLS and
-- CHECKs are declared only in migration SQL, never in schema.ts
-- (drizzle-orm 0.45 cannot model either without making future `generate`
-- runs emit conflicting DDL against this hand-written half).
--
-- The same fail-closed single-dimension `tenant_isolation` policy every
-- tenant-scoped table carries. The `NULLIF(current_setting(..., true), '')`
-- guard is load-bearing: Postgres returns '' once a transaction-local value
-- expires, so an un-scoped session sees ZERO rows instead of erroring.
ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "shipments_tenant_isolation" ON "shipments"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "manifests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "manifests_tenant_isolation" ON "manifests"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- The shipment's two-arm lifecycle. `labelled` = the adapter label exists
-- and the row is still open (dispatch may auto-stamp from it, the manifest
-- command may pick it up); `manifested` = closed onto a manifest
-- (`manifest_id` names it). The command allow-lists are pinned to this set
-- by the label.spec drift guard.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_status_check" CHECK ("status" IN ('labelled','manifested'));--> statement-breakpoint
-- A manifested shipment must name its manifest; an open one must not —
-- pairing is the same audit-gap argument the 0025 rotation-stamp CHECK
-- makes (a row that says manifested but points nowhere is unreadable).
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_manifest_pairing" CHECK (("status" = 'manifested') = ("manifest_id" IS NOT NULL));--> statement-breakpoint
-- The label request's optional measurements, same bounds as pack
-- (MAX_WEIGHT_GRAMS = 1_000_000 g; MAX_DIMENSION_MM = 100_000 mm). The
-- command rejects out-of-bounds with a 400 first; these are the backstops.
-- Arms are present together or not at all.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_weight_grams_range" CHECK ("weight_grams" IS NULL OR ("weight_grams" > 0 AND "weight_grams" <= 1000000));--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_dimensions_arms_paired" CHECK (("length_mm" IS NULL) = ("width_mm" IS NULL) AND ("width_mm" IS NULL) = ("height_mm" IS NULL));--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_dimension_mm_range" CHECK ("length_mm" IS NULL OR ("length_mm" > 0 AND "length_mm" <= 1000000 AND "width_mm" > 0 AND "width_mm" <= 1000000 AND "height_mm" > 0 AND "height_mm" <= 1000000));--> statement-breakpoint
-- The adapter-issued identity the whole writeback path rides: a blank
-- tracking number or document ref would be a label that says nothing.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tracking_number_nonblank" CHECK (length(btrim("tracking_number")) > 0);--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_label_document_ref_nonblank" CHECK (length(btrim("label_document_ref")) > 0);--> statement-breakpoint
-- The carrier code is a registry code (`sandbox`, `delhivery`, …) — an
-- empty string would be an unresolvable connection.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_carrier_code_nonblank" CHECK (length(btrim("carrier_code")) > 0);--> statement-breakpoint
-- A manifest that closed zero shipments is not a hand-over document (the
-- command requires ≥ 1; this is the backstop).
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_shipment_count_positive" CHECK ("shipment_count" >= 1);--> statement-breakpoint
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_carrier_code_nonblank" CHECK (length(btrim("carrier_code")) > 0);
