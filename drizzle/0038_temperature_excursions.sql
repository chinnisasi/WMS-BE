CREATE TABLE "temperature_excursions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"bin_id" uuid NOT NULL,
	"reading_c" numeric(6, 2) NOT NULL,
	"note" text,
	"hold_ids" uuid[] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"recorded_by" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "temperature_excursions_tenant_created_at_id_idx" ON "temperature_excursions" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "temperature_excursions_tenant_status_idx" ON "temperature_excursions" USING btree ("tenant_id","status");
-- ── hand-appended: the status CHECK + RLS (the 0008 pattern) ────────────────
-- Story 12-5 (AD-18). `drizzle-kit generate` is blind to CHECKs and to RLS,
-- so both are migration-SQL-only: `temperature_excursions.status` carries no
-- schema-side constraint object and the snapshot records `isRLSEnabled: false`
-- (the documented drizzle-orm gap), so the next generate must not re-emit
-- either. The vocabulary is the two-valued review lifecycle of story 12-5's
-- resolve command. No data statement: a new table, every row conforms.
ALTER TABLE "temperature_excursions" ADD CONSTRAINT "temperature_excursions_status_check" CHECK (
  "status" IN ('open', 'resolved')
);
ALTER TABLE "temperature_excursions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "temperature_excursions_tenant_isolation" ON "temperature_excursions"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
