CREATE TABLE "picks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"wave_id" uuid NOT NULL,
	"picklist_id" uuid NOT NULL,
	"picklist_line_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"bin_id" uuid NOT NULL,
	"suggested_bin_id" uuid,
	"batch_id" uuid,
	"suggested_batch_id" uuid,
	"reservation_id" uuid,
	"reservation_committed" boolean DEFAULT false NOT NULL,
	"qty" integer NOT NULL,
	"picked_by" uuid NOT NULL,
	"picked_at" timestamp with time zone NOT NULL,
	"device_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "picks_line_unique" ON "picks" USING btree ("tenant_id","picklist_line_id");--> statement-breakpoint
CREATE INDEX "picks_tenant_picklist_idx" ON "picks" USING btree ("tenant_id","picklist_id");--> statement-breakpoint
CREATE INDEX "picks_tenant_order_idx" ON "picks" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "picks_tenant_warehouse_created_at_id_idx" ON "picks" USING btree ("tenant_id","warehouse_id","created_at","id");
--> statement-breakpoint
-- Story 4.3 hand-append (the 0018 RLS pattern): RLS is declared only in
-- migration SQL, never in schema.ts. The same fail-closed single-dimension
-- `tenant_isolation` policy. The `current_setting(..., true)` empty-string
-- NULLIF guard is load-bearing (Postgres 18 returns '' after a
-- transaction-local value expires) so an un-scoped session fails closed
-- (sees zero rows) instead of erroring.
ALTER TABLE "picks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "picks_tenant_isolation" ON "picks"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- A pick draws a positive whole quantity — full-quantity picks only in this
-- story (short-picking is 4.4), so there is no zero arm to allow.
ALTER TABLE "picks" ADD CONSTRAINT "picks_qty_positive" CHECK ("qty" > 0);
--> statement-breakpoint
-- A pick that reports settling a hold must name the hold it settled: the
-- reservation and the ledger draw commit together or not at all, so a
-- `reservation_committed` row with no `reservation_id` would be a settlement
-- with nothing behind it.
ALTER TABLE "picks" ADD CONSTRAINT "picks_reservation_pairing" CHECK (
	"reservation_committed" = false OR "reservation_id" IS NOT NULL
);
--> statement-breakpoint
-- Story 4.3 hand-append: the pick-line state machine gains its `picked` arm
-- (additive — the outbound module's `PICKLIST_LINE_STATUSES` mirrors it).
-- `picked` sits OUTSIDE `'cancelled'` deliberately: the
-- `picklist_lines_open_order_line_unique` partial index keys on
-- `status <> 'cancelled'`, so a picked line KEEPS its claim on the order
-- line. Dropping out would free the order to be re-waved while its units
-- were being picked, and the second wave would plan stock that has already
-- left the bin.
ALTER TABLE "picklist_lines" DROP CONSTRAINT "picklist_lines_status_check";
--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_status_check" CHECK ("status" IN ('planned','unfulfillable','picked','cancelled'));
