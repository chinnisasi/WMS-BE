-- Story 9-1 — the operational dashboard's facts (the reporting read model).
--
-- Four things land here:
--   1. `pack_verification_failures` — one row per failed pack verification
--      (`pack-mismatch` from the scan-vs-picked check), on any of the three
--      entry paths (tenant route, device route, sync-report apply). SM-3's
--      "pack mismatches" half: nothing stored it before — the refusal rolled
--      everything back.
--   2. `ingest_backorder_refusals` — one row per channel order refused under
--      `backorder_policy = reject` (SM-4's "prevented" figure), deduped per
--      channel identity `(tenant, integration, external event)`: a webhook
--      redelivery mints a fresh idempotency key, so the key cannot dedupe.
--   3. `ledger_events (tenant_id, warehouse_id, type, recorded_at)` — the
--      reporting counts and the timeline's new type/from/to filters.
--   4. `app_metadata.reporting_facts_since` — the instant counting began.
--      There is NO backfill (the human decision): tiles reading the two fact
--      tables say "counting since <date>".
--
-- Both tables are OUTBOUND-owned (`test/architecture.spec.ts`) and written
-- best-effort: a failed fact write is logged and never changes the response.
-- No FKs (the repo convention). The `entry` CHECK and the RLS policies are
-- hand-appended below (the 0047 pattern — drizzle-kit is blind to both, and
-- the snapshot records `isRLSEnabled: false`).
--
-- THE INDEX IS A PLAIN BUILD, NOT CONCURRENTLY. drizzle's migrator runs every
-- pending migration inside ONE transaction, and `CREATE INDEX CONCURRENTLY`
-- cannot run inside a transaction block. A plain build holds a SHARE lock on
-- `ledger_events` for the build's duration: every ledger append (every pick,
-- putaway, receipt, adjustment) waits behind it. Accepted pre-launch, where
-- the table is small; for a LIVE deploy, follow the runbook recorded in
-- docs/design/PENDING.md (reporting) — build the index CONCURRENTLY by hand
-- under the same name first; this statement is then a no-op guarded below.
--
-- ── 0. the fail-fast guard ────────────────────────────────────────────────
DO $$
BEGIN
	IF to_regclass('public.pack_verification_failures') IS NOT NULL
		OR to_regclass('public.ingest_backorder_refusals') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0058 has already been applied: "pack_verification_failures" / "ingest_backorder_refusals" already exist. Re-running would half-land.';
	END IF;
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name = 'consignee_legal_name') = 0 THEN
		RAISE EXCEPTION 'migration 0058 is out of order: orders.consignee_legal_name does not exist — 0057 must be applied first.';
	END IF;
	IF EXISTS (SELECT 1 FROM app_metadata WHERE key = 'reporting_facts_since') THEN
		RAISE EXCEPTION 'migration 0058 has already been applied: app_metadata.reporting_facts_since exists.';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "ingest_backorder_refusals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"external_event_id" text NOT NULL,
	"lines" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_verification_failures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"entry" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"mismatch" jsonb NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_backorder_refusals_tenant_integration_event_unique" ON "ingest_backorder_refusals" USING btree ("tenant_id","integration_id","external_event_id");--> statement-breakpoint
CREATE INDEX "ingest_backorder_refusals_tenant_warehouse_created_at_idx" ON "ingest_backorder_refusals" USING btree ("tenant_id","warehouse_id","created_at");--> statement-breakpoint
-- A retry of the SAME failed pack (same Idempotency-Key, or the same
-- sync-report op re-applied) records no second row: the writer inserts
-- ON CONFLICT DO NOTHING against this partial unique.
CREATE UNIQUE INDEX "pack_verification_failures_tenant_key_unique" ON "pack_verification_failures" USING btree ("tenant_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE INDEX "pack_verification_failures_tenant_warehouse_created_at_idx" ON "pack_verification_failures" USING btree ("tenant_id","warehouse_id","created_at");--> statement-breakpoint
-- IF NOT EXISTS: the live-deploy runbook pre-builds this index CONCURRENTLY
-- under this exact name, after which this plain build must be a no-op.
CREATE INDEX IF NOT EXISTS "ledger_events_tenant_warehouse_type_recorded_at_idx" ON "ledger_events" USING btree ("tenant_id","warehouse_id","type","recorded_at");--> statement-breakpoint

-- ── hand-appended: the CHECK + RLS (the 0047 pattern) ─────────────────────
-- The vocabulary mirrors `PACK_FAILURE_ENTRIES` in `src/shared/db/schema.ts`.
ALTER TABLE "pack_verification_failures" ADD CONSTRAINT "pack_verification_failures_entry_check" CHECK (
  "entry" IN ('tenant', 'device', 'sync')
);--> statement-breakpoint
ALTER TABLE "pack_verification_failures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "pack_verification_failures_tenant_isolation" ON "pack_verification_failures"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "ingest_backorder_refusals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ingest_backorder_refusals_tenant_isolation" ON "ingest_backorder_refusals"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── the data statement: when counting began ───────────────────────────────
-- A JSON string holding the ISO-8601 UTC instant (`to_jsonb` of a
-- timestamptz renders it with its offset; the reporting read normalizes it).
-- Proved by the 0058 block in `test/reporting.spec.ts`.
INSERT INTO "app_metadata" ("id", "key", "value")
VALUES (gen_random_uuid(), 'reporting_facts_since', to_jsonb(now()));
