-- ── hand-amended (the 0064/0071 pattern): story 13-1, return authorizations ──
-- Two new tables, written ONLY by the returns module (pinned by
-- test/architecture.spec.ts): `return_authorizations` (the RMA header — an
-- operator authorizes part of a DISPATCHED order for return) and
-- `return_authorization_lines` (one order line each: the authorized quantity,
-- a reason from the fixed list, and — for a serial-tracked SKU — the catalog
-- serial ids, the ledger's `serial_ref` form).
--
-- drizzle-kit generated the table and index DDL below; the CHECKs, the RLS
-- policies and the post-migration probe are hand-written (drizzle-kit is
-- blind to them). The journal entry and snapshot are git-added with this
-- file; `bun run db:generate` afterwards reports "No schema changes".
--
-- Additive only: two new tables, no data statement — no pre-flight, no
-- fail-fast guard (the 0071 precedent). No foreign keys (IMPLEMENTATION-GUIDE
-- §3). No ledger event and no stock table is touched: an authorization moves
-- nothing.
CREATE TABLE "return_authorization_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rma_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"order_line_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"authorized_qty" bigint NOT NULL,
	"received_qty" bigint DEFAULT 0 NOT NULL,
	"reason_code" text NOT NULL,
	"reason_note" text,
	"serial_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "return_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_reference" text,
	"code" text NOT NULL,
	"external_reference" text,
	"status" text DEFAULT 'open' NOT NULL,
	"order_dispatched_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "return_authorization_lines_rma_line_no_unique" ON "return_authorization_lines" USING btree ("rma_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "return_authorization_lines_rma_order_line_unique" ON "return_authorization_lines" USING btree ("rma_id","order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_authorizations_tenant_code_unique" ON "return_authorizations" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "return_authorizations_tenant_created_at_id_idx" ON "return_authorizations" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "return_authorizations_tenant_order_idx" ON "return_authorizations" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "return_authorizations_tenant_warehouse_created_at_id_idx" ON "return_authorizations" USING btree ("tenant_id","warehouse_id","created_at","id");--> statement-breakpoint
-- ── hand-amended: the RMA CHECKs ──────────────────────────────────────────
-- The status vocabulary mirrors `RMA_STATUSES` (return-authorization.command.ts)
-- — pinned against this constraint by test/returns.spec.ts. 13-1 holds only
-- `open | cancelled`; 13-2 and 13-3 widen it (DROP then re-ADD, §3) — no state
-- is reserved before it is designed.
ALTER TABLE "return_authorizations" ADD CONSTRAINT "return_authorizations_status_check"
	CHECK ("status" IN ('open','cancelled'));--> statement-breakpoint
-- Written as an equivalence on `cancelled` (never an enumeration of the other
-- statuses), so it never overlaps the status CHECK: an unknown status with no
-- cancel columns is refused by the status CHECK ALONE, which is what lets the
-- probe below test each constraint separately — and a status 13-2 adds needs
-- no change here.
ALTER TABLE "return_authorizations" ADD CONSTRAINT "return_authorizations_cancel_shape"
	CHECK (
		("status" = 'cancelled' AND "cancelled_by" IS NOT NULL AND "cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL)
		OR ("status" <> 'cancelled' AND "cancelled_by" IS NULL AND "cancelled_at" IS NULL AND "cancel_reason" IS NULL)
	);--> statement-breakpoint
-- Trimmed text, 1–500 / 1–64 code points (the command trims; blank = absent).
ALTER TABLE "return_authorizations" ADD CONSTRAINT "return_authorizations_cancel_reason_length"
	CHECK ("cancel_reason" IS NULL OR (char_length("cancel_reason") BETWEEN 1 AND 500 AND "cancel_reason" = btrim("cancel_reason")));--> statement-breakpoint
ALTER TABLE "return_authorizations" ADD CONSTRAINT "return_authorizations_external_reference_length"
	CHECK ("external_reference" IS NULL OR (char_length("external_reference") BETWEEN 1 AND 64 AND "external_reference" = btrim("external_reference")));--> statement-breakpoint
ALTER TABLE "return_authorization_lines" ADD CONSTRAINT "return_authorization_lines_authorized_qty_positive"
	CHECK ("authorized_qty" > 0);--> statement-breakpoint
-- `line_no` is the request order, 1..n (unique per RMA) — the read order,
-- never inferred from uuidv7 ids.
ALTER TABLE "return_authorization_lines" ADD CONSTRAINT "return_authorization_lines_line_no_positive"
	CHECK ("line_no" >= 1);--> statement-breakpoint
ALTER TABLE "return_authorization_lines" ADD CONSTRAINT "return_authorization_lines_received_qty_nonnegative"
	CHECK ("received_qty" >= 0);--> statement-breakpoint
-- The reason vocabulary mirrors `RETURN_REASON_CODES` (pinned by
-- test/returns.spec.ts). The column is NOT NULL, so `IN (…)` cannot pass a
-- NULL through (§3's nullable-CHECK trap does not arise).
ALTER TABLE "return_authorization_lines" ADD CONSTRAINT "return_authorization_lines_reason_code_check"
	CHECK ("reason_code" IN ('damaged','defective','wrong-item','not-as-described','changed-mind','other'));--> statement-breakpoint
ALTER TABLE "return_authorization_lines" ADD CONSTRAINT "return_authorization_lines_reason_note_length"
	CHECK ("reason_note" IS NULL OR (char_length("reason_note") BETWEEN 1 AND 500 AND "reason_note" = btrim("reason_note")));--> statement-breakpoint
ALTER TABLE "return_authorization_lines" ADD CONSTRAINT "return_authorization_lines_other_needs_note"
	CHECK ("reason_code" <> 'other' OR "reason_note" IS NOT NULL);--> statement-breakpoint
-- ── hand-amended: RLS — the client-scoped document pattern ────────────────
-- The header carries `client_id` and the null-tolerant client clause of
-- `advance_shipment_notices` (0064): an operator session sees the tenant, a
-- client-stamped (portal) session only its own client's RMAs. 13-1 opens no
-- portal route; the policy is defence in depth from the first row. The lines
-- carry no client column: their visibility rides the parent (the 0064
-- `asn_lines` EXISTS shape).
ALTER TABLE "return_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "return_authorization_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "return_authorizations_tenant_isolation" ON "return_authorizations"
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
CREATE POLICY "return_authorization_lines_tenant_isolation" ON "return_authorization_lines"
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR EXISTS (
				SELECT 1 FROM "return_authorizations" r
				WHERE r."tenant_id" = "return_authorization_lines"."tenant_id" AND r."id" = "return_authorization_lines"."rma_id"
			)
		)
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR EXISTS (
				SELECT 1 FROM "return_authorizations" r
				WHERE r."tenant_id" = "return_authorization_lines"."tenant_id" AND r."id" = "return_authorization_lines"."rma_id"
			)
		)
	);--> statement-breakpoint
-- ── the post-migration assertion: every new CHECK refuses what it must ────
-- Each probe runs in its own subtransaction and must be refused by
-- `check_violation` (23514) ON THE NAMED CONSTRAINT — a probe another CHECK
-- happens to refuse proves nothing about the one it is written for. An insert
-- that LANDS is a CHECK that does not hold, and aborts the migration. The
-- accepted shapes are inserted first and rolled back by a sentinel
-- exception, so a CHECK that refuses everything cannot pass either.
DO $$
DECLARE
	t uuid := gen_random_uuid();
	refused_by text;
	probe text;
	expected text;
BEGIN
	-- (1) the accepted shapes.
	BEGIN
		INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","order_reference","code","external_reference","status","order_dispatched_at","created_by","cancelled_by","cancelled_at","cancel_reason")
		VALUES (gen_random_uuid(), t, t, t, t, NULL, 'P-0072-1', NULL, 'open', now(), t, NULL, NULL, NULL),
		       (gen_random_uuid(), t, t, t, t, 'ext-1', 'P-0072-2', 'RMA-CH-9', 'cancelled', now(), t, t, now(), 'customer withdrew');
		INSERT INTO "return_authorization_lines" ("id","tenant_id","rma_id","line_no","order_line_id","sku_id","authorized_qty","received_qty","reason_code","reason_note","serial_ids")
		VALUES (gen_random_uuid(), t, t, 1, gen_random_uuid(), t, 1000, 0, 'damaged', NULL, '{}'),
		       (gen_random_uuid(), t, t, 2, gen_random_uuid(), t, 2000, 1000, 'other', 'box crushed', ARRAY[gen_random_uuid(), gen_random_uuid()]),
		       (gen_random_uuid(), t, t, 3, gen_random_uuid(), t, 1, 0, 'changed-mind', NULL, '{}');
		RAISE EXCEPTION USING ERRCODE = 'P0072', MESSAGE = 'rollback the accepted probes';
	EXCEPTION WHEN SQLSTATE 'P0072' THEN NULL;
	END;
	-- (2) the refused shapes, each naming the constraint that must refuse it.
	FOREACH probe IN ARRAY ARRAY[
		'rma: unknown status',
		'rma: cancelled without its columns',
		'rma: open with a cancel column',
		'rma: blank cancel reason',
		'rma: overlong cancel reason',
		'rma: untrimmed cancel reason',
		'rma: empty external reference',
		'rma: overlong external reference',
		'rma: untrimmed external reference',
		'line: zero line_no',
		'line: zero authorized',
		'line: negative received',
		'line: unknown reason',
		'line: overlong note',
		'line: empty note',
		'line: other without a note'
	] LOOP
		refused_by := NULL;
		expected := CASE probe
			WHEN 'rma: unknown status' THEN 'return_authorizations_status_check'
			WHEN 'rma: cancelled without its columns' THEN 'return_authorizations_cancel_shape'
			WHEN 'rma: open with a cancel column' THEN 'return_authorizations_cancel_shape'
			WHEN 'rma: blank cancel reason' THEN 'return_authorizations_cancel_reason_length'
			WHEN 'rma: overlong cancel reason' THEN 'return_authorizations_cancel_reason_length'
			WHEN 'rma: untrimmed cancel reason' THEN 'return_authorizations_cancel_reason_length'
			WHEN 'line: zero line_no' THEN 'return_authorization_lines_line_no_positive'
			WHEN 'line: zero authorized' THEN 'return_authorization_lines_authorized_qty_positive'
			WHEN 'line: negative received' THEN 'return_authorization_lines_received_qty_nonnegative'
			WHEN 'line: unknown reason' THEN 'return_authorization_lines_reason_code_check'
			WHEN 'line: overlong note' THEN 'return_authorization_lines_reason_note_length'
			WHEN 'line: empty note' THEN 'return_authorization_lines_reason_note_length'
			WHEN 'line: other without a note' THEN 'return_authorization_lines_other_needs_note'
			ELSE 'return_authorizations_external_reference_length'
		END;
		BEGIN
			CASE probe
				WHEN 'rma: unknown status' THEN
					-- No cancel columns, so only the status CHECK can refuse it.
					INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","code","status","order_dispatched_at","created_by")
					VALUES (gen_random_uuid(), t, t, t, t, 'P1', 'received', now(), t);
				WHEN 'rma: cancelled without its columns' THEN
					INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","code","status","order_dispatched_at","created_by","cancelled_by","cancelled_at")
					VALUES (gen_random_uuid(), t, t, t, t, 'P2', 'cancelled', now(), t, t, now());
				WHEN 'rma: open with a cancel column' THEN
					INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","code","status","order_dispatched_at","created_by","cancel_reason")
					VALUES (gen_random_uuid(), t, t, t, t, 'P3', 'open', now(), t, 'note');
				WHEN 'rma: blank cancel reason' THEN
					INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","code","status","order_dispatched_at","created_by","cancelled_by","cancelled_at","cancel_reason")
					VALUES (gen_random_uuid(), t, t, t, t, 'P4', 'cancelled', now(), t, t, now(), '');
				WHEN 'rma: overlong cancel reason' THEN
					INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","code","status","order_dispatched_at","created_by","cancelled_by","cancelled_at","cancel_reason")
					VALUES (gen_random_uuid(), t, t, t, t, 'P5', 'cancelled', now(), t, t, now(), repeat('x', 501));
				WHEN 'rma: untrimmed cancel reason' THEN
					INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","code","status","order_dispatched_at","created_by","cancelled_by","cancelled_at","cancel_reason")
					VALUES (gen_random_uuid(), t, t, t, t, 'P6', 'cancelled', now(), t, t, now(), ' padded ');
				WHEN 'rma: empty external reference' THEN
					INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","code","external_reference","order_dispatched_at","created_by")
					VALUES (gen_random_uuid(), t, t, t, t, 'P7', '', now(), t);
				WHEN 'rma: overlong external reference' THEN
					INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","code","external_reference","order_dispatched_at","created_by")
					VALUES (gen_random_uuid(), t, t, t, t, 'P8', repeat('x', 65), now(), t);
				WHEN 'rma: untrimmed external reference' THEN
					INSERT INTO "return_authorizations" ("id","tenant_id","client_id","warehouse_id","order_id","code","external_reference","order_dispatched_at","created_by")
					VALUES (gen_random_uuid(), t, t, t, t, 'P9', ' ref', now(), t);
				WHEN 'line: zero line_no' THEN
					INSERT INTO "return_authorization_lines" ("id","tenant_id","rma_id","line_no","order_line_id","sku_id","authorized_qty","reason_code")
					VALUES (gen_random_uuid(), t, t, 0, gen_random_uuid(), t, 1000, 'damaged');
				WHEN 'line: zero authorized' THEN
					INSERT INTO "return_authorization_lines" ("id","tenant_id","rma_id","line_no","order_line_id","sku_id","authorized_qty","reason_code")
					VALUES (gen_random_uuid(), t, t, 1, gen_random_uuid(), t, 0, 'damaged');
				WHEN 'line: negative received' THEN
					INSERT INTO "return_authorization_lines" ("id","tenant_id","rma_id","line_no","order_line_id","sku_id","authorized_qty","received_qty","reason_code")
					VALUES (gen_random_uuid(), t, t, 1, gen_random_uuid(), t, 1000, -1, 'damaged');
				WHEN 'line: unknown reason' THEN
					INSERT INTO "return_authorization_lines" ("id","tenant_id","rma_id","line_no","order_line_id","sku_id","authorized_qty","reason_code")
					VALUES (gen_random_uuid(), t, t, 1, gen_random_uuid(), t, 1000, 'lost');
				WHEN 'line: overlong note' THEN
					INSERT INTO "return_authorization_lines" ("id","tenant_id","rma_id","line_no","order_line_id","sku_id","authorized_qty","reason_code","reason_note")
					VALUES (gen_random_uuid(), t, t, 1, gen_random_uuid(), t, 1000, 'damaged', repeat('x', 501));
				WHEN 'line: empty note' THEN
					INSERT INTO "return_authorization_lines" ("id","tenant_id","rma_id","line_no","order_line_id","sku_id","authorized_qty","reason_code","reason_note")
					VALUES (gen_random_uuid(), t, t, 1, gen_random_uuid(), t, 1000, 'damaged', '');
				WHEN 'line: other without a note' THEN
					INSERT INTO "return_authorization_lines" ("id","tenant_id","rma_id","line_no","order_line_id","sku_id","authorized_qty","reason_code")
					VALUES (gen_random_uuid(), t, t, 1, gen_random_uuid(), t, 1000, 'other');
			END CASE;
		EXCEPTION WHEN check_violation THEN
			GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
		END;
		IF refused_by IS NULL THEN
			RAISE EXCEPTION 'migration 0072: the CHECK probe "%" was not refused.', probe;
		END IF;
		IF refused_by <> expected THEN
			RAISE EXCEPTION 'migration 0072: the CHECK probe "%" was refused by % — expected %.', probe, refused_by, expected;
		END IF;
	END LOOP;
	-- Nothing a probe wrote survived (each refused insert rolled back).
	IF EXISTS (SELECT 1 FROM "return_authorizations" WHERE "tenant_id" = t)
		OR EXISTS (SELECT 1 FROM "return_authorization_lines" WHERE "tenant_id" = t) THEN
		RAISE EXCEPTION 'migration 0072: a CHECK probe row survived.';
	END IF;
END $$;
