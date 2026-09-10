CREATE TABLE "putaway_placements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"grn_id" uuid NOT NULL,
	"grn_line_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"batch_id" uuid,
	"qty" integer NOT NULL,
	"from_bin_id" uuid NOT NULL,
	"to_bin_id" uuid NOT NULL,
	"suggested_bin_id" uuid,
	"reason_code" text,
	"placed_by" uuid NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"device_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "putaway_placements_tenant_warehouse_created_at_id_idx" ON "putaway_placements" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE INDEX "putaway_placements_tenant_created_at_id_idx" ON "putaway_placements" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "putaway_placements_grn_id_idx" ON "putaway_placements" USING btree ("grn_id","created_at","id");-- Story 3.5 hand-append (the 0005→0014 RLS policy pattern): RLS is declared
-- only in migration SQL, never in schema.ts. Fail-closed single-dimension
-- `tenant_isolation` on the new placements table — a session without
-- `app.tenant_id` sees zero rows. Every read/write runs in an explicitly
-- tenant-scoped transaction.
ALTER TABLE "putaway_placements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "putaway_placements_tenant_isolation" ON "putaway_placements"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Story 3.5 hand-append: the placement is a real movement of existing stock —
-- a non-positive quantity is a client bug (text + CHECK per the repo
-- convention; no pgEnum).
ALTER TABLE "putaway_placements" ADD CONSTRAINT "putaway_placements_qty_check" CHECK ("qty" > 0);