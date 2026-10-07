-- ── hand-amended (the 0060/0061 pattern): story 21-5, client invoices ──
-- Monthly SERVICES (SAC) GST tax invoices to a client brand, frozen at issue.
-- NO foreign keys (house rule — uuid columns validated in the command
-- transaction). What lands here:
--   clients (+7 nullable columns) — the recipient's tax details: legal_name,
--                         gstin, billing_line1/line2/city, billing_state_code,
--                         billing_pincode. Never required; shape-checked
--                         when present; a GSTIN must match the billing state.
--   client_invoices      — one per (client, IST month, supplying GSTIN):
--                         draft (recomputable) → issued (numbered, frozen) →
--                         disputed | settled | void. Totals pinned by the
--                         0054-style CHECKs (subtotal + tax = total, cgst +
--                         sgst + igst = tax, payable = total + round_off,
--                         payable a whole rupee, round_off in −49…+50).
--   client_invoice_lines — one per metered (segment, charge, uom), quantity
--                         > 0, priced (nullable on a draft only), taxed per
--                         line with its own place of supply.
--   client_invoice_series — the services series per (tenant, supplying
--                         GSTIN, FY): gap-free, never interleaved with the
--                         goods invoice_series.
--
-- drizzle-kit is blind to CHECKs, triggers and RLS — all hand-written below.
-- The journal entry and snapshot are git-added with this file, and
-- `bun run db:generate` afterwards reports "No schema changes".
--
-- No data: purely additive (the 3PL design's "migration B" shape — every
-- new clients column is nullable, nothing is backfilled). Proven by the 0062
-- block in `test/client-invoices.spec.ts` (applied to a database built from
-- the repo's own journal trimmed to 0061, inside one transaction; every
-- CHECK, every trigger arm by direct SQL, the vocabulary pins, the policies).

-- ── 0. the fail-fast guard ────────────────────────────────────────────────
DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'client_invoices') <> 0 THEN
		RAISE EXCEPTION 'migration 0062 has already been applied: client_invoices already exists.';
	END IF;
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'storage_snapshots') = 0 THEN
		RAISE EXCEPTION 'migration 0062 is out of order: storage_snapshots does not exist — 0061 must be applied first.';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "client_invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"rate_card_id" uuid,
	"segment_from" timestamp with time zone NOT NULL,
	"segment_to" timestamp with time zone NOT NULL,
	"charge_code" text NOT NULL,
	"basis" text NOT NULL,
	"uom" text,
	"quantity" bigint NOT NULL,
	"unit_amount_paise" bigint,
	"amount_paise" bigint,
	"sac_code" text NOT NULL,
	"gst_bps" integer NOT NULL,
	"place_of_supply" text,
	"supply_type" text,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_invoice_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_gstin" text NOT NULL,
	"fy_label" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"supplier_gstin" text,
	"place_of_supply" text,
	"supply_type" text,
	"invoice_no" text,
	"fy_label" text,
	"series_seq" integer,
	"subtotal_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"round_off_paise" bigint NOT NULL,
	"payable_paise" bigint NOT NULL,
	"gaps" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"party" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"replaces_invoice_id" uuid,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"status_note" text,
	"status_changed_at" timestamp with time zone,
	"status_changed_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "gstin" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "billing_line1" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "billing_line2" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "billing_city" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "billing_state_code" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "billing_pincode" text;--> statement-breakpoint
CREATE INDEX "client_invoice_lines_tenant_invoice_idx" ON "client_invoice_lines" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_invoice_lines_invoice_segment_charge_uom_unique" ON "client_invoice_lines" USING btree ("invoice_id","segment_from","charge_code",coalesce("uom", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "client_invoice_series_tenant_gstin_fy_unique" ON "client_invoice_series" USING btree ("tenant_id","supplier_gstin","fy_label");--> statement-breakpoint
CREATE UNIQUE INDEX "client_invoices_one_live_per_group" ON "client_invoices" USING btree ("tenant_id","client_id","period_start",coalesce("supplier_gstin", '')) WHERE status <> 'void';--> statement-breakpoint
CREATE UNIQUE INDEX "client_invoices_tenant_gstin_invoice_no_unique" ON "client_invoices" USING btree ("tenant_id","supplier_gstin","invoice_no") WHERE invoice_no is not null;--> statement-breakpoint
CREATE INDEX "client_invoices_tenant_created_at_id_idx" ON "client_invoices" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "client_invoices_tenant_client_period_idx" ON "client_invoices" USING btree ("tenant_id","client_id","period_start");--> statement-breakpoint
-- ── hand-amended: the clients tax-detail CHECKs (migration SQL only) ──
-- Mirrored by `ClientsCommand.updateTaxDetails` (which answers a named 400
-- first) and `src/shared/primitives/address.ts`'s length ceilings.
ALTER TABLE "clients" ADD CONSTRAINT "clients_legal_name_format" CHECK (
	"legal_name" IS NULL OR (char_length("legal_name") BETWEEN 1 AND 200 AND "legal_name" = btrim("legal_name"))
);--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_gstin_format" CHECK (
	"gstin" IS NULL OR "gstin" ~ '^[0-9]{2}[A-Z0-9]{13}$'
);--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_billing_address_format" CHECK (
	("billing_line1" IS NULL OR char_length("billing_line1") BETWEEN 1 AND 200)
	AND ("billing_line2" IS NULL OR char_length("billing_line2") BETWEEN 1 AND 200)
	AND ("billing_city" IS NULL OR char_length("billing_city") BETWEEN 1 AND 100)
	AND ("billing_state_code" IS NULL OR "billing_state_code" ~ '^[0-9]{2}$')
	AND ("billing_pincode" IS NULL OR "billing_pincode" ~ '^[0-9]{6}$')
);--> statement-breakpoint
-- A registered client's GSTIN names its state: it must agree with the
-- billing state when both are present (the place of supply reads either).
ALTER TABLE "clients" ADD CONSTRAINT "clients_gstin_matches_billing_state" CHECK (
	"gstin" IS NULL OR "billing_state_code" IS NULL OR left("gstin", 2) = "billing_state_code"
);--> statement-breakpoint
-- ── hand-amended: the client-invoice CHECKs ──
-- The vocabularies mirror `src/modules/billing/client-invoices.ts`
-- (CLIENT_INVOICE_STATUSES, SUPPLY_TYPES) and `rate-cards.ts` (CHARGE_CODES,
-- RATE_BASES, CHARGE_BASIS), pinned by `test/client-invoices.spec.ts`.
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_status_check" CHECK (
	"status" IN ('draft', 'issued', 'disputed', 'settled', 'void')
);--> statement-breakpoint
-- One IST calendar month: the 1st to its last day.
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_period_month" CHECK (
	extract(day from "period_start") = 1
	AND "period_end" = ("period_start" + interval '1 month' - interval '1 day')::date
);--> statement-breakpoint
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_tax_shape" CHECK (
	("supply_type" IS NULL OR "supply_type" IN ('intra', 'inter'))
	AND ("place_of_supply" IS NULL OR "place_of_supply" ~ '^[0-9]{2}$')
	AND ("supplier_gstin" IS NULL OR "supplier_gstin" ~ '^[0-9]{2}[A-Z0-9]{13}$')
);--> statement-breakpoint
-- The totals (the 0054 precedent): exact sums, a whole-rupee payable, the
-- signed round-off in −49…+50.
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_totals" CHECK (
	"subtotal_paise" >= 0 AND "cgst_paise" >= 0 AND "sgst_paise" >= 0 AND "igst_paise" >= 0
	AND "subtotal_paise" + "tax_paise" = "total_paise"
	AND "cgst_paise" + "sgst_paise" + "igst_paise" = "tax_paise"
	AND "payable_paise" = "total_paise" + "round_off_paise"
	AND "round_off_paise" BETWEEN -49 AND 50
	AND "payable_paise" % 100 = 0
	AND "payable_paise" >= 0
);--> statement-breakpoint
-- A non-draft row requires its number: draft ⇔ no number ⇔ never issued;
-- a number carries its FY, sequence, stamps and supplying GSTIN.
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_numbered" CHECK (
	("status" = 'draft') = ("invoice_no" IS NULL)
	AND ("invoice_no" IS NULL) = ("fy_label" IS NULL)
	AND ("invoice_no" IS NULL) = ("series_seq" IS NULL)
	AND ("invoice_no" IS NULL) = ("issued_at" IS NULL)
	AND ("issued_at" IS NULL) = ("issued_by" IS NULL)
	AND ("invoice_no" IS NULL OR "supplier_gstin" IS NOT NULL)
);--> statement-breakpoint
-- An issued document carries no gap (the command refuses issue on any gap;
-- this is the backstop). gaps / warnings are always arrays.
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_gaps_shape" CHECK (
	jsonb_typeof("gaps") = 'array' AND jsonb_typeof("warnings") = 'array'
	AND ("status" = 'draft' OR jsonb_array_length("gaps") = 0)
);--> statement-breakpoint
-- Dispute and void carry a note; the status stamps are set exactly once the
-- invoice has left draft/issued.
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_status_note" CHECK (
	("status" NOT IN ('disputed', 'void') OR "status_note" IS NOT NULL)
	AND ("status_note" IS NULL OR char_length(btrim("status_note")) BETWEEN 1 AND 500)
	AND ("status_changed_at" IS NULL) = ("status_changed_by" IS NULL)
	AND ("status" IN ('draft', 'issued')) = ("status_changed_at" IS NULL)
);--> statement-breakpoint
ALTER TABLE "client_invoice_lines" ADD CONSTRAINT "client_invoice_lines_charge_code_check" CHECK (
	"charge_code" IN ('storage', 'inbound_handling', 'pick', 'outbound_handling')
);--> statement-breakpoint
ALTER TABLE "client_invoice_lines" ADD CONSTRAINT "client_invoice_lines_basis_check" CHECK (
	"basis" IN ('per_thousand_units_per_day', 'per_receipt_line', 'per_pick', 'per_order')
);--> statement-breakpoint
ALTER TABLE "client_invoice_lines" ADD CONSTRAINT "client_invoice_lines_charge_basis_pair" CHECK (
	("charge_code" = 'storage' AND "basis" = 'per_thousand_units_per_day')
	OR ("charge_code" = 'inbound_handling' AND "basis" = 'per_receipt_line')
	OR ("charge_code" = 'pick' AND "basis" = 'per_pick')
	OR ("charge_code" = 'outbound_handling' AND "basis" = 'per_order')
);--> statement-breakpoint
-- One quantity column, two units: a storage line (and only a storage line)
-- names its base UoM, and its quantity is milli-unit-days; every other line
-- is a count with no uom.
ALTER TABLE "client_invoice_lines" ADD CONSTRAINT "client_invoice_lines_uom_basis_pair" CHECK (
	("basis" = 'per_thousand_units_per_day') = ("uom" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "client_invoice_lines" ADD CONSTRAINT "client_invoice_lines_quantity_positive" CHECK (
	"quantity" > 0
);--> statement-breakpoint
-- The segment is a rate-card stretch: IST-midnight bounds, non-empty.
ALTER TABLE "client_invoice_lines" ADD CONSTRAINT "client_invoice_lines_segment" CHECK (
	"segment_to" > "segment_from"
	AND mod(extract(epoch from "segment_from") + 19800, 86400) = 0
	AND mod(extract(epoch from "segment_to") + 19800, 86400) = 0
);--> statement-breakpoint
-- Priced together, and only by a card: an unpriced (draft) line has neither.
ALTER TABLE "client_invoice_lines" ADD CONSTRAINT "client_invoice_lines_priced" CHECK (
	("unit_amount_paise" IS NULL) = ("amount_paise" IS NULL)
	AND ("rate_card_id" IS NOT NULL OR "unit_amount_paise" IS NULL)
	AND ("unit_amount_paise" IS NULL OR "unit_amount_paise" BETWEEN 0 AND 10000000)
	AND ("amount_paise" IS NULL OR "amount_paise" >= 0)
);--> statement-breakpoint
-- SAC (services, not HSN) and the rate: frozen onto each line (decision 4).
-- The split follows the supply type: intra = CGST + SGST, inter = IGST,
-- unresolved = no tax.
ALTER TABLE "client_invoice_lines" ADD CONSTRAINT "client_invoice_lines_tax" CHECK (
	"sac_code" ~ '^[0-9]{6}$'
	AND "gst_bps" BETWEEN 0 AND 10000
	AND ("place_of_supply" IS NULL OR "place_of_supply" ~ '^[0-9]{2}$')
	AND "cgst_paise" >= 0 AND "sgst_paise" >= 0 AND "igst_paise" >= 0
	AND (
		("supply_type" = 'intra' AND "igst_paise" = 0)
		OR ("supply_type" = 'inter' AND "cgst_paise" = 0 AND "sgst_paise" = 0)
		OR ("supply_type" IS NULL AND "cgst_paise" = 0 AND "sgst_paise" = 0 AND "igst_paise" = 0)
	)
);--> statement-breakpoint
ALTER TABLE "client_invoice_series" ADD CONSTRAINT "client_invoice_series_shape" CHECK (
	"last_seq" >= 0
	AND "supplier_gstin" ~ '^[0-9]{2}[A-Z0-9]{13}$'
	AND "fy_label" ~ '^FY-[0-9]{4}$'
);--> statement-breakpoint
-- ── hand-amended: frozen at issue (the triggers — the 0060 precedent) ──
-- A draft may stay a draft (refresh) or become issued; it is deleted only
-- once its lines are gone (discard). Issue requires the number, the
-- supplying GSTIN and the stamp, refuses while ANY line is unpriced or has
-- no place of supply, and requires at least one line, header subtotal / CGST
-- / SGST / IGST equal to the lines' sums, and a non-empty party. A non-draft row never returns to draft, is never
-- deleted, and changes only by an allowed transition — issued → disputed |
-- settled | void, disputed → settled | void — with its status columns:
-- every other column is frozen (compared as jsonb, so a later column is
-- frozen too). Dispute and void need a note. The identity columns (id,
-- tenant, client, period, supplying GSTIN, replaces, creator) never change.
-- TIME is not checked here — the command's clock owns "the month has ended".
CREATE FUNCTION "client_invoices_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	frozen text[] := ARRAY['status', 'status_note', 'status_changed_at', 'status_changed_by', 'updated_at'];
	line_count bigint;
	sum_amount bigint;
	sum_cgst bigint;
	sum_sgst bigint;
	sum_igst bigint;
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."status" <> 'draft' THEN
			RAISE EXCEPTION 'client_invoices: a % invoice is never deleted (invoice %)', OLD."status", OLD."id";
		END IF;
		IF EXISTS (SELECT 1 FROM "client_invoice_lines" WHERE "invoice_id" = OLD."id") THEN
			RAISE EXCEPTION 'client_invoices: draft % still has lines — delete its lines first', OLD."id";
		END IF;
		RETURN OLD;
	END IF;
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
		OR NEW."client_id" IS DISTINCT FROM OLD."client_id"
		OR NEW."period_start" IS DISTINCT FROM OLD."period_start"
		OR NEW."period_end" IS DISTINCT FROM OLD."period_end"
		OR NEW."supplier_gstin" IS DISTINCT FROM OLD."supplier_gstin"
		OR NEW."replaces_invoice_id" IS DISTINCT FROM OLD."replaces_invoice_id"
		OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
		RAISE EXCEPTION 'client_invoices: the identity of invoice % never changes', OLD."id";
	END IF;
	IF OLD."status" = 'draft' THEN
		IF NEW."status" = 'draft' THEN
			RETURN NEW;
		END IF;
		IF NEW."status" <> 'issued' THEN
			RAISE EXCEPTION 'client_invoices: a draft is issued or discarded — draft → % refused (invoice %)', NEW."status", OLD."id";
		END IF;
		IF NEW."invoice_no" IS NULL OR NEW."supplier_gstin" IS NULL OR NEW."issued_at" IS NULL THEN
			RAISE EXCEPTION 'client_invoices: invoice % cannot issue without its number, supplying GSTIN and issue stamp', OLD."id";
		END IF;
		IF EXISTS (
			SELECT 1 FROM "client_invoice_lines" l
			WHERE l."invoice_id" = OLD."id"
				AND (l."rate_card_id" IS NULL OR l."unit_amount_paise" IS NULL OR l."amount_paise" IS NULL
					OR l."place_of_supply" IS NULL OR l."supply_type" IS NULL)
		) THEN
			RAISE EXCEPTION 'client_invoices: invoice % has an unpriced line (or one with no place of supply) — it cannot issue', OLD."id";
		END IF;
		-- An issued document has lines, and its header is THEIR sums — a
		-- header written without its lines (or out of step with them) never
		-- becomes a tax invoice. And it prints a real party.
		SELECT count(*), coalesce(sum(l."amount_paise"), 0), coalesce(sum(l."cgst_paise"), 0),
				coalesce(sum(l."sgst_paise"), 0), coalesce(sum(l."igst_paise"), 0)
			INTO line_count, sum_amount, sum_cgst, sum_sgst, sum_igst
			FROM "client_invoice_lines" l WHERE l."invoice_id" = OLD."id";
		IF line_count = 0 THEN
			RAISE EXCEPTION 'client_invoices: invoice % has no line — it cannot issue', OLD."id";
		END IF;
		IF NEW."subtotal_paise" <> sum_amount OR NEW."cgst_paise" <> sum_cgst
			OR NEW."sgst_paise" <> sum_sgst OR NEW."igst_paise" <> sum_igst THEN
			RAISE EXCEPTION 'client_invoices: invoice % header totals are not the sums of its lines — it cannot issue', OLD."id";
		END IF;
		IF NEW."party" = '{}'::jsonb THEN
			RAISE EXCEPTION 'client_invoices: invoice % has no party to print — it cannot issue', OLD."id";
		END IF;
		RETURN NEW;
	END IF;
	-- Non-draft.
	IF NOT (
		(OLD."status" = 'issued' AND NEW."status" IN ('disputed', 'settled', 'void'))
		OR (OLD."status" = 'disputed' AND NEW."status" IN ('settled', 'void'))
	) THEN
		RAISE EXCEPTION 'client_invoices: invoice % is frozen — % → % is not a transition', OLD."id", OLD."status", NEW."status";
	END IF;
	IF NEW."status" IN ('disputed', 'void') AND NEW."status_note" IS NULL THEN
		RAISE EXCEPTION 'client_invoices: % needs a note (invoice %)', NEW."status", OLD."id";
	END IF;
	IF NEW."status_changed_at" IS NULL OR NEW."status_changed_at" IS NOT DISTINCT FROM OLD."status_changed_at" THEN
		RAISE EXCEPTION 'client_invoices: a transition stamps status_changed_at (invoice %)', OLD."id";
	END IF;
	IF (to_jsonb(NEW) - frozen) IS DISTINCT FROM (to_jsonb(OLD) - frozen) THEN
		RAISE EXCEPTION 'client_invoices: invoice % is frozen after issue — only its status, note and stamps change', OLD."id";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "client_invoices_frozen" BEFORE UPDATE OR DELETE ON "client_invoices"
	FOR EACH ROW EXECUTE FUNCTION "client_invoices_guard"();--> statement-breakpoint
-- Lines change only while their invoice is a draft — checked on BOTH the old
-- and the new parent, read FOR SHARE so a concurrent issue serialises
-- against the line write; a NEW line carries its invoice's tenant. A
-- missing parent (or one the session cannot see) reads as not-a-draft —
-- fail closed (IMPLEMENTATION-GUIDE §7c).
CREATE FUNCTION "client_invoice_lines_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	parent_status text;
	parent_tenant uuid;
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		SELECT "status" INTO parent_status FROM "client_invoices" WHERE "id" = OLD."invoice_id" FOR SHARE;
		IF parent_status IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'client_invoice_lines: invoice % is not a draft (%) — its lines are frozen', OLD."invoice_id", coalesce(parent_status, 'missing');
		END IF;
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		SELECT "status", "tenant_id" INTO parent_status, parent_tenant
			FROM "client_invoices" WHERE "id" = NEW."invoice_id" FOR SHARE;
		IF parent_status IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'client_invoice_lines: invoice % is not a draft (%) — its lines are frozen', NEW."invoice_id", coalesce(parent_status, 'missing');
		END IF;
		IF NEW."tenant_id" IS DISTINCT FROM parent_tenant THEN
			RAISE EXCEPTION 'client_invoice_lines: a line carries its invoice''s tenant (invoice %)', NEW."invoice_id";
		END IF;
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "client_invoice_lines_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "client_invoice_lines"
	FOR EACH ROW EXECUTE FUNCTION "client_invoice_lines_guard"();--> statement-breakpoint
-- TRUNCATE sidesteps row triggers — refused outright on both tables (the
-- ledger 0006 / rate cards 0060 precedent). Test teardown uses
-- session_replication_role = replica and DELETE, never TRUNCATE.
CREATE FUNCTION "client_invoices_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is never truncated: an issued client invoice is frozen', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "client_invoices_no_truncate" BEFORE TRUNCATE ON "client_invoices"
	FOR EACH STATEMENT EXECUTE FUNCTION "client_invoices_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "client_invoice_lines_no_truncate" BEFORE TRUNCATE ON "client_invoice_lines"
	FOR EACH STATEMENT EXECUTE FUNCTION "client_invoices_refuse_truncate"();--> statement-breakpoint
-- ── hand-amended: RLS ──
-- client_invoices: the tenant policy plus the AD-24 client clause WITH
-- `status <> 'draft'` — a portal session (21-7) sees its own client's
-- invoices once issued, NEVER a draft. Writes are OPERATOR-ONLY (the 0060
-- shape: split per command, `app.client_id` must be unset).
-- client_invoice_lines: no client column — a line INHERITS its invoice's
-- visibility (the EXISTS runs under client_invoices' own policy).
-- client_invoice_series: tenant-scoped and operator-only (a number is never
-- a portal concern).
ALTER TABLE "client_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_invoice_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "client_invoices_tenant_isolation" ON "client_invoices" FOR SELECT
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR ("client_id" = NULLIF(current_setting('app.client_id', true), '')::uuid AND "status" <> 'draft')
		)
	);--> statement-breakpoint
CREATE POLICY "client_invoices_operator_insert" ON "client_invoices" FOR INSERT
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "client_invoices_operator_update" ON "client_invoices" FOR UPDATE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "client_invoices_operator_delete" ON "client_invoices" FOR DELETE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "client_invoice_lines_tenant_isolation" ON "client_invoice_lines" FOR SELECT
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR EXISTS (
				SELECT 1 FROM "client_invoices" i
				WHERE i."tenant_id" = "client_invoice_lines"."tenant_id" AND i."id" = "client_invoice_lines"."invoice_id"
			)
		)
	);--> statement-breakpoint
CREATE POLICY "client_invoice_lines_operator_insert" ON "client_invoice_lines" FOR INSERT
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "client_invoice_lines_operator_update" ON "client_invoice_lines" FOR UPDATE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "client_invoice_lines_operator_delete" ON "client_invoice_lines" FOR DELETE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "client_invoice_series_tenant_isolation" ON "client_invoice_series"
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
-- ── the post-migration assertion ──────────────────────────────────────────
-- Everything above is DDL; this proves it all landed in this transaction:
-- the seven clients columns, RLS on the three tables, the nine policies, the
-- four triggers, the one-live-invoice index and the one-line-per-(segment,
-- charge, uom) index.
DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'clients'
			AND column_name IN ('legal_name', 'gstin', 'billing_line1', 'billing_line2', 'billing_city', 'billing_state_code', 'billing_pincode')) <> 7 THEN
		RAISE EXCEPTION 'migration 0062: the clients tax-detail columns did not all land.';
	END IF;
	IF (SELECT count(*) FROM pg_class
		WHERE relname IN ('client_invoices', 'client_invoice_lines', 'client_invoice_series') AND relrowsecurity) <> 3 THEN
		RAISE EXCEPTION 'migration 0062: RLS is not enabled on all three client-invoice tables.';
	END IF;
	IF (SELECT count(*) FROM pg_policies
		WHERE schemaname = current_schema() AND tablename IN ('client_invoices', 'client_invoice_lines', 'client_invoice_series')) <> 9 THEN
		RAISE EXCEPTION 'migration 0062: expected nine client-invoice policies.';
	END IF;
	IF (SELECT count(*) FROM pg_trigger
		WHERE NOT tgisinternal AND tgname IN ('client_invoices_frozen', 'client_invoice_lines_frozen', 'client_invoices_no_truncate', 'client_invoice_lines_no_truncate')) <> 4 THEN
		RAISE EXCEPTION 'migration 0062: expected the four client-invoice triggers.';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'client_invoices_one_live_per_group') THEN
		RAISE EXCEPTION 'migration 0062: the one-live-invoice index is missing.';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'client_invoice_lines_invoice_segment_charge_uom_unique') THEN
		RAISE EXCEPTION 'migration 0062: the one-line-per-(segment, charge, uom) index is missing.';
	END IF;
END $$;
