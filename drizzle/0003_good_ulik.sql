CREATE TABLE "bins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"code" text NOT NULL,
	"capacity" integer NOT NULL,
	"type" text NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bins_warehouse_id_code_unique" ON "bins" USING btree ("warehouse_id","code");--> statement-breakpoint
CREATE INDEX "bins_created_at_id_idx" ON "bins" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "zones_warehouse_id_code_unique" ON "zones" USING btree ("warehouse_id","code");--> statement-breakpoint
CREATE INDEX "zones_created_at_id_idx" ON "zones" USING btree ("created_at","id");--> statement-breakpoint
-- AD-3 defense-in-depth (Story 1.3): RLS on the new warehouse-scoped tables,
-- the same fail-closed single-dimension policy as 0001 (`tenant_isolation`).
-- Warehouse scoping is enforced in the app layer (`assertWarehouseInTenant`
-- inside the command transaction); `warehouse_id` is deliberately NOT in the
-- policy — the RLS session state carries only `app.tenant_id`. The
-- `current_setting(..., true)` empty-string NULLIF guard is load-bearing
-- (Postgres 18 returns '' after a transaction-local value expires) so an
-- un-scoped session fails closed (sees zero rows) instead of erroring.
ALTER TABLE "zones" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bins" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "zones_tenant_isolation" ON "zones"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "bins_tenant_isolation" ON "bins"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);