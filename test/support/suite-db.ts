import postgres from 'postgres';

/**
 * infra-1: one database per e2e suite.
 *
 * The suites used to share a single database, so every suite's fixtures,
 * idempotency rows, advisory locks and connection budget were visible to
 * every other suite — the coupling behind an intermittent failure that moved
 * between suites and hid from instrumentation. Each suite now clones the
 * template built in `global-setup.js` and drops it afterwards.
 *
 * `useSuiteDatabase` MUST be the first statement in a suite's `beforeAll`:
 * it rewrites `DATABASE_URL`/`DATABASE_AUTH_URL`, and everything downstream
 * (`createApp`, the suite's own `postgres()` handles, the auth-probe URL the
 * suite derives) reads those.
 */
const TEMPLATE_DB = 'wms_template';

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function adminHandle(base: string) {
  return postgres(withDatabase(base, 'postgres'), { max: 1 });
}

export interface SuiteDatabase {
  readonly name: string;
  /** Drops the suite's database. Safe to call when creation failed. */
  drop(): Promise<void>;
}

/**
 * @param suite a short, stable slug — the database is `wms_s_<suite>`, which
 *   `global-setup.js` also uses to sweep leftovers from interrupted runs.
 */
export async function useSuiteDatabase(suite: string): Promise<SuiteDatabase> {
  process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
  const original = process.env.DATABASE_URL;
  if (!/^[a-z0-9_]+$/.test(suite)) {
    throw new Error(`suite slug must be [a-z0-9_]+, got "${suite}"`);
  }
  const name = `wms_s_${suite}`;

  const admin = adminHandle(original);
  try {
    await admin.unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}'`,
    );
    await admin.unsafe(`drop database if exists "${name}"`);
    await admin.unsafe(`create database "${name}" template ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  const suiteUrl = withDatabase(original, name);
  process.env.DATABASE_URL = suiteUrl;
  const authUrl = new URL(suiteUrl);
  authUrl.username = 'wms_auth_probe';
  authUrl.password = 'wms_auth_probe';
  process.env.DATABASE_AUTH_URL = authUrl.toString();

  return {
    name,
    async drop() {
      process.env.DATABASE_URL = original;
      delete process.env.DATABASE_AUTH_URL;
      const cleaner = adminHandle(original);
      try {
        await cleaner.unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}'`,
        );
        await cleaner.unsafe(`drop database if exists "${name}"`);
      } finally {
        await cleaner.end();
      }
    },
  };
}
