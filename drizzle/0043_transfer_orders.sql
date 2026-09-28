-- Story 5-1 — Transfer Orders (FR-18/FR-29): the movements module's first
-- tables, `transfer_orders` + `transfer_order_lines`, plus the DATA migration
-- seeding one system-owned IN-TRANSIT bin per existing warehouse (the QC-hold
-- precedent — story 3.4's system bin, landed for stock that already exists).
--
-- The CHECKs (status + line quantity) and the RLS policies are hand-appended
-- below (the 0008/0025 pattern — drizzle-kit generate is blind to both, and
-- the snapshot records `isRLSEnabled: false`, so the next generate must not
-- re-emit either). No FKs anywhere (repo convention).
--
-- ── 0. the fail-fast guard ────────────────────────────────────────────────
-- The seed below is idempotent (ON CONFLICT DO NOTHING), but the CREATE
-- TABLEs above are not — a hand-applied re-run would half-land. Refuse
-- loudly, the 0040 way.
DO $$
BEGIN
	IF to_regclass('public.transfer_orders') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0043 has already been applied: the "transfer_orders" table already exists. Re-running would re-seed the IN-TRANSIT bins a second time.';
	END IF;
END $$;--> statement-breakpoint

-- ── 1. the pre-flight block ───────────────────────────────────────────────
-- The seed maps every warehouse to ITS OWN tenant's IN-TRANSIT bin, so the
-- only unmappable row is a warehouse whose `tenant_id` has no `tenants` row —
-- an orphan that no INSERT can repair (the bin row would carry a tenant_id
-- no RLS policy ever matches, invisible to every reader). The block lists
-- EVERY orphan at once, so an operator fixes all of them in one pass.
-- Orphan bins/zones under a live warehouse cannot exist for this seed: the
-- zone/bin codes are new ('IN-TRANSIT'), so nothing pre-exists to collide.
DO $$
DECLARE
	orphans text;
	wh_count bigint;
BEGIN
	SELECT string_agg(format('warehouse %s claims tenant %s', w.id, w.tenant_id), ', ' ORDER BY w.id)
	INTO orphans
	FROM warehouses w LEFT JOIN tenants t ON t.id = w.tenant_id
	WHERE t.id IS NULL;
	IF orphans IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0043 pre-flight failed: warehouses whose tenant does not exist, unmappable to any IN-TRANSIT bin (%)', orphans;
	END IF;
	SELECT count(*) INTO wh_count FROM warehouses;
	RAISE NOTICE 'migration 0043: seeding the IN-TRANSIT zone + bin for % warehouse(s)', wh_count;
END $$;--> statement-breakpoint

CREATE TABLE "transfer_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"quantity_milli" bigint NOT NULL,
	"from_bin_id" uuid NOT NULL,
	"to_bin_id" uuid NOT NULL,
	"batch_ref" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_warehouse_id" uuid NOT NULL,
	"dest_warehouse_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"outbound_confirmed_by" uuid,
	"outbound_confirmed_at" timestamp with time zone,
	"inbound_confirmed_by" uuid,
	"inbound_confirmed_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "transfer_order_lines_transfer_id_idx" ON "transfer_order_lines" USING btree ("transfer_id","id");--> statement-breakpoint
CREATE INDEX "transfer_order_lines_sku_id_idx" ON "transfer_order_lines" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "transfer_orders_tenant_created_at_id_idx" ON "transfer_orders" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "transfer_orders_dest_warehouse_status_idx" ON "transfer_orders" USING btree ("dest_warehouse_id","status");
-- ── hand-appended: the CHECKs + RLS (the 0008 pattern) ────────────────────
-- `drizzle-kit generate` is blind to CHECKs and to RLS, so both are
-- migration-SQL-only: `transfer_orders.status` carries no schema-side
-- constraint object and the snapshot records `isRLSEnabled: false` (the
-- documented drizzle-orm gap), so the next generate must not re-emit either.
-- The status vocabulary is the four-valued transfer lifecycle of story 5-1
-- (`draft | in_transit | completed | cancelled`); the line quantity is a
-- positive milli-unit level (a zero/negative line is a nothing movement).
-- No data statement for the CHECKs: new tables, every row conforms.
ALTER TABLE "transfer_orders" ADD CONSTRAINT "transfer_orders_status_check" CHECK (
  "status" IN ('draft', 'in_transit', 'completed', 'cancelled')
);
ALTER TABLE "transfer_order_lines" ADD CONSTRAINT "transfer_order_lines_quantity_check" CHECK (
  "quantity_milli" > 0
);
ALTER TABLE "transfer_orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "transfer_orders_tenant_isolation" ON "transfer_orders"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "transfer_order_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "transfer_order_lines_tenant_isolation" ON "transfer_order_lines"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- ── 2. the data migration: one IN-TRANSIT zone + bin per warehouse ───────
-- The system in-transit bin (story 5-1): the QC-hold bin's mirror (3.4).
-- Every warehouse gets exactly one, seeded HERE for the warehouses that
-- already exist and at warehouse creation for the new ones
-- (`ensureInTransitBinInTx`, beside `ensureQcHoldBinInTx`). Identity is the
-- fixed code pair — zone `IN-TRANSIT`, bin `IN-TRANSIT` — `system_owned`
-- flags it (putaway suggestions, picking and placements exclude it; the ATP
-- hook `inTransitUnits` counts the stock sitting in it by code +
-- system-owned), the type is `staging` and the capacity the same generous
-- sentinel the other system bins carry — transfers are never capacity-gated
-- on their own system bin.
--
-- `gen_random_uuid()` is migration-time only (the 0021/0040 precedent) — the
-- command paths mint uuidv7 in TS. Both inserts are ON CONFLICT DO NOTHING
-- (the ensure-or-reselect shape): a re-run lands on the existing rows.
INSERT INTO "zones" ("id", "tenant_id", "warehouse_id", "code", "name")
SELECT gen_random_uuid(), w."tenant_id", w."id", 'IN-TRANSIT', 'In Transit'
FROM "warehouses" w
ON CONFLICT ("warehouse_id", "code") DO NOTHING;--> statement-breakpoint

INSERT INTO "bins" ("id", "tenant_id", "warehouse_id", "zone_id", "code", "capacity", "type", "system_owned")
SELECT gen_random_uuid(), w."tenant_id", w."id", z."id", 'IN-TRANSIT', 1000000000, 'staging', true
FROM "warehouses" w
JOIN "zones" z ON z."warehouse_id" = w."id" AND z."code" = 'IN-TRANSIT'
ON CONFLICT ("warehouse_id", "code") DO NOTHING;--> statement-breakpoint

-- ── 3. the post-assertion ────────────────────────────────────────────────
-- Every warehouse must now own exactly one system-owned IN-TRANSIT bin. The
-- join is on the zone's (warehouse, code) identity, so a warehouse whose
-- zone insert was skipped by a conflict AND whose bin insert then missed
-- would surface here — fail loudly rather than ship a warehouse whose
-- transfers park stock in a bin that does not exist.
DO $$
DECLARE
	unseeded text;
BEGIN
	SELECT string_agg(format('warehouse %s (%s)', w.id, w.code), ', ' ORDER BY w.id)
	INTO unseeded
	FROM warehouses w
	LEFT JOIN bins b
	  ON b.warehouse_id = w.id AND b.code = 'IN-TRANSIT' AND b.system_owned
	WHERE b.id IS NULL;
	IF unseeded IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0043 post-assertion failed: warehouses still without a system-owned IN-TRANSIT bin (%)', unseeded;
	END IF;
END $$;