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
-- Run once per deployment as a superuser, then set:
--   DATABASE_URL=postgres://wms_app:<password>@<host>:<port>/<db>
--   DATABASE_AUTH_URL=postgres://wms_auth:<password>@<host>:<port>/<db>
--
-- Dev/CI may skip this: there DATABASE_URL is the superuser `wms` and
-- DATABASE_AUTH_URL falls back to it (a boot-time warning fires on fallback).
-- Replace BOTH 'change-me-*' passwords inside the DO block before use
-- (psql :variables are deliberately not used — CREATE ROLE passwords inside
-- dollar-quoted SQL cannot reference them).

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