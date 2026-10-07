-- ── hand-amended (the 0060–0062 pattern): story 21-5b, the dispute drill-down ──
-- One nullable column: `client_invoices.storage_measured_through` — the last
-- IST day the invoice's storage lines were measured through at its last
-- compute (the supplying-GSTIN group's snapshot watermark, clipped to
-- `period_end`; `period_start − 1` — nothing measured — when the group has
-- no snapshot scope). The dispute drill-down lists a storage line's
-- (day, warehouse) snapshots only up to it, so a draft prepared before the
-- snapshot job finished drills exactly the days its figure counted.
--
-- No data: a row already stored keeps NULL, and NULL means only "stored
-- before 0063". On a non-draft invoice the drill reads it as `period_end` —
-- issue already required storage complete through the month's end; on a
-- draft it reads as nothing measured (a refresh records the real day).
-- Every later compute (prepare, refresh, issue — including a stale issue)
-- writes a date, never NULL.
--
-- The 0062 guard admits the write: `client_invoices_guard` returns NEW for
-- any draft → draft update and checks only the issue rules on draft →
-- issued; a non-draft row's columns (this one included, by the
-- `to_jsonb(NEW) - frozen` comparison) stay frozen. Not part of the content
-- hash — it moves no figure.
--
-- drizzle-kit is blind to the guards below. The journal entry and snapshot
-- are git-added with this file; `bun run db:generate` afterwards reports
-- "No schema changes".

-- ── 0. the fail-fast guard ────────────────────────────────────────────────
DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'client_invoices'
			AND column_name = 'storage_measured_through') <> 0 THEN
		RAISE EXCEPTION 'migration 0063 has already been applied: client_invoices.storage_measured_through already exists.';
	END IF;
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'client_invoices') = 0 THEN
		RAISE EXCEPTION 'migration 0063 needs 0062 first: client_invoices does not exist.';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "storage_measured_through" date;--> statement-breakpoint
-- ── the post-migration assertion ──────────────────────────────────────────
-- The column landed nullable, and every existing row reads NULL (nothing was
-- backfilled — NULL means "issued before 0063", read as period_end).
DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'client_invoices'
			AND column_name = 'storage_measured_through' AND data_type = 'date' AND is_nullable = 'YES') <> 1 THEN
		RAISE EXCEPTION 'migration 0063: client_invoices.storage_measured_through did not land as a nullable date.';
	END IF;
	IF EXISTS (SELECT 1 FROM "client_invoices" WHERE "storage_measured_through" IS NOT NULL) THEN
		RAISE EXCEPTION 'migration 0063: an existing invoice carries a measured-through date — nothing should have been backfilled.';
	END IF;
END $$;
