import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { ChannelsFacade } from '../src/modules/channels/channels.facade';
import { OutboundFacade } from '../src/modules/outbound/outbound.facade';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { registerChannelAdapter } from '../src/modules/channels/channel-registry';
import { sealCredential } from '../src/modules/channels/channel-credentials';
import type { ChannelCredential } from '../src/modules/channels/channel-credentials';
import { testAvailabilityArm, unconfiguredRevokeArm } from '../src/modules/channels/channel-availability-port';
import { testWritebackArm, type TestChannelOrderState } from '../src/modules/channels/channel-writeback-port';
import { shopifyParseOrder, shopifyParseCancellation } from '../src/modules/channels/channel-shopify-port';
import { OUTBOX_RELAY } from '../src/shared/events/outbox.seam';
import type { OutboxRelay } from '../src/shared/events/outbox.seam';
import { OUTBOX_MAX_ATTEMPTS } from '../src/shared/events/outbox';
import { testAddress } from './support/shipment-address';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres + Valkey and signs sessions; the
// vault needs a real master key (any ≥32-char string).
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.CHANNEL_ENCRYPTION_KEY ??= 'e2e-only-channel-encryption-key-0123456789abcdef';
// The suites drive the relay's drain() directly (the channel-sync convention);
// every poll worker stays off.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.CHANNELS_SYNC_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const HMAC_HEADER = 'X-Suite-Hmac';
const TOPIC_HEADER = 'X-Suite-Topic';

jest.setTimeout(60_000);

/**
 * The suite's channels: TWO webhook-declared test adapters (one connection
 * per provider per tenant — the unique index), whose parse arms are the
 * Shopify ones so orders ingest the real way over signed deliveries. The
 * happy-path adapter shares the STATES map `testWritebackArm` maintains —
 * the channel's modeled fulfillment/cancellation ledger the state-specific
 * read-back guards read. The second adapter's writeback arm ALWAYS throws —
 * it carries the failure metering, the RD-7 decoupling pins and the DLQ.
 */
const WRITEBACK_STATES = new Map<string, TestChannelOrderState>();
const SECRET = 'whsec-writeback-suite-canary-1';

const WRITEBACK_ADAPTER = {
  code: 'test-writeback',
  displayName: 'Test Writeback',
  credentialFields: [
    { name: 'apiKey', label: 'API key', required: true, description: 'test key' },
    { name: 'webhookSecret', label: 'Webhook signing secret', required: false, description: 'suite signs deliveries directly' },
  ],
  availabilityArm: testAvailabilityArm(),
  revokeArm: unconfiguredRevokeArm('test-writeback'),
  orderWritebackArm: testWritebackArm(WRITEBACK_STATES),
  webhook: {
    topics: { orders: 'orders/create', cancellations: 'orders/cancelled' },
    verification: {
      header: HMAC_HEADER,
      encoding: 'base64' as const,
      scheme: 'hmac-sha256' as const,
      topicHeader: TOPIC_HEADER,
    },
    parseOrder: shopifyParseOrder,
    parseCancellation: shopifyParseCancellation,
  },
};

const FAILING_ADAPTER = {
  code: 'test-writeback-fail',
  displayName: 'Test Writeback Fail',
  credentialFields: [
    { name: 'apiKey', label: 'API key', required: true, description: 'test key' },
    { name: 'webhookSecret', label: 'Webhook signing secret', required: false, description: 'suite signs deliveries directly' },
  ],
  availabilityArm: testAvailabilityArm(),
  revokeArm: unconfiguredRevokeArm('test-writeback-fail'),
  // ALWAYS throws — the transport is down, every attempt fails.
  orderWritebackArm: async (): Promise<never> => {
    throw new Error('test-writeback transport failure (the suite’s always-failing arm)');
  },
  webhook: WRITEBACK_ADAPTER.webhook,
};

registerChannelAdapter(WRITEBACK_ADAPTER as unknown as Parameters<typeof registerChannelAdapter>[0]);
registerChannelAdapter(FAILING_ADAPTER as unknown as Parameters<typeof registerChannelAdapter>[0]);

const SKU_CODES = ['WB-A', 'WB-B', 'WB-C'] as const;
// The kit parent joins the IMPORT + the mapping set but holds NO stock —
// a kit SKU is created on an empty SKU (the catalog's own guard).
const KIT_CODE = 'WB-KIT';
const MAPPED_CODES = [...SKU_CODES, KIT_CODE];

describe('channel writeback: source filter, dedupe, convergence, echo, decoupling, DLQ (e2e, story 7-2)', () => {
  let app: INestApplication;
  let channels: ChannelsFacade;
  let outbound: OutboundFacade;
  let relay: OutboxRelay;
  let suiteDb: SuiteDatabase;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string; // the badge-in DEVICE session (picking)
  let warehouseId: string;
  let binId: string;
  let connId: string;
  let failingConnId: string;
  const skuIds = new Map<string, string>();

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('channel_writeback');
    app = await createApp(false);
    await app.init();
    channels = app.get(ChannelsFacade);
    outbound = app.get(OutboundFacade);
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    await seedTenantFixture();
  });

  afterAll(async () => {
    // Nothing under this suite's tenants is kept. The suite runs against its
    // own clone DB (useSuiteDatabase above); these deletions keep THAT clone
    // small for the suite's own queries, and suiteDb.drop() removes it whole.
    await cleanupRows();
    const db = app.get<unknown>(DATABASE) as Record<string, unknown> & { $client?: { end(): Promise<void> } };
    await (db.$client as { end(): Promise<void> }).end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as Record<string, unknown> & { $client?: { end(): Promise<void> } };
    await (authDb.$client as { end(): Promise<void> }).end();
    await app.close();
    await suiteDb.drop();
  });

  /**
   * Widens the integrations provider CHECK on THIS suite's throwaway DB
   * clone so the registered test adapters can hold integrations rows (the
   * channel-sync convention — the prod schema keeps the frozen enum).
   */
  async function admitTestProvidersInDb(): Promise<void> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`alter table integrations drop constraint if exists integrations_provider_check`;
      await sql`alter table integrations add constraint integrations_provider_check check (provider in ('shopify', 'amazon-in', 'flipkart', 'test-writeback', 'test-writeback-fail'))`;
    } finally {
      await sql.end();
    }
  }

  /** Direct connection insert — the frozen provider DTO vocabulary does not admit test codes. */
  async function insertConnection(
    provider: 'test-writeback' | 'test-writeback-fail',
    ingestWarehouseId: string | null,
    connectedBy: string | null,
  ): Promise<string> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const sealed = sealCredential({ apiKey: 'canary-writeback-key', webhookSecret: SECRET } as ChannelCredential);
      const inserted = (await sql`
        insert into integrations
          (id, tenant_id, provider, status, credential_sealed, credential_version,
           backorder_policy, ingest_warehouse_id, connected_by, created_at, updated_at)
        values (${uuidv7()}, ${tenantId}, ${provider}, 'connected', ${sealed}, 1,
                'accept', ${ingestWarehouseId}, ${connectedBy}, now(), now())
        returning id
      `) as unknown as { id: string }[];
      return inserted[0]!.id;
    } finally {
      await sql.end();
    }
  }

  async function seedTenantFixture(): Promise<void> {
    await admitTestProvidersInDb();
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Writeback Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // The ops manager drives everything web-side (channel.manage,
    // orders.manage, pack/dispatch.execute); the operator badges in for picks.
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

    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `WBW-${ulid().slice(10, 16).toUpperCase()}`, name: `Writeback WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
    const zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    binId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.body.id as string}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 1_000_000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;

    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [csvHeader, ...MAPPED_CODES.map((code) => `${code},Test SKU ${code},pcs,,1800,,,,,`)].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const skus = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) {
      if (MAPPED_CODES.includes(item.code)) {
        skuIds.set(item.code, item.id);
      }
    }
    expect(skuIds.size).toBe(MAPPED_CODES.length);

    // ── the device + badge-in operator (picking feeds every fixture) ────────
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Writeback bench scanner', pin: '2468' })
      .expect(201);
    const deviceToken = enrolled.body.deviceToken as string;
    const operatorEmail = `picker-${ulid().toLowerCase()}@example.com`;
    const operatorInvite = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: operatorEmail, role: 'operator' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: operatorInvite.body.inviteToken, password: 'correct-horse-battery' })
      .expect(200);
    operatorToken = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${deviceToken}`)
        .send({ operatorEmail, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    // ── the two connections (the ingest warehouse set + RD-2's actor) ──────
    connId = await insertConnection('test-writeback', warehouseId, ownerUserId);
    failingConnId = await insertConnection('test-writeback-fail', warehouseId, ownerUserId);
    await seedMappings(connId);
    await seedMappings(failingConnId);

    for (const code of SKU_CODES) {
      await seedStock(code, 50);
    }
    // The grant store's counters start EMPTY in this suite's fresh tenant —
    // the same fixture step every ordering suite runs (grants fail closed
    // 503 without it).
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
  }

  async function seedMappings(connectionId: string): Promise<void> {
    await channels.setChannelMappings(
      tenantId,
      connectionId,
      MAPPED_CODES.map((code) => ({ externalRef: code, skuId: skuIds.get(code)! })),
    );
  }

  async function seedStock(code: string, quantity: number): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId: skuIds.get(code)!,
        binId,
        quantityDelta: quantity,
        reasonCode: 'stock-count',
        note: 'writeback-suite seed',
      })
      .expect(201);
  }

  // ── ingest helpers (the signed-delivery shape the webhooks suite pins —
  // here only as the fixture for ingested orders) ─────────────────────────────

  function sign(bodyText: string): string {
    return createHmac('sha256', SECRET).update(bodyText, 'utf8').digest('base64');
  }

  /** Webhook-ingests one order and returns its internal id (RD-1/RD-2/RD-4). */
  async function ingestRef(
    connectionId: string,
    provider: 'test-writeback' | 'test-writeback-fail',
    orderRef: number,
    code: string,
    quantity: number,
  ): Promise<string> {
    const bodyText = JSON.stringify({
      id: orderRef,
      shipping_address: {
        name: 'Ravi Kumar', phone: '9876543210', address1: 'Plot 12',
        address2: 'Tech Park', city: 'Hyderabad', province: 'Telangana', zip: '500081',
      },
      line_items: [{ sku: code, quantity }],
    });
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/webhooks/channels/${provider}/${connectionId}/orders`)
      .set(HMAC_HEADER, sign(bodyText))
      .set(TOPIC_HEADER, 'orders/create')
      .set('Content-Type', 'application/json')
      .send(bodyText)
      .expect(200);
    return (await outbound.findOrderByChannelRef(tenantId, connectionId, String(orderRef)))!.id;
  }

  /** A manual order — the SOURCE FILTER's counter-example. */
  async function manualOrder(code: string, quantity: number): Promise<string> {
    return (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/orders`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, lines: [{ skuId: skuIds.get(code)!, quantity }], destination: testAddress() })
        .expect(201)
    ).body.order.id as string;
  }

  /** Walks the wave → pick → pack → dispatch flow for one order. */
  async function flowToFulfilment(orderId: string, codes: { code: string; quantity: number }[]): Promise<void> {
    const policyId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/wave-policies`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, name: `WB ${ulid().slice(10, 18)}`, grouping: 'single' })
        .expect(201)
    ).body.policy.id as string;
    const waveId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/waves`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, policyId, orderIds: [orderId] })
        .expect(201)
    ).body.wave.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const wave = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200)
    ).body.wave as {
      picklists: {
        lines: { id: string; picklistId: string; skuId: string; binId: string | null; qty: number }[];
      }[];
    };
    for (const picklist of wave.picklists) {
      for (const line of picklist.lines) {
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/outbound/picks`)
          .set('Authorization', `Bearer ${operatorToken}`)
          .set(KEY_HEADER, ulid())
          .send({
            warehouseId,
            picklistId: line.picklistId,
            picklistLineId: line.id,
            skuId: line.skuId,
            binId: line.binId!,
            qty: line.qty,
            occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          })
          .expect(201);
      }
    }
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned: codes.map(({ code, quantity }) => ({ skuId: skuIds.get(code)!, qty: quantity })) })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ carrierName: 'Blue Dart', trackingNumber: `BD-${orderId.slice(-8)}` })
      .expect(201);
  }

  /** Drains every due row (the suites' direct relay drive). */
  async function drainAll(): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      const res = await relay.drain(25);
      if (res.length === 0) return;
    }
    throw new Error('the outbox never emptied — 50 rounds');
  }

  async function sqlHandle(): Promise<postgres.Sql<Record<string, unknown>>> {
    return postgres(process.env.DATABASE_URL!, { max: 1 });
  }

  async function writebackRows(connectionId: string): Promise<{ status: string; error: string | null }[]> {
    const sql = await sqlHandle();
    try {
      return (await sql`
        select ic.status, ic.error from integration_calls ic
        where ic.tenant_id = ${tenantId} and ic.integration_id = ${connectionId} and ic.kind = 'order-writeback'
        order by ic.at asc
      `) as unknown as { status: string; error: string | null }[];
    } finally {
      await sql.end();
    }
  }

  /** Re-arms every outbox row of one type for an immediate re-drain. */
  async function forceDue(type: string): Promise<void> {
    const sql = await sqlHandle();
    try {
      await sql`update outbox_messages set next_attempt_at = now() where tenant_id = ${tenantId} and type = ${type}`;
    } finally {
      await sql.end();
    }
  }

  async function handAppendPacked(orderId: string): Promise<void> {
    const sql = await sqlHandle();
    try {
      await sql`
        insert into outbox_messages (id, tenant_id, type, payload, occurred_at, status, next_attempt_at)
        values (${uuidv7()}, ${tenantId}, 'order.packed', ${sql.json({ pack: { orderId } })}, now(), 'pending', now())
      `;
    } finally {
      await sql.end();
    }
  }

  async function deletePackedRows(): Promise<void> {
    const sql = await sqlHandle();
    try {
      await sql`delete from outbox_messages where tenant_id = ${tenantId} and type = 'order.packed'`;
    } finally {
      await sql.end();
    }
  }

  async function clearOutbox(): Promise<void> {
    const sql = await sqlHandle();
    try {
      await sql`delete from outbox_messages where tenant_id = ${tenantId}`;
    } finally {
      await sql.end();
    }
  }

  async function integrationHealth(id: string): Promise<Record<string, unknown>> {
    const sql = await sqlHandle();
    try {
      const rows = (await sql`
        select last_synced_at as "lastSyncedAt", last_error as "lastError",
               consecutive_failures as "consecutiveFailures", breaker_state as "breakerState",
               last_attempt_at as "lastAttemptAt"
        from integrations where tenant_id = ${tenantId} and id = ${id}
      `) as unknown as Record<string, unknown>[];
      return rows[0]!;
    } finally {
      await sql.end();
    }
  }

  async function orderStatus(orderId: string): Promise<string> {
    return (await outbound.orderForWriteback(tenantId, orderId))!.status;
  }

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      for (const table of [
        'channel_mappings',
        'integration_calls',
        'integrations',
        'picks',
        'picklist_lines',
        'picklists',
        'waves',
        'wave_policies',
        'order_lines',
        'orders',
      ]) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      for (const table of [
        'reservations',
        'batch_on_hand',
        'stock_on_hand',
        'outbox_messages',
        'idempotency_keys',
        'audit_events',
        'catalog_import_errors',
        'catalog_imports',
        'uom_conversions',
        'skus',
        'devices',
        'bins',
        'zones',
        'warehouses',
        'users',
        'tenants',
      ]) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
    } finally {
      await cleaner.end();
    }
  }

  // ── the source filter (row 7's first filter) ──────────────────────────────

  it('a MANUAL order’s pack + dispatch write back NOTHING — no meter rows, no channel state', async () => {
    const orderId = await manualOrder('WB-B', 2);
    await flowToFulfilment(orderId, [{ code: 'WB-B', quantity: 2 }]);
    await drainAll();
    // Writeback states are keyed by the order REF — a manual order never has one.
    expect(WRITEBACK_STATES.size).toBe(0);
    expect(await writebackRows(connId)).toEqual([]);
    expect(await writebackRows(failingConnId)).toEqual([]);
    await clearOutbox();
  });

  // ── the happy writeback ────────────────────────────────────────────────────

  it('an INGESTED order’s pack + dispatch land on the channel — one tracked fulfillment, two ok settles (RD-7)', async () => {
    const ref = 8_300_000_000_001;
    const orderId = await ingestRef(connId, 'test-writeback', ref, 'WB-A', 2);
    await flowToFulfilment(orderId, [{ code: 'WB-A', quantity: 2 }]);
    await drainAll();
    const state = WRITEBACK_STATES.get(String(ref))!;
    expect(state.fulfillments.size).toBe(1);
    const fulfillment = [...state.fulfillments.values()][0]!;
    expect(fulfillment.withTracking).toBe(true);
    expect(fulfillment.carrier).toBe('Blue Dart');
    expect(fulfillment.tracking).toBe(`BD-${orderId.slice(-8)}`);
    const rows = await writebackRows(connId);
    expect(rows.map((row) => row.status)).toEqual(['ok', 'ok']);
    await clearOutbox();
  });

  it('a REDRAINED row dedupes through the read-back guard — no second channel fulfillment, a noop settles ok', async () => {
    const ref = 8_300_000_000_001; // the previous test's order — re-append its packed row
    const state = WRITEBACK_STATES.get(String(ref))!;
    expect(state.fulfillments.size).toBe(1);
    const fulfillmentBefore = [...state.fulfillments.values()][0]!;
    await handAppendPacked((await outbound.findOrderByChannelRef(tenantId, connId, String(ref)))!.id);
    await drainAll();
    expect(state.fulfillments.size).toBe(1);
    expect([...state.fulfillments.values()][0]!.tracking).toBe(fulfillmentBefore.tracking);
    // The noop STILL settles — an idempotent re-statement mints its meter row.
    expect((await writebackRows(connId)).length).toBe(3);
    expect((await writebackRows(connId)).at(-1)!.status).toBe('ok');
    await clearOutbox();
  });

  it('REORDERING converges: dispatched settling first still ends with ONE tracked fulfillment', async () => {
    const ref = 8_300_000_000_002;
    const orderId = await ingestRef(connId, 'test-writeback', ref, 'WB-C', 2);
    await flowToFulfilment(orderId, [{ code: 'WB-C', quantity: 2 }]);
    // The relay's reordering window: the dispatched row drains while the
    // packed row is missing (deleted here to simulate the skew).
    await deletePackedRows();
    await drainAll();
    const state = WRITEBACK_STATES.get(String(ref))!;
    expect(state.fulfillments.size).toBe(1);
    expect([...state.fulfillments.values()][0]!.withTracking).toBe(true);
    // The packed row lands LATE — the read-back sees the tracked fulfillment and acks.
    await handAppendPacked(orderId);
    await drainAll();
    expect(state.fulfillments.size).toBe(1);
    expect((await writebackRows(connId)).at(-1)!.status).toBe('ok');
    await clearOutbox();
  });

  it('the ECHO settles: a channel-originated cancellation writes back one idempotent noop (RN-5)', async () => {
    const ref = 8_300_000_000_003;
    const orderId = await ingestRef(connId, 'test-writeback', ref, 'WB-A', 1);
    // The channel ALREADY holds the cancellation — the echo source.
    WRITEBACK_STATES.set(String(ref), { fulfillments: new Map(), cancelled: true });
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    await drainAll();
    const state = WRITEBACK_STATES.get(String(ref))!;
    expect(state.cancelled).toBe(true);
    expect(state.fulfillments.size).toBe(0);
    expect((await writebackRows(connId)).at(-1)!.status).toBe('ok');
    expect(await orderStatus(orderId)).toBe('cancelled');
    await clearOutbox();
  });

  it('the GONE-connection arm acks with no meter row (the 7-1 posture, PENDING row 133)', async () => {
    const ref = 8_300_000_000_004;
    const orderId = await ingestRef(connId, 'test-writeback', ref, 'WB-B', 1);
    // The connection leaves BEFORE the packed event drains.
    const rowsBefore = (await writebackRows(connId)).length;
    await request(app.getHttpServer())
      .delete(`${API}/${tenantId}/channels/connections/${connId}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .expect(204);
    await flowToFulfilment(orderId, [{ code: 'WB-B', quantity: 1 }]);
    await drainAll();
    // The meter is append-only over THIS connection's id — the gone arm's
    // pinned posture: no NEW row appeared for the dropped delivery.
    expect((await writebackRows(connId)).length).toBe(rowsBefore);
    expect(await orderStatus(orderId)).toBe('dispatched'); // the order side is untouched
    // Re-create the connection row for the remaining tests.
    connId = await insertConnection('test-writeback', warehouseId, ownerUserId);
    await seedMappings(connId);
    await clearOutbox();
  });

  it('a FAILING writeback: meters failed, touches NO sync stamp, never rungs the breaker — DLQ past budget (RD-7)', async () => {
    const ref = 8_300_000_000_005;
    await ingestRef(failingConnId, 'test-writeback-fail', ref, 'WB-B', 1);
    const orderId = (await outbound.findOrderByChannelRef(tenantId, failingConnId, String(ref)))!.id;
    await flowToFulfilment(orderId, [{ code: 'WB-B', quantity: 1 }]);
    // Drain to the retry budget: every attempt meters exactly one failed row.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i += 1) {
      await forceDue('order.packed');
      await relay.drain(25);
    }
    const rows = await writebackRows(failingConnId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.status).toBe('failed');
    }
    expect(rows.at(-1)!.error).toContain('test-writeback transport failure');
    // The row is past the relay's budget — dead-lettered (no pending left).
    const sql = await sqlHandle();
    try {
      const remaining = (await sql`
        select type, status, attempts from outbox_messages
        where tenant_id = ${tenantId} and type = 'order.packed'
        order by created_at asc
      `) as unknown as { type: string; status: string; attempts: number }[];
      expect(remaining.every((row) => row.status === 'quarantined')).toBe(true);
      for (const row of remaining) {
        expect(row.attempts).toBeGreaterThanOrEqual(OUTBOX_MAX_ATTEMPTS);
      }
    } finally {
      await sql.end();
    }
    // RD-7's decoupling, pinned: the sync machinery NEVER moved for a
    // failing writeback — same stamps, closed breaker, zero pressure.
    const health = await integrationHealth(failingConnId);
    expect(health.lastSyncedAt).toBeNull();
    expect(health.lastError).toBeNull();
    expect(health.lastAttemptAt).toBeNull();
    expect(health.consecutiveFailures).toBe(0);
    expect(health.breakerState).toBe('closed');
    await clearOutbox();
  });

  // ── the mapping-loss refusals (review patch P3: RD-7 amended) ─────────────

  /** A multi-line ingest of one order (the partial-resolution fixture). */
  async function ingestLines(
    connectionId: string,
    provider: 'test-writeback' | 'test-writeback-fail',
    orderRef: number,
    lines: { code: string; quantity: number }[],
  ): Promise<string> {
    const bodyText = JSON.stringify({
      id: orderRef,
      shipping_address: {
        name: 'Ravi Kumar', phone: '9876543210', address1: 'Plot 12',
        address2: 'Tech Park', city: 'Hyderabad', province: 'Telangana', zip: '500081',
      },
      line_items: lines.map(({ code, quantity }) => ({ sku: code, quantity })),
    });
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/webhooks/channels/${provider}/${connectionId}/orders`)
      .set(HMAC_HEADER, sign(bodyText))
      .set(TOPIC_HEADER, 'orders/create')
      .set('Content-Type', 'application/json')
      .send(bodyText)
      .expect(200);
    return (await outbound.findOrderByChannelRef(tenantId, connectionId, String(orderRef)))!.id;
  }

  function cancelBodyText(orderRef: number): string {
    return JSON.stringify({ id: orderRef });
  }

  /** The mapping PUT (arm 7) — the FULL-REPLACE seam the refusals name. */
  function putMappings(items: { externalRef: string; skuId: string }[]): request.Test {
    return request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${connId}/mappings`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ items });
  }

  it('a writeback whose lines PARTIALLY unresolve refuses WHOLE — the meter names the remediation, no partial fulfillment posts', async () => {
    const ref = 8_300_000_000_006;
    await ingestLines(connId, 'test-writeback', ref, [
      { code: 'WB-A', quantity: 2 },
      { code: 'WB-B', quantity: 1 },
    ]);
    // Full replacement minus WB-B (the remediation the refusal names): one
    // of the two packed lines now unresolves.
    await putMappings([{ externalRef: 'WB-A', skuId: skuIds.get('WB-A')! }]).expect(200);
    await flowToFulfilment((await outbound.findOrderByChannelRef(tenantId, connId, String(ref)))!.id, [
      { code: 'WB-A', quantity: 2 },
      { code: 'WB-B', quantity: 1 },
    ]);
    // The attempt meters ONE failed 'order-writeback' row naming the
    // mapping PUT as the healer — and posts NOTHING to the channel (the
    // half-measure of silently dropping the unmapped line is gone).
    await relay.drain(25);
    const rows = await writebackRows(connId);
    expect(rows.at(-1)!.status).toBe('failed');
    expect(rows.at(-1)!.error).toContain('1 of 2 order line(s) resolve to no channel SKU mapping');
    expect(rows.at(-1)!.error).toContain('map the SKU(s) (mapping PUT) to heal');
    expect(WRITEBACK_STATES.get(String(ref))?.fulfillments.size ?? 0).toBe(0);

    // The refusal is RETRYABLE honestly, and the HEAL lands it: the mapping
    // set restored, the redrained packed row posts and settles ok.
    await putMappings(MAPPED_CODES.map((code) => ({ externalRef: code, skuId: skuIds.get(code)! }))).expect(200);
    await forceDue('order.packed');
    await drainAll();
    const healed = WRITEBACK_STATES.get(String(ref))!;
    expect(healed.fulfillments.size).toBe(1);
    expect((await writebackRows(connId)).at(-1)!.status).toBe('ok');
    await clearOutbox();
  });

  it('a writeback whose EVERY line unresolves refuses whole with the zero-resolved count (review patch P9)', async () => {
    const ref = 8_300_000_000_008;
    await ingestRef(connId, 'test-writeback', ref, 'WB-C', 1);
    await putMappings([]).expect(200); // the total clear
    await flowToFulfilment((await outbound.findOrderByChannelRef(tenantId, connId, String(ref)))!.id, [
      { code: 'WB-C', quantity: 1 },
    ]);
    await relay.drain(25);
    const rows = await writebackRows(connId);
    expect(rows.at(-1)!.status).toBe('failed');
    expect(rows.at(-1)!.error).toContain('1 of 1 order line(s) resolve to no channel SKU mapping');
    expect(WRITEBACK_STATES.get(String(ref))?.fulfillments.size ?? 0).toBe(0);
    await clearOutbox();
  });

  it('a KIT order’s writeback posts the CHILDREN only — the parent never posts, mapped or unmapped (review patch P3)', async () => {
    // The kit exists only through the catalog route (kit-ness is relational):
    // 1×WB-KIT = 1×WB-A + 1×WB-C, every member mapped — the total clear the
    // previous test left behind is undone first.
    await channels.setChannelMappings(
      tenantId,
      connId,
      MAPPED_CODES.map((code) => ({ externalRef: code, skuId: skuIds.get(code)! })),
    );
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/skus/${skuIds.get('WB-KIT')!}/kit`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        components: [
          { skuId: skuIds.get('WB-A')!, quantity: 1 },
          { skuId: skuIds.get('WB-C')!, quantity: 1 },
        ],
      })
      .expect(201);
    const ref = 8_300_000_000_009;
    const orderId = await ingestRef(connId, 'test-writeback', ref, 'WB-KIT', 1);
    // The picklists carry the exploded children; the bench scans components.
    await flowToFulfilment(orderId, [
      { code: 'WB-A', quantity: 1 },
      { code: 'WB-C', quantity: 1 },
    ]);
    await drainAll();
    const state = WRITEBACK_STATES.get(String(ref))!;
    expect(state.fulfillments.size).toBe(1);
    // The FIRST applied statement posted exactly the children (the later
    // dispatched statement converges through the same read-back entry).
    expect(state.postedLines!.slice(0, 2)).toEqual([
      { externalRef: 'WB-A', quantity: 1 },
      { externalRef: 'WB-C', quantity: 1 },
    ]);
    for (const line of state.postedLines!) {
      expect(line.externalRef).not.toBe('WB-KIT'); // the parent NEVER posts
    }
    // The parent's mapping DROPPED (the components stay): the unmapped
    // parent refuses NOTHING — the exclusion ran BEFORE the mapping
    // resolution, and the re-drained packed row reads the fulfillment
    // and acks.
    await putMappings([
      { externalRef: 'WB-A', skuId: skuIds.get('WB-A')! },
      { externalRef: 'WB-C', skuId: skuIds.get('WB-C')! },
    ]).expect(200);
    await handAppendPacked(orderId);
    await drainAll();
    expect(WRITEBACK_STATES.get(String(ref))!.fulfillments.size).toBe(1); // no second fulfillment
    expect((await writebackRows(connId)).at(-1)!.status).toBe('ok');
    await clearOutbox();
  });

  it('a cancellation of a PACKED ingest order answers 200 {outcome: ignored} — meter + audit row (RD-8, review patches P9/P10)', async () => {
    const ref = 8_300_000_000_010;
    // Restore a set that maps this order's line (the kit test shrank it).
    await putMappings(MAPPED_CODES.map((code) => ({ externalRef: code, skuId: skuIds.get(code)! }))).expect(200);
    const orderId = await ingestRef(connId, 'test-writeback', ref, 'WB-B', 1);
    await flowToFulfilment(orderId, [{ code: 'WB-B', quantity: 1 }]);
    await drainAll();
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/webhooks/channels/test-writeback/${connId}/cancellations`)
      .set(HMAC_HEADER, sign(cancelBodyText(ref)))
      .set(TOPIC_HEADER, 'orders/cancelled')
      .set('Content-Type', 'application/json')
      .send(cancelBodyText(ref))
      .expect(200);
    expect(res.body.outcome).toBe('ignored');
    const sql = await sqlHandle();
    try {
      const meters = (await sql`
        select status from integration_calls
        where tenant_id = ${tenantId} and integration_id = ${connId}
          and kind = 'order-ingest' and status = 'ignored'
      `) as unknown as { status: string }[];
      expect(meters.length).toBeGreaterThanOrEqual(1);
      const audits = (await sql`
        select target_id, reference from audit_events
        where tenant_id = ${tenantId} and action = 'order.cancellation_ignored' and target_id = ${orderId}
      `) as unknown as { target_id: string; reference: string }[];
      expect(audits).toHaveLength(1);
      expect(audits[0]!.reference).toBe(String(ref));
      // The order's units already left — the status stands, the channel's
      // truth and ours already agree (RD-8).
      expect(await orderStatus(orderId)).toBe('dispatched');
    } finally {
      await sql.end();
    }
    await clearOutbox();
  });
});
