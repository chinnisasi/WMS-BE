-- ── story 1-6a: SKU goods-type attributes ─────────────────────────────────
-- HAND-WRITTEN (drizzle-kit cannot declare CHECKs). `drizzle/meta/0083_snapshot.json`
-- was generated from `schema.ts`; `bun run db:generate` afterwards reports
-- "No schema changes".
--
-- Order:
--   0. fail-fast: refuse a second run
--   1. the columns — every array `text[] NOT NULL DEFAULT '{}'`, both flags
--      `boolean NOT NULL DEFAULT false`, the rest nullable. Every existing
--      SKU reads the defaults; no data statement (no backfill).
--   2. the CHECKs (migration SQL only; the vocabularies are mirrored by the
--      tuples in `src/shared/primitives/goods-type.ts` and pinned against
--      these constraints in `test/sku-goods-type.spec.ts`):
--        skus_drug_schedules_check           drug_schedules ⊆ the schedules
--        skus_food_category_check            the food categories
--        skus_allergens_check                allergens ⊆ the FSSAI list
--        skus_allergens_food_pairing         allergens only with a food category that is not non-food
--        skus_dg_un_number_check             four digits, 0001–3599
--        skus_dg_class_check                 the DG classes
--        skus_dg_subsidiary_classes_check    subsidiaries ⊆ the DG classes
--        skus_dg_subsidiary_classes_bounds   at most two, the primary not among them
--        skus_dg_packing_group_check         I, II, III
--        skus_dg_un_class_pairing            UN number and DG class both set or both null
--        skus_dg_subsidiary_pairing          subsidiaries need a DG class
--        skus_dg_packing_group_pairing       a packing group needs a DG class that takes one
--        skus_max_stack_layers_bounded       1–100
--        skus_dg_hazard_derived              decision 3: a mapped class (not 8) implies its
--                                            hazard class; class 8 implies null or a corrosive
--      Sorting and de-duplicating the arrays is the command's (decision 10).
--   3. assert: every existing SKU reads the defaults, and each CHECK refuses
--      its named bad shape and admits a good one (the accepted shapes are
--      rolled back by a sentinel exception, so a CHECK that refused
--      everything fails too)
--
-- No foreign keys, no new table, no RLS change. Lock cost: ACCESS EXCLUSIVE
-- on `skus` for the ADD COLUMNs (constant defaults — no rewrite) and the
-- CHECK validation scans.

-- ── 0. fail-fast ─────────────────────────────────────────────────────────
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name = 'skus' AND column_name = 'dg_class'
	) THEN
		RAISE EXCEPTION 'migration 0083: skus.dg_class already exists — this migration has already been applied.';
	END IF;
END $$;
--> statement-breakpoint

-- ── 1. the columns ───────────────────────────────────────────────────────
ALTER TABLE "skus" ADD COLUMN "drug_schedules" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "food_category" text;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "allergens" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "dg_un_number" text;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "dg_class" text;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "dg_subsidiary_classes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "dg_packing_group" text;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "high_value" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "fragile" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "max_stack_layers" integer;--> statement-breakpoint

-- ── 2. the CHECKs ────────────────────────────────────────────────────────
-- Every arm over a nullable column says IS NULL / IS NOT NULL first
-- (NULL IN (…) is NULL, which a CHECK passes). The UN-number arm is one
-- regex, never a cast: Postgres does not promise AND short-circuits, and a
-- `::int` over a non-numeric value would raise instead of violate.
ALTER TABLE "skus" ADD CONSTRAINT "skus_drug_schedules_check" CHECK (
	"drug_schedules" <@ ARRAY['G', 'H', 'H1', 'X', 'C', 'C1', 'NDPS']::text[]
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_food_category_check" CHECK (
	"food_category" IS NULL OR "food_category" IN (
		'dairy', 'meat-poultry-seafood', 'fresh-produce', 'bakery-cereals', 'ready-to-eat', 'beverages',
		'oils-fats', 'spices-condiments', 'confectionery', 'packaged-dry-grocery', 'infant-food', 'other-food', 'non-food'
	)
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_allergens_check" CHECK (
	"allergens" <@ ARRAY['gluten-cereals', 'crustaceans', 'milk', 'eggs', 'fish', 'peanuts', 'tree-nuts', 'soybean', 'sulphite']::text[]
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_allergens_food_pairing" CHECK (
	cardinality("allergens") = 0 OR ("food_category" IS NOT NULL AND "food_category" <> 'non-food')
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_dg_un_number_check" CHECK (
	"dg_un_number" IS NULL OR ("dg_un_number" ~ '^([0-2][0-9]{3}|3[0-5][0-9]{2})$' AND "dg_un_number" <> '0000')
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_dg_class_check" CHECK (
	"dg_class" IS NULL OR "dg_class" IN (
		'1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '2.1', '2.2', '2.3', '3',
		'4.1', '4.2', '4.3', '5.1', '5.2', '6.1', '6.2', '7', '8', '9'
	)
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_dg_subsidiary_classes_check" CHECK (
	"dg_subsidiary_classes" <@ ARRAY[
		'1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '2.1', '2.2', '2.3', '3',
		'4.1', '4.2', '4.3', '5.1', '5.2', '6.1', '6.2', '7', '8', '9'
	]::text[]
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_dg_subsidiary_classes_bounds" CHECK (
	cardinality("dg_subsidiary_classes") <= 2
	AND ("dg_class" IS NULL OR NOT ("dg_class" = ANY ("dg_subsidiary_classes")))
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_dg_packing_group_check" CHECK (
	"dg_packing_group" IS NULL OR "dg_packing_group" IN ('I', 'II', 'III')
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_dg_un_class_pairing" CHECK (
	("dg_un_number" IS NULL) = ("dg_class" IS NULL)
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_dg_subsidiary_pairing" CHECK (
	cardinality("dg_subsidiary_classes") = 0 OR "dg_class" IS NOT NULL
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_dg_packing_group_pairing" CHECK (
	"dg_packing_group" IS NULL OR (
		"dg_class" IS NOT NULL
		AND "dg_class" NOT IN ('1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '2.1', '2.2', '2.3', '5.2', '6.2', '7')
	)
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_max_stack_layers_bounded" CHECK (
	"max_stack_layers" IS NULL OR "max_stack_layers" BETWEEN 1 AND 100
);--> statement-breakpoint
-- Decision 3's backstop. IS NOT DISTINCT FROM, never `=`: a null hazard
-- beside a mapped class must FAIL the arm, and `NULL = 'flammable'` is NULL,
-- which a CHECK passes.
ALTER TABLE "skus" ADD CONSTRAINT "skus_dg_hazard_derived" CHECK (
	CASE
		WHEN "dg_class" IS NULL THEN true
		WHEN "dg_class" IN ('1.1', '1.2', '1.3', '1.4', '1.5', '1.6') THEN "hazard_class" IS NOT DISTINCT FROM 'explosive'
		WHEN "dg_class" IN ('2.1', '2.2', '2.3') THEN "hazard_class" IS NOT DISTINCT FROM 'gas'
		WHEN "dg_class" = '3' THEN "hazard_class" IS NOT DISTINCT FROM 'flammable'
		WHEN "dg_class" = '5.1' THEN "hazard_class" IS NOT DISTINCT FROM 'oxidizer'
		WHEN "dg_class" = '6.1' THEN "hazard_class" IS NOT DISTINCT FROM 'toxic'
		WHEN "dg_class" = '8' THEN "hazard_class" IS NULL OR "hazard_class" IN ('corrosive-acid', 'corrosive-base')
		ELSE true
	END
);--> statement-breakpoint

-- ── 3. assert + probe ────────────────────────────────────────────────────
DO $$
DECLARE
	t uuid := gen_random_uuid();
	c uuid := gen_random_uuid();
	bad bigint;
	refused_by text;
	expected text;
	probe text;
	probes text[] := ARRAY[
		'drug schedule unknown', 'food category unknown', 'allergen unknown', 'allergen on non-food',
		'allergen without a category', 'un number 0000', 'un number 3600', 'un number with prefix',
		'dg class unknown', 'subsidiary unknown', 'three subsidiaries', 'subsidiary equals primary',
		'packing group unknown', 'un without class', 'class without un', 'subsidiary without class',
		'packing group without class', 'packing group on 2.1', 'stack 0', 'stack 101',
		'class 3 not flammable', 'class 3 null hazard', 'class 8 toxic'
	];
BEGIN
	SELECT count(*) INTO bad FROM "skus"
	 WHERE cardinality("drug_schedules") > 0 OR "food_category" IS NOT NULL OR cardinality("allergens") > 0
	    OR "dg_un_number" IS NOT NULL OR "dg_class" IS NOT NULL OR cardinality("dg_subsidiary_classes") > 0
	    OR "dg_packing_group" IS NOT NULL OR "high_value" OR "fragile" OR "max_stack_layers" IS NOT NULL;
	IF bad > 0 THEN
		RAISE EXCEPTION 'migration 0083: % existing SKU(s) did not read the goods-type defaults.', bad;
	END IF;

	-- (a) accepted shapes, rolled back by a sentinel exception.
	BEGIN
		INSERT INTO "skus" ("id","tenant_id","client_id","code","name","uom","gst_rate_bps","barcode",
			"drug_schedules","food_category","allergens","dg_un_number","dg_class","dg_subsidiary_classes",
			"dg_packing_group","high_value","fragile","max_stack_layers","hazard_class")
		VALUES
			(gen_random_uuid(), t, c, 'P-0083-A', 'Probe A', 'each', 0, 'P0083A',
			 ARRAY['C','H'], 'beverages', ARRAY['sulphite'], '3065', '3', ARRAY['6.1'], 'III', true, true, 1, 'flammable'),
			(gen_random_uuid(), t, c, 'P-0083-B', 'Probe B', 'each', 0, 'P0083B',
			 '{}', 'non-food', '{}', '0004', '1.1', '{}', NULL, false, false, 100, 'explosive'),
			(gen_random_uuid(), t, c, 'P-0083-C', 'Probe C', 'each', 0, 'P0083C',
			 '{}', NULL, '{}', '1830', '8', '{}', 'II', false, false, NULL, NULL),
			(gen_random_uuid(), t, c, 'P-0083-D', 'Probe D', 'each', 0, 'P0083D',
			 '{}', NULL, '{}', '1789', '8', '{}', 'II', false, false, NULL, 'corrosive-acid'),
			(gen_random_uuid(), t, c, 'P-0083-E', 'Probe E', 'each', 0, 'P0083E',
			 '{}', NULL, '{}', '3480', '9', '{}', NULL, false, false, NULL, 'flammable'),
			(gen_random_uuid(), t, c, 'P-0083-F', 'Probe F', 'each', 0, 'P0083F',
			 '{}', NULL, '{}', '3599', '2.1', ARRAY['6.1','8'], NULL, false, false, NULL, 'gas'),
			(gen_random_uuid(), t, c, 'P-0083-G', 'Probe G', 'each', 0, 'P0083G',
			 '{}', NULL, '{}', NULL, NULL, '{}', NULL, false, false, NULL, 'toxic');
		RAISE EXCEPTION USING ERRCODE = 'P0083', MESSAGE = 'rollback the accepted probes';
	EXCEPTION
		WHEN check_violation OR unique_violation THEN
			RAISE EXCEPTION 'migration 0083: an accepted shape was refused (%).', SQLERRM;
		WHEN SQLSTATE 'P0083' THEN
			NULL;
	END;

	-- (b) refused shapes, each by its named constraint. Every probe row is a
	-- valid SKU except in the one column the probe breaks.
	FOREACH probe IN ARRAY probes LOOP
		refused_by := NULL;
		expected := CASE probe
			WHEN 'drug schedule unknown' THEN 'skus_drug_schedules_check'
			WHEN 'food category unknown' THEN 'skus_food_category_check'
			WHEN 'allergen unknown' THEN 'skus_allergens_check'
			WHEN 'allergen on non-food' THEN 'skus_allergens_food_pairing'
			WHEN 'allergen without a category' THEN 'skus_allergens_food_pairing'
			WHEN 'un number 0000' THEN 'skus_dg_un_number_check'
			WHEN 'un number 3600' THEN 'skus_dg_un_number_check'
			WHEN 'un number with prefix' THEN 'skus_dg_un_number_check'
			WHEN 'dg class unknown' THEN 'skus_dg_class_check'
			WHEN 'subsidiary unknown' THEN 'skus_dg_subsidiary_classes_check'
			WHEN 'three subsidiaries' THEN 'skus_dg_subsidiary_classes_bounds'
			WHEN 'subsidiary equals primary' THEN 'skus_dg_subsidiary_classes_bounds'
			WHEN 'packing group unknown' THEN 'skus_dg_packing_group_check'
			WHEN 'un without class' THEN 'skus_dg_un_class_pairing'
			WHEN 'class without un' THEN 'skus_dg_un_class_pairing'
			WHEN 'subsidiary without class' THEN 'skus_dg_subsidiary_pairing'
			WHEN 'packing group without class' THEN 'skus_dg_packing_group_pairing'
			WHEN 'packing group on 2.1' THEN 'skus_dg_packing_group_pairing'
			WHEN 'stack 0' THEN 'skus_max_stack_layers_bounded'
			WHEN 'stack 101' THEN 'skus_max_stack_layers_bounded'
			ELSE 'skus_dg_hazard_derived'
		END;
		BEGIN
			INSERT INTO "skus" ("id","tenant_id","client_id","code","name","uom","gst_rate_bps","barcode",
				"drug_schedules","food_category","allergens","dg_un_number","dg_class","dg_subsidiary_classes",
				"dg_packing_group","max_stack_layers","hazard_class")
			SELECT gen_random_uuid(), t, c, 'P1', 'n', 'each', 0, 'B1',
				CASE probe WHEN 'drug schedule unknown' THEN ARRAY['Z'] ELSE '{}'::text[] END,
				CASE probe
					WHEN 'food category unknown' THEN 'snacks'
					WHEN 'allergen unknown' THEN 'dairy'
					WHEN 'allergen on non-food' THEN 'non-food'
					ELSE NULL
				END,
				CASE probe
					WHEN 'allergen unknown' THEN ARRAY['peanut']
					WHEN 'allergen on non-food' THEN ARRAY['milk']
					WHEN 'allergen without a category' THEN ARRAY['milk']
					ELSE '{}'::text[]
				END,
				CASE probe
					WHEN 'un number 0000' THEN '0000'
					WHEN 'un number 3600' THEN '3600'
					WHEN 'un number with prefix' THEN 'UN1203'
					WHEN 'dg class unknown' THEN '1203'
					WHEN 'subsidiary unknown' THEN '1203'
					WHEN 'three subsidiaries' THEN '1203'
					WHEN 'subsidiary equals primary' THEN '1203'
					WHEN 'packing group unknown' THEN '1203'
					WHEN 'un without class' THEN '1203'
					WHEN 'packing group on 2.1' THEN '1950'
					WHEN 'class 3 not flammable' THEN '1203'
					WHEN 'class 3 null hazard' THEN '1203'
					WHEN 'class 8 toxic' THEN '1830'
					ELSE NULL
				END,
				CASE probe
					WHEN 'un number 0000' THEN '3'
					WHEN 'un number 3600' THEN '3'
					WHEN 'un number with prefix' THEN '3'
					WHEN 'dg class unknown' THEN '10'
					WHEN 'subsidiary unknown' THEN '3'
					WHEN 'three subsidiaries' THEN '3'
					WHEN 'subsidiary equals primary' THEN '3'
					WHEN 'packing group unknown' THEN '3'
					WHEN 'class without un' THEN '3'
					WHEN 'packing group on 2.1' THEN '2.1'
					WHEN 'class 3 not flammable' THEN '3'
					WHEN 'class 3 null hazard' THEN '3'
					WHEN 'class 8 toxic' THEN '8'
					ELSE NULL
				END,
				CASE probe
					WHEN 'subsidiary unknown' THEN ARRAY['6.3']
					WHEN 'three subsidiaries' THEN ARRAY['6.1', '8', '9']
					WHEN 'subsidiary equals primary' THEN ARRAY['3']
					WHEN 'subsidiary without class' THEN ARRAY['6.1']
					ELSE '{}'::text[]
				END,
				CASE probe
					WHEN 'packing group unknown' THEN 'IV'
					WHEN 'packing group without class' THEN 'II'
					WHEN 'packing group on 2.1' THEN 'II'
					ELSE NULL
				END,
				CASE probe WHEN 'stack 0' THEN 0 WHEN 'stack 101' THEN 101 ELSE NULL END,
				CASE probe
					WHEN 'class 3 not flammable' THEN 'toxic'
					WHEN 'class 3 null hazard' THEN NULL
					WHEN 'class 8 toxic' THEN 'toxic'
					WHEN 'packing group on 2.1' THEN 'gas'
					WHEN 'class without un' THEN 'flammable'
					WHEN 'un number 0000' THEN 'flammable'
					WHEN 'un number 3600' THEN 'flammable'
					WHEN 'un number with prefix' THEN 'flammable'
					WHEN 'subsidiary unknown' THEN 'flammable'
					WHEN 'three subsidiaries' THEN 'flammable'
					WHEN 'subsidiary equals primary' THEN 'flammable'
					WHEN 'packing group unknown' THEN 'flammable'
					ELSE NULL
				END;
			RAISE EXCEPTION 'migration 0083: the probe "%" was admitted — % must refuse it.', probe, expected;
		EXCEPTION
			WHEN check_violation THEN
				GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
				IF refused_by IS DISTINCT FROM expected THEN
					RAISE EXCEPTION 'migration 0083: the probe "%" was refused by % — expected %.', probe, refused_by, expected;
				END IF;
		END;
	END LOOP;
	IF EXISTS (SELECT 1 FROM "skus" WHERE "tenant_id" = t) THEN
		RAISE EXCEPTION 'migration 0083: a probe row survived.';
	END IF;
END $$;
