CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"reserved_qty" integer DEFAULT 0 NOT NULL,
	"reservation_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"integration_id" uuid,
	"external_event_id" text,
	"source_payload_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "order_lines_order_id_idx" ON "order_lines" USING btree ("order_id","created_at","id");--> statement-breakpoint
CREATE INDEX "order_lines_tenant_id_idx" ON "order_lines" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_warehouse_created_at_id_idx" ON "orders" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_source_event_unique" ON "orders" USING btree ("tenant_id","integration_id","external_event_id") WHERE integration_id is not null and external_event_id is not null;--> statement-breakpoint
-- Story 4.1 hand-append (the 0011 RLS policy pattern): RLS is declared only
-- in migration SQL, never in schema.ts. Same fail-closed single-dimension
-- `tenant_isolation` policy on the two new outbound-owned tables. The
-- `current_setting(..., true)` empty-string NULLIF guard is load-bearing
-- (Postgres 18 returns '' after a transaction-local value expires) so an
-- un-scoped session fails closed (sees zero rows) instead of erroring. Every
-- read/write runs in an explicitly tenant-scoped transaction.
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "orders_tenant_isolation" ON "orders"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "order_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "order_lines_tenant_isolation" ON "order_lines"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Story 4.1 hand-append: the order state machine lives ONLY in the outbound
-- module (AD-6) — the DB CHECK enforces the additive arm set (`accepted` /
-- `cancelled` today; picking / packed / dispatched arrive with stories
-- 4.3 / 4.5 / 4.6 as additive CHECK arms). The source arm and the line
-- fulfillment arm get the same treatment — a typo'd arm would silently drop
-- the row out of every status-filtered consumer.
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK ("status" IN ('accepted','cancelled'));
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_source_check" CHECK ("source" IN ('manual','ingested'));
--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_status_check" CHECK ("status" IN ('open','backordered'));
--> statement-breakpoint
-- Quantities are positive integers in base UoM; the reserved split is
-- non-negative and can never exceed the ordered quantity (the command layer
-- rejects first, the CHECKs are the backstop).
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_qty_positive" CHECK ("qty" > 0);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_reserved_qty_nonnegative" CHECK ("reserved_qty" >= 0);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_reserved_qty_lte_qty" CHECK ("reserved_qty" <= "qty");
