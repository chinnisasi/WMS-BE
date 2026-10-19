-- Story 1-5a — the staff client filter: indexes only.
--
-- Every staff list now takes an optional `clientId`, filtered in SQL before
-- the page limit. The lists with their OWN `client_id` column page on
-- `(created_at, id)`; without these, a filtered page walks the unfiltered
-- keyset index and discards every other client's rows on the way (a client
-- whose rows are all old scans the whole warehouse history). Each index is
-- the table's keyset with `client_id` after the tenant:
--   purchase_orders, orders, goods_receipt_notes, return_authorizations,
--   ledger_events: (tenant_id, client_id, warehouse_id, created_at, id)
--   goods_receipt_notes: (tenant_id, client_id, created_at, id) — the GRN
--     list is tenant-wide when no warehouseId is given.
--   return_authorizations: (tenant_id, client_id, created_at, id) — the
--     RMA list is tenant-wide when no warehouseId is given.
--   skus, products: (tenant_id, client_id, created_at, id) — the SKU, kit
--     and product lists page tenant-wide on (created_at, id) too.
-- `ledger_events` already had two client indexes (0061, on `recorded_at`);
-- they cannot serve the timeline's `(created_at, id)` keyset. The orders
-- index also serves the waves', manifests', invoices' and picklist lines'
-- "an order of the client" probe. Lists that reach their client through a
-- SKU filter by `sku_id IN (the client's SKUs)` and need no new index.
-- No new column, no data change (spec 1-5a "Never").
--
-- THE INDEXES ARE PLAIN BUILDS, NOT CONCURRENTLY. drizzle's migrator runs
-- every pending migration inside ONE transaction, and `CREATE INDEX
-- CONCURRENTLY` cannot run inside a transaction block. A plain build holds a
-- SHARE lock on its table for the build's duration: every ledger append
-- (every pick, putaway, receipt, adjustment), order, PO, GRN, RMA and SKU
-- write waits behind it. Accepted pre-launch, where the tables are small;
-- for a LIVE deploy over a large tenant, follow the runbook recorded in
-- docs/design/PENDING.md (clients) — build each index CONCURRENTLY by hand
-- under the same name first; each statement below is then a no-op
-- (`IF NOT EXISTS`, the 0058 precedent).
CREATE INDEX IF NOT EXISTS "goods_receipt_notes_tenant_client_warehouse_created_at_id_idx" ON "goods_receipt_notes" USING btree ("tenant_id","client_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goods_receipt_notes_tenant_client_created_at_id_idx" ON "goods_receipt_notes" USING btree ("tenant_id","client_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_events_tenant_client_warehouse_created_at_id_idx" ON "ledger_events" USING btree ("tenant_id","client_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_tenant_client_warehouse_created_at_id_idx" ON "orders" USING btree ("tenant_id","client_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_tenant_client_created_at_id_idx" ON "products" USING btree ("tenant_id","client_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_tenant_client_warehouse_created_at_id_idx" ON "purchase_orders" USING btree ("tenant_id","client_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_authorizations_tenant_client_created_at_id_idx" ON "return_authorizations" USING btree ("tenant_id","client_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_authorizations_tenant_client_warehouse_created_at_id_idx" ON "return_authorizations" USING btree ("tenant_id","client_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skus_tenant_client_created_at_id_idx" ON "skus" USING btree ("tenant_id","client_id","created_at","id");