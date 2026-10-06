-- ── hand-amended (the 0056 pattern): story 8-1d, the buyer legal name ──
-- One nullable column on `orders` (outbound-owned, written by the create
-- command only): the GST-registered buyer's legal / trade name, printed as
-- the invoice's buyer and so NIC's `toTrdName`.
--
-- drizzle-kit is blind to CHECKs, so the CHECK below is hand-written. The
-- journal entry and snapshot are git-added with this file, and
-- `bun run db:generate` afterwards reports "No schema changes".
--
-- No backfill: every existing order reads NULL (the invoice falls back to
-- the destination contact name, exactly as before). The CHECK holds on every
-- existing row by construction (NULL), so it is added validated.

DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name = 'consignee_legal_name') <> 0 THEN
		RAISE EXCEPTION 'migration 0057 has already been applied: orders.consignee_legal_name already exists.';
	END IF;
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'eway_bills') = 0 THEN
		RAISE EXCEPTION 'migration 0057 is out of order: eway_bills does not exist — 0056 must be applied first.';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "consignee_legal_name" text;--> statement-breakpoint
-- NULL, or 1–100 characters once trimmed (char_length counts code points —
-- the command's `[...s].length` unit; btrim refuses a whitespace-only name
-- the command would have read as absent) AND a consignee GSTIN beside it (a
-- B2C buyer has no registered name to print).
ALTER TABLE "orders" ADD CONSTRAINT "orders_consignee_legal_name_check" CHECK (
	"consignee_legal_name" IS NULL
	OR (char_length(btrim("consignee_legal_name")) BETWEEN 1 AND 100 AND "consignee_gstin" IS NOT NULL)
);
