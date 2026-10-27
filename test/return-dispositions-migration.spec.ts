import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(180_000);

const MIGRATION = '0097_return_dispositions.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 4-7a — migration 0097 against a POPULATED database standing exactly
 * at 0096 (the repo's own migrations, journal trimmed — the 0079 harness),
 * applied whole inside one transaction as the real runner applies it.
 * Every other suite starts from a template migrated with no returns in it, so
 * this is the only place the backfill (`open_qty = qty`, A1) and its proof
 * run against 13-2-era receipt lines — and the pre-flight's refusal of an
 * unknown QC hold kind.
 */
describe('migration 0097: returns disposition', () => {
  const PRE_DB = 'wms_s_return_dispositions_premigration';
  let sql: ReturnType<typeof postgres>;
  let folder: string;

  const tenantId = uuidv7();
  const lines = [
    { id: uuidv7(), qty: 2500, condition: 'resaleable', serial: null as string | null },
    { id: uuidv7(), qty: 1000, condition: 'damaged', serial: uuidv7() },
    { id: uuidv7(), qty: 7000, condition: 'opened', serial: null as string | null },
  ];

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL!;
    const url = new URL(baseUrl);
    url.pathname = `/${PRE_DB}`;
    const preUrl = url.toString();
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

    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0097-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 96);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    expect(await sql`select to_regclass('public.return_dispositions') as t`).toEqual([{ t: null }]);

    // ── the "before" state: 13-2-era receipt lines and QC holds ─────────────
    for (const [i, line] of lines.entries()) {
      await sql`insert into return_receipt_lines (id, tenant_id, return_receipt_id, rma_line_id, sku_id, line_no, qty, condition, serial_id, ledger_event_id)
        values (${line.id}, ${tenantId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${i + 1}, ${line.qty}, ${line.condition}, ${line.serial}, ${uuidv7()})`;
    }
    await sql`insert into qc_holds (id, tenant_id, warehouse_id, sku_id, bin_id, reason, status, held_by, held_at, kind)
      values (${uuidv7()}, ${tenantId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 'pre-0097 manual', 'open', ${uuidv7()}, now(), 'manual')`;
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

  it('the pre-flight refuses an unknown QC hold kind, naming it — and rolls back whole', async () => {
    const odd = uuidv7();
    // The 0078 CHECK refuses an unknown kind, so drop it for the probe (a hand-edited database).
    await sql`alter table qc_holds drop constraint qc_holds_kind_check`;
    await sql`insert into qc_holds (id, tenant_id, warehouse_id, sku_id, bin_id, reason, status, held_by, held_at, kind)
      values (${odd}, ${tenantId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 'odd', 'open', ${uuidv7()}, now(), 'legacy')`;
    try {
      await expect(
        sql.begin(async (tx) => {
          for (const statement of migrationStatements()) await tx.unsafe(statement);
        }),
      ).rejects.toThrow(new RegExp(odd));
      expect(await sql`select to_regclass('public.return_dispositions') as t`).toEqual([{ t: null }]);
    } finally {
      await sql`delete from qc_holds where id = ${odd}`;
      await sql`alter table qc_holds add constraint qc_holds_kind_check check (kind in ('manual', 'receipt'))`;
    }
  });

  it('applies over 13-2-era lines: every line backfilled open_qty = qty; the new CHECK, indexes and policies exist; a re-run fails fast', async () => {
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) await tx.unsafe(statement);
    });
    const rows = (await sql`select id, qty::bigint as qty, open_qty::bigint as open from return_receipt_lines where tenant_id = ${tenantId} order by line_no`) as unknown as {
      id: string;
      qty: string;
      open: string;
    }[];
    expect(rows.map((row) => [row.id, Number(row.open)])).toEqual(lines.map((line) => [line.id, line.qty]));
    // The CHECK holds over the backfilled rows and refuses an overdraw.
    await expect(sql`update return_receipt_lines set open_qty = qty + 1 where id = ${lines[0]!.id}`).rejects.toThrow(/return_receipt_lines_open_qty_range/);
    await expect(sql`update return_receipt_lines set open_qty = -1 where id = ${lines[0]!.id}`).rejects.toThrow(/return_receipt_lines_open_qty_range/);
    const indexes = (await sql`select indexname from pg_indexes where tablename in ('return_receipt_lines', 'return_dispositions', 'return_hold_settlements') order by indexname`) as unknown as {
      indexname: string;
    }[];
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'return_receipt_lines_tenant_open_idx',
        'return_receipt_lines_tenant_sku_batch_open_idx',
        'return_receipt_lines_tenant_serial_idx',
        'return_dispositions_tenant_line_serial_unique',
        'return_hold_settlements_tenant_hold_unique',
      ]),
    );
    const policies = (await sql`select policyname from pg_policies where tablename in ('return_dispositions', 'return_hold_settlements') order by policyname`) as unknown as {
      policyname: string;
    }[];
    expect(policies.map((row) => row.policyname)).toEqual(['return_dispositions_tenant_isolation', 'return_hold_settlements_tenant_isolation']);
    // The pre-existing manual hold survives the kind CHECK's re-add; a return hold is admitted.
    expect(await sql`select count(*)::int as n from qc_holds where tenant_id = ${tenantId} and kind = 'manual'`).toEqual([{ n: 1 }]);
    // Fail-fast on a second run (nothing transformed twice).
    await expect(
      sql.begin(async (tx) => {
        for (const statement of migrationStatements()) await tx.unsafe(statement);
      }),
    ).rejects.toThrow(/already been applied/);
  });
});
