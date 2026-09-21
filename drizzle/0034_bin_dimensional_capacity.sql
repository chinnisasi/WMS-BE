-- Story 11-5 — BIN DIMENSIONAL CAPACITY (FR-39).
--
-- A bin's only capacity is a bare whole-unit count that treats every base unit
-- as equal space: a bin full of small items and a bin holding one heavy crate
-- look identical, and an oversize SKU places into any bin with a spare unit.
-- Four nullable columns on `bins` close that gap — the internal dimensions in
-- millimetres and a max weight in grams — and are the bin-side counterpart of
-- 11.2's SKU attributes (`weight_grams`, `length_mm/width_mm/height_mm`),
-- which until now had zero consumers. Every value NULLABLE = unconstrained =
-- exactly pre-11.5 behavior: a bin without limits is gated by its unit count
-- alone, so every existing warehouse behaves byte-identically.
--
-- INTEGER STORAGE, WYSIWYG EVERYWHERE (the 11.2 SKU-attribute precedent):
-- dimensions in MILLIMETRES, weight in GRAMS — the API fields, the DTO mirrors
-- and the store all speak the same integers; no decimals, no conversion layer.
-- Bins are BIGGER than SKUs (a floor location is an area), so the caps are a
-- magnitude above the SKU-side ones: dimensions ≤ 100,000 mm (100 m), weight
-- ≤ 100,000,000 g (100 tonnes).
--
-- TENANCY-OWNED STRUCTURE. Bin master data (structure) is tenancy's; putaway
-- owns `blocked` only (the re-homing precedent). These four are structure →
-- tenancy writes them (create/grid + the new editBinCapacity command behind
-- the same PATCH route); putaway only READS them in its three capacity gates.
--
-- ADDITIVE ONLY: four ADD COLUMNs, no data statement, nothing to back-fill —
-- which is also why this needs no fail-fast re-run guard (ADD COLUMN cannot
-- be applied twice). The columns are declared in `schema.ts` too; drizzle-orm
-- 0.45 can model neither a CHECK nor a regex, so the bounds live ONLY here.

ALTER TABLE "bins" ADD COLUMN "length_mm" integer;--> statement-breakpoint
ALTER TABLE "bins" ADD COLUMN "width_mm" integer;--> statement-breakpoint
ALTER TABLE "bins" ADD COLUMN "height_mm" integer;--> statement-breakpoint
ALTER TABLE "bins" ADD COLUMN "max_weight_grams" integer;--> statement-breakpoint

-- ── hand-appended: CHECKs (the 0006-0010/0019/0021/0025/0028/0031 pattern) ──
-- RLS policies and CHECK constraints are declared ONLY in migration SQL,
-- never in `schema.ts` — a copy there would make every future `db:generate`
-- emit conflicting DDL against this hand-written half. Each constraint is
-- NULL-tolerant: an unconstrained bin is legal and must stay storable.
--
-- The caps mirror `MAX_BIN_DIMENSION_MM` / `MAX_BIN_WEIGHT_GRAMS`
-- (`src/modules/tenancy/bin.command.ts`). The commands refuse first with a
-- named 400 (`assertBinCapacityAttributes` — one validator behind
-- editBinCapacity's replay lookup and in the create/grid commands); these are
-- the backstop that makes a negative-dimension or absurd row impossible to
-- store by any path, including a future one. Widening a cap later is DROP
-- then re-ADD (the 0023/0024 precedent), never an in-place edit.

ALTER TABLE "bins" ADD CONSTRAINT "bins_length_mm_bounded"
	CHECK ("length_mm" IS NULL OR ("length_mm" > 0 AND "length_mm" <= 100000));--> statement-breakpoint
ALTER TABLE "bins" ADD CONSTRAINT "bins_width_mm_bounded"
	CHECK ("width_mm" IS NULL OR ("width_mm" > 0 AND "width_mm" <= 100000));--> statement-breakpoint
ALTER TABLE "bins" ADD CONSTRAINT "bins_height_mm_bounded"
	CHECK ("height_mm" IS NULL OR ("height_mm" > 0 AND "height_mm" <= 100000));--> statement-breakpoint
ALTER TABLE "bins" ADD CONSTRAINT "bins_max_weight_grams_bounded"
	CHECK ("max_weight_grams" IS NULL OR ("max_weight_grams" > 0 AND "max_weight_grams" <= 100000000));
