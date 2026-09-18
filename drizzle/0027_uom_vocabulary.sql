-- Story 10.2 — UoM becomes a CLOSED VOCABULARY with a declared precision.
--
-- `skus.uom` has been free `text` with no CHECK since 1.4, so `pcs`, `PCS`
-- and `pieces` could coexist as three different units of the same thing. This
-- migration closes it: every stored unit is normalized to one CANONICAL
-- spelling, and a hand-written CHECK — the repo's uniform enum-by-CHECK
-- pattern, ten precedents deep (`orders_status_check`,
-- `reservations_state_check`, `devices_status_check`,
-- `picklist_lines_reason_code_check`, …) — makes an unknown unit impossible to
-- store.
--
-- This is also the migration story 10.1 could not write. 10.1 recorded a
-- deviation from this repo's own "the command layer rejects first, CHECKs are
-- the backstop" convention: with no vocabulary there was no set to check
-- against. There is one now, and here it is.
--
-- WHY A CHECK AND NOT A `pgEnum`. This schema does have a Postgres enum —
-- `user_role` (`schema.ts:57`) — so the honest reason is not "we don't use
-- them". It is that a vocabulary expected to GROW is the wrong thing to put in
-- a type: extending an enum means `ALTER TYPE … ADD VALUE`, with its own
-- transaction rules, no removal and no reordering, while a CHECK is dropped
-- and re-added with the widened set — which is exactly what 0019, 0022, 0023
-- and 0024 already do for the other vocabularies. The four coarse roles are a
-- closed set by design; units are not. (And no lookup table: a row with no
-- columns but its own name, an FK, and a join on every read, to express a
-- constant that lives in one `as const` tuple.)
--
-- ADDING A UNIT LATER is a migration that DROPs and re-ADDs the constraint
-- with the widened set — the 0023/0024 `orders_status_check` precedent — plus
-- the matching line in the TS tuple and its declared precision.
--
-- WHAT IS DELIBERATELY NOT HERE. No imperial units (`lb`, `oz`, `gallon`,
-- `ft`, `inch`): they are only useful to a tenant who also CONVERTS between
-- them, and conversions do not exist yet. `uom_conversions.factor` stays an
-- `integer` for the same reason — nothing in the codebase multiplies by it, so
-- a fractional factor would have no consumer. Both arrive together in a later
-- story rather than as two half-features now.

-- ── 0. the vocabulary, declared ONCE for this migration ───────────────────
-- Everything below reads the set from here: the pre-flight refusal, the alias
-- rewrite, the dedup, and the thirteen whole-unit alignment statements. A
-- 0-dp unit added to the TS tuple and to `uom_canonical` therefore cannot
-- silently miss the rounding — there is no second list to forget. (The CHECK
-- constraints at the end must still spell the set out: a CHECK cannot read a
-- table. The vocabulary e2e suite pins all three against the TS tuple.)
CREATE TEMP TABLE uom_canonical (uom text PRIMARY KEY, places int NOT NULL);--> statement-breakpoint
INSERT INTO uom_canonical (uom, places) VALUES
	('each',0), ('box',0), ('case',0), ('carton',0), ('pack',0),
	('pallet',0), ('bag',0), ('drum',0), ('roll',0), ('crate',0),
	('bundle',0), ('pair',0), ('dozen',0), ('bottle',0), ('can',0),
	('tin',0), ('jar',0), ('tube',0), ('tray',0), ('sheet',0),
	('bar',0), ('cylinder',0), ('keg',0), ('set',0), ('g',3),
	('kg',3), ('tonne',3), ('ml',3), ('litre',3), ('kl',3),
	('mm',3), ('cm',3), ('m',3), ('sqm',3), ('sqft',3);--> statement-breakpoint

-- The alias map: a generous SPELLING surface over a narrow STORAGE surface,
-- which is the whole reason a closed vocabulary costs nobody an onboarding.
-- Byte-for-byte the same map as `UOM_ALIASES` in `src/modules/catalog/uom.ts`;
-- the e2e suite asserts set equality in BOTH directions, so an alias that
-- exists only here (or only there) fails rather than drifting.
CREATE TEMP TABLE uom_alias (alias text PRIMARY KEY, canonical text NOT NULL REFERENCES uom_canonical(uom));--> statement-breakpoint
INSERT INTO uom_alias (alias, canonical) VALUES
	('ea','each'), ('eaches','each'), ('unit','each'), ('units','each'),
	('pc','each'), ('pcs','each'), ('piece','each'), ('pieces','each'),
	('no','each'), ('nos','each'), ('number','each'), ('numbers','each'),
	('item','each'), ('items','each'), ('qty','each'), ('boxes','box'),
	('bx','box'), ('cases','case'), ('cs','case'), ('cartons','carton'),
	('ctn','carton'), ('ctns','carton'), ('packs','pack'), ('packet','pack'),
	('packets','pack'), ('pkt','pack'), ('pkts','pack'), ('pk','pack'),
	('pallets','pallet'), ('plt','pallet'), ('plts','pallet'), ('bags','bag'),
	('sack','bag'), ('sacks','bag'), ('drums','drum'), ('rolls','roll'),
	('crates','crate'), ('bundles','bundle'), ('bdl','bundle'), ('bdls','bundle'),
	('pairs','pair'), ('pr','pair'), ('prs','pair'), ('dozens','dozen'),
	('dz','dozen'), ('doz','dozen'), ('gram','g'), ('grams','g'),
	('gm','g'), ('gms','g'), ('gramme','g'), ('grammes','g'),
	('kgs','kg'), ('kilo','kg'), ('kilos','kg'), ('kilogram','kg'),
	('kilograms','kg'), ('kilogramme','kg'), ('kilogrammes','kg'), ('tonnes','tonne'),
	('ton','tonne'), ('tons','tonne'), ('mt','tonne'), ('t','tonne'),
	('metric ton','tonne'), ('metric tonne','tonne'), ('milliliter','ml'), ('millilitre','ml'),
	('milliliters','ml'), ('millilitres','ml'), ('mls','ml'), ('cc','ml'),
	('l','litre'), ('lt','litre'), ('ltr','litre'), ('ltrs','litre'),
	('liter','litre'), ('liters','litre'), ('litres','litre'), ('kilolitre','kl'),
	('kilolitres','kl'), ('kiloliter','kl'), ('kiloliters','kl'), ('kls','kl'),
	('millimeter','mm'), ('millimeters','mm'), ('millimetre','mm'), ('millimetres','mm'),
	('mms','mm'), ('centimeter','cm'), ('centimeters','cm'), ('centimetre','cm'),
	('centimetres','cm'), ('cms','cm'), ('meter','m'), ('meters','m'),
	('metre','m'), ('metres','m'), ('mtr','m'), ('mtrs','m'),
	('sq m','sqm'), ('sq.m','sqm'), ('sqmt','sqm'), ('sqmtr','sqm'),
	('m2','sqm'), ('square meter','sqm'), ('square metre','sqm'), ('sq ft','sqft'),
	('sq.ft','sqft'), ('sqfeet','sqft'), ('ft2','sqft'), ('square foot','sqft'),
	('square feet','sqft'), ('bottles','bottle'), ('cans','can'), ('tins','tin'),
	('jars','jar'), ('tubes','tube'), ('trays','tray'), ('sheets','sheet'),
	('bars','bar'), ('cylinders','cylinder'), ('kegs','keg'), ('sets','set');--> statement-breakpoint

-- `resolve_uom` is `resolveUom` in SQL: normalize (trim, lower-case, collapse
-- internal whitespace, strip the trailing spreadsheet punctuation a CSV cell
-- carries — `"Kg."`, `"pcs,"`), then map through the aliases. NULL when the
-- vocabulary does not know the spelling. Every step below asks this one
-- function, so the pre-flight refusal, the dedup and the rewrite can never
-- disagree about what a cell means.
CREATE FUNCTION pg_temp.resolve_uom(raw text) RETURNS text LANGUAGE sql STABLE AS $fn$
	SELECT COALESCE(
		(SELECT c.uom FROM uom_canonical c WHERE c.uom = n.norm),
		(SELECT a.canonical FROM uom_alias a WHERE a.alias = n.norm)
	)
	FROM (
		SELECT regexp_replace(
			lower(regexp_replace(btrim(raw), '[[:space:]]+', ' ', 'g')),
			'[.,;:[:space:]]+$', ''
		) AS norm
	) n;
$fn$;--> statement-breakpoint

-- ── 1. pre-flight: every unresolvable spelling, named AT ONCE ─────────────
-- Without this, an unmappable unit surfaces as a bare 23514 from the CHECK at
-- the very end, naming ONE value — so an operator fixes one row, re-runs the
-- deploy, and meets the next one. The ledger guard further down already
-- established the pattern; this is the same courtesy applied to the input.
DO $$
DECLARE
	unknown_units text;
BEGIN
	SELECT string_agg(DISTINCT quote_literal(u.uom), ', ' ORDER BY quote_literal(u.uom)) INTO unknown_units
	FROM (
		SELECT "uom" FROM "skus"
		UNION ALL
		SELECT "uom" FROM "uom_conversions"
	) u
	WHERE pg_temp.resolve_uom(u."uom") IS NULL;
	IF unknown_units IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0027: these stored unit spellings are outside the vocabulary and cannot be resolved: %. Correct them (or add them to src/modules/catalog/uom.ts AND this migration) before deploying — the whole list is here so this is one fix, not one per run.', unknown_units;
	END IF;
END $$;--> statement-breakpoint

-- ── 2. conversions are made unique BEFORE the spellings collapse ──────────
-- `uom_conversions_sku_id_uom_unique` is the trap. One SKU carrying both
-- `box:12` and `boxes:12` is two legal rows today and ONE row after
-- normalization — so the rewrite in step 3 would abort the deploy on a unique
-- violation, mid-migration, with the SKUs already half-rewritten. Both
-- deletions therefore run on the RESOLVED value, ahead of any UPDATE.

-- 2a. A conversion whose target resolves to its SKU's own base unit is not a
-- conversion at all — `box:12` against a base of `boxes` was two spellings of
-- one unit, and a factor-12 identity conversion is a lie about the catalog.
DELETE FROM "uom_conversions" c
USING "skus" s
WHERE c."sku_id" = s."id"
	AND pg_temp.resolve_uom(c."uom") = pg_temp.resolve_uom(s."uom");--> statement-breakpoint

-- 2b. Two spellings of the same target on one SKU keep the OLDEST row (ids are
-- uuidv7, so lowest id is first created — the one the tenant entered first).
DELETE FROM "uom_conversions" c
USING "uom_conversions" keep
WHERE c."sku_id" = keep."sku_id"
	AND pg_temp.resolve_uom(c."uom") = pg_temp.resolve_uom(keep."uom")
	AND c."id" > keep."id";--> statement-breakpoint

-- ── 3. the stored spellings become canonical ──────────────────────────────
-- `pcs` becomes `each`, which IS a visible change to what the API returns for
-- today's SKUs; at four distinct stored spellings and pre-launch that is
-- cheap, but it is a change, not a no-op, and it is written here where it can
-- be seen.
UPDATE "skus" SET "uom" = pg_temp.resolve_uom("uom") WHERE "uom" <> pg_temp.resolve_uom("uom");--> statement-breakpoint
UPDATE "uom_conversions" SET "uom" = pg_temp.resolve_uom("uom") WHERE "uom" <> pg_temp.resolve_uom("uom");--> statement-breakpoint

-- ── 4. stored quantities are aligned to their unit's new precision ────────
-- Only a 0-decimal unit can be violated: the representation is milli-units, so
-- a 3-decimal unit already stores exactly what it can express, and every unit
-- in the vocabulary declares 0 or 3. For a whole-unit SKU the rule is
-- therefore "a multiple of 1000 milli-units".
--
-- Today every one of these statements touches ZERO rows, and that is a fact
-- about 0026 rather than an assumption: it multiplied every quantity by
-- exactly 1000, so every value that predates this migration is already a
-- multiple of 1000. They are written anyway — an alignment claimed in a
-- comment and not performed in SQL is an alignment nobody can audit, and the
-- next environment to be migrated may not have 0026's guarantee behind it.
--
-- **They round TOGETHER, not column by column.** Rounding each column on its
-- own is how a migration invents a divergence the reconciliation oracle then
-- quarantines: `sum(batch_on_hand)` drifting off `stock_on_hand`, or a
-- `reserved_qty` rounded UP past a `qty` rounded DOWN, which is
-- `order_lines_reserved_qty_lte_qty` failing and, before that, ATP going
-- negative. Every paired column is rounded in ONE statement, and step 5
-- asserts the pairings held.

-- 4a. The batch rows round first, and the exact amount they moved is captured
-- so `stock_on_hand` can follow them rather than round independently.
CREATE TEMP TABLE batch_alignment AS
SELECT b."tenant_id", b."sku_id", b."bin_id",
	sum(round(b."quantity" / 1000.0) * 1000 - b."quantity")::bigint AS delta
FROM "batch_on_hand" b
JOIN "skus" s ON s."id" = b."sku_id"
JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
GROUP BY 1, 2, 3
HAVING sum(round(b."quantity" / 1000.0) * 1000 - b."quantity") <> 0;--> statement-breakpoint

UPDATE "batch_on_hand" q SET "quantity" = round(q."quantity" / 1000.0) * 1000
FROM "skus" s JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
WHERE q."sku_id" = s."id" AND q."quantity" % 1000 <> 0;--> statement-breakpoint

-- 4b. `stock_on_hand` moves by exactly what its batch rows moved. A bin whose
-- stock is entirely batch-tracked lands aligned by construction and is left
-- alone by the statement after this one; a bin carrying non-batch stock as
-- well keeps that surplus rather than having it overwritten by the batch sum.
UPDATE "stock_on_hand" q SET "quantity" = greatest(q."quantity" + a.delta, 0)
FROM batch_alignment a
WHERE q."tenant_id" = a."tenant_id" AND q."sku_id" = a."sku_id" AND q."bin_id" = a."bin_id";--> statement-breakpoint

UPDATE "stock_on_hand" q SET "quantity" = round(q."quantity" / 1000.0) * 1000
FROM "skus" s JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
WHERE q."sku_id" = s."id" AND q."quantity" % 1000 <> 0;--> statement-breakpoint

-- 4c. The floors are the existing CHECKs, restated: a reservation, a GRN line,
-- an over-receipt, a placement and a pick are all `> 0`, so a value under half
-- a unit floors to one whole unit rather than rounding to a zero the
-- constraint would reject.
UPDATE "reservations" q SET "quantity" = greatest(round(q."quantity" / 1000.0) * 1000, 1000)
FROM "skus" s JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
WHERE q."sku_id" = s."id" AND q."quantity" % 1000 <> 0;--> statement-breakpoint

UPDATE "purchase_order_lines" q SET
	"ordered_qty" = greatest(round(q."ordered_qty" / 1000.0) * 1000, 1000),
	"received_qty" = round(q."received_qty" / 1000.0) * 1000
FROM "skus" s JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
WHERE q."sku_id" = s."id" AND (q."ordered_qty" % 1000 <> 0 OR q."received_qty" % 1000 <> 0);--> statement-breakpoint

-- `applied_qty <= qty` is a CHECK: the applied half is clamped to the rounded
-- physical half in the same statement that rounds it.
UPDATE "goods_receipt_lines" q SET
	"qty" = greatest(round(q."qty" / 1000.0) * 1000, 1000),
	"applied_qty" = least(
		round(q."applied_qty" / 1000.0) * 1000,
		greatest(round(q."qty" / 1000.0) * 1000, 1000)
	)
FROM "skus" s JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
WHERE q."sku_id" = s."id" AND (q."qty" % 1000 <> 0 OR q."applied_qty" % 1000 <> 0);--> statement-breakpoint

UPDATE "over_receipts" q SET "excess_qty" = greatest(round(q."excess_qty" / 1000.0) * 1000, 1000)
FROM "skus" s JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
WHERE q."sku_id" = s."id" AND q."excess_qty" % 1000 <> 0;--> statement-breakpoint

UPDATE "putaway_placements" q SET "qty" = greatest(round(q."qty" / 1000.0) * 1000, 1000)
FROM "skus" s JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
WHERE q."sku_id" = s."id" AND q."qty" % 1000 <> 0;--> statement-breakpoint

-- `reserved_qty <= qty` is a CHECK, and the reserved half is what ATP is
-- derived from — rounding it UP past a `qty` rounded DOWN is a negative ATP.
UPDATE "order_lines" q SET
	"qty" = greatest(round(q."qty" / 1000.0) * 1000, 1000),
	"reserved_qty" = least(
		round(q."reserved_qty" / 1000.0) * 1000,
		greatest(round(q."qty" / 1000.0) * 1000, 1000)
	)
FROM "skus" s JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
WHERE q."sku_id" = s."id" AND (q."qty" % 1000 <> 0 OR q."reserved_qty" % 1000 <> 0);--> statement-breakpoint

-- `picklist_lines_slice_shape` is the tightest constraint in the schema: an
-- unplanned slice is (no bin, qty 0, shortfall > 0), a planned one is (bin,
-- qty > 0, shortfall 0), and a short one is (bin, qty > 0, 0 < shortfall <=
-- qty). Rounding has to preserve whichever arm the row is in, so each half is
-- floored or zeroed by its own arm rather than by one blanket expression.
UPDATE "picklist_lines" q SET
	"qty" = CASE WHEN q."bin_id" IS NULL THEN 0 ELSE greatest(round(q."qty" / 1000.0) * 1000, 1000) END,
	"shortfall_qty" = CASE
		WHEN q."shortfall_qty" = 0 THEN 0
		WHEN q."bin_id" IS NULL THEN greatest(round(q."shortfall_qty" / 1000.0) * 1000, 1000)
		ELSE least(
			greatest(round(q."shortfall_qty" / 1000.0) * 1000, 1000),
			greatest(round(q."qty" / 1000.0) * 1000, 1000)
		)
	END
FROM "skus" s JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
WHERE q."sku_id" = s."id" AND (q."qty" % 1000 <> 0 OR q."shortfall_qty" % 1000 <> 0);--> statement-breakpoint

UPDATE "picks" q SET "qty" = greatest(round(q."qty" / 1000.0) * 1000, 1000)
FROM "skus" s JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
WHERE q."sku_id" = s."id" AND q."qty" % 1000 <> 0;--> statement-breakpoint

-- The SKU's own UoM-denominated thresholds. Zero is meaningful here — it is
-- how the catalog says a SKU has no reorder point at all — so these round
-- rather than floor.
UPDATE "skus" q SET
	"reorder_point" = round(q."reorder_point" / 1000.0) * 1000,
	"reorder_qty" = round(q."reorder_qty" / 1000.0) * 1000
FROM uom_canonical c
WHERE c.uom = q."uom" AND c.places = 0
	AND (q."reorder_point" % 1000 <> 0 OR q."reorder_qty" % 1000 <> 0);--> statement-breakpoint

-- `bins.capacity` has no SKU and therefore no unit at all: a bin holds many
-- SKUs measured many ways, and `suggestBin` calls its capacity "shared
-- base-UoM space". It is whole units, always — and FLOORED at one, because a
-- capacity that rounds to zero is a bin that can never accept a putaway, which
-- is a worse answer than a bin one unit smaller than it was.
UPDATE "bins" SET "capacity" = greatest(round("capacity" / 1000.0) * 1000, 1000) WHERE "capacity" % 1000 <> 0;--> statement-breakpoint

-- ── 5. the alignment is asserted, not assumed ─────────────────────────────
-- THE LEDGER IS NOT REWRITTEN, AND A MISALIGNED EVENT IS A HARD STOP.
-- `ledger_events` is append-only: BEFORE UPDATE/DELETE row triggers enforce it
-- (0026 could touch the table only because `ALTER TABLE … SET DATA TYPE`
-- rewrites without firing them — an `UPDATE` would fire them and fail), and
-- `quantity_delta` is one of the bytes each event's `event_hash` is taken
-- over. Rewriting a settled event to make a balance tidy is exactly what an
-- append-only ledger exists to prevent.
--
-- The other three checks are the pairings step 4 rounded together. They are
-- cheap, they run once, and they are the difference between "the alignment is
-- consistent" being a claim in a comment and being a fact the deploy proved.
DO $$
DECLARE
	misaligned bigint;
	broken bigint;
BEGIN
	SELECT count(*) INTO misaligned
	FROM "ledger_events" e
	JOIN "skus" s ON s."id" = e."sku_id"
	JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
	WHERE e."quantity_delta" % 1000 <> 0;
	IF misaligned > 0 THEN
		RAISE EXCEPTION 'migration 0027: % ledger event(s) on whole-unit SKUs carry a fractional quantity_delta. The ledger is append-only and hash-chained, so this migration will not rewrite them — reconcile the affected SKUs before declaring their units whole-unit.', misaligned;
	END IF;

	SELECT count(*) INTO broken
	FROM "stock_on_hand" q
	JOIN "skus" s ON s."id" = q."sku_id"
	JOIN uom_canonical c ON c.uom = s."uom" AND c.places = 0
	WHERE q."quantity" < COALESCE((
		SELECT sum(b."quantity") FROM "batch_on_hand" b
		WHERE b."tenant_id" = q."tenant_id" AND b."sku_id" = q."sku_id" AND b."bin_id" = q."bin_id"
	), 0);
	IF broken > 0 THEN
		RAISE EXCEPTION 'migration 0027: alignment left % (sku, bin) scope(s) holding less stock than their batch rows claim. Rounding must never make the batch projection exceed the plain one.', broken;
	END IF;

	SELECT count(*) INTO broken FROM "order_lines" WHERE "reserved_qty" > "qty";
	IF broken > 0 THEN
		RAISE EXCEPTION 'migration 0027: alignment left % order line(s) reserving more than they ordered — ATP would read negative.', broken;
	END IF;

	SELECT count(*) INTO broken FROM "goods_receipt_lines" WHERE "applied_qty" > "qty";
	IF broken > 0 THEN
		RAISE EXCEPTION 'migration 0027: alignment left % goods-receipt line(s) applying more than was physically received.', broken;
	END IF;
END $$;--> statement-breakpoint

-- ── 6. the vocabulary becomes a database constraint ───────────────────────
-- The enum-by-CHECK pattern, written the way the other ten are. `skus.uom` is
-- immutable after import (CSV import is the only creator of SKUs — there is no
-- `POST /skus` — and `PatchSkuDto` carries no `uom`), so this constraint is
-- checked at exactly one write path; it is a backstop, and it is meant to be.
ALTER TABLE "skus" ADD CONSTRAINT "skus_uom_check" CHECK ("uom" IN ('each','box','case','carton','pack','pallet','bag','drum','roll','crate','bundle','pair','dozen','bottle','can','tin','jar','tube','tray','sheet','bar','cylinder','keg','set','g','kg','tonne','ml','litre','kl','mm','cm','m','sqm','sqft'));--> statement-breakpoint
ALTER TABLE "uom_conversions" ADD CONSTRAINT "uom_conversions_uom_check" CHECK ("uom" IN ('each','box','case','carton','pack','pallet','bag','drum','roll','crate','bundle','pair','dozen','bottle','can','tin','jar','tube','tray','sheet','bar','cylinder','keg','set','g','kg','tonne','ml','litre','kl','mm','cm','m','sqm','sqft'));--> statement-breakpoint

-- The whole-unit capacity rule, stated where it cannot be bypassed. The bin
-- command refuses a fractional or sub-unit capacity first (a readable 400
-- naming the reason); this is the backstop that keeps a direct write from
-- inventing one. `> 0` is part of the rule, not decoration: a bin with zero
-- capacity accepts no putaway ever, and the API contract has never allowed
-- one.
ALTER TABLE "bins" ADD CONSTRAINT "bins_capacity_whole_units" CHECK ("capacity" % 1000 = 0 AND "capacity" > 0);--> statement-breakpoint

-- ── 7. the scaffolding comes down ─────────────────────────────────────────
-- Temp objects are session-scoped, and the migrator's session outlives this
-- file; dropping them keeps the next migration's namespace clean.
DROP TABLE batch_alignment;--> statement-breakpoint
DROP TABLE uom_alias;--> statement-breakpoint
DROP TABLE uom_canonical;--> statement-breakpoint
DROP FUNCTION pg_temp.resolve_uom(text);
