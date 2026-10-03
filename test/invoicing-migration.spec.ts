import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(120_000);

const MIGRATION = '0054_invoice_regulatory_pass.sql';

/** Migration 0054, split into the statements the real runner executes. */
function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** The 8-1 document shape — the one 0054 rewrites. */
function legacyDocument(invoiceNo: string | null, subtotal: number, gst: number, revision: number): Record<string, unknown> {
  return {
    header: {
      invoiceNo,
      fyLabel: invoiceNo === null ? null : 'FY-2627',
      orderRef: uuidv7(),
      issuedAt: invoiceNo === null ? null : '2026-09-30T06:00:00.000Z',
      supplyType: 'intra',
      placeOfSupply: '27',
      originGstin: invoiceNo === null ? null : '27AAAPZ1234C1ZV',
      consigneeGstin: null,
      originAddress: null,
      consigneeAddress: null,
    },
    seller: { name: 'Legacy Co', gstin: invoiceNo === null ? null : '27AAAPZ1234C1ZV' },
    buyer: { name: null, gstin: null },
    lines: [],
    totals: { subtotal, gst, payAble: subtotal + gst },
    gaps: [],
    revision,
  };
}

/**
 * Story 8-1b — migration 0054 against a database that still carries the
 * 0053 schema and 8-1-shaped rows. Every other suite starts from a template
 * that is already migrated, so this is the only place 0054's data statements
 * (the backfill, the document and snapshot rewrites) run over real rows. The
 * scratch database is built from the repo's own migrations with the journal
 * trimmed at 0053 (the fractional-quantity harness), then 0054 is applied
 * WHOLE inside one transaction, as the real runner applies it.
 */
describe('migration 0054: the invoice regulatory pass, applied to 8-1 rows', () => {
  const PRE_DB = 'wms_s_invoice_premigration';
  let baseUrl: string;
  let preUrl: string;
  let sql: ReturnType<typeof postgres>;
  let folder: string;

  const tenantId = uuidv7();
  const warehouseId = uuidv7();

  /** [id, total remainder label, subtotal, gst, expected payable, expected roundOff] */
  const issued = [
    { id: uuidv7(), no: 'FY-2627-000001', seq: 1, subtotal: 100_000, gst: 18_000, payable: 118_000, roundOff: 0, revision: 1 }, // remainder 00
    { id: uuidv7(), no: 'FY-2627-000002', seq: 2, subtotal: 369_024, gst: 66_425, payable: 435_400, roundOff: -49, revision: 3 }, // 49
    { id: uuidv7(), no: 'FY-2627-000003', seq: 3, subtotal: 369_025, gst: 66_425, payable: 435_500, roundOff: 50, revision: 2 }, // 50
  ] as const;
  const awaitingId = uuidv7();
  const legacySeriesId = uuidv7();
  const invoiceKeyId = uuidv7();
  const otherKeyId = uuidv7();
  const otherSnapshot = { order: { id: uuidv7(), totals: { payAble: 1 } } }; // not an invoice snapshot

  interface Before {
    issued: { id: string; invoice_no: string; subtotal_paise: string; gst_paise: string; total_paise: string; revision: number; updated_at: string }[];
  }
  let before: Before;
  let preflightError: unknown;
  const unstampedId = uuidv7();

  beforeAll(async () => {
    baseUrl = process.env.DATABASE_URL!;
    const url = new URL(baseUrl);
    url.pathname = `/${PRE_DB}`;
    preUrl = url.toString();
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1 });
    try {
      await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
      await admin.unsafe(`drop database if exists "${PRE_DB}"`);
      await admin.unsafe(`create database "${PRE_DB}"`);
    } finally {
      await admin.end();
    }

    // The schema as it stood the moment before 8-1b: the repo's own
    // migrations, journal trimmed at 0053, the file under test removed.
    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0054-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 53);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });

    // Seed the 8-1 state: three issued invoices (total remainders 00 / 49 /
    // 50), an awaiting zero-total one, the per-tenant series row, an
    // invoicing idempotency snapshot carrying `payAble`, and an unrelated
    // snapshot that must not move. Raw inserts: this test is about the DB.
    for (const row of issued) {
      await sql`
        insert into invoices (id, tenant_id, order_id, warehouse_id, invoice_no, fy_label, series_seq, status,
          origin_gstin, place_of_supply, supply_type, subtotal_paise, gst_paise, total_paise, revision, document,
          created_at, updated_at)
        values (${row.id}, ${tenantId}, ${uuidv7()}, ${warehouseId}, ${row.no}, 'FY-2627', ${row.seq}, 'issued',
          '27AAAPZ1234C1ZV', '27', 'intra', ${row.subtotal}, ${row.gst}, ${row.subtotal + row.gst}, ${row.revision},
          ${sql.json(legacyDocument(row.no, row.subtotal, row.gst, row.revision) as never)},
          '2026-09-30T06:00:00.123456Z', '2026-09-30T07:00:00.654321Z')
      `;
    }
    await sql`
      insert into invoices (id, tenant_id, order_id, warehouse_id, status, subtotal_paise, gst_paise, total_paise, revision, document)
      values (${awaitingId}, ${tenantId}, ${uuidv7()}, ${warehouseId}, 'awaiting-data', 0, 0, 0, 1,
        ${sql.json(legacyDocument(null, 0, 0, 1) as never)})
    `;
    await sql`
      insert into invoice_series (id, tenant_id, fy_label, last_seq) values (${legacySeriesId}, ${tenantId}, 'FY-2627', 3)
    `;
    const invoiceSnapshot = {
      invoice: {
        id: issued[0].id,
        invoiceNo: 'FY-2627-000009',
        subtotalPaise: 193_271,
        gstPaise: 34_789,
        totalPaise: 228_060,
        revision: 1,
        document: { ...legacyDocument('FY-2627-000009', 193_271, 34_789, 1) },
        lines: [],
      },
    };
    await sql`
      insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
      values (${invoiceKeyId}, ${tenantId}, '01J0000000000000000000INV1', 'h1', ${sql.json(invoiceSnapshot as never)}),
             (${otherKeyId}, ${tenantId}, '01J0000000000000000000ORD1', 'h2', ${sql.json(otherSnapshot as never)})
    `;

    before = {
      issued: (await sql`
        select id, invoice_no, subtotal_paise::text, gst_paise::text, total_paise::text, revision, updated_at::text
        from invoices where status = 'issued' order by id
      `) as never,
    };

    // The pre-flight bites: a document whose payAble disagrees with its
    // total aborts the whole file, naming the row — and rolls back cleanly.
    const badId = uuidv7();
    try {
      await sql.begin(async (tx) => {
        await tx`
          insert into invoices (id, tenant_id, order_id, warehouse_id, status, subtotal_paise, gst_paise, total_paise, document)
          values (${badId}, ${tenantId}, ${uuidv7()}, ${warehouseId}, 'awaiting-data', 10, 0, 10,
            ${sql.json({ ...legacyDocument(null, 10, 0, 1), totals: { subtotal: 10, gst: 0, payAble: 11 } } as never)})
        `;
        // Pre-flight (b): an issued row with no supplier GSTIN.
        await tx`
          insert into invoices (id, tenant_id, order_id, warehouse_id, invoice_no, fy_label, series_seq, status,
            subtotal_paise, gst_paise, total_paise, document)
          values (${unstampedId}, ${tenantId}, ${uuidv7()}, ${warehouseId}, 'FY-2627-000099', 'FY-2627', 99, 'issued',
            12, 0, 12, ${sql.json(legacyDocument('FY-2627-000099', 12, 0, 1) as never)})
        `;
        for (const statement of migrationStatements()) {
          await tx.unsafe(statement);
        }
      });
    } catch (err) {
      preflightError = err;
    }

    // The real apply: the whole file, one transaction.
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) {
        await tx.unsafe(statement);
      }
    });
  });

  afterAll(async () => {
    await sql?.end();
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1 });
    try {
      await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
      await admin.unsafe(`drop database if exists "${PRE_DB}"`);
    } finally {
      await admin.end();
    }
  });

  it('the pre-flight refused a payAble ≠ total document, naming it, and left nothing behind', async () => {
    expect(preflightError).toBeDefined();
    expect((preflightError as Error).message).toContain('pre-flight failed');
    expect((preflightError as Error).message).toContain('payAble 11, total_paise 10');
    expect((preflightError as Error).message).toContain(`Issued invoices without invoice_no or origin_gstin: [${unstampedId}]`);
    const leftovers = (await sql`select count(*)::int as n from invoices where total_paise in (10, 12)`) as unknown as { n: number }[];
    expect(Number(leftovers[0]!.n)).toBe(0);
  });

  it('backfills payable and round-off from the total column: remainders 00 / 49 / 50 and the zero total', async () => {
    const rows = (await sql`
      select id, total_paise::text as total, payable_paise::text as payable, round_off_paise::text as round_off
      from invoices
    `) as unknown as { id: string; total: string; payable: string; round_off: string }[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of issued) {
      expect(byId.get(row.id)).toEqual({
        id: row.id,
        total: String(row.subtotal + row.gst),
        payable: String(row.payable),
        round_off: String(row.roundOff),
      });
    }
    expect(byId.get(awaitingId)).toEqual({ id: awaitingId, total: '0', payable: '0', round_off: '0' });
  });

  it('rewrites every document to {subtotal, gst, total, roundOff, payable} — no `payAble` survives', async () => {
    const docs = (await sql`select id, document from invoices`) as unknown as { id: string; document: { totals: unknown } }[];
    const byId = new Map(docs.map((row) => [row.id, row.document]));
    for (const row of issued) {
      expect(byId.get(row.id)!.totals).toEqual({
        subtotal: row.subtotal,
        gst: row.gst,
        total: row.subtotal + row.gst,
        roundOff: row.roundOff,
        payable: row.payable,
      });
    }
    expect(byId.get(awaitingId)!.totals).toEqual({ subtotal: 0, gst: 0, total: 0, roundOff: 0, payable: 0 });
    const stale = (await sql`select count(*)::int as n from invoices where document::text like '%payAble%'`) as unknown as { n: number }[];
    expect(Number(stale[0]!.n)).toBe(0);
  });

  it('rewrites the invoicing idempotency snapshot from its OWN figures, and leaves every other snapshot alone', async () => {
    const rows = (await sql`select id, response_snapshot from idempotency_keys`) as unknown as {
      id: string;
      response_snapshot: { invoice?: { payablePaise: number; roundOffPaise: number; totalPaise: number; document: { totals: unknown } } };
    }[];
    const invoiceKey = rows.find((row) => row.id === invoiceKeyId)!.response_snapshot.invoice!;
    expect(invoiceKey.document.totals).toEqual({ subtotal: 193_271, gst: 34_789, total: 228_060, roundOff: 40, payable: 228_100 });
    expect(invoiceKey.totalPaise).toBe(228_060);
    expect(invoiceKey.payablePaise).toBe(228_100);
    expect(invoiceKey.roundOffPaise).toBe(40);
    expect(rows.find((row) => row.id === otherKeyId)!.response_snapshot).toEqual(otherSnapshot);
    const stale = (await sql`
      select count(*)::int as n from idempotency_keys where response_snapshot->'invoice' is not null
        and response_snapshot::text like '%payAble%'
    `) as unknown as { n: number }[];
    expect(Number(stale[0]!.n)).toBe(0);
  });

  it('changes no issued invoice’s number, subtotal, GST, total, revision or updated_at', async () => {
    const after = await sql`
      select id, invoice_no, subtotal_paise::text, gst_paise::text, total_paise::text, revision, updated_at::text
      from invoices where status = 'issued' order by id
    `;
    expect([...after]).toEqual(before.issued);
    expect(before.issued.map((row) => row.invoice_no).sort()).toEqual(['FY-2627-000001', 'FY-2627-000002', 'FY-2627-000003']);
  });

  it('keeps the legacy series row with a NULL GSTIN, beside which a per-GSTIN series can open', async () => {
    const legacy = (await sql`select origin_gstin, fy_label, last_seq::text as last_seq from invoice_series where id = ${legacySeriesId}`) as unknown as {
      origin_gstin: string | null;
      fy_label: string;
      last_seq: string;
    }[];
    expect(legacy).toEqual([{ origin_gstin: null, fy_label: 'FY-2627', last_seq: '3' }]);
    // The new series for the same tenant and FY, keyed by GSTIN; a second
    // one for the same GSTIN is the partial unique's violation, and the
    // ON CONFLICT the generator issues infers that index from its predicate.
    await sql`insert into invoice_series (id, tenant_id, origin_gstin, fy_label, last_seq) values (${uuidv7()}, ${tenantId}, '27AAAPZ1234C1ZV', 'FY-2627', 0)`;
    const conflicted = await sql`
      insert into invoice_series (id, tenant_id, origin_gstin, fy_label, last_seq)
      values (${uuidv7()}, ${tenantId}, '27AAAPZ1234C1ZV', 'FY-2627', 0)
      on conflict (tenant_id, origin_gstin, fy_label) where origin_gstin is not null do nothing
      returning id
    `;
    expect(conflicted).toHaveLength(0);
    const indexes = (await sql`
      select indexname, indexdef from pg_indexes where tablename in ('invoice_series', 'invoices') order by indexname
    `) as unknown as { indexname: string; indexdef: string }[];
    const names = indexes.map((row) => row.indexname);
    expect(names).toContain('invoice_series_tenant_gstin_fy_unique');
    expect(names).toContain('invoices_tenant_gstin_invoice_no_unique');
    expect(names).not.toContain('invoice_series_tenant_fy_unique');
    expect(names).not.toContain('invoices_tenant_invoice_no_unique');
  });

  it('enforces the new CHECKs: the balance, the round-off range, whole rupees, non-negative, and issued ⇒ (number, GSTIN)', async () => {
    const insert = (overrides: Record<string, unknown>) =>
      sql.begin(async (tx) => {
        const row = {
          id: uuidv7(),
          tenant_id: tenantId,
          order_id: uuidv7(),
          warehouse_id: warehouseId,
          status: 'awaiting-data',
          subtotal_paise: 100,
          gst_paise: 0,
          total_paise: 100,
          payable_paise: 100,
          round_off_paise: 0,
          document: sql.json({} as never),
          ...overrides,
        };
        await tx`insert into invoices ${sql(row as never)}`;
        throw new Error('rollback');
      });
    const violated = async (overrides: Record<string, unknown>, constraint: string): Promise<void> => {
      let error: unknown;
      try {
        await insert(overrides);
      } catch (err) {
        error = err;
      }
      expect((error as { constraint_name?: string }).constraint_name).toBe(constraint);
    };
    // The baseline row is legal (it reaches the rollback, not a CHECK).
    await expect(insert({})).rejects.toThrow('rollback');
    await violated({ payable_paise: 200 }, 'invoices_payable_balance_check');
    await violated({ subtotal_paise: 49, total_paise: 49, payable_paise: 100, round_off_paise: 51 }, 'invoices_round_off_range_check');
    await violated({ subtotal_paise: 140, total_paise: 140, payable_paise: 150, round_off_paise: 10 }, 'invoices_payable_whole_rupee_check');
    await violated({ status: 'issued' }, 'invoices_issued_stamped_check');
    await violated({ status: 'issued', invoice_no: '27/2627/000001' }, 'invoices_issued_stamped_check');
    const checks = (await sql`
      select conname from pg_constraint where conrelid = 'invoices'::regclass and contype = 'c'
    `) as unknown as { conname: string }[];
    expect(checks.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        'invoices_payable_balance_check',
        'invoices_round_off_range_check',
        'invoices_payable_whole_rupee_check',
        'invoices_payable_non_negative_check',
        'invoices_issued_stamped_check',
      ]),
    );
    const notNull = (await sql`
      select column_name, is_nullable from information_schema.columns
      where table_name = 'invoices' and column_name in ('payable_paise', 'round_off_paise') order by column_name
    `) as unknown as { column_name: string; is_nullable: string }[];
    expect(notNull).toEqual([
      { column_name: 'payable_paise', is_nullable: 'NO' },
      { column_name: 'round_off_paise', is_nullable: 'NO' },
    ]);
  });

  it('a second apply RAISEs at the guard and changes nothing', async () => {
    const docsBefore = await sql`select id, document::text from invoices order by id`;
    let error: unknown;
    try {
      await sql.begin(async (tx) => {
        for (const statement of migrationStatements()) {
          await tx.unsafe(statement);
        }
      });
    } catch (err) {
      error = err;
    }
    expect((error as Error).message).toContain('migration 0054 has already been applied');
    expect([...(await sql`select id, document::text from invoices order by id`)]).toEqual([...docsBefore]);
  });
});
