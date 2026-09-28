-- Story 21-1 — the client dimension (migration A, AD-23): the `clients`
-- table with exactly one system-owned `self` client per tenant, `client_id`
-- NOT NULL backfilled on `skus`, `orders`, `purchase_orders` and
-- `ledger_events`, and the two designed nullable columns
-- (`bins.dedicated_client_id`, `users.client_id`).
--
-- WHY IN PLACE (the 10-1 "last in-place migration" licence, spent on
-- quantity REWRITES, still holds for a NEW column). Backfilling a NEW column
-- changes no representation: `event_hash`, every quantity column and all
-- pre-existing columns are byte-identical before and after — the hash chain
-- is NOT touched (client_id is not an input to `event_hash`), no type is
-- rewritten and no value re-derived. Only INSERTs change shape. The licence
-- story 10.1 recorded ("no reader to cut over, no rollback to rehearse") is
-- what makes this honest today; it expires with the first real tenant. What
-- 10-1's caveat actually forbids is rewriting an EXISTING column's
-- representation — this migration does none.
--
-- RLS SCOPE (deliberate): this migration adds ONLY the standard
-- tenant-only `clients_tenant_isolation` policy. The second RLS session
-- variable `app.client_id`, the fail-closed policies on the four tables and
-- the DB-level isolation probe are story 21-2's — landing the clause without
-- its probe would ship an unverified leak-guard.
--
-- Proven by `test/client-dimension.spec.ts` Part A: the migration is applied,
-- inside one transaction, to a database built from this repo's OWN migration
-- journal trimmed to 0039 and seeded with tenants, SKUs, orders, POs and
-- ledger rows — the `test/fractional-quantity.spec.ts` Part-A harness.

-- ── 0. the fail-fast guard ────────────────────────────────────────────────
-- This migration is NOT idempotent and cannot be made so: the backfill
-- UPDATEs are keyed on the self client's existence, so a second run would
-- find the columns already NOT NULL and re-`ADD COLUMN` into a hard error —
-- but only after the pre-flight and the table create had half-worked in
-- whatever transaction carried them. The drizzle journal normally makes a
-- re-run impossible; a hand-applied re-run (or a snapshot that went missing,
-- so `db:generate` emits a duplicate column someone then "fixes" the same
-- way) would not be caught by anything else. Refuse loudly instead.
DO $$
BEGIN
	IF to_regclass('public.clients') IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0040 has already been applied: the "clients" table already exists. Re-running would re-backfill client_id a second time.';
	END IF;
END $$;--> statement-breakpoint

-- ── 1. the pre-flight block ───────────────────────────────────────────────
-- The backfill maps every row to ITS OWN tenant's self client, so the only
-- unmappable row is one whose `tenant_id` has no `tenants` row — an orphan
-- that no INSERT can ever repair. The block lists EVERY orphan at once, per
-- table, so an operator fixes all of them in one pass, not one row per run.
DO $$
DECLARE
	orphans text;
BEGIN
	SELECT string_agg(format('%s: tenant %s', tbl, tid), ', ' ORDER BY tbl, tid)
	INTO orphans
	FROM (
		SELECT DISTINCT 'skus' AS tbl, s.tenant_id AS tid
			FROM skus s LEFT JOIN tenants t ON t.id = s.tenant_id WHERE t.id IS NULL
		UNION ALL
		SELECT DISTINCT 'orders', o.tenant_id
			FROM orders o LEFT JOIN tenants t ON t.id = o.tenant_id WHERE t.id IS NULL
		UNION ALL
		SELECT DISTINCT 'purchase_orders', p.tenant_id
			FROM purchase_orders p LEFT JOIN tenants t ON t.id = p.tenant_id WHERE t.id IS NULL
		UNION ALL
		SELECT DISTINCT 'ledger_events', l.tenant_id
			FROM ledger_events l LEFT JOIN tenants t ON t.id = l.tenant_id WHERE t.id IS NULL
	) found;
	IF orphans IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0040 pre-flight failed: rows whose tenant does not exist, unmappable to any client (%)', orphans;
	END IF;
END $$;--> statement-breakpoint

-- ── 2. the table ──────────────────────────────────────────────────────────
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"system_owned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_id_code_unique" ON "clients" USING btree ("tenant_id","code");--> statement-breakpoint
-- AD-23: exactly one system-owned client per tenant — the partial unique
-- index refuses a second in any transaction, including a concurrent ensure.
CREATE UNIQUE INDEX "clients_tenant_system_owned_unique" ON "clients" USING btree ("tenant_id") WHERE system_owned;--> statement-breakpoint

-- ── hand-appended: the CHECKs + RLS (the 0008 pattern) ─────────────────────
-- `drizzle-kit generate` is blind to CHECKs and to RLS, so both are
-- migration-SQL-only. The status vocabulary is the FULL designed set frozen
-- at birth: widening a CHECK needs DROP then re-ADD (the 0023/0024
-- precedent), so `departed` is admitted now even though client offboarding
-- is a non-goal of this story.
ALTER TABLE "clients" ADD CONSTRAINT "clients_status_check" CHECK (
  "status" IN ('active', 'suspended', 'departed')
);
-- A system-owned client is the tenant's own goods — it cannot be `departed`.
ALTER TABLE "clients" ADD CONSTRAINT "clients_system_owned_not_departed" CHECK (
  "system_owned" = false OR "status" <> 'departed'
);
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "clients_tenant_isolation" ON "clients"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. one self client per existing tenant ────────────────────────────────
-- The backfill's mapping source: every tenant that exists at migration time
-- gets exactly one `system_owned` `self` client, named after the tenant.
-- `gen_random_uuid()` here is migration-time only (the 0021 precedent) — the
-- app stamps uuidv7 on every client it creates after this migration.
INSERT INTO "clients" ("id", "tenant_id", "code", "name", "status", "system_owned")
SELECT gen_random_uuid(), t."id", 'self', t."name", 'active', true
FROM "tenants" t;--> statement-breakpoint

-- ── 4. the scoping column on the four tables: add, backfill, assert, lock ──
-- The column is added NULLABLE, backfilled from the self client, asserted to
-- have mapped every row, and only then locked NOT NULL — the reverse order
-- (a NOT NULL add) would fail on any non-empty table, and a backfill with no
-- assertion is exactly the gap both migration reviews caught.
ALTER TABLE "ledger_events" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "bins" ADD COLUMN "dedicated_client_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "client_id" uuid;--> statement-breakpoint

-- The append-only guard (0006) is a BEFORE UPDATE row trigger on
-- `ledger_events` — it exists to stop APPLICATION writers from mutating
-- settled events, and it would refuse this backfill. The migration is the one
-- legitimate mass writer of settled rows: this UPDATE sets ONLY the new
-- `client_id` column (event_hash is untouched), and both statements below run
-- inside the migration's single transaction, so a failure anywhere rolls the
-- disable back too — the guard can never be left off. (0026 needed no such
-- dance because its `SET DATA TYPE` rewrites the table without firing row
-- triggers; a backfill UPDATE does fire them.)
ALTER TABLE "ledger_events" DISABLE TRIGGER "ledger_events_append_only";--> statement-breakpoint
UPDATE "ledger_events" l SET "client_id" = c."id"
  FROM "clients" c WHERE c."tenant_id" = l."tenant_id" AND c."code" = 'self' AND c."system_owned";--> statement-breakpoint
ALTER TABLE "ledger_events" ENABLE TRIGGER "ledger_events_append_only";--> statement-breakpoint
UPDATE "orders" o SET "client_id" = c."id"
  FROM "clients" c WHERE c."tenant_id" = o."tenant_id" AND c."code" = 'self' AND c."system_owned";--> statement-breakpoint
UPDATE "purchase_orders" p SET "client_id" = c."id"
  FROM "clients" c WHERE c."tenant_id" = p."tenant_id" AND c."code" = 'self' AND c."system_owned";--> statement-breakpoint
UPDATE "skus" s SET "client_id" = c."id"
  FROM "clients" c WHERE c."tenant_id" = s."tenant_id" AND c."code" = 'self' AND c."system_owned";--> statement-breakpoint

-- ── the post-migration assertion ──────────────────────────────────────────
-- Every row must now carry a client. A row that didn't map (an orphan the
-- pre-flight could not have seen — a tenant deleted mid-migration between
-- two statements) fails the migration HERE, naming every table at once,
-- BEFORE the NOT NULL locks the shape in.
DO $$
DECLARE
	unmapped text;
BEGIN
	SELECT string_agg(tbl || ': ' || n::text, ', ')
	INTO unmapped
	FROM (
		SELECT 'skus' AS tbl, count(*) AS n FROM "skus" WHERE "client_id" IS NULL
		UNION ALL
		SELECT 'orders', count(*) FROM "orders" WHERE "client_id" IS NULL
		UNION ALL
		SELECT 'purchase_orders', count(*) FROM "purchase_orders" WHERE "client_id" IS NULL
		UNION ALL
		SELECT 'ledger_events', count(*) FROM "ledger_events" WHERE "client_id" IS NULL
	) counts
	WHERE n > 0;
	IF unmapped IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0040 post-assertion failed: rows still without a client after backfill (%)', unmapped;
	END IF;
END $$;--> statement-breakpoint

ALTER TABLE "ledger_events" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ALTER COLUMN "client_id" SET NOT NULL;