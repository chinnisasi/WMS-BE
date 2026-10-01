-- ── hand-appended (the 0050 pattern): story 7-2's ingest config ────────────
-- `integrations.ingest_warehouse_id` (RD-4): the ONE ingest warehouse every
-- webhook-created order lands on; nullable until the config PUT sets it.
-- Migration + journal entry + snapshot git-added together; `bun run
-- db:generate` after this reports "No schema changes".
-- drizzle-kit generate is blind to CHECKs; the vocabulary additions below are
-- drop-and-recreate amendments of 0050's constraints (nothing is widened
-- silently — the TS tuples in `src/shared/db/schema.ts` mirror these lists).
--
--  `INTEGRATION_CALL_KINDS` gains `order-ingest` (RD-9's per-delivery ingest
--  decision rows) and `order-writeback` (RD-7's writeback settle rows).
--  `INTEGRATION_CALL_STATUSES` gains the ingest/writeback OUTCOME statuses
--  (a refused ingest is a status, never a failure — RD-9).

DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'integrations' AND column_name = 'ingest_warehouse_id') <> 0 THEN
		RAISE EXCEPTION 'migration 0051 has already been applied: integrations.ingest_warehouse_id already exists. Re-running would half-land.';
	END IF;
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'integrations' AND column_name = 'backorder_policy') = 0 THEN
		RAISE EXCEPTION 'migration 0051 is out of order: integrations.backorder_policy does not exist — migration 0050 must be applied first.';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "ingest_warehouse_id" uuid;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_ingest_warehouse_id_uuid_shape" CHECK (
  "ingest_warehouse_id" IS NULL OR "ingest_warehouse_id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);--> statement-breakpoint
ALTER TABLE "integration_calls" DROP CONSTRAINT "integration_calls_kind_check";--> statement-breakpoint
ALTER TABLE "integration_calls" ADD CONSTRAINT "integration_calls_kind_check" CHECK (
  "kind" IN ('availability-sync', 'credential-revoke', 'order-ingest', 'order-writeback')
);--> statement-breakpoint
ALTER TABLE "integration_calls" DROP CONSTRAINT "integration_calls_status_check";--> statement-breakpoint
ALTER TABLE "integration_calls" ADD CONSTRAINT "integration_calls_status_check" CHECK (
  "status" IN ('ok', 'failed',
    'accepted', 'backordered', 'replayed', 'rejected', 'conflict', 'unmapped',
    'validation-failed', 'warehouse-unset', 'config-invalid',
    'verification-failed', 'actor-unprivileged',
    'released', 'ignored', 'cancellation-unresolved')
);

-- (no data statements — the new column starts empty on every row; nothing to
-- backfill. No new RLS policy: the column lives on the already fail-closed
-- `integrations` table — the pinned policy count is unchanged.)