CREATE TYPE "public"."user_role" AS ENUM('owner', 'ops_manager', 'operator', 'accountant');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reference" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "user_role" DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invite_token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invite_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "audit_events_tenant_id_occurred_at_idx" ON "audit_events" USING btree ("tenant_id","occurred_at");
-- Story 1.5 hand-append: every user that existed before this migration was
-- created by tenant registration (the only user-creating path until now), so
-- they are all Owners — the 'operator' column default would otherwise demote
-- them on deploy.
UPDATE "users" SET "role" = 'owner';
--> statement-breakpoint
-- AD-3 defense-in-depth (Story 1.5): RLS on the new audit_events table, the
-- same fail-closed single-dimension policy as 0001/0003/0004
-- (`tenant_isolation`). The `users` policy already exists (0001) and still
-- matches — this migration only adds columns. The `current_setting(..., true)`
-- empty-string NULLIF guard is load-bearing (Postgres 18 returns '' after a
-- transaction-local value expires) so an un-scoped session fails closed (sees
-- zero rows) instead of erroring.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_events_tenant_isolation" ON "audit_events"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);