-- Story 5-4 — Variance review and resolution: the resolution spine that
-- finishes what 5-3 started. Three parts:
--
-- 1. `count_variances` widens from its 5-3 single state: the status CHECK is
--    DROPped and re-ADDed with the full lifecycle vocabulary
--    (`'open' → 'adjusted' | 'recounted'`), and the resolution's columns
--    arrive — `threshold_quantity_milli` (the policy value frozen at submit,
--    the `threshold_quantity_at_request` precedent), `resolved_by`,
--    `resolved_at`, `recount_task_id` (bare uuid, no FK — the repo
--    convention; validated in the command transaction) and
--    `considered_event_seqs` (the consulted ledger seqs, jsonb). Existing
--    rows all read `open` and carry null resolution columns — no backfill,
--    no data migration. The 0045 CHECK on `delta_milli` already guards the
--    recount arm's recomputation (the recomputed delta is written with its
--    line in the same UPDATE).
--
-- 2. `count_variance_policies` — the per-tenant opt-in (config-not-code, the
--    `stock_adjustment_policies` mirror): one row per tenant whose
--    `quantity_threshold_milli` marks over-threshold variances owner-only
--    at the resolve command and drives the submit's owner-notification
--    outbox event. Null = disabled, the same semantics as a missing row.
--
-- 3. The deferred indexes from PENDING: `count_variances(task_id)` (the
--    variances-by-task reads — the resolution surface's task→variance
--    lookups; the resolve command reads count_tasks by PK, so it is NOT the
--    epoch guard's path) and `skus(tenant_id, abc_class)` (the
--    scheduler's classed-SKU probe), both as plain CREATE INDEX — drizzle-kit
--    re-emits them from the schema (the snapshot carries them).
--
-- The CHECKs (widened status vocabulary, the frozen threshold, the policy's
-- non-negative threshold) and the new RLS policy are hand-appended below
-- (the 0008/0043/0044/0045 pattern — drizzle-kit generate is blind to both,
-- and the snapshot records `isRLSEnabled: false`, so the next generate must
-- not re-emit either).
--
-- ── 0. the fail-fast guard ────────────────────────────────────────────────
-- The table/column shape below is not idempotent — a hand-applied re-run or
-- an out-of-order application (0045 missing) would half-land or 42703.
-- Refuse loudly, the 0044 way: the new table checks both the ALTER target
-- and itself.
DO $$
BEGIN
	IF to_regclass('public.count_variances') IS NOT NULL AND to_regclass('public.count_variance_policies') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0046 has already been applied: "count_variance_policies" already exists and "count_variances" already carries its resolution columns. Re-running would half-land.';
	END IF;
	IF to_regclass('public.count_variance_policies') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0046 has already been applied: the "count_variance_policies" table already exists. Re-running would half-land.';
	END IF;
	IF to_regclass('public.count_variances') IS NULL THEN
		RAISE EXCEPTION 'migration 0046 is out of order: "count_variances" does not exist — migration 0045 must be applied first.';
	END IF;
	IF to_regclass('public.stock_adjustment_policies') IS NULL THEN
		RAISE EXCEPTION 'migration 0046 is out of order: "stock_adjustment_policies" does not exist — migration 0044 must be applied first.';
	END IF;
END $$;--> statement-breakpoint

CREATE TABLE "count_variance_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quantity_threshold_milli" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "count_variances" ADD COLUMN "threshold_quantity_milli" integer;--> statement-breakpoint
ALTER TABLE "count_variances" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "count_variances" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "count_variances" ADD COLUMN "recount_task_id" uuid;--> statement-breakpoint
ALTER TABLE "count_variances" ADD COLUMN "considered_event_seqs" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "count_variance_policies_tenant_id_unique" ON "count_variance_policies" USING btree ("tenant_id");--> statement-breakpoint
-- Story 5-4 (the snapshot's index) — the variances-by-task reads: the
-- resolution surface's task→variance lookups (the submit response's variance
-- card, the replay reads) resolve through the task id. The resolve command
-- itself reads count_tasks by PK; this index is not the epoch guard's path.
CREATE INDEX "count_variances_task_id_idx" ON "count_variances" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "skus_tenant_id_abc_class_idx" ON "skus" USING btree ("tenant_id","abc_class");--> statement-breakpoint

-- ── hand-appended: the 5-4 CHECKs + RLS (the 0044/0045 pattern) ───────────
-- `drizzle-kit generate` is blind to CHECKs and to RLS, so both are
-- hand-appended. The widened status vocabulary goes through DROP CONSTRAINT
-- then re-ADD (the `three-mirrored-layers` discipline's DB side — 5-3 pinned
-- it single-value, so the state list arrives as a replacement, not a new
-- name) — `0046_variance_resolution.sql` is the 005-4 vocabulary's migration.
--
-- No data statement for the re-ADD: every 5-3 row is `open` (the single
-- value the 0045 CHECK pinned), which conforms to the wide list — and there
-- is no resolved row to migrate because 0045's submit never wrote one.
-- The re-ADD statement, in this exact position, IS the proof of pass:
-- it fails loudly if any row carries a state outside the vocabulary.
ALTER TABLE "count_variances" DROP CONSTRAINT "count_variances_status_check";--> statement-breakpoint
ALTER TABLE "count_variances" ADD CONSTRAINT "count_variances_status_check" CHECK (
  "status" IN ('open', 'adjusted', 'recounted')
);--> statement-breakpoint
-- The frozen threshold stamp is the submit's context, never a guess: null =
-- no policy row (disabled), a stamped value is a non-negative threshold.
ALTER TABLE "count_variances" ADD CONSTRAINT "count_variances_threshold_check" CHECK (
  "threshold_quantity_milli" IS NULL OR "threshold_quantity_milli" >= 0
);--> statement-breakpoint
ALTER TABLE "count_variance_policies" ADD CONSTRAINT "count_variance_policies_threshold_check" CHECK (
  "quantity_threshold_milli" IS NULL OR "quantity_threshold_milli" >= 0
);--> statement-breakpoint
ALTER TABLE "count_variance_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "count_variance_policies_tenant_isolation" ON "count_variance_policies"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- (no data statements beyond the constraint re-ADD — the new columns start
-- null for existing `open` rows and `count_variance_policies` starts empty).
