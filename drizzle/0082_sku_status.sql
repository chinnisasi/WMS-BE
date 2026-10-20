-- ── story 1-4b: SKU deactivation — `skus.status` + `skus.inactive_reason` ──
-- HAND-WRITTEN (drizzle-kit cannot declare CHECKs). `drizzle/meta/0082_snapshot.json`
-- was generated from `schema.ts`; `bun run db:generate` afterwards reports
-- "No schema changes".
--
-- Order:
--   0. fail-fast: refuse a second run
--   1. the columns — `status text NOT NULL DEFAULT 'active'` (every existing
--      SKU reads active; no data statement), `inactive_reason text`
--   2. the CHECKs (migration SQL only; mirrored by `SKU_STATUSES` in
--      schema.ts and the status command):
--        skus_status_check              status IN ('active','inactive')
--        skus_inactive_reason_pairing   the reason is NULL unless inactive
--        skus_inactive_reason_length    1–500 characters when present
--      Trimming is the command's (decision 14), not a CHECK's.
--   3. assert: every existing SKU is active with no reason, and each CHECK
--      refuses its named bad shape and admits a good one (rolled back by a
--      sentinel exception, so a CHECK that refused everything fails too)
--
-- No foreign keys, no new table, no RLS change. Lock cost: ACCESS EXCLUSIVE
-- on `skus` for the ADD COLUMN (a constant default — no rewrite) and the
-- CHECK validation scan.

-- ── 0. fail-fast ─────────────────────────────────────────────────────────
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name = 'skus' AND column_name = 'status'
	) THEN
		RAISE EXCEPTION 'migration 0082: skus.status already exists — this migration has already been applied.';
	END IF;
END $$;
--> statement-breakpoint

-- ── 1. the columns ───────────────────────────────────────────────────────
ALTER TABLE "skus" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "inactive_reason" text;--> statement-breakpoint

-- ── 2. the CHECKs ────────────────────────────────────────────────────────
-- `status` is NOT NULL, so the IN list needs no IS NOT NULL arm.
ALTER TABLE "skus" ADD CONSTRAINT "skus_status_check" CHECK ("status" IN ('active', 'inactive'));--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_inactive_reason_pairing" CHECK (
	"inactive_reason" IS NULL OR "status" = 'inactive'
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_inactive_reason_length" CHECK (
	"inactive_reason" IS NULL OR char_length("inactive_reason") BETWEEN 1 AND 500
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
BEGIN
	SELECT count(*) INTO bad FROM "skus" WHERE "status" <> 'active' OR "inactive_reason" IS NOT NULL;
	IF bad > 0 THEN
		RAISE EXCEPTION 'migration 0082: % existing SKU(s) did not read active with no reason.', bad;
	END IF;

	-- (a) accepted shapes, rolled back by a sentinel exception.
	BEGIN
		INSERT INTO "skus" ("id","tenant_id","client_id","code","name","uom","gst_rate_bps","barcode","status","inactive_reason")
		VALUES (gen_random_uuid(), t, c, 'P-0082-A', 'Probe A', 'each', 0, 'P0082A', 'active', NULL),
		       (gen_random_uuid(), t, c, 'P-0082-B', 'Probe B', 'each', 0, 'P0082B', 'inactive', NULL),
		       (gen_random_uuid(), t, c, 'P-0082-C', 'Probe C', 'each', 0, 'P0082C', 'inactive', 'x'),
		       (gen_random_uuid(), t, c, 'P-0082-D', 'Probe D', 'each', 0, 'P0082D', 'inactive', repeat('r', 500));
		RAISE EXCEPTION USING ERRCODE = 'P0082', MESSAGE = 'rollback the accepted probes';
	EXCEPTION
		WHEN check_violation OR unique_violation THEN
			RAISE EXCEPTION 'migration 0082: an accepted shape was refused (%).', SQLERRM;
		WHEN SQLSTATE 'P0082' THEN
			NULL;
	END;

	-- (b) refused shapes, each by its named constraint.
	FOREACH probe IN ARRAY ARRAY['status unknown', 'reason while active', 'reason empty', 'reason too long'] LOOP
		refused_by := NULL;
		expected := CASE probe
			WHEN 'status unknown' THEN 'skus_status_check'
			WHEN 'reason while active' THEN 'skus_inactive_reason_pairing'
			ELSE 'skus_inactive_reason_length'
		END;
		BEGIN
			CASE probe
				WHEN 'status unknown' THEN
					INSERT INTO "skus" ("id","tenant_id","client_id","code","name","uom","gst_rate_bps","barcode","status")
					VALUES (gen_random_uuid(), t, c, 'P1', 'n', 'each', 0, 'B1', 'blocked');
				WHEN 'reason while active' THEN
					INSERT INTO "skus" ("id","tenant_id","client_id","code","name","uom","gst_rate_bps","barcode","status","inactive_reason")
					VALUES (gen_random_uuid(), t, c, 'P1', 'n', 'each', 0, 'B1', 'active', 'why');
				WHEN 'reason empty' THEN
					INSERT INTO "skus" ("id","tenant_id","client_id","code","name","uom","gst_rate_bps","barcode","status","inactive_reason")
					VALUES (gen_random_uuid(), t, c, 'P1', 'n', 'each', 0, 'B1', 'inactive', '');
				ELSE
					INSERT INTO "skus" ("id","tenant_id","client_id","code","name","uom","gst_rate_bps","barcode","status","inactive_reason")
					VALUES (gen_random_uuid(), t, c, 'P1', 'n', 'each', 0, 'B1', 'inactive', repeat('r', 501));
			END CASE;
			RAISE EXCEPTION 'migration 0082: the probe "%" was admitted — % must refuse it.', probe, expected;
		EXCEPTION
			WHEN check_violation THEN
				GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
				IF refused_by IS DISTINCT FROM expected THEN
					RAISE EXCEPTION 'migration 0082: the probe "%" was refused by % — expected %.', probe, refused_by, expected;
				END IF;
		END;
	END LOOP;
	IF EXISTS (SELECT 1 FROM "skus" WHERE "tenant_id" = t) THEN
		RAISE EXCEPTION 'migration 0082: a probe row survived.';
	END IF;
END $$;
