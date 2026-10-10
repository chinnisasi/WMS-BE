-- ── hand-written: story 21-9, a late receipt pends with or without a line ──
-- A receipt against a terminal document (a cancelled or closed ASN, a closed
-- PO) is accepted and held: every line becomes an over-receipt pending
-- approval against THAT document. A line that matches no document line (no
-- reference, a SKU that differs from its line, a line id that no longer
-- exists) pends too — against the document, with NO line (decision 2). So
-- `over_receipts_document_pair` relaxes: exactly one document, and a line
-- only beside its own document; the line itself becomes optional.
--
--   0064: (po, po_line, —, —) OR (—, —, asn, asn_line)
--   0066: (po, po_line?, —, —) OR (—, —, asn, asn_line?)
--
-- Forward-only. No pre-flight and no fail-fast guard: relaxing a CHECK
-- strands no stored row (every row 0064 admitted, 0066 admits), and a re-run
-- drops and re-adds the same constraint. Rollback-safe: older code already
-- reads a null `po_line_id` (the over-receipt DTO's `poLineId` is nullable,
-- the web's `lineContext` handles one).
--
-- drizzle-kit is blind to CHECKs: the snapshot is 0065's with a new id, and
-- `bun run db:generate` afterwards reports "No schema changes".
ALTER TABLE "over_receipts" DROP CONSTRAINT "over_receipts_document_pair";--> statement-breakpoint
ALTER TABLE "over_receipts" ADD CONSTRAINT "over_receipts_document_pair" CHECK (
	("po_id" IS NOT NULL AND "asn_id" IS NULL AND "asn_line_id" IS NULL)
	OR ("asn_id" IS NOT NULL AND "po_id" IS NULL AND "po_line_id" IS NULL)
);--> statement-breakpoint
-- ── the post-migration assertion (the 0064 model) ─────────────────────────
-- The accepted shapes are inserted first and rolled back by a sentinel, so a
-- CHECK that refuses everything cannot pass. Each refused shape runs in its
-- own subtransaction and must be refused by `check_violation` ON THE NAMED
-- CONSTRAINT — a probe another CHECK happens to refuse proves nothing.
DO $$
DECLARE
	t uuid := gen_random_uuid();
	refused_by text;
	probe text;
BEGIN
	-- (1) the accepted shapes: a PO and an ASN row with no line (new), and
	-- both fully lined shapes (unchanged).
	BEGIN
		INSERT INTO "over_receipts" ("id","tenant_id","warehouse_id","grn_id","grn_line_id","po_id","po_line_id","asn_id","asn_line_id","sku_id","excess_qty","requested_by","requested_at")
		VALUES (gen_random_uuid(), t, t, t, t, gen_random_uuid(), NULL, NULL, NULL, t, 1000, t, now()),
		       (gen_random_uuid(), t, t, t, t, NULL, NULL, gen_random_uuid(), NULL, t, 1000, t, now()),
		       (gen_random_uuid(), t, t, t, t, gen_random_uuid(), gen_random_uuid(), NULL, NULL, t, 1000, t, now()),
		       (gen_random_uuid(), t, t, t, t, NULL, NULL, gen_random_uuid(), gen_random_uuid(), t, 1000, t, now());
		RAISE EXCEPTION USING ERRCODE = 'P0066', MESSAGE = 'rollback the accepted probes';
	EXCEPTION
		WHEN check_violation THEN
			RAISE EXCEPTION 'migration 0066: an accepted over-receipt shape was refused — over_receipts_document_pair refuses what it must admit.';
		WHEN SQLSTATE 'P0066' THEN
			NULL; -- the accepted shapes landed, and the sentinel rolled them back
	END;
	-- (2) the refused shapes, each by `over_receipts_document_pair`.
	FOREACH probe IN ARRAY ARRAY[
		'no document',
		'both documents',
		'po with an asn line',
		'asn with a po line',
		'a po line with no document',
		'an asn line with no document'
	] LOOP
		refused_by := NULL;
		BEGIN
			CASE probe
				WHEN 'no document' THEN
					INSERT INTO "over_receipts" ("id","tenant_id","warehouse_id","grn_id","grn_line_id","sku_id","excess_qty","requested_by","requested_at")
					VALUES (gen_random_uuid(), t, t, t, t, t, 1000, t, now());
				WHEN 'both documents' THEN
					INSERT INTO "over_receipts" ("id","tenant_id","warehouse_id","grn_id","grn_line_id","po_id","asn_id","sku_id","excess_qty","requested_by","requested_at")
					VALUES (gen_random_uuid(), t, t, t, t, gen_random_uuid(), gen_random_uuid(), t, 1000, t, now());
				WHEN 'po with an asn line' THEN
					INSERT INTO "over_receipts" ("id","tenant_id","warehouse_id","grn_id","grn_line_id","po_id","asn_line_id","sku_id","excess_qty","requested_by","requested_at")
					VALUES (gen_random_uuid(), t, t, t, t, gen_random_uuid(), gen_random_uuid(), t, 1000, t, now());
				WHEN 'asn with a po line' THEN
					INSERT INTO "over_receipts" ("id","tenant_id","warehouse_id","grn_id","grn_line_id","asn_id","po_line_id","sku_id","excess_qty","requested_by","requested_at")
					VALUES (gen_random_uuid(), t, t, t, t, gen_random_uuid(), gen_random_uuid(), t, 1000, t, now());
				WHEN 'a po line with no document' THEN
					INSERT INTO "over_receipts" ("id","tenant_id","warehouse_id","grn_id","grn_line_id","po_line_id","sku_id","excess_qty","requested_by","requested_at")
					VALUES (gen_random_uuid(), t, t, t, t, gen_random_uuid(), t, 1000, t, now());
				WHEN 'an asn line with no document' THEN
					INSERT INTO "over_receipts" ("id","tenant_id","warehouse_id","grn_id","grn_line_id","asn_line_id","sku_id","excess_qty","requested_by","requested_at")
					VALUES (gen_random_uuid(), t, t, t, t, gen_random_uuid(), t, 1000, t, now());
			END CASE;
		EXCEPTION WHEN check_violation THEN
			GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
		END;
		IF refused_by IS NULL THEN
			RAISE EXCEPTION 'migration 0066: the CHECK probe "%" was not refused.', probe;
		END IF;
		IF refused_by <> 'over_receipts_document_pair' THEN
			RAISE EXCEPTION 'migration 0066: the CHECK probe "%" was refused by % — expected over_receipts_document_pair.', probe, refused_by;
		END IF;
	END LOOP;
	IF EXISTS (SELECT 1 FROM "over_receipts" WHERE "tenant_id" = t) THEN
		RAISE EXCEPTION 'migration 0066: a CHECK probe row survived.';
	END IF;
END $$;
