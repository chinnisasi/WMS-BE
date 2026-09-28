-- Story 21-2 — client isolation RLS (AD-24): the second fail-closed RLS
-- session variable `app.client_id`. The client dimension landed in 0040 but
-- nothing enforced it at the database: a portal session for client A could
-- still read client B's rows, because every policy keyed on `app.tenant_id`
-- alone (AD-3 scopes tenant + warehouse only). This migration recreates the
-- four stamped tables' `*_tenant_isolation` policies with a null-tolerant
-- client clause, and — the human decision recorded in the spec — extends the
-- same clause to `clients_tenant_isolation`, so a portal session sees only
-- its own client row.
--
-- THE PREDICATE (the ratified AD-24 shape, identical on every policy):
--
--   USING ( tenant arm
--           AND ( NULLIF(current_setting('app.client_id', true), '') IS NULL
--                 OR <client column> = NULLIF(current_setting('app.client_id', true), '')::uuid ) )
--
-- NULL-tolerant, not bare equality: unset = the OPERATOR shape (sees the
-- whole tenant — cross-client waves and every existing operator flow keep
-- working); set-but-wrong binds to NOTHING (a portal session that stamps a
-- foreign client id sees zero rows — fail closed). The NULLIF-empty guard is
-- load-bearing (PG18 returns '' for an expired transaction-local setting);
-- without it an expired client scope would error, not filter.
--
-- WITH CHECK carries the IDENTICAL arm (the repo convention): a portal
-- session cannot WRITE a row its session cannot read. Inherited tables
-- (stock_on_hand, batch_on_hand, …) get NO clause — they carry no client_id
-- and ride the SKU join, which the skus policy now filters; `db:generate`
-- stays blind to all of it (RLS is migration-SQL-only).
--
-- Operator sessions are unchanged end to end: `withTenantTransaction` leaves
-- `app.client_id` untouched unless the caller opts in (21-7's portal is the
-- first consumer).
--
-- Proven at the DATABASE by `test/client-isolation.spec.ts` — the
-- `wms_rls_probe` non-superuser role, advisory key 742105: a portal-shaped
-- session sees its own rows and zero of the sibling client's, a foreign
-- client write is refused 42501, an operator-shaped session still sees both
-- clients, and an unscoped session sees zero. CAP-2: a database-level probe,
-- not only an API test.

-- ── 0. the fail-fast guard ────────────────────────────────────────────────
-- The policies below reference the client binding column on the four stamped
-- tables AND on `clients` (which binds on `id`, not a client_id column); the
-- clause is only meaningful on top of migration 0040's client dimension. A
-- database that skipped 0040 must refuse here, naming every missing table,
-- rather than fail mid-migration on the first policy that names a column
-- that does not exist.
DO $$
DECLARE
	missing text;
BEGIN
	SELECT string_agg(table_name || ' (missing ' || binding_column || ')', ', ' ORDER BY table_name)
	INTO missing
	FROM (
		SELECT t AS table_name, col AS binding_column
		FROM (VALUES
			('skus', 'client_id'),
			('orders', 'client_id'),
			('purchase_orders', 'client_id'),
			('ledger_events', 'client_id'),
			('clients', 'id')
		) AS stamped(t, col)
		WHERE NOT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public'
				AND table_name = stamped.t
				AND column_name = stamped.col
		)
	) gaps;
	IF missing IS NOT NULL THEN
		RAISE EXCEPTION 'migration 0041 requires the client dimension (0040) to be applied first: tables missing their client binding column (%)', missing;
	END IF;
END $$;--> statement-breakpoint

-- ── 1. the four stamped tables: recreate with the client clause ───────────
-- DROP + CREATE (not ALTER POLICY / CREATE OR REPLACE): the repo's
-- migration-idiom minimalism, reading identically to 0004/0006/0011/0017's
-- policy blocks. USING and WITH CHECK are byte-identical arms.

DROP POLICY "skus_tenant_isolation" ON "skus";--> statement-breakpoint
CREATE POLICY "skus_tenant_isolation" ON "skus"
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
DROP POLICY "ledger_events_tenant_isolation" ON "ledger_events";--> statement-breakpoint
CREATE POLICY "ledger_events_tenant_isolation" ON "ledger_events"
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

DROP POLICY "purchase_orders_tenant_isolation" ON "purchase_orders";--> statement-breakpoint
CREATE POLICY "purchase_orders_tenant_isolation" ON "purchase_orders"
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

DROP POLICY "orders_tenant_isolation" ON "orders";--> statement-breakpoint
CREATE POLICY "orders_tenant_isolation" ON "orders"
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

-- ── 2. the clients table: the decided clause (Option A) ───────────────────
-- The human decision (spec, 2026-09-28): the client clause binds on `id` —
-- a portal session sees only ITS OWN client row, an operator session sees
-- all of the tenant's. Replaces 0040's tenant-only predicate wholesale
-- (not an additional policy — one policy per table, the RLS-SCOPE note in
-- 0040's header resolved).
DROP POLICY "clients_tenant_isolation" ON "clients";--> statement-breakpoint
CREATE POLICY "clients_tenant_isolation" ON "clients"
	USING (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR "id" = NULLIF(current_setting('app.client_id', true), '')::uuid
		)
	)
	WITH CHECK (
		"tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		AND (
			NULLIF(current_setting('app.client_id', true), '') IS NULL
			OR "id" = NULLIF(current_setting('app.client_id', true), '')::uuid
		)
	);
