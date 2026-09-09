CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operator_user_id" uuid,
	"label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"wipe_flag" boolean DEFAULT false NOT NULL,
	"enrollment_code_hash" text,
	"enrollment_code_expires_at" timestamp with time zone,
	"enrolled_at" timestamp with time zone,
	"pin_hash" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "devices_enrollment_code_hash_unique" ON "devices" USING btree ("enrollment_code_hash") WHERE enrollment_code_hash is not null;--> statement-breakpoint
CREATE INDEX "devices_created_at_id_idx" ON "devices" USING btree ("created_at","id");--> statement-breakpoint
-- Story 3.2 hand-append (the audit_events tenant-led convention): every
-- per-tenant list/pagination query filters tenant_id first — without a
-- tenant-led index each probe scans the whole table.
CREATE INDEX "devices_tenant_id_created_at_id_idx" ON "devices" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
-- Story 3.2 hand-append (the 0005→0011 RLS policy pattern): RLS is declared
-- only in migration SQL, never in schema.ts. Fail-closed single-dimension
-- `tenant_isolation` on tenancy-owned `devices` — a session without
-- `app.tenant_id` sees zero rows. Every read/write runs in an explicitly
-- tenant-scoped transaction.
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "devices_tenant_isolation" ON "devices"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Story 3.2 hand-append: a typo'd lifecycle status would drop the row out of
-- every status-filtered consumer — the state set is DB-enforced (text + CHECK
-- per the repo convention; no pgEnum). Revocation is one-way; un-revoking is
-- not a state.
ALTER TABLE "devices" ADD CONSTRAINT "devices_status_check" CHECK ("status" IN ('active','revoked'));