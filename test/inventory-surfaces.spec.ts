import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// The e2e suite talks to the real Postgres (docker-compose dev DB by
// default; CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
// A host that exports either poll interval would boot the background workers
// and race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/** Day-scale helper for mfg/expiry instants relative to the test clock. */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

describe('inventory read surfaces (e2e, story 2.5)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let warehouseId: string;
  let binA: string;
  let binB: string;
  /** The canonical expiry the API returns for batch BX (seeded +10d). */
  let bxExpiry: string;
  const skuIds = new Map<string, string>();

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('inventory_surfaces');
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
    await suiteDb.drop();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // The ledger tables are append-only by trigger — the suite's cleanup
      // rides the superuser's replication-role bypass (sibling-suite rule).
      await sql.unsafe('set session_replication_role = replica');
      await sql.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('set session_replication_role = DEFAULT');
      await sql.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM batch_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM serials WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM batches WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // Story 2.2's scan state belongs to the tenant too (review loop 1).
      await sql.unsafe('DELETE FROM reconciliation_checkpoints WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
    } finally {
      await sql.end();
    }
  }

  interface AdjustBody {
    warehouseId: string;
    skuId: string;
    binId: string;
    quantityDelta: number;
    reasonCode: string;
    note: string;
    batch?: { code: string; mfgDate?: string; expiryDate?: string; overrideReason?: string };
    serials?: string[];
  }

  function adjust(body: AdjustBody, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function get(path: string): SupertestTest {
    return request(app.getHttpServer()).get(`${API}/${tenantId}${path}`).set('Authorization', `Bearer ${opsToken}`);
  }

  async function dbCount(table: string, extra = '', params: string[] = []): Promise<number> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql.unsafe(
        `select count(*)::int as n from ${table} where tenant_id = $1 and warehouse_id = $2 ${extra}`,
        [tenantId, warehouseId, ...params],
      );
      return Number((rows[0] as unknown as { n: number }).n);
    } finally {
      await sql.end();
    }
  }

  beforeAll(async () => {
    // Tenant + owner + an ops manager.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Surface Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await mintSignIn(app, { email, password: 'correct-horse-battery' })
    ).body.accessToken as string;
    opsToken = ownerToken;

    // Warehouse → zone → two bins.
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ origin: testAddress(), code: `SRF-${ulid().slice(10, 16).toUpperCase()}`, name: `Surfacepoint ${ulid()}` })
      .expect(201);
    warehouseId = warehouse.body.id as string;
    const zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    const binBody = { capacity: 1000, type: 'shelf' };
    binA = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.body.id as string}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...binBody, code: 'A-01-01' })
        .expect(201)
    ).body.id as string;
    binB = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.body.id as string}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...binBody, code: 'A-01-02' })
        .expect(201)
    ).body.id as string;

    // Four SKUs via the import (the only SKU-creation path): batch-tracked,
    // serial-tracked, both arms, and a flagless passthrough control.
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      'BT-1,Batch Pills,pcs,,1800,,true,false,,,',
      'ST-1,Serial Widgets,pcs,,1800,,false,true,,,',
      'BS-1,Both Arms,pcs,,1800,,true,true,,,',
      'PLAIN-1,Flagless,pcs,,1800,,false,false,,,',
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const skus = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }
    expect(skuIds.size).toBe(4);

    // Seed the stock every read below composes against: untracked (PLAIN-1
    // in both bins), batch-tracked (BT-1 batch SL-A in binA), serial-tracked
    // (ST-1 two units in binA).
    await adjust({ warehouseId, skuId: skuIds.get('PLAIN-1')!, binId: binA, quantityDelta: 2, reasonCode: 'stock-count', note: 'plain stock for surfaces' }).expect(201);
    await adjust({ warehouseId, skuId: skuIds.get('PLAIN-1')!, binId: binB, quantityDelta: 3, reasonCode: 'stock-count', note: 'plain stock for surfaces' }).expect(201);
    await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: 5,
      reasonCode: 'stock-count', note: 'batch intake for surfaces',
      batch: { code: 'SL-A', expiryDate: daysFromNow(300) },
    }).expect(201);
    await adjust({
      warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: 2,
      reasonCode: 'stock-count', note: 'serial intake for surfaces',
      serials: ['SN-S1', 'SN-S2'],
    }).expect(201);
  });

  // ── Stock list: keyset pagination, filters, error surfaces ──────────────

  it('stock list: walks the keyset to exhaustion with no dup/miss, filters by SKU and bin', async () => {
    const total = await dbCount('stock_on_hand');

    const firstPage = await get(`/warehouses/${warehouseId}/inventory/stock?limit=2`).expect(200);
    const firstItems = firstPage.body.items as { skuId: string; binId: string }[];
    expect(firstItems).toHaveLength(2);
    let nextCursor = firstPage.body.nextCursor as string | null;
    expect(nextCursor).toBeTruthy();

    const seen = firstItems.map((item) => `${item.skuId}:${item.binId}`);
    let guard = 0;
    while (nextCursor !== null && guard < 50) {
      const page = await get(`/warehouses/${warehouseId}/inventory/stock?limit=2&cursor=${encodeURIComponent(nextCursor)}`).expect(200);
      seen.push(...(page.body.items as { skuId: string; binId: string }[]).map((item) => `${item.skuId}:${item.binId}`));
      nextCursor = page.body.nextCursor as string | null;
      guard += 1;
    }
    expect(nextCursor).toBeNull();
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);

    // The SKU filter narrows to that SKU's rows only (the untracked
    // passthrough: plain stock_on_hand rows, no batch fields anywhere).
    const plain = await get(`/warehouses/${warehouseId}/inventory/stock?skuId=${skuIds.get('PLAIN-1')}`).expect(200);
    const plainItems = plain.body.items as Record<string, unknown>[];
    expect(plainItems.length).toBe(
      await dbCount('stock_on_hand', 'and sku_id = $3::uuid', [skuIds.get('PLAIN-1')!]),
    );
    for (const item of plainItems) {
      expect(item.skuId).toBe(skuIds.get('PLAIN-1'));
      // The exact row shape — no batch fields on the stock list.
      expect(Object.keys(item).sort()).toEqual(['binId', 'createdAt', 'id', 'quantity', 'skuId', 'warehouseId']);
    }

    const inBinB = await get(`/warehouses/${warehouseId}/inventory/stock?binId=${binB}`).expect(200);
    const binBItems = inBinB.body.items as { binId: string }[];
    expect(binBItems.length).toBe(await dbCount('stock_on_hand', 'and bin_id = $3::uuid', [binB]));
    for (const item of binBItems) {
      expect(item.binId).toBe(binB);
    }
  });

  it('stock list errors: a crafted-but-invalid cursor is a 400 invalid-cursor; a foreign warehouse is a 404; no token is a 401; a foreign tenant is a 403', async () => {
    const bogus = Buffer.from(JSON.stringify({ id: 'not-a-uuid', createdAt: 'nope' })).toString('base64');
    const rejected = await get(`/warehouses/${warehouseId}/inventory/stock?cursor=${encodeURIComponent(bogus)}`).expect(400);
    expect(rejected.body).toMatchObject({ status: 400, code: 'invalid-cursor' });

    // The DTO's limit bounds are the facade's no-clamp contract — out of
    // range is a 400, never a silently rewritten page size.
    await get(`/warehouses/${warehouseId}/inventory/stock?limit=0`).expect(400);
    await get(`/warehouses/${warehouseId}/inventory/stock?limit=201`).expect(400);

    await get(`/warehouses/${uuidv7()}/inventory/stock`).expect(404);

    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/inventory/stock`)
      .expect(401);

    const foreign = await request(app.getHttpServer())
      .get(`${API}/${uuidv7()}/warehouses/${warehouseId}/inventory/stock`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(403);
    expect(foreign.body).toMatchObject({ status: 403, code: 'permission-denied' });
  });

  // ── Batch list: the FEFO join (expiry ASC nulls last, expired listed) ────

  it('batch list: FEFO order is data (expiry ASC, nulls last, expired still listed), joined with on-hand', async () => {
    const sku = skuIds.get('BT-1')!;
    // Seed four batches into binB: BX (+10d), BY (+2d), BZ (null), BE (expired).
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 5, reasonCode: 'stock-count', note: 'BX', batch: { code: 'BX', expiryDate: daysFromNow(10) } }).expect(201);
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 4, reasonCode: 'stock-count', note: 'BY', batch: { code: 'BY', expiryDate: daysFromNow(2) } }).expect(201);
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 3, reasonCode: 'stock-count', note: 'BZ', batch: { code: 'BZ' } }).expect(201);
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 7, reasonCode: 'stock-count', note: 'BE expired', batch: { code: 'BE', expiryDate: daysFromNow(-1) } }).expect(201);

    const res = await get(`/warehouses/${warehouseId}/inventory/batches?skuId=${sku}`).expect(200);
    const items = res.body.items as { code: string; expiryDate: string | null; quantity: number }[];
    // FEFO order is data, not policy: expiry ASC — BE (expired, the earliest
    // expiry) sorts FIRST and is still listed — and nulls LAST (BZ); SL-A
    // (binA, +300d) sits between BX and BZ.
    expect(items.map((item) => item.code)).toEqual(['BE', 'BY', 'BX', 'SL-A', 'BZ']);
    const byCode = new Map(items.map((item) => [item.code, item]));
    expect(byCode.get('BY')).toMatchObject({ quantity: 4 });
    expect(byCode.get('BZ')).toMatchObject({ quantity: 3, expiryDate: null });
    expect(byCode.get('BE')).toMatchObject({ quantity: 7 });
    expect(byCode.get('SL-A')).toMatchObject({ quantity: 5 }); // sits in binA
    bxExpiry = byCode.get('BX')!.expiryDate!;

    // The bin filter narrows the on-hand half of the join — SL-A reads 0.
    const binAOnly = await get(`/warehouses/${warehouseId}/inventory/batches?skuId=${sku}&binId=${binA}`).expect(200);
    const binAItems = new Map(
      (binAOnly.body.items as { code: string; quantity: number }[]).map((item) => [item.code, item.quantity]),
    );
    expect(binAItems.get('SL-A')).toBe(5);
    expect(binAItems.get('BX')).toBe(0);
    expect(binAOnly.body.items).toHaveLength(5);
  });

  it('batch list errors: missing skuId is a 400, a malformed skuId is a 400, a foreign warehouse is a 404', async () => {
    const missing = await get(`/warehouses/${warehouseId}/inventory/batches`).expect(400);
    expect(missing.body).toMatchObject({ status: 400, code: 'validation-failed' });

    await get(`/warehouses/${warehouseId}/inventory/batches?skuId=not-a-uuid`).expect(400);

    const foreign = await get(`/warehouses/${uuidv7()}/inventory/batches?skuId=${skuIds.get('BT-1')}`).expect(404);
    expect(foreign.body).toMatchObject({ status: 404, code: 'not-found' });
  });

  // ── Batch detail: identity + per-bin on-hand + full history ──────────────

  it('batch detail: identity, per-bin on-hand rows, and the full history in one payload; unknown batch is a 404', async () => {
    const sku = skuIds.get('BT-1')!;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    let batchId: string;
    try {
      const rows = await sql`select id from batches where tenant_id = ${tenantId} and code = 'BX'`;
      batchId = (rows[0] as unknown as { id: string }).id;
    } finally {
      await sql.end();
    }

    const res = await get(`/inventory/batches/${batchId}`).expect(200);
    expect(res.body).toMatchObject({
      id: batchId,
      skuId: sku,
      code: 'BX',
      status: 'active',
    });
    expect(res.body.expiryDate).toBe(bxExpiry);
    expect(res.body.mfgDate).toBeNull();
    expect(res.body.bins).toEqual([{ warehouseId, binId: binB, quantity: 5 }]);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0]).toMatchObject({
      skuId: sku,
      toBinId: binB,
      quantityDelta: 5,
      serialRef: null,
    });

    // A draw grows the history (the ledger is the audit log) and drains the bin.
    await adjust({
      warehouseId, skuId: sku, binId: binB, quantityDelta: -1,
      reasonCode: 'damaged', note: 'detail test draw',
      batch: { code: 'BX', overrideReason: 'one unit counted out' },
    }).expect(201);
    const after = await get(`/inventory/batches/${batchId}`).expect(200);
    expect(after.body.history).toHaveLength(2);
    expect(after.body.history.map((e: { quantityDelta: number }) => e.quantityDelta)).toEqual([5, -1]);
    expect(after.body.bins).toEqual([{ warehouseId, binId: binB, quantity: 4 }]);

    // The tenant-wide claim: a second warehouse + bin receives part of the
    // SAME batch (identity is per tenant+sku+code — the ensure returns BX) —
    // the detail's bins now span both warehouses.
    const w2 = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ origin: testAddress(), code: `SRF2-${ulid().slice(10, 16).toUpperCase()}`, name: `Surfacepoint Two ${ulid()}` })
      .expect(201);
    const w2Id = w2.body.id as string;
    const w2zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${w2Id}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    const w2bin = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${w2Id}/zones/${w2zone.body.id as string}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 1000, type: 'shelf', code: 'B-01-01' })
        .expect(201)
    ).body.id as string;
    await adjust({
      warehouseId: w2Id, skuId: sku, binId: w2bin, quantityDelta: 2,
      reasonCode: 'stock-count', note: 'cross-warehouse BX',
      batch: { code: 'BX', expiryDate: bxExpiry },
    }).expect(201);

    const tenantWide = await get(`/inventory/batches/${batchId}`).expect(200);
    const bins = tenantWide.body.bins as { warehouseId: string; binId: string; quantity: number }[];
    expect(bins).toHaveLength(2);
    const byWarehouse = new Map(bins.map((bin) => [bin.warehouseId, bin]));
    expect(byWarehouse.get(warehouseId)).toEqual({ warehouseId, binId: binB, quantity: 4 });
    expect(byWarehouse.get(w2Id)).toEqual({ warehouseId: w2Id, binId: w2bin, quantity: 2 });
    // The move is a third ledger event of the same batch (seq is
    // per-warehouse, so the cross-warehouse history order is not defined —
    // compare as a set).
    const deltas = (tenantWide.body.history as { quantityDelta: number }[]).map((e) => e.quantityDelta);
    expect([...deltas].sort((a, b) => b - a)).toEqual([5, 2, -1]);

    const unknown = await get(`/inventory/batches/${uuidv7()}`).expect(404);
    expect(unknown.body).toMatchObject({ status: 404, code: 'not-found' });
    // A malformed (non-uuid) id is an unknown identity — the 404, not a 500.
    const malformed = await get('/inventory/batches/not-a-uuid').expect(404);
    expect(malformed.body).toMatchObject({ status: 404, code: 'not-found' });
  });

  // ── Serial detail: identity, derived location, full history ──────────────

  it('serial detail: location derived from the latest event, history oldest-first; unknown serial is a 404', async () => {
    const sku = skuIds.get('ST-1')!;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    let sn1Id: string;
    let sn2Id: string;
    try {
      const rows = await sql`select id, serial_number from serials where tenant_id = ${tenantId} and serial_number in ('SN-S1','SN-S2')`;
      for (const row of rows as unknown as { id: string; serial_number: string }[]) {
        if (row.serial_number === 'SN-S1') sn1Id = row.id;
        if (row.serial_number === 'SN-S2') sn2Id = row.id;
      }
    } finally {
      await sql.end();
    }

    const res = await get(`/inventory/serials/${sn1Id!}`).expect(200);
    expect(res.body).toMatchObject({
      id: sn1Id!,
      skuId: sku,
      serialNumber: 'SN-S1',
      status: 'active',
      location: { warehouseId, binId: binA },
    });
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0]).toMatchObject({
      skuId: sku,
      toBinId: binA,
      quantityDelta: 1,
      batchRef: null,
    });

    // Draw SN-S1 out of stock: the history grows, the location stays the
    // ledger's last-known bin (the derived state, never a projection).
    await adjust({ warehouseId, skuId: sku, binId: binA, quantityDelta: -1, reasonCode: 'damaged', note: 'serial draw for surfaces', serials: ['SN-S1'] }).expect(201);
    const after = await get(`/inventory/serials/${sn1Id!}`).expect(200);
    expect(after.body.location).toEqual({ warehouseId, binId: binA });
    expect(after.body.history).toHaveLength(2);
    expect((after.body.history as { quantityDelta: number }[]).map((e) => e.quantityDelta)).toEqual([1, -1]);

    // SN-S2 never moved: one intake event, still in binA.
    const sn2 = await get(`/inventory/serials/${sn2Id!}`).expect(200);
    expect(sn2.body.history).toHaveLength(1);
    expect(sn2.body.location).toEqual({ warehouseId, binId: binA });

    const unknown = await get(`/inventory/serials/${uuidv7()}`).expect(404);
    expect(unknown.body).toMatchObject({ status: 404, code: 'not-found' });
    // A malformed (non-uuid) id is an unknown identity — the 404, not a 500.
    const malformed = await get('/inventory/serials/not-a-uuid').expect(404);
    expect(malformed.body).toMatchObject({ status: 404, code: 'not-found' });
  });

  // ── Both-arms cross-refs: the batch and serial of one combined movement ──

  it('a combined batch+serial movement cross-references: the batch history carries the serialRef, the serial history the batchRef', async () => {
    const sku = skuIds.get('BS-1')!;
    const res = await adjust({
      warehouseId, skuId: sku, binId: binB, quantityDelta: 1,
      reasonCode: 'stock-count', note: 'combined arms for surfaces',
      batch: { code: 'C-BOTH', expiryDate: daysFromNow(120) },
      serials: ['SN-B1'],
    }).expect(201);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    let batchId: string;
    let serialId: string;
    try {
      const events = await sql`
        select batch_ref, serial_ref from ledger_events where tenant_id = ${tenantId} and seq = ${res.body.event.seq}
      `;
      batchId = (events[0] as unknown as { batch_ref: string }).batch_ref;
      serialId = (events[0] as unknown as { serial_ref: string }).serial_ref;
    } finally {
      await sql.end();
    }

    const batchDetail = await get(`/inventory/batches/${batchId!}`).expect(200);
    expect((batchDetail.body.history as { serialRef: string | null }[])[0]!.serialRef).toBe(serialId);

    const serialDetail = await get(`/inventory/serials/${serialId!}`).expect(200);
    expect((serialDetail.body.history as { batchRef: string | null }[])[0]!.batchRef).toBe(batchId);
  });

  // ── Timeline enrichment: the additive nullable passthroughs ──────────────

  it('timeline enrichment: every event carries batchRef/serialRef/referenceDoc; arm-less events stay null; prior fields unchanged', async () => {
    const res = await get(`/warehouses/${warehouseId}/inventory/events?limit=200`).expect(200);
    const items = res.body.items as Record<string, unknown>[];
    expect(items.length).toBeGreaterThanOrEqual(9);
    for (const item of items) {
      // Every prior field is still present (the additive contract) …
      expect(Object.keys(item).sort()).toEqual(
        [
          'actorUserId', 'batchRef', 'createdAt', 'eventHash', 'fromBinId', 'id',
          'occurredAt', 'quantityDelta', 'recordedAt', 'referenceDoc', 'seq',
          'serialRef', 'skuId', 'toBinId', 'type',
        ],
      );
    }

    // … the plain-SKU intake is an arm-less event: null arms, the reference
    // doc carried verbatim, no overrideReason key.
    const plain = items.find(
      (item) => item.skuId === skuIds.get('PLAIN-1') && item.quantityDelta === 2,
    )!;
    expect(plain).toMatchObject({ type: 'stock.adjusted', batchRef: null, serialRef: null });
    expect(plain.referenceDoc).toMatchObject({ kind: 'manual-adjustment', reasonCode: 'stock-count', note: 'plain stock for surfaces' });
    expect('overrideReason' in (plain.referenceDoc as Record<string, unknown>)).toBe(false);

    // … the batch intake carries its batchRef and the doc rides verbatim.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const batchRows = await sql`select id from batches where tenant_id = ${tenantId} and code = 'SL-A'`;
      const batchId = (batchRows[0] as unknown as { id: string }).id;
      const intake = items.find(
        (item) => item.batchRef === batchId && item.quantityDelta === 5,
      )!;
      expect(intake).toBeDefined();
      expect(intake.serialRef).toBeNull();
      expect(intake.referenceDoc).toMatchObject({ kind: 'manual-adjustment', note: 'batch intake for surfaces' });
      expect('overrideReason' in (intake.referenceDoc as Record<string, unknown>)).toBe(false);

      // The serial arm's non-null path: the ST-1 intake wrote one event per
      // unit, each carrying its catalog serial id as serialRef (cross-checked
      // against the serials table exactly like the batch id above).
      const serialRows = await sql`
        select id, serial_number from serials
        where tenant_id = ${tenantId} and serial_number in ('SN-S1','SN-S2')
      `;
      const serialIds = new Map(
        (serialRows as unknown as { id: string; serial_number: string }[]).map((row) => [row.serial_number, row.id]),
      );
      const intakeRefs = items
        .filter((item) => (item.referenceDoc as Record<string, unknown> | null)?.note === 'serial intake for surfaces')
        .map((item) => item.serialRef as string)
        .sort();
      expect(intakeRefs).toHaveLength(2);
      expect(intakeRefs).toEqual([serialIds.get('SN-S1'), serialIds.get('SN-S2')].sort());
      // And the draw event's serialRef is non-null too.
      const draw = items.find(
        (item) => (item.referenceDoc as Record<string, unknown> | null)?.note === 'serial draw for surfaces',
      )!;
      expect(draw.serialRef).toBe(serialIds.get('SN-S1'));
    } finally {
      await sql.end();
    }
  });
  // ── Inventory-screen: `order=location`, `nonZero`, the full-precision cursor ──
  //
  // A separate warehouse (W2) so the rows above keep their counts. Bins are
  // made over HTTP; the one system bin is inserted by hand (system bins are
  // only ever ensured lazily by the flows that use them), and the stock goes
  // in through the real adjustment path.
  describe('stock list by location (inventory-screen)', () => {
    let w2: string;
    let w3: string;
    const w2Bins = new Map<string, string>();
    let w3SameCodeBin: string;
    let plainSku: string;
    let plain2Sku: string;

    async function makeWarehouse(prefix: string): Promise<{ warehouseId: string; zoneId: string }> {
      const created = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${prefix}-${ulid().slice(10, 16).toUpperCase()}`, name: `${prefix} ${ulid()}` })
        .expect(201);
      const id = created.body.id as string;
      const zone = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${id}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'D', name: 'Zone D' })
        .expect(201);
      return { warehouseId: id, zoneId: zone.body.id as string };
    }

    async function makeBin(whId: string, zoneId: string, code: string): Promise<string> {
      return (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${whId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 100000, type: 'shelf', code })
          .expect(201)
      ).body.id as string;
    }

    function stockIn(whId: string, skuId: string, binId: string, quantityDelta: number): SupertestTest {
      return adjust({ warehouseId: whId, skuId, binId, quantityDelta, reasonCode: 'stock-count', note: 'location order' });
    }

    function listW2(query: string): SupertestTest {
      return get(`/warehouses/${w2}/inventory/stock?${query}`);
    }

    interface LocRow { id: string; skuId: string; binId: string; binCode: string; binSystemOwned: boolean; quantity: number }

    async function walk(query: string): Promise<LocRow[]> {
      const seen: LocRow[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const res = await listW2(`${query}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`).expect(200);
        seen.push(...(res.body.items as LocRow[]));
        cursor = res.body.nextCursor as string | null;
        guard += 1;
      } while (cursor !== null && guard < 100);
      expect(cursor).toBeNull();
      return seen;
    }

    beforeAll(async () => {
      plainSku = skuIds.get('PLAIN-1')!;
      // Two untracked SKUs are needed for the tie inside one bin: PLAIN-1
      // plus a fresh flagless SKU.
      const csv = [
        'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
        'PLAIN-2,Flagless Two,pcs,,1800,,false,false,,,',
      ].join('\n');
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/catalog/imports`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .field('mode', 'initial')
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
        .expect(201);
      const skus = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/catalog/skus?limit=100`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      plain2Sku = (skus.body.items as { code: string; id: string }[]).find((item) => item.code === 'PLAIN-2')!.id;
      expect(plain2Sku).toBeDefined();

      const a = await makeWarehouse('LOC');
      w2 = a.warehouseId;
      // Lexical codes: `D-01-10` sorts before `D-01-2`, and `D-02` before `D01`
      // (`-` is 0x2D, below every digit).
      for (const code of ['D01', 'D-01-2', 'D-02', 'D-01-10', 'D-01-01']) {
        w2Bins.set(code, await makeBin(w2, a.zoneId, code));
      }
      // The system RECEIVING bin, inserted the way `ensureReceivingBinInTx`
      // would (code + system_owned is the identity).
      const receivingId = uuidv7();
      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await sql`
          insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned)
          values (${receivingId}, ${tenantId}, ${w2}, ${a.zoneId}, 'RECEIVING', 1000000000, 'staging', true)
        `;
      } finally {
        await sql.end();
      }
      w2Bins.set('RECEIVING', receivingId);

      // A same-code bin in another warehouse, with stock — never joined to W2.
      const b = await makeWarehouse('OTH');
      w3 = b.warehouseId;
      w3SameCodeBin = await makeBin(w3, b.zoneId, 'D-01-01');
      await stockIn(w3, plainSku, w3SameCodeBin, 9).expect(201);

      // W2 stock. RECEIVING is seeded FIRST so the default (newest-first)
      // order could never accidentally put it last.
      await stockIn(w2, plainSku, receivingId, 4).expect(201);
      await stockIn(w2, plainSku, w2Bins.get('D01')!, 1).expect(201);
      await stockIn(w2, plain2Sku, w2Bins.get('D-01-01')!, 2).expect(201);
      await stockIn(w2, plainSku, w2Bins.get('D-01-01')!, 3).expect(201);
      await stockIn(w2, plainSku, w2Bins.get('D-02')!, 5).expect(201);
      await stockIn(w2, plainSku, w2Bins.get('D-01-10')!, 6).expect(201);
      await stockIn(w2, plainSku, w2Bins.get('D-01-2')!, 7).expect(201);
      // Drained to zero: the row stays in stock_on_hand at 0.
      await stockIn(w2, plain2Sku, w2Bins.get('D-01-2')!, 2).expect(201);
      await stockIn(w2, plain2Sku, w2Bins.get('D-01-2')!, -2).expect(201);
    });

    it('order=location: storage bins by code (lexical, COLLATE "C"), then system bins; ties by SKU id across a page boundary', async () => {
      const rows = await walk('order=location&limit=1');
      const order = rows.map((row) => row.binCode);
      expect(order).toEqual(['D-01-01', 'D-01-01', 'D-01-10', 'D-01-2', 'D-01-2', 'D-02', 'D01', 'RECEIVING']);
      // The tied bin code over two SKUs is split across pages (limit 1) and
      // ordered by SKU id, then row id — nothing duplicated or missed.
      const tie = rows.filter((row) => row.binCode === 'D-01-01').map((row) => row.skuId);
      expect(tie).toEqual([plainSku, plain2Sku].sort());
      const tie2 = rows.filter((row) => row.binCode === 'D-01-2').map((row) => row.skuId);
      expect(tie2).toEqual([plainSku, plain2Sku].sort());
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      // The location items carry the bin's code and system flag.
      const receiving = rows.at(-1)!;
      expect(receiving.binSystemOwned).toBe(true);
      expect(receiving.binId).toBe(w2Bins.get('RECEIVING'));
      expect(receiving.quantity).toBe(4);
      expect(rows.slice(0, -1).every((row) => row.binSystemOwned === false)).toBe(true);
      expect(Object.keys(rows[0]!).sort()).toEqual(
        ['binCode', 'binId', 'binSystemOwned', 'createdAt', 'id', 'quantity', 'skuId', 'warehouseId'],
      );
    });

    it('nonZero=true drops the drained row, also when combined with a cursor and order=location', async () => {
      const all = await walk('order=location&limit=200');
      const zero = all.filter((row) => row.quantity === 0);
      expect(zero).toHaveLength(1);
      expect(zero[0]!.binCode).toBe('D-01-2');

      const nonZero = await walk('order=location&nonZero=true&limit=1');
      expect(nonZero.every((row) => row.quantity > 0)).toBe(true);
      expect(nonZero.map((row) => row.id)).toEqual(all.filter((row) => row.quantity > 0).map((row) => row.id));

      // The default order honours it too.
      const plain = await listW2('nonZero=true&limit=200').expect(200);
      const plainItems = plain.body.items as { quantity: number }[];
      expect(plainItems).toHaveLength(all.length - 1);
      expect(plainItems.every((row) => row.quantity > 0)).toBe(true);
      // An unparseable flag is refused by name.
      const yes = await listW2('nonZero=yes').expect(400);
      expect(yes.body).toMatchObject({ status: 400, code: 'validation-failed' });
      // `nonZero=false` behaves exactly like the flag absent.
      const off = await walk('order=location&nonZero=false&limit=200');
      expect(off.map((row) => row.id)).toEqual(all.map((row) => row.id));
    });

    it('order=location with skuId (the SKU search) lists only that SKU, one row per non-zero bin, across pages', async () => {
      const rows = await walk(`order=location&nonZero=true&skuId=${plainSku}&limit=1`);
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.every((row) => row.skuId === plainSku)).toBe(true);
      expect(rows.map((row) => row.binCode)).toEqual(['D-01-01', 'D-01-10', 'D-01-2', 'D-02', 'D01', 'RECEIVING']);
      // plain2Sku's rows (D-01-01, and the drained D-01-2) never appear.
      const other = await walk(`order=location&nonZero=true&skuId=${plain2Sku}&limit=1`);
      expect(other.map((row) => row.binCode)).toEqual(['D-01-01']);
    });

    it('a same-code bin in another warehouse is never joined', async () => {
      const rows = await walk('order=location&limit=200');
      expect(rows.some((row) => row.binId === w3SameCodeBin)).toBe(false);
      expect(rows.every((row) => row.binId === w2Bins.get(row.binCode))).toBe(true);
      // Filtering W2 by W3's bin id yields nothing; W3 lists its own row.
      const foreign = await listW2(`order=location&binId=${w3SameCodeBin}`).expect(200);
      expect(foreign.body.items).toEqual([]);
      const own = await get(`/warehouses/${w3}/inventory/stock?order=location`).expect(200);
      expect((own.body.items as LocRow[]).map((row) => [row.binCode, row.quantity])).toEqual([['D-01-01', 9]]);
    });

    it('a cursor minted under one order is a 400 invalid-cursor under the other, in both directions; an unknown order is a 400', async () => {
      const location = await listW2('order=location&limit=1').expect(200);
      const locationCursor = location.body.nextCursor as string;
      expect(locationCursor).toBeTruthy();
      const plain = await listW2('limit=1').expect(200);
      const plainCursor = plain.body.nextCursor as string;
      expect(plainCursor).toBeTruthy();

      const wrongWay = await listW2(`limit=1&cursor=${encodeURIComponent(locationCursor)}`).expect(400);
      expect(wrongWay.body).toMatchObject({ status: 400, code: 'invalid-cursor' });
      const otherWay = await listW2(`order=location&limit=1&cursor=${encodeURIComponent(plainCursor)}`).expect(400);
      expect(otherWay.body).toMatchObject({ status: 400, code: 'invalid-cursor' });

      // A crafted location cursor with a bad id is a 400, never a 500.
      const crafted = Buffer.from(
        JSON.stringify({ o: 'location', sys: false, binCode: 'D-01-01', skuId: 'nope', id: uuidv7() }),
      ).toString('base64url');
      const craftedRes = await listW2(`order=location&cursor=${encodeURIComponent(crafted)}`).expect(400);
      expect(craftedRes.body).toMatchObject({ status: 400, code: 'invalid-cursor' });

      const unknown = await listW2('order=created').expect(400);
      expect(unknown.body).toMatchObject({ status: 400, code: 'validation-failed' });
    });

    it('the default order pages a tie group within one microsecond without a miss (full-precision cursor)', async () => {
      // Stamp every W2 row with ONE microsecond-precise instant: a cursor
      // truncated to milliseconds (`…00.123Z`) sorts below `…00.123456`, so
      // its strict `<` would skip the whole tie group after page one. The
      // original stamps are restored afterwards, so no later test inherits them.
      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      let original: { id: string; created_at: string }[] = [];
      try {
        original = (await sql`
          select id, created_at::text as created_at from stock_on_hand
          where tenant_id = ${tenantId} and warehouse_id = ${w2}
        `) as unknown as { id: string; created_at: string }[];
        await sql`
          update stock_on_hand set created_at = '2026-01-01 00:00:00.123456+00'
          where tenant_id = ${tenantId} and warehouse_id = ${w2}
        `;
        const total = original.length;
        expect(total).toBeGreaterThan(2);
        const seen: string[] = [];
        let cursor: string | null = null;
        let guard = 0;
        do {
          const res = await listW2(`limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`).expect(200);
          seen.push(...(res.body.items as { id: string }[]).map((row) => row.id));
          cursor = res.body.nextCursor as string | null;
          guard += 1;
        } while (cursor !== null && guard < 100);
        expect(seen).toHaveLength(total);
        expect(new Set(seen).size).toBe(total);
      } finally {
        for (const row of original) {
          await sql`update stock_on_hand set created_at = ${row.created_at}::timestamptz where id = ${row.id}`;
        }
        await sql.end();
      }
    });
  });
});
