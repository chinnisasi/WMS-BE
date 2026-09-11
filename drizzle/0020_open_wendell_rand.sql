-- Story 4.3 (index-only): the device catalog snapshot's pick-task read.
-- That endpoint is fetched by every device on every refresh — it is the one
-- read the offline substrate's latency depends on — and the query filters on
-- `picklists.warehouse_id/status`, `waves.status` and `picklist_lines.status`
-- (+ a non-null `bin_id`), none of which had a supporting index. The
-- `picklist_lines` index is PARTIAL on exactly that predicate, so it holds
-- open floor work only and does not grow with picking history, and its
-- column order also serves the walk-order sort.
CREATE INDEX "picklist_lines_pickable_walk_idx" ON "picklist_lines" USING btree ("tenant_id","picklist_id","walk_seq","id") WHERE status = 'planned' and bin_id is not null;--> statement-breakpoint
CREATE INDEX "picklists_tenant_warehouse_status_idx" ON "picklists" USING btree ("tenant_id","warehouse_id","status");--> statement-breakpoint
CREATE INDEX "waves_tenant_status_idx" ON "waves" USING btree ("tenant_id","status");
