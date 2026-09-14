CREATE TABLE "bin_state_epochs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"bin_id" uuid NOT NULL,
	"epoch" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "picks" ADD COLUMN "conflict_class" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bin_state_epochs_scope_unique" ON "bin_state_epochs" USING btree ("tenant_id","warehouse_id","bin_id");--> statement-breakpoint
-- Story 4.3b hand-append (the 0006-0010/0019 RLS + CHECK pattern): RLS is
-- declared only in migration SQL, never in schema.ts. The same fail-closed
-- single-dimension `tenant_isolation` policy the sibling inventory
-- projections carry; the `current_setting(..., true)` empty-string NULLIF
-- guard is load-bearing (Postgres 18 returns '' once a transaction-local
-- value expires) so an un-scoped session sees zero rows instead of erroring.
ALTER TABLE "bin_state_epochs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bin_state_epochs_tenant_isolation" ON "bin_state_epochs"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- The epoch is opaque and MONOTONIC: it only ever moves forward, and it is
-- never zero (a zero would be indistinguishable from "no row" on the wire).
ALTER TABLE "bin_state_epochs" ADD CONSTRAINT "bin_state_epochs_epoch_positive" CHECK ("epoch" > 0);--> statement-breakpoint
-- Backfill: without it the taxonomy is INERT on deploy. Every bin already
-- holding stock would read `epoch = null`, which the pick command treats as a
-- match (a bin no movement has ever touched has nothing to be stale against),
-- so no queued pick could be classified until that bin's NEXT movement minted
-- a row — a silent, bin-by-bin ramp-up across the whole existing warehouse,
-- with a device holding a pre-deploy task getting today's undifferentiated
-- 422 in the meantime. Seeding 1 for every distinct bin the projection knows
-- makes the comparison live from the first replay after deploy. A device's
-- cached snapshot predates the epoch either way, so it sends none and is
-- treated as a match — nothing is misclassified by the seed itself.
INSERT INTO "bin_state_epochs" ("id", "tenant_id", "warehouse_id", "bin_id", "epoch")
SELECT gen_random_uuid(), "tenant_id", "warehouse_id", "bin_id", 1
FROM (SELECT DISTINCT "tenant_id", "warehouse_id", "bin_id" FROM "stock_on_hand") AS "scoped"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The AD-14 taxonomy's two SUCCESS arms are the only classes a stored pick
-- can carry: the two refusal arms (`pick-bin-short`, `pick-unresolvable`)
-- write nothing, so no row can ever be stamped with them.
ALTER TABLE "picks" ADD CONSTRAINT "picks_conflict_class_check" CHECK ("conflict_class" IN ('none','applied','settled'));
