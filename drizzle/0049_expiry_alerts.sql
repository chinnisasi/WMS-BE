-- Story 6.2 — FR-23's expiry/aging half of the replenishment module. Two
-- table shapes:
--
--   expiry_alert_policies — the per-TENANT config (config-not-code): a tenant
--     with NO row has expiry/aging alerting disabled (no default lead or
--     threshold days hide in code). One row per tenant (unique tenant_id);
--     `expiry_lead_days` / `aging_threshold_days`, both ≥ 0.
--   batch_alerts — per-SCOPE alert rows the scheduler tick's expiry scan
--     opens: kind `expiry_upcoming` | `aged` (a batch triggering both carries
--     two rows), at most ONE open row per (tenant, warehouse, sku, batch,
--     kind) — the partial unique. `age_days` frozen at detection (`aged`
--     only); lifecycle `open → resolved` (on-hand 0, nobody stamped, no
--     event) | `open → dismissed` (human). No batch code/expiry column —
--     identity and dates are catalog-owned and read fresh (AD-6).
--
-- Also one index on the EXISTING `batches` table (`batches_tenant_expiry_idx`) —
-- the scan's join input, declarable because it has no `where` clause.
--
-- The snapshot carries the tables + indexes as written (partial unique
-- included — `drizzle/meta/0009-0011` record `where` clauses, so the
-- open-scope unique is drizzle-declared and generated above, NOT
-- hand-appended). The kind/status CHECKs (the three-mirrored-layers
-- discipline's DB side), the ≥-0 CHECKs on the config ints, and the
-- fail-closed RLS policies are hand-appended below (the 0048 pattern —
-- drizzle-kit generate is blind to CHECKs and to RLS, and the snapshot
-- records `isRLSEnabled: false`, so the next generate must not re-emit
-- either).
--
-- ── 0. the fail-fast guard ────────────────────────────────────────────────
-- The CREATE below is not idempotent — a hand-applied re-run would half-land
-- and an out-of-order application (0048 missing) would land out of order.
-- Refuse loudly, the 0048 way.
DO $$
BEGIN
	IF to_regclass('public.batch_alerts') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0049 has already been applied: the "batch_alerts" table already exists. Re-running would half-land.';
	END IF;
	IF to_regclass('public.suggested_pos') IS NULL THEN
		RAISE EXCEPTION 'migration 0049 is out of order: "suggested_pos" does not exist — migration 0048 must be applied first.';
	END IF;
END $$;--> statement-breakpoint

CREATE TABLE "batch_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"age_days" integer,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "expiry_alert_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expiry_lead_days" integer NOT NULL,
	"aging_threshold_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "batch_alerts_open_tenant_warehouse_sku_batch_kind_unique" ON "batch_alerts" USING btree ("tenant_id","warehouse_id","sku_id","batch_id","kind") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "batch_alerts_tenant_status_created_at_id_idx" ON "batch_alerts" USING btree ("tenant_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "batch_alerts_tenant_kind_created_at_id_idx" ON "batch_alerts" USING btree ("tenant_id","kind","created_at","id");--> statement-breakpoint
CREATE INDEX "batch_alerts_tenant_warehouse_created_at_id_idx" ON "batch_alerts" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "expiry_alert_policies_tenant_unique" ON "expiry_alert_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "batches_tenant_expiry_idx" ON "batches" USING btree ("tenant_id","expiry_date");

-- ── hand-appended: the 6-2 CHECKs + RLS (the 0048 pattern) ────────────────
-- The vocabularies below mirror the TS tuples in `src/shared/db/schema.ts`
-- (`BATCH_ALERT_KINDS`, `BATCH_ALERT_STATUSES`); the ≥-0 CHECKs carry the
-- domain rule the config command enforces at the edge (a negative day count
-- is a refusal there, a corrupt row here). `age_days` is nullable by design
-- (`expiry_upcoming` rows carry no frozen age).
ALTER TABLE "expiry_alert_policies" ADD CONSTRAINT "expiry_alert_policies_expiry_lead_days_nonnegative_check" CHECK (
  "expiry_lead_days" >= 0
);--> statement-breakpoint
ALTER TABLE "expiry_alert_policies" ADD CONSTRAINT "expiry_alert_policies_aging_threshold_days_nonnegative_check" CHECK (
  "aging_threshold_days" >= 0
);--> statement-breakpoint
ALTER TABLE "batch_alerts" ADD CONSTRAINT "batch_alerts_kind_check" CHECK (
  "kind" IN ('expiry_upcoming', 'aged')
);--> statement-breakpoint
ALTER TABLE "batch_alerts" ADD CONSTRAINT "batch_alerts_status_check" CHECK (
  "status" IN ('open', 'resolved', 'dismissed')
);--> statement-breakpoint
ALTER TABLE "expiry_alert_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "expiry_alert_policies_tenant_isolation" ON "expiry_alert_policies"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "batch_alerts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "batch_alerts_tenant_isolation" ON "batch_alerts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- (no data statements — the tables start empty; nothing to backfill).