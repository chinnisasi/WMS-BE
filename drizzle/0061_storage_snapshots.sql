-- ── hand-amended (the 0058/0060 pattern): story 21-4, metering and storage snapshots ──
-- Three things land here, NO foreign keys (house rule — uuid columns
-- validated in the transaction that writes them):
--   storage_snapshots         — one row per (client, warehouse, IST day, SKU
--                               base UoM): the client's on-hand base
--                               milli-units at the END of the IST day, folded
--                               from the ledger (AD-25 — a rebuildable
--                               projection, not a book). Only positive values
--                               are stored; a zero day has no row.
--   storage_snapshot_progress — the snapshot job's per-(client, warehouse)
--                               watermark: the last day written, the running
--                               per-uom on-hand at its end, and the IST day
--                               the drift check last ran. Born only when the
--                               scope's first day is written under the commit
--                               guarantee (no transaction that began before
--                               the day's end still open — pg_stat_activity).
--   ledger_events (tenant_id, client_id, warehouse_id, recorded_at) — the
--                               storage fold and the scope discovery (no
--                               client_id index existed before).
--   ledger_events (tenant_id, client_id, type, recorded_at) — the metering
--                               read's dispatched-order count, across
--                               warehouses.
--   storage_snapshots (tenant_id, client_id, snapshot_date) — the metering
--                               read's per-client sums across warehouses.
--
-- THE INDEXES ARE PLAIN BUILDS, NOT CONCURRENTLY (0058's reasoning, unchanged):
-- drizzle's migrator runs every pending migration inside ONE transaction, and
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. A plain
-- build holds a SHARE lock on ledger_events while it runs — every ledger
-- append waits behind it. Accepted pre-launch, where the table is small; for
-- a LIVE deploy follow 0058's runbook (build it CONCURRENTLY by hand first —
-- the two ledger CREATEs below then need IF NOT EXISTS in that deploy's copy).
--
-- drizzle-kit is blind to CHECKs and RLS — both hand-written below. The
-- journal entry and snapshot are git-added with this file, and
-- `bun run db:generate` afterwards reports "No schema changes".
--
-- No data: purely additive. Proven by the 0061 block in
-- `test/metering.spec.ts` (the tables, the CHECK, the policies, the guard).

-- ── 0. the fail-fast guard ────────────────────────────────────────────────
DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'storage_snapshots') <> 0 THEN
		RAISE EXCEPTION 'migration 0061 has already been applied: storage_snapshots already exists.';
	END IF;
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'rate_cards') = 0 THEN
		RAISE EXCEPTION 'migration 0061 is out of order: rate_cards does not exist — 0060 must be applied first.';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "storage_snapshot_progress" (
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"last_day" date NOT NULL,
	"running" jsonb NOT NULL,
	"drift_checked_on" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_snapshot_progress_tenant_id_client_id_warehouse_id_pk" PRIMARY KEY("tenant_id","client_id","warehouse_id")
);
--> statement-breakpoint
CREATE TABLE "storage_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"uom" text NOT NULL,
	"on_hand_milli" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "storage_snapshots_scope_day_uom_unique" ON "storage_snapshots" USING btree ("tenant_id","client_id","warehouse_id","snapshot_date","uom");--> statement-breakpoint
CREATE INDEX "storage_snapshots_tenant_client_date_idx" ON "storage_snapshots" USING btree ("tenant_id","client_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "ledger_events_tenant_client_warehouse_recorded_at_idx" ON "ledger_events" USING btree ("tenant_id","client_id","warehouse_id","recorded_at");--> statement-breakpoint
CREATE INDEX "ledger_events_tenant_client_type_recorded_at_idx" ON "ledger_events" USING btree ("tenant_id","client_id","type","recorded_at");--> statement-breakpoint
-- ── hand-amended: the CHECKs (migration SQL only) ──
-- A snapshot row exists only for a positive closing stock: a zero day is
-- recorded by the watermark passing it, never by a zero row.
ALTER TABLE "storage_snapshots" ADD CONSTRAINT "storage_snapshots_on_hand_positive" CHECK (
	"on_hand_milli" > 0
);--> statement-breakpoint
-- ── hand-amended: RLS — the AD-24 clause, READ-ONLY for a client session ──
-- 0060's shape exactly: reads carry 0041's null-tolerant client clause (an
-- operator sees the tenant; a portal session only its own client's rows);
-- writes are OPERATOR-ONLY — with `app.client_id` set, INSERT/UPDATE/DELETE
-- bind nothing. Split per command because a FOR ALL policy's WITH CHECK
-- does not cover DELETE.
ALTER TABLE "storage_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storage_snapshot_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "storage_snapshots_tenant_isolation" ON "storage_snapshots" FOR SELECT
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR "client_id" = NULLIF(current_setting('app.client_id', true), '')::uuid
		)
	);--> statement-breakpoint
CREATE POLICY "storage_snapshots_operator_insert" ON "storage_snapshots" FOR INSERT
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "storage_snapshots_operator_update" ON "storage_snapshots" FOR UPDATE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "storage_snapshots_operator_delete" ON "storage_snapshots" FOR DELETE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "storage_snapshot_progress_tenant_isolation" ON "storage_snapshot_progress" FOR SELECT
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR "client_id" = NULLIF(current_setting('app.client_id', true), '')::uuid
		)
	);--> statement-breakpoint
CREATE POLICY "storage_snapshot_progress_operator_insert" ON "storage_snapshot_progress" FOR INSERT
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "storage_snapshot_progress_operator_update" ON "storage_snapshot_progress" FOR UPDATE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "storage_snapshot_progress_operator_delete" ON "storage_snapshot_progress" FOR DELETE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);
