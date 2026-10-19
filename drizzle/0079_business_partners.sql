-- ── story 1-3: the business partner master ───────────────────────────────
-- HAND-WRITTEN (drizzle-kit would drop `vendors` and create a new table; the
-- rename must happen IN PLACE so every id — and every `purchase_orders.
-- vendor_id` / `suggested_pos.vendor_id` pointing at one — survives with its
-- `created_at`). `drizzle/meta/0079_snapshot.json` was edited to match
-- `schema.ts`; `bun run db:generate` afterwards reports "No schema changes".
--
-- Order (each step reads what the one before it left):
--   0. fail-fast + pre-flight: refuse to run twice; list every PO whose
--      vendor_id resolves to no vendor, all at once
--   1. rename `vendors` → `business_partners` (table, pkey, indexes, policy)
--   2. the new partner columns, their CHECKs, the GSTIN partial unique
--   3. `partner_client_links` + its CHECKs, indexes and RLS (the 0041 clause)
--   4. backfill links from history: DISTINCT (vendor, client) over
--      purchase_orders ∪ (suggested_pos drafts ⋈ skus.client_id)
--   5. backfill each client's default: among the linked `is_default` vendors,
--      the lowest (created_at, id)
--   6. backfill `purchase_orders.vendor_snapshot` in the full v1 shape
--   7. the probe: no PO with a null snapshot or an unresolved vendor; every
--      historical pair linked; at most one default per client; every CHECK
--      refuses its named bad shape and admits a good one
--   8. drop `is_default` from the partner row (it moved onto the link)
--
-- No foreign keys (IMPLEMENTATION-GUIDE §3). Lock cost: the rename and the
-- ADD COLUMNs take ACCESS EXCLUSIVE on `business_partners` (tens to hundreds
-- of rows); the snapshot backfill rewrites every `purchase_orders` row once.

-- ── 0. fail-fast + pre-flight ────────────────────────────────────────────
DO $$
DECLARE
	orphans text;
BEGIN
	IF to_regclass('public.business_partners') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0079: business_partners already exists — this migration has already been applied.';
	END IF;
	SELECT string_agg(format('%s (tenant %s, vendor_id %s)', po.code, po.tenant_id, po.vendor_id), '; ' ORDER BY po.code)
	  INTO orphans
	  FROM purchase_orders po
	 WHERE NOT EXISTS (SELECT 1 FROM vendors v WHERE v.tenant_id = po.tenant_id AND v.id = po.vendor_id);
	IF orphans IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0079: purchase orders whose vendor_id resolves to no vendor: %', orphans;
	END IF;
END $$;
--> statement-breakpoint

-- ── 1. rename in place ───────────────────────────────────────────────────
ALTER TABLE "vendors" RENAME TO "business_partners";--> statement-breakpoint
ALTER TABLE "business_partners" RENAME CONSTRAINT "vendors_pkey" TO "business_partners_pkey";--> statement-breakpoint
ALTER INDEX "vendors_tenant_id_code_unique" RENAME TO "business_partners_tenant_id_code_unique";--> statement-breakpoint
ALTER INDEX "vendors_created_at_id_idx" RENAME TO "business_partners_created_at_id_idx";--> statement-breakpoint
ALTER POLICY "vendors_tenant_isolation" ON "business_partners" RENAME TO "business_partners_tenant_isolation";--> statement-breakpoint

-- ── 2. the partner columns ───────────────────────────────────────────────
-- Every migrated vendor is an active partner in the vendor role.
ALTER TABLE "business_partners" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "gstin" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "pan" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "roles" text[];--> statement-breakpoint
UPDATE "business_partners" SET "roles" = ARRAY['vendor']::text[];--> statement-breakpoint
ALTER TABLE "business_partners" ALTER COLUMN "roles" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "registered_line1" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "registered_line2" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "registered_city" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "registered_state_code" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "registered_pincode" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "dispatch_line1" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "dispatch_line2" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "dispatch_city" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "dispatch_state_code" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "dispatch_pincode" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "business_partners" ADD COLUMN "inactive_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "business_partners_tenant_gstin_unique" ON "business_partners" USING btree ("tenant_id","gstin") WHERE gstin IS NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "vendor_snapshot" jsonb;--> statement-breakpoint

-- The partner CHECKs (migration SQL only). Mirrored by `PartnersCommand`,
-- which answers a named 400/409 first. Nullable columns say IS NULL first.
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_code_format" CHECK (
	char_length("code") BETWEEN 1 AND 64 AND "code" = btrim("code")
);--> statement-breakpoint
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_name_format" CHECK (
	char_length("name") BETWEEN 1 AND 200 AND "name" = btrim("name")
);--> statement-breakpoint
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_legal_name_format" CHECK (
	"legal_name" IS NULL OR (char_length("legal_name") BETWEEN 1 AND 200 AND "legal_name" = btrim("legal_name"))
);--> statement-breakpoint
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_gstin_format" CHECK (
	"gstin" IS NULL OR "gstin" ~ '^[0-9]{2}[A-Z0-9]{13}$'
);--> statement-breakpoint
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_pan_format" CHECK (
	"pan" IS NULL OR "pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'
);--> statement-breakpoint
-- A registered partner's PAN is its GSTIN's characters 3–12 (derived when absent).
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_pan_matches_gstin" CHECK (
	"gstin" IS NULL OR ("pan" IS NOT NULL AND "pan" = substr("gstin", 3, 10))
);--> statement-breakpoint
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_gstin_matches_state" CHECK (
	"gstin" IS NULL OR "registered_state_code" IS NULL OR left("gstin", 2) = "registered_state_code"
);--> statement-breakpoint
-- The two address groups take the clients' registered shape (0077's
-- `clients_registered_address_format`): all-or-none, line2 optional.
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_registered_address_format" CHECK (
	(
		"registered_line1" IS NULL AND "registered_line2" IS NULL AND "registered_city" IS NULL
		AND "registered_state_code" IS NULL AND "registered_pincode" IS NULL
	) OR (
		"registered_line1" IS NOT NULL AND char_length("registered_line1") BETWEEN 1 AND 200
		AND ("registered_line2" IS NULL OR char_length("registered_line2") BETWEEN 1 AND 200)
		AND "registered_city" IS NOT NULL AND char_length("registered_city") BETWEEN 1 AND 100
		AND "registered_state_code" IS NOT NULL AND "registered_state_code" ~ '^[0-9]{2}$'
		AND "registered_pincode" IS NOT NULL AND "registered_pincode" ~ '^[0-9]{6}$'
	)
);--> statement-breakpoint
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_dispatch_address_format" CHECK (
	(
		"dispatch_line1" IS NULL AND "dispatch_line2" IS NULL AND "dispatch_city" IS NULL
		AND "dispatch_state_code" IS NULL AND "dispatch_pincode" IS NULL
	) OR (
		"dispatch_line1" IS NOT NULL AND char_length("dispatch_line1") BETWEEN 1 AND 200
		AND ("dispatch_line2" IS NULL OR char_length("dispatch_line2") BETWEEN 1 AND 200)
		AND "dispatch_city" IS NOT NULL AND char_length("dispatch_city") BETWEEN 1 AND 100
		AND "dispatch_state_code" IS NOT NULL AND "dispatch_state_code" ~ '^[0-9]{2}$'
		AND "dispatch_pincode" IS NOT NULL AND "dispatch_pincode" ~ '^[0-9]{6}$'
	)
);--> statement-breakpoint
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_contact_format" CHECK (
	("contact_name" IS NULL OR (char_length("contact_name") BETWEEN 1 AND 120 AND "contact_name" = btrim("contact_name")))
	AND ("contact_phone" IS NULL OR (char_length("contact_phone") BETWEEN 1 AND 20 AND "contact_phone" = btrim("contact_phone")))
	AND ("contact_email" IS NULL OR (
		"contact_email" = lower(btrim("contact_email")) AND char_length("contact_email") BETWEEN 3 AND 254
		AND strpos("contact_email", '@') > 1
	))
);--> statement-breakpoint
-- Non-empty, drawn from the vocabulary, no NULL element, no duplicate.
-- Pinned against `PARTNER_ROLES` by test/business-partners.spec.ts.
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_roles_check" CHECK (
	cardinality("roles") >= 1
	AND "roles" <@ ARRAY['vendor', 'consignee', 'transporter']::text[]
	AND array_position("roles", NULL) IS NULL
	AND coalesce(cardinality(array_positions("roles", 'vendor')), 0) <= 1
	AND coalesce(cardinality(array_positions("roles", 'consignee')), 0) <= 1
	AND coalesce(cardinality(array_positions("roles", 'transporter')), 0) <= 1
);--> statement-breakpoint
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_status_check" CHECK (
	"status" IN ('active', 'inactive')
	AND ("inactive_reason" IS NULL OR (char_length("inactive_reason") BETWEEN 1 AND 200 AND "inactive_reason" = btrim("inactive_reason")))
	AND ("status" = 'inactive' OR "inactive_reason" IS NULL)
);--> statement-breakpoint

-- ── 3. partner_client_links ──────────────────────────────────────────────
CREATE TABLE "partner_client_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"role" text NOT NULL,
	"client_code" text,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "partner_client_links_partner_client_role_unique" ON "partner_client_links" USING btree ("tenant_id","partner_id","client_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_client_links_client_code_unique" ON "partner_client_links" USING btree ("tenant_id","client_id","role","client_code") WHERE client_code IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_client_links_one_default_unique" ON "partner_client_links" USING btree ("tenant_id","client_id") WHERE is_default;--> statement-breakpoint
CREATE INDEX "partner_client_links_tenant_client_role_idx" ON "partner_client_links" USING btree ("tenant_id","client_id","role");--> statement-breakpoint
ALTER TABLE "partner_client_links" ADD CONSTRAINT "partner_client_links_role_check" CHECK (
	"role" IN ('vendor', 'consignee')
);--> statement-breakpoint
ALTER TABLE "partner_client_links" ADD CONSTRAINT "partner_client_links_client_code_format" CHECK (
	"client_code" IS NULL OR (char_length("client_code") BETWEEN 1 AND 64 AND "client_code" = btrim("client_code"))
);--> statement-breakpoint
-- A default is an ACTIVE VENDOR link (deactivating a link clears it).
ALTER TABLE "partner_client_links" ADD CONSTRAINT "partner_client_links_default_check" CHECK (
	NOT "is_default" OR ("role" = 'vendor' AND "active")
);--> statement-breakpoint
-- RLS: the tenant arm plus the 0041 `app.client_id` clause on `client_id` —
-- a portal-stamped transaction sees only its own client's links (decision 8:
-- no portal route reads them yet; defence in depth).
ALTER TABLE "partner_client_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "partner_client_links_tenant_isolation" ON "partner_client_links"
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

-- ── 4. links from history (decision 7) ───────────────────────────────────
-- Every (vendor, client) pair a PO names, plus every open suggested-PO
-- draft's vendor against its SKU's client. A vendor with no history migrates
-- unlinked. Active, no client code, no default (step 5 sets it).
INSERT INTO "partner_client_links" ("id","tenant_id","partner_id","client_id","role","active","is_default")
SELECT gen_random_uuid(), pairs.tenant_id, pairs.partner_id, pairs.client_id, 'vendor', true, false
  FROM (
	SELECT po.tenant_id, po.vendor_id AS partner_id, po.client_id
	  FROM purchase_orders po
	UNION
	SELECT sp.tenant_id, sp.vendor_id, s.client_id
	  FROM suggested_pos sp
	  JOIN skus s ON s.tenant_id = sp.tenant_id AND s.id = sp.sku_id
	  JOIN business_partners bp ON bp.tenant_id = sp.tenant_id AND bp.id = sp.vendor_id
	 WHERE sp.status = 'draft' AND sp.vendor_id IS NOT NULL
  ) pairs;--> statement-breakpoint

-- ── 5. each client's default (decision 10: default only where linked) ───
-- Several `is_default` vendors could exist (no unique before); per client
-- the linked one with the lowest (created_at, id) — the old sweep's pick.
UPDATE "partner_client_links" l
   SET "is_default" = true
  FROM (
	SELECT DISTINCT ON (l2.tenant_id, l2.client_id) l2.id
	  FROM partner_client_links l2
	  JOIN business_partners bp ON bp.tenant_id = l2.tenant_id AND bp.id = l2.partner_id
	 WHERE bp.is_default
	 ORDER BY l2.tenant_id, l2.client_id, bp.created_at, bp.id
  ) pick
 WHERE l.id = pick.id;--> statement-breakpoint

-- ── 6. the vendor snapshot, full v1 shape (every key present) ────────────
UPDATE "purchase_orders" po
   SET "vendor_snapshot" = jsonb_build_object(
	'v', 1,
	'code', bp.code,
	'name', bp.name,
	'legalName', bp.legal_name,
	'gstin', bp.gstin,
	'stateCode', coalesce(bp.registered_state_code, left(bp.gstin, 2)),
	'registeredAddress', CASE WHEN bp.registered_line1 IS NULL THEN NULL ELSE jsonb_build_object(
		'line1', bp.registered_line1, 'line2', bp.registered_line2, 'city', bp.registered_city,
		'stateCode', bp.registered_state_code, 'pincode', bp.registered_pincode) END,
	'dispatchAddress', CASE WHEN bp.dispatch_line1 IS NULL THEN NULL ELSE jsonb_build_object(
		'line1', bp.dispatch_line1, 'line2', bp.dispatch_line2, 'city', bp.dispatch_city,
		'stateCode', bp.dispatch_state_code, 'pincode', bp.dispatch_pincode) END
   )
  FROM business_partners bp
 WHERE bp.tenant_id = po.tenant_id AND bp.id = po.vendor_id;--> statement-breakpoint

-- ── 7. the probe ─────────────────────────────────────────────────────────
DO $$
DECLARE
	bad text;
	t uuid := gen_random_uuid();
	c uuid := gen_random_uuid();
	p uuid := gen_random_uuid();
	refused_by text;
	expected text;
	probe text;
BEGIN
	-- (a) every PO resolves to a partner and carries a full v1 snapshot.
	SELECT string_agg(po.code, ', ' ORDER BY po.code) INTO bad
	  FROM purchase_orders po
	 WHERE po.vendor_snapshot IS NULL
	    OR NOT EXISTS (SELECT 1 FROM business_partners bp WHERE bp.tenant_id = po.tenant_id AND bp.id = po.vendor_id)
	    OR NOT (po.vendor_snapshot ?& ARRAY['v','code','name','legalName','gstin','stateCode','registeredAddress','dispatchAddress'])
	    OR (po.vendor_snapshot ->> 'v') IS DISTINCT FROM '1';
	IF bad IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0079: purchase orders without a resolvable vendor or a full v1 snapshot: %', bad;
	END IF;
	-- (b) every historical PO pair has an active vendor link.
	SELECT string_agg(DISTINCT po.code, ', ') INTO bad
	  FROM purchase_orders po
	 WHERE NOT EXISTS (
		SELECT 1 FROM partner_client_links l
		 WHERE l.tenant_id = po.tenant_id AND l.partner_id = po.vendor_id AND l.client_id = po.client_id
		   AND l.role = 'vendor' AND l.active);
	IF bad IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0079: purchase orders whose (vendor, client) pair has no active link: %', bad;
	END IF;
	-- (c) at most one default per client (the partial unique says so; asserted anyway).
	IF EXISTS (SELECT 1 FROM partner_client_links WHERE is_default GROUP BY tenant_id, client_id HAVING count(*) > 1) THEN
		RAISE EXCEPTION 'migration 0079: a client has more than one default vendor.';
	END IF;

	-- (d) accepted shapes, rolled back by a sentinel exception — a CHECK that
	-- refused everything fails the migration.
	BEGIN
		INSERT INTO "business_partners" ("id","tenant_id","code","name","legal_name","gstin","pan","roles",
			"registered_line1","registered_city","registered_state_code","registered_pincode",
			"dispatch_line1","dispatch_line2","dispatch_city","dispatch_state_code","dispatch_pincode",
			"contact_name","contact_phone","contact_email","status")
		VALUES (p, t, 'P-0079-A', 'Probe A', 'Probe A Pvt Ltd', '27ABCDE1234F1Z5', 'ABCDE1234F', ARRAY['vendor','consignee','transporter'],
			'1 Probe Road', 'Mumbai', '27', '400001',
			'2 Probe Road', 'Unit 4', 'Pune', '27', '411001',
			'Asha', '+91 98200 00000', 'asha@example.invalid', 'active');
		INSERT INTO "business_partners" ("id","tenant_id","code","name","pan","roles","status","inactive_reason")
		VALUES (gen_random_uuid(), t, 'P-0079-B', 'Probe B', 'ABCDE1234F', ARRAY['transporter'], 'inactive', 'stopped trading');
		INSERT INTO "business_partners" ("id","tenant_id","code","name","roles","status")
		VALUES (gen_random_uuid(), t, 'P-0079-C', 'Probe C', ARRAY['vendor'], 'inactive');
		INSERT INTO "partner_client_links" ("id","tenant_id","partner_id","client_id","role","client_code","active","is_default")
		VALUES (gen_random_uuid(), t, p, c, 'vendor', 'SUP-9', true, true),
		       (gen_random_uuid(), t, p, c, 'consignee', 'SUP-9', false, false);
		RAISE EXCEPTION USING ERRCODE = 'P0079', MESSAGE = 'rollback the accepted probes';
	EXCEPTION
		WHEN check_violation OR unique_violation THEN
			RAISE EXCEPTION 'migration 0079: an accepted shape was refused (%).', SQLERRM;
		WHEN SQLSTATE 'P0079' THEN
			NULL;
	END;

	-- (e) refused shapes, each by its named constraint.
	FOREACH probe IN ARRAY ARRAY[
		'code untrimmed', 'name empty', 'legal name untrimmed', 'gstin lower-case', 'pan malformed',
		'pan differs from gstin', 'gstin without pan', 'gstin in another state', 'registered without a pincode',
		'dispatch line2 alone', 'contact email upper-case', 'roles empty', 'roles unknown', 'roles duplicate',
		'status unknown', 'reason while active', 'duplicate gstin', 'link role transporter',
		'link client code untrimmed', 'default on a consignee link', 'default on an inactive link',
		'two defaults for one client', 'duplicate link', 'duplicate client code'
	] LOOP
		refused_by := NULL;
		expected := CASE probe
			WHEN 'code untrimmed' THEN 'business_partners_code_format'
			WHEN 'name empty' THEN 'business_partners_name_format'
			WHEN 'legal name untrimmed' THEN 'business_partners_legal_name_format'
			WHEN 'gstin lower-case' THEN 'business_partners_gstin_format'
			WHEN 'pan malformed' THEN 'business_partners_pan_format'
			WHEN 'pan differs from gstin' THEN 'business_partners_pan_matches_gstin'
			WHEN 'gstin without pan' THEN 'business_partners_pan_matches_gstin'
			WHEN 'gstin in another state' THEN 'business_partners_gstin_matches_state'
			WHEN 'registered without a pincode' THEN 'business_partners_registered_address_format'
			WHEN 'dispatch line2 alone' THEN 'business_partners_dispatch_address_format'
			WHEN 'contact email upper-case' THEN 'business_partners_contact_format'
			WHEN 'roles empty' THEN 'business_partners_roles_check'
			WHEN 'roles unknown' THEN 'business_partners_roles_check'
			WHEN 'roles duplicate' THEN 'business_partners_roles_check'
			WHEN 'status unknown' THEN 'business_partners_status_check'
			WHEN 'reason while active' THEN 'business_partners_status_check'
			WHEN 'duplicate gstin' THEN 'business_partners_tenant_gstin_unique'
			WHEN 'link role transporter' THEN 'partner_client_links_role_check'
			WHEN 'link client code untrimmed' THEN 'partner_client_links_client_code_format'
			WHEN 'default on a consignee link' THEN 'partner_client_links_default_check'
			WHEN 'default on an inactive link' THEN 'partner_client_links_default_check'
			WHEN 'two defaults for one client' THEN 'partner_client_links_one_default_unique'
			WHEN 'duplicate link' THEN 'partner_client_links_partner_client_role_unique'
			ELSE 'partner_client_links_client_code_unique'
		END;
		BEGIN
			CASE probe
				WHEN 'code untrimmed' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","roles") VALUES (gen_random_uuid(), t, ' P1', 'n', ARRAY['vendor']);
				WHEN 'name empty' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","roles") VALUES (gen_random_uuid(), t, 'P1', '', ARRAY['vendor']);
				WHEN 'legal name untrimmed' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","legal_name","roles") VALUES (gen_random_uuid(), t, 'P1', 'n', 'x ', ARRAY['vendor']);
				WHEN 'gstin lower-case' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","gstin","pan","roles") VALUES (gen_random_uuid(), t, 'P1', 'n', '27ABCDE1234F1z5', 'ABCDE1234F', ARRAY['vendor']);
				WHEN 'pan malformed' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","pan","roles") VALUES (gen_random_uuid(), t, 'P1', 'n', 'ABCDE12345', ARRAY['vendor']);
				WHEN 'pan differs from gstin' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","gstin","pan","roles") VALUES (gen_random_uuid(), t, 'P1', 'n', '27ABCDE1234F1Z5', 'ZZZZZ9999Z', ARRAY['vendor']);
				WHEN 'gstin without pan' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","gstin","roles") VALUES (gen_random_uuid(), t, 'P1', 'n', '27ABCDE1234F1Z5', ARRAY['vendor']);
				WHEN 'gstin in another state' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","gstin","pan","roles","registered_line1","registered_city","registered_state_code","registered_pincode")
					VALUES (gen_random_uuid(), t, 'P1', 'n', '27ABCDE1234F1Z5', 'ABCDE1234F', ARRAY['vendor'], 'l1', 'city', '29', '560001');
				WHEN 'registered without a pincode' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","roles","registered_line1","registered_city","registered_state_code")
					VALUES (gen_random_uuid(), t, 'P1', 'n', ARRAY['vendor'], 'l1', 'city', '27');
				WHEN 'dispatch line2 alone' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","roles","dispatch_line2") VALUES (gen_random_uuid(), t, 'P1', 'n', ARRAY['vendor'], 'l2');
				WHEN 'contact email upper-case' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","roles","contact_email") VALUES (gen_random_uuid(), t, 'P1', 'n', ARRAY['vendor'], 'A@example.invalid');
				WHEN 'roles empty' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","roles") VALUES (gen_random_uuid(), t, 'P1', 'n', ARRAY[]::text[]);
				WHEN 'roles unknown' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","roles") VALUES (gen_random_uuid(), t, 'P1', 'n', ARRAY['supplier']);
				WHEN 'roles duplicate' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","roles") VALUES (gen_random_uuid(), t, 'P1', 'n', ARRAY['vendor','vendor']);
				WHEN 'status unknown' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","roles","status") VALUES (gen_random_uuid(), t, 'P1', 'n', ARRAY['vendor'], 'blocked');
				WHEN 'reason while active' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","roles","status","inactive_reason") VALUES (gen_random_uuid(), t, 'P1', 'n', ARRAY['vendor'], 'active', 'why');
				WHEN 'duplicate gstin' THEN
					INSERT INTO "business_partners" ("id","tenant_id","code","name","gstin","pan","roles")
					VALUES (gen_random_uuid(), t, 'P1', 'n', '27ABCDE1234F1Z5', 'ABCDE1234F', ARRAY['vendor']),
					       (gen_random_uuid(), t, 'P2', 'n', '27ABCDE1234F1Z5', 'ABCDE1234F', ARRAY['vendor']);
				WHEN 'link role transporter' THEN
					INSERT INTO "partner_client_links" ("id","tenant_id","partner_id","client_id","role") VALUES (gen_random_uuid(), t, p, c, 'transporter');
				WHEN 'link client code untrimmed' THEN
					INSERT INTO "partner_client_links" ("id","tenant_id","partner_id","client_id","role","client_code") VALUES (gen_random_uuid(), t, p, c, 'vendor', ' S');
				WHEN 'default on a consignee link' THEN
					INSERT INTO "partner_client_links" ("id","tenant_id","partner_id","client_id","role","is_default") VALUES (gen_random_uuid(), t, p, c, 'consignee', true);
				WHEN 'default on an inactive link' THEN
					INSERT INTO "partner_client_links" ("id","tenant_id","partner_id","client_id","role","active","is_default") VALUES (gen_random_uuid(), t, p, c, 'vendor', false, true);
				WHEN 'two defaults for one client' THEN
					INSERT INTO "partner_client_links" ("id","tenant_id","partner_id","client_id","role","is_default")
					VALUES (gen_random_uuid(), t, p, c, 'vendor', true), (gen_random_uuid(), t, gen_random_uuid(), c, 'vendor', true);
				WHEN 'duplicate link' THEN
					INSERT INTO "partner_client_links" ("id","tenant_id","partner_id","client_id","role")
					VALUES (gen_random_uuid(), t, p, c, 'vendor'), (gen_random_uuid(), t, p, c, 'vendor');
				WHEN 'duplicate client code' THEN
					INSERT INTO "partner_client_links" ("id","tenant_id","partner_id","client_id","role","client_code","active")
					VALUES (gen_random_uuid(), t, p, c, 'vendor', 'S1', false), (gen_random_uuid(), t, gen_random_uuid(), c, 'vendor', 'S1', true);
			END CASE;
		EXCEPTION
			WHEN check_violation OR unique_violation THEN
				GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
		END;
		IF refused_by IS DISTINCT FROM expected THEN
			RAISE EXCEPTION 'migration 0079: probe "%" was refused by % (expected %).', probe, coalesce(refused_by, 'nothing'), expected;
		END IF;
	END LOOP;
	IF EXISTS (SELECT 1 FROM "business_partners" WHERE "tenant_id" = t) OR EXISTS (SELECT 1 FROM "partner_client_links" WHERE "tenant_id" = t) THEN
		RAISE EXCEPTION 'migration 0079: a probe row survived.';
	END IF;
END $$;
--> statement-breakpoint

-- ── 8. the default moved onto the link ───────────────────────────────────
ALTER TABLE "business_partners" DROP COLUMN "is_default";
