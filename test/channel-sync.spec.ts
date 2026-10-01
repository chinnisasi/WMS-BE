import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { fromMilli, toMilli } from '../src/shared/primitives/quantity';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ChannelsFacade } from '../src/modules/channels/channels.facade';
import type { ChannelVisibleSnapshot } from '../src/modules/inventory/reservation.service';
import { BREAKER_FAILURE_THRESHOLD } from '../src/modules/channels/channels.view';
import { registerChannelAdapter, channelAdapter } from '../src/modules/channels/channel-registry';
import { sealCredential } from '../src/modules/channels/channel-credentials';
import { testAvailabilityArm, unconfiguredRevokeArm } from '../src/modules/channels/channel-availability-port';
import { ChannelsSyncWorker, parseChannelsSyncPollMs, MAX_SYNC_CONNECTIONS_PER_TICK } from '../src/jobs/jobs.module';
import { CHANNEL_AVAILABILITY_PUBLISHED_EVENT } from '../src/modules/channels/channels.facade';
import { OUTBOX_RELAY } from '../src/shared/events/outbox.seam';
import type { OutboxRelay } from '../src/shared/events/outbox.seam';
import { testAddress } from './support/shipment-address';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres + Valkey and signs sessions; the
// vault needs a real master key (any ≥32-char string).
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.CHANNEL_ENCRYPTION_KEY ??= 'e2e-only-channel-encryption-key-0123456789abcdef';
// Background workers stay off in suites — this suite drives `drain()` and
// `publishConnectionSnapshot()` directly (the sibling convention).
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.CHANNELS_SYNC_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/**
 * The suite's own test channel: a REGISTERED adapter that actually delivers
 * (the `testAvailabilityArm` — its accepted-at echoes the publication's,
 * so a successful settle is provable in-process). The three frozen channels
 * keep their 501 unconfigured arms — the FAILURE paths ride a real shopify
 * connection. The test code registers per-suite (same process); its
 * connection rides a direct sealed-credential insert because the frozen
 * three-provider DTO vocabulary does not admit test codes.
 */
registerChannelAdapter({
  code: 'test-echo',
  displayName: 'Test Echo',
  credentialFields: [{ name: 'apiKey', label: 'API key', required: true, description: 'test key' }],
  availabilityArm: testAvailabilityArm(),
  revokeArm: unconfiguredRevokeArm('test-echo'),
});

const SHOPIFY_CREDENTIAL = {
  shopDomain: 'sync-suite-store.myshopify.com',
  accessToken: 'canary-sync-shopify-5c19d8',
};
const SKU_CODES = ['SYNC-A', 'SYNC-B'] as const;

describe('availability sync: publish, deliver, meter, break, retry (e2e, story 7-1)', () => {
  let app: INestApplication;
  let facade: InventoryFacade;
  let channels: ChannelsFacade;
  let relay: OutboxRelay;
  let suiteDb: SuiteDatabase;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerUserId: string;
  let opsToken: string;
  let warehouseId: string;
  let shopifyId: string;
  let flipkartId: string;
  let echoId: string;
  const skuIds = new Map<string, string>();

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('channel_sync');
    app = await createApp(false);
    await app.init();
    facade = app.get(InventoryFacade);
    channels = app.get(ChannelsFacade);
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
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

  /**
   * Widens the integrations provider CHECK on THIS suite's throwaway DB
   * clone so the registered test-echo adapter can hold an integrations row.
   * The prod schema keeps the frozen three-provider enum and the DTO keeps
   * its frozen 400 vocabulary — this is a runtime-only swap inside a DB
   * that `drop()`s after the suite.
   */
  async function admitTestProviderInDb(): Promise<void> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`alter table integrations drop constraint if exists integrations_provider_check`;
      await sql`alter table integrations add constraint integrations_provider_check check (provider in ('shopify', 'amazon-in', 'flipkart', 'test-echo'))`;
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
      .send({ name: `Sync Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
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
      .send({ origin: testAddress(), code: `SYN-${ulid().slice(10, 16).toUpperCase()}`, name: `Sync WH ${ulid()}` })
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

    // The test-echo connection rides a DIRECT (sealed) insert — the DTO's
    // frozen provider vocabulary does not admit test codes, and the sync
    // machinery is credential-shape-agnostic (the delivery opens it in
    // process under the same CHANNEL_ENCRYPTION_KEY the suite set).
    const echoSql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const sealed = sealCredential({ apiKey: 'canary-echo-key-95af31' });
      const inserted = (await echoSql`
        insert into integrations
          (id, tenant_id, provider, status, credential_sealed, credential_version,
           backorder_policy, connected_by, created_at, updated_at)
        values (${uuidv7()}, ${tenantId}, 'test-echo', 'connected', ${sealed}, 1,
                'accept', ${ownerUserId}, now(), now())
        returning id
      `) as unknown as { id: string }[];
      echoId = inserted[0]!.id;
    } finally {
      await echoSql.end();
    }

    await facade.rebuildReservationCounters(tenantId, warehouseId);
  }

  /** Seeds committed on-hand via the stock adjustment command (HTTP). */
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
        .send({ warehouseId, skuId, binId: bins[0]!.id, quantityDelta: quantity, reasonCode: 'stock-count', note: 'sync-suite seed' })
        .expect((res) => {
          if (res.status !== 201) {
            throw new Error(`seed stock failed (${res.status}): ${JSON.stringify(res.body)}`);
          }
        })
        .expect(201);
    } finally {
      await sql.end();
    }
  }

  async function sqlHandle(): Promise<postgres.Sql<Record<string, unknown>>> {
    return postgres(process.env.DATABASE_URL!, { max: 1 });
  }

  /**
   * Removes THIS tenant's outbox rows — each delivery-driving test starts
   * from an empty queue, so a single-row `drain(1)` is deterministic (the
   * earlier tests' appended rows would otherwise be delivered first and
   * pollute the attempt counts).
   */
  async function clearOutbox(): Promise<void> {
    const sql = await sqlHandle();
    try {
      await sql`delete from outbox_messages where tenant_id = ${tenantId}`;
    } finally {
      await sql.end();
    }
  }

  /** Forces the relay to see pending rows as due (no sleeping out backoff). */
  async function forceDue(): Promise<void> {
    const sql = await sqlHandle();
    try {
      await sql`update outbox_messages set next_attempt_at = now() where tenant_id = ${tenantId}`;
    } finally {
      await sql.end();
    }
  }

  async function availabilityRows(): Promise<
    { kind: string; status: string; integrationId: string; error: string | null }[]
  > {
    const sql = await sqlHandle();
    try {
      return (await sql`
        select kind, status, integration_id as "integrationId", error from integration_calls
        where tenant_id = ${tenantId} order by at asc
      `) as unknown as { kind: string; status: string; integrationId: string; error: string | null }[];
    } finally {
      await sql.end();
    }
  }

  async function integrationRow(id: string): Promise<Record<string, unknown>> {
    const sql = await sqlHandle();
    try {
      const rows = (await sql`
        select status, breaker_state as "breakerState", consecutive_failures as "consecutiveFailures",
               last_synced_at as "lastSyncedAt", last_attempt_at as "lastAttemptAt", last_error as "lastError"
        from integrations where tenant_id = ${tenantId} and id = ${id}
      `) as unknown as Record<string, unknown>[];
      return rows[0]!;
    } finally {
      await sql.end();
    }
  }

  async function outboxRows(connectionId: string): Promise<{ status: string; attempts: number }[]> {
    const sql = await sqlHandle();
    try {
      return (await sql`
        select status, attempts from outbox_messages
        where tenant_id = ${tenantId} and type = ${CHANNEL_AVAILABILITY_PUBLISHED_EVENT}
          and payload->>'connectionId' = ${connectionId}
      `) as unknown as { status: string; attempts: number }[];
    } finally {
      await sql.end();
    }
  }

  /** Maps both skus onto the echo connection (the seed arm; no route). */
  async function mapEchoSkus(): Promise<void> {
    await channels.setChannelMappings(
      tenantId,
      echoId,
      [...skuIds.entries()].map(([code, skuId]) => ({ externalRef: `echo-${code}`, skuId })),
    );
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

  // ── the publish cycle (RN-6) ──────────────────────────────────────────────

  it('publish: nothing without scopes; with them, one outbox row per connection whose scopes carry V(c) = atp − buffer', async () => {
    // No mappings anywhere yet: the publish refuses BOTH connections and
    // an absent id.
    expect(await channels.publishConnectionSnapshot(tenantId, shopifyId)).toBe(false);
    expect(await channels.publishConnectionSnapshot(tenantId, echoId)).toBe(false);
    expect(await channels.publishConnectionSnapshot(tenantId, uuidv7())).toBe('absent');
    await clearOutbox();

    // Mappings in; the echo snapshot publishes (2 skus × 1 warehouse, no
    // stock — zeros, but REAL committed reads, never invented).
    await mapEchoSkus();
    expect(await channels.publishConnectionSnapshot(tenantId, echoId)).toBe(true);
    let rows = await outboxRows(echoId);
    expect(rows).toHaveLength(1);
    const sql = await sqlHandle();
    try {
      const outbox = (await sql`
        select payload from outbox_messages
        where tenant_id = ${tenantId} and type = ${CHANNEL_AVAILABILITY_PUBLISHED_EVENT}
          and payload->>'connectionId' = ${echoId}
      `) as unknown as { payload: { connectionId: string; provider: string; publishedAt: string; scopes: { warehouseId: string; skuId: string; visibleMilli: number }[] } }[];
      const payload = outbox[0]!.payload;
      expect(payload.connectionId).toBe(echoId);
      expect(payload.provider).toBe('test-echo');
      expect(typeof payload.publishedAt).toBe('string');
      expect(payload.scopes).toHaveLength(2); // 2 mapped skus × 1 tenant warehouse
      for (const scope of payload.scopes) {
        expect(scope.warehouseId).toBe(warehouseId);
        expect(scope.visibleMilli).toBe(0);
      }
    } finally {
      await sql.end();
    }

    // RN-6 through the very read the sync rides: 10 on-hand, buffer 4 →
    // pool atp 6 → V(c) = 6 − 4 = 2 (the buffer subtracted AGAIN from the
    // channel's own listing — the staleness margin).
    const shopifySkuId = skuIds.get('SYNC-A')!;
    await seedStock(shopifySkuId, 10);
    await channels.setChannelMappings(tenantId, shopifyId, [{ externalRef: 'ext-1', skuId: shopifySkuId }]);
    const placed = await channels.setConnectionBuffers(
      {
        tenantId,
        actorUserId: ownerUserId,
        connectionId: shopifyId,
        items: [{ warehouseId, skuId: shopifySkuId, bufferMilli: toMilli(4) }],
      },
      ulid(),
    );
    expect(placed.verdicts).toHaveLength(1);
    expect(placed.verdicts[0]).toMatchObject({ status: 'applied', bufferMilli: toMilli(4) });
    expect(await channels.publishConnectionSnapshot(tenantId, shopifyId)).toBe(true);
    rows = await outboxRows(shopifyId);
    expect(rows).toHaveLength(1);
    const sql2 = await sqlHandle();
    try {
      const outbox = (await sql2`
        select payload from outbox_messages
        where tenant_id = ${tenantId} and type = ${CHANNEL_AVAILABILITY_PUBLISHED_EVENT}
          and payload->>'connectionId' = ${shopifyId}
      `) as unknown as { payload: { scopes: { skuId: string; visibleMilli: number }[] } }[];
      const scope = outbox[0]!.payload.scopes[0]!;
      expect(scope.skuId).toBe(shopifySkuId);
      expect(scope.visibleMilli).toBe(toMilli(2));
    } finally {
      await sql2.end();
    }
    // The RN-6 read through the inventory facade: pool, buffer and
    // visibility all agree with the published scope.
    const snapshot = (await facade.channelVisibleQuantity(
      tenantId,
      warehouseId,
      shopifySkuId,
      shopifyId,
    )) as ChannelVisibleSnapshot;
    expect({
      onHand: fromMilli(snapshot.onHand),
      poolAtp: fromMilli(snapshot.poolAtp),
      buffer: fromMilli(snapshot.buffer),
    }).toEqual({ onHand: 10, poolAtp: 6, buffer: 4 });
    expect(snapshot.visibleMilli).toBe(toMilli(2));
  });

  it('an OPEN breaker blocks the publish (RN-5); the manual retry half-opens it and re-appends', async () => {
    await clearOutbox();
    await channels.setChannelMappings(tenantId, flipkartId, [{ externalRef: 'fk-1', skuId: skuIds.get('SYNC-A')! }]);
    expect(await channels.publishConnectionSnapshot(tenantId, flipkartId)).toBe(true);
    const sql = await sqlHandle();
    try {
      await sql`update integrations set breaker_state = 'open' where tenant_id = ${tenantId} and id = ${flipkartId}`;
      expect(await channels.publishConnectionSnapshot(tenantId, flipkartId)).toBe(false); // blocked-open
    } finally {
      await sql.end();
    }
    // The retry is the unstick path: half-open + a fresh publication.
    const retried = await channels.retryConnection(
      { tenantId, actorUserId: ownerUserId, connectionId: flipkartId },
      ulid(),
    );
    expect(retried.breakerState).toBe('half-open');
    const rows = await outboxRows(flipkartId);
    expect(rows).toHaveLength(2); // the original + the retry's
  });

  it('delivery, failing: each drain attempt meters a failed call and strokes the breaker; the row quarantines at 5; the breaker opens', async () => {
    await clearOutbox();
    const beforeCount = (await availabilityRows()).filter((r) => r.integrationId === shopifyId).length;

    expect(await channels.publishConnectionSnapshot(tenantId, shopifyId)).toBe(true);

    // Attempt 1: the shopify arm is the unconfigured 501 — a retriable
    // delivery failure; the settle still commits (meter row + stamp).
    await forceDue();
    await relay.drain(1);
    const afterOne = (await availabilityRows()).filter((r) => r.integrationId === shopifyId);
    expect(afterOne).toHaveLength(beforeCount + 1);
    const metered = afterOne[afterOne.length - 1]!;
    expect(metered).toMatchObject({ kind: 'availability-sync', status: 'failed' });
    expect(metered.error).not.toBeNull();
    expect(await integrationRow(shopifyId)).toMatchObject({ breakerState: 'closed', consecutiveFailures: 1 });

    // Attempts 2..5 — the due instant is forced between cycles (no sleeping
    // through the 5s → 10s → … backoff ladder); the breaker opens on the
    // FIFTH consecutive failure and the row dead-letters.
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await forceDue();
      await relay.drain(1);
      const after = (await availabilityRows()).filter((r) => r.integrationId === shopifyId);
      expect(after).toHaveLength(beforeCount + attempt);
    }
    expect(await integrationRow(shopifyId)).toMatchObject({
      breakerState: 'open',
      consecutiveFailures: BREAKER_FAILURE_THRESHOLD,
    });
    const quarantined = await outboxRows(shopifyId);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({ status: 'quarantined', attempts: 5 });

    // Health derives ERROR on the arm-4 list (the breaker's state).
    const list = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/channels/connections`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    const entry = (list.body.items as Record<string, unknown>[]).find((e) => e.id === shopifyId)!;
    expect(entry).toMatchObject({ health: 'error', breakerState: 'open' });
    expect(entry.lastError).not.toBeNull();
  });

  it('retry over an OPEN breaker: half-open, re-append, one failed delivery re-opens immediately (RN-5)', async () => {
    await clearOutbox();
    const beforeCount = (await availabilityRows()).filter((r) => r.integrationId === shopifyId).length;
    expect((await integrationRow(shopifyId)).breakerState).toBe('open');

    const retried = await channels.retryConnection(
      { tenantId, actorUserId: ownerUserId, connectionId: shopifyId },
      ulid(),
    );
    expect(retried.breakerState).toBe('half-open');
    // The retry's fresh publication rides its own outbox row — the ONLY one
    // here (clearOutbox removed the previous test's DLQ row).
    const retriedRows = await outboxRows(shopifyId);
    expect(retriedRows).toHaveLength(1);
    expect(retriedRows[0]).toMatchObject({ status: 'pending', attempts: 0 });

    await forceDue();
    await relay.drain(1);
    expect((await availabilityRows()).filter((r) => r.integrationId === shopifyId))
      .toHaveLength(beforeCount + 1);
    // One strike out of half-open RE-OPENS the breaker.
    expect(await integrationRow(shopifyId)).toMatchObject({ breakerState: 'open' });
  });

  it('delivery, succeeding: the echo arm settles ok — the row acks, last_synced_at stamps, the streak resets', async () => {
    await clearOutbox();
    const beforeCount = (await availabilityRows()).filter((r) => r.integrationId === echoId).length;
    expect(await channels.publishConnectionSnapshot(tenantId, echoId)).toBe(true);

    await forceDue();
    await relay.drain(1);
    const after = (await availabilityRows()).filter((r) => r.integrationId === echoId);
    expect(after).toHaveLength(beforeCount + 1);
    expect(after[after.length - 1]).toMatchObject({ kind: 'availability-sync', status: 'ok' });
    const row = await integrationRow(echoId);
    expect(row).toMatchObject({ breakerState: 'closed', consecutiveFailures: 0, lastError: null });
    expect(row.lastSyncedAt).not.toBeNull();

    // The ack deleted the outbox row (the relay's success contract).
    expect(await outboxRows(echoId)).toEqual([]);
  });

  it('recordSyncStall: stamps lastError/lastAttemptAt (health degrades), strokes NO breaker, writes NO meter row', async () => {
    const beforeCount = (await availabilityRows()).length;
    await channels.recordSyncStall(tenantId, echoId, 'reservation store unavailable (suite)');
    const row = await integrationRow(echoId);
    expect(row.lastError).toBe('reservation store unavailable (suite)');
    expect(row.lastAttemptAt).not.toBeNull();
    expect(row.breakerState).toBe('closed');
    expect(row.consecutiveFailures).toBe(0);
    expect((await availabilityRows()).length).toBe(beforeCount); // not a metered call

    // Health derives DEGRADED (lastError set, breaker closed) on the arm-4 list.
    const list = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/channels/connections`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    const entry = (list.body.items as Record<string, unknown>[]).find((e) => e.id === echoId)!;
    expect(entry).toMatchObject({ health: 'degraded', breakerState: 'closed' });
    expect(entry.lastError).toBe('reservation store unavailable (suite)');
  });

  it('the worker plumbing: parseChannelsSyncPollMs, the env gate, and a tick that drives the enumerated connections through the facade', async () => {
    // The parse helper (the outbox-worker suite's shape).
    expect(parseChannelsSyncPollMs(undefined)).toBe(0);
    expect(parseChannelsSyncPollMs('')).toBe(0);
    expect(parseChannelsSyncPollMs('0')).toBe(0);
    expect(parseChannelsSyncPollMs('60000')).toBe(60000);
    for (const bad of ['soon', '1.5', '-5']) {
      expect(() => parseChannelsSyncPollMs(bad)).toThrow(/CHANNELS_SYNC_POLL_MS/);
    }
    expect(MAX_SYNC_CONNECTIONS_PER_TICK).toBe(200);

    // The worker driven manually with stubs (no bootstrap timers): the
    // enumerate (BYPASSRLS rows) drives one facade publish per row through
    // the facade (the module's one exported seam).
    const enumeration = [
      { tenantId: 't1', connectionId: 'c1' },
      { tenantId: 't2', connectionId: 'c2' },
    ];
    const calls: { tenantId: string; connectionId: string }[] = [];
    const stubFacade = {
      publishConnectionSnapshot: (tenant: string, connection: string) => {
        calls.push({ tenantId: tenant, connectionId: connection });
        return Promise.resolve(true);
      },
    } as unknown as ChannelsFacade;
    const worker = new ChannelsSyncWorker(
      { execute: (): Promise<unknown> => Promise.resolve(enumeration) } as never,
      stubFacade,
    );
    await worker.tick();
    expect(calls).toEqual(enumeration);

    // The env gate: an unset poll schedules nothing (the bootstrap returns).
    const gatedWorker = new ChannelsSyncWorker(
      { execute: (): Promise<never> => Promise.reject(new Error('must not run')) } as never,
      stubFacade,
    );
    gatedWorker.onApplicationBootstrap();
    gatedWorker.onApplicationShutdown();

    // The registry: all three frozen channels carry both arms (the ports
    // this suite's failure paths ride).
    expect(channelAdapter('shopify')).toBeDefined();
    expect(channelAdapter('amazon-in')).toBeDefined();
    expect(channelAdapter('flipkart')).toBeDefined();
  });
});