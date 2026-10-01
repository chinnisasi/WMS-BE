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
import { sealCredential, openCredential } from '../src/modules/channels/channel-credentials';
import type { ChannelCredential } from '../src/modules/channels/channel-credentials';
import { testAvailabilityArm, unconfiguredRevokeArm } from '../src/modules/channels/channel-availability-port';
import { testWritebackArm } from '../src/modules/channels/channel-writeback-port';
import { shopifyParseOrder, shopifyParseCancellation } from '../src/modules/channels/channel-shopify-port';
import { ROLE_CAPABILITIES } from '../src/modules/tenancy/permissions';
import { testAddress } from './support/shipment-address';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres + Valkey and signs sessions; the
// vault needs a real master key (any ≥32-char string).
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.CHANNEL_ENCRYPTION_KEY ??= 'e2e-only-channel-encryption-key-0123456789abcdef';
// Background workers stay off in suites — the webhook route is SYNCHRONOUS
// (RD-9), no outbox drain is needed for the ingest arms.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.CHANNELS_SYNC_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/**
 * The suite's own ingest-capable adapter: the test-channel registration that
 * carries a WEBHOOK DECLARATION (RD-5) whose parse arms are the Shopify
 * ones — deliveries are therefore Shopify-SHAPED bodies (the `id` ref, the
 * `line_items` sku+quantity lines) over a suite-owned header pair. The
 * frozen three channels' declarations stay their own (the shopify arms get
 * their registry-level wiring pinned in the transport suite); this suite
 * tests the CONTROLLER's contract, which is provider-shaped not
 * provider-coupled.
 */
registerChannelAdapter({
  code: 'test-webhook',
  displayName: 'Test Webhook',
  credentialFields: [
    { name: 'apiKey', label: 'API key', required: true, description: 'test key' },
    { name: 'webhookSecret', label: 'Webhook signing secret', required: false, description: 'suite signs deliveries directly' },
    { name: 'locationId', label: 'Location', required: false, description: 'unused in this suite' },
  ],
  availabilityArm: testAvailabilityArm(),
  revokeArm: unconfiguredRevokeArm('test-webhook'),
  orderWritebackArm: testWritebackArm(new Map()),
  webhook: {
    topics: { orders: 'orders/create', cancellations: 'orders/cancelled' },
    verification: {
      header: 'X-Suite-Hmac',
      encoding: 'base64',
      scheme: 'hmac-sha256',
      topicHeader: 'X-Suite-Topic',
    },
    parseOrder: shopifyParseOrder,
    parseCancellation: shopifyParseCancellation,
  },
});

// One connection PER PROVIDER PER TENANT (`integrations_tenant_provider_
// unique` — a connection IS a shop) — so this suite drives ONE ingest
// connection and MUTATES its config between phases (the same mutation the
// config PUT / rotate would do; the direct SQL keeps the phases independent).
const SECRET_ONE = 'whsec-webhook-suite-canary-1';
const SECRET_TWO = 'whsec-webhook-suite-canary-2';

const SKU_CODES = [
  'WH-A', // the accepted line's SKU (stocked)
  'WH-B', // the divergence + cancellation test's SKU (stocked)
  'WH-REJ', // zero-stock line (zero-grant + accept-shortfall cases)
  'WH-KIT', // the kit parent
  'WH-C1', // kit component 1 (stocked)
  'WH-C2', // kit component 2 (starved)
] as const;

describe('channel webhooks: ingest arms, verification, dedup, policy, RBAC (e2e, story 7-2)', () => {
  let app: INestApplication;
  let channels: ChannelsFacade;
  let outbound: OutboundFacade;
  let suiteDb: SuiteDatabase;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let opsToken: string;
  let accountantUserId = '';
  let warehouseId: string;
  let connId: string;
  let flipkartId: string;
  const skuIds = new Map<string, string>();

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('channel_webhooks');
    app = await createApp(false);
    await app.init();
    channels = app.get(ChannelsFacade);
    outbound = app.get(OutboundFacade);
    await seedTenantFixture();
  });

  afterAll(async () => {
    await cleanupRows();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await (db.$client as { end(): Promise<void> }).end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await (authDb.$client as { end(): Promise<void> }).end();
    await app.close();
    await suiteDb.drop();
  });

  async function admitTestProviderInDb(): Promise<void> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`alter table integrations drop constraint if exists integrations_provider_check`;
      await sql`alter table integrations add constraint integrations_provider_check check (provider in ('shopify', 'amazon-in', 'flipkart', 'test-webhook'))`;
    } finally {
      await sql.end();
    }
  }

  /** Direct connection insert — the frozen provider DTO vocabulary does not admit test codes. */
  async function insertConnection(args: {
    secret: string;
    ingestWarehouseId: string | null;
    connectedBy: string;
    backorderPolicy?: 'accept' | 'reject';
  }): Promise<string> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const sealed = sealCredential({ apiKey: 'canary-wh-key', webhookSecret: args.secret } as ChannelCredential);
      const inserted = (await sql`
        insert into integrations
          (id, tenant_id, provider, status, credential_sealed, credential_version,
           backorder_policy, ingest_warehouse_id, connected_by, created_at, updated_at)
        values (${uuidv7()}, ${tenantId}, 'test-webhook', 'connected', ${sealed}, 1,
                ${args.backorderPolicy ?? 'accept'}, ${args.ingestWarehouseId}, ${args.connectedBy}, now(), now())
        returning id
      `) as unknown as { id: string }[];
      return inserted[0]!.id;
    } finally {
      await sql.end();
    }
  }

  async function seedTenantFixture(): Promise<void> {
    await admitTestProviderInDb();
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Webhook Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
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

    // The ops manager (channel.manage + orders.manage) and the accountant
    // (NO capabilities — the fail-closed ingest actor, RD-2).
    for (const [role, mailPrefix] of [
      ['ops_manager', 'ops'],
      ['accountant', 'bean'],
    ] as const) {
      const acctEmail = `${mailPrefix}-${ulid().toLowerCase()}@example.com`;
      const invited = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/users`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email: acctEmail, role })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken, password: `${mailPrefix}-password-123` })
        .expect(200);
      if (role === 'ops_manager') {
        opsToken = (
          await request(app.getHttpServer())
            .post(`${API}/sign-in`)
            .send({ email: acctEmail, password: 'ops-password-123' })
            .expect(200)
        ).body.accessToken as string;
      } else {
        accountantUserId = (
          await request(app.getHttpServer())
            .get(`${API}/${tenantId}/users`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .expect(200)
        ).body.items.find((u: { email: string }) => u.email === acctEmail).id as string;
      }
    }

    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ origin: testAddress(), code: `WHK-${ulid().slice(10, 16).toUpperCase()}`, name: `Webhook WH ${ulid()}` })
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
      .send({ capacity: 1000000, type: 'shelf', code: 'A-01-01' })
      .expect(201);

    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [csvHeader, ...SKU_CODES.map((code) => `${code},Test SKU ${code},pcs,,1800,,,,,`)].join('\n');
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
      if ((SKU_CODES as readonly string[]).includes(item.code)) {
        skuIds.set(item.code, item.id);
      }
    }
    expect(skuIds.size).toBe(SKU_CODES.length);

    flipkartId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/channels/connections`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          provider: 'flipkart',
          credentials: { appId: 'canary-flipkart-app-1', appSecret: 'canary-flipkart-secret-2' },
        })
        .expect(201)
    ).body.id as string;

    connId = await insertConnection({ secret: SECRET_ONE, ingestWarehouseId: warehouseId, connectedBy: ownerUserId });

    // Mappings: the kit family + the stocked plain lines.
    await channels.setChannelMappings(
      tenantId,
      connId,
      ['WH-A', 'WH-B', 'WH-REJ', 'WH-KIT', 'WH-C1', 'WH-C2'].map((code) => ({ externalRef: code, skuId: skuIds.get(code)! })),
    );

    // The kit: 1 WH-KIT explodes to 2×WH-C1 + 3×WH-C2.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/skus/${skuIds.get('WH-KIT')!}/kit`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: skuIds.get('WH-C1')!, quantity: 2 }, { skuId: skuIds.get('WH-C2')!, quantity: 3 }] })
      .expect(201);

    // Stock: the happy-path lines fully; the kit's C2 starved (4 < 6).
    await seedStock('WH-A', 100);
    await seedStock('WH-B', 100);
    await seedStock('WH-C1', 100);
    await seedStock('WH-C2', 4);

    // The grant store's counters start EMPTY in this suite's fresh tenant —
    // the same fixture step every ordering suite runs (grants fail closed
    // 503 without it).
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
  }

  async function seedStock(code: string, quantity: number): Promise<void> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const bins = (await sql`
        select id from bins where warehouse_id = ${warehouseId} order by code asc limit 1
      `) as unknown as { id: string }[];
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: skuIds.get(code)!, binId: bins[0]!.id, quantityDelta: quantity, reasonCode: 'stock-count', note: 'webhook-suite seed' })
        .expect(201);
    } finally {
      await sql.end();
    }
  }

  /** The phase mutations on the ONE ingest connection (config PUT / rotate equivalents). */
  async function mutateConnection(fields: {
    ingestWarehouseId?: string | null;
    backorderPolicy?: 'accept' | 'reject';
    connectedBy?: string;
  }): Promise<void> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.ingestWarehouseId !== undefined) {
        params.push(fields.ingestWarehouseId);
        sets.push(`ingest_warehouse_id = $${params.length}::uuid`);
      }
      if (fields.backorderPolicy !== undefined) {
        params.push(fields.backorderPolicy);
        sets.push(`backorder_policy = $${params.length}`);
      }
      if (fields.connectedBy !== undefined) {
        params.push(fields.connectedBy);
        sets.push(`connected_by = $${params.length}::uuid`);
      }
      if (sets.length === 0) return;
      params.push(tenantId, connId);
      await sql.unsafe(
        `update integrations set ${sets.join(', ')} where tenant_id = $${params.length - 1}::uuid and id = $${params.length}::uuid`,
        params as never[],
      );
    } finally {
      await sql.end();
    }
  }

  // ── the signed-delivery helpers ────────────────────────────────────────────
  // The signature is over the EXACT bytes the request carries: the body text
  // is stringified once and sent verbatim (rawBody re-captures the bytes).

  function sign(secret: string, bodyText: string): string {
    return createHmac('sha256', secret).update(bodyText, 'utf8').digest('base64');
  }

  function orderBody(orderRef: number, lines: { sku: string; quantity: number }[]): string {
    return JSON.stringify({
      id: orderRef,
      shipping_address: {
        name: 'Ravi Kumar',
        phone: '9876543210',
        address1: 'Plot 12',
        address2: 'Tech Park',
        city: 'Hyderabad',
        province: 'Telangana',
        zip: '500081',
      },
      line_items: lines,
    });
  }

  function cancelBody(orderRef: number): string {
    return JSON.stringify({ id: orderRef });
  }

  function postOrder(conn: string, bodyText: string, secret = SECRET_ONE, topic = 'orders/create') {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/webhooks/channels/test-webhook/${conn}/orders`)
      .set('X-Suite-Hmac', sign(secret, bodyText))
      .set('X-Suite-Topic', topic)
      .set('Content-Type', 'application/json')
      .send(bodyText);
  }

  function postCancel(conn: string, bodyText: string, secret = SECRET_ONE, topic = 'orders/cancelled') {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/webhooks/channels/test-webhook/${conn}/cancellations`)
      .set('X-Suite-Hmac', sign(secret, bodyText))
      .set('X-Suite-Topic', topic)
      .set('Content-Type', 'application/json')
      .send(bodyText);
  }

  function postOrderTo(provider: string, conn: string, bodyText: string): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/webhooks/channels/${provider}/${conn}/orders`)
      .set('Content-Type', 'application/json')
      .send(bodyText);
  }

  async function sqlHandle(): Promise<postgres.Sql<Record<string, unknown>>> {
    return postgres(process.env.DATABASE_URL!, { max: 1 });
  }

  async function meterRows(connectionId: string): Promise<{ kind: string; status: string; error: string | null }[]> {
    const sql = await sqlHandle();
    try {
      return (await sql`
        select kind, status, error from integration_calls
        where tenant_id = ${tenantId} and integration_id = ${connectionId}
        order by at asc
      `) as unknown as { kind: string; status: string; error: string | null }[];
    } finally {
      await sql.end();
    }
  }

  async function clearMeterRows(connectionId: string): Promise<void> {
    const sql = await sqlHandle();
    try {
      await sql`delete from integration_calls where tenant_id = ${tenantId} and integration_id = ${connectionId}`;
    } finally {
      await sql.end();
    }
  }

  async function readStoredCredential(connectionId: string): Promise<ChannelCredential> {
    const sql = await sqlHandle();
    try {
      const rows = (await sql`
        select credential_sealed from integrations where tenant_id = ${tenantId} and id = ${connectionId}
      `) as unknown as { credential_sealed: string }[];
      return openCredential(rows[0]!.credential_sealed);
    } finally {
      await sql.end();
    }
  }

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql.unsafe('set session_replication_role = replica');
      for (const table of [
        'channel_mappings',
        'integration_calls',
        'integrations',
        'kit_compositions',
        'order_lines',
        'orders',
        'reservations',
        'ledger_events',
        'stock_on_hand',
        'batch_on_hand',
        'ledger_anchors',
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
        await sql.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      await sql.unsafe('set session_replication_role = DEFAULT');
    } finally {
      await sql.end();
    }
  }

  // ── phase A: the ingest happy path (RD-1/RD-2/RD-4) ───────────────────────

  it('a verified delivery accepts through THE order path — source ingested, the connection its actor', async () => {
    const res = await postOrder(connId, orderBody(9_000_000_010_001, [{ sku: 'WH-A', quantity: 3 }])).expect(200);
    expect(res.body.outcome).toBe('accepted');
    const order = await outbound.orderForWriteback(tenantId, res.body.orderId);
    expect(order).not.toBeNull();
    expect(order!.source).toBe('ingested');
    expect(order!.integrationId).toBe(connId);
    expect(order!.externalEventId).toBe('9000000010001');
    expect(order!.status).toBe('accepted');
  });

  it('the same payload redelivered answers the SAME order as replayed (RD-1 eternal dedup)', async () => {
    const res = await postOrder(connId, orderBody(9_000_000_010_001, [{ sku: 'WH-A', quantity: 3 }])).expect(200);
    expect(res.body.outcome).toBe('replayed');
    expect(res.body.orderId).toBe(
      (await outbound.findOrderByChannelRef(tenantId, connId, '9000000010001'))!.id,
    );
  });

  it('concurrent same-deliveries resolve to ONE order — both answer it', async () => {
    const bodyText = orderBody(9_000_000_010_002, [{ sku: 'WH-A', quantity: 1 }]);
    const [first, second] = await Promise.all([postOrder(connId, bodyText), postOrder(connId, bodyText)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The pin: BOTH resolve to the same order (the partial unique + the
    // dedup-loser resolution). The outcome labels coincide here when both
    // pre-checks ran before the winner committed — the honest replayed label
    // is pinned by the sequential redelivery test above.
    expect(second.body.orderId).toBe(first.body.orderId);
    for (const label of [first.body.outcome, second.body.outcome]) {
      expect(['accepted', 'backordered', 'replayed']).toContain(label);
    }
  });

  it('a divergent payload on a known ref answers 422 naming the order id', async () => {
    const existing = await outbound.findOrderByChannelRef(tenantId, connId, '9000000010001');
    const res = await postOrder(connId, orderBody(9_000_000_010_001, [{ sku: 'WH-A', quantity: 5 }])).expect(422);
    expect(res.body.code).toBe('order-source-conflict');
    expect(res.body.detail).toContain(existing!.id);
  });

  it('an unmapped external ref answers 400 naming that ref (tenant-owned vocabulary)', async () => {
    const res = await postOrder(connId, orderBody(9_000_000_010_003, [{ sku: 'WH-UNMAPPED', quantity: 1 }])).expect(400);
    expect(res.body.code).toBe('validation-failed');
    expect(res.body.detail).toContain('WH-UNMAPPED');
    const rows = await meterRows(connId);
    expect(rows.at(-1)!.status).toBe('unmapped');
  });

  it('a verified body carrying no mappable shape answers 400 naming nothing channel-sensitive', async () => {
    const res = await postOrder(connId, JSON.stringify({ nonsense: 'shape' })).expect(400);
    expect(res.body.code).toBe('validation-failed');
    expect(res.body.detail).not.toContain('canary');
  });

  // ── phase B: the verification-failure class (RD-5) ────────────────────────

  it('tampered body answers 401 with an empty detail — before any parse', async () => {
    // A WELL-FORMED body signed with a DIFFERENT secret than the connection
    // holds: the 401 must fire BEFORE the parse arm (the no-shape body test
    // below proves a parse-first design would answer differently).
    const res = await postOrder(connId, JSON.stringify({ nonsense: 'shape' }), 'whsec-the-wrong-secret').expect(401);
    expect(res.body.code).toBe('webhook-signature-invalid');
    expect(res.body.detail).toBe('');
  });

  it('a captured orders delivery replayed against cancellations fails the TOPIC BINDING (valid HMAC)', async () => {
    const bodyText = orderBody(9_000_000_000_001, [{ sku: 'WH-A', quantity: 1 }]);
    // Correct signature, correct orders topic — but the CANCELLATIONS
    // endpoint, which declares 'orders/cancelled'.
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/webhooks/channels/test-webhook/${connId}/cancellations`)
      .set('X-Suite-Hmac', sign(SECRET_ONE, bodyText))
      .set('X-Suite-Topic', 'orders/create')
      .set('Content-Type', 'application/json')
      .send(bodyText)
      .expect(401);
    expect(res.body.code).toBe('webhook-signature-invalid');
    expect(res.body.detail).toBe('');
  });

  it('the coarse verification-failed counter rate-limits within its window and names nothing (RD-5/bl-5)', async () => {
    await clearMeterRows(connId);
    for (let i = 0; i < 3; i += 1) {
      await postOrder(connId, orderBody(9_000_000_010_009 + i, [{ sku: 'WH-A', quantity: 1 }]), 'whsec-the-wrong-secret').expect(401);
    }
    const rows = (await meterRows(connId)).filter((row) => row.status === 'verification-failed');
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe('order-ingest');
    expect(rows[0]!.error).toBeNull();
  });

  // ── phase C: routes that answer before any connection work ────────────────

  it('a shape-valid delivery to an unknown connection answers 404 naming nothing', async () => {
    await postOrder(uuidv7(), orderBody(9_000_000_010_040, [{ sku: 'WH-A', quantity: 1 }])).expect(404);
  });

  it('a connection addressed under the WRONG provider path answers 404', async () => {
    // The connection exists — but not under THIS provider path.
    await postOrderTo('flipkart', connId, orderBody(9_000_000_010_041, [{ sku: 'WH-A', quantity: 1 }])).expect(404);
  });

  it('a provider with a connection but no webhook declaration answers the typed 501', async () => {
    const res = await postOrderTo('flipkart', flipkartId, orderBody(9_000_000_010_042, [{ sku: 'WH-A', quantity: 1 }])).expect(501);
    expect(res.body.code).toBe('channel-transport-unconfigured');
  });

  // ── phase D: the cancellation arms (RD-8) ─────────────────────────────────

  it('an unknown order ref answers 503 cancellation-unresolved (the channel retries)', async () => {
    const res = await postCancel(connId, cancelBody(9_000_000_020_001)).expect(503);
    expect(res.body.code).toBe('cancellation-unresolved');
    const rows = await meterRows(connId);
    expect(rows.at(-1)!.status).toBe('cancellation-unresolved');
  });

  it('a cancellation of an accepted order releases it; re-cancel answers ignored (200)', async () => {
    await postOrder(connId, orderBody(9_000_000_020_002, [{ sku: 'WH-B', quantity: 2 }])).expect(200);
    const orderId = (await outbound.findOrderByChannelRef(tenantId, connId, '9000000020002'))!.id;
    await postCancel(connId, cancelBody(9_000_000_020_002)).expect(200);
    const order = await outbound.orderForWriteback(tenantId, orderId);
    expect(order!.status).toBe('cancelled');
    const rows = await meterRows(connId);
    expect(rows.some((row) => row.status === 'released')).toBe(true);
    const again = await postCancel(connId, cancelBody(9_000_000_020_002)).expect(200);
    expect(again.body.outcome).toBe('ignored');
  });

  // ── phase E: the actor authority (RD-2) — re-read PER DELIVERY ────────────

  it('the connection actor is re-read PER DELIVERY — a lost orders.manage fails closed 403', async () => {
    // An accepted order under the OWNER actor first.
    const accepted = await postOrder(connId, orderBody(9_000_000_010_010, [{ sku: 'WH-A', quantity: 1 }])).expect(200);
    expect(accepted.body.outcome).toBe('accepted');
    // Demote: the connection's actor becomes the capability-less accountant.
    await mutateConnection({ connectedBy: accountantUserId });
    const res = await postOrder(connId, orderBody(9_000_000_010_011, [{ sku: 'WH-A', quantity: 1 }])).expect(403);
    expect(res.body.code).toBe('order-actor-unprivileged');
    expect(await outbound.findOrderByChannelRef(tenantId, connId, '9000000010011')).toBeNull();
    const rows = await meterRows(connId);
    expect(rows.at(-1)!.status).toBe('actor-unprivileged');
    const res2 = await postCancel(connId, cancelBody(9_000_000_010_010)).expect(403);
    expect(res2.body.code).toBe('order-actor-unprivileged');
    // Restore for the phases after.
    await mutateConnection({ connectedBy: ownerUserId });
  });

  // ── phase F: the config arms (RD-4) ───────────────────────────────────────

  it('an ingest with no warehouse set answers 422 ingest-warehouse-unset', async () => {
    await mutateConnection({ ingestWarehouseId: null });
    const res = await postOrder(connId, orderBody(9_000_000_010_004, [{ sku: 'WH-A', quantity: 1 }])).expect(422);
    expect(res.body.code).toBe('ingest-warehouse-unset');
    const rows = await meterRows(connId);
    expect(rows.at(-1)!.status).toBe('warehouse-unset');
    await mutateConnection({ ingestWarehouseId: warehouseId });
  });

  it('an ingest whose configured warehouse does not exist answers 422 ingest-config-invalid (never a 404)', async () => {
    await mutateConnection({ ingestWarehouseId: uuidv7() });
    const res = await postOrder(connId, orderBody(9_000_000_010_005, [{ sku: 'WH-A', quantity: 1 }])).expect(422);
    expect(res.body.code).toBe('ingest-config-invalid');
    const rows = await meterRows(connId);
    expect(rows.at(-1)!.status).toBe('config-invalid');
    await mutateConnection({ ingestWarehouseId: warehouseId });
  });

  // ── phase G: the backorder policy (RD-3) ──────────────────────────────────

  it('accept-policy shortfall accepts as backordered — zero-grant lines included', async () => {
    // Still 'accept' here — a zero-stock line backorders, the order stands.
    const res = await postOrder(connId, orderBody(9_000_000_010_006, [{ sku: 'WH-REJ', quantity: 2 }])).expect(200);
    expect(res.body.outcome).toBe('backordered');
  });

  it('accept-policy kit with a starved CHILD backorders (the parent line reads backordered)', async () => {
    const res = await postOrder(connId, orderBody(9_000_000_010_012, [{ sku: 'WH-KIT', quantity: 2 }])).expect(200);
    expect(res.body.outcome).toBe('backordered');
  });

  it('reject-policy with a fully-grantable kit ACCEPTS', async () => {
    await seedStock('WH-C2', 100);
    await mutateConnection({ backorderPolicy: 'reject' });
    const res = await postOrder(connId, orderBody(9_000_000_010_007, [{ sku: 'WH-KIT', quantity: 1 }])).expect(200);
    expect(res.body.outcome).toBe('accepted');
  });

  it('reject-policy with an ungrantable kit child refuses the WHOLE order 409 — nothing written', async () => {
    // 2 kits need 4×WH-C1 (fine) and 6×WH-C2 — the C2 stock is consumed by
    // the previous test's accept... re-seed the starvation. stock_on_hand
    // carries MILLI units (the milli scale is 1000) — subtract in milli.
    const sql = await sqlHandle();
    try {
      await sql`update stock_on_hand set quantity = quantity - 100000 where tenant_id = ${tenantId} and sku_id = ${skuIds.get('WH-C2')!} and warehouse_id = ${warehouseId}`;
    } finally {
      await sql.end();
    }
    const res = await postOrder(connId, orderBody(9_000_000_010_008, [{ sku: 'WH-KIT', quantity: 2 }])).expect(409);
    expect(res.body.code).toBe('order-backorder-rejected');
    expect(await outbound.findOrderByChannelRef(tenantId, connId, '9000000010008')).toBeNull();
    const rows = await meterRows(connId);
    expect(rows.at(-1)!.status).toBe('rejected');
  });

  it('reject-policy with a zero-grant plain line refuses the whole order 409', async () => {
    const res = await postOrder(connId, orderBody(9_000_000_010_009 + 100, [{ sku: 'WH-REJ', quantity: 2 }])).expect(409);
    expect(res.body.code).toBe('order-backorder-rejected');
    await mutateConnection({ backorderPolicy: 'accept' });
  });

  // ── phase H: rotate semantics + the mid-delivery rotate window ────────────

  it('a rotate POSTing every declared field keeps webhookSecret (wholesale-replace semantics)', async () => {
    await request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${connId}/credentials`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ credentials: { apiKey: 'canary-wh-key-rotated', webhookSecret: SECRET_ONE, locationId: '111111' } })
      .expect(200);
    const stored = await readStoredCredential(connId);
    expect(stored.webhookSecret).toBe(SECRET_ONE);
    expect(stored.apiKey).toBe('canary-wh-key-rotated');
    // The redelivery under the SAME (surviving) secret still verifies.
    const res = await postOrder(connId, orderBody(9_000_000_010_001, [{ sku: 'WH-A', quantity: 3 }])).expect(200);
    expect(res.body.outcome).toBe('replayed');
  });

  it('a mid-delivery rotate: a delivery signed with the STALE secret answers 401 (the blob is re-read)', async () => {
    // Rotate to a fresh secret; the previously-signed bytes now fail.
    await request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${connId}/credentials`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ credentials: { apiKey: 'canary-wh-key-rotated', webhookSecret: SECRET_TWO, locationId: '111111' } })
      .expect(200);
    await postOrder(connId, orderBody(9_000_000_010_001, [{ sku: 'WH-A', quantity: 3 }]), SECRET_ONE).expect(401);
    // And the current secret verifies again.
    await postOrder(connId, orderBody(9_000_000_010_001, [{ sku: 'WH-A', quantity: 3 }]), SECRET_TWO).expect(200);
  });

  // ── the mappings routes (row 4-5) ─────────────────────────────────────────

  it('mappings GET reads under channel.manage; the PUT fully replaces (shrink-set)', async () => {
    const list = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/channels/connections/${connId}/mappings`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect(list.body.items.length).toBe(6);
    // Shrink-set: PUT only WH-A.
    await request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${connId}/mappings`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ items: [{ externalRef: 'WH-A', skuId: skuIds.get('WH-A')! }] })
      .expect(200);
    const shrunk = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/channels/connections/${connId}/mappings`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect(shrunk.body.items).toEqual([{ externalRef: 'WH-A', skuId: skuIds.get('WH-A')! }]);
    // The empty PUT clears everything.
    await request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${connId}/mappings`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ items: [] })
      .expect(200);
    const cleared = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/channels/connections/${connId}/mappings`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect(cleared.body.items).toEqual([]);
    // Restore for the (already-run) suites' invariant — the file's later
    // tests replay the ORIGINAL set through the facade seed arm.
  });

  it('mappings PUT caps the set at the buffer cap — 400', async () => {
    const items = Array.from({ length: 201 }, (_, i) => ({
      externalRef: `ref-${i}`,
      skuId: skuIds.get('WH-A')!,
    }));
    const res = await request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${connId}/mappings`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ items })
      .expect(400);
    expect(res.body.code).toBe('validation-failed');
  });

  it('mappings routes refuse a capability-less role 403 (AD-4)', async () => {
    const accountantEmail = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/users`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body.items.find((u: { id: string }) => u.id === accountantUserId).email as string;
    const accountantToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: accountantEmail, password: 'bean-password-123' })
        .expect(200)
    ).body.accessToken as string;
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/channels/connections/${connId}/mappings`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${connId}/mappings`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .set(KEY_HEADER, ulid())
      .send({ items: [] })
      .expect(403);
  });

  it('bl-21 pinned: every channel.manage holder holds orders.manage, and no one else does', () => {
    for (const [role, caps] of Object.entries(ROLE_CAPABILITIES)) {
      expect(caps.has('channel.manage')).toBe(caps.has('orders.manage'));
      if (role === 'owner' || role === 'ops_manager') {
        expect(caps.has('channel.manage')).toBe(true);
      } else {
        expect(caps.has('channel.manage')).toBe(false);
      }
    }
  });
});