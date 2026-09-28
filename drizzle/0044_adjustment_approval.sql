-- Story 5-2 — Stock adjustment approval thresholds (FR-19): the inventory
-- module's two new tables, `stock_adjustment_pendings` + `stock_adjustment_policies`,
-- plus the closed adjustment reason vocabulary as a DB CHECK.
--
-- `stock_adjustment_policies` is the per-tenant opt-in (config-not-code): one
-- row per tenant whose `quantity_threshold` turns over-threshold adjustments
-- into PENDING rows. `stock_adjustment_pendings` parks those adjustments —
-- the converted signed delta, the reason/note and the resolved batch /
-- serial / handling-unit arms — until an `adjustments.approve` holder decides.
--
-- The CHECKs (pending status, the 8-value reason vocabulary, the signed
-- non-zero delta, the non-negative threshold) and the RLS policies are
-- hand-appended below (the 0008/0043 pattern — drizzle-kit generate is blind
-- to both, and the snapshot records `isRLSEnabled: false`, so the next
-- generate must not re-emit either). No FKs anywhere (repo convention). No
-- data migration: both tables start empty.
--
-- ── 0. the fail-fast guard ────────────────────────────────────────────────
-- The CREATE TABLEs below are not idempotent — a hand-applied re-run would
-- half-land (pendings created, policies refused). Refuse loudly, the
-- 0040/0043 way. BOTH tables are checked — `stock_adjustment_pendings` is
-- created first, so a guard that looked only at `stock_adjustment_policies`
-- would let a re-run past a tree where pendings already exists.
DO $$
BEGIN
	IF to_regclass('public.stock_adjustment_pendings') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0044 has already been applied: the "stock_adjustment_pendings" table already exists. Re-running would half-land (pendings skipped, policies re-created).';
	END IF;
	IF to_regclass('public.stock_adjustment_policies') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0044 has already been applied: the "stock_adjustment_policies" table already exists. Re-running would half-land.';
	END IF;
END $$;--> statement-breakpoint

CREATE TABLE "stock_adjustment_pendings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"bin_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"quantity_milli" bigint NOT NULL,
	"reason_code" text NOT NULL,
	"note" text NOT NULL,
	"batch_override_reason" text,
	"batch_id" uuid,
	"serial_ids" jsonb,
	"handling_unit_ids" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"threshold_quantity_at_request" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_adjustment_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quantity_threshold" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "stock_adjustment_pendings_tenant_status_created_at_id_idx" ON "stock_adjustment_pendings" USING btree ("tenant_id","status","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustment_policies_tenant_id_unique" ON "stock_adjustment_policies" USING btree ("tenant_id");
-- ── hand-appended: the CHECKs + RLS (the 0008/0043 pattern) ───────────────
-- `drizzle-kit generate` is blind to CHECKs and to RLS, so both are
-- migration-SQL-only: the status / reason / threshold vocabularies carry no
-- schema-side constraint objects and the snapshot records `isRLSEnabled:
-- false`, so the next generate must not re-emit either.
--
-- `stock_adjustment_pendings.status` is the pending-decision lifecycle of
-- story 5-2 (`pending | approved | rejected`). `reason_code` enumerates the
-- SAME eight-value closed vocabulary the API layer's `@IsIn` enforces over
-- `ADJUSTMENT_REASON_CODES` (src/modules/inventory/adjustment-reason.ts) —
-- `test/adjustment-approval.spec.ts` pins the TS list against this CHECK so
-- the mirrored copies cannot drift silently. `quantity_milli` is a signed
-- NON-zero milli-unit delta (a zero delta is a nothing adjustment, refused
-- at the DTO long before a pend row could exist; +/- direction is the
-- increase/decrease). `threshold_quantity_at_request` is non-negative (the
-- threshold is an absolute-quantity ceiling in base units). On the policy
-- table, `quantity_threshold` is nullable (null = flow disabled, the same
-- semantics as an absent row) and non-negative when present.
--
-- No data statement for the CHECKs: new tables, every row conforms.
ALTER TABLE "stock_adjustment_pendings" ADD CONSTRAINT "stock_adjustment_pendings_status_check" CHECK (
  "status" IN ('pending', 'approved', 'rejected')
);
ALTER TABLE "stock_adjustment_pendings" ADD CONSTRAINT "stock_adjustment_pendings_reason_code_check" CHECK (
  "reason_code" IN ('stock-count', 'damaged', 'expired', 'shrinkage', 'found', 'recall', 'system-correction', 'other')
);
ALTER TABLE "stock_adjustment_pendings" ADD CONSTRAINT "stock_adjustment_pendings_quantity_check" CHECK (
  "quantity_milli" <> 0
);
ALTER TABLE "stock_adjustment_pendings" ADD CONSTRAINT "stock_adjustment_pendings_threshold_check" CHECK (
  "threshold_quantity_at_request" >= 0
);
ALTER TABLE "stock_adjustment_policies" ADD CONSTRAINT "stock_adjustment_policies_quantity_threshold_check" CHECK (
  "quantity_threshold" IS NULL OR "quantity_threshold" >= 0
);
ALTER TABLE "stock_adjustment_pendings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stock_adjustment_pendings_tenant_isolation" ON "stock_adjustment_pendings"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "stock_adjustment_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stock_adjustment_policies_tenant_isolation" ON "stock_adjustment_policies"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);