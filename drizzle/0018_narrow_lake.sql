CREATE TABLE "picklist_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"picklist_id" uuid NOT NULL,
	"wave_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"bin_id" uuid,
	"bin_code" text,
	"batch_id" uuid,
	"reservation_id" uuid,
	"qty" integer NOT NULL,
	"shortfall_qty" integer DEFAULT 0 NOT NULL,
	"slice_seq" integer NOT NULL,
	"walk_seq" integer NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "picklists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"wave_id" uuid NOT NULL,
	"order_id" uuid,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wave_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"name" text NOT NULL,
	"grouping" text DEFAULT 'single' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"max_orders" integer,
	"cutoff_local_time" text,
	"carrier_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waves" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"released_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "picklist_lines_picklist_walk_idx" ON "picklist_lines" USING btree ("picklist_id","walk_seq","id");--> statement-breakpoint
CREATE INDEX "picklist_lines_tenant_order_idx" ON "picklist_lines" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "picklist_lines_tenant_id_idx" ON "picklist_lines" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "picklist_lines_tenant_wave_idx" ON "picklist_lines" USING btree ("tenant_id","wave_id");--> statement-breakpoint
CREATE UNIQUE INDEX "picklist_lines_open_order_line_unique" ON "picklist_lines" USING btree ("tenant_id","order_line_id","slice_seq") WHERE status <> 'cancelled';--> statement-breakpoint
CREATE INDEX "picklists_wave_id_idx" ON "picklists" USING btree ("wave_id","created_at","id");--> statement-breakpoint
CREATE INDEX "picklists_tenant_id_idx" ON "picklists" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wave_policies_warehouse_name_unique" ON "wave_policies" USING btree ("tenant_id","warehouse_id","name");--> statement-breakpoint
CREATE INDEX "wave_policies_tenant_warehouse_created_at_id_idx" ON "wave_policies" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE INDEX "waves_tenant_warehouse_created_at_id_idx" ON "waves" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
-- Story 4.2 hand-append (the 0017 RLS pattern): RLS is declared only in
-- migration SQL, never in schema.ts. The same fail-closed single-dimension
-- `tenant_isolation` policy on the four new outbound-owned tables. The
-- `current_setting(..., true)` empty-string NULLIF guard is load-bearing
-- (Postgres 18 returns '' after a transaction-local value expires) so an
-- un-scoped session fails closed (sees zero rows) instead of erroring.
ALTER TABLE "wave_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "wave_policies_tenant_isolation" ON "wave_policies"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "waves" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "waves_tenant_isolation" ON "waves"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "picklists" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "picklists_tenant_isolation" ON "picklists"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "picklist_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "picklist_lines_tenant_isolation" ON "picklist_lines"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Story 4.2 hand-append: the wave/picklist state machines live ONLY in the
-- outbound module (AD-6) — the DB CHECKs enforce the additive arm sets
-- (picking / packed arms arrive with 4.3 / 4.5 as additive CHECK arms). A
-- typo'd arm would silently drop the row out of every status-filtered
-- consumer, including the one-open-wave partial unique index below.
ALTER TABLE "waves" ADD CONSTRAINT "waves_status_check" CHECK ("status" IN ('planned','released','cancelled'));
--> statement-breakpoint
ALTER TABLE "picklists" ADD CONSTRAINT "picklists_status_check" CHECK ("status" IN ('planned','ready','cancelled'));
--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_status_check" CHECK ("status" IN ('planned','unfulfillable','cancelled'));
--> statement-breakpoint
ALTER TABLE "wave_policies" ADD CONSTRAINT "wave_policies_grouping_check" CHECK ("grouping" IN ('single','batch'));
--> statement-breakpoint
-- Policy bounds (the command layer rejects first; the CHECKs are the
-- backstop). `cutoff_local_time` is a wall-clock `HH:MM` in Asia/Kolkata —
-- never an instant, never a timestamptz: it recurs every local day.
ALTER TABLE "wave_policies" ADD CONSTRAINT "wave_policies_priority_nonnegative" CHECK ("priority" >= 0);
--> statement-breakpoint
ALTER TABLE "wave_policies" ADD CONSTRAINT "wave_policies_max_orders_positive" CHECK ("max_orders" IS NULL OR "max_orders" > 0);
--> statement-breakpoint
ALTER TABLE "wave_policies" ADD CONSTRAINT "wave_policies_cutoff_local_time_shape" CHECK ("cutoff_local_time" IS NULL OR "cutoff_local_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
--> statement-breakpoint
-- A pick line names either units at a bin, or the uncovered shortfall of an
-- `unfulfillable` slice — never neither, never negative. The quantities are
-- always drawn from the order line's `reserved_qty`, never its `qty`.
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_qty_nonnegative" CHECK ("qty" >= 0);
--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_shortfall_qty_nonnegative" CHECK ("shortfall_qty" >= 0);
--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_slice_seq_nonnegative" CHECK ("slice_seq" >= 0);
--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_walk_seq_nonnegative" CHECK ("walk_seq" >= 0);
--> statement-breakpoint
-- A bin-less slice carries the uncovered shortfall and no units (the
-- `unfulfillable` arm); every other slice names a bin and draws a positive
-- quantity. The shape keys on `bin_id`, NOT on `status`: cancelling a wave
-- flips every line to `cancelled` (that is what frees its orders through the
-- partial unique index), and an unfulfillable line must survive that flip.
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_slice_shape" CHECK (
	("bin_id" IS NULL AND "qty" = 0 AND "shortfall_qty" > 0)
	OR ("bin_id" IS NOT NULL AND "qty" > 0 AND "shortfall_qty" = 0)
);
--> statement-breakpoint
-- The terminal instants are stamped with their flip (the 0014 release-pairing
-- pattern): a released wave always names when, a cancelled wave always names
-- when. A wave cancelled AFTER release keeps both.
ALTER TABLE "waves" ADD CONSTRAINT "waves_released_at_pairing" CHECK ("status" <> 'released' OR "released_at" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "waves" ADD CONSTRAINT "waves_cancelled_at_pairing" CHECK ("status" <> 'cancelled' OR "cancelled_at" IS NOT NULL);
