CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"grn_id" uuid NOT NULL,
	"po_line_id" uuid,
	"sku_id" uuid NOT NULL,
	"batch_id" uuid,
	"qty" integer NOT NULL,
	"applied_qty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"code" text NOT NULL,
	"po_id" uuid,
	"blind_reason_code" text,
	"status" text DEFAULT 'recorded' NOT NULL,
	"device_id" uuid NOT NULL,
	"recorded_by" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "over_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"grn_id" uuid NOT NULL,
	"grn_line_id" uuid NOT NULL,
	"po_id" uuid,
	"po_line_id" uuid,
	"sku_id" uuid NOT NULL,
	"excess_qty" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bins" ADD COLUMN "system_owned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_grn_id_idx" ON "goods_receipt_lines" USING btree ("grn_id","created_at","id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_tenant_id_idx" ON "goods_receipt_lines" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_notes_tenant_id_code_unique" ON "goods_receipt_notes" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "goods_receipt_notes_tenant_created_at_id_idx" ON "goods_receipt_notes" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "goods_receipt_notes_tenant_warehouse_created_at_id_idx" ON "goods_receipt_notes" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE INDEX "over_receipts_tenant_status_created_at_id_idx" ON "over_receipts" USING btree ("tenant_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "over_receipts_tenant_created_at_id_idx" ON "over_receipts" USING btree ("tenant_id","created_at","id");-- Story 3.3 hand-append (the 0005→0012 RLS policy pattern): RLS is declared
-- only in migration SQL, never in schema.ts. Fail-closed single-dimension
-- `tenant_isolation` on each of the three new receiving tables — a session
-- without `app.tenant_id` sees zero rows. Every read/write runs in an
-- explicitly tenant-scoped transaction.
ALTER TABLE "goods_receipt_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "goods_receipt_notes_tenant_isolation" ON "goods_receipt_notes"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "goods_receipt_lines_tenant_isolation" ON "goods_receipt_lines"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "over_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "over_receipts_tenant_isolation" ON "over_receipts"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Story 3.3 hand-append: a typo'd lifecycle status would drop the row out of
-- every status-filtered consumer — the state sets are DB-enforced (text +
-- CHECK per the repo convention; no pgEnum).
ALTER TABLE "goods_receipt_notes" ADD CONSTRAINT "goods_receipt_notes_status_check" CHECK ("status" IN ('recorded'));
--> statement-breakpoint
ALTER TABLE "over_receipts" ADD CONSTRAINT "over_receipts_status_check" CHECK ("status" IN ('pending','approved','rejected'));
--> statement-breakpoint
ALTER TABLE "over_receipts" ADD CONSTRAINT "over_receipts_excess_qty_positive" CHECK ("excess_qty" > 0);
--> statement-breakpoint
-- Quantities are positive / non-negative integers in base UoM: a GRN line
-- always records physical truth (qty > 0); the applied portion is the
-- within-open slice (>= 0) and never more than what physically arrived. The
-- deliberate absence of a `received_qty <= ordered_qty` CHECK on
-- purchase_order_lines is story 3.3's decision — approved over-receipts
-- legitimately drive received past ordered (the OpenAPI `openQty` minimum is
-- relaxed in the same change).
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_qty_positive" CHECK ("qty" > 0);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_applied_qty_nonnegative" CHECK ("applied_qty" >= 0);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_applied_le_physical" CHECK ("applied_qty" <= "qty");
--> statement-breakpoint
-- Blind receipts: a GRN either references a PO or carries a blind reason code
-- from the fixed enum — never both, never neither. This is the DB backstop
-- behind the command's 400s.
ALTER TABLE "goods_receipt_notes" ADD CONSTRAINT "goods_receipt_notes_blind_pairing" CHECK (
	("po_id" IS NULL AND "blind_reason_code" IN ('unannounced-delivery','po-not-found','other'))
	OR ("po_id" IS NOT NULL AND "blind_reason_code" IS NULL)
);
