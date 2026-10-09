-- ── hand-written: story 21-7, the client-portal persona ───────────────────
-- A portal user is a FIFTH role, `client`, paired with `users.client_id` by a
-- CHECK: a user carries a client exactly when its role is `client`
-- (decision 1, 2026-10-09). The role holds no capabilities.
--
-- THE MIGRATOR APPLIES EVERY PENDING MIGRATION IN ONE TRANSACTION
-- (drizzle-orm/pg-core/dialect.js — one `session.transaction` around the
-- whole pending set), and Postgres refuses to USE an enum value inside the
-- transaction that added it (55P04 "unsafe use of new value"). So nothing in
-- this file — and nothing in any migration that might ever be applied in the
-- same run — may resolve 'client' as a `user_role`: the CHECK compares
-- `role::text`, and the probes below never write a `client` role. The
-- `client`-without-`client_id` direction is proved in jest
-- (test/portal.spec.ts), where the value has long been committed.
--
-- drizzle-kit is blind to the CHECK; the enum value is mirrored in
-- `schema.ts` (`userRoleEnum`). The journal entry and snapshot are git-added
-- with this file; `bun run db:generate` afterwards reports "No schema changes".

-- ── 0. the fail-fast guard ────────────────────────────────────────────────
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'users_client_role_pairing'
	) THEN
		RAISE EXCEPTION 'migration 0065 has already been applied: users_client_role_pairing already exists.';
	END IF;
END $$;--> statement-breakpoint
-- ── 1. pre-flight ────────────────────────────────────────────────────────
-- Before this migration no role could pair with a client, so EVERY user row
-- carrying a client_id would violate the new CHECK. Name the count at once
-- (an operator fixes them in one pass), rather than failing on the ADD.
DO $$
DECLARE
	n bigint;
BEGIN
	SELECT count(*) INTO n FROM "users" WHERE "client_id" IS NOT NULL;
	IF n <> 0 THEN
		RAISE EXCEPTION 'migration 0065: % users row(s) carry a client_id but no role can pair with one yet — clear users.client_id on them (a client-portal user is invited after this migration) and re-run.', n;
	END IF;
END $$;--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'client';--> statement-breakpoint
-- ── 2. the pairing CHECK ──────────────────────────────────────────────────
-- `role::text`, never `role = 'client'`: the latter resolves the new enum
-- value inside this transaction (55P04). Both sides are non-null booleans
-- (`role` is NOT NULL), so the equality never reads NULL-as-pass.
ALTER TABLE "users" ADD CONSTRAINT "users_client_role_pairing"
	CHECK (("role"::text = 'client') = ("client_id" IS NOT NULL));--> statement-breakpoint
-- ── 3. the post-migration assertion ───────────────────────────────────────
-- One DO block per probe, each catching `check_violation` (the 0064
-- precedent) ON THE NAMED CONSTRAINT. The refused shape: an `operator`
-- carrying a client_id. The accepted shape (an operator with no client) is
-- inserted first and rolled back by a sentinel, so a CHECK that refuses
-- everything cannot pass either.
DO $$
DECLARE
	t uuid := gen_random_uuid();
BEGIN
	BEGIN
		INSERT INTO "users" ("id","tenant_id","email","password_hash","role","status","client_id")
		VALUES (gen_random_uuid(), t, 'probe-0065-accepted-' || t::text || '@probe.invalid', 'x', 'operator', 'active', NULL);
		RAISE EXCEPTION USING ERRCODE = 'P0065', MESSAGE = 'sentinel';
	EXCEPTION
		WHEN check_violation THEN
			RAISE EXCEPTION 'migration 0065: an operator with no client was refused — users_client_role_pairing refuses the accepted shape.';
		WHEN SQLSTATE 'P0065' THEN
			NULL; -- the accepted shape landed, and the sentinel rolled it back
	END;
END $$;--> statement-breakpoint
DO $$
DECLARE
	t uuid := gen_random_uuid();
	refused_by text;
BEGIN
	BEGIN
		INSERT INTO "users" ("id","tenant_id","email","password_hash","role","status","client_id")
		VALUES (gen_random_uuid(), t, 'probe-0065-refused-' || t::text || '@probe.invalid', 'x', 'operator', 'active', gen_random_uuid());
	EXCEPTION WHEN check_violation THEN
		GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
	END;
	IF refused_by IS NULL THEN
		RAISE EXCEPTION 'migration 0065: an operator carrying a client_id was ADMITTED — users_client_role_pairing does not hold.';
	END IF;
	IF refused_by <> 'users_client_role_pairing' THEN
		RAISE EXCEPTION 'migration 0065: the operator-with-client probe was refused by % — expected users_client_role_pairing.', refused_by;
	END IF;
	IF EXISTS (SELECT 1 FROM "users" WHERE "tenant_id" = t) THEN
		RAISE EXCEPTION 'migration 0065: a CHECK probe row survived.';
	END IF;
END $$;
