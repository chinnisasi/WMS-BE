-- Provisioning for the two-role design (docs/repos/wms-be/README.md):
--
--   wms_app   — the application role for DATABASE_URL. NOT superuser, so the
--               fail-closed RLS policies actually bind (the docker-compose
--               `wms` user is a superuser and bypasses RLS unconditionally).
--   wms_auth  — the auth-time role for DATABASE_AUTH_URL. NOT superuser but
--               BYPASSRLS: sign-in and the registration replay lookup run
--               before any tenant context exists (reads only; writes always
--               go through DATABASE).
--
-- Run as a superuser (on managed Postgres, the master user), then set:
--   DATABASE_URL=postgres://wms_app:<password>@<host>:<port>/<db>
--   DATABASE_AUTH_URL=postgres://wms_auth:<password>@<host>:<port>/<db>
--
-- Dev/CI may skip this: there DATABASE_URL is the superuser `wms` and
-- DATABASE_AUTH_URL falls back to it (a boot-time warning fires on fallback).
-- Replace BOTH 'change-me-*' passwords inside the DO block before use
-- (psql :variables are deliberately not used — CREATE ROLE passwords inside
-- dollar-quoted SQL cannot reference them).
--
-- Re-running is safe: existing roles are left alone and KEEP their passwords
-- (the 'change-me-*' values only apply when a role is created), and every
-- grant below is idempotent. An existing deployment provisioned before the
-- session-visibility fix needs only the one line:
--   grant pg_read_all_stats to wms_app;

do $$ begin
  if not exists (select from pg_roles where rolname = 'wms_app') then
    create role wms_app login password 'change-me-app' nosuperuser nobypassrls;
  end if;
  if not exists (select from pg_roles where rolname = 'wms_auth') then
    create role wms_auth login password 'change-me-auth' nosuperuser bypassrls;
  end if;
end $$;

-- BYPASSRLS bypasses policies but NOT grants: both roles still need table
-- privileges, and wms_app needs the sequences-free uuid path only.
grant usage on schema public to wms_app, wms_auth;
grant select, insert, update, delete on all tables in schema public to wms_app, wms_auth;
alter default privileges in schema public
  grant select, insert, update, delete on tables to wms_app, wms_auth;

-- Session visibility (IMPLEMENTATION-GUIDE §7d). The §7d probe
-- (src/shared/db/open-transactions.ts) proves "every transaction that began
-- before T has finished" from pg_stat_activity, for its two callers: the
-- async audit export claim (9-3b) and the storage snapshots (21-4). Without
-- this grant every wms_auth, operator or superuser session is hidden from
-- wms_app, and both jobs refuse (and log) on every tick. It is required:
-- one role for every connection is no substitute (a hidden autovacuum
-- worker still refuses). wms_auth needs nothing here. Re-run by the same
-- grantor it only raises a NOTICE. Side effect: wms_app can read every
-- session's query text (parameterized queries show $n placeholders; values
-- travel out of band). On PG16+ the grantor
-- needs ADMIN OPTION on pg_read_all_stats (a superuser, or a managed
-- Postgres's master user); verify with
--   select pg_has_role('wms_app', 'pg_read_all_stats', 'USAGE');
grant pg_read_all_stats to wms_app;

-- Story 6-2a — readiness (`GET /health/ready`) compares the database's
-- latest applied migration with the image's journal, reading drizzle's own
-- table as the app role. Run AFTER `db:migrate:deploy` (which creates the
-- schema); before it, the block is a no-op and the next run grants. Read-only:
-- the app role can never write the migrations table.
do $$ begin
  if exists (select from pg_namespace where nspname = 'drizzle') then
    grant usage on schema drizzle to wms_app;
    grant select on all tables in schema drizzle to wms_app;
  end if;
end $$;
