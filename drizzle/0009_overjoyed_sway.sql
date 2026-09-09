CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reservations_tenant_state_expires_at_idx" ON "reservations" USING btree ("tenant_id","state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_open_owner_scope_unique" ON "reservations" USING btree ("tenant_id","warehouse_id","sku_id","owner_type","owner_id") WHERE state = 'held';--> statement-breakpoint
CREATE INDEX "reservations_tenant_warehouse_sku_state_idx" ON "reservations" USING btree ("tenant_id","warehouse_id","sku_id","state");--> statement-breakpoint
-- Story 2.3 hand-append (the 0006/0007/0008 RLS policy pattern): RLS is declared
-- only in migration SQL, never in schema.ts. Same fail-closed single-dimension
-- `tenant_isolation` policy on the new tenant-bearing table. The
-- `current_setting(..., true)` empty-string NULLIF guard is load-bearing
-- (Postgres 18 returns '' after a transaction-local value expires) so an
-- un-scoped session fails closed (sees zero rows) instead of erroring. Every
-- reservation read/write runs in an explicitly tenant-scoped transaction; the
-- reaper's one cross-tenant read (due holds across tenants) runs on the
-- BYPASSRLS connection (the relay/reconciliation tenant-discovery precedent),
-- while its terminal UPDATE stays tenant-scoped.
ALTER TABLE "reservations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "reservations_tenant_isolation" ON "reservations"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Story 2.3 hand-append: the held → committed → released/expired state machine
-- is DB-enforced — a typo'd state would silently drop the row out of every
-- `state = 'held'` consumer (the reaper, the counter rebuild, grant
-- idempotency) and corrupt the reserved-counter mirror.
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_state_check" CHECK ("state" IN ('held','committed','released','expired'));
--> statement-breakpoint
-- A reservation of zero (or negative) units guards nothing — the grant path
-- rejects it first; the CHECK is the backstop.
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_quantity_positive" CHECK ("quantity" > 0);