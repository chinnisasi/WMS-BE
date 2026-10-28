import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(120_000);

const MIGRATION = '0105_vendor_returns.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 2-8b — migration 0105 against a database standing at 0104 that
 * already holds DAMAGED stock (a warehouse, a system DAMAGED bin and its
 * on-hand), applied whole in one transaction as the real runner applies it:
 * the two tables exist with RLS on, the in-migration probes ran (a CHECK that
 * refused everything or nothing would have failed the transaction), nothing
 * existing was touched, and a re-run is refused by the fail-fast guard. Then
 * each named CHECK refuses its shape from outside the migration too.
 */
describe('migration 0105: the return-to-vendor tables', () => {
  const PRE_DB = 'wms_s_vendor_returns_premigration';
  let sql: ReturnType<typeof postgres>;
  let preUrl: string;
  let folder: string;
  const tenantId = uuidv7();
  const w = uuidv7();
  const zone = uuidv7();
  const bin = uuidv7();
  const skuId = uuidv7();

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
    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0105-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; when: number }[] };
    const mine = journal.entries.find((entry) => entry.idx === 105)!;
    // §3 — a renumbered migration is re-timed: its `when` is after every prior entry.
    expect(journal.entries.filter((entry) => entry.idx < 105).every((entry) => entry.when < mine.when)).toBe(true);
    journal.entries = journal.entries.filter((entry) => entry.idx <= 104);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    // ── the "before" state through the 0104 schema: DAMAGED holding stock ──
    await sql`insert into zones (id, tenant_id, warehouse_id, code, name) values (${zone}, ${tenantId}, ${w}, 'DAMAGED', 'Damaged')`;
    await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned) values
      (${bin}, ${tenantId}, ${w}, ${zone}, 'DAMAGED', 1000000000, 'staging', true)`;
    await sql`insert into stock_on_hand (id, tenant_id, warehouse_id, bin_id, sku_id, quantity) values (${uuidv7()}, ${tenantId}, ${w}, ${bin}, ${skuId}, 7000)`;
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

  it('applies in one transaction over a populated DAMAGED bin: both tables, RLS on, the existing stock untouched; a re-run is refused', async () => {
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) await tx.unsafe(statement);
    });
    const tables = (await sql`select relname, relrowsecurity from pg_class where relname in ('vendor_returns', 'vendor_return_lines') order by relname`) as unknown as {
      relname: string;
      relrowsecurity: boolean;
    }[];
    expect(tables).toEqual([
      { relname: 'vendor_return_lines', relrowsecurity: true },
      { relname: 'vendor_returns', relrowsecurity: true },
    ]);
    const policies = (await sql`select tablename from pg_policies where tablename in ('vendor_returns', 'vendor_return_lines') order by tablename`) as unknown as { tablename: string }[];
    expect(policies.map((row) => row.tablename)).toEqual(['vendor_return_lines', 'vendor_returns']);
    const stock = (await sql`select quantity::bigint as q from stock_on_hand where tenant_id = ${tenantId} and bin_id = ${bin}`) as unknown as { q: string }[];
    expect(Number(stock[0]!.q)).toBe(7000);
    // Every index is IF NOT EXISTS and present.
    const indexes = (await sql`select indexname from pg_indexes where tablename in ('vendor_returns', 'vendor_return_lines') order by indexname`) as unknown as { indexname: string }[];
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'vendor_return_lines_arm_unique',
        'vendor_return_lines_line_no_unique',
        'vendor_return_lines_tenant_grn_line_idx',
        'vendor_returns_tenant_client_created_at_id_idx',
        'vendor_returns_tenant_code_unique',
        'vendor_returns_tenant_created_at_id_idx',
        'vendor_returns_tenant_warehouse_status_idx',
      ]),
    );
    await expect(
      sql.begin(async (tx) => {
        for (const statement of migrationStatements()) await tx.unsafe(statement);
      }),
    ).rejects.toThrow(/migration 0105: vendor_returns already exists/);
  });

  it('each named CHECK refuses its shape from outside the migration; the accepted shapes insert', async () => {
    const u = uuidv7();
    const base = { tenant_id: tenantId, warehouse_id: w, client_id: uuidv7(), vendor_id: uuidv7(), consignee_address_kind: 'registered', vendor_snapshot: sql.json({}), client_snapshot: sql.json({}), created_by: u };
    const refusedBy = async (row: Record<string, unknown>): Promise<string | null> => {
      try {
        await sql.begin(async (tx) => {
          await tx`insert into vendor_returns ${tx({ id: uuidv7(), code: `RTV-${uuidv7()}`, ...base, ...row } as never)}`;
          throw new Error('accepted');
        });
        return null;
      } catch (err) {
        const constraint = (err as { constraint_name?: string }).constraint_name;
        if (constraint === undefined && (err as Error).message === 'accepted') return 'accepted';
        return constraint ?? (err as Error).message;
      }
    };
    expect(await refusedBy({ status: 'draft' })).toBe('accepted');
    expect(await refusedBy({ status: 'shipped' })).toBe('vendor_returns_status_check');
    expect(await refusedBy({ status: 'picked' })).toBe('vendor_returns_picked_pairing');
    expect(await refusedBy({ status: 'picked', picked_by: u, picked_at: new Date().toISOString(), picked_device_id: u })).toBe('accepted');
    expect(await refusedBy({ status: 'cancelled' })).toBe('vendor_returns_cancel_pairing');
    expect(await refusedBy({ status: 'cancelled', cancelled_by: u, cancelled_at: new Date().toISOString(), cancel_reason: 'x' })).toBe('accepted');
    expect(
      await refusedBy({
        status: 'dispatched',
        picked_by: u,
        picked_at: new Date().toISOString(),
        picked_device_id: u,
        dispatched_by: u,
        dispatched_at: new Date().toISOString(),
        brand_document_type: 'challan',
        brand_document_number: 'CH-1',
        brand_document_date: '2026-10-27',
        package_count: 1,
      }),
    ).toBe('vendor_returns_carrier_identity');
    expect(await refusedBy({ status: 'draft', tracking_ref: 'AWB' })).toBe('vendor_returns_dispatch_pairing');
  });
});
