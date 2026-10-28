import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { COUNT_TASK_STATUSES, STOCK_TAKE_STATUSES } from '../src/shared/db/schema';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(120_000);

/**
 * Story 3-5b — migration 0107 (`stock_takes`, `stock_freeze_bins`, the
 * count_tasks columns and the widened status CHECK). The migration's own DO
 * block probes every CHECK at apply time (accepted shapes rolled back, each
 * refused shape by its named constraint); this suite pins what that block
 * cannot: the two count_tasks CHECKs stay NOT VALID (a VALID add would scan
 * the table under ACCESS EXCLUSIVE), the TS tuples equal the CHECK literals,
 * the RLS policies exist, and a re-run is refused by the fail-fast guard.
 */
describe('migration 0107: stock take with freeze', () => {
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('stock_take_migration');
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
  });

  afterAll(async () => {
    await sql?.end();
    await suiteDb.drop();
  });

  async function checkOf(table: string, name: string): Promise<{ def: string; validated: boolean }> {
    const rows = (await sql`
      select pg_get_constraintdef(c.oid) as def, c.convalidated as validated
        from pg_constraint c where c.conrelid = ${table}::regclass and c.conname = ${name}`) as unknown as { def: string; validated: boolean }[];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  function literals(def: string): string[] {
    return [...def.matchAll(/'([^']+)'::text/g)].map((match) => match[1]!);
  }

  it('count_tasks: the status CHECK admits cancelled and the pairing CHECK exists — both NOT VALID', async () => {
    const status = await checkOf('count_tasks', 'count_tasks_status_check');
    expect(status.validated).toBe(false);
    expect(literals(status.def)).toEqual([...COUNT_TASK_STATUSES]);
    const pairing = await checkOf('count_tasks', 'count_tasks_cancelled_pairing');
    expect(pairing.validated).toBe(false);
    expect(pairing.def).toContain('cancelled_at IS NOT NULL');
  });

  it('stock_takes: the status CHECK is the TS tuple (IS NOT NULL first), validated', async () => {
    const status = await checkOf('stock_takes', 'stock_takes_status_check');
    expect(status.validated).toBe(true);
    expect(status.def).toContain('IS NOT NULL');
    expect(literals(status.def)).toEqual([...STOCK_TAKE_STATUSES]);
  });

  it('refuses a cancelled task without cancelled_at, and a pending one with it (the pairing)', async () => {
    const t = uuidv7();
    for (const [status, cancelledAt] of [
      ['cancelled', null],
      ['pending', new Date().toISOString()],
    ] as const) {
      const refused = await sql`
        insert into count_tasks (id, tenant_id, warehouse_id, bin_id, status, origin, cancelled_at)
        values (${uuidv7()}, ${t}, ${uuidv7()}, ${uuidv7()}, ${status}, 'on_demand', ${cancelledAt})`.catch((err: { constraint_name?: string }) => err.constraint_name);
      expect(refused).toBe('count_tasks_cancelled_pairing');
    }
  });

  it('stock_takes: the lifecycle pairing admits each status with exactly its stamps and refuses the rest', async () => {
    const t = uuidv7();
    const insert = (status: string, cols: Record<string, unknown>) =>
      sql`insert into stock_takes ${sql({ id: uuidv7(), tenant_id: t, warehouse_id: uuidv7(), status, bin_count: 1, started_by: t, started_at: new Date(), ...cols })}`
        .then(() => 'ok')
        .catch((err: { constraint_name?: string }) => err.constraint_name ?? 'other');
    const now = new Date();
    expect(await insert('counting', {})).toBe('ok');
    expect(await insert('posting', { approved_by: t, approved_at: now })).toBe('ok');
    expect(await insert('closed', { approved_by: t, approved_at: now, closed_by: t, closed_at: now, posted_count: 1, unposted_count: 0 })).toBe('ok');
    expect(await insert('abandoned', { abandoned_by: t, abandoned_at: now })).toBe('ok');
    expect(await insert('closed', { approved_by: t, approved_at: now })).toBe('stock_takes_lifecycle_pairing');
    expect(await insert('counting', { approved_by: t, approved_at: now })).toBe('stock_takes_lifecycle_pairing');
    expect(await insert('abandoned', {})).toBe('stock_takes_lifecycle_pairing');
    expect(await insert('posting', { approved_by: t })).toBe('stock_takes_lifecycle_pairing');
    await sql`delete from stock_takes where tenant_id = ${t}`;
  });

  it('both new tables carry the fail-closed tenant RLS policy', async () => {
    const rows = (await sql`
      select tablename, policyname, qual from pg_policies where tablename in ('stock_takes', 'stock_freeze_bins') order by tablename`) as unknown as {
      tablename: string;
      policyname: string;
      qual: string;
    }[];
    expect(rows.map((row) => row.policyname)).toEqual(['stock_freeze_bins_tenant_isolation', 'stock_takes_tenant_isolation']);
    for (const row of rows) expect(row.qual).toContain("NULLIF(current_setting('app.tenant_id'::text, true), ''::text)");
    const rls = (await sql`select relname, relrowsecurity from pg_class where relname in ('stock_takes', 'stock_freeze_bins')`) as unknown as { relrowsecurity: boolean }[];
    expect(rls.every((row) => row.relrowsecurity)).toBe(true);
  });

  it('a re-run is refused by the fail-fast guard', async () => {
    const guard = readFileSync(resolve(process.cwd(), 'drizzle', '0107_stock_take_freeze.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .find((statement) => statement.includes('this migration has already been applied'))!;
    await expect(sql.unsafe(guard)).rejects.toThrow(/migration 0107: .* already been applied/);
  });
});
