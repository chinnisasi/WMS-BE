-- ── hand-amended (the 0051 pattern): story 7-2's reviewed patch round ──────
-- `channel_mappings.inventory_item_id` (RD-6, amended by human negotiation —
-- spec change-log entry 7): the resolved numeric Shopify inventory_item_id
-- the availability-publish arm last resolved the mapped ref as, cached per
-- mapping row so a publish cycle never posts the WMS `skuId` uuid as the
-- channel's `inventory_item_ids`. Nullable; set only by the arm's resolution
-- write-back, cleared by every mapping PUT (a re-mapped ref's cached id
-- belongs to the old ref and must not survive it).
-- Migration + journal entry + snapshot git-added together; `bun run
-- db:generate` after this reports "No schema changes".
-- drizzle-kit generate is blind to CHECKs; the vocabulary addition below is
-- a drop-and-recreate amendment of 0051's constraint (nothing is widened
-- silently — the TS tuple in `src/shared/db/schema.ts` mirrors this list).
--
--  `INTEGRATION_CALL_STATUSES` gains `item-unresolved` (an unresolvable
--  variant lookup meters a typed refusal — a meted status, never a "failed"
--  transport verdict and never breaker/health pressure — RD-6/RD-9 amended).

DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'channel_mappings' AND column_name = 'inventory_item_id') <> 0 THEN
		RAISE EXCEPTION 'migration 0052 has already been applied: channel_mappings.inventory_item_id already exists. Re-running would half-land.';
	END IF;
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'channel_mappings' AND column_name = 'sku_id') = 0 THEN
		RAISE EXCEPTION 'migration 0052 is out of order: channel_mappings.sku_id does not exist — migration 0050 must be applied first.';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "channel_mappings" ADD COLUMN "inventory_item_id" bigint;--> statement-breakpoint
ALTER TABLE "integration_calls" DROP CONSTRAINT "integration_calls_status_check";--> statement-breakpoint
ALTER TABLE "integration_calls" ADD CONSTRAINT "integration_calls_status_check" CHECK (
  "status" IN ('ok', 'failed',
    'accepted', 'backordered', 'replayed', 'rejected', 'conflict', 'unmapped',
    'validation-failed', 'warehouse-unset', 'config-invalid',
    'verification-failed', 'actor-unprivileged',
    'item-unresolved',
    'released', 'ignored', 'cancellation-unresolved')
);

-- (no data statements — the new column starts empty on every row; nothing to
-- backfill. No new RLS policy: the column lives on the already fail-closed
-- `channel_mappings` table — the pinned policy count is unchanged.)