-- Story 10.1 — fractional quantities: every quantity column becomes a
-- `bigint` holding **milli-units** (the SKU's base UoM × 10³), and every
-- existing value is multiplied by 1000 in place.
--
-- WHY IN PLACE. No environment holds live tenant data yet, so a single
-- forward migration is honest and cheap: there is nothing to dual-write, no
-- reader to cut over, and no rollback to rehearse. This is a **dated
-- assumption, not a permanent licence** — the moment a real tenant exists,
-- any future representation change must use expand → dual-write → backfill →
-- cut over → contract instead. This is the last migration that gets to
-- rewrite a quantity column in place.
--
-- WHY ×10³ AND NOT ×10⁶. The binding limit is not `bigint` but the 2⁵³
-- exact-integer ceiling of IEEE doubles, which quantities cross twice: Lua
-- 5.1 inside the Valkey reservation scripts, and JavaScript itself. At ×10⁶
-- the usable range collapses to ~9.0 × 10⁹ base units (a grams-based silo
-- caps at ~9,007 t — reachable, and exactly the class of bug this migration
-- exists to remove). At ×10³ it is ~9.0 × 10¹² base units.
--
-- The cast is written `("col"::bigint * 1000)`, never `("col" * 1000)`: the
-- multiplication has to happen in 64-bit, or int4 arithmetic overflows on the
-- way to the wider column and the migration fails on data it was meant to
-- carry.
--
-- `bins.capacity`, `skus.reorder_point` and `skus.reorder_qty` scale WITH the
-- quantities. All three are UoM-denominated and compared directly against
-- quantities; scaling one side alone would silently break every capacity gate
-- and every reorder trigger.
--
-- THE HASH CHAIN IS NOT REWRITTEN, AND THAT IS A CONSEQUENCE, NOT AN
-- OVERSIGHT. `ledger_events.event_hash` is sha256 over the event's canonical
-- bytes, and `quantity_delta` is one of those bytes — so multiplying the
-- column by 1000 leaves every pre-existing event's stored hash disagreeing
-- with a recomputation of it. `LedgerService.verifyChain` would report a
-- severity-1 break on any event that predates this migration.
--
-- Rehashing them here is not possible honestly: the canonical form includes
-- the timestamp normalizer and the sorted-key reference doc, neither of which
-- SQL can reproduce byte-for-byte, and a hash the database computes a second
-- way is not the same guarantee. The pre-launch premise is what makes this
-- acceptable — no environment holds settled ledger events, so there is no
-- chain to break. It is also the sharpest reason this is the LAST in-place
-- quantity migration: once a real tenant's events exist, their hashes are
-- evidence, and evidence is not something a forward migration gets to rewrite.
--
-- (The append-only triggers are BEFORE UPDATE/DELETE row triggers. An
-- `ALTER TABLE … SET DATA TYPE` rewrites the table without firing them, which
-- is what lets this migration touch `ledger_events` at all — and is asserted
-- against real rows in `test/fractional-quantity.spec.ts`.)
--
-- NOT scaled (deliberately): `unit_cost_paise` (money is integer paise),
-- `gst_rate_bps` (basis points), `uom_conversions.factor` (a box of 12 is 12
-- whether quantities are scaled or not — fractional conversions belong to
-- story 10.2), sequences, epochs, attempt counters, row counts, `slice_seq`,
-- `walk_seq` and `credential_version`.

-- ── 0. the fail-fast guard ────────────────────────────────────────────────
-- This migration is NOT idempotent and cannot be made so: `SET DATA TYPE
-- bigint USING (col::bigint * 1000)` is perfectly legal on a column that is
-- ALREADY bigint, so a second run multiplies every quantity by a thousand
-- again — silently, with no error to notice. The drizzle journal normally
-- makes that impossible, but a hand-applied re-run (or a snapshot that went
-- missing, so `db:generate` emits a second type change someone then "fixes"
-- the same way) would not be caught by anything else. So the migration
-- refuses to run twice, loudly, rather than quietly corrupting every balance.
DO $$
BEGIN
	IF (
		SELECT atttypid FROM pg_attribute
		WHERE attrelid = 'stock_on_hand'::regclass AND attname = 'quantity' AND NOT attisdropped
	) = 'bigint'::regtype THEN
		RAISE EXCEPTION 'migration 0026 has already been applied: stock_on_hand.quantity is already bigint. Re-running would multiply every quantity by 1000 a second time.';
	END IF;
END $$;--> statement-breakpoint

-- ── 1. the CHECKs come off first ──────────────────────────────────────────
-- A CHECK survives an `ALTER COLUMN TYPE` by being re-derived against the new
-- type, but the compound ones (`applied_le_physical`, `reserved_qty_lte_qty`,
-- `slice_shape`, `short_pairing`) span columns that change in separate
-- statements — dropping them all up front keeps the re-creation explicit and
-- auditable rather than implicit and invisible.
ALTER TABLE "stock_on_hand" DROP CONSTRAINT "stock_on_hand_quantity_nonnegative";--> statement-breakpoint
ALTER TABLE "batch_on_hand" DROP CONSTRAINT "batch_on_hand_quantity_nonnegative";--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_quantity_positive";--> statement-breakpoint
ALTER TABLE "purchase_order_lines" DROP CONSTRAINT "purchase_order_lines_ordered_qty_positive";--> statement-breakpoint
ALTER TABLE "purchase_order_lines" DROP CONSTRAINT "purchase_order_lines_received_qty_nonnegative";--> statement-breakpoint
ALTER TABLE "over_receipts" DROP CONSTRAINT "over_receipts_excess_qty_positive";--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" DROP CONSTRAINT "goods_receipt_lines_qty_positive";--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" DROP CONSTRAINT "goods_receipt_lines_applied_qty_nonnegative";--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" DROP CONSTRAINT "goods_receipt_lines_applied_le_physical";--> statement-breakpoint
ALTER TABLE "putaway_placements" DROP CONSTRAINT "putaway_placements_qty_check";--> statement-breakpoint
ALTER TABLE "order_lines" DROP CONSTRAINT "order_lines_qty_positive";--> statement-breakpoint
ALTER TABLE "order_lines" DROP CONSTRAINT "order_lines_reserved_qty_nonnegative";--> statement-breakpoint
ALTER TABLE "order_lines" DROP CONSTRAINT "order_lines_reserved_qty_lte_qty";--> statement-breakpoint
ALTER TABLE "picklist_lines" DROP CONSTRAINT "picklist_lines_qty_nonnegative";--> statement-breakpoint
ALTER TABLE "picklist_lines" DROP CONSTRAINT "picklist_lines_shortfall_qty_nonnegative";--> statement-breakpoint
ALTER TABLE "picklist_lines" DROP CONSTRAINT "picklist_lines_slice_shape";--> statement-breakpoint
ALTER TABLE "picklist_lines" DROP CONSTRAINT "picklist_lines_short_pairing";--> statement-breakpoint
ALTER TABLE "picks" DROP CONSTRAINT "picks_qty_positive";--> statement-breakpoint

-- ── 2. the columns widen and their values scale, in one statement each ────
-- The ledger's signed delta. No CHECK has ever constrained it (a movement is
-- signed by direction), so it only widens.
ALTER TABLE "ledger_events" ALTER COLUMN "quantity_delta" SET DATA TYPE bigint USING ("quantity_delta"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "stock_on_hand" ALTER COLUMN "quantity" SET DATA TYPE bigint USING ("quantity"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "batch_on_hand" ALTER COLUMN "quantity" SET DATA TYPE bigint USING ("quantity"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "reservations" ALTER COLUMN "quantity" SET DATA TYPE bigint USING ("quantity"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "ordered_qty" SET DATA TYPE bigint USING ("ordered_qty"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "received_qty" SET DATA TYPE bigint USING ("received_qty"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "received_qty" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ALTER COLUMN "qty" SET DATA TYPE bigint USING ("qty"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ALTER COLUMN "applied_qty" SET DATA TYPE bigint USING ("applied_qty"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ALTER COLUMN "applied_qty" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "over_receipts" ALTER COLUMN "excess_qty" SET DATA TYPE bigint USING ("excess_qty"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "putaway_placements" ALTER COLUMN "qty" SET DATA TYPE bigint USING ("qty"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "order_lines" ALTER COLUMN "qty" SET DATA TYPE bigint USING ("qty"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "order_lines" ALTER COLUMN "reserved_qty" SET DATA TYPE bigint USING ("reserved_qty"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "order_lines" ALTER COLUMN "reserved_qty" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "picklist_lines" ALTER COLUMN "qty" SET DATA TYPE bigint USING ("qty"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "picklist_lines" ALTER COLUMN "shortfall_qty" SET DATA TYPE bigint USING ("shortfall_qty"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "picklist_lines" ALTER COLUMN "shortfall_qty" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "picks" ALTER COLUMN "qty" SET DATA TYPE bigint USING ("qty"::bigint * 1000);--> statement-breakpoint

-- The three UoM-denominated siblings (see the header): these are compared
-- against quantities, so they are quantities for the purpose of this change.
ALTER TABLE "bins" ALTER COLUMN "capacity" SET DATA TYPE bigint USING ("capacity"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "skus" ALTER COLUMN "reorder_point" SET DATA TYPE bigint USING ("reorder_point"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "skus" ALTER COLUMN "reorder_point" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "skus" ALTER COLUMN "reorder_qty" SET DATA TYPE bigint USING ("reorder_qty"::bigint * 1000);--> statement-breakpoint
ALTER TABLE "skus" ALTER COLUMN "reorder_qty" SET DEFAULT 0;--> statement-breakpoint

-- ── 3. the CHECKs go back on, against the new type ────────────────────────
-- Every body is re-created verbatim: scaling both sides of a comparison by
-- the same factor leaves its MEANING untouched, which is the whole point of
-- a representation migration. `reserved_qty <= qty` is as true in milli-units
-- as it was in base units.
ALTER TABLE "stock_on_hand" ADD CONSTRAINT "stock_on_hand_quantity_nonnegative" CHECK ("quantity" >= 0);--> statement-breakpoint
ALTER TABLE "batch_on_hand" ADD CONSTRAINT "batch_on_hand_quantity_nonnegative" CHECK ("quantity" >= 0);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_quantity_positive" CHECK ("quantity" > 0);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_ordered_qty_positive" CHECK ("ordered_qty" > 0);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_received_qty_nonnegative" CHECK ("received_qty" >= 0);--> statement-breakpoint
ALTER TABLE "over_receipts" ADD CONSTRAINT "over_receipts_excess_qty_positive" CHECK ("excess_qty" > 0);--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_qty_positive" CHECK ("qty" > 0);--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_applied_qty_nonnegative" CHECK ("applied_qty" >= 0);--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_applied_le_physical" CHECK ("applied_qty" <= "qty");--> statement-breakpoint
ALTER TABLE "putaway_placements" ADD CONSTRAINT "putaway_placements_qty_check" CHECK ("qty" > 0);--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_qty_positive" CHECK ("qty" > 0);--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_reserved_qty_nonnegative" CHECK ("reserved_qty" >= 0);--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_reserved_qty_lte_qty" CHECK ("reserved_qty" <= "qty");--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_qty_nonnegative" CHECK ("qty" >= 0);--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_shortfall_qty_nonnegative" CHECK ("shortfall_qty" >= 0);--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_slice_shape" CHECK (
	("bin_id" IS NULL AND "qty" = 0 AND "shortfall_qty" > 0)
	OR ("bin_id" IS NOT NULL AND "qty" > 0 AND "shortfall_qty" = 0)
	OR (
		"status" IN ('short','cancelled')
		AND "bin_id" IS NOT NULL AND "qty" > 0
		AND "shortfall_qty" > 0 AND "shortfall_qty" <= "qty"
	)
);--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_short_pairing" CHECK (
	"status" <> 'short' OR ("shortfall_qty" > 0 AND "reason_code" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "picks" ADD CONSTRAINT "picks_qty_positive" CHECK ("qty" > 0);
