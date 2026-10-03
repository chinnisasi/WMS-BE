-- ── hand-written (the 0053 pattern): story 8-1b, the invoice regulatory pass ──
-- Three shape changes, each with the data statements that carry existing rows
-- across (statement ORDER is load-bearing — a NOT NULL or CHECK before the
-- backfill fails on any non-empty table, invisibly in CI's empty databases):
--
--   1. invoices gain the stored rupee round-off: `payable_paise` (half-up at
--      50 paise) and `round_off_paise` (= payable − total, in −49…+50).
--   2. every invoice document's totals become {subtotal, gst, total, roundOff,
--      payable} — the 8-1 `payAble` key is renamed `total` (its value IS the
--      exact total) — and every replayable idempotency snapshot that embeds
--      the old shape is rewritten the same way, so a pre-change key replays
--      the new shape.
--   3. numbering moves to one series per (tenant, supplier GSTIN, FY). Legacy
--      per-tenant series rows keep a NULL `origin_gstin` — a frozen historical
--      series nothing allocates from again — and legacy numbers are untouched.
--
-- An issued invoice gains only DERIVED fields here: its number, subtotal,
-- GST, total, revision and updated_at are never written. The proof is
-- test/invoicing-migration.spec.ts (a scratch database migrated to 0053,
-- seeded, then this file applied whole). drizzle-kit is blind to CHECKs and
-- data statements; the journal entry + snapshot are git-added with this
-- file, and `bun run db:generate` afterwards reports "No schema changes".

-- Step 1 — guards: re-run (would rewrite twice) and out-of-order.
DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'invoices' AND column_name = 'payable_paise') <> 0 THEN
		RAISE EXCEPTION 'migration 0054 has already been applied: invoices.payable_paise already exists. Re-running would rewrite the documents twice.';
	END IF;
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'invoice_series') = 0 THEN
		RAISE EXCEPTION 'migration 0054 is out of order: the invoice_series table does not exist — 0053 must be applied first.';
	END IF;
END $$;--> statement-breakpoint
-- Step 2 — pre-flight: every row that the rewrite or the new CHECKs cannot
-- carry, listed at once (an operator fixes them in one pass, not one per run).
--   (a) a document whose `payAble` is not the row's exact total — the rename
--       to `total` would otherwise silently change what the document says;
--   (b) an issued row without a number or a supplier GSTIN — the new
--       issued ⇒ (number, GSTIN) CHECK would refuse it with no row named.
DO $$
DECLARE
	mismatched text;
	unstamped text;
BEGIN
	SELECT string_agg(id::text || ' (payAble ' || coalesce(document->'totals'->>'payAble', 'absent') || ', total_paise ' || total_paise::text || ')', ', ')
		INTO mismatched
		FROM invoices
		WHERE (document->'totals'->>'payAble')::bigint IS DISTINCT FROM total_paise;
	SELECT string_agg(id::text, ', ')
		INTO unstamped
		FROM invoices
		WHERE status = 'issued' AND (invoice_no IS NULL OR origin_gstin IS NULL);
	IF mismatched IS NOT NULL OR unstamped IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0054 pre-flight failed. Documents whose totals.payAble differs from total_paise: [%]. Issued invoices without invoice_no or origin_gstin: [%].',
			coalesce(mismatched, 'none'), coalesce(unstamped, 'none');
	END IF;
END $$;--> statement-breakpoint
-- Step 3 — the columns, nullable and with no DEFAULT (a default would let a
-- later write forget them; the backfill below states every row's value).
ALTER TABLE "invoices" ADD COLUMN "payable_paise" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "round_off_paise" bigint;--> statement-breakpoint
-- Step 4 — backfill from the total_paise COLUMN (never the document). Integer
-- `div` is floor division, which is half-up here because
-- invoices_money_non_negative_check keeps every total ≥ 0. This is exactly
-- arith.ts `roundToRupee` (the parity test in invoicing.spec.ts pins it).
UPDATE "invoices" SET
	"payable_paise" = div("total_paise" + 50, 100) * 100,
	"round_off_paise" = div("total_paise" + 50, 100) * 100 - "total_paise";--> statement-breakpoint
-- Step 5 — every document's totals, rebuilt from the columns. `revision` and
-- `updated_at` are deliberately not touched: the content of the money did
-- not change, only its presentation.
UPDATE "invoices" SET "document" = jsonb_set(
	"document",
	'{totals}',
	jsonb_build_object(
		'subtotal', "subtotal_paise",
		'gst', "gst_paise",
		'total', "total_paise",
		'roundOff', "round_off_paise",
		'payable', "payable_paise"
	)
);--> statement-breakpoint
-- Step 6 — replayable snapshots of the generate command embed the document
-- (and the row's money fields): rewrite each that still carries `payAble`,
-- from ITS OWN figures (a snapshot may hold an older revision than the row),
-- and add `invoice.payablePaise` / `invoice.roundOffPaise` (from the
-- snapshot's `invoice.totalPaise`, else its document total — a NULL inside
-- jsonb_set would null the WHOLE snapshot).
UPDATE "idempotency_keys" AS k SET "response_snapshot" = jsonb_set(
	jsonb_set(
		jsonb_set(
			k."response_snapshot",
			'{invoice,document,totals}',
			jsonb_build_object(
				'subtotal', s.subtotal,
				'gst', s.gst,
				'total', s.total,
				'roundOff', div(s.total + 50, 100) * 100 - s.total,
				'payable', div(s.total + 50, 100) * 100
			)
		),
		'{invoice,payablePaise}',
		to_jsonb(div(coalesce(s.invoice_total, s.total) + 50, 100) * 100)
	),
	'{invoice,roundOffPaise}',
	to_jsonb(div(coalesce(s.invoice_total, s.total) + 50, 100) * 100 - coalesce(s.invoice_total, s.total))
)
FROM (
	SELECT
		"id",
		("response_snapshot"->'invoice'->'document'->'totals'->>'subtotal')::bigint AS subtotal,
		("response_snapshot"->'invoice'->'document'->'totals'->>'gst')::bigint AS gst,
		("response_snapshot"->'invoice'->'document'->'totals'->>'payAble')::bigint AS total,
		("response_snapshot"->'invoice'->>'totalPaise')::bigint AS invoice_total
	FROM "idempotency_keys"
	WHERE jsonb_typeof("response_snapshot"->'invoice'->'document'->'totals') = 'object'
		AND ("response_snapshot"->'invoice'->'document'->'totals') ? 'payAble'
) AS s
WHERE s."id" = k."id";--> statement-breakpoint
-- Step 7 — now every row carries both values.
ALTER TABLE "invoices" ALTER COLUMN "payable_paise" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "round_off_paise" SET NOT NULL;--> statement-breakpoint
-- Step 8 — the rounding and issuance invariants, in storage.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payable_balance_check" CHECK ("payable_paise" = "total_paise" + "round_off_paise");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_round_off_range_check" CHECK ("round_off_paise" BETWEEN -49 AND 50);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payable_whole_rupee_check" CHECK ("payable_paise" % 100 = 0);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payable_non_negative_check" CHECK ("payable_paise" >= 0);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_stamped_check" CHECK ("status" <> 'issued' OR ("invoice_no" IS NOT NULL AND "origin_gstin" IS NOT NULL));--> statement-breakpoint
-- Step 9 — the series: per supplier GSTIN. Legacy rows keep a NULL GSTIN and
-- fall outside the new (partial) unique; they are never deleted.
ALTER TABLE "invoice_series" ADD COLUMN "origin_gstin" text;--> statement-breakpoint
DROP INDEX "invoice_series_tenant_fy_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_series_tenant_gstin_fy_unique" ON "invoice_series" USING btree ("tenant_id","origin_gstin","fy_label") WHERE origin_gstin is not null;--> statement-breakpoint
-- Step 10 — the invoice-number unique: per (tenant, supplier GSTIN). Every
-- legacy number is unique per tenant already, so it is unique per
-- (tenant, GSTIN) a fortiori — the new index cannot fail on existing rows.
CREATE UNIQUE INDEX "invoices_tenant_gstin_invoice_no_unique" ON "invoices" USING btree ("tenant_id","origin_gstin","invoice_no") WHERE invoice_no is not null;--> statement-breakpoint
DROP INDEX "invoices_tenant_invoice_no_unique";
