-- ── hand-appended: the 7-1 CHECKs + RLS (the 0048/0049 pattern) ───────────
-- The vocabularies below mirror the TS tuples in `src/shared/db/schema.ts`
-- (`CHANNEL_PROVIDERS`, `INTEGRATION_STATUSES`, `INTEGRATION_BREAKER_STATES`,
-- `BACKORDER_POLICIES`, `INTEGRATION_CALL_KINDS`, `INTEGRATION_CALL_STATUSES`).
-- drizzle-kit generate is blind to CHECKs and to RLS, and the snapshot
-- records `isRLSEnabled: false`, so the next generate must not re emit either.
--
-- Also the standing-arm backstop on the EXISTING `reservations` table: a row
-- with `expires_at` NULL is admitted ONLY for `owner_type = 'buffer'` (story
-- 7.1, AD-13) — every other hold keeps an expiry (the reaper's bound).
--
-- ── 0. the fail-fast guard (the 0049 pattern) ─────────────────────────────
DO $$
BEGIN
	IF to_regclass('public.integrations') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0050 has already been applied: the "integrations" table already exists. Re-running would half-land.';
	END IF;
	IF to_regclass('public.batch_alerts') IS NULL THEN
		RAISE EXCEPTION 'migration 0050 is out of order: "batch_alerts" does not exist — migration 0049 must be applied first.';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "channel_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"sku_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"error" text,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"credential_sealed" text,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"backorder_policy" text DEFAULT 'accept' NOT NULL,
	"connected_by" uuid NOT NULL,
	"rotated_at" timestamp with time zone,
	"rotated_by" uuid,
	"last_synced_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"breaker_state" text DEFAULT 'closed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reservations" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_mappings_integration_ref_unique" ON "channel_mappings" USING btree ("tenant_id","integration_id","external_ref");--> statement-breakpoint
CREATE INDEX "channel_mappings_tenant_integration_idx" ON "channel_mappings" USING btree ("tenant_id","integration_id");--> statement-breakpoint
CREATE INDEX "integration_calls_tenant_integration_at_idx" ON "integration_calls" USING btree ("tenant_id","integration_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_tenant_provider_unique" ON "integrations" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "integrations_tenant_created_at_id_idx" ON "integrations" USING btree ("tenant_id","created_at","id");


ALTER TABLE "reservations" ADD CONSTRAINT "reservations_expires_at_standing_rule_check" CHECK (
  "owner_type" = 'buffer' OR "expires_at" IS NOT NULL
);--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_provider_check" CHECK (
  "provider" IN ('shopify', 'amazon-in', 'flipkart')
);--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_status_check" CHECK (
  "status" IN ('connected', 'disconnected')
);--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_backorder_policy_check" CHECK (
  "backorder_policy" IN ('accept', 'reject')
);--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_breaker_state_check" CHECK (
  "breaker_state" IN ('closed', 'open', 'half-open')
);--> statement-breakpoint
-- The carriers precedent (0025): sealed credential material must carry the
-- envelope prefix — raw provider material can never be stored.
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_credential_sealed_envelope" CHECK (
  "credential_sealed" LIKE 'v1:%'
);--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_consecutive_failures_nonnegative_check" CHECK (
  "consecutive_failures" >= 0
);--> statement-breakpoint
ALTER TABLE "channel_mappings" ADD CONSTRAINT "channel_mappings_external_ref_nonempty_check" CHECK (
  "external_ref" <> ''
);--> statement-breakpoint
ALTER TABLE "integration_calls" ADD CONSTRAINT "integration_calls_kind_check" CHECK (
  "kind" IN ('availability-sync', 'credential-revoke')
);--> statement-breakpoint
ALTER TABLE "integration_calls" ADD CONSTRAINT "integration_calls_status_check" CHECK (
  "status" IN ('ok', 'failed')
);--> statement-breakpoint
ALTER TABLE "integration_calls" ADD CONSTRAINT "integration_calls_latency_nonnegative_check" CHECK (
  "latency_ms" IS NULL OR "latency_ms" >= 0
);--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "integrations_tenant_isolation" ON "integrations"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "channel_mappings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "channel_mappings_tenant_isolation" ON "channel_mappings"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "integration_calls" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "integration_calls_tenant_isolation" ON "integration_calls"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- (no data statements — the tables start empty; nothing to backfill).
