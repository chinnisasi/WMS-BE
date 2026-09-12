import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

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
      await sql.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    opsToken = ownerToken;

    // Warehouse → zone → two bins.
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `SRF-${ulid().slice(10, 16).toUpperCase()}`, name: `Surfacepoint ${ulid()}` })
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
    await adjust({ warehouseId, skuId: skuIds.get('PLAIN-1')!, binId: binA, quantityDelta: 2, reasonCode: 'cycle-count', note: 'plain stock for surfaces' }).expect(201);
    await adjust({ warehouseId, skuId: skuIds.get('PLAIN-1')!, binId: binB, quantityDelta: 3, reasonCode: 'cycle-count', note: 'plain stock for surfaces' }).expect(201);
    await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: 5,
      reasonCode: 'cycle-count', note: 'batch intake for surfaces',
      batch: { code: 'SL-A', expiryDate: daysFromNow(300) },
    }).expect(201);
    await adjust({
      warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: 2,
      reasonCode: 'cycle-count', note: 'serial intake for surfaces',
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
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 5, reasonCode: 'cycle-count', note: 'BX', batch: { code: 'BX', expiryDate: daysFromNow(10) } }).expect(201);
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 4, reasonCode: 'cycle-count', note: 'BY', batch: { code: 'BY', expiryDate: daysFromNow(2) } }).expect(201);
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 3, reasonCode: 'cycle-count', note: 'BZ', batch: { code: 'BZ' } }).expect(201);
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 7, reasonCode: 'cycle-count', note: 'BE expired', batch: { code: 'BE', expiryDate: daysFromNow(-1) } }).expect(201);

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
      reasonCode: 'damage', note: 'detail test draw',
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
      .send({ code: `SRF2-${ulid().slice(10, 16).toUpperCase()}`, name: `Surfacepoint Two ${ulid()}` })
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
      reasonCode: 'cycle-count', note: 'cross-warehouse BX',
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
    await adjust({ warehouseId, skuId: sku, binId: binA, quantityDelta: -1, reasonCode: 'damage', note: 'serial draw for surfaces', serials: ['SN-S1'] }).expect(201);
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
      reasonCode: 'cycle-count', note: 'combined arms for surfaces',
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
    expect(plain.referenceDoc).toMatchObject({ kind: 'manual-adjustment', reasonCode: 'cycle-count', note: 'plain stock for surfaces' });
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
});