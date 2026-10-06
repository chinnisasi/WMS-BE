-- ── hand-amended (the 0053/0056 pattern): story 21-3, rate cards ──
-- The billing module's first two tables, NO foreign keys (house rule — uuid
-- columns validated in the command transaction):
--   rate_cards      — a client's versioned prices: drafted (no date),
--                     activated from an IST-midnight effective_from, frozen
--                     after activation; superseded by a later card from its
--                     date; a not-yet-effective card can be cancelled, which
--                     reopens its predecessor.
--   rate_card_lines — one priced charge per row, integer paise per unit of
--                     a closed basis, stamped with the card's client_id so
--                     the AD-24 client clause binds lines directly.
--
-- drizzle-kit is blind to CHECKs, RLS and triggers — all hand-written below.
-- The journal entry and snapshot are git-added with this file, and
-- `bun run db:generate` afterwards reports "No schema changes".
--
-- No data: purely additive (the 3PL design's "migration B" shape). Proven by
-- the 0060 block in `test/rate-cards.spec.ts` (every CHECK, every trigger
-- arm by direct SQL, the vocabulary pins, the policies).

-- ── 0. the fail-fast guard ────────────────────────────────────────────────
DO $$
BEGIN
	IF (SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'rate_cards') <> 0 THEN
		RAISE EXCEPTION 'migration 0060 has already been applied: rate_cards already exists.';
	END IF;
	IF (SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'catalog_imports' AND column_name = 'client_id') = 0 THEN
		RAISE EXCEPTION 'migration 0060 is out of order: catalog_imports.client_id does not exist — 0059 must be applied first.';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "rate_card_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"rate_card_id" uuid NOT NULL,
	"charge_code" text NOT NULL,
	"basis" text NOT NULL,
	"amount_paise" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" uuid,
	"activated_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rate_card_lines_card_charge_unique" ON "rate_card_lines" USING btree ("rate_card_id","charge_code");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_cards_one_open_per_client" ON "rate_cards" USING btree ("tenant_id","client_id") WHERE status = 'active' AND effective_to IS NULL;--> statement-breakpoint
CREATE INDEX "rate_cards_tenant_client_effective_from_idx" ON "rate_cards" USING btree ("tenant_id","client_id","effective_from");--> statement-breakpoint
-- ── hand-amended: the CHECKs (migration SQL only) ──
-- The vocabularies mirror `src/modules/billing/rate-cards.ts`
-- (RATE_CARD_STATUSES, CHARGE_CODES, RATE_BASES, CHARGE_BASIS) and are
-- pinned against it by `test/rate-cards.spec.ts`.
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_status_check" CHECK (
	"status" IN ('draft', 'active', 'superseded', 'cancelled')
);--> statement-breakpoint
-- Effective boundaries are IST midnights (UTC+05:30, no DST): the epoch plus
-- 19,800 s is a whole number of days. A fractional second fails too.
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_effective_from_ist_midnight" CHECK (
	"effective_from" IS NULL OR mod(extract(epoch from "effective_from") + 19800, 86400) = 0
);--> statement-breakpoint
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_effective_to_ist_midnight" CHECK (
	"effective_to" IS NULL OR mod(extract(epoch from "effective_to") + 19800, 86400) = 0
);--> statement-breakpoint
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_effective_order" CHECK (
	"effective_to" IS NULL OR ("effective_from" IS NOT NULL AND "effective_to" > "effective_from")
);--> statement-breakpoint
-- draft ⇔ no effective_from ⇔ never activated.
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_draft_undated" CHECK (
	("status" = 'draft') = ("effective_from" IS NULL)
	AND ("status" = 'draft') = ("activated_at" IS NULL)
	AND ("activated_at" IS NULL) = ("activated_by" IS NULL)
);--> statement-breakpoint
-- superseded ⇔ a successor's date closes it.
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_superseded_closed" CHECK (
	("status" = 'superseded') = ("effective_to" IS NOT NULL)
);--> statement-breakpoint
-- cancelled ⇔ the cancel stamps.
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_cancelled_stamped" CHECK (
	("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
	AND ("cancelled_at" IS NULL) = ("cancelled_by" IS NULL)
);--> statement-breakpoint
ALTER TABLE "rate_card_lines" ADD CONSTRAINT "rate_card_lines_charge_code_check" CHECK (
	"charge_code" IN ('storage', 'inbound_handling', 'pick', 'outbound_handling')
);--> statement-breakpoint
ALTER TABLE "rate_card_lines" ADD CONSTRAINT "rate_card_lines_basis_check" CHECK (
	"basis" IN ('per_thousand_units_per_day', 'per_receipt_line', 'per_pick', 'per_order')
);--> statement-breakpoint
-- Each charge is priced on exactly ONE basis (the pair map).
ALTER TABLE "rate_card_lines" ADD CONSTRAINT "rate_card_lines_charge_basis_pair" CHECK (
	("charge_code" = 'storage' AND "basis" = 'per_thousand_units_per_day')
	OR ("charge_code" = 'inbound_handling' AND "basis" = 'per_receipt_line')
	OR ("charge_code" = 'pick' AND "basis" = 'per_pick')
	OR ("charge_code" = 'outbound_handling' AND "basis" = 'per_order')
);--> statement-breakpoint
-- Integer paise per unit of basis, GST-exclusive, ₹0 .. ₹1 lakh.
ALTER TABLE "rate_card_lines" ADD CONSTRAINT "rate_card_lines_amount_range" CHECK (
	"amount_paise" BETWEEN 0 AND 10000000
);--> statement-breakpoint
-- ── hand-amended: frozen after activation (the triggers) ──
-- A card's ONLY changes after it leaves `draft` are the transitions:
--   supersede:          active → superseded, effective_to null → set
--   cancel:             active|superseded → cancelled, the cancel stamps
--                       null → set, effective_to → null (no window)
--   reopen-on-cancel:   the cancelled card's predecessor — superseded →
--                       active (effective_to → null) when the cancelled card
--                       was open, else superseded → superseded with
--                       effective_to moved LATER to the cancelled card's end
-- In every one of them each column except status, effective_to, the cancel
-- stamps and updated_at is IS NOT DISTINCT FROM its old value. A draft may
-- be edited (updated_at) or activated (status, effective_from, the activate
-- stamps — the CHECKs above hold the shape). The identity columns (id,
-- tenant_id, client_id, created_by, created_at) never change. Only a draft
-- is ever deleted. TIME is not checked here ("cancel only before its date"
-- is the command's rule, on the command's clock) — the trigger guards the
-- shape of a transition, not when it may happen.
CREATE FUNCTION "rate_cards_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."status" <> 'draft' THEN
			RAISE EXCEPTION 'rate_cards: a % card is never deleted (card %)', OLD."status", OLD."id";
		END IF;
		-- A draft is deleted only once its lines are gone (the command deletes
		-- lines first): a direct delete would leave orphan lines the line
		-- trigger then refuses to delete (their parent reads as missing).
		IF EXISTS (SELECT 1 FROM "rate_card_lines" WHERE "rate_card_id" = OLD."id") THEN
			RAISE EXCEPTION 'rate_cards: draft % still has lines — delete its lines first', OLD."id";
		END IF;
		RETURN OLD;
	END IF;
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
		OR NEW."client_id" IS DISTINCT FROM OLD."client_id"
		OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
		RAISE EXCEPTION 'rate_cards: the identity of card % never changes', OLD."id";
	END IF;
	IF OLD."status" = 'draft' THEN
		IF NEW."status" IN ('draft', 'active') THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'rate_cards: a draft becomes active or is deleted — draft → % refused (card %)', NEW."status", OLD."id";
	END IF;
	-- Non-draft: the frozen columns.
	IF NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
		OR NEW."activated_by" IS DISTINCT FROM OLD."activated_by"
		OR NEW."activated_at" IS DISTINCT FROM OLD."activated_at" THEN
		RAISE EXCEPTION 'rate_cards: card % is frozen after activation (effective_from and the activation stamps never change)', OLD."id";
	END IF;
	IF OLD."status" = 'active' AND NEW."status" = 'superseded'
		AND OLD."effective_to" IS NULL AND NEW."effective_to" IS NOT NULL
		AND NEW."cancelled_by" IS NOT DISTINCT FROM OLD."cancelled_by"
		AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at" THEN
		RETURN NEW;
	END IF;
	-- cancel: a dated card (active, or superseded by a later one) is
	-- withdrawn; a cancelled card has no window, so effective_to clears.
	IF OLD."status" IN ('active', 'superseded') AND NEW."status" = 'cancelled'
		AND NEW."effective_to" IS NULL
		AND OLD."cancelled_at" IS NULL AND NEW."cancelled_at" IS NOT NULL THEN
		RETURN NEW;
	END IF;
	-- the predecessor of a cancelled card: reopened (→ active, open-ended)…
	IF OLD."status" = 'superseded' AND NEW."status" = 'active'
		AND NEW."effective_to" IS NULL
		AND NEW."cancelled_by" IS NOT DISTINCT FROM OLD."cancelled_by"
		AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at" THEN
		RETURN NEW;
	END IF;
	-- …or extended to the cancelled card's own end (stays superseded; the
	-- IST-midnight CHECK holds the new boundary). Only ever LATER.
	IF OLD."status" = 'superseded' AND NEW."status" = 'superseded'
		AND NEW."effective_to" IS NOT NULL AND NEW."effective_to" > OLD."effective_to"
		AND NEW."cancelled_by" IS NOT DISTINCT FROM OLD."cancelled_by"
		AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at" THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'rate_cards: card % is frozen after activation — % → % is not a transition', OLD."id", OLD."status", NEW."status";
END;
$$;--> statement-breakpoint
CREATE TRIGGER "rate_cards_frozen" BEFORE UPDATE OR DELETE ON "rate_cards"
	FOR EACH ROW EXECUTE FUNCTION "rate_cards_guard"();--> statement-breakpoint
-- Lines change only while their card is a draft — checked on BOTH the old
-- and the new parent (an UPDATE re-pointing a line at another card is two
-- parents), under FOR SHARE so a concurrent activation of the parent
-- serialises against the line write. A NEW line must carry its card's
-- tenant and client.
CREATE FUNCTION "rate_card_lines_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	parent_status text;
	parent_tenant uuid;
	parent_client uuid;
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		SELECT "status" INTO parent_status FROM "rate_cards" WHERE "id" = OLD."rate_card_id" FOR SHARE;
		IF parent_status IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'rate_card_lines: card % is not a draft (%) — its lines are frozen', OLD."rate_card_id", coalesce(parent_status, 'missing');
		END IF;
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		SELECT "status", "tenant_id", "client_id" INTO parent_status, parent_tenant, parent_client
			FROM "rate_cards" WHERE "id" = NEW."rate_card_id" FOR SHARE;
		IF parent_status IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'rate_card_lines: card % is not a draft (%) — its lines are frozen', NEW."rate_card_id", coalesce(parent_status, 'missing');
		END IF;
		IF NEW."tenant_id" IS DISTINCT FROM parent_tenant OR NEW."client_id" IS DISTINCT FROM parent_client THEN
			RAISE EXCEPTION 'rate_card_lines: a line carries its card''s tenant and client (card %)', NEW."rate_card_id";
		END IF;
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "rate_card_lines_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "rate_card_lines"
	FOR EACH ROW EXECUTE FUNCTION "rate_card_lines_guard"();--> statement-breakpoint
-- TRUNCATE sidesteps row triggers — refused outright on both tables (the
-- ledger's 0006 precedent). Test teardown uses session_replication_role =
-- replica and DELETE, never TRUNCATE.
CREATE FUNCTION "rate_cards_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is never truncated: rate cards are frozen after activation', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "rate_cards_no_truncate" BEFORE TRUNCATE ON "rate_cards"
	FOR EACH STATEMENT EXECUTE FUNCTION "rate_cards_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "rate_card_lines_no_truncate" BEFORE TRUNCATE ON "rate_card_lines"
	FOR EACH STATEMENT EXECUTE FUNCTION "rate_cards_refuse_truncate"();--> statement-breakpoint
-- ── hand-amended: RLS — the AD-24 clause, READ-ONLY for a client session ──
-- Reads carry 0041's null-tolerant client clause (an operator sees the
-- tenant; a portal session sees only its own client's cards). Writes are
-- OPERATOR-ONLY: with `app.client_id` set, INSERT/UPDATE/DELETE bind
-- nothing — a client never edits its own price list. Split per command
-- because a FOR ALL policy's WITH CHECK does not cover DELETE.
ALTER TABLE "rate_cards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_card_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rate_cards_tenant_isolation" ON "rate_cards" FOR SELECT
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR "client_id" = NULLIF(current_setting('app.client_id', true), '')::uuid
		)
	);--> statement-breakpoint
CREATE POLICY "rate_cards_operator_insert" ON "rate_cards" FOR INSERT
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "rate_cards_operator_update" ON "rate_cards" FOR UPDATE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "rate_cards_operator_delete" ON "rate_cards" FOR DELETE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "rate_card_lines_tenant_isolation" ON "rate_card_lines" FOR SELECT
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR "client_id" = NULLIF(current_setting('app.client_id', true), '')::uuid
		)
	);--> statement-breakpoint
CREATE POLICY "rate_card_lines_operator_insert" ON "rate_card_lines" FOR INSERT
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "rate_card_lines_operator_update" ON "rate_card_lines" FOR UPDATE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);--> statement-breakpoint
CREATE POLICY "rate_card_lines_operator_delete" ON "rate_card_lines" FOR DELETE
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND NULLIF(current_setting('app.client_id', true), '') IS NULL
	);
