-- Story 21-2b — client admin and attribution. Hand-written (the 0040
-- machinery): the vocabulary a CREATED client must satisfy, enforced by the
-- database, plus the run-level client column the catalog import records.
--
--   * `clients.code` — an operator-facing code, stored UPPERCASE (the
--     warehouse-code convention): 2..32 characters of A-Z, 0-9 and `-`,
--     starting with a letter or digit. The system-owned `self` client is
--     exempt and stays lowercase `self` (its identity, `SELF_CLIENT_CODE`).
--   * `self` / `SELF` is reserved: only the system-owned row may carry it.
--     The command refuses it too; this CHECK is what makes the reservation a
--     property of the table rather than of one code path (triage #19).
--   * `clients.name` — 1..200 characters after trimming. 200 is the tenant
--     name's own cap (`tenancy.dto.ts`): the self client's name IS the tenant
--     name, so a lower cap would break registration (triage #3).
--   * `catalog_imports.client_id` — the client a run imported FOR, so a
--     fix-mode re-run inherits it (decision 3). Added nullable, backfilled
--     to each tenant's self client (every run before this story stamped
--     `self` on its SKUs), asserted, then locked NOT NULL.
--
-- No `client_id` backfill on any other table: every existing row already
-- carries `self` (0040) and stays there. Proven by the 0059 block in
-- `test/clients.spec.ts` (Part A — the `test/client-dimension.spec.ts`
-- harness: the repo's own journal trimmed to 0058, seeded, applied in one
-- transaction).

-- ── 0. the fail-fast guard ────────────────────────────────────────────────
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'catalog_imports' AND column_name = 'client_id'
	) THEN
		RAISE EXCEPTION 'migration 0059 has already been applied: catalog_imports.client_id already exists.';
	END IF;
END $$;--> statement-breakpoint

-- ── 1. the pre-flight block — EVERY offender at once ──────────────────────
-- A non-system client whose code would not satisfy the new CHECKs once
-- uppercased, a non-system client claiming the reserved code, two
-- non-system clients of one tenant whose codes collide once uppercased
-- (the dedupe-before-rewrite rule: the UPPER() below would raise 23505
-- mid-migration), any client whose trimmed name is empty or over 200, and a
-- catalog import whose tenant has no self client to backfill from.
DO $$
DECLARE
	offenders text;
BEGIN
	SELECT string_agg(problem, '; ' ORDER BY problem)
	INTO offenders
	FROM (
		SELECT format('client %s (tenant %s): code "%s" is not 2-32 characters of A-Z, 0-9, "-"', c.id, c.tenant_id, c.code) AS problem
			FROM clients c
			WHERE NOT c.system_owned AND upper(c.code) !~ '^[A-Z0-9][A-Z0-9-]{1,31}$'
		UNION ALL
		SELECT format('client %s (tenant %s): code "%s" is reserved for the system-owned self client', c.id, c.tenant_id, c.code)
			FROM clients c
			WHERE NOT c.system_owned AND upper(c.code) = 'SELF'
		UNION ALL
		SELECT format('tenant %s: clients %s collide on code "%s" once uppercased', c.tenant_id, string_agg(c.id::text, ', ' ORDER BY c.id), upper(c.code))
			FROM clients c
			WHERE NOT c.system_owned
			GROUP BY c.tenant_id, upper(c.code)
			HAVING count(*) > 1
		UNION ALL
		SELECT format('client %s (tenant %s): name is %s characters once trimmed (1-200 allowed)', c.id, c.tenant_id, char_length(btrim(c.name)))
			FROM clients c
			WHERE char_length(btrim(c.name)) NOT BETWEEN 1 AND 200
		UNION ALL
		SELECT DISTINCT format('catalog import run(s) of tenant %s: the tenant has no self client to backfill from', ci.tenant_id)
			FROM catalog_imports ci
			WHERE NOT EXISTS (
				SELECT 1 FROM clients c WHERE c.tenant_id = ci.tenant_id AND c.code = 'self' AND c.system_owned
			)
	) found;
	IF offenders IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0059 pre-flight failed: %', offenders;
	END IF;
END $$;--> statement-breakpoint

-- ── 2. normalise existing non-system codes to uppercase ───────────────────
UPDATE "clients" SET "code" = upper("code"), "updated_at" = now()
WHERE NOT "system_owned" AND "code" <> upper("code");--> statement-breakpoint

-- ── 3. the CHECKs (migration SQL only — drizzle-kit is blind to them) ─────
ALTER TABLE "clients" ADD CONSTRAINT "clients_code_format" CHECK (
  "code" ~ '^[A-Z0-9][A-Z0-9-]{1,31}$' OR "system_owned"
);--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_self_code_reserved" CHECK (
  ("code" <> 'SELF' AND "code" <> 'self') OR "system_owned"
);--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_name_length" CHECK (
  char_length(btrim("name")) BETWEEN 1 AND 200
);--> statement-breakpoint

-- ── 4. catalog_imports.client_id: add, backfill, assert, lock ─────────────
ALTER TABLE "catalog_imports" ADD COLUMN "client_id" uuid;--> statement-breakpoint
UPDATE "catalog_imports" ci SET "client_id" = c."id"
FROM "clients" c
WHERE c."tenant_id" = ci."tenant_id" AND c."code" = 'self' AND c."system_owned";--> statement-breakpoint
DO $$
DECLARE
	missing bigint;
BEGIN
	SELECT count(*) INTO missing FROM catalog_imports WHERE client_id IS NULL;
	IF missing > 0 THEN
		RAISE EXCEPTION 'migration 0059 post-assertion failed: % catalog import run(s) carry no client after the backfill', missing;
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "catalog_imports" ALTER COLUMN "client_id" SET NOT NULL;
