import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { fromMilli, toMilli } from '../src/shared/primitives/quantity';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ChannelsFacade } from '../src/modules/channels/channels.facade';
import { testAddress } from './support/shipment-address';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres + Valkey and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.CHANNEL_ENCRYPTION_KEY ??= 'e2e-only-channel-encryption-key-0123456789abcdef';
// Background workers stay off in suites (the sibling convention, extended to
// the channels sync worker).
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.CHANNELS_SYNC_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const BUFFER_OWNER_TYPE = 'buffer';

/**
 * The suite's fixtures: one tenant, one warehouse; the SHOPIFY connection
 * carries the place/adjust/refuse/reaper scenarios; the DISCONNECT test
 * owns its own (tenant, provider) slot — an amazon-in connection — so the
 * release scenario can delete its connection without disturbing the others
 * (one connection per provider per tenant).
 */
const SHOPIFY_CREDENTIAL = {
  shopDomain: 'buffer-suite-store.myshopify.com',
  accessToken: 'canary-buffer-shopify-2e41aa',
};
const AMAZON_CREDENTIAL = {
  sellerId: 'canary-buffer-seller-7a11f0',
  refreshToken: 'canary-buffer-refresh-31da90',
};

const SKU_CODES = ['BUF-PLACE', 'BUF-ADJUST', 'BUF-CEILING', 'BUF-REAP', 'BUF-RELEASE'] as const;

describe('standing buffers: place, adjust, clear, refuse, survive the reaper, release on disconnect (e2e, story 7-1)', () => {
  let app: INestApplication;
  let facade: InventoryFacade;
  let channels: ChannelsFacade;
  let suiteDb: SuiteDatabase;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let opsToken: string;
  let warehouseId: string;
  let shopifyId: string;
  const skuIds = new Map<string, string>();

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('channel_buffers');
    app = await createApp(false);
    await app.init();
    facade = app.get(InventoryFacade);
    channels = app.get(ChannelsFacade);
    await seedTenantFixture();
  });

  afterAll(async () => {
    await cleanupRows();
    const db = app.get<unknown>(DATABASE) as Record<string, unknown> & { $client?: { end(): Promise<void> } };
    await (db.$client as { end(): Promise<void> }).end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as Record<string, unknown> & { $client?: { end(): Promise<void> } };
    await (authDb.$client as { end(): Promise<void> }).end();
    await app.close();
    await suiteDb.drop();
  });

  async function seedTenantFixture(): Promise<void> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Buffer Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    const opsEmail = `ops-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: opsEmail, role: 'ops_manager' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken, password: 'ops-password-123' })
      .expect(200);
    opsToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: opsEmail, password: 'ops-password-123' })
        .expect(200)
    ).body.accessToken as string;

    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ origin: testAddress(), code: `BUF-${ulid().slice(10, 16).toUpperCase()}`, name: `Buffer WH ${ulid()}` })
      .expect(201);
    warehouseId = warehouse.body.id as string;
    const zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.body.id as string}/bins`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ capacity: 100000, type: 'shelf', code: 'A-01-01' })
      .expect(201);

    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [csvHeader, ...SKU_CODES.map((code) => `${code},Test SKU ${code},pcs,,1800,,,,,`)].join('\n');
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
      if ((SKU_CODES as readonly string[]).includes(item.code)) {
        skuIds.set(item.code, item.id);
      }
    }
    expect(skuIds.size).toBe(SKU_CODES.length);

    shopifyId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/channels/connections`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ provider: 'shopify', credentials: { ...SHOPIFY_CREDENTIAL } })
        .expect(201)
    ).body.id as string;

    // Cold-start bootstrap: seed the tenant's counters + ready marker from
    // the (still empty) journal — the operator path after a Valkey flush
    // (the reservations suite's convention).
    await facade.rebuildReservationCounters(tenantId, warehouseId);
  }

  /** Seeds committed on-hand via the stock.adjustment command (HTTP). */
  async function seedStock(skuId: string, quantity: number): Promise<void> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const bins = (await sql`
        select id from bins where warehouse_id = ${warehouseId} order by code asc limit 1
      `) as unknown as { id: string }[];
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId,
          binId: bins[0]!.id,
          quantityDelta: quantity,
          reasonCode: 'stock-count',
          note: 'buffer-suite seed',
        })
        .expect(201);
    } finally {
      await sql.end();
    }
  }

  function putBuffers(items: { skuId: string; bufferMilli: number }[], connectionId = shopifyId): request.Test {
    return request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${connectionId}/buffers`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        items: items.map((item) => ({ warehouseId, ...item })),
      });
  }

  /** This connection's HELD buffer rows for one sku, in BASE units (milli folded). */
  async function bufferRows(skuId: string, connectionId: string): Promise<
    { state: string; quantity: number; owner_type: string; owner_id: string; expires_at: string | null }[]
  > {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const raw = (await sql`
        select state, quantity, owner_type, owner_id, expires_at
        from reservations
        where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
          and sku_id = ${skuId} and owner_type = ${BUFFER_OWNER_TYPE} and owner_id = ${connectionId}
          and state = 'held'
        order by created_at asc
      `) as unknown as { state: string; quantity: string; owner_type: string; owner_id: string; expires_at: string | null }[];
      return raw.map((r) => ({ ...r, quantity: fromMilli(Number(r.quantity)) }));
    } finally {
      await sql.end();
    }
  }

  /** RN-6's V(c) plus the pool facts (BASE units — the core speaks milli; this is the suite's edge). */
  async function visibilityOf(skuId: string, connectionId: string): Promise<Record<string, number>> {
    const pool = await facade.channelVisibleQuantity(tenantId, warehouseId, skuId, connectionId);
    return {
      onHand: fromMilli(pool.onHand),
      poolAtp: fromMilli(pool.poolAtp),
      buffer: fromMilli(pool.buffer),
      // (the `visibleMilli` NAME rides the wire; the suite normalizes it)
      visibleMilli: fromMilli(pool.visibleMilli),
    };
  }

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      for (const table of [
        'channel_mappings',
        'integration_calls',
        'integrations',
        'reservations',
        'stock_on_hand',
        'batch_on_hand',
        'outbox_messages',
        'idempotency_keys',
        'audit_events',
        'catalog_import_errors',
        'catalog_imports',
        'uom_conversions',
        'skus',
        'bins',
        'zones',
        'warehouses',
        'users',
        'tenants',
      ]) {
        if (table === 'stock_on_hand' || table === 'batch_on_hand') {
          await sql.unsafe('set session_replication_role = replica');
        }
        await sql.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
        if (table === 'stock_on_hand' || table === 'batch_on_hand') {
          await sql.unsafe('set session_replication_role = DEFAULT');
        }
      }
    } finally {
      await sql.end();
    }
  }

  // ── the scenarios ──────────────────────────────────────────────────────────

  it('place: the buffer is a held reservations row (owner_type buffer, expires_at NULL) folded into reserved', async () => {
    const skuId = skuIds.get('BUF-PLACE')!;
    await seedStock(skuId, 10);
    const res = await putBuffers([{ skuId, bufferMilli: toMilli(3) }]).expect(200);
    expect((res.body.verdicts as Record<string, unknown>[])[0]).toMatchObject({
      index: 0,
      warehouseId,
      skuId,
      status: 'applied',
      bufferMilli: toMilli(3),
      standingMilli: toMilli(3),
    });

    const rowsFound = await bufferRows(skuId, shopifyId);
    expect(rowsFound).toHaveLength(1);
    expect(rowsFound[0]).toMatchObject({
      state: 'held',
      quantity: 3,
      owner_type: 'buffer',
      owner_id: shopifyId,
      expires_at: null,
    });
    // RN-1: the buffer folds into `reserved` (10 on-hand → pool atp 7);
    // RN-6: the channel's V(c) subtracts its OWN buffer once more (4 — the
    // staleness margin: the channel may not LIST its buffer).
    expect(await visibilityOf(skuId, shopifyId)).toMatchObject({
      onHand: 10,
      poolAtp: 7,
      buffer: 3,
      visibleMilli: 4,
    });
    // Arm 4's buckets carry the row.
    const list = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/channels/connections`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    const entry = (list.body.items as Record<string, unknown>[]).find((e) => e.id === shopifyId)!;
    expect(entry.buffers).toEqual([{ warehouseId, skuId, bufferMilli: toMilli(3) }]);
  });

  it('adjust: raise, re-set the same target (unchanged), then clear to 0 — the row releases', async () => {
    const skuId = skuIds.get('BUF-ADJUST')!;
    await seedStock(skuId, 20);
    await putBuffers([{ skuId, bufferMilli: toMilli(5) }]).expect(200);
    const raised = await putBuffers([{ skuId, bufferMilli: toMilli(8) }]).expect(200);
    expect((raised.body.verdicts as Record<string, unknown>[])[0]).toMatchObject({
      status: 'applied',
      bufferMilli: toMilli(8),
      standingMilli: toMilli(8),
    });
    // The same target again: 'unchanged'.
    const same = await putBuffers([{ skuId, bufferMilli: toMilli(8) }]).expect(200);
    expect((same.body.verdicts as Record<string, unknown>[])[0]!.status).toBe('unchanged');
    // Clear: the release — the buffer row goes terminal, all folds gone.
    const cleared = await putBuffers([{ skuId, bufferMilli: 0 }]).expect(200);
    expect((cleared.body.verdicts as Record<string, unknown>[])[0]!).toMatchObject({
      status: 'applied',
      bufferMilli: 0,
      standingMilli: 0,
    });
    expect(await bufferRows(skuId, shopifyId)).toEqual([]);
    expect(await visibilityOf(skuId, shopifyId)).toMatchObject({
      poolAtp: 20,
      buffer: 0,
      visibleMilli: 20,
    });
  });

  it('refuse: a target the pool cannot grant is a per-item buffer-over-ceiling verdict with the OLD buffer standing', async () => {
    const skuId = skuIds.get('BUF-CEILING')!;
    await seedStock(skuId, 4);
    await putBuffers([{ skuId, bufferMilli: toMilli(4) }]).expect(200);
    // 20 on hand after? No: 4 on-hand, buffer 4 → atp 0; a raise cannot grant.
    const refusedRes = await putBuffers([{ skuId, bufferMilli: toMilli(12) }]).expect(200);
    const verdicts = refusedRes.body.verdicts as Record<string, unknown>[];
    expect(verdicts[0]).toMatchObject({
      status: 'refused',
      bufferMilli: toMilli(12),
      standingMilli: toMilli(4),
      code: 'buffer-over-ceiling',
    });
    // The OLD buffer stands — the core rolled the grant back by construction.
    expect(await visibilityOf(skuId, shopifyId)).toMatchObject({ poolAtp: 0, buffer: 4 });
    // The refusal still consumed the key with the FULL verdict list — mixed
    // requests keep their per-item outcomes (place one more alongside).
    const mixed = await putBuffers([
      { skuId: skuIds.get('BUF-ADJUST')!, bufferMilli: 0 }, // unchanged clear
      { skuId, bufferMilli: toMilli(6) }, // refused
    ]).expect(200);
    const mixedVerdicts = mixed.body.verdicts as Record<string, unknown>[];
    expect(mixedVerdicts.map((v) => v.status)).toEqual(['unchanged', 'refused']);
  });

  it('survive: the reaper expires TTL holds on the same sku and SKIPS the NULL-expiry buffers', async () => {
    const skuId = skuIds.get('BUF-REAP')!;
    await seedStock(skuId, 10);
    await putBuffers([{ skuId, bufferMilli: toMilli(2) }]).expect(200);
    const hold = await facade.grantReservation({
      tenantId,
      warehouseId,
      skuId,
      ownerType: 'order-line',
      ownerId: `reap-${ulid().toLowerCase()}`,
      quantity: toMilli(1),
      ttlSeconds: 1,
    });
    expect(hold.state).toBe('held');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const expired = await facade.expireDueReservations();
    expect(expired).toBeGreaterThanOrEqual(1);

    const rowsFound = await bufferRows(skuId, shopifyId);
    expect(rowsFound).toHaveLength(1);
    expect(rowsFound[0]).toMatchObject({ state: 'held', quantity: 2, expires_at: null });
    // Pool math after the reaping: onHand 10, buffer 2 → atp 8.
    expect(await visibilityOf(skuId, shopifyId)).toMatchObject({
      onHand: 10,
      poolAtp: 8,
      buffer: 2,
      visibleMilli: 6,
    });
  });

  it('release: disconnect releases the connection’s buffers through the core, drops the mappings, and restores the counter', async () => {
    const skuId = skuIds.get('BUF-RELEASE')!;
    await seedStock(skuId, 30);
    // The disconnect scenario's own connection (the shopify slot stays).
    const amazonId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/channels/connections`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ provider: 'amazon-in', credentials: { ...AMAZON_CREDENTIAL } })
        .expect(201)
    ).body.id as string;
    await putBuffers([{ skuId, bufferMilli: toMilli(6) }], amazonId).expect(200);
    expect(await visibilityOf(skuId, amazonId)).toMatchObject({ poolAtp: 24, buffer: 6 });
    // Seed a mapping to prove its death with the connection.
    const written = await channels.setChannelMappings(tenantId, amazonId, [
      { externalRef: 'shopify-canary-order-1', skuId },
    ]);
    expect(written).toBe(1);

    await request(app.getHttpServer())
      .delete(`${API}/${tenantId}/channels/connections/${amazonId}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .expect(204);

    // The buffer row went terminal; the owner's rows are gone from the held
    // set and the journal shows the release.
    expect(await bufferRows(skuId, amazonId)).toEqual([]);
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const journal = (await sql`
        select state, owner_type from reservations
        where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
          and sku_id = ${skuId} and owner_id = ${amazonId}
      `) as unknown as { state: string; owner_type: string }[];
      expect(journal).toEqual([{ ...journalExpect() }]);
      // The counter parity: the restore mirrors ran — visible is the FULL
      // pool again (a missed mirror would leave reserved 6 → visible 24).
      expect(await visibilityOf(skuId, amazonId)).toMatchObject({
        onHand: 30,
        poolAtp: 30,
        buffer: 0,
        visibleMilli: 30,
      });
      // Mappings died with the connection; so did the row.
      const mappings = (await sql`
        select id from channel_mappings where tenant_id = ${tenantId} and integration_id = ${amazonId}
      `) as unknown as { id: string }[];
      expect(mappings).toEqual([]);
      const gone = (await sql`
        select id from integrations where tenant_id = ${tenantId} and id = ${amazonId}
      `) as unknown as { id: string }[];
      expect(gone).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  function journalExpect(): Record<string, unknown> {
    // The release journal query above expects the released row's owner_type;
    // the releaseInTx's terminal state. (Pinned inline in the test that
    // reads it.)
    return { state: 'released', owner_type: 'buffer' };
  }

  it('fences: a foreign sku id in the items is a 404 (buffer-sku-not-found), an unknown connection id a 404', async () => {
    const FOREIGN_SKU = uuidv7();
    await putBuffers([{ skuId: FOREIGN_SKU, bufferMilli: 100 }]).expect(404);
    // No skuId from another tenant's inventory was written: the refusal came
    // before phase 2 and no buffer row exists for it.
    expect(await bufferRows(FOREIGN_SKU, shopifyId)).toEqual([]);
    await request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${uuidv7()}/buffers`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ items: [{ warehouseId, skuId: skuIds.get('BUF-PLACE')!, bufferMilli: 100 }] })
      .expect(404);
  });

  it('the buffers verdicts replay: the same key re-answers the same verdicts without re-applying (absolute targets)', async () => {
    const skuId = skuIds.get('BUF-ADJUST')!;
    const items = [{ skuId, bufferMilli: toMilli(1) }];
    const key = ulid();
    const putWithKey = (k: string): request.Test =>
      request(app.getHttpServer())
        .put(`${API}/${tenantId}/channels/connections/${shopifyId}/buffers`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, k)
        .send({ items: items.map((item) => ({ warehouseId, ...item })) });
    const first = await putWithKey(key).expect(200);
    const replay = await putWithKey(key).expect(200);
    expect(replay.body).toEqual(first.body);
    // The buffers list still shows ONE standing buffer of 1 (the replay did
    // not double it — targets are absolute).
    const entry = await (async () => {
      const list = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/channels/connections`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200);
      return (list.body.items as Record<string, unknown>[]).find((e) => e.id === shopifyId)!;
    })();
    const placed = entry.buffers as { skuId: string; bufferMilli: number }[];
    expect(placed.filter((b) => b.skuId === skuId)).toHaveLength(1);
    expect(placed.find((b) => b.skuId === skuId)!.bufferMilli).toBe(toMilli(1));
  });
});