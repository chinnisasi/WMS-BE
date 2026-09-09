CREATE TABLE "inventory_quarantines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"bin_id" uuid NOT NULL,
	"from_seq" integer NOT NULL,
	"to_seq" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_checkpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"invalid_attempts" integer DEFAULT 0 NOT NULL,
	"last_divergences" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_quarantines_open_scope_unique" ON "inventory_quarantines" USING btree ("tenant_id","warehouse_id","sku_id","bin_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "inventory_quarantines_tenant_warehouse_status_idx" ON "inventory_quarantines" USING btree ("tenant_id","warehouse_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_checkpoints_tenant_warehouse_unique" ON "reconciliation_checkpoints" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "reconciliation_checkpoints_tenant_updated_at_idx" ON "reconciliation_checkpoints" USING btree ("tenant_id","updated_at");
--> statement-breakpoint
-- Story 2.2 hand-append (the 0006/0007 RLS policy pattern): RLS is declared
-- only in migration SQL, never in schema.ts. Same fail-closed single-dimension
-- `tenant_isolation` policy on each of the two new tenant-bearing tables. The
-- `current_setting(..., true)` empty-string NULLIF guard is load-bearing
-- (Postgres 18 returns '' after a transaction-local value expires) so an
-- un-scoped session fails closed (sees zero rows) instead of erroring. The
-- worker's one cross-tenant read (partition discovery, oldest-checkpoint-first)
-- deliberately runs on the BYPASSRLS connection (the relay's tenant-discovery
-- precedent); every row write stays in an explicitly tenant-scoped transaction.
ALTER TABLE "reconciliation_checkpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "reconciliation_checkpoints_tenant_isolation" ON "reconciliation_checkpoints"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory_quarantines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "inventory_quarantines_tenant_isolation" ON "inventory_quarantines"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Story 2.2 hand-append: a typo'd quarantine status would silently drop the
-- row out of every `status = 'open'` consumer (2.3's reservation path) — the
-- state machine is DB-enforced.
ALTER TABLE "inventory_quarantines" ADD CONSTRAINT "inventory_quarantines_status_check" CHECK ("status" IN ('open','resolved'));
--> statement-breakpoint
-- A negative checkpoint watermark is corruption, not state: the checkpoint
-- names a verified-through seq, which starts at 0.
ALTER TABLE "reconciliation_checkpoints" ADD CONSTRAINT "reconciliation_checkpoints_last_seq_nonnegative" CHECK ("last_seq" >= 0);
--> statement-breakpoint
ALTER TABLE "inventory_quarantines" ADD CONSTRAINT "inventory_quarantines_seq_range_valid" CHECK ("from_seq" <= "to_seq");