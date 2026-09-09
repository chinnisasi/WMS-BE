CREATE TABLE "batch_on_hand" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"bin_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"code" text NOT NULL,
	"mfg_date" timestamp with time zone,
	"expiry_date" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "serials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"serial_number" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "batch_on_hand_scope_unique" ON "batch_on_hand" USING btree ("tenant_id","warehouse_id","sku_id","bin_id","batch_id");--> statement-breakpoint
CREATE INDEX "batch_on_hand_tenant_warehouse_sku_idx" ON "batch_on_hand" USING btree ("tenant_id","warehouse_id","sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batches_tenant_sku_code_unique" ON "batches" USING btree ("tenant_id","sku_id","code");--> statement-breakpoint
CREATE INDEX "batches_tenant_sku_idx" ON "batches" USING btree ("tenant_id","sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "serials_tenant_sku_serial_unique" ON "serials" USING btree ("tenant_id","sku_id","serial_number");--> statement-breakpoint
CREATE INDEX "serials_tenant_sku_idx" ON "serials" USING btree ("tenant_id","sku_id");--> statement-breakpoint
CREATE INDEX "ledger_events_tenant_serial_ref_seq_idx" ON "ledger_events" USING btree ("tenant_id","serial_ref","seq");--> statement-breakpoint
CREATE INDEX "ledger_events_tenant_batch_ref_seq_idx" ON "ledger_events" USING btree ("tenant_id","batch_ref","seq");--> statement-breakpoint
-- Story 2.4 hand-append (the 0006/0007/0008/0009 RLS policy pattern): RLS is
-- declared only in migration SQL, never in schema.ts. Same fail-closed
-- single-dimension `tenant_isolation` policy on each of the three new
-- tenant-bearing tables (catalog-owned `batches`/`serials`, inventory-owned
-- `batch_on_hand`). The `current_setting(..., true)` empty-string NULLIF guard
-- is load-bearing (Postgres 18 returns '' after a transaction-local value
-- expires) so an un-scoped session fails closed (sees zero rows) instead of
-- erroring. Every read/write runs in an explicitly tenant-scoped transaction.
ALTER TABLE "batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "batches_tenant_isolation" ON "batches"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "serials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "serials_tenant_isolation" ON "serials"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "batch_on_hand" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "batch_on_hand_tenant_isolation" ON "batch_on_hand"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Story 2.4 hand-append: a typo'd lifecycle status would silently drop the row
-- out of every status-filtered consumer — the state set is DB-enforced.
ALTER TABLE "batches" ADD CONSTRAINT "batches_status_check" CHECK ("status" IN ('active','blocked'));
--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_status_check" CHECK ("status" IN ('active','blocked'));
--> statement-breakpoint
-- A negative batch on-hand is corruption, not state: the projection fold
-- rejects a batch over-draw naming the batch first; the CHECK is the backstop
-- (the speculative-tuple clamp of the stock_on_hand fold applies here too).
ALTER TABLE "batch_on_hand" ADD CONSTRAINT "batch_on_hand_quantity_nonnegative" CHECK ("quantity" >= 0);