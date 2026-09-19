-- Story 11.2 — SKU PHYSICAL ATTRIBUTES AND ORIGIN (FR-36).
--
-- A SKU carries no physical attributes anywhere: no weight, no dimensions, no
-- country of origin — so nothing can rate a parcel, print a label, or check
-- whether stock fits a bin. Five nullable catalog columns close that gap:
-- `weight_grams` (the static catalog weight carriers rate from) and the three
-- dimensions in millimetres are the second hard input behind 4-6d (rating →
-- labels) and the direct input to 11-5 (dimensional capacity);
-- `country_of_origin` is the import-documentation standard ISO 3166-1 alpha-2.
--
-- INTEGER STORAGE, WYSIWYG EVERYWHERE (the `handling_units.weight_grams`
-- 10.3 precedent, extended to millimetres): weight in GRAMS, dimensions in
-- MILLIMETRES — the CSV columns, the API fields and the web inputs all speak
-- grams and millimetres. No decimals, no `numeric`, no conversion layer;
-- carrier adapters (4-6d) convert at their own edge. Quantities are
-- milli-units because they accumulate arithmetically in the ledger; a
-- physical attribute is a read-only fact consumed by rating and capacity —
-- the closer precedent is a plain integer with a named cap.
--
-- NOT CATCH WEIGHT (AD-22). `weight_grams` here is the SKU's static catalog
-- weight; Epic 10's per-handling-unit actual weight on `handling_units`
-- stays a separate concept captured at receipt. Do not conflate them.
--
-- NULLABLE, NEVER REQUIRED AT CREATE. Unlike 11-1's addresses, SKU creation
-- is import-only with an existing corpus of import files; forcing weight
-- would break every import in flight. A SKU without weight/dims is simply
-- unrateable — 4-6d refuses rating for it and names the gap; 11-5 skips its
-- capacity check for it. No backfill, so every pre-11.2 row reads `null`.
--
-- ADDITIVE ONLY: five ADD COLUMNs, no data statement, nothing to back-fill —
-- which is also why this needs no fail-fast re-run guard (ADD COLUMN cannot
-- be applied twice). The columns are declared in `schema.ts` too; drizzle-orm
-- 0.45 can model neither a CHECK nor a regex, so the bounds live ONLY here.

ALTER TABLE "skus" ADD COLUMN "weight_grams" integer;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "length_mm" integer;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "width_mm" integer;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "height_mm" integer;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "country_of_origin" text;--> statement-breakpoint

-- ── hand-appended: CHECKs (the 0006-0010/0019/0021/0025/0028 pattern) ──────
-- RLS policies and CHECK constraints are declared ONLY in migration SQL,
-- never in `schema.ts` — a copy there would make every future `db:generate`
-- emit conflicting DDL against this hand-written half. Each constraint is
-- NULL-tolerant: absent attributes are legal and must stay storable.
--
-- The caps mirror `MAX_SKU_WEIGHT_GRAMS` / `MAX_SKU_DIMENSION_MM`
-- (`src/modules/catalog/sku-attributes.ts`). The commands refuse first with a
-- named 400 (`assertSkuAttributes` — one validator behind the edit command's
-- replay lookup and in the import row parser); these are the backstop that
-- makes a zero-weight or absurd row impossible to store by any path, including
-- a future one. Widening a cap later is DROP then re-ADD (the 0023/0024
-- precedent), never an in-place edit.

ALTER TABLE "skus" ADD CONSTRAINT "skus_weight_grams_bounded"
	CHECK ("weight_grams" IS NULL OR ("weight_grams" > 0 AND "weight_grams" <= 1000000));--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_length_mm_bounded"
	CHECK ("length_mm" IS NULL OR ("length_mm" > 0 AND "length_mm" <= 10000));--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_width_mm_bounded"
	CHECK ("width_mm" IS NULL OR ("width_mm" > 0 AND "width_mm" <= 10000));--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_height_mm_bounded"
	CHECK ("height_mm" IS NULL OR ("height_mm" > 0 AND "height_mm" <= 10000));--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_country_of_origin_iso_alpha2"
	CHECK ("country_of_origin" IS NULL OR "country_of_origin" ~ '^[A-Z]{2}$');
