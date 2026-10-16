-- ── hand-amended (the 0064/0071/0072 pattern): story 13-2, return receipts ──
-- The floor receives returned units scan-first against a return
-- authorization. Two new tables, written ONLY by the returns module (pinned
-- by test/architecture.spec.ts): `return_receipts` (one per `return.receive`
-- op that applied at least one entry) and `return_receipt_lines` (one applied
-- entry each: the RMA line, the quantity, the inspection grade, the batch /
-- serial / handling unit, the `return.received` ledger event). Plus three
-- widenings:
--   * `return_authorizations.status` gains `partially_received | received`
--     (the 0070/0072 DROP-and-re-ADD; `RMA_STATUSES` widens with it);
--   * `return_authorization_lines` gains `received_qty <= authorized_qty`;
--   * `handling_units` gains return provenance — `grn_line_id` becomes
--     nullable, `return_receipt_line_id` is added, and exactly one of the two
--     is set — and the non-packable status `returned` (a returned case
--     awaiting disposition; 13-3 changes it when it restocks).
--
-- drizzle-kit generated the table, column and index DDL below; the CHECKs,
-- the RLS policies and the post-migration probe are hand-written (drizzle-kit
-- is blind to them). The journal entry and snapshot are git-added with this
-- file; `bun run db:generate` afterwards reports "No schema changes".
--
-- No data statement: every existing `handling_units` row carries a
-- `grn_line_id` (it was NOT NULL until this file), and every existing RMA line
-- has `received_qty = 0` (nothing wrote it before 13-2), so both new CHECKs
-- hold over existing rows by construction — the ADD CONSTRAINT validates them
-- and would abort the deploy otherwise. No foreign keys (IMPLEMENTATION-GUIDE
-- §3).
CREATE TABLE "return_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"return_receipt_id" uuid NOT NULL,
	"rma_line_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"qty" bigint NOT NULL,
	"condition" text NOT NULL,
	"note" text,
	"batch_id" uuid,
	"serial_id" uuid,
	"handling_unit_id" uuid,
	"ledger_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "return_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"rma_id" uuid NOT NULL,
	"code" text NOT NULL,
	"device_id" uuid NOT NULL,
	"received_by" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handling_units" ALTER COLUMN "grn_line_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "handling_units" ADD COLUMN "return_receipt_line_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "return_receipt_lines_receipt_line_no_unique" ON "return_receipt_lines" USING btree ("return_receipt_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "return_receipt_lines_rma_line_serial_unique" ON "return_receipt_lines" USING btree ("rma_line_id","serial_id") WHERE "return_receipt_lines"."serial_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "return_receipt_lines_tenant_rma_line_idx" ON "return_receipt_lines" USING btree ("tenant_id","rma_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_receipts_tenant_code_unique" ON "return_receipts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "return_receipts_tenant_rma_idx" ON "return_receipts" USING btree ("tenant_id","rma_id");--> statement-breakpoint
CREATE INDEX "handling_units_tenant_return_receipt_line_idx" ON "handling_units" USING btree ("tenant_id","return_receipt_line_id");--> statement-breakpoint

-- ── hand-amended: the receipt CHECKs ──────────────────────────────────────
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_qty_positive"
	CHECK ("qty" > 0);--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_line_no_positive"
	CHECK ("line_no" >= 1);--> statement-breakpoint
-- The inspection grade (human decision 1) mirrors `RETURN_CONDITIONS`
-- (return-receipt.command.ts), pinned against this constraint by
-- test/return-receipts.spec.ts. The column is NOT NULL, so `IN (…)` cannot
-- pass a NULL through (§3's nullable-CHECK trap does not arise).
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_condition_check"
	CHECK ("condition" IN ('resaleable','opened','damaged','missing-parts'));--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_note_length"
	CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 200 AND "note" = btrim("note")));--> statement-breakpoint
-- A unit is identified by a serial OR a handling unit (catch weight), never
-- both — catalog refuses a SKU that is both serial- and catch-weight tracked.
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_identity_shape"
	CHECK ("serial_id" IS NULL OR "handling_unit_id" IS NULL);--> statement-breakpoint
-- A serial line is exactly one unit (1,000 milli-units).
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_serial_one_unit"
	CHECK ("serial_id" IS NULL OR "qty" = 1000);--> statement-breakpoint
-- ── hand-amended: the RMA widenings ───────────────────────────────────────
-- Received never passes authorized: the command decrements a remaining
-- quantity under the RMA row lock; this is the backstop.
ALTER TABLE "return_authorization_lines" ADD CONSTRAINT "return_authorization_lines_received_within_authorized"
	CHECK ("received_qty" <= "authorized_qty");--> statement-breakpoint
-- The status vocabulary mirrors the widened `RMA_STATUSES` — DROP then
-- re-ADD (§3). The cancel-shape CHECK (an equivalence on `cancelled`) needs
-- no change: a received RMA carries no cancel columns.
ALTER TABLE "return_authorizations" DROP CONSTRAINT "return_authorizations_status_check";--> statement-breakpoint
ALTER TABLE "return_authorizations" ADD CONSTRAINT "return_authorizations_status_check"
	CHECK ("status" IN ('open','partially_received','received','cancelled'));--> statement-breakpoint
-- ── hand-amended: handling-unit provenance and the `returned` status ──────
-- Exactly one provenance: a GRN line (received from a supplier) or a
-- return-receipt line (returned by a customer).
ALTER TABLE "handling_units" ADD CONSTRAINT "handling_units_provenance"
	CHECK (("grn_line_id" IS NULL) <> ("return_receipt_line_id" IS NULL));--> statement-breakpoint
-- `HANDLING_UNIT_STATUSES` (catalog/handling-unit.ts) widens with it — pinned
-- by test/catch-weight.spec.ts. `returned` is NOT packable: pack admits only
-- `active`, so a returned case cannot ship on another order until 13-3
-- restocks it.
ALTER TABLE "handling_units" DROP CONSTRAINT "handling_units_status_check";--> statement-breakpoint
ALTER TABLE "handling_units" ADD CONSTRAINT "handling_units_status_check"
	CHECK ("status" IN ('active', 'pending_approval', 'rejected', 'packed', 'returned'));--> statement-breakpoint
-- ── hand-amended: RLS — the client-scoped document pattern (0072) ─────────
ALTER TABLE "return_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "return_receipts_tenant_isolation" ON "return_receipts"
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
CREATE POLICY "return_receipt_lines_tenant_isolation" ON "return_receipt_lines"
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR EXISTS (
				SELECT 1 FROM "return_receipts" r
				WHERE r."tenant_id" = "return_receipt_lines"."tenant_id" AND r."id" = "return_receipt_lines"."return_receipt_id"
			)
		)
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR EXISTS (
				SELECT 1 FROM "return_receipts" r
				WHERE r."tenant_id" = "return_receipt_lines"."tenant_id" AND r."id" = "return_receipt_lines"."return_receipt_id"
			)
		)
	);--> statement-breakpoint
-- ── the post-migration assertion: every new CHECK refuses what it must ────
-- The 0072 shape: each probe in its own subtransaction, refused by
-- `check_violation` ON THE NAMED CONSTRAINT; the accepted shapes inserted
-- first and rolled back by a sentinel exception, so a CHECK that refuses
-- everything fails too.
DO $$
DECLARE
	t uuid := gen_random_uuid();
	refused_by text;
	probe text;
	expected text;
BEGIN
	-- (1) the accepted shapes.
	BEGIN
		INSERT INTO "return_receipt_lines" ("id","tenant_id","return_receipt_id","rma_line_id","sku_id","line_no","qty","condition","note","batch_id","serial_id","handling_unit_id","ledger_event_id")
		VALUES (gen_random_uuid(), t, t, gen_random_uuid(), t, 1, 2500, 'resaleable', NULL, NULL, NULL, NULL, t),
		       (gen_random_uuid(), t, t, gen_random_uuid(), t, 2, 1000, 'opened', 'seal broken', t, gen_random_uuid(), NULL, t),
		       (gen_random_uuid(), t, t, gen_random_uuid(), t, 3, 1000, 'damaged', NULL, NULL, NULL, gen_random_uuid(), t),
		       (gen_random_uuid(), t, t, gen_random_uuid(), t, 4, 3000, 'missing-parts', 'no charger', NULL, NULL, NULL, t);
		INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","code","status","order_dispatched_at","created_by")
		VALUES (gen_random_uuid(), t, t, t, t, 'P-0073-1', 'partially_received', now(), t),
		       (gen_random_uuid(), t, t, t, t, 'P-0073-2', 'received', now(), t);
		INSERT INTO "return_authorization_lines" ("id","tenant_id","rma_id","line_no","order_line_id","sku_id","authorized_qty","received_qty","reason_code")
		VALUES (gen_random_uuid(), t, t, 1, gen_random_uuid(), t, 2000, 2000, 'damaged');
		INSERT INTO "handling_units" ("id","tenant_id","warehouse_id","sku_id","batch_id","grn_line_id","return_receipt_line_id","weight_grams","status")
		VALUES (gen_random_uuid(), t, t, t, NULL, NULL, gen_random_uuid(), 2340, 'returned'),
		       (gen_random_uuid(), t, t, t, NULL, gen_random_uuid(), NULL, 18400, 'active');
		RAISE EXCEPTION USING ERRCODE = 'P0073', MESSAGE = 'rollback the accepted probes';
	EXCEPTION WHEN SQLSTATE 'P0073' THEN NULL;
	END;
	-- (2) the refused shapes, each naming the constraint that must refuse it.
	FOREACH probe IN ARRAY ARRAY[
		'receipt line: zero qty',
		'receipt line: zero line_no',
		'receipt line: unknown condition',
		'receipt line: empty note',
		'receipt line: overlong note',
		'receipt line: untrimmed note',
		'receipt line: serial and handling unit',
		'receipt line: serial of two units',
		'rma line: received past authorized',
		'rma: unknown status',
		'unit: no provenance',
		'unit: two provenances',
		'unit: unknown status'
	] LOOP
		refused_by := NULL;
		expected := CASE probe
			WHEN 'receipt line: zero qty' THEN 'return_receipt_lines_qty_positive'
			WHEN 'receipt line: zero line_no' THEN 'return_receipt_lines_line_no_positive'
			WHEN 'receipt line: unknown condition' THEN 'return_receipt_lines_condition_check'
			WHEN 'receipt line: empty note' THEN 'return_receipt_lines_note_length'
			WHEN 'receipt line: overlong note' THEN 'return_receipt_lines_note_length'
			WHEN 'receipt line: untrimmed note' THEN 'return_receipt_lines_note_length'
			WHEN 'receipt line: serial and handling unit' THEN 'return_receipt_lines_identity_shape'
			WHEN 'receipt line: serial of two units' THEN 'return_receipt_lines_serial_one_unit'
			WHEN 'rma line: received past authorized' THEN 'return_authorization_lines_received_within_authorized'
			WHEN 'rma: unknown status' THEN 'return_authorizations_status_check'
			WHEN 'unit: no provenance' THEN 'handling_units_provenance'
			WHEN 'unit: two provenances' THEN 'handling_units_provenance'
			ELSE 'handling_units_status_check'
		END;
		BEGIN
			CASE probe
				WHEN 'receipt line: zero qty' THEN
					INSERT INTO "return_receipt_lines" ("id","tenant_id","return_receipt_id","rma_line_id","sku_id","line_no","qty","condition","ledger_event_id")
					VALUES (gen_random_uuid(), t, t, t, t, 1, 0, 'resaleable', t);
				WHEN 'receipt line: zero line_no' THEN
					INSERT INTO "return_receipt_lines" ("id","tenant_id","return_receipt_id","rma_line_id","sku_id","line_no","qty","condition","ledger_event_id")
					VALUES (gen_random_uuid(), t, t, t, t, 0, 1000, 'resaleable', t);
				WHEN 'receipt line: unknown condition' THEN
					INSERT INTO "return_receipt_lines" ("id","tenant_id","return_receipt_id","rma_line_id","sku_id","line_no","qty","condition","ledger_event_id")
					VALUES (gen_random_uuid(), t, t, t, t, 1, 1000, 'mint', t);
				WHEN 'receipt line: empty note' THEN
					INSERT INTO "return_receipt_lines" ("id","tenant_id","return_receipt_id","rma_line_id","sku_id","line_no","qty","condition","note","ledger_event_id")
					VALUES (gen_random_uuid(), t, t, t, t, 1, 1000, 'opened', '', t);
				WHEN 'receipt line: overlong note' THEN
					INSERT INTO "return_receipt_lines" ("id","tenant_id","return_receipt_id","rma_line_id","sku_id","line_no","qty","condition","note","ledger_event_id")
					VALUES (gen_random_uuid(), t, t, t, t, 1, 1000, 'opened', repeat('x', 201), t);
				WHEN 'receipt line: untrimmed note' THEN
					INSERT INTO "return_receipt_lines" ("id","tenant_id","return_receipt_id","rma_line_id","sku_id","line_no","qty","condition","note","ledger_event_id")
					VALUES (gen_random_uuid(), t, t, t, t, 1, 1000, 'opened', ' padded ', t);
				WHEN 'receipt line: serial and handling unit' THEN
					INSERT INTO "return_receipt_lines" ("id","tenant_id","return_receipt_id","rma_line_id","sku_id","line_no","qty","condition","serial_id","handling_unit_id","ledger_event_id")
					VALUES (gen_random_uuid(), t, t, t, t, 1, 1000, 'damaged', gen_random_uuid(), gen_random_uuid(), t);
				WHEN 'receipt line: serial of two units' THEN
					INSERT INTO "return_receipt_lines" ("id","tenant_id","return_receipt_id","rma_line_id","sku_id","line_no","qty","condition","serial_id","ledger_event_id")
					VALUES (gen_random_uuid(), t, t, t, t, 1, 2000, 'damaged', gen_random_uuid(), t);
				WHEN 'rma line: received past authorized' THEN
					INSERT INTO "return_authorization_lines" ("id","tenant_id","rma_id","line_no","order_line_id","sku_id","authorized_qty","received_qty","reason_code")
					VALUES (gen_random_uuid(), t, t, 1, gen_random_uuid(), t, 1000, 2000, 'damaged');
				WHEN 'rma: unknown status' THEN
					-- No cancel columns, so only the status CHECK can refuse it.
					INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","code","status","order_dispatched_at","created_by")
					VALUES (gen_random_uuid(), t, t, t, t, 'P1', 'dispositioned', now(), t);
				WHEN 'unit: no provenance' THEN
					INSERT INTO "handling_units" ("id","tenant_id","warehouse_id","sku_id","weight_grams","status")
					VALUES (gen_random_uuid(), t, t, t, 1000, 'returned');
				WHEN 'unit: two provenances' THEN
					INSERT INTO "handling_units" ("id","tenant_id","warehouse_id","sku_id","grn_line_id","return_receipt_line_id","weight_grams","status")
					VALUES (gen_random_uuid(), t, t, t, gen_random_uuid(), gen_random_uuid(), 1000, 'active');
				WHEN 'unit: unknown status' THEN
					INSERT INTO "handling_units" ("id","tenant_id","warehouse_id","sku_id","grn_line_id","weight_grams","status")
					VALUES (gen_random_uuid(), t, t, t, gen_random_uuid(), 1000, 'restocked');
			END CASE;
		EXCEPTION WHEN check_violation THEN
			GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
		END;
		IF refused_by IS NULL THEN
			RAISE EXCEPTION 'migration 0073: the CHECK probe "%" was not refused.', probe;
		END IF;
		IF refused_by <> expected THEN
			RAISE EXCEPTION 'migration 0073: the CHECK probe "%" was refused by % — expected %.', probe, refused_by, expected;
		END IF;
	END LOOP;
	-- Nothing a probe wrote survived (each refused insert rolled back).
	IF EXISTS (SELECT 1 FROM "return_receipt_lines" WHERE "tenant_id" = t)
		OR EXISTS (SELECT 1 FROM "return_authorizations" WHERE "tenant_id" = t)
		OR EXISTS (SELECT 1 FROM "return_authorization_lines" WHERE "tenant_id" = t)
		OR EXISTS (SELECT 1 FROM "handling_units" WHERE "tenant_id" = t) THEN
		RAISE EXCEPTION 'migration 0073: a CHECK probe row survived.';
	END IF;
END $$;
