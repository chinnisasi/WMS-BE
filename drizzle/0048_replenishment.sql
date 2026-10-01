-- Story 6.1 — FR-22's replenishment spine: reorder points, breach alerts, and
-- suggested POs. Three table shapes:
--
--   reorder_policies — the per-warehouse override over the SKU columns'
--     tenant-wide defaults (effective point = policy row ?? SKU column).
--   reorder_breaches — one alert row per breach EVENT (re-breach opens a NEW
--     row: the unique covers only the `open` state), point/atp frozen at
--     detection. Lifecycle `open → recovered | actioned | dismissed`.
--   suggested_pos — the draft PO artifact minted when a breach opens; only
--     the human-triggered submit command writes a real PO (the inbound path).
--
-- The snapshot carries the tables + indexes as written (partial uniques
-- included — `drizzle/meta/0009-0011` record `where` clauses, so the
-- open-breach / draft-only unique pair is drizzle-declared and generated
-- above, NOT hand-appended). The status CHECKs (both vocabularies — the
-- three-mirrored-layers discipline's DB side), the positive-quantity CHECKs,
-- and the fail-closed RLS policies are hand-appended below (the 0047
-- pattern — drizzle-kit generate is blind to CHECKs and to RLS, and the
-- snapshot records `isRLSEnabled: false`, so the next generate must not
-- re-emit either).
--
-- ── 0. the fail-fast guard ────────────────────────────────────────────────
-- The CREATE below is not idempotent — a hand-applied re-run would half-land
-- and an out-of-order application (0047 missing) would land out of order.
-- Refuse loudly, the 0047 way.
DO $$
BEGIN
	IF to_regclass('public.reorder_policies') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0048 has already been applied: the "reorder_policies" table already exists. Re-running would half-land.';
	END IF;
	IF to_regclass('public.rejected_ops') IS NULL THEN
		RAISE EXCEPTION 'migration 0048 is out of order: "rejected_ops" does not exist — migration 0047 must be applied first.';
	END IF;
END $$;--> statement-breakpoint

CREATE TABLE "reorder_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"reorder_point_milli" bigint NOT NULL,
	"reorder_qty_milli" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "reorder_policies_tenant_warehouse_sku_unique" ON "reorder_policies" USING btree ("tenant_id","warehouse_id","sku_id");--> statement-breakpoint
CREATE INDEX "reorder_policies_tenant_created_at_id_idx" ON "reorder_policies" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "reorder_policies_tenant_warehouse_created_at_id_idx" ON "reorder_policies" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint

CREATE TABLE "reorder_breaches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"point_milli" bigint NOT NULL,
	"atp_milli" bigint NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "reorder_breaches_open_tenant_warehouse_sku_unique" ON "reorder_breaches" USING btree ("tenant_id","warehouse_id","sku_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "reorder_breaches_tenant_status_created_at_id_idx" ON "reorder_breaches" USING btree ("tenant_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "reorder_breaches_tenant_warehouse_created_at_id_idx" ON "reorder_breaches" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint

CREATE TABLE "suggested_pos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"breach_id" uuid NOT NULL,
	"vendor_id" uuid,
	"quantity_milli" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_po_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "suggested_pos_draft_tenant_warehouse_sku_unique" ON "suggested_pos" USING btree ("tenant_id","warehouse_id","sku_id") WHERE "status" = 'draft';--> statement-breakpoint
CREATE INDEX "suggested_pos_tenant_status_created_at_id_idx" ON "suggested_pos" USING btree ("tenant_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "suggested_pos_tenant_warehouse_created_at_id_idx" ON "suggested_pos" USING btree ("tenant_id","warehouse_id","created_at","id");

-- ── hand-appended: the 6-1 CHECKs + RLS (the 0047 pattern) ────────────────
-- The vocabularies below mirror the TS tuples in `src/shared/db/schema.ts`
-- (`REPLENISHMENT_BREACH_STATUSES`, `SUGGESTED_PO_STATUSES`); the positive
-- milli CHECKs carry the domain rule the policy commands enforce at the edge
-- (a policy of 0 or the wire's 0 is a refusal there, a corrupt row here).
ALTER TABLE "reorder_policies" ADD CONSTRAINT "reorder_policies_point_milli_positive_check" CHECK (
  "reorder_point_milli" > 0
);--> statement-breakpoint
ALTER TABLE "reorder_policies" ADD CONSTRAINT "reorder_policies_qty_milli_positive_check" CHECK (
  "reorder_qty_milli" > 0
);--> statement-breakpoint
ALTER TABLE "reorder_breaches" ADD CONSTRAINT "reorder_breaches_status_check" CHECK (
  "status" IN ('open', 'recovered', 'actioned', 'dismissed')
);--> statement-breakpoint
ALTER TABLE "suggested_pos" ADD CONSTRAINT "suggested_pos_status_check" CHECK (
  "status" IN ('draft', 'submitted', 'dismissed')
);--> statement-breakpoint
ALTER TABLE "reorder_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reorder_policies_tenant_isolation" ON "reorder_policies"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "reorder_breaches" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reorder_breaches_tenant_isolation" ON "reorder_breaches"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "suggested_pos" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "suggested_pos_tenant_isolation" ON "suggested_pos"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- (no data statements — the tables start empty; nothing to backfill).