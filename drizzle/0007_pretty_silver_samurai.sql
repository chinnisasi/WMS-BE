CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outbox_messages_tenant_status_next_attempt_idx" ON "outbox_messages" USING btree ("tenant_id","status","next_attempt_at","created_at");
-- Story outbox-relay hand-append (the 0006 RLS policy pattern): RLS is
-- declared only in migration SQL, never in schema.ts. Same fail-closed
-- single-dimension `tenant_isolation` policy. The `current_setting(..., true)`
-- empty-string NULLIF guard is load-bearing (Postgres 18 returns '' after a
-- transaction-local value expires) so an un-scoped session fails closed (sees
-- zero rows) instead of erroring. The relay's one cross-tenant read (tenant
-- discovery) deliberately runs on the BYPASSRLS connection; every row
-- mutation stays in an explicitly tenant-scoped transaction.
ALTER TABLE "outbox_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "outbox_messages_tenant_isolation" ON "outbox_messages"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);