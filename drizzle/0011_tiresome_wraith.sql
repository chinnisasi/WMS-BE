CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"po_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"ordered_qty" integer NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"unit_cost_paise" integer NOT NULL,
	"expected_date" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"carried_from_po_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "purchase_order_lines_po_id_idx" ON "purchase_order_lines" USING btree ("po_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_tenant_id_code_unique" ON "purchase_orders" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "purchase_orders_tenant_created_at_id_idx" ON "purchase_orders" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "purchase_orders_tenant_warehouse_created_at_id_idx" ON "purchase_orders" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE INDEX "purchase_orders_tenant_carried_from_idx" ON "purchase_orders" USING btree ("tenant_id","carried_from_po_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_tenant_id_code_unique" ON "vendors" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "vendors_created_at_id_idx" ON "vendors" USING btree ("created_at","id");--> statement-breakpoint
-- Story 3.1 hand-append (the 0005→0010 RLS policy pattern): RLS is declared
-- only in migration SQL, never in schema.ts. Same fail-closed
-- single-dimension `tenant_isolation` policy on each of the three new
-- tenant-bearing tables (inbound-owned `vendors`, `purchase_orders`,
-- `purchase_order_lines`). The `current_setting(..., true)` empty-string
-- NULLIF guard is load-bearing (Postgres 18 returns '' after a
-- transaction-local value expires) so an un-scoped session fails closed
-- (sees zero rows) instead of erroring. Every read/write runs in an
-- explicitly tenant-scoped transaction.
ALTER TABLE "vendors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vendors_tenant_isolation" ON "vendors"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "purchase_orders_tenant_isolation" ON "purchase_orders"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "purchase_order_lines_tenant_isolation" ON "purchase_order_lines"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Story 3.1 hand-append: a typo'd lifecycle status would silently drop the row
-- out of every status-filtered consumer — the state sets are DB-enforced
-- (text + CHECK per the repo convention; no pgEnum).
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_status_check" CHECK ("status" IN ('open','closed'));
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_status_check" CHECK ("status" IN ('open','cancelled','carried'));
--> statement-breakpoint
-- Quantities are positive integers in base UoM / non-negative integer paise
-- (AD-9): a non-positive ordered qty or unit cost is a data-entry error, and
-- a negative received qty is corruption — the command layer rejects first,
-- the CHECKs are the backstop. (The `received_qty <= ordered_qty` arm of the
-- open_qty >= 0 invariant lands with 3.3's receipt path: shipping it now
-- would block over-receipt approval, which allows receipts past ordered.)
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_ordered_qty_positive" CHECK ("ordered_qty" > 0);
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_received_qty_nonnegative" CHECK ("received_qty" >= 0);
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_unit_cost_paise_nonnegative" CHECK ("unit_cost_paise" >= 0);