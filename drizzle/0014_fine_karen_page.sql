CREATE TABLE "qc_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"bin_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"held_by" uuid NOT NULL,
	"held_at" timestamp with time zone NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "qc_holds_open_scope_unique" ON "qc_holds" USING btree ("tenant_id","warehouse_id","sku_id","bin_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "qc_holds_tenant_status_created_at_id_idx" ON "qc_holds" USING btree ("tenant_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "qc_holds_tenant_created_at_id_idx" ON "qc_holds" USING btree ("tenant_id","created_at","id");-- Story 3.4 hand-append (the 0005→0013 RLS policy pattern): RLS is declared
-- only in migration SQL, never in schema.ts. Fail-closed single-dimension
-- `tenant_isolation` on the new holds table — a session without
-- `app.tenant_id` sees zero rows. Every read/write runs in an explicitly
-- tenant-scoped transaction.
ALTER TABLE "qc_holds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "qc_holds_tenant_isolation" ON "qc_holds"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Story 3.4 hand-append: a typo'd hold status would drop the row out of every
-- status-filtered consumer — the state set is DB-enforced (text + CHECK per
-- the repo convention; no pgEnum).
ALTER TABLE "qc_holds" ADD CONSTRAINT "qc_holds_status_check" CHECK ("status" IN ('open','released'));
--> statement-breakpoint
-- A released row carries who released it and when; an open row carries
-- neither. The DB backstop behind the command's conditional UPDATE.
ALTER TABLE "qc_holds" ADD CONSTRAINT "qc_holds_release_pairing" CHECK (
	("status" = 'open' AND "released_by" IS NULL AND "released_at" IS NULL)
	OR ("status" = 'released' AND "released_by" IS NOT NULL AND "released_at" IS NOT NULL)
);
