import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres (docker-compose dev DB by default;
// CI provides the service container) and signs sessions — the same bootstrap
// the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/**
 * Story 11-2 — the SKU's physical attributes and origin, driven over the
 * I/O matrix in the spec:
 *
 * | Scenario | Pinned by |
 * |---|---|
 * | PATCH sets attributes → echoed in edit + list | `PATCH sets all five` |
 * | zero / negative / over-cap weight → 400 naming weightGrams | `refuses an out-of-range weight` |
 * | fractional dimension → 400 naming lengthMm | `refuses a fractional dimension` |
 * | "in" / "IND" → 400 naming countryOfOrigin | `refuses a bad country` |
 * | absent = unchanged, null = cleared, cleared reads null | `absent leaves, null clears` |
 * | empty patch (attributes count as fields) | `refuses an empty patch` |
 * | import with the new columns; blank → null; bad → row error | `import lands the attributes` |
 * | unknown column still 400 file-unreadable | `keeps the closed-header contract` |
 * | pre-11.2 idempotency key replays 200 | `a pre-11.2 edit key replays` |
 * | pre-11.2 SKU row reads null | asserted throughout via the no-attribute seed |
 */
describe('sku physical attributes (e2e, story 11-2)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  const skuIds = new Map<string, string>();

  let suiteDb: SuiteDatabase;

  /** The full documented header INCLUDING the 11.2 attribute columns. */
  const CSV_HEADER =
    'sku_code,name,uom,gst_rate,hsn,weight_grams,length_mm,width_mm,height_mm,country_of_origin,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';

  function csvRow(values: Record<string, string>): string {
    return CSV_HEADER.split(',')
      .map((column) => values[column] ?? '')
      .join(',');
  }

  function csvFile(rows: Record<string, string>[], header = CSV_HEADER): Buffer {
    return Buffer.from([header, ...rows.map((row) => csvRow(row))].join('\n'), 'utf8');
  }

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('sku_attributes');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });

    // ── tenant + owner ─────────────────────────────────────────────────────
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Attributes Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email, password: 'correct-horse-battery' })
      .expect(200)
      .then((res) => res.body.accessToken as string);

    // ── scenario SKUs: one imported WITHOUT the attribute columns (the
    //    pre-11.2 shape — every attribute must read null) ───────────────────
    const legacyHeader =
      'sku_code,name,uom,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const legacyCsv = [legacyHeader, 'PRE-112,Legacy shape SKU,pcs,1800,,,,,'].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .attach('file', Buffer.from(legacyCsv, 'utf8'), { filename: 'legacy.csv', contentType: 'text/csv' })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of list.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }
    expect(skuIds.get('PRE-112')).toBeDefined();
  });

  afterAll(async () => {
    await cleanupRows();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await cleaner.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // Children before parents: errors → runs → conversions → skus.
      await cleaner.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
    } finally {
      await cleaner.end();
    }
  }

  function listSkus(): request.Test {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  function patchSku(skuId: string, body: Record<string, unknown>, idempotencyKey = ulid()): request.Test {
    return request(app.getHttpServer())
      .patch(`${API}/${tenantId}/catalog/skus/${skuId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, idempotencyKey)
      .send(body);
  }

  function importCsv(file: Buffer, idempotencyKey = ulid()): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, idempotencyKey)
      .attach('file', file, { filename: 'catalog.csv', contentType: 'text/csv' });
  }

  function skuByCode(code: string): { id: string } {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`scenario SKU ${code} missing`);
    return { id };
  }

  test('a pre-11.2 SKU row (imported without the columns) reads null everywhere', async () => {
    const legacy = skuIds.get('PRE-112')!;
    const list = await listSkus().expect(200);
    const row = (list.body.items as { code: string; weightGrams: unknown }[]).find((s) => s.code === 'PRE-112');
    expect(row).toBeDefined();
    expect(row!.weightGrams).toBeNull();

    const edited = await patchSku(legacy, { name: 'Legacy shape SKU renamed' }).expect(200);
    expect(edited.body.weightGrams).toBeNull();
    expect(edited.body.lengthMm).toBeNull();
    expect(edited.body.widthMm).toBeNull();
    expect(edited.body.heightMm).toBeNull();
    expect(edited.body.countryOfOrigin).toBeNull();
  });

  test('PATCH sets all five attributes — echoed in the edit response and the list', async () => {
    const created = await importCsv(
      csvFile([{ sku_code: 'ATTR-OK', name: 'Teak shelf', uom: 'pcs', gst_rate: '1800' }]),
    ).expect(201);
    expect(created.body.committedRows).toBe(1);
    const list = await listSkus().expect(200);
    const row = (list.body.items as { code: string; id: string }[]).find((s) => s.code === 'ATTR-OK');
    skuIds.set('ATTR-OK', row!.id);

    const res = await patchSku(row!.id, {
      weightGrams: 500,
      lengthMm: 200,
      widthMm: 150,
      heightMm: 100,
      countryOfOrigin: 'IN',
    }).expect(200);
    // Echoed field-for-field in the edit response…
    expect(res.body).toMatchObject({
      id: row!.id,
      weightGrams: 500,
      lengthMm: 200,
      widthMm: 150,
      heightMm: 100,
      countryOfOrigin: 'IN',
    });
    // …and in the list.
    const after = await listSkus().expect(200);
    const listed = (after.body.items as Record<string, unknown>[]).find((s) => s.code === 'ATTR-OK');
    expect(listed).toMatchObject({
      weightGrams: 500,
      lengthMm: 200,
      widthMm: 150,
      heightMm: 100,
      countryOfOrigin: 'IN',
    });

    // `catalog.sku_edited` emitted as before (a replay appends nothing — the
    // key here is fresh, so exactly one row lands for this edit).
    const events = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId} and type = 'catalog.sku_edited'
    `;
    expect(events[0]?.n).toBeGreaterThan(0);
  });

  test('refuses an out-of-range weight, naming weightGrams (0, -5, over-cap)', async () => {
    const { id } = skuByCode('ATTR-OK');
    for (const weightGrams of [0, -5, 1_000_001]) {
      const res = await patchSku(id, { weightGrams }).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(String(res.body.detail)).toContain('weightGrams');
    }
  });

  test('refuses a fractional dimension, naming lengthMm', async () => {
    const { id } = skuByCode('ATTR-OK');
    const res = await patchSku(id, { lengthMm: 12.5 }).expect(400);
    expect(res.body.code).toBe('validation-failed');
    expect(String(res.body.detail)).toContain('lengthMm');
  });

  test('refuses a dimension below the floor and over the cap, naming the axis', async () => {
    const { id } = skuByCode('ATTR-OK');
    const floor = await patchSku(id, { lengthMm: 0 }).expect(400);
    expect(floor.body.code).toBe('validation-failed');
    expect(String(floor.body.detail)).toContain('lengthMm');

    const overCap = await patchSku(id, { lengthMm: 10_001 }).expect(400);
    expect(overCap.body.code).toBe('validation-failed');
    expect(String(overCap.body.detail)).toContain('lengthMm');
  });

  test("the controller's '' arm clears the origin (the hsn template)", async () => {
    // ATTR-OK carries countryOfOrigin 'IN' from the echo test; an empty
    // string passes the DTO's `@Matches(/^$|^[A-Z]{2}$/)` and the controller
    // maps '' → null — the same edge the hsn '' pin exercises in
    // test/catalog.spec.ts.
    const { id } = skuByCode('ATTR-OK');
    const cleared = await patchSku(id, { countryOfOrigin: '' }).expect(200);
    expect(cleared.body.countryOfOrigin).toBeNull();
  });

  test('refuses a bad country, naming countryOfOrigin ("in" and "IND")', async () => {
    const { id } = skuByCode('ATTR-OK');
    for (const countryOfOrigin of ['in', 'IND']) {
      const res = await patchSku(id, { countryOfOrigin }).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(String(res.body.detail)).toContain('countryOfOrigin');
    }
  });

  test('absent leaves, null clears, and a cleared attribute reads back null', async () => {
    await importCsv(csvFile([{ sku_code: 'ATTR-CLEAR', name: 'Cardboard box', uom: 'pcs', gst_rate: '1800' }])).expect(201);
    const list = await listSkus().expect(200);
    const row = (list.body.items as { code: string; id: string }[]).find((s) => s.code === 'ATTR-CLEAR');
    skuIds.set('ATTR-CLEAR', row!.id);
    await patchSku(row!.id, { weightGrams: 250, countryOfOrigin: 'CN' }).expect(200);

    // Absent = unchanged: a patch touching only the name keeps both.
    const afterAbsent = await patchSku(row!.id, { name: 'Cardboard box renamed' }).expect(200);
    expect(afterAbsent.body.weightGrams).toBe(250);
    expect(afterAbsent.body.countryOfOrigin).toBe('CN');

    // null = cleared: the cleared fields read back null, the untouched one stays.
    const afterClear = await patchSku(row!.id, { weightGrams: null, countryOfOrigin: null }).expect(200);
    expect(afterClear.body.weightGrams).toBeNull();
    expect(afterClear.body.countryOfOrigin).toBeNull();
    expect(afterClear.body.name).toBe('Cardboard box renamed');

    const listed = await listSkus().expect(200);
    const cleared = (listed.body.items as Record<string, unknown>[]).find((s) => s.code === 'ATTR-CLEAR');
    expect(cleared).toMatchObject({ weightGrams: null, countryOfOrigin: null });
  });

  test('refuses an empty patch — the message now names the attribute fields', async () => {
    const { id } = skuByCode('ATTR-OK');
    const res = await patchSku(id, {}).expect(400);
    expect(res.body.code).toBe('validation-failed');
    // 11-3 added productId and variantValues to the optional fields the
    // detail enumerates — an empty body still lists them alongside 11-2's.
    for (const field of [
      'weightGrams',
      'lengthMm',
      'widthMm',
      'heightMm',
      'countryOfOrigin',
      'productId',
      'variantValues',
    ]) {
      expect(String(res.body.detail)).toContain(field);
    }
  });

  test('import lands the attributes; a blank cell is null; a bad value is a per-row error', async () => {
    const run = await importCsv(
      csvFile([
        { sku_code: 'ATTR-IMP-OK', name: 'Imported with attributes', uom: 'pcs', gst_rate: '1800', hsn: '10062020', weight_grams: '1200', length_mm: '600', width_mm: '400', height_mm: '350', country_of_origin: 'CN' },
        { sku_code: 'ATTR-IMP-BAD', name: 'Weight below the floor', uom: 'pcs', gst_rate: '1800', weight_grams: '0' },
        { sku_code: 'ATTR-IMP-FRAC', name: 'Fractional width', uom: 'pcs', gst_rate: '1800', width_mm: '12.5' },
        { sku_code: 'ATTR-IMP-ORIGIN', name: 'Lowercase origin', uom: 'pcs', gst_rate: '1800', country_of_origin: 'in' },
        { sku_code: 'ATTR-IMP-BLANK', name: 'Blank attributes stay null', uom: 'pcs', gst_rate: '1800' },
      ]),
    ).expect(201);
    expect(run.body.committedRows).toBe(2);
    expect(run.body.failedRows).toBe(3);
    const byRow = new Map(
      (run.body.errors as { rowNumber: number; code: string; skuCode: string | null; detail: string }[]).map((e) => [
        e.rowNumber,
        e,
      ]),
    );
    // Row errors are per-row (partial commit stands) and name the refused field.
    expect(byRow.get(2)?.code).toBe('validation-failed');
    expect(byRow.get(2)?.skuCode).toBe('ATTR-IMP-BAD');
    expect(byRow.get(2)?.detail).toContain('weightGrams');
    expect(byRow.get(3)?.skuCode).toBe('ATTR-IMP-FRAC');
    expect(byRow.get(3)?.detail).toContain('widthMm');
    expect(byRow.get(4)?.skuCode).toBe('ATTR-IMP-ORIGIN');
    expect(byRow.get(4)?.detail).toContain('countryOfOrigin');

    const list = await listSkus().expect(200);
    const ok = (list.body.items as Record<string, unknown>[]).find((s) => s.code === 'ATTR-IMP-OK');
    expect(ok).toMatchObject({
      weightGrams: 1200,
      lengthMm: 600,
      widthMm: 400,
      heightMm: 350,
      countryOfOrigin: 'CN',
    });
    const blank = (list.body.items as Record<string, unknown>[]).find((s) => s.code === 'ATTR-IMP-BLANK');
    expect(blank).toMatchObject({
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      countryOfOrigin: null,
    });

    // The failed rows are the fix set — a fix re-submit with corrected values commits.
    const fix = await importCsv(
      csvFile([
        { sku_code: 'ATTR-IMP-BAD', name: 'Weight below the floor', uom: 'pcs', gst_rate: '1800', weight_grams: '800' },
        { sku_code: 'ATTR-IMP-FRAC', name: 'Fractional width', uom: 'pcs', gst_rate: '1800', width_mm: '13' },
        { sku_code: 'ATTR-IMP-ORIGIN', name: 'Lowercase origin', uom: 'pcs', gst_rate: '1800', country_of_origin: 'IN' },
      ]),
      ulid(),
    )
      .field('mode', 'fix')
      .expect(201);
    expect(fix.body.mode).toBe('fix');
    expect(fix.body.committedRows).toBe(3);
    expect(fix.body.failedRows).toBe(0);
    expect(fix.body.skippedRows).toBe(0);
  });

  test('keeps the closed-header contract: an unknown column is still 400 file-unreadable', async () => {
    const res = await importCsv(
      csvFile([{ sku_code: 'ATTR-UNKNOWN', name: 'Tea tin', uom: 'pcs', gst_rate: '1800' }], 'sku_code,name,uom,gst_rate,net_weight_grams'),
    ).expect(400);
    expect(res.body.code).toBe('file-unreadable');
    expect(String(res.body.detail)).toContain('net_weight_grams');
  });

  test('a pre-11.2 edit key (same body, attributes omitted) still replays 200', async () => {
    await importCsv(csvFile([{ sku_code: 'ATTR-REPLAY', name: 'Replay pin SKU', uom: 'pcs', gst_rate: '1800' }])).expect(201);
    const list = await listSkus().expect(200);
    const row = (list.body.items as { code: string; id: string }[]).find((s) => s.code === 'ATTR-REPLAY');
    skuIds.set('ATTR-REPLAY', row!.id);

    // A body exactly as a pre-11.2 client mints it: NO attribute keys at all.
    const legacyBody = { name: 'Replay pin SKU', gstRate: 1800 };
    const key = ulid();
    const first = await patchSku(row!.id, legacyBody, key).expect(200);
    // The replay is a 200 re-serving the snapshot — a hash break would answer
    // 422 idempotency-key-reuse (the 10.2 shape this story deliberately
    // avoids: absent optional keys drop out of the spread hash).
    const replay = await patchSku(row!.id, legacyBody, key).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.body.weightGrams).toBeNull();
  });

  test('the migration CHECKs are the backstop a command cannot bypass', async () => {
    // Direct SQL writes are out of reach of every validator by definition —
    // the CHECKs exist so even those cannot store a zero weight or a
    // lowercase origin. (The row is never committed: each insert throws.)
    await expect(
      sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode, weight_grams)
          values (${uuidv7()}, ${tenantId}, 'CHECK-PROBE-1', 'probe', 'each', 1800, ${`BC-${ulid()}`}, 0)`,
    ).rejects.toThrow(/skus_weight_grams_bounded/);
    await expect(
      sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode, country_of_origin)
          values (${uuidv7()}, ${tenantId}, 'CHECK-PROBE-2', 'probe', 'each', 1800, ${`BC-${ulid()}`}, 'in')`,
    ).rejects.toThrow(/skus_country_of_origin_iso_alpha2/);
    // NULL is legal for every attribute — the unset shape must stay storable.
    await expect(
      sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode, weight_grams, country_of_origin)
          values (${uuidv7()}, ${tenantId}, 'CHECK-PROBE-3', 'probe', 'each', 1800, ${`BC-${ulid()}`}, null, null)`,
    ).resolves.toBeDefined();
  });
});
