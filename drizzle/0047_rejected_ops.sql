-- Story 5-6 — AD-14 quarantine residents: the durable end of the replay
-- drop. A device's outbox walk deletes every terminal refused op (the
-- `rejected` and case-4 `quarantined` fates); until now they survived only
-- as an in-memory sync-summary line. `rejected_ops` gives each one a
-- server-side row: tenancy-owned (the spec's Design Notes — the resource is
-- a report of a device sync outcome, op-type-generic across
-- receive/pick/putaway/pack/count/transfer, and tenancy owns the device
-- contract the upload rides), uploaded by a new device sync-report route,
-- deduped per (tenant, op_id) so at-least-once uploads are safe, and
-- resolved from the web Conflicts & Reviews tab by the existing
-- `review.decide` set (no new capability — the mirror stays at 31).
--
-- The snapshot itself carries the table + its two indexes (the unique dedupe
-- pair and the keyset read). The CHECKs (classification + status
-- vocabularies — the three-mirrored-layers discipline's DB side) and the RLS
-- policy are hand-appended below (the 0046 pattern — drizzle-kit generate is
-- blind to both, and the snapshot records `isRLSEnabled: false`, so the next
-- generate must not re-emit either).
--
-- ── 0. the fail-fast guard ────────────────────────────────────────────────
-- The CREATE below is not idempotent — a hand-applied re-run would half-land
-- and an out-of-order application (0046 missing) would fail 42703 on nothing
-- it depends on but still land out of order. Refuse loudly, the 0046 way.
DO $$
BEGIN
	IF to_regclass('public.rejected_ops') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0047 has already been applied: the "rejected_ops" table already exists. Re-running would half-land.';
	END IF;
	IF to_regclass('public.count_variances') IS NULL THEN
		RAISE EXCEPTION 'migration 0047 is out of order: "count_variances" does not exist — migration 0046 must be applied first.';
	END IF;
END $$;--> statement-breakpoint

CREATE TABLE "rejected_ops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"operator_user_id" uuid NOT NULL,
	"op_id" text NOT NULL,
	"op_type" text NOT NULL,
	"classification" text NOT NULL,
	"problem_code" text NOT NULL,
	"problem_detail" text,
	"payload" jsonb NOT NULL,
	"attribution" jsonb NOT NULL,
	"op_enqueued_at" timestamp with time zone NOT NULL,
	"op_occurred_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "rejected_ops_tenant_id_op_id_unique" ON "rejected_ops" USING btree ("tenant_id","op_id");--> statement-breakpoint
CREATE INDEX "rejected_ops_tenant_status_created_at_id_idx" ON "rejected_ops" USING btree ("tenant_id","status","created_at","id");

-- ── hand-appended: the 5-6 CHECKs + RLS (the 0046 pattern) ────────────────
-- `drizzle-kit generate` is blind to CHECKs and to RLS, so both are
-- hand-appended. `op_id` is the mobile op's ULID (not a uuid — the client
-- minted it) and its dedupe pair is the unique index above; the
-- vocabularies below mirror the TS tuples in `src/shared/db/schema.ts`
-- (`REJECTED_OP_CLASSIFICATIONS`, `REJECTED_OP_STATUSES`).
ALTER TABLE "rejected_ops" ADD CONSTRAINT "rejected_ops_classification_check" CHECK (
  "classification" IN ('rejected', 'quarantined')
);--> statement-breakpoint
ALTER TABLE "rejected_ops" ADD CONSTRAINT "rejected_ops_status_check" CHECK (
  "status" IN ('open', 'applied', 'recounted', 'discarded')
);--> statement-breakpoint
ALTER TABLE "rejected_ops" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rejected_ops_tenant_isolation" ON "rejected_ops"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- (no data statements — the table starts empty; nothing to backfill).
