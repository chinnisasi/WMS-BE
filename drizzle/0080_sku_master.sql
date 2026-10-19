-- ── story 1-4: the SKU master — barcodes, pack levels, shelf life, per-client products ──
-- HAND-WRITTEN (drizzle-kit cannot order a backfill between ADD COLUMN and
-- SET NOT NULL, nor declare CHECKs or RLS). `drizzle/meta/0080_snapshot.json`
-- was generated from `schema.ts`; `bun run db:generate` afterwards reports
-- "No schema changes".
--
-- Order (each step reads what the one before it left):
--   0. fail-fast (refuse a second run) + pre-flight: list EVERY offender at
--      once — a `skus.barcode` breaking the barcode rule (decision 12), a
--      `uom_conversions.factor` outside 2–1,000,000, a product whose SKUs
--      span clients
--   1. the `sku_barcodes` table + its indexes; `skus.shelf_life_days`;
--      `products.client_id` (nullable for the backfill)
--   2. backfill: one primary `sku_barcodes` row per SKU (barcode, base uom,
--      client = the SKU's); each product's client from its SKUs, else the
--      tenant's `self` client (code 'self' AND system_owned)
--   3. assert: exactly one primary per SKU, equal to `skus.barcode` and its
--      uom; every `sku_barcodes.client_id` equals its SKU's; no product
--      without a client
--   4. `products.client_id` SET NOT NULL
--   5. swap the product name index: tenant-unique → (tenant, client)-unique
--   6. the CHECKs (shelf life, factor, barcode rule, barcode level uom) —
--      each probed below with a refused and an accepted shape
--   7. RLS: `sku_barcodes` gets the tenant + `app.client_id` clause (0079's
--      `partner_client_links` shape); `products`' policy is recreated with it
--
-- No foreign keys (IMPLEMENTATION-GUIDE §3). Lock cost: ACCESS EXCLUSIVE on
-- `products`, `skus` and `uom_conversions` for the ADD COLUMN / CHECK
-- validation; the backfill reads every SKU once.

-- ── 0. fail-fast + pre-flight ────────────────────────────────────────────
DO $$
DECLARE
	bad_barcodes text;
	bad_factors text;
	split_products text;
	report text := '';
BEGIN
	IF to_regclass('public.sku_barcodes') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0080: sku_barcodes already exists — this migration has already been applied.';
	END IF;
	-- Decision 12: trimmed, 1–64 characters, printable ASCII, no ';'.
	SELECT string_agg(format('%s (tenant %s, barcode %L)', s.code, s.tenant_id, s.barcode), '; ' ORDER BY s.tenant_id, s.code)
	  INTO bad_barcodes
	  FROM skus s
	 WHERE NOT (
		char_length(s.barcode) BETWEEN 1 AND 64
		AND s.barcode ~ '^[!-~]([ -~]*[!-~])?$'
		AND strpos(s.barcode, ';') = 0
	 );
	SELECT string_agg(format('%s → %s × %s (tenant %s)', s.code, c.uom, c.factor, c.tenant_id), '; ' ORDER BY c.tenant_id, s.code, c.uom)
	  INTO bad_factors
	  FROM uom_conversions c
	  LEFT JOIN skus s ON s.tenant_id = c.tenant_id AND s.id = c.sku_id
	 WHERE c.factor < 2 OR c.factor > 1000000;
	SELECT string_agg(format('%L (tenant %s)', p.name, p.tenant_id), '; ' ORDER BY p.tenant_id, p.name)
	  INTO split_products
	  FROM products p
	 WHERE (SELECT count(DISTINCT s.client_id) FROM skus s WHERE s.tenant_id = p.tenant_id AND s.product_id = p.id) > 1;
	IF bad_barcodes IS NOT NULL THEN
		report := report || ' SKU barcodes breaking the barcode rule (trimmed, 1–64 printable ASCII characters, no ";"): ' || bad_barcodes || '.';
	END IF;
	IF bad_factors IS NOT NULL THEN
		report := report || ' uom_conversions factors outside 2–1,000,000: ' || bad_factors || '.';
	END IF;
	IF split_products IS NOT NULL THEN
		report := report || ' products whose SKUs span clients: ' || split_products || '.';
	END IF;
	IF report <> '' THEN
		RAISE EXCEPTION 'migration 0080: fix these rows first —%', report;
	END IF;
END $$;
--> statement-breakpoint

-- ── 1. the table and the columns ─────────────────────────────────────────
CREATE TABLE "sku_barcodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"barcode" text NOT NULL,
	"uom" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "sku_barcodes_tenant_client_barcode_unique" ON "sku_barcodes" USING btree ("tenant_id","client_id","barcode");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_barcodes_primary_unique" ON "sku_barcodes" USING btree ("sku_id") WHERE is_primary;--> statement-breakpoint
CREATE INDEX "sku_barcodes_tenant_sku_idx" ON "sku_barcodes" USING btree ("tenant_id","sku_id");--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "shelf_life_days" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "client_id" uuid;--> statement-breakpoint

-- ── 2. backfill ──────────────────────────────────────────────────────────
INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom","is_primary","created_at","updated_at")
SELECT gen_random_uuid(), s.tenant_id, s.client_id, s.id, s.barcode, s.uom, true, s.created_at, s.updated_at
  FROM skus s;--> statement-breakpoint
-- A product takes its SKUs' client (the pre-flight proved there is one).
UPDATE "products" p
   SET "client_id" = (
	SELECT min(s.client_id::text)::uuid FROM skus s WHERE s.tenant_id = p.tenant_id AND s.product_id = p.id
   );--> statement-breakpoint
-- …else the tenant's own `self` client.
UPDATE "products" p
   SET "client_id" = c.id
  FROM clients c
 WHERE p.client_id IS NULL
   AND c.tenant_id = p.tenant_id AND c.code = 'self' AND c.system_owned;--> statement-breakpoint

-- ── 3. assert ────────────────────────────────────────────────────────────
DO $$
DECLARE
	bad text;
BEGIN
	SELECT string_agg(format('%s (tenant %s)', s.code, s.tenant_id), ', ' ORDER BY s.tenant_id, s.code) INTO bad
	  FROM skus s
	 WHERE (SELECT count(*) FROM sku_barcodes b WHERE b.sku_id = s.id AND b.is_primary) <> 1
	    OR NOT EXISTS (
		SELECT 1 FROM sku_barcodes b
		 WHERE b.sku_id = s.id AND b.is_primary AND b.tenant_id = s.tenant_id
		   AND b.barcode = s.barcode AND b.uom = s.uom);
	IF bad IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0080: SKUs without exactly one primary barcode row equal to skus.barcode: %', bad;
	END IF;
	SELECT string_agg(b.barcode, ', ') INTO bad
	  FROM sku_barcodes b
	  JOIN skus s ON s.id = b.sku_id
	 WHERE b.client_id IS DISTINCT FROM s.client_id OR b.tenant_id IS DISTINCT FROM s.tenant_id;
	IF bad IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0080: barcode rows whose client differs from their SKU''s: %', bad;
	END IF;
	SELECT string_agg(format('%L (tenant %s)', p.name, p.tenant_id), ', ') INTO bad
	  FROM products p WHERE p.client_id IS NULL;
	IF bad IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0080: products left without a client (no SKUs and no self client): %', bad;
	END IF;
END $$;
--> statement-breakpoint

-- ── 4. NOT NULL ──────────────────────────────────────────────────────────
ALTER TABLE "products" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint

-- ── 5. product names unique per client (decision 3) ──────────────────────
DROP INDEX "products_tenant_id_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_client_name_unique" ON "products" USING btree ("tenant_id","client_id","name");--> statement-breakpoint

-- ── 6. the CHECKs (migration SQL only; mirrored by `sku-master.ts`) ──────
ALTER TABLE "skus" ADD CONSTRAINT "skus_shelf_life_days_check" CHECK (
	"shelf_life_days" IS NULL OR ("shelf_life_days" >= 1 AND "shelf_life_days" <= 3650)
);--> statement-breakpoint
ALTER TABLE "uom_conversions" ADD CONSTRAINT "uom_conversions_factor_check" CHECK (
	"factor" >= 2 AND "factor" <= 1000000
);--> statement-breakpoint
-- Decision 12 — the one barcode rule: trimmed, 1–64 printable ASCII
-- characters, no ';' (the import's barcodes-cell separator).
ALTER TABLE "sku_barcodes" ADD CONSTRAINT "sku_barcodes_barcode_check" CHECK (
	char_length("barcode") BETWEEN 1 AND 64
	AND "barcode" ~ '^[!-~]([ -~]*[!-~])?$'
	AND strpos("barcode", ';') = 0
);--> statement-breakpoint
-- The level's uom — the same closed vocabulary as `skus_uom_check` /
-- `uom_conversions_uom_check` (0027), pinned to `UOMS` by
-- test/uom-precision.spec.ts.
ALTER TABLE "sku_barcodes" ADD CONSTRAINT "sku_barcodes_uom_check" CHECK ("uom" IN ('each','box','case','carton','pack','pallet','bag','drum','roll','crate','bundle','pair','dozen','bottle','can','tin','jar','tube','tray','sheet','bar','cylinder','keg','set','g','kg','tonne','ml','litre','kl','mm','cm','m','sqm','sqft'));--> statement-breakpoint

-- ── 7. RLS ───────────────────────────────────────────────────────────────
-- The tenant arm plus the 0041 `app.client_id` clause on `client_id` — a
-- portal-stamped transaction sees only its own client's rows (no portal
-- route reads either table; defence in depth).
ALTER TABLE "sku_barcodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sku_barcodes_tenant_isolation" ON "sku_barcodes"
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR "client_id" = NULLIF(current_setting('app.client_id', true), '')::uuid
		)
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR "client_id" = NULLIF(current_setting('app.client_id', true), '')::uuid
		)
	);--> statement-breakpoint
DROP POLICY "products_tenant_isolation" ON "products";--> statement-breakpoint
CREATE POLICY "products_tenant_isolation" ON "products"
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR "client_id" = NULLIF(current_setting('app.client_id', true), '')::uuid
		)
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR "client_id" = NULLIF(current_setting('app.client_id', true), '')::uuid
		)
	);--> statement-breakpoint

-- ── 8. the probe: every CHECK refuses its named bad shape and admits a good one ──
DO $$
DECLARE
	t uuid := gen_random_uuid();
	c uuid := gen_random_uuid();
	s uuid := gen_random_uuid();
	refused_by text;
	expected text;
	probe text;
BEGIN
	-- (a) accepted shapes, rolled back by a sentinel exception — a CHECK that
	-- refused everything fails the migration.
	BEGIN
		INSERT INTO "skus" ("id","tenant_id","client_id","code","name","uom","gst_rate_bps","barcode","shelf_life_days")
		VALUES (s, t, c, 'P-0080', 'Probe', 'each', 0, 'P 0080-A', 3650);
		INSERT INTO "skus" ("id","tenant_id","client_id","code","name","uom","gst_rate_bps","barcode","shelf_life_days")
		VALUES (gen_random_uuid(), t, c, 'P-0080-B', 'Probe B', 'each', 0, 'P0080B', 1);
		INSERT INTO "uom_conversions" ("id","tenant_id","sku_id","uom","factor")
		VALUES (gen_random_uuid(), t, s, 'case', 2), (gen_random_uuid(), t, s, 'pallet', 1000000);
		INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom","is_primary")
		VALUES (gen_random_uuid(), t, c, s, 'P 0080-A', 'each', true),
		       (gen_random_uuid(), t, c, s, '!~', 'case', false),
		       (gen_random_uuid(), t, c, s, repeat('9', 64), 'pallet', false),
		       (gen_random_uuid(), t, c, s, 'X', 'each', false);
		RAISE EXCEPTION USING ERRCODE = 'P0080', MESSAGE = 'rollback the accepted probes';
	EXCEPTION
		WHEN check_violation OR unique_violation THEN
			RAISE EXCEPTION 'migration 0080: an accepted shape was refused (%).', SQLERRM;
		WHEN SQLSTATE 'P0080' THEN
			NULL;
	END;

	-- (b) refused shapes, each by its named constraint.
	FOREACH probe IN ARRAY ARRAY[
		'shelf life zero', 'shelf life over ten years', 'factor one', 'factor over a million',
		'barcode empty', 'barcode leading space', 'barcode trailing space', 'barcode semicolon',
		'barcode non-ascii', 'barcode control character', 'barcode too long', 'level unknown',
		'duplicate barcode in a client', 'two primaries'
	] LOOP
		refused_by := NULL;
		expected := CASE probe
			WHEN 'shelf life zero' THEN 'skus_shelf_life_days_check'
			WHEN 'shelf life over ten years' THEN 'skus_shelf_life_days_check'
			WHEN 'factor one' THEN 'uom_conversions_factor_check'
			WHEN 'factor over a million' THEN 'uom_conversions_factor_check'
			WHEN 'level unknown' THEN 'sku_barcodes_uom_check'
			WHEN 'duplicate barcode in a client' THEN 'sku_barcodes_tenant_client_barcode_unique'
			WHEN 'two primaries' THEN 'sku_barcodes_primary_unique'
			ELSE 'sku_barcodes_barcode_check'
		END;
		BEGIN
			CASE probe
				WHEN 'shelf life zero' THEN
					INSERT INTO "skus" ("id","tenant_id","client_id","code","name","uom","gst_rate_bps","barcode","shelf_life_days") VALUES (gen_random_uuid(), t, c, 'P1', 'n', 'each', 0, 'B1', 0);
				WHEN 'shelf life over ten years' THEN
					INSERT INTO "skus" ("id","tenant_id","client_id","code","name","uom","gst_rate_bps","barcode","shelf_life_days") VALUES (gen_random_uuid(), t, c, 'P1', 'n', 'each', 0, 'B1', 3651);
				WHEN 'factor one' THEN
					INSERT INTO "uom_conversions" ("id","tenant_id","sku_id","uom","factor") VALUES (gen_random_uuid(), t, s, 'case', 1);
				WHEN 'factor over a million' THEN
					INSERT INTO "uom_conversions" ("id","tenant_id","sku_id","uom","factor") VALUES (gen_random_uuid(), t, s, 'case', 1000001);
				WHEN 'barcode empty' THEN
					INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom") VALUES (gen_random_uuid(), t, c, s, '', 'each');
				WHEN 'barcode leading space' THEN
					INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom") VALUES (gen_random_uuid(), t, c, s, ' 890', 'each');
				WHEN 'barcode trailing space' THEN
					INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom") VALUES (gen_random_uuid(), t, c, s, '890 ', 'each');
				WHEN 'barcode semicolon' THEN
					INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom") VALUES (gen_random_uuid(), t, c, s, '890;1', 'each');
				WHEN 'barcode non-ascii' THEN
					INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom") VALUES (gen_random_uuid(), t, c, s, 'caf' || chr(233), 'each');
				WHEN 'barcode control character' THEN
					INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom") VALUES (gen_random_uuid(), t, c, s, 'a' || chr(9) || 'b', 'each');
				WHEN 'barcode too long' THEN
					INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom") VALUES (gen_random_uuid(), t, c, s, repeat('9', 65), 'each');
				WHEN 'level unknown' THEN
					INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom") VALUES (gen_random_uuid(), t, c, s, '890', 'cases');
				WHEN 'duplicate barcode in a client' THEN
					INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom")
					VALUES (gen_random_uuid(), t, c, s, '890', 'each'), (gen_random_uuid(), t, c, gen_random_uuid(), '890', 'each');
				ELSE
					INSERT INTO "sku_barcodes" ("id","tenant_id","client_id","sku_id","barcode","uom","is_primary")
					VALUES (gen_random_uuid(), t, c, s, '890', 'each', true), (gen_random_uuid(), t, c, s, '891', 'each', true);
			END CASE;
			RAISE EXCEPTION 'migration 0080: the probe "%" was admitted — % must refuse it.', probe, expected;
		EXCEPTION
			WHEN check_violation OR unique_violation THEN
				GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
				IF refused_by IS DISTINCT FROM expected THEN
					RAISE EXCEPTION 'migration 0080: the probe "%" was refused by % — expected %.', probe, refused_by, expected;
				END IF;
		END;
	END LOOP;
END $$;
