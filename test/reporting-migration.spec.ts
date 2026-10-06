import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';
import { PACK_FAILURE_ENTRIES } from '../src/shared/db/schema';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(120_000);

const MIGRATION = '0058_reporting_facts.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 9-1 — migration 0058 against a database that stands exactly at
 * 0057 (the repo's own migrations, journal trimmed — the fractional-quantity
 * harness), applied WHOLE inside one transaction as the real runner applies
 * it. Every other suite starts from a template already migrated, so this is
 * the only place 0058's guard and its one data statement (the
 * `reporting_facts_since` stamp) are proven to run.
 */
describe('migration 0058: the reporting facts', () => {
  const PRE_DB = 'wms_s_reporting_premigration';
  let preUrl: string;
  let sql: ReturnType<typeof postgres>;
  let folder: string;
  let appliedAt: number;

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL!;
    const url = new URL(baseUrl);
    url.pathname = `/${PRE_DB}`;
    preUrl = url.toString();
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
      await admin.unsafe(`drop database if exists "${PRE_DB}"`);
      await admin.unsafe(`create database "${PRE_DB}"`);
    } finally {
      await admin.end();
    }

    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0058-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 57);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    // The scratch database really stands at 0057: the fact tables are absent.
    expect(await sql`select to_regclass('public.pack_verification_failures') as t`).toEqual([{ t: null }]);

    appliedAt = Date.now();
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) {
        await tx.unsafe(statement);
      }
    });
  });

  afterAll(async () => {
    await sql?.end();
    rmSync(folder, { recursive: true, force: true });
    const adminUrl = new URL(process.env.DATABASE_URL!);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
      await admin.unsafe(`drop database if exists "${PRE_DB}"`);
    } finally {
      await admin.end();
    }
  });

  it('stamps app_metadata.reporting_facts_since with the instant it ran (a JSON timestamp string)', async () => {
    const rows = (await sql`select value from app_metadata where key = 'reporting_facts_since'`) as unknown as { value: unknown }[];
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]!.value).toBe('string');
    const stamped = Date.parse(rows[0]!.value as string);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(Math.abs(stamped - appliedAt)).toBeLessThan(60_000);
  });

  it('enables fail-closed RLS with one tenant policy on each fact table', async () => {
    const tables = (await sql`
      select relname, relrowsecurity from pg_class
      where relname in ('pack_verification_failures', 'ingest_backorder_refusals') order by relname`) as unknown as {
      relname: string;
      relrowsecurity: boolean;
    }[];
    expect(tables).toEqual([
      { relname: 'ingest_backorder_refusals', relrowsecurity: true },
      { relname: 'pack_verification_failures', relrowsecurity: true },
    ]);
    const policies = (await sql`
      select tablename, qual from pg_policies
      where tablename in ('pack_verification_failures', 'ingest_backorder_refusals') order by tablename`) as unknown as {
      tablename: string;
      qual: string;
    }[];
    expect(policies.map((p) => p.tablename)).toEqual(['ingest_backorder_refusals', 'pack_verification_failures']);
    for (const policy of policies) expect(policy.qual).toContain("NULLIF(current_setting('app.tenant_id'");
  });

  it('dedupes refusals on (tenant, integration, external event) and pins the entry vocabulary', async () => {
    const tenantId = uuidv7();
    const integrationId = uuidv7();
    const insert = () => sql`
      insert into ingest_backorder_refusals (id, tenant_id, warehouse_id, integration_id, external_event_id, lines)
      values (${uuidv7()}, ${tenantId}, ${uuidv7()}, ${integrationId}, 'EVT-1', '[]'::jsonb)`;
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
    await sql`
      insert into pack_verification_failures (id, tenant_id, warehouse_id, order_id, entry, actor_user_id, mismatch)
      values (${uuidv7()}, ${tenantId}, ${uuidv7()}, ${uuidv7()}, 'sync', ${uuidv7()}, '[]'::jsonb)`;
    await expect(sql`
      insert into pack_verification_failures (id, tenant_id, warehouse_id, order_id, entry, actor_user_id, mismatch)
      values (${uuidv7()}, ${tenantId}, ${uuidv7()}, ${uuidv7()}, 'carrier-pigeon', ${uuidv7()}, '[]'::jsonb)`).rejects.toMatchObject({
      code: '23514',
    });
    // A retried failed pack (same key) is one row; keyless rows never collide.
    const failure = (key: string | null) => sql`
      insert into pack_verification_failures (id, tenant_id, warehouse_id, order_id, entry, actor_user_id, mismatch, idempotency_key)
      values (${uuidv7()}, ${tenantId}, ${uuidv7()}, ${uuidv7()}, 'tenant', ${uuidv7()}, '[]'::jsonb, ${key})`;
    await failure('01KEYAAAAAAAAAAAAAAAAAAAAA');
    await expect(failure('01KEYAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({ code: '23505' });
    await failure(null);
    await failure(null);
    const def = (await sql`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'pack_verification_failures_entry_check'`) as unknown as {
      def: string;
    }[];
    expect([...def[0]!.def.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()).toEqual([...PACK_FAILURE_ENTRIES].sort());
  });

  it('builds the ledger (tenant, warehouse, type, recorded_at) index', async () => {
    const rows = (await sql`
      select indexdef from pg_indexes where indexname = 'ledger_events_tenant_warehouse_type_recorded_at_idx'`) as unknown as {
      indexdef: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain('(tenant_id, warehouse_id, type, recorded_at)');
  });

  it('the fail-fast guard refuses a second application, and nothing half-lands', async () => {
    await expect(
      sql.begin(async (tx) => {
        for (const statement of migrationStatements()) {
          await tx.unsafe(statement);
        }
      }),
    ).rejects.toThrow(/migration 0058 has already been applied/);
    const stamps = await sql`select count(*)::int as n from app_metadata where key = 'reporting_facts_since'`;
    expect(stamps).toEqual([{ n: 1 }]);
  });
});
