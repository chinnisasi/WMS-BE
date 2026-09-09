import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import type { Workbook } from 'exceljs';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';

// The e2e suite talks to the real Postgres (docker-compose dev DB by default;
// CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
// A host that exports either poll interval would boot the background workers
// and race these tests — the same convention as the reconciliation suite.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const IDENTITY_URL = '/api/v1/tenants';

function registrationBody(email: string): Record<string, unknown> {
  return { name: `Priya Spices ${email.split('@')[0]}`, ownerEmail: email, password: 'correct-horse-battery' };
}

/** The documented import header (spec 1.4 Design Notes). */
const CSV_HEADER = 'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';

function csvRow(values: Record<string, string>): string {
  const columns = CSV_HEADER.split(',');
  return columns
    .map((column) => values[column] ?? '')
    .join(',');
}

function csvFile(rows: Record<string, string>[], header = CSV_HEADER): Buffer {
  return Buffer.from([header, ...rows.map((row) => csvRow(row))].join('\n'), 'utf8');
}

/** A small valid workbook; the xlsx parse path needs exercising too. */
async function xlsxFile(rows: Record<string, string>[]): Promise<Buffer> {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook() as Workbook;
  const sheet = workbook.addWorksheet('catalog');
  sheet.addRow(CSV_HEADER.split(','));
  for (const row of rows) {
    sheet.addRow(CSV_HEADER.split(',').map((column) => row[column] ?? ''));
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

describe('catalog (e2e)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    // Same deployment-parity auth probe as tenancy.spec.ts.
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // Serialized across parallel jest workers: concurrent CREATE ROLE /
      // GRANT ON ALL TABLES from sibling suites trips "tuple concurrently
      // updated" on the shared catalog rows.
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742105)`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_auth_probe') then
              create role wms_auth_probe login password 'wms_auth_probe' nosuperuser bypassrls;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_auth_probe');
        await tx.unsafe(
          'grant select, insert, update, delete on all tables in schema public to wms_auth_probe',
        );
      });
      const authUrl = new URL(process.env.DATABASE_URL!);
      authUrl.username = 'wms_auth_probe';
      authUrl.password = 'wms_auth_probe';
      process.env.DATABASE_AUTH_URL = authUrl.toString();
    } finally {
      await admin.end();
    }
    app = await createApp(false);
    await app.init();
  });

  afterAll(async () => {
    await cleanupRows();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // The suite's committed outbox rows must not linger (the relay
      // worker is env-gated OFF in tests — nothing drains them here).
      await sql.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // Children before parents: errors → runs → conversions → skus.
      await sql.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
    } finally {
      await sql.end();
    }
  }

  function registerTenant(email: string): SupertestTest {
    return request(app.getHttpServer())
      .post(IDENTITY_URL)
      .set('Idempotency-Key', ulid())
      .send(registrationBody(email));
  }

  async function signIn(email: string, password = 'correct-horse-battery'): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/sign-in`)
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function setupTenant(): Promise<{ tenantId: string; token: string }> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const tenantId = registered.body.tenant.id as string;
    const token = await signIn(email);
    return { tenantId, token };
  }

  function importCatalog(
    token: string,
    tenantId: string,
    file: { buffer: Buffer; name: string; mimetype: string },
    options: { mode?: string; idempotencyKey?: string } = {},
  ): SupertestTest {
    const test = request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', options.idempotencyKey ?? ulid());
    if (options.mode !== undefined) {
      test.field('mode', options.mode);
    }
    return test.attach('file', file.buffer, { filename: file.name, contentType: file.mimetype });
  }

  function listSkus(
    token: string,
    tenantId: string,
    query: Record<string, unknown> = {},
  ): SupertestTest {
    return request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/catalog/skus`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);
  }

  function patchSku(
    token: string,
    tenantId: string,
    skuId: string,
    body: Record<string, unknown>,
    idempotencyKey = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .patch(`${IDENTITY_URL}/${tenantId}/catalog/skus/${skuId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  async function importOk(
    token: string,
    tenantId: string,
    file: { buffer: Buffer; name: string; mimetype: string },
    options: { mode?: string; idempotencyKey?: string } = {},
  ): Promise<{
    importId: string;
    mode: string;
    committedRows: number;
    failedRows: number;
    skippedRows: number;
    errors: { rowNumber: number; skuCode: string | null; code: string; detail: string }[];
  }> {
    const res = await importCatalog(token, tenantId, file, options).expect(201);
    return res.body;
  }

  test('partial commit: valid rows commit in one transaction, bad rows are named per row', async () => {
    const { tenantId, token } = await setupTenantWithSeed(3);
    // One more import mixing good and bad rows: bad gst, empty name, duplicate
    // code (vs the seeded catalog), and a good row — 1 commits, 3 fail.
    const file = csvFile([
      { sku_code: 'NEW-OK-1', name: 'New ok row', uom: 'pcs', gst_rate: '1800', uom_conversions: 'box:12;case:144', barcode: 'BC-NEW-OK-1' },
      { sku_code: 'NEW-BAD-GST', name: 'Bad gst', uom: 'pcs', gst_rate: 'not-a-number' },
      { sku_code: 'NEW-BAD-NAME', name: '', uom: 'pcs', gst_rate: '500' },
      { sku_code: 'SEED-SKU-1', name: 'Duplicate of a committed code', uom: 'pcs', gst_rate: '500' },
    ]);
    const run = await importOk(token, tenantId, { buffer: file, name: 'catalog.csv', mimetype: 'text/csv' });

    expect(run.mode).toBe('initial');
    expect(run.committedRows).toBe(1);
    expect(run.failedRows).toBe(3);
    expect(run.skippedRows).toBe(0);
    expect(run.errors).toHaveLength(3);
    const byRow = new Map(run.errors.map((e) => [e.rowNumber, e]));
    expect(byRow.get(2)).toMatchObject({ skuCode: 'NEW-BAD-GST', code: 'validation-failed' });
    expect(byRow.get(3)).toMatchObject({ skuCode: 'NEW-BAD-NAME', code: 'validation-failed' });
    expect(byRow.get(4)).toMatchObject({ skuCode: 'SEED-SKU-1', code: 'duplicate-sku-code' });
    for (const error of run.errors) {
      expect(error.detail).toBeTruthy();
    }

    // The committed row is live with its conversions; the failed ones are not.
    const list = await listSkus(token, tenantId).expect(200);
    const codes = list.body.items.map((s: { code: string }) => s.code);
    expect(codes).toContain('NEW-OK-1');
    expect(codes).not.toContain('NEW-BAD-GST');
    const created = list.body.items.find((s: { code: string }) => s.code === 'NEW-OK-1');
    expect(created).toMatchObject({ barcode: 'BC-NEW-OK-1', gstRateBps: 1800, uom: 'pcs' });
    expect(created.uomConversions).toEqual(
      expect.arrayContaining([
        { uom: 'box', factor: 12 },
        { uom: 'case', factor: 144 },
      ]),
    );

    // The run ledger records the import; a 201 can carry failures honestly.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const runs = await sql`select committed_rows, failed_rows, skipped_rows, mode from catalog_imports where tenant_id = ${tenantId} order by created_at desc limit 1`;
      expect(runs[0]).toMatchObject({ committed_rows: 1, failed_rows: 3, skipped_rows: 0, mode: 'initial' });
    } finally {
      await sql.end();
    }
  });

  test('the 5,000-row acceptance shape: 30 bad rows, 4,970 commit', async () => {
    const { tenantId, token } = await setupTenantWithSeed(0);
    const rows: Record<string, string>[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const bad = i < 30;
      rows.push({
        sku_code: `BULK-${String(i).padStart(4, '0')}`,
        name: bad ? '' : `Bulk item ${i}`, // first 30 rows fail on the empty name
        uom: 'pcs',
        gst_rate: '1800',
      });
    }
    const file = csvFile(rows);
    const run = await importOk(token, tenantId, { buffer: file, name: 'bulk.csv', mimetype: 'text/csv' });

    expect(run.committedRows).toBe(4970);
    expect(run.failedRows).toBe(30);
    expect(run.errors).toHaveLength(30);
    // Errors name the row and the code, first 30 data rows.
    expect(run.errors.map((e) => e.rowNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    expect(run.errors.every((e) => e.code === 'validation-failed')).toBe(true);

    const list = await listSkus(token, tenantId, { limit: 200 }).expect(200);
    expect(list.body.items).toHaveLength(200); // page one of many
    expect(list.body.nextCursor).toBeTruthy();

    // Generated barcodes are server-side uuidv7 values, unique per tenant.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rowsOut = await sql`select count(*)::int as n, count(distinct barcode)::int as distinct_barcodes from skus where tenant_id = ${tenantId}`;
      expect(rowsOut[0]!.n).toBe(4970);
      expect(rowsOut[0]!.distinct_barcodes).toBe(4970);
      const sample = await sql`select barcode from skus where tenant_id = ${tenantId} limit 1`;
      expect(String(sample[0]!.barcode)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      await sql.end();
    }
  }, 30_000);

  test('duplicate sku codes are rejected within the file and against the tenant, naming the code', async () => {
    const { tenantId, token } = await setupTenantWithSeed(0);
    const first = await importOk(token, tenantId, {
      buffer: csvFile([{ sku_code: 'DUP-1', name: 'First', uom: 'pcs', gst_rate: '500' }]),
      name: 'first.csv',
      mimetype: 'text/csv',
    });
    expect(first.committedRows).toBe(1);

    // Same file contains the committed code twice AND the tenant code once.
    const file = csvFile([
      { sku_code: 'DUP-2', name: 'A', uom: 'pcs', gst_rate: '500' },
      { sku_code: 'DUP-2', name: 'B', uom: 'pcs', gst_rate: '500' },
      { sku_code: 'DUP-1', name: 'C', uom: 'pcs', gst_rate: '500' },
    ]);
    const run = await importOk(token, tenantId, { buffer: file, name: 'catalog.csv', mimetype: 'text/csv' });
    expect(run.committedRows).toBe(1); // only the first DUP-2 row
    expect(run.failedRows).toBe(2);
    expect(run.errors.map((e) => [e.skuCode, e.code])).toEqual(
      expect.arrayContaining([
        ['DUP-2', 'duplicate-sku-code'],
        ['DUP-1', 'duplicate-sku-code'],
      ]),
    );
    expect(run.errors.every((e) => e.detail.includes('DUP'))).toBe(true);

    // Never a whole-import 409: the run itself is 201 (asserted by importOk).
  });

  test('one barcode resolving to two SKUs is a row-level rejection naming the conflicting SKU', async () => {
    const { tenantId, token } = await setupTenantWithSeed(0);
    // File-internal: two rows, same provided barcode.
    const file = csvFile([
      { sku_code: 'BAR-A', name: 'A', uom: 'pcs', gst_rate: '500', barcode: 'SHARED-BARCODE' },
      { sku_code: 'BAR-B', name: 'B', uom: 'pcs', gst_rate: '500', barcode: 'SHARED-BARCODE' },
    ]);
    const run = await importOk(token, tenantId, { buffer: file, name: 'catalog.csv', mimetype: 'text/csv' });
    expect(run.committedRows).toBe(1);
    expect(run.errors[0]).toMatchObject({ skuCode: 'BAR-B', code: 'duplicate-barcode' });
    expect(run.errors[0]!.detail).toContain('BAR-A');

    // Tenant-level: a later import reusing the committed barcode.
    const later = await importOk(token, tenantId, {
      buffer: csvFile([{ sku_code: 'BAR-C', name: 'C', uom: 'pcs', gst_rate: '500', barcode: 'SHARED-BARCODE' }]),
      name: 'catalog.csv',
      mimetype: 'text/csv',
    });
    expect(later.committedRows).toBe(0);
    expect(later.errors[0]).toMatchObject({ skuCode: 'BAR-C', code: 'duplicate-barcode' });
    expect(later.errors[0]!.detail).toContain('BAR-A');
  });

  test('fix mode processes only the latest run\'s failed SKU codes; the rest are skipped', async () => {
    const { tenantId, token } = await setupTenantWithSeed(0);
    // Run 1: GOOD-1 and GOOD-2 commit; BAD-1 fails (bad gst).
    const first = await importOk(token, tenantId, {
      buffer: csvFile([
        { sku_code: 'GOOD-1', name: 'Good one', uom: 'pcs', gst_rate: '500' },
        { sku_code: 'GOOD-2', name: 'Good two', uom: 'pcs', gst_rate: '500' },
        { sku_code: 'BAD-1', name: 'Broken gst', uom: 'pcs', gst_rate: '99999' },
      ]),
      name: 'run1.csv',
      mimetype: 'text/csv',
    });
    expect(first).toMatchObject({ committedRows: 2, failedRows: 1, skippedRows: 0 });

    // Fix round 1: the fixed BAD-1 row processes, GOOD-1 (committed) and
    // EXTRA-1 (never failed) are skipped.
    const fix1 = await importOk(
      token,
      tenantId,
      {
        buffer: csvFile([
          { sku_code: 'GOOD-1', name: 'Good one again', uom: 'pcs', gst_rate: '500' },
          { sku_code: 'BAD-1', name: 'Fixed gst', uom: 'pcs', gst_rate: '1200' },
          { sku_code: 'EXTRA-1', name: 'Not in the failed set', uom: 'pcs', gst_rate: '500' },
        ]),
        name: 'fix1.csv',
        mimetype: 'text/csv',
      },
      { mode: 'fix' },
    );
    expect(fix1.mode).toBe('fix');
    expect(fix1).toMatchObject({ committedRows: 1, failedRows: 0, skippedRows: 2 });

    // The committed fix is live with the corrected values.
    const list = await listSkus(token, tenantId).expect(200);
    const fixed = list.body.items.find((s: { code: string }) => s.code === 'BAD-1');
    expect(fixed).toMatchObject({ gstRateBps: 1200 });
    expect(list.body.items.find((s: { code: string }) => s.code === 'EXTRA-1')).toBeUndefined();

    // A fresh initial run seeds a new failed set: two rows fail shape, one
    // commits (an all-clean fix run leaves an EMPTY set — there is nothing
    // left to fix, so a subsequent fix round skips everything).
    const run2 = await importOk(token, tenantId, {
      buffer: csvFile([
        { sku_code: 'NEW-OK-2', name: 'Fine', uom: 'pcs', gst_rate: '500' },
        { sku_code: 'FIX-BAD-1', name: 'Broken gst again', uom: 'pcs', gst_rate: '99999' },
        { sku_code: 'FIX-BAD-2', name: '', uom: 'pcs', gst_rate: '500' },
      ]),
      name: 'run2.csv',
      mimetype: 'text/csv',
    });
    expect(run2).toMatchObject({ committedRows: 1, failedRows: 2 });

    // Fix round 2 against that run: FIX-BAD-1 still fails (and forms the next
    // failed set — a still-bad row stays targetable), FIX-BAD-2 commits, and
    // BAD-1 (committed in an earlier round) is skipped.
    const fix2 = await importOk(
      token,
      tenantId,
      {
        buffer: csvFile([
          { sku_code: 'BAD-1', name: 'Committed earlier — skipped', uom: 'pcs', gst_rate: '1200' },
          { sku_code: 'FIX-BAD-1', name: 'Still broken gst', uom: 'pcs', gst_rate: '99999' },
          { sku_code: 'FIX-BAD-2', name: 'Fixed name', uom: 'pcs', gst_rate: '500' },
        ]),
        name: 'fix2.csv',
        mimetype: 'text/csv',
      },
      { mode: 'fix' },
    );
    expect(fix2).toMatchObject({ committedRows: 1, failedRows: 1, skippedRows: 1 });
    expect(fix2.errors[0]).toMatchObject({ skuCode: 'FIX-BAD-1', code: 'validation-failed' });

    // Round 3 targets the latest run's failed set ({FIX-BAD-1}) and commits it.
    const fix3 = await importOk(
      token,
      tenantId,
      {
        buffer: csvFile([{ sku_code: 'FIX-BAD-1', name: 'Fixed gst for good', uom: 'pcs', gst_rate: '1200' }]),
        name: 'fix3.csv',
        mimetype: 'text/csv',
      },
      { mode: 'fix' },
    );
    expect(fix3).toMatchObject({ committedRows: 1, failedRows: 0, skippedRows: 0 });

    // The final catalog holds every committed code — and never the skipped
    // EXTRA-1.
    const finalList = await listSkus(token, tenantId, { limit: 200 }).expect(200);
    expect(finalList.body.items.map((s: { code: string }) => s.code).sort()).toEqual(
      ['BAD-1', 'FIX-BAD-1', 'FIX-BAD-2', 'GOOD-1', 'GOOD-2', 'NEW-OK-2'].sort(),
    );
  });

  test('replay with the same key re-serves the exact snapshot; a different file with the same key is 422', async () => {
    const { tenantId, token } = await setupTenantWithSeed(0);
    const file = csvFile([
      { sku_code: 'REPLAY-1', name: 'Replay one', uom: 'pcs', gst_rate: '500' },
      { sku_code: 'REPLAY-2', name: '', uom: 'pcs', gst_rate: '500' }, // fails
    ]);
    const key = ulid();
    const first = await importOk(token, tenantId, { buffer: file, name: 'catalog.csv', mimetype: 'text/csv' }, { idempotencyKey: key });

    const replay = await importOk(token, tenantId, { buffer: file, name: 'catalog.csv', mimetype: 'text/csv' }, { idempotencyKey: key });
    expect(replay).toEqual(first);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const skusCount = await sql`select count(*)::int as n from skus where tenant_id = ${tenantId} and code like 'REPLAY-%'`;
      const runs = await sql`select count(*)::int as n from catalog_imports where tenant_id = ${tenantId}`;
      const keys = await sql`select count(*)::int as n from idempotency_keys where key = ${key}`;
      expect(skusCount[0]!.n).toBe(1); // the committed row, not duplicated
      expect(runs[0]!.n).toBe(1); // one run, one idempotency record
      expect(keys[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }

    // Same key, different file → idempotency-key-reuse, not a replay.
    const reuse = await importCatalog(token, tenantId, {
      buffer: csvFile([{ sku_code: 'REPLAY-3', name: 'Different file', uom: 'pcs', gst_rate: '500' }]),
      name: 'catalog.csv',
      mimetype: 'text/csv',
    }, { idempotencyKey: key }).expect(422);
    expect(reuse.body).toMatchObject({ code: 'idempotency-key-reuse' });
  });

  test('import limits: >10,000 rows and >5 MB are 422 import-too-large', async () => {
    const { tenantId, token } = await setupTenantWithSeed(0);

    const tooManyRows: Record<string, string>[] = [];
    for (let i = 0; i < 10_001; i += 1) {
      tooManyRows.push({ sku_code: `CAP-${i}`, name: `Cap ${i}`, uom: 'pcs', gst_rate: '500' });
    }
    const rowsRes = await importCatalog(token, tenantId, {
      buffer: csvFile(tooManyRows),
      name: 'catalog.csv',
      mimetype: 'text/csv',
    }).expect(422);
    expect(rowsRes.body).toMatchObject({ code: 'import-too-large' });

    // A file over 5 MB but under the row cap — the size path, not the row path.
    const wide = 'x'.repeat(60_000);
    const padded: Record<string, string>[] = [];
    for (let i = 0; i < 100; i += 1) {
      padded.push({ sku_code: `PAD-${i}`, name: wide, uom: 'pcs', gst_rate: '500' });
    }
    const sizeRes = await importCatalog(token, tenantId, {
      buffer: csvFile(padded),
      name: 'catalog.csv',
      mimetype: 'text/csv',
    }).expect(422);
    expect(sizeRes.body).toMatchObject({ code: 'import-too-large' });
  });

  test('unsupported file types are 415; unreadable files are 400', async () => {
    const { tenantId, token } = await setupTenantWithSeed(0);

    const notCsv = await importCatalog(token, tenantId, {
      buffer: Buffer.from('plain text, not a spreadsheet', 'utf8'),
      name: 'catalog.txt',
      mimetype: 'text/plain',
    }).expect(415);
    expect(notCsv.body).toMatchObject({ code: 'unsupported-file-type' });

    // .xlsx extension carrying garbage bytes → parse failure.
    const corrupt = await importCatalog(token, tenantId, {
      buffer: Buffer.from('this is not a zip archive', 'utf8'),
      name: 'catalog.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }).expect(400);
    expect(corrupt.body).toMatchObject({ code: 'file-unreadable' });

    // Missing required header column → file-unreadable, nothing committed.
    const badHeader = await importCatalog(token, tenantId, {
      buffer: Buffer.from('sku_code,name\nA-1,Thing\n', 'utf8'),
      name: 'catalog.csv',
      mimetype: 'text/csv',
    }).expect(400);
    expect(badHeader.body).toMatchObject({ code: 'file-unreadable' });

    // Header-only CSV → no data rows → file-unreadable.
    const headerOnly = await importCatalog(token, tenantId, {
      buffer: Buffer.from(`${CSV_HEADER}\n`, 'utf8'),
      name: 'catalog.csv',
      mimetype: 'text/csv',
    }).expect(400);
    expect(headerOnly.body).toMatchObject({ code: 'file-unreadable' });

    // No file part at all → 400.
    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .field('mode', 'initial')
      .expect(400);

    // Rejected uploads leave no run and no idempotency record behind.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const runs = await sql`select count(*)::int as n from catalog_imports where tenant_id = ${tenantId}`;
      expect(runs[0]!.n).toBe(0);
    } finally {
      await sql.end();
    }
  });

  test('xlsx imports parse like csv (conversions, flags, provided barcodes honored)', async () => {
    const { tenantId, token } = await setupTenantWithSeed(0);
    const file = await xlsxFile([
      { sku_code: 'XLSX-1', name: 'Sheet row', uom: 'pcs', gst_rate: '1200', hsn: '10062020', batch_tracked: 'true', serial_tracked: '0', reorder_point: '10', reorder_qty: '20', barcode: 'XLSX-BAR-1', uom_conversions: 'box:6' },
    ]);
    const run = await importOk(token, tenantId, {
      buffer: file,
      name: 'catalog.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(run.committedRows).toBe(1);

    const list = await listSkus(token, tenantId).expect(200);
    const sku = list.body.items.find((s: { code: string }) => s.code === 'XLSX-1');
    expect(sku).toMatchObject({
      gstRateBps: 1200,
      hsn: '10062020',
      batchTracked: true,
      serialTracked: false,
      reorderPoint: 10,
      reorderQty: 20,
      barcode: 'XLSX-BAR-1',
    });
    expect(sku.uomConversions).toEqual([{ uom: 'box', factor: 6 }]);
  });

  test('the SKU list walks the keyset cursor chain; crafted cursors and bad limits are 400', async () => {
    const { tenantId, token } = await setupTenantWithSeed(5);

    await listSkus(token, tenantId, { limit: 0 }).expect(400);
    await listSkus(token, tenantId, { limit: 201 }).expect(400);

    const crafted = Buffer.from(
      JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', id: 'garbage' }),
      'utf8',
    ).toString('base64url');
    const badCursor = await listSkus(token, tenantId, { cursor: crafted }).expect(400);
    expect(badCursor.body).toMatchObject({ code: 'invalid-cursor' });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const res = await listSkus(token, tenantId, cursor === undefined ? { limit: 2 } : { limit: 2, cursor }).expect(200);
      seen.push(...res.body.items.map((s: { code: string }) => s.code));
      if (res.body.nextCursor === null) break;
      cursor = res.body.nextCursor as string;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(['SEED-SKU-1', 'SEED-SKU-2', 'SEED-SKU-3', 'SEED-SKU-4', 'SEED-SKU-5']));

    await listSkus(token, tenantId, { limit: 1 }).expect(200);
    await listSkus(token, tenantId, { limit: 200 }).expect(200);
  });

  test('SKU edit persists the PATCH fields; unknown SKU 404; barcode collision 409 naming the SKU', async () => {
    const { tenantId, token } = await setupTenantWithSeed(2);
    const list = await listSkus(token, tenantId).expect(200);
    const target = list.body.items.find((s: { code: string }) => s.code === 'SEED-SKU-1');
    const other = list.body.items.find((s: { code: string }) => s.code === 'SEED-SKU-2');

    const body = { name: 'Edited name', gstRate: 2800, hsn: '09101000', batchTracked: true, serialTracked: true, reorderPoint: 5, reorderQty: 25 };
    const key = ulid();
    const edited = await patchSku(token, tenantId, target.id, body, key).expect(200);
    expect(edited.body).toMatchObject({ id: target.id, code: 'SEED-SKU-1', name: 'Edited name', gstRateBps: 2800, hsn: '09101000', batchTracked: true, reorderPoint: 5, reorderQty: 25 });
    expect(edited.body.uomConversions).toEqual(target.uomConversions); // conversions untouched

    // Replay re-serves the same snapshot.
    const replay = await patchSku(token, tenantId, target.id, body, key).expect(200);
    expect(replay.body).toEqual(edited.body);
    // Same key, different payload → idempotency-key-reuse.
    await patchSku(token, tenantId, target.id, { name: 'Different' }, key).expect(422);

    // hsn clears to null; barcode change persists.
    const cleared = await patchSku(token, tenantId, target.id, { hsn: '', barcode: 'EDITED-BARCODE' }).expect(200);
    expect(cleared.body.hsn).toBeNull();
    expect(cleared.body.barcode).toBe('EDITED-BARCODE');

    // Empty patch → 400.
    await patchSku(token, tenantId, target.id, {}).expect(400);

    // Barcode colliding with another tenant SKU → 409 duplicate-barcode naming it.
    const collision = await patchSku(token, tenantId, target.id, { barcode: other.barcode }).expect(409);
    expect(collision.body).toMatchObject({ status: 409, code: 'duplicate-barcode' });
    expect(collision.body.detail).toContain('SEED-SKU-2');

    // Unknown SKU → 404 not-found.
    await patchSku(token, tenantId, uuidv7(), body).expect(404);

    // SKU code is not part of the contract — whitelist rejects it.
    await patchSku(token, tenantId, target.id, { code: 'HACKED', name: 'Still edited' }).expect(400);
  });

  test('catalog endpoints require a session (401) and a foreign session gets 403', async () => {
    const { tenantId, token } = await setupTenantWithSeed(1);

    await importCatalog(token, tenantId, {
      buffer: csvFile([{ sku_code: 'AUTH-1', name: 'Auth', uom: 'pcs', gst_rate: '500' }]),
      name: 'catalog.csv',
      mimetype: 'text/csv',
    })
      .unset('Authorization')
      .expect(401);

    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const registeredB = await registerTenant(emailB).expect(201);
    createdTenantIds.push(registeredB.body.tenant.id);
    const tokenB = await signIn(emailB);

    const crossImport = await importCatalog(tokenB, tenantId, {
      buffer: csvFile([{ sku_code: 'CROSS-1', name: 'Cross', uom: 'pcs', gst_rate: '500' }]),
      name: 'catalog.csv',
      mimetype: 'text/csv',
    }).expect(403);
    expect(crossImport.body).toMatchObject({ code: 'permission-denied' });

    const crossList = await listSkus(tokenB, tenantId).expect(403);
    expect(crossList.body).toMatchObject({ code: 'permission-denied' });

    const list = await listSkus(token, tenantId).expect(200);
    const target = list.body.items[0]!;
    const crossPatch = await patchSku(tokenB, tenantId, target.id, { name: 'Hijack' }).expect(403);
    expect(crossPatch.body).toMatchObject({ code: 'permission-denied' });

    // Missing Idempotency-Key on the mutating routes → 400.
    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csvFile([]), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`${IDENTITY_URL}/${tenantId}/catalog/skus/${target.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'No key' })
      .expect(400);
  });

  test('the checklist catalog step flips honestly after a partial import', async () => {
    const { tenantId, token } = await setupTenantWithSeed(0);
    const fetchChecklist = async () =>
      request(app.getHttpServer())
        .get(`${IDENTITY_URL}/${tenantId}/setup-checklist`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

    const before = await fetchChecklist();
    const catalogBefore = before.body.steps.find((s: { key: string }) => s.key === 'catalog');
    expect(catalogBefore.done).toBe(false);

    // A run with failures: committed rows flip the step, the detail is honest.
    const run = await importOk(token, tenantId, {
      buffer: csvFile([
        { sku_code: 'CHK-1', name: 'Check one', uom: 'pcs', gst_rate: '500' },
        { sku_code: 'CHK-2', name: 'Check two', uom: 'pcs', gst_rate: '500' },
        { sku_code: 'CHK-3', name: '', uom: 'pcs', gst_rate: '500' },
      ]),
      name: 'catalog.csv',
      mimetype: 'text/csv',
    });
    expect(run).toMatchObject({ committedRows: 2, failedRows: 1 });

    const after = await fetchChecklist();
    const catalog = after.body.steps.find((s: { key: string }) => s.key === 'catalog');
    expect(catalog.done).toBe(true);
    expect(catalog.detail).toContain('2 SKUs');
    expect(catalog.detail).toContain('last import 2 committed, 1 failed');

    // All-failed run: still 0 SKUs, detail stays honest about the failure.
    const tenant2Email = `owner-${ulid().toLowerCase()}@example.com`;
    const tenant2 = await registerTenant(tenant2Email).expect(201);
    createdTenantIds.push(tenant2.body.tenant.id);
    const token2 = await signIn(tenant2Email);
    const failedRun = await importOk(token2, tenant2.body.tenant.id, {
      buffer: csvFile([{ sku_code: 'FAIL-1', name: '', uom: 'pcs', gst_rate: '500' }]),
      name: 'catalog.csv',
      mimetype: 'text/csv',
    });
    expect(failedRun).toMatchObject({ committedRows: 0, failedRows: 1 });
    const checklist2 = await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenant2.body.tenant.id}/setup-checklist`)
      .set('Authorization', `Bearer ${token2}`)
      .expect(200);
    const catalog2 = checklist2.body.steps.find((s: { key: string }) => s.key === 'catalog');
    expect(catalog2.done).toBe(false);
    expect(catalog2.detail).toContain('0 SKUs');
    expect(catalog2.detail).toContain('last import 0 committed, 1 failed');
  });

  test('RLS: a tenant-scoped session cannot read another tenant’s catalog rows', async () => {
    const { tenantId: tenantA } = await setupTenantWithSeed(2);
    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const registeredB = await registerTenant(emailB).expect(201);
    createdTenantIds.push(registeredB.body.tenant.id);
    const tenantB = registeredB.body.tenant.id as string;

    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    let scoped: postgres.Sql<Record<string, unknown>> | undefined;
    try {
      await admin.unsafe(`
        do $$ begin
          if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
            create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
          end if;
        end $$;
      `);
      await admin.unsafe('grant usage on schema public to wms_rls_probe');
      await admin.unsafe(
        'grant select, insert, update, delete on all tables in schema public to wms_rls_probe',
      );
      const probeUrl = new URL(process.env.DATABASE_URL!);
      probeUrl.username = 'wms_rls_probe';
      probeUrl.password = 'wms_rls_probe';
      scoped = postgres(probeUrl.toString(), { max: 1 });

      // skus: own read visible, foreign read empty, unscoped fail-closed.
      const ownSkus = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        return tx`select id from skus where tenant_id = ${tenantA}`;
      });
      expect(ownSkus.length).toBe(2);

      const foreignSkus = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        return tx`select id from skus where tenant_id = ${tenantA}`;
      });
      expect(foreignSkus).toHaveLength(0);

      const unscopedSkus = await scoped`select id from skus where tenant_id = ${tenantA}`;
      expect(unscopedSkus).toHaveLength(0);

      const foreignSkuInsert = scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode)
          values (${uuidv7()}, ${tenantB}, ${`RLS-${ulid().slice(0, 6)}`}, 'rls probe', 'pcs', 500, ${uuidv7()})`;
      });
      await expect(foreignSkuInsert).rejects.toThrow(/row-level security/i);

      // uom_conversions: seeded rows visible to the owner tenant only.
      const ownConversions = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        return tx`select id from uom_conversions where tenant_id = ${tenantA}`;
      });
      expect(ownConversions.length).toBe(2); // both seeded SKUs carry box:12
      const foreignConversions = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        return tx`select id from uom_conversions where tenant_id = ${tenantA}`;
      });
      expect(foreignConversions).toHaveLength(0);
      const unscopedConversions = await scoped`select id from uom_conversions where tenant_id = ${tenantA}`;
      expect(unscopedConversions).toHaveLength(0);

      const foreignConversionInsert = scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`insert into uom_conversions (id, tenant_id, sku_id, uom, factor)
          values (${uuidv7()}, ${tenantB}, ${ownSkus[0]!.id}, 'box', 12)`;
      });
      await expect(foreignConversionInsert).rejects.toThrow(/row-level security/i);

      // catalog_imports + catalog_import_errors: the same four probes.
      const ownRuns = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        return tx`select id from catalog_imports where tenant_id = ${tenantA}`;
      });
      expect(ownRuns.length).toBeGreaterThanOrEqual(1);
      const foreignRuns = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        return tx`select id from catalog_imports where tenant_id = ${tenantA}`;
      });
      expect(foreignRuns).toHaveLength(0);
      const unscopedRuns = await scoped`select id from catalog_imports where tenant_id = ${tenantA}`;
      expect(unscopedRuns).toHaveLength(0);
      const foreignRunInsert = scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`insert into catalog_imports (id, tenant_id, mode, committed_rows, failed_rows, skipped_rows)
          values (${uuidv7()}, ${tenantB}, 'initial', 0, 0, 0)`;
      });
      await expect(foreignRunInsert).rejects.toThrow(/row-level security/i);

      const ownErrors = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        return tx`select id from catalog_import_errors where tenant_id = ${tenantA}`;
      });
      expect(ownErrors.length).toBeGreaterThanOrEqual(0);
      const foreignErrors = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        return tx`select id from catalog_import_errors where tenant_id = ${tenantA}`;
      });
      expect(foreignErrors).toHaveLength(0);
      const unscopedErrors = await scoped`select id from catalog_import_errors where tenant_id = ${tenantA}`;
      expect(unscopedErrors).toHaveLength(0);

      const foreignErrorInsert = scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`insert into catalog_import_errors (id, tenant_id, import_id, row_number, sku_code, reason_code, reason_detail)
          values (${uuidv7()}, ${tenantB}, ${ownRuns[0]!.id}, 1, 'X', 'validation-failed', 'rls probe')`;
      });
      await expect(foreignErrorInsert).rejects.toThrow(/row-level security/i);
    } finally {
      await scoped?.end();
      await admin.end();
    }
  });

  test('concurrent imports sharing one Idempotency-Key: exactly one 201, the loser gets 409 conflict', async () => {
    const { tenantId, token } = await setupTenantWithSeed(0);
    // Two different files with disjoint SKU codes so the only possible loser
    // conflict is the (tenant_id, key) unique index itself — not a row clash.
    // The big file keeps its transaction open long enough that the small
    // file's idempotency lookup happens before either key insert commits;
    // otherwise the loser would instead see the committed key with a
    // different payload hash and take the sequential-reuse 422 path.
    const key = ulid();
    const bigRows = Array.from({ length: 2_000 }, (_, i) => ({
      sku_code: `RACE-BIG-${String(i + 1).padStart(4, '0')}`,
      name: `Racer big ${i + 1}`,
      uom: 'pcs',
      gst_rate: '500',
    }));
    const fileA = csvFile(bigRows);
    const fileB = csvFile([{ sku_code: 'RACE-SMALL', name: 'Racer small', uom: 'pcs', gst_rate: '500' }]);
    const settled = await Promise.allSettled([
      importCatalog(token, tenantId, { buffer: fileA, name: 'a.csv', mimetype: 'text/csv' }, { idempotencyKey: key }),
      importCatalog(token, tenantId, { buffer: fileB, name: 'b.csv', mimetype: 'text/csv' }, { idempotencyKey: key }),
    ]);
    const outcomes = settled.flatMap((outcome) =>
      outcome.status === 'fulfilled'
        ? [{ status: outcome.value.status as number, code: outcome.value.body.code as string | undefined }]
        : [],
    );
    outcomes.sort((a, b) => a.status - b.status);
    expect(outcomes.map((o) => o.status)).toEqual([201, 409]);
    expect(outcomes.find((o) => o.status === 409)!.code).toBe('conflict');
  });

  test('concurrent PATCHes claiming the same new barcode: the loser gets 409 duplicate-barcode, not a 500', async () => {
    const { tenantId, token } = await setupTenantWithSeed(2);
    const list = await listSkus(token, tenantId).expect(200);
    const items = list.body.items as { id: string; barcode: string | null }[];
    const [skuA, skuB] = items;
    expect(skuA).toBeTruthy();
    expect(skuB).toBeTruthy();
    // Both pre-checks pass (neither SKU carries the barcode yet), so the race
    // is decided by the skus_tenant_id_barcode_unique constraint — the loser's
    // UPDATE must surface as the mapped 409, never a raw 500.
    const settled = await Promise.allSettled([
      patchSku(token, tenantId, skuA!.id, { barcode: 'RACE-BARCODE' }),
      patchSku(token, tenantId, skuB!.id, { barcode: 'RACE-BARCODE' }),
    ]);
    const outcomes = settled.flatMap((outcome) =>
      outcome.status === 'fulfilled'
        ? [{ status: outcome.value.status as number, code: outcome.value.body.code as string | undefined }]
        : [],
    );
    outcomes.sort((a, b) => a.status - b.status);
    expect(outcomes.map((o) => o.status)).toEqual([200, 409]);
    expect(outcomes.find((o) => o.status === 409)!.code).toBe('duplicate-barcode');
  });

  test('the OpenAPI document exposes the catalog contract (drift guard companion)', async () => {
    const committed = JSON.parse(
      readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8') as string,
    ) as { paths: Record<string, unknown> };
    expect(Object.keys(committed.paths)).toEqual(
      expect.arrayContaining([
        '/tenants/{tenantId}/catalog/imports',
        '/tenants/{tenantId}/catalog/skus',
        '/tenants/{tenantId}/catalog/skus/{skuId}',
      ]),
    );
  });

  /** Seeds `count` good SKUs via the import path (never direct inserts). */
  async function setupTenantWithSeed(count: number): Promise<{ tenantId: string; token: string }> {
    const { tenantId, token } = await setupTenant();
    if (count > 0) {
      const rows: Record<string, string>[] = [];
      for (let i = 1; i <= count; i += 1) {
        rows.push({
          sku_code: `SEED-SKU-${i}`,
          name: `Seed ${i}`,
          uom: 'pcs',
          gst_rate: '1800',
          uom_conversions: 'box:12',
          barcode: `SEED-BAR-${i}`,
        });
      }
      await importOk(token, tenantId, { buffer: csvFile(rows), name: 'seed.csv', mimetype: 'text/csv' });
    }
    return { tenantId, token };
  }
});
