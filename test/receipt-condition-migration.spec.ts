import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { ensureDamagedBinInTx } from '../src/modules/tenancy/receiving-bin';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(120_000);

const MIGRATION = '0087_receipt_line_condition.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 2-4a, code review CR1 — migration 0087 against a database standing at
 * 0086 that already holds user locations coded `DAMAGED` (created before the
 * code was reserved): a zone, a live bin and a RETIRED bin (retire keeps the
 * unique key, codes cannot be renamed, zones cannot be retired — nothing in
 * the product could free the code). Applied whole in one transaction, as the
 * real runner applies it: each is re-coded to `DAMAGED-<id prefix>` with a
 * NOTICE naming it, and the system DAMAGED bin — what a damaged receipt
 * ensures before it books — then ensures cleanly in both warehouses.
 */
describe('migration 0087: pre-rule DAMAGED locations are re-coded', () => {
  const PRE_DB = 'wms_s_receipt_condition_premigration';
  let sql: ReturnType<typeof postgres>;
  let preUrl: string;
  let folder: string;
  const notices: string[] = [];

  const tenantId = uuidv7();
  const w1 = uuidv7();
  const w2 = uuidv7();
  const userZone = uuidv7(); // W1: a user zone coded DAMAGED holding a user bin coded DAMAGED
  const userBin = uuidv7();
  const zoneW2 = uuidv7();
  const retiredBin = uuidv7(); // W2: a retired user bin coded DAMAGED
  const actor = uuidv7();

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

    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0087-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 86);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: (notice) => void notices.push(String(notice.message)) });
    // ── the "before" state, through the 0086 schema ─────────────────────────
    await sql`insert into zones (id, tenant_id, warehouse_id, code, name) values
      (${userZone}, ${tenantId}, ${w1}, 'DAMAGED', 'Our damaged'),
      (${zoneW2}, ${tenantId}, ${w2}, 'A', 'Aisle A')`;
    await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned) values
      (${userBin}, ${tenantId}, ${w1}, ${userZone}, 'DAMAGED', 10000, 'shelf', false)`;
    await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned, retired_at, retired_by) values
      (${retiredBin}, ${tenantId}, ${w2}, ${zoneW2}, 'DAMAGED', 10000, 'shelf', false, now(), ${actor})`;
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

  it('re-codes every user zone and bin (retired included) to DAMAGED-<id prefix>, naming each; the system bin then ensures', async () => {
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) await tx.unsafe(statement);
    });
    const zones = (await sql`select id, code from zones where tenant_id = ${tenantId} order by code`) as unknown as { id: string; code: string }[];
    expect(zones).toEqual(
      expect.arrayContaining([
        { id: userZone, code: `DAMAGED-${userZone.slice(0, 8)}` },
        { id: zoneW2, code: 'A' },
      ]),
    );
    const bins = (await sql`select id, code from bins where tenant_id = ${tenantId} order by id`) as unknown as { id: string; code: string }[];
    expect(bins).toEqual(
      expect.arrayContaining([
        { id: userBin, code: `DAMAGED-${userBin.slice(0, 8)}` },
        { id: retiredBin, code: `DAMAGED-${retiredBin.slice(0, 8)}` },
      ]),
    );
    for (const [warehouse, id, newCode] of [
      [w1, userZone, `DAMAGED-${userZone.slice(0, 8)}`],
      [w1, userBin, `DAMAGED-${userBin.slice(0, 8)}`],
      [w2, retiredBin, `DAMAGED-${retiredBin.slice(0, 8)}`],
    ] as const) {
      expect(notices.some((notice) => notice.includes(warehouse) && notice.includes(id) && notice.includes(`DAMAGED → ${newCode}`))).toBe(true);
    }

    // What a damaged receipt ensures before it books: the system DAMAGED
    // bin, now free of the collision in both warehouses (409 before 0087).
    const db = createDatabase(preUrl);
    try {
      for (const warehouseId of [w1, w2]) {
        const ensured = await withTenantTransaction(db, tenantId, (tx) => ensureDamagedBinInTx(tx, tenantId, warehouseId));
        const row = (await sql`select code, system_owned from bins where id = ${ensured.binId}`) as unknown as { code: string; system_owned: boolean }[];
        expect(row[0]).toEqual({ code: 'DAMAGED', system_owned: true });
      }
    } finally {
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    }
  });
});
