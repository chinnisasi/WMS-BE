import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { toMilli } from '../src/shared/primitives/quantity';
import { testAddress } from './support/shipment-address';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { HAZARD_CLASSES } from '../src/shared/primitives/hazard';
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
      // Story 12-1: the class-guard scenarios park stock in bins — the
      // projection goes before the SKUs and bins it points at.
      await cleaner.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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
    // detail enumerates — an empty body still lists them alongside 11-2's;
    // 12-1 appends storageClass the same way; 12-2 appends hazardClass.
    for (const field of [
      'weightGrams',
      'lengthMm',
      'widthMm',
      'heightMm',
      'countryOfOrigin',
      'productId',
      'variantValues',
      'storageClass',
      'hazardClass',
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
    // Story 12-1: the storage-class vocabulary's DB backstop — the HTTP
    // refusals happen in TS (`assertStorageClass` / `@IsIn`), so only a
    // direct out-of-vocabulary write proves the 0035 CHECK exists.
    await expect(
      sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode, storage_class)
          values (${uuidv7()}, ${tenantId}, 'CHECK-PROBE-SC', 'probe', 'each', 1800, ${`BC-${ulid()}`}, 'tropical')`,
    ).rejects.toThrow(/skus_storage_class_check/);
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
    // Story 12-2: the hazard vocabulary's DB backstop — a direct
    // out-of-vocabulary write is 23514; the NULL arm stays storable (null is
    // the unset shape, unlike the NOT NULL storage class — a null insert
    // must SUCCEED here, or the clear verb could not exist).
    await expect(
      sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode, hazard_class)
          values (${uuidv7()}, ${tenantId}, 'CHECK-PROBE-HC', 'probe', 'each', 1800, ${`BC-${ulid()}`}, 'biohazard')`,
    ).rejects.toThrow(/skus_hazard_class_check/);
    await expect(
      sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode, hazard_class)
          values (${uuidv7()}, ${tenantId}, 'CHECK-PROBE-HC2', 'probe', 'each', 1800, ${`BC-${ulid()}`}, null)`,
    ).resolves.toBeDefined();
    // ...and the ACCEPTANCE side: every one of the seven vocabulary values
    // inserts cleanly (the refusal side is the 23514 probe above).
    for (const hazardClass of HAZARD_CLASSES) {
      await expect(
        sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode, hazard_class)
            values (${uuidv7()}, ${tenantId}, ${`CHECK-PROBE-HC-${hazardClass}`}, 'probe', 'each', 1800, ${`BC-${ulid()}`}, ${hazardClass})`,
      ).resolves.toBeDefined();
    }
    // The 0036 migration's shape, read back from the catalog: nullable
    // column, exactly one CHECK carrying the seven-class vocabulary.
    const hazardColumn = await sql`
      select is_nullable from information_schema.columns
      where table_name = 'skus' and column_name = 'hazard_class'`;
    expect(hazardColumn[0]).toMatchObject({ is_nullable: 'YES' });
    const hazardCheck = await sql`
      select conname from pg_constraint
      where conrelid = 'skus'::regclass and conname = 'skus_hazard_class_check'`;
    expect(hazardCheck).toHaveLength(1);
  });

  // ── Story 12-1 — the storage class: import column, edit guard (FR-40) ─────

  test('the import carries storage_class: a classed row lands it, a BLANK cell defaults to ambient (never null — the column is NOT NULL), and a misspelled class is a per-row error', async () => {
    const headerWithClass = `${CSV_HEADER},storage_class`;
    const rowWithClass = (values: Record<string, string>): string =>
      headerWithClass.split(',').map((column) => values[column] ?? '').join(',');
    const fileWithClass = (rows: Record<string, string>[]): Buffer =>
      Buffer.from([headerWithClass, ...rows.map(rowWithClass)].join('\n'), 'utf8');

    const run = await importCsv(
      fileWithClass([
        { sku_code: 'SC-IMP-FRZ', name: 'Imported frozen', uom: 'pcs', gst_rate: '1800', storage_class: 'frozen' },
        { sku_code: 'SC-IMP-BLANK', name: 'Blank class stays ambient', uom: 'pcs', gst_rate: '1800' },
        { sku_code: 'SC-IMP-BAD', name: 'Not a recordable class', uom: 'pcs', gst_rate: '1800', storage_class: 'tropical' },
      ]),
    ).expect(201);
    expect(run.body.committedRows).toBe(2);
    expect(run.body.failedRows).toBe(1);
    const error = (run.body.errors as { rowNumber: number; code: string; skuCode: string | null; detail: string }[])[0]!;
    expect(error.rowNumber).toBe(3);
    expect(error.code).toBe('validation-failed');
    expect(error.skuCode).toBe('SC-IMP-BAD');
    // The row error names the CSV COLUMN the user misspelled, not the
    // command field the validator saw.
    expect(error.detail).toContain('storage_class');

    const list = await listSkus().expect(200);
    const byCode = new Map((list.body.items as { code: string; storageClass: string }[]).map((s) => [s.code, s]));
    expect(byCode.get('SC-IMP-FRZ')!.storageClass).toBe('frozen');
    // The blank-cell semantics: an omitted/empty cell is the DEFAULT class,
    // never a null — every SKU carries a class from birth.
    expect(byCode.get('SC-IMP-BLANK')!.storageClass).toBe('ambient');
  });

  test('the SKU class edit: the vocabulary is closed at the boundary; staged intake stock (a system bin) does not block the first edit; live stock in a non-conforming bin is a 409 naming the bin; an open hold pins its origin bin', async () => {
    // A warehouse of its own: one storage bin through the real surface, and
    // the system Receiving bin with staged stock written directly (this suite
    // has no device/operator — the guard's exclusion of system bins is the
    // point under test, and the real-surface hold/attribution path is
    // bin-admin's coverage).
    const warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `SC-${ulid().slice(10, 16).toUpperCase()}`, name: `Storage Guard Depot ${ulid()}` })
        .expect(201)
    ).body.id as string;
    const zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    const binA = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A-01', capacity: 100, type: 'shelf' })
        .expect(201)
    ).body.id as string;
    const receivingBin = (
      await sql`
        insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${zoneId}, 'RECEIVING', 10000, 'shelf', true)
        returning id`
    )[0] as unknown as { id: string };

    // SC-GUARD imported in the legacy shape (no class column) with THREE
    // units staged in the system Receiving bin — the intake shape. The first
    // class edit MUST pass despite that stock: the guard excludes system
    // bins, or no intake SKU could ever leave ambient.
    await importCsv(
      csvFile([{ sku_code: 'SC-GUARD', name: 'Storage guard SKU', uom: 'pcs', gst_rate: '1800' }]),
    ).expect(201);
    const list = await listSkus().expect(200);
    const guardSku = (list.body.items as { code: string; id: string; storageClass: string }[]).find((s) => s.code === 'SC-GUARD')!;
    expect(guardSku.storageClass).toBe('ambient');
    await sql`
      insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${guardSku.id}, ${receivingBin.id}, ${toMilli(3)})`;

    const firstEdit = await patchSku(guardSku.id, { storageClass: 'frozen' }).expect(200);
    expect(firstEdit.body.storageClass).toBe('frozen');

    // The closed vocabulary, at the command boundary (the DTO mirror refuses
    // the same shape earlier): a misspelled class is a 400 naming the field.
    const bad = await patchSku(guardSku.id, { storageClass: 'tropical' }).expect(400);
    expect(bad.body.code).toBe('validation-failed');
    expect(String(bad.body.detail)).toContain('storageClass');

    // THE STOCK ARM: two units of the frozen SKU parked in the ambient bin
    // (the named adjustment bypass, written directly here) — an edit to a
    // class the bin cannot satisfy is 409 `storage-class-conflict` naming
    // the SKU, the new class, and the offending bin. The class stays put.
    await sql`
      insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${guardSku.id}, ${binA}, ${toMilli(2)})`;
    const stranded = await patchSku(guardSku.id, { storageClass: 'chilled' }).expect(409);
    expect(stranded.body).toMatchObject({ status: 409, code: 'storage-class-conflict' });
    expect(String(stranded.body.detail)).toContain('SC-GUARD');
    expect(String(stranded.body.detail)).toContain('chilled');
    expect(String(stranded.body.detail)).toContain('A-01');
    const unchanged = await listSkus().expect(200);
    expect(
      (unchanged.body.items as { code: string; storageClass: string }[]).find((s) => s.code === 'SC-GUARD')!.storageClass,
    ).toBe('frozen');

    // THE HOLD ARM: the hold moves the bin's stock to the QC bin, so the bin
    // is empty — but the hold pins its ORIGIN bin, and an edit to a class
    // that origin bin cannot satisfy is 409 naming the origin bin and the
    // hold. The same target class as the stock arm's refusal above, now with
    // the bin emptied: only the hold arm is left to refuse.
    const hold = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/qc-holds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: guardSku.id, binId: binA, reason: 'temperature excursion' })
        .expect(201)
    ).body.qcHold as { id: string };
    const heldEdit = await patchSku(guardSku.id, { storageClass: 'chilled' }).expect(409);
    expect(heldEdit.body).toMatchObject({ status: 409, code: 'storage-class-conflict' });
    expect(String(heldEdit.body.detail)).toContain('A-01');
    expect(String(heldEdit.body.detail)).toContain(hold.id);

    // Release returns the stock to the origin bin — and with it the SKU's
    // conformance is restored for the AMBIENT class: the edit the hold was
    // blocking indirectly now passes (the 2 returned units are ambient-class
    // in an ambient bin, and the staged intake stock in the system bin is
    // excluded as ever).
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/qc-holds/${hold.id}/release`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const releasedEdit = await patchSku(guardSku.id, { storageClass: 'ambient' }).expect(200);
    expect(releasedEdit.body.storageClass).toBe('ambient');
  });

  test('the class edit replays: an explicit null is a 400, a class-carrying edit re-serves its snapshot without re-running the guard, and a pre-12.1 snapshot replays with the ambient fallback on a byte-identical legacy digest', async () => {
    // A SKU of its own for the replay arms.
    await importCsv(csvFile([{ sku_code: 'SC-REPLAY', name: 'Replay base', uom: 'pcs', gst_rate: '1800' }])).expect(201);
    const base = (await listSkus().expect(200)).body.items as { code: string; id: string }[];
    const replaySku = base.find((s) => s.code === 'SC-REPLAY')!;

    // The 11-5 `blocked` precedent, SKU side: `storageClass: null` is a 400 —
    // `@IsOptional` skips null, the command treats only `undefined` as
    // absent, and the column is NOT NULL.
    const nulled = await patchSku(replaySku.id, { storageClass: null }).expect(400);
    expect(nulled.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(String(nulled.body.detail)).toContain('storageClass');

    // A class-carrying edit under key K, then stock parked in an ambient bin
    // afterwards (the named adjustment bypass, written directly). The replay
    // must RE-SERVE the snapshot — the guard sits behind the replay lookup,
    // so re-running it here would 409 on the new stock; the 10.2 rule says it
    // must not.
    const key = ulid();
    const first = await patchSku(replaySku.id, { storageClass: 'frozen' }, key).expect(200);
    expect(first.body.storageClass).toBe('frozen');
    const parked = await sql`
      insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
      select ${uuidv7()}, ${tenantId}, b.warehouse_id, ${replaySku.id}, b.id, ${toMilli(2)}
      from bins b
      where b.tenant_id = ${tenantId} and b.system_owned = false
      limit 1
      returning id`;
    expect(parked).toHaveLength(1); // the guard would 409 this state if re-run — the premise must not be vacuous
    const replay = await patchSku(replaySku.id, { storageClass: 'frozen' }, key).expect(200);
    expect(replay.body).toEqual(first.body);

    // Legacy replay: a key whose payload was minted by a pre-12.1 build
    // (name + gstRate only — the hand-computed digest below is what THAT
    // build hashed) and whose stored snapshot predates the column. A
    // hash-shape change would answer 422 idempotency-key-reuse here, not
    // 200; a missing fallback would omit the required `storageClass` field.
    await importCsv(csvFile([{ sku_code: 'SC-LEGACY-12', name: 'Legacy digest', uom: 'pcs', gst_rate: '1800' }])).expect(201);
    const legacyItems = (await listSkus().expect(200)).body.items as {
      code: string;
      id: string;
    }[];
    const legacySku = legacyItems.find((s) => s.code === 'SC-LEGACY-12')!;
    const legacyKey = ulid();
    const legacyHash = hashCommandPayload({
      tenantId,
      skuId: legacySku.id,
      name: 'Legacy digest',
      gstRateBps: 1800,
      // NOTE the absence: a pre-12.1 build had no `storageClass` key to emit.
      // `JSON.stringify` drops it on today's build too (absent = unchanged),
      // which is exactly what makes the two builds hash the same bytes.
    });
    const legacySnapshot = {
      id: legacySku.id,
      tenantId,
      code: 'SC-LEGACY-12',
      name: 'Legacy digest',
      uom: 'pcs',
      uomPrecision: 0,
      gstRateBps: 1800,
      hsn: null,
      batchTracked: false,
      serialTracked: false,
      catchWeightTracked: false,
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      countryOfOrigin: null,
      productId: null,
      variantValues: null,
      barcode: `BC-${ulid()}`,
      // A real pre-12.1 snapshot carried the replenishment fields (SkuSnapshot
      // has had them since 10.1) and the conversions (since the edit command
      // first served a snapshot); the mapper at the edge maps them.
      reorderPoint: 0,
      reorderQty: 0,
      uomConversions: [],
    };
    const seed = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await seed`
        insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (${uuidv7()}, ${tenantId}, ${legacyKey}, ${legacyHash}, ${seed.json(legacySnapshot)})`;
    } finally {
      await seed.end();
    }
    const legacyReplay = await patchSku(legacySku.id, { name: 'Legacy digest', gstRate: 1800 }, legacyKey).expect(200);
    expect(legacyReplay.body).toMatchObject({
      id: legacySku.id,
      storageClass: 'ambient',
      // Story 12-2: the same fallback pattern one layer deeper — the
      // pre-12.1 snapshot carries no hazard class, and the replay pins the
      // REQUIRED `hazardClass` field to null.
      hazardClass: null,
    });
  });

  // ── Story 12-2 — the hazard class: import column, edit guard (FR-41) ───────

  test('the import carries hazard_class: a classed row lands it, a BLANK cell is null (the 11.2 attribute blank semantics — the column is nullable), and a misspelled class is a per-row error', async () => {
    const headerWithHazard = `${CSV_HEADER},hazard_class`;
    const rowWithHazard = (values: Record<string, string>): string =>
      headerWithHazard.split(',').map((column) => values[column] ?? '').join(',');
    const fileWithHazard = (rows: Record<string, string>[]): Buffer =>
      Buffer.from([headerWithHazard, ...rows.map(rowWithHazard)].join('\n'), 'utf8');

    const run = await importCsv(
      fileWithHazard([
        { sku_code: 'HC-IMP-FL', name: 'Imported flammable', uom: 'pcs', gst_rate: '1800', hazard_class: 'flammable' },
        { sku_code: 'HC-IMP-BLANK', name: 'Blank class stays null', uom: 'pcs', gst_rate: '1800' },
        { sku_code: 'HC-IMP-BAD', name: 'Not a recordable class', uom: 'pcs', gst_rate: '1800', hazard_class: 'biohazard' },
      ]),
    ).expect(201);
    expect(run.body.committedRows).toBe(2);
    expect(run.body.failedRows).toBe(1);
    const error = (run.body.errors as { rowNumber: number; code: string; skuCode: string | null; detail: string }[])[0]!;
    expect(error.rowNumber).toBe(3);
    expect(error.code).toBe('validation-failed');
    expect(error.skuCode).toBe('HC-IMP-BAD');
    // The row error names the CSV COLUMN the user misspelled, not the
    // command field the validator saw.
    expect(error.detail).toContain('hazard_class');

    const list = await listSkus().expect(200);
    const byCode = new Map((list.body.items as { code: string; id: string; hazardClass: string | null }[]).map((s) => [s.code, s]));
    expect(byCode.get('HC-IMP-FL')!.hazardClass).toBe('flammable');
    // The blank-cell semantics: an omitted/empty cell is NULL — unlike the
    // NOT NULL storage class, a hazard class is an attribute, not a default.
    expect(byCode.get('HC-IMP-BLANK')!.hazardClass).toBeNull();
    for (const code of ['HC-IMP-FL', 'HC-IMP-BLANK']) {
      skuIds.set(code, byCode.get(code)!.id);
    }
  });

  test('the SKU hazard edit: the vocabulary is closed at the boundary; its OWN stock in a bin never blocks the edit; a binmate of a segregated class is a 409 naming the bin and the binmate; a compatible class edits over the same stock; null ALWAYS clears; an open hold pins its origin bin', async () => {
    // A warehouse of its own (the 12-1 guard test's shape): one storage bin
    // through the real surface, and the system Receiving bin with staged
    // intake stock written directly (this suite has no device/operator).
    const warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `HC-${ulid().slice(10, 16).toUpperCase()}`, name: `Hazard Guard Depot ${ulid()}` })
        .expect(201)
    ).body.id as string;
    const zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    const hazardBin = async (code: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, capacity: 100, type: 'shelf' })
          .expect(201)
      ).body.id as string;
    const binA = await hazardBin('A-01');
    const receivingBin = (
      await sql`
        insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${zoneId}, 'RECEIVING', 10000, 'shelf', true)
        returning id`
    )[0] as unknown as { id: string };

    await importCsv(
      csvFile([
        { sku_code: 'HC-GUARD', name: 'Hazard guard SKU', uom: 'pcs', gst_rate: '1800' },
        { sku_code: 'HC-BM', name: 'Hazard binmate SKU', uom: 'pcs', gst_rate: '1800' },
      ]),
    ).expect(201);
    const list = await listSkus().expect(200);
    const byCode = new Map((list.body.items as { code: string; id: string }[]).map((s) => [s.code, s.id]));
    const guardSkuId = byCode.get('HC-GUARD')!;
    const binmateSkuId = byCode.get('HC-BM')!;
    skuIds.set('HC-GUARD', guardSkuId);
    skuIds.set('HC-BM', binmateSkuId);

    // Intake shape: THREE staged units in the system Receiving bin BEFORE the
    // first class is set. The edit MUST pass — the guard excludes system
    // bins, or no intake SKU could ever take a class.
    await sql`
      insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${guardSkuId}, ${receivingBin.id}, ${toMilli(3)})`;

    // The closed vocabulary, at the command boundary (the DTO mirror refuses
    // the same shape earlier): a misspelled class is a 400 naming the field.
    const bad = await patchSku(guardSkuId, { hazardClass: 'biohazard' }).expect(400);
    expect(bad.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(String(bad.body.detail)).toContain('hazardClass');

    // FIRST SET + THE OWN-SKU SKIP: two units of the SKU itself parked in
    // `A-01` (the named adjustment bypass, written directly). Assigning its
    // FIRST class must pass — a bin whose only occupants are the SKU's own
    // units can never segregate from itself.
    await sql`
      insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${guardSkuId}, ${binA}, ${toMilli(2)})`;
    const firstSet = await patchSku(guardSkuId, { hazardClass: 'explosive' }).expect(200);
    expect(firstSet.body.hazardClass).toBe('explosive');

    // THE STOCK ARM: an oxidizer binmate arrives in the same bin (the
    // binmate takes its class while stockless — its own guard has nothing to
    // strand) — now the
    // change to `flammable` (the class the review loopback's oxidiser/fuel
    // example pins) would strand live stock beside a segregated class: 409
    // `hazard-segregation-conflict` naming the bin, the binmate and both
    // classes. The class stays put.
    await patchSku(binmateSkuId, { hazardClass: 'oxidizer' }).expect(200);
    await sql`
      insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${binmateSkuId}, ${binA}, ${toMilli(1)})`;
    const stranded = await patchSku(guardSkuId, { hazardClass: 'flammable' }).expect(409);
    expect(stranded.body).toMatchObject({ status: 409, code: 'hazard-segregation-conflict' });
    expect(String(stranded.body.detail)).toContain('HC-GUARD');
    expect(String(stranded.body.detail)).toContain('flammable');
    expect(String(stranded.body.detail)).toContain('A-01');
    expect(String(stranded.body.detail)).toContain('HC-BM');
    expect(String(stranded.body.detail)).toContain('oxidizer');
    const unchanged = await listSkus().expect(200);
    expect(
      (unchanged.body.items as { code: string; hazardClass: string | null }[]).find((s) => s.code === 'HC-GUARD')!.hazardClass,
    ).toBe('explosive');

    // THE NO-OP SKIP: re-patching the SAME class with the same incompatible
    // binmate present is 200 — the guard body runs only on a CHANGE (a
    // same-class edit strands nothing new).
    const noOp = await patchSku(guardSkuId, { hazardClass: 'explosive' }).expect(200);
    expect(noOp.body.hazardClass).toBe('explosive');

    // BOTH class fields in one body: the 12-1 storage-class gate passes (an
    // explicit `ambient` is the SKU's current class — the field locks, its
    // guard body skips) and the 12-2 hazard gate refuses — the guards run
    // in their fixed order and the whole patch commits nothing.
    const mixed = await patchSku(guardSkuId, { storageClass: 'ambient', hazardClass: 'flammable' }).expect(409);
    expect(mixed.body).toMatchObject({ status: 409, code: 'hazard-segregation-conflict' });
    expect(String(mixed.body.detail)).toContain('A-01');
    const stillExplosive = await listSkus().expect(200);
    const stillRow = (stillExplosive.body.items as { code: string; hazardClass: string | null; storageClass: string }[]).find((s) => s.code === 'HC-GUARD')!;
    expect(stillRow.hazardClass).toBe('explosive');
    expect(stillRow.storageClass).toBe('ambient'); // the storage arm was not applied either — nothing committed

    // THE PREDICATE, NOT A BLANKET: a COMPATIBLE class edits over the SAME
    // stock (explosive beside toxic is a decided-compatible pair) — 200.
    const compatible = await patchSku(guardSkuId, { hazardClass: 'toxic' }).expect(200);
    expect(compatible.body.hazardClass).toBe('toxic');

    // THE CLEAR VERB: `null` ALWAYS succeeds — clearing carries no new rule
    // for any bin the SKU sits in — and reads back null.
    const cleared = await patchSku(guardSkuId, { hazardClass: null }).expect(200);
    expect(cleared.body.hazardClass).toBeNull();

    // THE HOLD ARM: the hold moves the bin's stock to the QC bin (a SYSTEM
    // bin — excluded from the stock scan), so the bin the SKU itself stocks
    // is `A-02` only… but the hold pins its ORIGIN bin, and an edit to a
    // class that origin bin's REMAINING binmate segregates from is 409
    // naming the origin bin, the binmate and the HOLD id (triage #15).
    const hold = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/qc-holds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: guardSkuId, binId: binA, reason: 'leaking drum' })
        .expect(201)
    ).body.qcHold as { id: string };
    const heldEdit = await patchSku(guardSkuId, { hazardClass: 'explosive' }).expect(409);
    expect(heldEdit.body).toMatchObject({ status: 409, code: 'hazard-segregation-conflict' });
    expect(String(heldEdit.body.detail)).toContain(hold.id);
    expect(String(heldEdit.body.detail)).toContain('A-01');
    expect(String(heldEdit.body.detail)).toContain('HC-BM');
    expect(String(heldEdit.body.detail)).toContain('oxidizer');
    expect(String(heldEdit.body.detail)).toContain('explosive');

    // Release returns the stock to the origin bin — the stock arm is live
    // again (the same edit refuses, now from the bin row itself), and a
    // compatible class still edits over the same stock.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/qc-holds/${hold.id}/release`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const releasedRefusal = await patchSku(guardSkuId, { hazardClass: 'explosive' }).expect(409);
    expect(String(releasedRefusal.body.detail)).toContain('A-01');
    const releasedEdit = await patchSku(guardSkuId, { hazardClass: 'corrosive-base' }).expect(200);
    expect(releasedEdit.body.hazardClass).toBe('corrosive-base');
  });

  test('the hazard edit replays: a class-carrying edit re-serves its snapshot without re-running the guard, and a pre-12.2 snapshot (post-12.1 shape) replays with the null fallback on a byte-identical legacy digest', async () => {
    // A SKU of its own for the replay arms, plus its future binmate.
    await importCsv(
      csvFile([
        { sku_code: 'HC-REPLAY', name: 'Hazard replay base', uom: 'pcs', gst_rate: '1800' },
        { sku_code: 'HC-RBM', name: 'Hazard replay binmate', uom: 'pcs', gst_rate: '1800' },
      ]),
    ).expect(201);
    const items = (await listSkus().expect(200)).body.items as { code: string; id: string }[];
    const replaySku = items.find((s) => s.code === 'HC-REPLAY')!;
    const replayBinmate = items.find((s) => s.code === 'HC-RBM')!;
    await patchSku(replayBinmate.id, { hazardClass: 'oxidizer' }).expect(200);

    // A class-carrying edit under key K, then stock parked afterwards in a
    // non-system bin TOGETHER with a segregated binmate (written directly —
    // the named adjustment bypass shape). The replay must RE-SERVE the
    // snapshot — the hazard guard sits behind the replay lookup, so
    // re-running it would 409 on flammable-vs-oxidizer; the 10.2 rule says
    // it must not.
    const key = ulid();
    const first = await patchSku(replaySku.id, { hazardClass: 'flammable' }, key).expect(200);
    expect(first.body.hazardClass).toBe('flammable');
    const parkedBin = (
      await sql`
        insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
        select ${uuidv7()}, ${tenantId}, b.warehouse_id, x.sku_id, b.id, x.qty
        from bins b,
             (values (${replaySku.id}::uuid, ${toMilli(2)}::bigint), (${replayBinmate.id}::uuid, ${toMilli(1)}::bigint)) as x(sku_id, qty)
        where b.tenant_id = ${tenantId} and b.system_owned = false
        limit 1
        returning id`
    ) as unknown as { id: string }[];
    expect(parkedBin).toHaveLength(1); // the guard would 409 this state if re-run — the premise must not be vacuous
    const replay = await patchSku(replaySku.id, { hazardClass: 'flammable' }, key).expect(200);
    expect(replay.body).toEqual(first.body);

    // Legacy replay: a key whose payload was minted by a pre-12.2 build
    // (name + gstRate only — the hand-computed digest below is what THAT
    // build hashed) and whose stored snapshot predates the 12-2 column but
    // carries the 12-1 `storageClass`. A hash-shape change would answer 422
    // idempotency-key-reuse here, not 200; a missing fallback would omit the
    // required `hazardClass` field.
    await importCsv(csvFile([{ sku_code: 'HC-LEGACY-22', name: 'Legacy digest 22', uom: 'pcs', gst_rate: '1800' }])).expect(201);
    const legacyItems = (await listSkus().expect(200)).body.items as { code: string; id: string }[];
    const legacySku = legacyItems.find((s) => s.code === 'HC-LEGACY-22')!;
    const legacyKey = ulid();
    const legacyHash = hashCommandPayload({
      tenantId,
      skuId: legacySku.id,
      name: 'Legacy digest 22',
      gstRateBps: 1800,
      // NOTE the absence: a pre-12.2 build had no `hazardClass` key to emit.
      // `JSON.stringify` drops it on today's build too (absent = unchanged),
      // which is exactly what makes the two builds hash the same bytes.
    });
    const legacySnapshot = {
      id: legacySku.id,
      tenantId,
      code: 'HC-LEGACY-22',
      name: 'Legacy digest 22',
      uom: 'pcs',
      uomPrecision: 0,
      gstRateBps: 1800,
      hsn: null,
      batchTracked: false,
      serialTracked: false,
      catchWeightTracked: false,
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      countryOfOrigin: null,
      productId: null,
      variantValues: null,
      storageClass: 'ambient', // a post-12.1 build served the class — only the hazard column is new here
      barcode: `BC-${ulid()}`,
      reorderPoint: 0,
      reorderQty: 0,
      uomConversions: [],
    };
    const seed = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await seed`
        insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (${uuidv7()}, ${tenantId}, ${legacyKey}, ${legacyHash}, ${seed.json(legacySnapshot)})`;
    } finally {
      await seed.end();
    }
    const legacyReplay = await patchSku(legacySku.id, { name: 'Legacy digest 22', gstRate: 1800 }, legacyKey).expect(200);
    expect(legacyReplay.body).toMatchObject({
      id: legacySku.id,
      storageClass: 'ambient',
      hazardClass: null,
    });
  });
});
