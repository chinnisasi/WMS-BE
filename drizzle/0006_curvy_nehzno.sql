CREATE TABLE "ledger_anchors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"from_seq" integer NOT NULL,
	"to_seq" integer NOT NULL,
	"digest" text NOT NULL,
	"anchored_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"sku_id" uuid NOT NULL,
	"quantity_delta" integer NOT NULL,
	"from_bin_id" uuid,
	"to_bin_id" uuid,
	"batch_ref" text,
	"serial_ref" text,
	"actor_user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"reference_doc" jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"event_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_on_hand" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"bin_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Unique: the DB backstop behind the anchor advisory lock — two
-- overlapping anchor ranges for one warehouse cannot commit.
CREATE UNIQUE INDEX "ledger_anchors_tenant_warehouse_to_seq_unique" ON "ledger_anchors" USING btree ("tenant_id","warehouse_id","to_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_events_tenant_warehouse_seq_unique" ON "ledger_events" USING btree ("tenant_id","warehouse_id","seq");--> statement-breakpoint
CREATE INDEX "ledger_events_tenant_warehouse_sku_seq_idx" ON "ledger_events" USING btree ("tenant_id","warehouse_id","sku_id","seq");--> statement-breakpoint
CREATE INDEX "ledger_events_tenant_warehouse_created_at_id_idx" ON "ledger_events" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_on_hand_scope_unique" ON "stock_on_hand" USING btree ("tenant_id","warehouse_id","sku_id","bin_id");--> statement-breakpoint
CREATE INDEX "stock_on_hand_tenant_warehouse_sku_idx" ON "stock_on_hand" USING btree ("tenant_id","warehouse_id","sku_id");
-- Story 2.1 hand-append (the 0005 RLS policy pattern): RLS is declared only
-- in migration SQL, never in schema.ts. Same fail-closed single-dimension
-- `tenant_isolation` policy on each of the three new tenant-bearing tables.
-- The `current_setting(..., true)` empty-string NULLIF guard is load-bearing
-- (Postgres 18 returns '' after a transaction-local value expires) so an
-- un-scoped session fails closed (sees zero rows) instead of erroring.
ALTER TABLE "ledger_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ledger_events_tenant_isolation" ON "ledger_events"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "stock_on_hand" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "stock_on_hand_tenant_isolation" ON "stock_on_hand"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "ledger_anchors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ledger_anchors_tenant_isolation" ON "ledger_anchors"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Story 2.1 hand-append: append-only enforcement at the DATABASE, not by
-- convention. Corrections are new compensating ledger events; an UPDATE or
-- DELETE of a settled ledger event (or anchor) is rejected here. The
-- projection table `stock_on_hand` is deliberately NOT covered — it is
-- derived state maintained (updated) in the same transaction as the event.
CREATE FUNCTION "ledger_append_only_guard"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'ledger table % is append-only: % rejected', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "ledger_events_append_only"
	BEFORE UPDATE OR DELETE ON "ledger_events"
	FOR EACH ROW EXECUTE FUNCTION "ledger_append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "ledger_anchors_append_only"
	BEFORE UPDATE OR DELETE ON "ledger_anchors"
	FOR EACH ROW EXECUTE FUNCTION "ledger_append_only_guard"();
--> statement-breakpoint
-- TRUNCATE is a third way to destroy settled rows (it also sidesteps
-- row-level triggers) — the same unconditional guard covers it via
-- statement-level triggers on both ledger tables.
CREATE TRIGGER "ledger_events_append_only_truncate"
	BEFORE TRUNCATE ON "ledger_events"
	FOR EACH STATEMENT EXECUTE FUNCTION "ledger_append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "ledger_anchors_append_only_truncate"
	BEFORE TRUNCATE ON "ledger_anchors"
	FOR EACH STATEMENT EXECUTE FUNCTION "ledger_append_only_guard"();
--> statement-breakpoint
-- Story 2.1 hand-append: the on-hand projection must never go below zero.
-- The projection updater rejects an over-draw first (422 naming the bin and
-- current on-hand); this CHECK is the database backstop behind it.
ALTER TABLE "stock_on_hand" ADD CONSTRAINT "stock_on_hand_quantity_nonnegative" CHECK ("quantity" >= 0);