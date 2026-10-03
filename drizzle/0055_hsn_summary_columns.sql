-- ── hand-written (the 0054 pattern): story 8-2a, the HSN summary's read model ──
-- Two READ-MODEL columns, each backfilled from the frozen invoice document,
-- so the HSN summary filters by period and groups by unit with an indexed,
-- set-based aggregate instead of scanning every document's jsonb:
--
--   1. invoices.issued_at — the issuance instant, the SAME value as
--      `document.header.issuedAt`. NULL while awaiting-data; set on every
--      issued/voided row (a two-way CHECK). Only issued and voided rows are
--      backfilled: an 8-1 row re-parked awaiting-data can carry a stale
--      `issuedAt` in its document, which must NOT become an issue instant.
--   2. invoice_lines.uom — the SKU's base UoM at generation (the document
--      line's `uom`). No vocabulary CHECK: a frozen snapshot must survive a
--      later vocabulary change.
--
-- The uom backfill joins each line to its document line on
-- (invoice_id, orderLineId) — the key this migration also makes UNIQUE, so
-- the join can never fan out later. Statement ORDER is load-bearing: guard →
-- pre-flight → nullable ADD → backfill → SET NOT NULL → CHECKs → UNIQUE →
-- index (a NOT NULL or CHECK before its backfill fails only on a non-empty
-- table, invisibly in CI's empty databases).
--
-- Nothing else on any row changes — not the document, not revision, not
-- updated_at. The proof is test/invoicing-migration.spec.ts (a scratch
-- database migrated to 0054, seeded, then this file applied whole, with a
-- whole-row `to_jsonb(row) - 'issued_at' - 'uom'` comparison).
--
-- Lock window: the backfill UPDATEs rewrite both tables under ACCESS
-- EXCLUSIVE / ROW EXCLUSIVE locks for the length of the deploy transaction.
-- Acceptable at current volumes — 0054 already rewrote every invoice row.
--
-- drizzle-kit is blind to CHECKs and data statements; the journal entry and
-- snapshot are git-added with this file, and `bun run db:generate`
-- afterwards reports "No schema changes".

-- Step 1 — guards: re-run (would re-backfill) and out-of-order.
DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'invoices' AND column_name = 'issued_at') <> 0
		OR (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'invoice_lines' AND column_name = 'uom') <> 0 THEN
		RAISE EXCEPTION 'migration 0055 has already been applied: invoices.issued_at or invoice_lines.uom already exists.';
	END IF;
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'invoices' AND column_name = 'payable_paise') = 0 THEN
		RAISE EXCEPTION 'migration 0055 is out of order: invoices.payable_paise does not exist — 0054 must be applied first.';
	END IF;
END $$;--> statement-breakpoint
-- Step 2 — pre-flight: every row the backfill or the new constraints cannot
-- carry, listed at once (an operator fixes them in one pass, not one per run).
--   (a) an issued or voided row whose document `issuedAt` is null or not an
--       ISO-8601 UTC instant ending in `Z`;
--   (b) a line matching zero, or several, of its invoice's document lines
--       on orderLineId;
--   (c) a line whose (single) matched document line carries a null or blank
--       `uom`;
--   (d) duplicate (invoice_id, order_line_id) rows — the new UNIQUE would
--       refuse them with no row named.
DO $$
DECLARE
	bad_issued text;
	bad_match text;
	bad_uom text;
	dup_lines text;
BEGIN
	SELECT string_agg("id"::text || ' (' || "status" || ', issuedAt ' || coalesce("document"->'header'->>'issuedAt', 'null') || ')', ', ')
		INTO bad_issued
		FROM "invoices"
		WHERE "status" IN ('issued', 'voided')
			AND (("document"->'header'->>'issuedAt') IS NULL
				OR ("document"->'header'->>'issuedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$');
	WITH matches AS (
		SELECT l."id", l."invoice_id", l."order_line_id",
			(SELECT count(*) FROM jsonb_array_elements(
				CASE WHEN jsonb_typeof(i."document"->'lines') = 'array' THEN i."document"->'lines' ELSE '[]'::jsonb END) AS elem
				WHERE elem->>'orderLineId' = l."order_line_id"::text) AS n,
			(SELECT min(elem->>'uom') FROM jsonb_array_elements(
				CASE WHEN jsonb_typeof(i."document"->'lines') = 'array' THEN i."document"->'lines' ELSE '[]'::jsonb END) AS elem
				WHERE elem->>'orderLineId' = l."order_line_id"::text) AS matched_uom
		FROM "invoice_lines" l
		-- LEFT: a line whose invoice row is missing matches nothing (n = 0).
		LEFT JOIN "invoices" i ON i."id" = l."invoice_id"
	)
	SELECT
		string_agg(CASE WHEN n <> 1 THEN "id"::text || ' (invoice ' || "invoice_id"::text || ', ' || n::text || ' matches)' END, ', '),
		string_agg(CASE WHEN n = 1 AND (matched_uom IS NULL OR btrim(matched_uom) = '') THEN "id"::text || ' (invoice ' || "invoice_id"::text || ')' END, ', ')
		INTO bad_match, bad_uom
		FROM matches;
	SELECT string_agg(d."invoice_id"::text || '/' || d."order_line_id"::text || ' (' || d.n::text || ' rows)', ', ')
		INTO dup_lines
		FROM (SELECT "invoice_id", "order_line_id", count(*) AS n FROM "invoice_lines" GROUP BY 1, 2 HAVING count(*) > 1) d;
	IF bad_issued IS NOT NULL OR bad_match IS NOT NULL OR bad_uom IS NOT NULL OR dup_lines IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0055 pre-flight failed. Issued/voided invoices without an ISO-Z document issuedAt: [%]. Lines matching zero or several document lines: [%]. Lines whose document uom is null or blank: [%]. Duplicate (invoice_id, order_line_id) lines: [%].',
			coalesce(bad_issued, 'none'), coalesce(bad_match, 'none'), coalesce(bad_uom, 'none'), coalesce(dup_lines, 'none');
	END IF;
END $$;--> statement-breakpoint
-- Step 3 — the columns, nullable and with no DEFAULT (a default would let a
-- later write forget them; the backfill below states every row's value).
ALTER TABLE "invoices" ADD COLUMN "issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "uom" text;--> statement-breakpoint
-- Step 4 — backfill. issued_at ONLY on issued/voided rows (an awaiting row's
-- document may carry a stale 8-1 issuedAt — it stays NULL). The ISO-Z text
-- casts to the same instant whatever the session time zone.
UPDATE "invoices" SET "issued_at" = ("document"->'header'->>'issuedAt')::timestamptz
	WHERE "status" IN ('issued', 'voided');--> statement-breakpoint
-- uom from the line's own invoice's document only (the pre-flight proved
-- exactly one match per line).
UPDATE "invoice_lines" AS l SET "uom" = (
	SELECT elem->>'uom'
	FROM "invoices" i, jsonb_array_elements(i."document"->'lines') AS elem
	WHERE i."id" = l."invoice_id" AND elem->>'orderLineId' = l."order_line_id"::text
);--> statement-breakpoint
-- Step 5 — every line now carries its unit.
ALTER TABLE "invoice_lines" ALTER COLUMN "uom" SET NOT NULL;--> statement-breakpoint
-- Step 6 — the issuance instant exists exactly when the invoice has issued.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_awaiting_unissued_check" CHECK ("status" <> 'awaiting-data' OR "issued_at" IS NULL);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_at_stamped_check" CHECK ("status" = 'awaiting-data' OR "issued_at" IS NOT NULL);--> statement-breakpoint
-- Step 7 — one line per order line per invoice (the backfill's join key).
CREATE UNIQUE INDEX "invoice_lines_invoice_order_line_unique" ON "invoice_lines" USING btree ("invoice_id","order_line_id");--> statement-breakpoint
-- Step 8 — the HSN summary's scan: issued rows per (tenant, GSTIN, instant).
CREATE INDEX "invoices_tenant_gstin_issued_at_idx" ON "invoices" USING btree ("tenant_id","origin_gstin","issued_at") WHERE status = 'issued';
