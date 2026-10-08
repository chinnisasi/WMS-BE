-- ── hand-amended (the 0060–0063 pattern): story 21-6, advance shipment notices ──
-- Two new tables — `advance_shipment_notices` (the ASN header, a deliberate
-- mirror of `purchase_orders`) and `asn_lines` — plus the receiving columns
-- that let ONE `grn.submit` book against a PO, an ASN, or neither (blind):
--   * `goods_receipt_notes.asn_id`, and the blind-pairing CHECK widened to
--     three arms (DROP then re-ADD under the SAME name — the 0023/0024
--     precedent; the reason list is written out IN FULL, unchanged);
--   * `goods_receipt_lines.asn_line_id`, never beside `po_line_id`;
--   * `over_receipts.asn_id` / `asn_line_id`, with a CHECK that exactly one
--     of the document pairs is set, each pair together.
--
-- drizzle-kit generated the table/column/index DDL below; the CHECKs, the
-- RLS policies, the guards and the probes are hand-written (drizzle-kit is
-- blind to them). The journal entry and snapshot are git-added with this
-- file; `bun run db:generate` afterwards reports "No schema changes".

-- ── 0. the fail-fast guard ────────────────────────────────────────────────
DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'advance_shipment_notices') <> 0 THEN
		RAISE EXCEPTION 'migration 0064 has already been applied: advance_shipment_notices already exists.';
	END IF;
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'goods_receipt_notes' AND column_name = 'asn_id') <> 0 THEN
		RAISE EXCEPTION 'migration 0064 has already been applied: goods_receipt_notes.asn_id already exists.';
	END IF;
END $$;--> statement-breakpoint
-- ── 1. pre-flight ────────────────────────────────────────────────────────
-- (a) The new over-receipt pair CHECK requires every EXISTING row to name its
-- PO and PO line (a blind receipt never pended an excess — the submit only
-- raises one against a PO line). Listed all at once if any row would fail.
-- (b) Decision 3 makes PO close refuse while any over-receipt is pending, and
-- approve never refuses on document status — so an excess left pending on a
-- PO closed BEFORE 21-6 stays decidable. Counted and reported here so the
-- operator knows how many such rows the queue still carries.
DO $$
DECLARE
	offenders text;
	legacy_pending bigint;
BEGIN
	SELECT string_agg("id"::text, ', ' ORDER BY "id") INTO offenders
	FROM "over_receipts"
	WHERE "po_id" IS NULL OR "po_line_id" IS NULL;
	IF offenders IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0064 pre-flight: over_receipts rows without a PO and PO line cannot satisfy the new document pair CHECK: %', offenders;
	END IF;
	-- (c) 0013's pairing admitted a GRN with neither a PO nor a reason (NULL
	-- IN (…) is NULL); the widened CHECK refuses it, so list any first.
	SELECT string_agg("code", ', ' ORDER BY "code") INTO offenders
	FROM "goods_receipt_notes"
	WHERE "po_id" IS NULL AND "blind_reason_code" IS NULL;
	IF offenders IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0064 pre-flight: goods receipts with neither a purchase order nor a blind reason cannot satisfy the widened pairing CHECK: %', offenders;
	END IF;
	SELECT count(*) INTO legacy_pending
	FROM "over_receipts" o
	JOIN "purchase_orders" p ON p."tenant_id" = o."tenant_id" AND p."id" = o."po_id"
	WHERE o."status" = 'pending' AND p."status" = 'closed';
	RAISE NOTICE 'migration 0064: % pending over-receipt(s) sit on purchase orders closed before 21-6 — they stay approvable and rejectable.', legacy_pending;
END $$;--> statement-breakpoint
CREATE TABLE "advance_shipment_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"asn_code" text NOT NULL,
	"status" text DEFAULT 'announced' NOT NULL,
	"expected_at" timestamp with time zone,
	"status_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asn_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asn_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"announced_qty" bigint NOT NULL,
	"received_qty" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "asn_line_id" uuid;--> statement-breakpoint
ALTER TABLE "goods_receipt_notes" ADD COLUMN "asn_id" uuid;--> statement-breakpoint
ALTER TABLE "over_receipts" ADD COLUMN "asn_id" uuid;--> statement-breakpoint
ALTER TABLE "over_receipts" ADD COLUMN "asn_line_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "advance_shipment_notices_tenant_client_code_unique" ON "advance_shipment_notices" USING btree ("tenant_id","client_id","asn_code");--> statement-breakpoint
CREATE INDEX "advance_shipment_notices_tenant_warehouse_status_idx" ON "advance_shipment_notices" USING btree ("tenant_id","warehouse_id","status");--> statement-breakpoint
CREATE INDEX "advance_shipment_notices_tenant_warehouse_created_at_id_idx" ON "advance_shipment_notices" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
CREATE INDEX "asn_lines_asn_id_idx" ON "asn_lines" USING btree ("asn_id","created_at","id");--> statement-breakpoint
CREATE INDEX "goods_receipt_notes_tenant_asn_idx" ON "goods_receipt_notes" USING btree ("tenant_id","asn_id");--> statement-breakpoint
CREATE INDEX "over_receipts_tenant_po_idx" ON "over_receipts" USING btree ("tenant_id","po_id");--> statement-breakpoint
CREATE INDEX "over_receipts_tenant_asn_idx" ON "over_receipts" USING btree ("tenant_id","asn_id");--> statement-breakpoint
-- ── hand-amended: the ASN CHECKs ──────────────────────────────────────────
-- The status vocabulary mirrors `ASN_STATUSES` (asn.command.ts) — pinned
-- against this constraint by `test/asn.spec.ts`. `closed` and `cancelled`
-- are the two explicit terminal states and carry the operator's note; the
-- three derived states never do.
ALTER TABLE "advance_shipment_notices" ADD CONSTRAINT "advance_shipment_notices_status_check"
	CHECK ("status" IN ('announced','partially_received','received','closed','cancelled'));--> statement-breakpoint
ALTER TABLE "advance_shipment_notices" ADD CONSTRAINT "advance_shipment_notices_code_length"
	CHECK (char_length("asn_code") BETWEEN 1 AND 64);--> statement-breakpoint
-- Written as an equivalence (not an enumeration of the statuses) so it never
-- overlaps the status CHECK: an unknown status is refused by the status CHECK
-- ALONE, which is what lets the post-assertion probe each one separately.
ALTER TABLE "advance_shipment_notices" ADD CONSTRAINT "advance_shipment_notices_note_pairing"
	CHECK (
		("status" IN ('closed','cancelled')) = ("status_note" IS NOT NULL)
		AND ("status_note" IS NULL OR char_length("status_note") BETWEEN 1 AND 500)
	);--> statement-breakpoint
-- No `received_qty <= announced_qty` ceiling — an approved over-receipt drives
-- received past announced, exactly as on a PO line (0013's decision).
ALTER TABLE "asn_lines" ADD CONSTRAINT "asn_lines_announced_qty_positive" CHECK ("announced_qty" > 0);--> statement-breakpoint
ALTER TABLE "asn_lines" ADD CONSTRAINT "asn_lines_received_qty_nonnegative" CHECK ("received_qty" >= 0);--> statement-breakpoint
-- ── hand-amended: the receiving backstops ─────────────────────────────────
-- A GRN references exactly ONE of: a PO, an ASN, or neither — and then it
-- carries a blind reason from the fixed list. The list is written out in full
-- and is unchanged from 0013 (a new reason still needs a migration).
-- `IS NOT NULL` is load-bearing and NEW: 0013's arm read `po_id IS NULL AND
-- blind_reason_code IN (…)`, and `NULL IN (…)` is NULL, which a CHECK treats
-- as a pass — so a GRN with neither a PO nor a reason was admitted. The
-- command never wrote one (its 400 came first); the pre-flight lists any.
ALTER TABLE "goods_receipt_notes" DROP CONSTRAINT "goods_receipt_notes_blind_pairing";--> statement-breakpoint
ALTER TABLE "goods_receipt_notes" ADD CONSTRAINT "goods_receipt_notes_blind_pairing" CHECK (
	("po_id" IS NOT NULL AND "asn_id" IS NULL AND "blind_reason_code" IS NULL)
	OR ("asn_id" IS NOT NULL AND "po_id" IS NULL AND "blind_reason_code" IS NULL)
	OR ("po_id" IS NULL AND "asn_id" IS NULL AND "blind_reason_code" IS NOT NULL
		AND "blind_reason_code" IN ('unannounced-delivery','po-not-found','other'))
);--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_one_line_reference"
	CHECK ("po_line_id" IS NULL OR "asn_line_id" IS NULL);--> statement-breakpoint
ALTER TABLE "over_receipts" ADD CONSTRAINT "over_receipts_document_pair" CHECK (
	("po_id" IS NOT NULL AND "po_line_id" IS NOT NULL AND "asn_id" IS NULL AND "asn_line_id" IS NULL)
	OR ("asn_id" IS NOT NULL AND "asn_line_id" IS NOT NULL AND "po_id" IS NULL AND "po_line_id" IS NULL)
);--> statement-breakpoint
-- ── hand-amended: RLS — the AD-24 client clause ───────────────────────────
-- The header carries `client_id` and the same null-tolerant clause as
-- `purchase_orders` (0041): an operator session sees the tenant, a portal
-- session only its own client's ASNs — for reads AND writes (21-7's portal
-- announces shipments). The lines carry no client column: their visibility
-- rides the parent (the 0062 `client_invoice_lines` shape) — a portal
-- session sees, and may write, only lines under an ASN it can see.
ALTER TABLE "advance_shipment_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asn_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "advance_shipment_notices_tenant_isolation" ON "advance_shipment_notices"
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
CREATE POLICY "asn_lines_tenant_isolation" ON "asn_lines"
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR EXISTS (
				SELECT 1 FROM "advance_shipment_notices" a
				WHERE a."tenant_id" = "asn_lines"."tenant_id" AND a."id" = "asn_lines"."asn_id"
			)
		)
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR EXISTS (
				SELECT 1 FROM "advance_shipment_notices" a
				WHERE a."tenant_id" = "asn_lines"."tenant_id" AND a."id" = "asn_lines"."asn_id"
			)
		)
	);--> statement-breakpoint
-- ── the post-migration assertion: every new CHECK refuses what it must ────
-- Each probe runs in its own subtransaction and must be refused by `check_violation`
-- (23514) ON THE NAMED CONSTRAINT — a probe another CHECK happens to refuse
-- proves nothing about the one it is written for. An insert that LANDS is a
-- CHECK that does not hold, and aborts the migration. One accepted shape per
-- table is inserted first, and rolled back by a sentinel exception, so a CHECK
-- that refuses everything cannot pass either.
DO $$
DECLARE
	t uuid := gen_random_uuid();
	refused_by text;
	probe text;
	expected text;
BEGIN
	-- (1) the accepted shapes, one or more per table touched.
	BEGIN
		INSERT INTO "goods_receipt_notes" ("id","tenant_id","warehouse_id","code","po_id","asn_id","blind_reason_code","device_id","recorded_by","occurred_at","recorded_at")
		VALUES (gen_random_uuid(), t, t, 'P-0064-A', gen_random_uuid(), NULL, NULL, t, t, now(), now()),
		       (gen_random_uuid(), t, t, 'P-0064-B', NULL, gen_random_uuid(), NULL, t, t, now(), now()),
		       (gen_random_uuid(), t, t, 'P-0064-C', NULL, NULL, 'other', t, t, now(), now());
		INSERT INTO "goods_receipt_lines" ("id","tenant_id","grn_id","po_line_id","asn_line_id","sku_id","qty","applied_qty")
		VALUES (gen_random_uuid(), t, t, gen_random_uuid(), NULL, t, 1000, 1000),
		       (gen_random_uuid(), t, t, NULL, gen_random_uuid(), t, 1000, 1000),
		       (gen_random_uuid(), t, t, NULL, NULL, t, 1000, 1000);
		INSERT INTO "over_receipts" ("id","tenant_id","warehouse_id","grn_id","grn_line_id","po_id","po_line_id","asn_id","asn_line_id","sku_id","excess_qty","requested_by","requested_at")
		VALUES (gen_random_uuid(), t, t, t, t, gen_random_uuid(), gen_random_uuid(), NULL, NULL, t, 1000, t, now()),
		       (gen_random_uuid(), t, t, t, t, NULL, NULL, gen_random_uuid(), gen_random_uuid(), t, 1000, t, now());
		INSERT INTO "advance_shipment_notices" ("id","tenant_id","client_id","warehouse_id","asn_code","status","status_note")
		VALUES (gen_random_uuid(), t, t, t, 'P-0064-1', 'closed', 'short shipment'),
		       (gen_random_uuid(), t, t, t, 'P-0064-2', 'received', NULL);
		INSERT INTO "asn_lines" ("id","tenant_id","asn_id","sku_id","announced_qty","received_qty")
		VALUES (gen_random_uuid(), t, t, t, 1000, 0),
		       (gen_random_uuid(), t, t, t, 1000, 2000);
		RAISE EXCEPTION USING ERRCODE = 'P0064', MESSAGE = 'rollback the accepted probes';
	EXCEPTION WHEN SQLSTATE 'P0064' THEN NULL;
	END;
	-- (2) the refused shapes, each naming the constraint that must refuse it.
	FOREACH probe IN ARRAY ARRAY[
		'grn: po and asn',
		'grn: asn and reason',
		'grn: po and reason',
		'grn: neither, no reason',
		'grn: neither, unknown reason',
		'grn line: both references',
		'over-receipt: no pair',
		'over-receipt: both pairs',
		'over-receipt: split pair',
		'asn: unknown status',
		'asn: closed without a note',
		'asn: announced with a note',
		'asn: overlong note',
		'asn: empty code',
		'asn line: zero announced',
		'asn line: negative received'
	] LOOP
		refused_by := NULL;
		expected := CASE
			WHEN probe LIKE 'grn:%' THEN 'goods_receipt_notes_blind_pairing'
			WHEN probe LIKE 'grn line:%' THEN 'goods_receipt_lines_one_line_reference'
			WHEN probe LIKE 'over-receipt:%' THEN 'over_receipts_document_pair'
			WHEN probe = 'asn: unknown status' THEN 'advance_shipment_notices_status_check'
			WHEN probe = 'asn: empty code' THEN 'advance_shipment_notices_code_length'
			WHEN probe LIKE 'asn:%' THEN 'advance_shipment_notices_note_pairing'
			WHEN probe = 'asn line: zero announced' THEN 'asn_lines_announced_qty_positive'
			ELSE 'asn_lines_received_qty_nonnegative'
		END;
		BEGIN
			CASE probe
				WHEN 'grn: po and asn' THEN
					INSERT INTO "goods_receipt_notes" ("id","tenant_id","warehouse_id","code","po_id","asn_id","device_id","recorded_by","occurred_at","recorded_at")
					VALUES (gen_random_uuid(), t, t, 'P1', gen_random_uuid(), gen_random_uuid(), t, t, now(), now());
				WHEN 'grn: asn and reason' THEN
					INSERT INTO "goods_receipt_notes" ("id","tenant_id","warehouse_id","code","asn_id","blind_reason_code","device_id","recorded_by","occurred_at","recorded_at")
					VALUES (gen_random_uuid(), t, t, 'P2', gen_random_uuid(), 'other', t, t, now(), now());
				WHEN 'grn: po and reason' THEN
					INSERT INTO "goods_receipt_notes" ("id","tenant_id","warehouse_id","code","po_id","blind_reason_code","device_id","recorded_by","occurred_at","recorded_at")
					VALUES (gen_random_uuid(), t, t, 'P3', gen_random_uuid(), 'other', t, t, now(), now());
				WHEN 'grn: neither, no reason' THEN
					INSERT INTO "goods_receipt_notes" ("id","tenant_id","warehouse_id","code","device_id","recorded_by","occurred_at","recorded_at")
					VALUES (gen_random_uuid(), t, t, 'P4', t, t, now(), now());
				WHEN 'grn: neither, unknown reason' THEN
					INSERT INTO "goods_receipt_notes" ("id","tenant_id","warehouse_id","code","blind_reason_code","device_id","recorded_by","occurred_at","recorded_at")
					VALUES (gen_random_uuid(), t, t, 'P5', 'asn-not-found', t, t, now(), now());
				WHEN 'grn line: both references' THEN
					INSERT INTO "goods_receipt_lines" ("id","tenant_id","grn_id","po_line_id","asn_line_id","sku_id","qty","applied_qty")
					VALUES (gen_random_uuid(), t, t, gen_random_uuid(), gen_random_uuid(), t, 1000, 1000);
				WHEN 'over-receipt: no pair' THEN
					INSERT INTO "over_receipts" ("id","tenant_id","warehouse_id","grn_id","grn_line_id","sku_id","excess_qty","requested_by","requested_at")
					VALUES (gen_random_uuid(), t, t, t, t, t, 1000, t, now());
				WHEN 'over-receipt: both pairs' THEN
					INSERT INTO "over_receipts" ("id","tenant_id","warehouse_id","grn_id","grn_line_id","po_id","po_line_id","asn_id","asn_line_id","sku_id","excess_qty","requested_by","requested_at")
					VALUES (gen_random_uuid(), t, t, t, t, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), t, 1000, t, now());
				WHEN 'over-receipt: split pair' THEN
					INSERT INTO "over_receipts" ("id","tenant_id","warehouse_id","grn_id","grn_line_id","po_id","asn_line_id","sku_id","excess_qty","requested_by","requested_at")
					VALUES (gen_random_uuid(), t, t, t, t, gen_random_uuid(), gen_random_uuid(), t, 1000, t, now());
				WHEN 'asn: unknown status' THEN
					-- No note, so only the status CHECK can refuse it.
					INSERT INTO "advance_shipment_notices" ("id","tenant_id","client_id","warehouse_id","asn_code","status")
					VALUES (gen_random_uuid(), t, t, t, 'P10', 'open');
				WHEN 'asn: closed without a note' THEN
					INSERT INTO "advance_shipment_notices" ("id","tenant_id","client_id","warehouse_id","asn_code","status")
					VALUES (gen_random_uuid(), t, t, t, 'P11', 'closed');
				WHEN 'asn: announced with a note' THEN
					INSERT INTO "advance_shipment_notices" ("id","tenant_id","client_id","warehouse_id","asn_code","status","status_note")
					VALUES (gen_random_uuid(), t, t, t, 'P12', 'announced', 'note');
				WHEN 'asn: overlong note' THEN
					INSERT INTO "advance_shipment_notices" ("id","tenant_id","client_id","warehouse_id","asn_code","status","status_note")
					VALUES (gen_random_uuid(), t, t, t, 'P13', 'cancelled', repeat('x', 501));
				WHEN 'asn: empty code' THEN
					INSERT INTO "advance_shipment_notices" ("id","tenant_id","client_id","warehouse_id","asn_code")
					VALUES (gen_random_uuid(), t, t, t, '');
				WHEN 'asn line: zero announced' THEN
					INSERT INTO "asn_lines" ("id","tenant_id","asn_id","sku_id","announced_qty")
					VALUES (gen_random_uuid(), t, t, t, 0);
				WHEN 'asn line: negative received' THEN
					INSERT INTO "asn_lines" ("id","tenant_id","asn_id","sku_id","announced_qty","received_qty")
					VALUES (gen_random_uuid(), t, t, t, 1000, -1);
			END CASE;
		EXCEPTION WHEN check_violation THEN
			GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
		END;
		IF refused_by IS NULL THEN
			RAISE EXCEPTION 'migration 0064: the CHECK probe "%" was not refused.', probe;
		END IF;
		IF refused_by <> expected THEN
			RAISE EXCEPTION 'migration 0064: the CHECK probe "%" was refused by % — expected %.', probe, refused_by, expected;
		END IF;
	END LOOP;
	-- Nothing a probe wrote survived (each refused insert rolled back).
	IF EXISTS (SELECT 1 FROM "goods_receipt_notes" WHERE "tenant_id" = t)
		OR EXISTS (SELECT 1 FROM "goods_receipt_lines" WHERE "tenant_id" = t)
		OR EXISTS (SELECT 1 FROM "over_receipts" WHERE "tenant_id" = t)
		OR EXISTS (SELECT 1 FROM "advance_shipment_notices" WHERE "tenant_id" = t)
		OR EXISTS (SELECT 1 FROM "asn_lines" WHERE "tenant_id" = t) THEN
		RAISE EXCEPTION 'migration 0064: a CHECK probe row survived.';
	END IF;
END $$;
