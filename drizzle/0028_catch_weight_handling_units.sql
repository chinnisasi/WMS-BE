-- Story 10.3 — CATCH WEIGHT: one row per physical handling unit.
--
-- Catch-weight goods (meat, fish, cheese, produce) are handled BY UNIT and
-- priced BY WEIGHT: a case of beef is *one* case weighing 18.4 kg, and the
-- next weighs 18.6 kg. Nothing in this schema could hold a per-unit actual
-- weight — `skus` had only `batch_tracked`/`serial_tracked`, and
-- `stock_on_hand` is keyed (tenant, warehouse, sku, bin) and carries quantity
-- alone. The one weight field that existed (`pack.weightGrams`, on the
-- `pack.packed` reference doc) is a per-PARCEL gross shipping weight: a
-- different concept at a different granularity, and deliberately not reused.
--
-- WHAT THIS MIGRATION IS NOT. There is **no `ledger_events` change here**, and
-- no new ledger event type. Adding a hashed `handling_unit_ref` column would
-- change the canonical bytes of EVERY pre-existing event — `verifyChain` would
-- report severity-1 across the whole chain, on top of the break 0026 already
-- took. Instead, a unit's CONSUMPTION is recorded inside the already-hashed
-- `reference_doc`: `pack.packed` carries the ids consumed into each order line
-- and `stock.adjusted` the ids of a write-off. `JSON.stringify` drops absent
-- keys, so a historical event whose stored jsonb lacks them hashes exactly as
-- it always did.
--
-- WHAT THAT DOES AND DOES NOT PROTECT, stated exactly. The hash chain covers
-- WHICH units were consumed and by what — it does not cover the WEIGHTS.
-- `grn.received` is an aggregate event per receipt line: it carries neither
-- the unit ids nor their grams, so an out-of-band `UPDATE handling_units SET
-- weight_grams = ...` after receipt leaves `verifyChain` green. The weight's
-- integrity rests on there being exactly one writer of this table, no code
-- path that updates the column, and the CHECK below — not on the ledger. That
-- is the accepted cost of a satellite record; putting the weights inside the
-- chain means fanning receipt out per unit, which is a second serial system
-- and roughly four times this story.
--
-- WHY THIS TABLE DIVERGES FROM `serials`, WHICH IT OTHERWISE RESEMBLES. A
-- serial earns its location from the ledger because putaway and pick fan OUT
-- one event per serial. Nothing here does — so `handling_units` must answer
-- from its OWN columns what a serial answers from the ledger: `warehouse_id`
-- (pack's cross-warehouse guard), `batch_id` (what makes `catch_weight × batch`
-- genuinely usable, rather than repeating the unsolved serials-have-no-batch
-- problem behind the `pick.command.ts` refusal) and `status` (which is what
-- keeps pack from failing open on a case written off as damaged). The accepted,
-- documented cost is that a handling unit has NO queryable location between
-- receipt and pack; mid-life traceability and move-as-unit are epic 15.
--
-- ADDITIVE ONLY. The new `skus` column defaults `false`, so every existing SKU
-- is a non-catch-weight SKU and every existing code path behaves exactly as it
-- did. There is no data statement here and nothing to back-fill — which is
-- also why this migration needs no fail-fast re-run guard: `CREATE TABLE` and
-- `ADD COLUMN` are not statements that can be applied twice.

CREATE TABLE "handling_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"batch_id" uuid,
	"grn_line_id" uuid NOT NULL,
	"weight_grams" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"packed_order_line_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "catch_weight_tracked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "handling_units_tenant_sku_status_idx" ON "handling_units" USING btree ("tenant_id","sku_id","status");--> statement-breakpoint
CREATE INDEX "handling_units_tenant_grn_line_idx" ON "handling_units" USING btree ("tenant_id","grn_line_id");--> statement-breakpoint
CREATE INDEX "handling_units_tenant_id_idx" ON "handling_units" USING btree ("tenant_id");--> statement-breakpoint
-- ── hand-appended: RLS + CHECKs (the 0006-0010/0019/0021/0025 pattern) ─────
-- RLS policies and CHECK constraints are declared ONLY in migration SQL,
-- never in `schema.ts` — drizzle-orm 0.45 can model neither, so a copy there
-- would make every future `db:generate` emit conflicting DDL against this
-- hand-written half.

-- The same fail-closed SINGLE-DIMENSION `tenant_isolation` policy every
-- tenant-scoped table carries. It predicates on `tenant_id` alone —
-- `warehouse_id` is a command-level 404 guard, not an isolation boundary, and
-- no existing policy in this schema predicates on it either. The
-- `NULLIF(current_setting(..., true), '')` guard is load-bearing: Postgres
-- returns '' once a transaction-local setting expires, so an un-scoped session
-- sees ZERO rows rather than erroring.
ALTER TABLE "handling_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "handling_units_tenant_isolation" ON "handling_units"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- The lifecycle vocabulary, mirrored from `HANDLING_UNIT_STATUSES`
-- (`src/modules/catalog/handling-unit.ts`) — the repo's uniform
-- enum-by-CHECK pattern, ten precedents deep. The two are pinned together by
-- an e2e assertion, because three copies of a list drift silently. Widening
-- this set later is a DROP then re-ADD (the 0023/0024 precedent), never an
-- in-place edit.
ALTER TABLE "handling_units" ADD CONSTRAINT "handling_units_status_check"
	CHECK ("status" IN ('active', 'pending_approval', 'rejected', 'packed'));--> statement-breakpoint

-- The captured weight is INTEGER GRAMS and strictly positive, bounded by
-- `MAX_HANDLING_UNIT_WEIGHT_GRAMS` (1,000 kg — past it the bench is reporting
-- grams as milligrams, or the scale is unplugged). The command refuses first
-- with a named 400; this is the backstop that makes a zero-weight or absurd
-- row impossible to store by any path, including a future one.
--
-- Note what is NOT here: no scaling, no milli-units, no relationship to
-- `quantity_delta`. A catch weight is an attribute of an identified thing, not
-- a conserved delta, so it is absent from the reconciliation fold by design —
-- summing weights across a bin produces a number no invariant constrains.
ALTER TABLE "handling_units" ADD CONSTRAINT "handling_units_weight_grams_bounded"
	CHECK ("weight_grams" > 0 AND "weight_grams" <= 1000000);
