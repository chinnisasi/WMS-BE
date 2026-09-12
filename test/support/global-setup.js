/**
 * infra-1: build the template database once per run.
 *
 * Every e2e suite used to share one database, which made every suite's
 * fixtures, idempotency rows, advisory locks and connection budget visible to
 * every other suite. Suites now each get their own database cloned from this
 * template, so migrations run ONCE here rather than 20+ times.
 */
const postgres = require('postgres');
const { execSync } = require('node:child_process');

const TEMPLATE_DB = 'wms_template';

function adminUrl(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

module.exports = async function globalSetup() {
  // Same default every suite sets at module load — globalSetup runs before
  // any suite module is evaluated, so it cannot rely on theirs.
  process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
  const base = process.env.DATABASE_URL;

  const admin = postgres(adminUrl(base, 'postgres'), { max: 1 });
  try {
    // Anything still connected from an interrupted run would block the drop.
    await admin.unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname like 'wms_s_%' or datname = '${TEMPLATE_DB}'`,
    );
    const stale = await admin.unsafe(
      `select datname from pg_database where datname like 'wms_s_%'`,
    );
    for (const row of stale) {
      await admin.unsafe(`drop database if exists "${row.datname}"`);
    }
    await admin.unsafe(`drop database if exists ${TEMPLATE_DB}`);
    await admin.unsafe(`create database ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  execSync('bun src/shared/db/migrate.ts', {
    env: { ...process.env, DATABASE_URL: adminUrl(base, TEMPLATE_DB) },
    stdio: 'pipe',
  });

  // The probe roles are CLUSTER-global (created once); their grants live
  // inside the template so every cloned database inherits them.
  const template = postgres(adminUrl(base, TEMPLATE_DB), { max: 1 });
  try {
    await template.unsafe(`
      do $$ begin
        if not exists (select from pg_roles where rolname = 'wms_auth_probe') then
          create role wms_auth_probe login password 'wms_auth_probe' nosuperuser bypassrls;
        end if;
        if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
          create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
        end if;
      end $$;
    `);
    await template.unsafe('grant usage on schema public to wms_auth_probe, wms_rls_probe');
    await template.unsafe(
      'grant select, insert, update, delete on all tables in schema public to wms_auth_probe, wms_rls_probe',
    );
  } finally {
    await template.end();
  }
};
