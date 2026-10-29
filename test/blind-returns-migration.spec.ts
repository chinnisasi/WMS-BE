import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';
import {
  AUTHORIZABLE_REASON_CODES,
  BLIND_MATCH_KINDS,
  BLIND_REJECT_REASONS,
  RETURN_REASON_CODES,
  RMA_ORIGINS,
  RMA_REVIEW_STATUSES,
} from '../src/modules/returns/return-authorization.command';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(180_000);

const MIGRATION = '0112_blind_returns.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 4-7b — migration 0112 against a POPULATED database standing exactly
 * at 0111 (the repo's own migrations, journal trimmed — the 0097 harness),
 * applied whole inside one transaction as the real runner applies it. Every
 * other suite starts from a template migrated with no RMAs in it, so this is
 * the only place the proof block runs against 13-1 / 13-2 / 4-7a-era rows
 * (an authorized RMA, its line, its receipt line with `open_qty`), and the
 * fail-fast's refusal of a database without 4-7a.
 */
describe('migration 0112: blind returns', () => {
  const PRE_DB = 'wms_s_blind_returns_premigration';
  let sql: ReturnType<typeof postgres>;
  let folder: string;

  const tenantId = uuidv7();
  const rmaIds = [uuidv7(), uuidv7()];
  const lineIds = [uuidv7(), uuidv7(), uuidv7()];

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

    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0112-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 111);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    expect(await sql`select count(*)::int as n from information_schema.columns where table_name = 'return_authorizations' and column_name = 'origin'`).toEqual([{ n: 0 }]);

    // ── the "before" state: authorized RMAs (open and received), their lines, a receipt line ─
    for (const [i, id] of rmaIds.entries()) {
      await sql`insert into return_authorizations (id, tenant_id, client_id, warehouse_id, order_id, code, status, order_dispatched_at, created_by)
        values (${id}, ${tenantId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${`RMA-000${i + 1}`}, ${i === 0 ? 'open' : 'received'}, now(), ${uuidv7()})`;
    }
    await sql`insert into return_authorization_lines (id, tenant_id, rma_id, line_no, order_line_id, sku_id, authorized_qty, received_qty, reason_code)
      values (${lineIds[0]!}, ${tenantId}, ${rmaIds[0]!}, 1, ${uuidv7()}, ${uuidv7()}, 2000, 0, 'damaged')`;
    await sql`insert into return_authorization_lines (id, tenant_id, rma_id, line_no, order_line_id, sku_id, authorized_qty, received_qty, reason_code, reason_note)
      values (${lineIds[1]!}, ${tenantId}, ${rmaIds[1]!}, 1, ${uuidv7()}, ${uuidv7()}, 1000, 1000, 'other', 'came back opened')`;
    await sql`insert into return_receipt_lines (id, tenant_id, return_receipt_id, rma_line_id, sku_id, line_no, qty, open_qty, condition, ledger_event_id)
      values (${lineIds[2]!}, ${tenantId}, ${uuidv7()}, ${lineIds[1]!}, ${uuidv7()}, 1, 1000, 1000, 'opened', ${uuidv7()})`;
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

  it('the fail-fast refuses a database without 4-7a (no open_qty) — and rolls back whole', async () => {
    await sql`alter table return_receipt_lines rename column open_qty to open_qty_hidden`;
    try {
      await expect(
        sql.begin(async (tx) => {
          for (const statement of migrationStatements()) await tx.unsafe(statement);
        }),
      ).rejects.toThrow(/0097 must be applied first/);
      expect(await sql`select count(*)::int as n from information_schema.columns where table_name = 'return_authorizations' and column_name = 'origin'`).toEqual([{ n: 0 }]);
    } finally {
      await sql`alter table return_receipt_lines rename column open_qty_hidden to open_qty`;
    }
  });

  it('applies over authorized RMAs: every row reads origin authorized with no blind column, the CHECKs are NOT VALID and pinned against the TS tuples, the indexes exist, a re-run fails fast', async () => {
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) await tx.unsafe(statement);
    });
    const rows = (await sql`select id, origin, review_status, client_prompted from return_authorizations where tenant_id = ${tenantId} order by code`) as unknown as {
      id: string;
      origin: string;
      review_status: string | null;
      client_prompted: boolean | null;
    }[];
    expect(rows).toEqual(rmaIds.map((id) => ({ id, origin: 'authorized', review_status: null, client_prompted: null })));
    // The receipt line keeps its open quantity; the lines keep their order lines.
    expect(await sql`select open_qty::bigint::text as n from return_receipt_lines where id = ${lineIds[2]!}`).toEqual([{ n: '1000' }]);
    expect(await sql`select count(*)::int as n from return_authorization_lines where tenant_id = ${tenantId} and order_line_id is null`).toEqual([{ n: 0 }]);

    // The vocabularies: each TS tuple against its quoted CHECK literals.
    const checks = (await sql`select conname, pg_get_constraintdef(oid) as def, convalidated from pg_constraint
      where conrelid in ('public.return_authorizations'::regclass, 'public.return_authorization_lines'::regclass) and contype = 'c'`) as unknown as {
      conname: string;
      def: string;
      convalidated: boolean;
    }[];
    const literals = (name: string): string[] => {
      const def = checks.find((row) => row.conname === name)?.def ?? '';
      return [...def.matchAll(/'([^']+)'::text/g)].map((match) => match[1]!).sort();
    };
    expect(literals('return_authorization_lines_reason_code_check')).toEqual([...RETURN_REASON_CODES].sort());
    expect(literals('return_authorizations_origin_check')).toEqual([...RMA_ORIGINS].sort());
    expect(literals('return_authorizations_review_status_check')).toEqual([...RMA_REVIEW_STATUSES].sort());
    expect(literals('return_authorizations_match_kind_check')).toEqual([...BLIND_MATCH_KINDS].sort());
    expect(literals('return_authorizations_review_reason_code_check')).toEqual([...BLIND_REJECT_REASONS].sort());
    expect(AUTHORIZABLE_REASON_CODES.every((code) => (RETURN_REASON_CODES as readonly string[]).includes(code))).toBe(true);
    expect(RETURN_REASON_CODES.filter((code) => !(AUTHORIZABLE_REASON_CODES as readonly string[]).includes(code))).toEqual(['unannounced']);
    for (const name of [
      'return_authorizations_origin_check',
      'return_authorizations_review_status_check',
      'return_authorizations_match_kind_check',
      'return_authorizations_review_reason_code_check',
      'return_authorizations_parcel_reference_length',
      'return_authorizations_review_note_length',
      'return_authorizations_origin_shape',
      'return_authorizations_review_shape',
      'return_authorization_lines_reason_code_check',
    ]) {
      expect([name, checks.find((row) => row.conname === name)?.convalidated]).toEqual([name, false]);
    }
    // The NOT VALID CHECKs still bite on a write: an authorized RMA cannot lose its order.
    await expect(sql`update return_authorizations set order_id = null, order_dispatched_at = null where id = ${rmaIds[0]!}`).rejects.toThrow(
      /return_authorizations_origin_shape/,
    );
    // A later VALIDATE succeeds over the existing rows (the deploy step DEPLOY.md §5 names).
    for (const name of ['return_authorizations_origin_shape', 'return_authorizations_review_shape']) {
      await sql.unsafe(`alter table return_authorizations validate constraint ${name}`);
    }
    await sql.unsafe('alter table return_authorization_lines validate constraint return_authorization_lines_reason_code_check');

    const indexes = (await sql`select indexname from pg_indexes where tablename in ('return_authorizations', 'shipments') order by indexname`) as unknown as { indexname: string }[];
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'return_authorizations_tenant_pending_review_idx',
        'return_authorizations_tenant_parcel_reference_idx',
        'shipments_tenant_tracking_number_idx',
      ]),
    );
    // Fail-fast on a second run.
    await expect(
      sql.begin(async (tx) => {
        for (const statement of migrationStatements()) await tx.unsafe(statement);
      }),
    ).rejects.toThrow(/already been applied/);
  });
});
