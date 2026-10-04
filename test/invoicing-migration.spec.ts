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

/** A migration (0054 by default), split into the statements the real runner executes. */
function migrationStatements(file: string = MIGRATION): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', file), 'utf8')
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

const MIGRATION_0055 = '0055_hsn_summary_columns.sql';

/** A post-0054 (8-1b) document: lines carry `uom`, totals the 8-1b shape. */
function regulatoryDocument(
  invoiceNo: string | null,
  issuedAt: string | null,
  lines: readonly { orderLineId: string; uom: string | null }[],
): Record<string, unknown> {
  return {
    header: {
      invoiceNo,
      fyLabel: invoiceNo === null ? null : 'FY-2627',
      orderRef: uuidv7(),
      issuedAt,
      supplyType: 'intra',
      placeOfSupply: '29',
      originGstin: '29AAAPZ1234C1ZV',
      consigneeGstin: null,
      originAddress: null,
      consigneeAddress: null,
    },
    seller: { name: 'HSN Co', gstin: '29AAAPZ1234C1ZV' },
    buyer: { name: null, gstin: null },
    lines: lines.map((line) => ({
      orderLineId: line.orderLineId,
      skuCode: 'SKU',
      skuName: 'SKU',
      hsn: '0910',
      qtyMilli: 1000,
      uom: line.uom,
      ratePaise: 0,
      rateSource: 'order_line',
      taxablePaise: 0,
      gstBps: 500,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      hsnGap: false,
    })),
    totals: { subtotal: 0, gst: 0, total: 0, roundOff: 0, payable: 0 },
    gaps: [],
    revision: 1,
  };
}

/**
 * Story 8-2a — migration 0055 against a database that carries the 0054
 * schema and 8-1 / 8-1b rows. The scratch database is built from the repo's
 * own migrations with the journal trimmed at 0054, seeded, then 0055 is
 * applied WHOLE inside one transaction (as the real runner applies it).
 * Proves: `issued_at` is the document's `issuedAt` as an INSTANT on issued
 * and voided rows only, `uom` is the document line's, and nothing else on
 * any row moved (`to_jsonb(row)` minus the new column, `updated_at` included).
 */
describe('migration 0055: the HSN summary read-model columns, applied to 0054 rows', () => {
  const PRE_DB = 'wms_s_invoice_pre0055';
  let baseUrl: string;
  let sql: ReturnType<typeof postgres>;
  let folder: string;

  const tenantId = uuidv7();
  const warehouseId = uuidv7();

  // [invoice id, status, invoice_no, document issuedAt, lines [orderLineId, uom]]
  const legacy = { id: uuidv7(), status: 'issued', no: 'FY-2627-000001', issuedAt: '2026-09-30T06:00:00.000Z', lines: [{ orderLineId: uuidv7(), uom: 'each' }] };
  const regulatory = {
    id: uuidv7(),
    status: 'issued',
    no: '29/2627/000001',
    issuedAt: '2026-08-15T10:11:12.345Z',
    lines: [
      { orderLineId: uuidv7(), uom: 'kg' },
      { orderLineId: uuidv7(), uom: 'bag' },
    ],
  };
  // Re-parked 8-1 row: its document still carries a STALE issuedAt — which
  // must NOT become an issue instant.
  const awaiting = { id: uuidv7(), status: 'awaiting-data', no: null, issuedAt: '2026-09-01T00:00:00.000Z', lines: [{ orderLineId: uuidv7(), uom: 'litre' }] };
  // The IST month boundary to the millisecond (30 Sep 23:59:59.999 IST).
  const boundary = { id: uuidv7(), status: 'issued', no: '29/2627/000002', issuedAt: '2026-09-30T18:29:59.999Z', lines: [{ orderLineId: uuidv7(), uom: 'jar' }] };
  const voided = { id: uuidv7(), status: 'voided', no: null, issuedAt: '2026-07-01T00:00:00.000Z', lines: [{ orderLineId: uuidv7(), uom: 'keg' }] };
  const seeded = [legacy, regulatory, awaiting, boundary, voided];

  let beforeInvoices: Map<string, unknown>;
  let beforeLines: Map<string, unknown>;
  let preflightError: unknown;
  const preflight = {
    nullIssuedAt: uuidv7(),
    notIsoZ: uuidv7(),
    zeroMatchLine: uuidv7(),
    severalMatchLine: uuidv7(),
    blankUomLine: uuidv7(),
    dupInvoice: uuidv7(),
    dupOrderLine: uuidv7(),
  };

  async function insertInvoice(
    tx: ReturnType<typeof postgres> | postgres.TransactionSql,
    row: { id: string; status: string; no: string | null; issuedAt: string | null },
    document: Record<string, unknown>,
  ): Promise<void> {
    await tx`
      insert into invoices (id, tenant_id, order_id, warehouse_id, invoice_no, fy_label, series_seq, status, origin_gstin,
        place_of_supply, supply_type, subtotal_paise, gst_paise, total_paise, payable_paise, round_off_paise, revision, document,
        created_at, updated_at)
      values (${row.id}, ${tenantId}, ${uuidv7()}, ${warehouseId}, ${row.no}, ${row.no === null ? null : 'FY-2627'},
        ${row.no === null ? null : 1}, ${row.status}, '29AAAPZ1234C1ZV', '29', 'intra', 0, 0, 0, 0, 0, 1,
        ${sql.json(document as never)}, '2026-07-01T00:00:00.123456Z', '2026-07-02T00:00:00.654321Z')
    `;
  }

  async function insertLine(
    tx: ReturnType<typeof postgres> | postgres.TransactionSql,
    invoiceId: string,
    orderLineId: string,
    id: string = uuidv7(),
  ): Promise<void> {
    await tx`
      insert into invoice_lines (id, tenant_id, invoice_id, order_line_id, sku_code, sku_name, hsn, qty_milli, rate_paise,
        rate_source, taxable_paise, gst_bps, created_at, updated_at)
      values (${id}, ${tenantId}, ${invoiceId}, ${orderLineId}, 'SKU', 'SKU', '0910', 1000, 0, 'order_line', 0, 500,
        '2026-07-01T00:00:00.111111Z', '2026-07-03T00:00:00.222222Z')
    `;
  }

  const applyWhole = (): Promise<unknown> =>
    sql.begin(async (tx) => {
      for (const statement of migrationStatements(MIGRATION_0055)) {
        await tx.unsafe(statement);
      }
    });

  beforeAll(async () => {
    baseUrl = process.env.DATABASE_URL!;
    const url = new URL(baseUrl);
    url.pathname = `/${PRE_DB}`;
    const preUrl = url.toString();
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

    // The schema the moment before 8-2a: the repo's own migrations, journal
    // trimmed at 0054, the file under test removed.
    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0055-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION_0055));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 54);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });

    for (const row of seeded) {
      await insertInvoice(sql, row, regulatoryDocument(row.no, row.issuedAt, row.lines));
      for (const line of row.lines) {
        await insertLine(sql, row.id, line.orderLineId);
      }
    }

    beforeInvoices = new Map(
      ((await sql`select id, to_jsonb(i) as row from invoices i`) as unknown as { id: string; row: unknown }[]).map((r) => [r.id, r.row]),
    );
    beforeLines = new Map(
      ((await sql`select id, to_jsonb(l) as row from invoice_lines l`) as unknown as { id: string; row: unknown }[]).map((r) => [r.id, r.row]),
    );

    // The pre-flight bites: every offender kind at once, named — and the
    // whole file rolls back.
    try {
      await sql.begin(async (tx) => {
        // (a) issued with a null issuedAt; voided with a non-Z timestamp.
        await insertInvoice(tx, { id: preflight.nullIssuedAt, status: 'issued', no: '29/2627/000098', issuedAt: null }, regulatoryDocument('29/2627/000098', null, []));
        await insertInvoice(tx, { id: preflight.notIsoZ, status: 'voided', no: null, issuedAt: null }, regulatoryDocument(null, '2026-09-30 06:00:00', []));
        // (b) a line matching NO document line, and one matching two.
        const host = uuidv7();
        const twice = uuidv7();
        await insertInvoice(tx, { id: host, status: 'issued', no: '29/2627/000099', issuedAt: null }, regulatoryDocument('29/2627/000099', '2026-09-01T00:00:00Z', [
          { orderLineId: twice, uom: 'each' },
          { orderLineId: twice, uom: 'box' },
        ]));
        await insertLine(tx, host, uuidv7(), preflight.zeroMatchLine);
        await insertLine(tx, host, twice, preflight.severalMatchLine);
        // (c) a matched line whose document uom is blank.
        const blankHost = uuidv7();
        const blankLine = uuidv7();
        await insertInvoice(tx, { id: blankHost, status: 'awaiting-data', no: null, issuedAt: null }, regulatoryDocument(null, null, [{ orderLineId: blankLine, uom: '  ' }]));
        await insertLine(tx, blankHost, blankLine, preflight.blankUomLine);
        // (d) two rows for one (invoice, order line).
        await insertInvoice(tx, { id: preflight.dupInvoice, status: 'awaiting-data', no: null, issuedAt: null }, regulatoryDocument(null, null, [{ orderLineId: preflight.dupOrderLine, uom: 'each' }]));
        await insertLine(tx, preflight.dupInvoice, preflight.dupOrderLine);
        await insertLine(tx, preflight.dupInvoice, preflight.dupOrderLine);
        for (const statement of migrationStatements(MIGRATION_0055)) {
          await tx.unsafe(statement);
        }
      });
    } catch (err) {
      preflightError = err;
    }

    await applyWhole();
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

  it('the pre-flight refused every offender kind at once, naming each, and left nothing behind', () => {
    expect(preflightError).toBeDefined();
    const message = (preflightError as Error).message;
    expect(message).toContain('migration 0055 pre-flight failed');
    expect(message).toContain(`${preflight.nullIssuedAt} (issued, issuedAt null)`);
    expect(message).toContain(`${preflight.notIsoZ} (voided, issuedAt 2026-09-30 06:00:00)`);
    expect(message).toContain(`${preflight.zeroMatchLine} (invoice`);
    expect(message).toContain('0 matches');
    expect(message).toContain(`${preflight.severalMatchLine} (invoice`);
    expect(message).toContain('2 matches');
    expect(message).toMatch(new RegExp(`whose document uom is null or blank: \\[${preflight.blankUomLine} `));
    expect(message).toContain(`${preflight.dupInvoice}/${preflight.dupOrderLine} (2 rows)`);
  });

  it('backfills issued_at from the document as an INSTANT on issued and voided rows — and leaves the awaiting row NULL despite its stale issuedAt', async () => {
    const rows = (await sql`
      select id, to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as issued_at,
        issued_at = (document->'header'->>'issuedAt')::timestamptz as same_instant
      from invoices
    `) as unknown as { id: string; issued_at: string | null; same_instant: boolean | null }[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of [legacy, regulatory, boundary, voided]) {
      expect(byId.get(row.id)).toEqual({ id: row.id, issued_at: row.issuedAt, same_instant: true });
    }
    expect(byId.get(awaiting.id)!.issued_at).toBeNull();
    expect(rows).toHaveLength(seeded.length);
  });

  it('backfills every line’s uom from its own document line (two lines on one invoice included)', async () => {
    const rows = (await sql`select invoice_id, order_line_id, uom from invoice_lines`) as unknown as {
      invoice_id: string;
      order_line_id: string;
      uom: string;
    }[];
    const expected = seeded.flatMap((row) => row.lines.map((line) => ({ invoice_id: row.id, order_line_id: line.orderLineId, uom: line.uom })));
    expect(rows.sort((a, b) => a.order_line_id.localeCompare(b.order_line_id))).toEqual(
      expected.sort((a, b) => a.order_line_id.localeCompare(b.order_line_id)),
    );
  });

  it('changes nothing else on any row — the whole row minus the new column is identical, updated_at included', async () => {
    const invoicesAfter = (await sql`select id, to_jsonb(i) - 'issued_at' as row from invoices i`) as unknown as { id: string; row: unknown }[];
    expect(new Map(invoicesAfter.map((r) => [r.id, r.row]))).toEqual(beforeInvoices);
    const linesAfter = (await sql`select id, to_jsonb(l) - 'uom' as row from invoice_lines l`) as unknown as { id: string; row: unknown }[];
    expect(new Map(linesAfter.map((r) => [r.id, r.row]))).toEqual(beforeLines);
    expect(beforeInvoices.size).toBe(seeded.length);
  });

  it('enforces the two-way issued_at CHECKs, uom NOT NULL, the line UNIQUE, and creates the partial index', async () => {
    const violation = async (run: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<{ constraint_name?: string; code?: string }> => {
      let error: unknown;
      try {
        await sql.begin(async (tx) => {
          await run(tx);
          throw new Error('rollback');
        });
      } catch (err) {
        error = err;
      }
      return error as { constraint_name?: string; code?: string };
    };
    expect((await violation((tx) => tx`update invoices set issued_at = now() where id = ${awaiting.id}`)).constraint_name).toBe(
      'invoices_awaiting_unissued_check',
    );
    expect((await violation((tx) => tx`update invoices set issued_at = null where id = ${legacy.id}`)).constraint_name).toBe(
      'invoices_issued_at_stamped_check',
    );
    expect((await violation((tx) => tx`update invoices set issued_at = null where id = ${voided.id}`)).constraint_name).toBe(
      'invoices_issued_at_stamped_check',
    );
    expect((await violation((tx) => tx`update invoice_lines set uom = null where invoice_id = ${legacy.id}`)).code).toBe('23502');
    const dup = await violation((tx) =>
      tx`insert into invoice_lines (id, tenant_id, invoice_id, order_line_id, sku_code, sku_name, qty_milli, rate_paise, rate_source, taxable_paise, gst_bps, uom)
         values (${uuidv7()}, ${tenantId}, ${legacy.id}, ${legacy.lines[0]!.orderLineId}, 'SKU', 'SKU', 1, 0, 'order_line', 0, 0, 'each')`,
    );
    expect(dup.constraint_name).toBe('invoice_lines_invoice_order_line_unique');
    // A legal write still lands (the baseline reaches the rollback, not a constraint).
    expect((await violation((tx) => tx`update invoices set issued_at = now() where id = ${legacy.id}`)) as unknown as Error).toEqual(new Error('rollback'));
    const indexes = (await sql`select indexdef from pg_indexes where indexname = 'invoices_tenant_gstin_issued_at_idx'`) as unknown as { indexdef: string }[];
    expect(indexes[0]!.indexdef).toContain('(tenant_id, origin_gstin, issued_at) WHERE (status = \'issued\'::text)');
  });

  it('a second apply RAISEs at the guard and changes nothing', async () => {
    const snapshot = async () => [...(await sql`select id, to_jsonb(i)::text as row from invoices i order by id`)];
    const before = await snapshot();
    let error: unknown;
    try {
      await applyWhole();
    } catch (err) {
      error = err;
    }
    expect((error as Error).message).toContain('migration 0055 has already been applied');
    expect(await snapshot()).toEqual(before);
  });
});

const MIGRATION_0056 = '0056_eway_bills.sql';

/**
 * Story 8-2b — migration 0056 (the e-way tables) applied to a database at
 * 0055 with an issued invoice in it. 0056 is additive (no backfill — the
 * story's Never list), so the proof is: the tables, CHECKs, triggers, RLS and
 * the ONE national seed row land; no existing row moves; a re-run RAISEs.
 */
describe('migration 0056: the e-way tables, applied to 0055 rows', () => {
  const PRE_DB = 'wms_s_invoice_pre0056';
  let baseUrl: string;
  let sql: ReturnType<typeof postgres>;
  let folder: string;
  const tenantId = uuidv7();
  const invoiceId = uuidv7();
  let invoiceBefore: string;

  const applyWhole = (): Promise<unknown> =>
    sql.begin(async (tx) => {
      for (const statement of migrationStatements(MIGRATION_0056)) {
        await tx.unsafe(statement);
      }
    });

  beforeAll(async () => {
    baseUrl = process.env.DATABASE_URL!;
    const url = new URL(baseUrl);
    url.pathname = `/${PRE_DB}`;
    const preUrl = url.toString();
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
    // The schema the moment before 8-2b: journal trimmed at 0055.
    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0056-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION_0056));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 55);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });

    await sql`
      insert into invoices (id, tenant_id, order_id, warehouse_id, invoice_no, fy_label, series_seq, status, origin_gstin,
        place_of_supply, supply_type, subtotal_paise, gst_paise, total_paise, payable_paise, round_off_paise, revision, document, issued_at)
      values (${invoiceId}, ${tenantId}, ${uuidv7()}, ${uuidv7()}, '29/2627/000001', 'FY-2627', 1, 'issued', '29AAAPZ1234C1ZV',
        '27', 'inter', 6000000, 1080000, 7080000, 7080000, 0, 1, ${sql.json({ header: { issuedAt: '2026-10-01T00:00:00.000Z' } } as never)},
        '2026-10-01T00:00:00.000Z')
    `;
    invoiceBefore = (await sql`select to_jsonb(i)::text as row from invoices i where id = ${invoiceId}`)[0]!.row as string;
    await applyWhole();
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

  it('seeds exactly the one verified national rule, and backfills nothing', async () => {
    expect([...(await sql`select effective_from::text as d, threshold_paise::text as p, source from eway_national_thresholds`)]).toEqual([
      { d: '2018-04-01', p: '5000000', source: 'CGST Rule 138(1)' },
    ]);
    expect((await sql`select count(*)::int as n from eway_bills`)[0]!.n).toBe(0);
    expect((await sql`select to_jsonb(i)::text as row from invoices i where id = ${invoiceId}`)[0]!.row).toBe(invoiceBefore);
  });

  it('the national table refuses UPDATE and DELETE; the state overrides refuse UPDATE but allow teardown DELETE', async () => {
    await expect(sql`update eway_national_thresholds set threshold_paise = 1`).rejects.toThrow(/append-only/);
    await expect(sql`delete from eway_national_thresholds`).rejects.toThrow(/append-only/);
    const id = uuidv7();
    await sql`insert into eway_state_thresholds (id, tenant_id, state_code, threshold_paise, effective_from, created_by)
      values (${id}, ${tenantId}, '27', 10000000, '2025-04-01', ${uuidv7()})`;
    await expect(sql`update eway_state_thresholds set threshold_paise = 1 where id = ${id}`).rejects.toThrow(/append-only/);
    await sql`delete from eway_state_thresholds where id = ${id}`;
    expect((await sql`select count(*)::int as n from eway_state_thresholds`)[0]!.n).toBe(0);
  });

  it('enables RLS with the uniform policy on the three tenant tables (not the global one)', async () => {
    const rows = await sql`select relname, relrowsecurity from pg_class where relname like 'eway_%' and relkind = 'r' order by relname`;
    expect([...rows].map((r) => [r.relname, r.relrowsecurity])).toEqual([
      ['eway_bills', true],
      ['eway_gstin_settings', true],
      ['eway_national_thresholds', false],
      ['eway_state_thresholds', true],
    ]);
    const policies = await sql`select tablename from pg_policies where tablename like 'eway_%' order by tablename`;
    expect([...policies].map((p) => p.tablename)).toEqual(['eway_bills', 'eway_gstin_settings', 'eway_state_thresholds']);
  });

  it('a second apply RAISEs at the guard and changes nothing', async () => {
    let error: unknown;
    try {
      await applyWhole();
    } catch (err) {
      error = err;
    }
    expect((error as Error).message).toContain('migration 0056 has already been applied');
    expect((await sql`select count(*)::int as n from eway_national_thresholds`)[0]!.n).toBe(1);
  });
});
