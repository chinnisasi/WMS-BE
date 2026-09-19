import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
 * Story 11-3 — the product (AD-19) and the SKU's variant attachment, driven
 * over the I/O matrix in the spec:
 *
 * | Scenario | Pinned by |
 * |---|---|
 * | create product → 201, echoed, `catalog.product_created` | `create echoes` |
 * | product-create replay (no duplicate event) | `create echoes` |
 * | duplicate name → 409 `duplicate-product-name` | `refuses a duplicate name` |
 * | product list, keyset, items carry skuCount | `list is keyset-paged` |
 * | attach via SKU PATCH → echoed in edit + list, `catalog.sku_edited` | `attaches a variant` |
 * | values mismatch → 400 naming variantValues + the axis | `refuses a mismatch` |
 * | duplicate variant → 409, nothing written | `refuses a duplicate variant` |
 * | detach → both read null; re-value; no values riding a detach | `detaches` |
 * | pre-11.3 replay (SKU edit) | `a pre-11.3 edit key` |
 * | import with product/variant_values; blank → unattached; row errors | `import lands the attachment` |
 * | unknown column still 400 file-unreadable | `keeps the closed-header contract` |
 * | axes edit attached → 409 `product-has-variants`; skuCount 0 → 200 | the axes-edit pair |
 * | empty product edit → `empty-product-edit` | `list is keyset-paged` |
 * | CHECK probe: variant_values pairs with product_id | `the migration CHECK is the backstop` |
 * | RLS on products | `RLS on products` |
 * | OpenAPI paths | `the OpenAPI document exposes` |
 */
describe('product variants (e2e, story 11-3)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  const skuIds = new Map<string, string>();
  const productIds = new Map<string, string>();

  let suiteDb: SuiteDatabase;

  /** The full documented header INCLUDING the 11.3 variant columns. */
  const CSV_HEADER = 'sku_code,name,uom,gst_rate,product,variant_values,barcode';

  function csvRow(values: Record<string, string>, header: string): string {
    return header
      .split(',')
      .map((column) => values[column] ?? '')
      .join(',');
  }

  function csvFile(rows: Record<string, string>[], header = CSV_HEADER): Buffer {
    return Buffer.from([header, ...rows.map((row) => csvRow(row, header))].join('\n'), 'utf8');
  }

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('products');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });

    // ── tenant + owner ─────────────────────────────────────────────────────
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Variants Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email, password: 'correct-horse-battery' })
      .expect(200)
      .then((res) => res.body.accessToken as string);

    // ── scenario SKUs, imported the pre-11.3 way (no product columns — every
    //    one starts unattached, productId/variantValues null) ───────────────
    await importCsv(
      csvFile(
        [
          { sku_code: 'VAR-A', name: 'Variant A', uom: 'pcs', gst_rate: '1800' },
          { sku_code: 'VAR-B', name: 'Variant B', uom: 'pcs', gst_rate: '1800' },
          { sku_code: 'VAR-C', name: 'Variant C', uom: 'pcs', gst_rate: '1800' },
          { sku_code: 'VAR-PLAIN', name: 'Plain edit target', uom: 'pcs', gst_rate: '1800' },
        ],
        'sku_code,name,uom,gst_rate,barcode',
      ),
    ).expect(201);
    const list = await listSkus().expect(200);
    for (const item of list.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }
    for (const code of ['VAR-A', 'VAR-B', 'VAR-C', 'VAR-PLAIN']) {
      expect(skuIds.get(code)).toBeDefined();
    }
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
      // Children before parents: errors → runs → conversions → skus → products.
      await cleaner.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM products WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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

  function listProducts(): request.Test {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/products`)
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  function patchSku(skuId: string, body: Record<string, unknown>, idempotencyKey = ulid()): request.Test {
    return request(app.getHttpServer())
      .patch(`${API}/${tenantId}/catalog/skus/${skuId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, idempotencyKey)
      .send(body);
  }

  function createProduct(body: Record<string, unknown>, idempotencyKey = ulid()): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/products`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, idempotencyKey)
      .send(body);
  }

  function patchProduct(productId: string, body: Record<string, unknown>, idempotencyKey = ulid()): request.Test {
    return request(app.getHttpServer())
      .patch(`${API}/${tenantId}/catalog/products/${productId}`)
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

  async function createScenarioProduct(
    name: string,
    axes: string[] = ['size', 'colour'],
  ): Promise<{ id: string; name: string; axes: string[] }> {
    const res = await createProduct({ name, axes }).expect(201);
    productIds.set(name, res.body.id as string);
    return res.body as { id: string; name: string; axes: string[] };
  }

  function skuByCode(code: string): { id: string } {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`scenario SKU ${code} missing`);
    return { id };
  }

  function listedByCode(items: Record<string, unknown>[], code: string): Record<string, unknown> {
    const row = items.find((item) => item.code === code);
    expect(row).toBeDefined();
    return row!;
  }

  // ── product create ────────────────────────────────────────────────────────

  test('create echoes the product; a matching key replays with no duplicate event', async () => {
    const res = await createProduct({ name: 'Oversized Tee', axes: ['size', 'colour'] }).expect(201);
    expect(res.body).toMatchObject({
      name: 'Oversized Tee',
      axes: ['size', 'colour'],
      skuCount: 0,
    });
    expect(typeof res.body.id).toBe('string');
    productIds.set('Oversized Tee', res.body.id as string);

    const created = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId} and type = 'catalog.product_created'
        and payload->>'name' = 'Oversized Tee'
    `;
    expect(created[0]?.n).toBe(1);

    // A matching key + payload replays the snapshot with no duplicate event
    // (the createOrder convention the spec pins for products too).
    const key = ulid();
    const first = await createProduct({ name: 'Replayed Tee', axes: ['size'] }, key).expect(201);
    productIds.set('Replayed Tee', first.body.id as string);
    const replay = await createProduct({ name: 'Replayed Tee', axes: ['size'] }, key).expect(201);
    expect(replay.body).toEqual(first.body);
    const both = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId} and type = 'catalog.product_created'
        and payload->>'name' = 'Replayed Tee'
    `;
    expect(both[0]?.n).toBe(1);
  });

  test('refuses a duplicate product name (pre-check and edit arm share one code)', async () => {
    const res = await createProduct({ name: 'Oversized Tee', axes: ['colour'] }).expect(409);
    expect(res.body.code).toBe('duplicate-product-name');
    expect(String(res.body.detail)).toContain('Oversized Tee');

    // The edit arm: renaming onto another product's name is the same 409.
    const tee = productIds.get('Oversized Tee')!;
    const dup = await patchProduct(tee, { name: 'Replayed Tee' }).expect(409);
    expect(dup.body.code).toBe('duplicate-product-name');
  });

  test('list is keyset-paged (items carry skuCount); an empty product edit is its own error', async () => {
    const list = await listProducts().expect(200);
    const items = list.body.items as { name: string; skuCount: number; axes: string[] }[];
    expect(items.map((item) => item.name)).toEqual(
      expect.arrayContaining(['Oversized Tee', 'Replayed Tee']),
    );
    expect(items.every((item) => item.skuCount === 0)).toBe(true);

    const over = await createProduct({ name: 'Four axes', axes: ['a', 'b', 'c', 'd'] }).expect(400);
    expect(over.body.code).toBe('validation-failed');
    expect(String(over.body.detail)).toContain('axes');

    const empty = await patchProduct(productIds.get('Replayed Tee')!, {}).expect(400);
    expect(empty.body.code).toBe('empty-product-edit');
  });

  // ── the SKU-side attach ───────────────────────────────────────────────────

  test('attaches a variant via the SKU PATCH — echoed in edit + list, counted in the product list', async () => {
    const tee = productIds.get('Oversized Tee')!;
    const { id: skuA } = skuByCode('VAR-A');

    const attached = await patchSku(skuA, {
      productId: tee,
      variantValues: { size: 'M', colour: 'Red' },
    }).expect(200);
    expect(attached.body).toMatchObject({
      id: skuA,
      productId: tee,
      variantValues: { size: 'M', colour: 'Red' },
    });

    // …and in the list.
    const items = (await listSkus().expect(200)).body.items as Record<string, unknown>[];
    expect(listedByCode(items, 'VAR-A').productId).toBe(tee);
    expect(listedByCode(items, 'VAR-A').variantValues).toEqual({ size: 'M', colour: 'Red' });

    // Unattached siblings still read null (every pre-11.3 row reads this way).
    expect(listedByCode(items, 'VAR-PLAIN').productId).toBeNull();
    expect(listedByCode(items, 'VAR-PLAIN').variantValues).toBeNull();

    // `catalog.sku_edited` still the edit's event (no new variant event type —
    // nothing below the catalog learns what a variant is).
    const events = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId} and type = 'catalog.sku_edited'
        and payload->>'skuId' = ${skuA}
    `;
    expect(events[0]?.n).toBe(1);

    // The product list's skuCount is DERIVED — now 1.
    const products = (await listProducts().expect(200)).body.items as { id: string; skuCount: number }[];
    expect(products.find((p) => p.id === tee)!.skuCount).toBe(1);
  });

  test('refuses a mismatch: missing axis, unknown key, blank value, non-string, values without a product', async () => {
    const tee = productIds.get('Oversized Tee')!;
    const { id: skuB } = skuByCode('VAR-B');

    const cases: { body: Record<string, unknown>; axis: string }[] = [
      // Missing an axis entirely.
      { body: { productId: tee, variantValues: { size: 'L' } }, axis: 'colour' },
      // An unknown key.
      { body: { productId: tee, variantValues: { size: 'M', colour: 'Red', fit: 'loose' } }, axis: 'fit' },
      // A blank value.
      { body: { productId: tee, variantValues: { size: 'M', colour: '  ' } }, axis: 'colour' },
      // A non-string value.
      { body: { productId: tee, variantValues: { size: 'M', colour: 5 } }, axis: 'colour' },
    ];
    for (const { body, axis } of cases) {
      const res = await patchSku(skuB, body).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(String(res.body.detail)).toContain('variantValues');
      expect(String(res.body.detail)).toContain(axis);
    }
    // Nothing was written — VAR-B is still unattached after all four refusals.
    const still = (await listSkus().expect(200)).body.items as Record<string, unknown>[];
    expect(listedByCode(still, 'VAR-B').productId).toBeNull();
    expect(listedByCode(still, 'VAR-B').variantValues).toBeNull();

    // variantValues without productId: a values-only move on an unattached
    // SKU has no axes to cover.
    const orphan = await patchSku(skuB, { variantValues: { size: 'M', colour: 'Red' } }).expect(400);
    expect(orphan.body.code).toBe('validation-failed');
    expect(String(orphan.body.detail)).toContain('variantValues');

    // Attaching with NO values at all is refused, naming the axes.
    const noValues = await patchSku(skuB, { productId: tee }).expect(400);
    expect(noValues.body.code).toBe('validation-failed');
    expect(String(noValues.body.detail)).toContain('size');

    // A 404 arm: attaching to a product that does not exist in this tenant.
    const ghost = await patchSku(skuB, {
      productId: uuidv7(),
      variantValues: { size: 'M', colour: 'Red' },
    }).expect(404);
    expect(ghost.body.code).toBe('not-found');
  });

  test('refuses a duplicate variant — nothing is written, the values stay with their SKU', async () => {
    const tee = productIds.get('Oversized Tee')!;
    const { id: skuB } = skuByCode('VAR-B');
    const { id: skuC } = skuByCode('VAR-C');

    // VAR-A already holds M/Red (the attach test); VAR-B takes a different
    // pair, then VAR-C is refused the identical pair (the spec's acceptance:
    // a third SKU reusing values is refused 409).
    await patchSku(skuB, { productId: tee, variantValues: { size: 'L', colour: 'Blue' } }).expect(200);
    const dup = await patchSku(skuC, {
      productId: tee,
      variantValues: { size: 'L', colour: 'Blue' },
    }).expect(409);
    expect(dup.body.code).toBe('duplicate-variant-values');
    expect(String(dup.body.detail)).toContain('VAR-B');

    // Nothing was written: VAR-C is still unattached.
    const still = (await listSkus().expect(200)).body.items as Record<string, unknown>[];
    expect(listedByCode(still, 'VAR-C').productId).toBeNull();
    expect(listedByCode(still, 'VAR-C').variantValues).toBeNull();

    // Distinct values attach fine — and the product now counts three variants
    // (the spec's acceptance criterion, one variant per distinct values set).
    await patchSku(skuC, { productId: tee, variantValues: { size: 'S', colour: 'Green' } }).expect(200);
    const products = (await listProducts().expect(200)).body.items as { id: string; skuCount: number }[];
    expect(products.find((p) => p.id === tee)!.skuCount).toBe(3);
  });

  test('detaches: variantValues are cleared with it, and the SKU can re-attach with new values', async () => {
    const tee = productIds.get('Oversized Tee')!;
    const { id: skuC } = skuByCode('VAR-C');

    const detached = await patchSku(skuC, { productId: null }).expect(200);
    expect(detached.body.productId).toBeNull();
    expect(detached.body.variantValues).toBeNull();

    // The product count falls back to 2 (VAR-A and VAR-B still attached).
    const products = (await listProducts().expect(200)).body.items as { id: string; skuCount: number }[];
    expect(products.find((p) => p.id === tee)!.skuCount).toBe(2);

    // Re-attach with DIFFERENT values is a fresh variant (the duplicate rule
    // compares values, not history).
    await patchSku(skuC, { productId: tee, variantValues: { colour: 'Green', size: 'XL' } }).expect(200);

    // A values-only patch re-values against the CURRENT attachment.
    const reValued = await patchSku(skuC, { variantValues: { size: 'XL', colour: 'Black' } }).expect(200);
    expect(reValued.body.productId).toBe(tee);
    expect(reValued.body.variantValues).toEqual({ size: 'XL', colour: 'Black' });

    // variantValues cannot ride a detach — the mistake is refused, not
    // silently dropped.
    const ride = await patchSku(skuC, { productId: null, variantValues: { size: 'S' } }).expect(400);
    expect(ride.body.code).toBe('validation-failed');
  });

  test('a pre-11.3 edit key (same body, variant keys omitted) still replays 200', async () => {
    const { id } = skuByCode('VAR-PLAIN');
    // A body exactly as a pre-11.3 client mints it: NO productId/variantValues
    // keys at all. The replay is a 200 re-serving the snapshot — a hash break
    // would answer 422 idempotency-key-reuse (the 10.2 shape this story
    // deliberately avoids: absent optional keys drop out of the spread hash).
    const legacyBody = { name: 'Plain edit target', gstRate: 1800 };
    const key = ulid();
    const first = await patchSku(id, legacyBody, key).expect(200);
    const replay = await patchSku(id, legacyBody, key).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.body.productId).toBeNull();
  });

  // ── product edit ──────────────────────────────────────────────────────────

  test('axes edit with variants attached → 409 product-has-variants; with none → 200', async () => {
    // A fresh product nobody attached to — axes are freely re-declared.
    const free = await createScenarioProduct('Axis-free Tee', ['size']);
    const renamed = await patchProduct(free.id, { axes: ['fit'], name: 'Axis-free Tee v2' }).expect(200);
    expect(renamed.body.axes).toEqual(['fit']);
    expect(renamed.body.name).toBe('Axis-free Tee v2');
    expect(renamed.body.skuCount).toBe(0);
    // `catalog.product_edited` landed for the rename.
    const edited = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId} and type = 'catalog.product_edited'
        and payload->>'productId' = ${free.id}
    `;
    expect(edited[0]?.n).toBe(1);

    // The attached product's axes are frozen — even a REORDERED array is a
    // different declaration (element-wise comparison, not set equality).
    const tee = productIds.get('Oversized Tee')!;
    const refused = await patchProduct(tee, { axes: ['colour', 'size'] }).expect(409);
    expect(refused.body.code).toBe('product-has-variants');
    // The name alone stays editable on the attached product.
    await patchProduct(tee, { name: 'Oversized Tee Classic' }).expect(200);
    productIds.set('Oversized Tee Classic', tee);
    productIds.delete('Oversized Tee');
  });

  test('product edit replay: the same key + payload re-serves the snapshot with no duplicate event', async () => {
    const tee = productIds.get('Oversized Tee Classic')!;
    const key = ulid();
    const first = await patchProduct(tee, { name: 'Oversized Tee Renamed' }, key).expect(200);
    productIds.set('Oversized Tee Renamed', tee);
    productIds.delete('Oversized Tee Classic');
    const replay = await patchProduct(tee, { name: 'Oversized Tee Renamed' }, key).expect(200);
    expect(replay.body).toEqual(first.body);
    const events = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId} and type = 'catalog.product_edited'
        and payload->>'productId' = ${tee} and payload->>'name' = 'Oversized Tee Renamed'
    `;
    expect(events[0]?.n).toBe(1);
  });

  // ── import with the variant columns ───────────────────────────────────────

  test('import lands the attachment; blank cells stay unattached; row errors name the refusal', async () => {
    await createScenarioProduct('Imported Tee', ['size', 'colour']);
    await createScenarioProduct('One Axis Tee', ['size']);

    const run = await importCsv(
      csvFile([
        // Attached — the happy path.
        { sku_code: 'IMP-VAR-1', name: 'Imported variant M', uom: 'pcs', gst_rate: '1800', product: 'Imported Tee', variant_values: 'size=M; colour=Red' },
        // Blank product + blank values → unattached, the pre-11.3 shape.
        { sku_code: 'IMP-PLAIN', name: 'Imported plain', uom: 'pcs', gst_rate: '1800' },
        // Values without a product → refused at parse time.
        { sku_code: 'IMP-VALUES-NO-PRODUCT', name: 'Values ride a product', uom: 'pcs', gst_rate: '1800', variant_values: 'size=M' },
        // A product cell without values → the coverage check refuses.
        { sku_code: 'IMP-PRODUCT-NO-VALUES', name: 'Missing values', uom: 'pcs', gst_rate: '1800', product: 'Imported Tee' },
        // The referenced product does not exist → import references, never creates.
        { sku_code: 'IMP-GHOST', name: 'Ghost product', uom: 'pcs', gst_rate: '1800', product: 'No Such Tee', variant_values: 'size=M' },
        // The values do not cover the referenced product's axes.
        { sku_code: 'IMP-MISMATCH', name: 'Axis mismatch', uom: 'pcs', gst_rate: '1800', product: 'One Axis Tee', variant_values: 'size=M; colour=Red' },
        // File-internal duplicate: the first claim commits…
        { sku_code: 'IMP-DUP-1', name: 'First claim', uom: 'pcs', gst_rate: '1800', product: 'Imported Tee', variant_values: 'size=S; colour=White' },
        // …the identical second claim is a row error naming the earlier row.
        { sku_code: 'IMP-DUP-2', name: 'Second claim', uom: 'pcs', gst_rate: '1800', product: 'Imported Tee', variant_values: 'size=S; colour=White' },
        // A cell with no `=` → refused at parse time.
        { sku_code: 'IMP-BAD-CELL', name: 'Bad cell grammar', uom: 'pcs', gst_rate: '1800', product: 'Imported Tee', variant_values: 'size M' },
      ]),
    ).expect(201);
    expect(run.body.committedRows).toBe(3);
    expect(run.body.failedRows).toBe(6);
    const byRow = new Map(
      (run.body.errors as { rowNumber: number; code: string; skuCode: string | null; detail: string }[]).map((e) => [
        e.rowNumber,
        e,
      ]),
    );
    expect(byRow.get(3)?.code).toBe('validation-failed');
    expect(byRow.get(3)?.detail).toContain('variant_values');
    expect(byRow.get(4)?.code).toBe('validation-failed');
    expect(byRow.get(4)?.detail).toContain('variantValues');
    expect(byRow.get(5)?.skuCode).toBe('IMP-GHOST');
    expect(byRow.get(5)?.detail).toContain('never creates');
    expect(byRow.get(6)?.skuCode).toBe('IMP-MISMATCH');
    expect(byRow.get(6)?.code).toBe('validation-failed');
    expect(byRow.get(6)?.detail).toContain('colour');
    expect(byRow.get(8)?.skuCode).toBe('IMP-DUP-2');
    expect(byRow.get(8)?.code).toBe('duplicate-variant-values');
    expect(byRow.get(8)?.detail).toContain('Row 7');
    expect(byRow.get(9)?.skuCode).toBe('IMP-BAD-CELL');
    expect(byRow.get(9)?.detail).toContain('axis=value');

    // The committed shape: the attached row carries BOTH fields, the plain
    // row reads null — the partial commit stands around the 6 refusals.
    const list = await listSkus().expect(200);
    const attached = listedByCode(list.body.items as Record<string, unknown>[], 'IMP-VAR-1');
    expect(attached.productId).toBe(productIds.get('Imported Tee'));
    expect(attached.variantValues).toEqual({ size: 'M', colour: 'Red' });
    const plain = listedByCode(list.body.items as Record<string, unknown>[], 'IMP-PLAIN');
    expect(plain.productId).toBeNull();
    expect(plain.variantValues).toBeNull();

    // The tenant duplicate arm: a second run reusing values an EXISTING SKU
    // already carries is a row error naming that SKU's code — and the match
    // is key-order independent (the sorted-keys fingerprint).
    const tenantDup = await importCsv(
      csvFile([
        { sku_code: 'IMP-DUP-TENANT', name: 'Tenant dup', uom: 'pcs', gst_rate: '1800', product: 'Imported Tee', variant_values: 'colour=Red; size=M' },
      ]),
    ).expect(201);
    expect(tenantDup.body.committedRows).toBe(0);
    expect(tenantDup.body.failedRows).toBe(1);
    const tenantDupError = (tenantDup.body.errors as { code: string; detail: string }[])[0]!;
    expect(tenantDupError.code).toBe('duplicate-variant-values');
    expect(tenantDupError.detail).toContain('IMP-VAR-1');
  });

  test('keeps the closed-header contract: an unknown column is still 400 file-unreadable', async () => {
    const res = await importCsv(
      csvFile([{ sku_code: 'IMP-UNKNOWN', name: 'Tea tin', uom: 'pcs', gst_rate: '1800' }], 'sku_code,name,uom,gst_rate,variant_size'),
    ).expect(400);
    expect(res.body.code).toBe('file-unreadable');
    expect(String(res.body.detail)).toContain('variant_size');
  });

  // ── 0032 deployment probes: CHECK + RLS ───────────────────────────────────

  test('the migration CHECK is the backstop: variant_values pairs with product_id', async () => {
    // Direct SQL writes are out of reach of every validator by definition —
    // the CHECK exists so even those cannot store an orphaned value blob or
    // a product ref without values. (The rows are never committed: each
    // insert throws.)
    await expect(
      sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode, product_id, variant_values)
          values (${uuidv7()}, ${tenantId}, 'CHECK-VAR-1', 'probe', 'each', 1800, ${`BC-${ulid()}`}, null, ${sql.json({ size: 'M' })})`,
    ).rejects.toThrow(/skus_variant_values_pairing/);
    await expect(
      sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode, product_id, variant_values)
          values (${uuidv7()}, ${tenantId}, 'CHECK-VAR-2', 'probe', 'each', 1800, ${`BC-${ulid()}`}, ${uuidv7()}, null)`,
    ).rejects.toThrow(/skus_variant_values_pairing/);
    // The paired shape — both set, the values a proper object — stays storable
    // (and so does the fully-null pre-11.3 shape, which every scenario row
    // above already proves). `sql.json` because a bare string parameter is
    // double-encoded by the driver into a jsonb STRING, not an object.
    await expect(
      sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode, product_id, variant_values)
          values (${uuidv7()}, ${tenantId}, 'CHECK-VAR-3', 'probe', 'each', 1800, ${`BC-${ulid()}`}, ${uuidv7()}, ${sql.json({ size: 'M' })})`,
    ).resolves.toBeDefined();
  });

  test('RLS on products: an un-scoped session sees zero rows; a scoped session sees its own', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1 });
    try {
      const unscoped = await rls.unsafe('select count(*)::int as n from products');
      expect(Number(unscoped[0]!.n)).toBe(0);
      await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
      const scoped = await rls.unsafe('select count(*)::int as n from products');
      expect(Number(scoped[0]!.n)).toBeGreaterThan(0);
      // The isolation is two-sided: another tenant's setting reads zero.
      await rls.unsafe(`select set_config('app.tenant_id', '${uuidv7()}', false)`);
      const other = await rls.unsafe('select count(*)::int as n from products');
      expect(Number(other[0]!.n)).toBe(0);
    } finally {
      await rls.end();
    }
  });

  test('the OpenAPI document exposes the product contract (drift guard companion)', async () => {
    const committed = JSON.parse(
      readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8') as string,
    ) as { paths: Record<string, unknown> };
    expect(Object.keys(committed.paths)).toEqual(
      expect.arrayContaining([
        '/tenants/{tenantId}/catalog/products',
        '/tenants/{tenantId}/catalog/products/{productId}',
      ]),
    );
  });
});