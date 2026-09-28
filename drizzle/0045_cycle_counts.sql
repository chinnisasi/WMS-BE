-- Story 5-3 — Cycle count scheduling and execution (FR-cycle-count): the
-- movements module's four count tables — `count_policies` (the per-warehouse
-- ABC schedule), `count_tasks` (the STORED per-bin task: expected-at-start
-- lives on the lines, the bin epoch frozen as a scalar), `count_task_lines`
-- (the per-SKU expected/counted rows) and `count_variances` (the open rows
-- 5-4 resolves) — plus `skus.abc_class` (OQ-1: nullable, null = excluded
-- from scheduled generation).
--
-- The CHECKs (task status/origin, non-negative quantities, the abc_class
-- vocabulary, positive intervals) and the RLS policies are hand-appended
-- below (the 0008/0043/0044 pattern — drizzle-kit generate is blind to
-- both, and the snapshot records `isRLSEnabled: false`, so the next
-- generate must not re-emit either). No FKs anywhere (repo convention; the
-- task_id/sku_id/bin_id refs are validated in the command transaction). No
-- data migration: the tables start empty and `skus.abc_class` starts null
-- (no backfill — a guessed class would silently schedule every legacy SKU
-- for counts).
--
-- ── 0. the fail-fast guard ────────────────────────────────────────────────
-- The CREATE TABLEs are not idempotent — a hand-applied re-run would
-- half-land (count_tasks created, the rest refused). Refuse loudly, the
-- 0040/0043/0044 way.
DO $$
BEGIN
	IF to_regclass('public.count_tasks') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0045 has already been applied: the "count_tasks" table already exists. Re-running would half-land (count_tasks skipped, the rest re-created).';
	END IF;
	IF to_regclass('public.count_policies') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0045 has already been applied: the "count_policies" table already exists. Re-running would half-land.';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "count_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"abc_class" text NOT NULL,
	"interval_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "count_task_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"expected_quantity_milli" bigint NOT NULL,
	"counted_quantity_milli" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "count_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"bin_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"origin" text NOT NULL,
	"bin_state_epoch" bigint,
	"created_by" uuid,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "count_variances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"bin_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"expected_quantity_milli" bigint NOT NULL,
	"counted_quantity_milli" bigint NOT NULL,
	"delta_milli" bigint NOT NULL,
	"epoch_conflict" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "abc_class" text;--> statement-breakpoint
CREATE UNIQUE INDEX "count_policies_tenant_wh_class_unique" ON "count_policies" USING btree ("tenant_id","warehouse_id","abc_class");--> statement-breakpoint
CREATE INDEX "count_task_lines_task_id_idx" ON "count_task_lines" USING btree ("task_id","sku_id");--> statement-breakpoint
CREATE INDEX "count_tasks_tenant_wh_bin_status_idx" ON "count_tasks" USING btree ("tenant_id","warehouse_id","bin_id","status");--> statement-breakpoint
CREATE INDEX "count_tasks_wh_status_idx" ON "count_tasks" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE INDEX "count_variances_tenant_status_created_at_id_idx" ON "count_variances" USING btree ("tenant_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "count_variances_warehouse_id_idx" ON "count_variances" USING btree ("warehouse_id");
-- ── hand-appended: the CHECKs + RLS (the 0008/0043/0044 pattern) ──────────
-- `drizzle-kit generate` is blind to CHECKs and to RLS, so both are
-- migration-SQL-only: the status / origin / abc_class vocabularies carry no
-- schema-side constraint objects and the snapshot records `isRLSEnabled:
-- false`, so the next generate must not re-emit either.
--
-- `count_tasks.status` is the two-value lifecycle (`pending | completed`) —
-- the conditional-UPDATE submit makes a second submit of a settled task a
-- deterministic 409. `count_tasks.origin` is the three-value birth
-- vocabulary (`on_demand | scheduled | recount`). `bin_state_epoch` is
-- nullable bigint (null = the bin had no epoch row at task start) and
-- NON-NEGATIVE when present (epochs mint from 0 upward — the ledger fold's
-- counter). `created_by` / `completed_by` are nullable uuids with NO
-- default; `created_by` null = the scheduler minted the task.
--
-- `count_policies.abc_class` enumerates the SAME three-value vocabulary the
-- API layer's `@IsIn` enforces over `ABC_CLASSES`
-- (src/shared/primitives/abc-class.ts) — pinned against this CHECK by
-- `test/count.spec.ts` so the mirrored copies cannot drift silently.
-- `interval_days` is strictly positive (a zero-day interval would re-count
-- every tick).
--
-- `count_task_lines` quantities are NON-NEGATIVE milli-units: an expected
-- quantity is a bin's on-hand (never negative; 0 = a beyond-task SKU's
-- appended line), a counted quantity is what the operator entered (0 is a
-- valid explicit count). `counted_quantity_milli` is nullable (null = not
-- yet counted; an absent value refuses the submit — 400 `count-incomplete`).
--
-- `count_variances` carries the settled row: both quantities NOT NULL and
-- non-negative, `delta_milli` = counted − expected exactly (a signed
-- consistency CHECK pins the arithmetic), `status` is exactly `open` in 5-3
-- (5-4 owns every later state — its states arrive as their own migration),
-- and `epoch_conflict` is the OQ-2 flag.
--
-- `skus.abc_class` enumerates the same vocabulary when present (nullable).
--
-- No data statement for the CHECKs: new tables, every row conforms.
ALTER TABLE "count_policies" ADD CONSTRAINT "count_policies_abc_class_check" CHECK (
  "abc_class" IN ('a', 'b', 'c')
);
ALTER TABLE "count_policies" ADD CONSTRAINT "count_policies_interval_check" CHECK (
  "interval_days" > 0
);
ALTER TABLE "count_tasks" ADD CONSTRAINT "count_tasks_status_check" CHECK (
  "status" IN ('pending', 'completed')
);
ALTER TABLE "count_tasks" ADD CONSTRAINT "count_tasks_origin_check" CHECK (
  "origin" IN ('on_demand', 'scheduled', 'recount')
);
ALTER TABLE "count_tasks" ADD CONSTRAINT "count_tasks_epoch_check" CHECK (
  "bin_state_epoch" IS NULL OR "bin_state_epoch" >= 0
);
ALTER TABLE "count_task_lines" ADD CONSTRAINT "count_task_lines_expected_check" CHECK (
  "expected_quantity_milli" >= 0
);
ALTER TABLE "count_task_lines" ADD CONSTRAINT "count_task_lines_counted_check" CHECK (
  "counted_quantity_milli" IS NULL OR "counted_quantity_milli" >= 0
);
ALTER TABLE "count_variances" ADD CONSTRAINT "count_variances_expected_check" CHECK (
  "expected_quantity_milli" >= 0
);
ALTER TABLE "count_variances" ADD CONSTRAINT "count_variances_counted_check" CHECK (
  "counted_quantity_milli" >= 0
);
ALTER TABLE "count_variances" ADD CONSTRAINT "count_variances_delta_check" CHECK (
  "delta_milli" = "counted_quantity_milli" - "expected_quantity_milli"
);
ALTER TABLE "count_variances" ADD CONSTRAINT "count_variances_status_check" CHECK (
  "status" IN ('open')
);
ALTER TABLE "skus" ADD CONSTRAINT "skus_abc_class_check" CHECK (
  "abc_class" IS NULL OR "abc_class" IN ('a', 'b', 'c')
);
ALTER TABLE "count_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "count_policies_tenant_isolation" ON "count_policies"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "count_tasks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "count_tasks_tenant_isolation" ON "count_tasks"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "count_task_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "count_task_lines_tenant_isolation" ON "count_task_lines"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "count_variances" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "count_variances_tenant_isolation" ON "count_variances"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);