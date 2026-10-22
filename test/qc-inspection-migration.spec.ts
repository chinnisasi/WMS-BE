import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(120_000);

const MIGRATION = '0091_qc_inspection.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 2-8a — migration 0091 against a database standing at 0090 that
 * already holds QC holds (an open manual hold, a released one and an open
 * receipt hold). Applied whole in one transaction, as the real runner applies
 * it: its own probes pass (they run inside it), every existing row is
 * byte-for-byte untouched, and the widened CHECKs admit an `inspected` close
 * of an existing open row. A second application refuses (the fail-fast guard).
 */
describe('migration 0091: the QC inspection outcome over existing holds', () => {
  const PRE_DB = 'wms_s_qc_inspection_premigration';
  let sql: ReturnType<typeof postgres>;
  let preUrl: string;
  let folder: string;

  const tenantId = uuidv7();
  const wh = uuidv7();
  const actor = uuidv7();
  const openManual = uuidv7();
  const released = uuidv7();
  const openReceipt = uuidv7();

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

    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0091-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 90);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    // ── the "before" state, through the 0090 schema ─────────────────────────
    await sql`insert into qc_holds (id, tenant_id, warehouse_id, sku_id, bin_id, reason, status, held_by, held_at) values
      (${openManual}, ${tenantId}, ${wh}, ${uuidv7()}, ${uuidv7()}, 'open manual', 'open', ${actor}, '2026-10-01T10:00:00Z')`;
    await sql`insert into qc_holds (id, tenant_id, warehouse_id, sku_id, bin_id, reason, status, held_by, held_at, released_by, released_at) values
      (${released}, ${tenantId}, ${wh}, ${uuidv7()}, ${uuidv7()}, 'released manual', 'released', ${actor}, '2026-10-01T10:00:00Z', ${actor}, '2026-10-02T10:00:00Z')`;
    await sql`insert into qc_holds (id, tenant_id, warehouse_id, sku_id, bin_id, reason, status, held_by, held_at, kind, grn_line_id) values
      (${openReceipt}, ${tenantId}, ${wh}, ${uuidv7()}, ${uuidv7()}, 'QC on receipt', 'open', ${actor}, '2026-10-03T10:00:00Z', 'receipt', ${uuidv7()})`;
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

  it('applies over open and released rows (its probes pass inside it), leaves them untouched, then admits an inspected close', async () => {
    const snapshot = async () => sql`select * from qc_holds where tenant_id = ${tenantId} order by id`;
    const before = await snapshot();
    expect(before).toHaveLength(3);
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) await tx.unsafe(statement);
    });
    expect(await snapshot()).toEqual(before);
    expect(await sql`select 1 from qc_inspections`).toHaveLength(0);
    // The widened vocabulary and pairing: an existing open hold closes inspected.
    await sql`update qc_holds set status = 'inspected', released_by = ${actor}, released_at = now() where id = ${openManual}`;
    await expect(sql`update qc_holds set status = 'inspected' where id = ${openReceipt}`).rejects.toThrow(/qc_holds_release_pairing/);
    // The fail-fast guard: a second application refuses before touching anything.
    await expect(
      sql.begin(async (tx) => {
        for (const statement of migrationStatements()) await tx.unsafe(statement);
      }),
    ).rejects.toThrow(/already been applied/);
  });
});
