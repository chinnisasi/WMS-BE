import type { INestApplication } from '@nestjs/common';
import { and, desc, eq, sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { orders } from '../src/shared/db/schema';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { CLIENT_ORDER_REF_RE, MAX_CLIENT_ORDER_REF_LENGTH, normalizeClientOrderRef } from '../src/modules/outbound/order.command';
import { orderReferenceMatch } from '../src/modules/outbound/order-reference';
import { OutboundFacade } from '../src/modules/outbound/outbound.facade';
import { clientWindDownBlockersInTx } from '../src/modules/outbound/client-wind-down';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { dispatchedOrderFixtures, type Picklist } from './support/dispatched-order';
import { mintSignIn } from './support/sign-in';

// Story 4-1b — the client order number: a nullable `orders.client_order_ref`,
// unique per client among LIVE orders (0088), set at the staff create and the
// portal create, returned raw on every order read, and searchable by an exact
// `reference` on the staff and portal order lists. Every row of the spec's
// I/O matrix is driven here over real HTTP; the CHECK and the indexes are
// probed against their TS mirror, and the search's two index arms are proved
// by an EXPLAIN of the real predicate.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.LICENCE_EXPIRY_POLL_MS;

jest.setTimeout(180_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const STAFF_DUPLICATE = (ref: string, warehouseCode: string) =>
  `${ref} is already used by another live order of this client (in warehouse ${warehouseCode}) — find it with the search, or use a different number (a cancelled order frees its number).`;
const PORTAL_DUPLICATE = (ref: string) =>
  `Order number ${ref} is already used by another of your orders (a cancelled order frees its number) — use a different number.`;

interface OrderBody {
  id: string;
  clientId: string;
  clientOrderRef?: string | null;
  externalEventId: string | null;
  status: string;
}

describe('client order number (e2e, story 4-1b)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let valkey: Redis;
  let db: Database;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string;
  let warehouseId: string;
  let otherWarehouseId: string;
  let warehouseCode: string;
  let binId: string;
  let acme: string;
  let beta: string;
  let gamma: string;
  const sku = new Map<string, string>();
  let portalA: string;
  let portalB: string;

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('orderclientref');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 3, onnotice: () => undefined });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });
    db = app.get<Database>(DATABASE);

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Client Ref 3PL ${ulid()}`, ownerEmail, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = await signIn(ownerEmail);
    opsToken = (await createMember('ops_manager')).token;
    const floor = await createMember('operator');

    warehouseId = await createWarehouse('CR-W1', 'Main');
    otherWarehouseId = await createWarehouse('CR-W2', 'Annex');
    warehouseCode = (await sql`select code from warehouses where id = ${warehouseId}`)[0]!.code as string;
    const zone = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' })
        .expect(201)
    ).body.id as string;
    binId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 1000000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;

    acme = await createClient('ACME', 'Acme Apparel');
    beta = await createClient('BETA', 'Beta Beauty');
    gamma = await createClient('GAMMA', 'Gamma Goods');
    await importCsv(['A-1,Acme tee,pcs,1800,,,'], acme);
    await importCsv(['B-1,Beta serum,pcs,1800,,,'], beta);
    await importCsv(['G-1,Gamma mug,pcs,1800,,,'], gamma);
    const listed = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of listed.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    for (const code of ['A-1', 'B-1', 'G-1']) await adjust(sku.get(code)!, 1000);
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

    // The badge-in device session that draws the picks.
    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Client ref scanner', pin: '2468' })
      .expect(201);
    operatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: floor.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    portalA = await portalUser(acme);
    portalB = await portalUser(beta);
  });

  afterAll(async () => {
    const keys = await valkey.keys(`wms:{${tenantId}}:*`).catch(() => [] as string[]);
    if (keys.length > 0) await valkey.del(...keys);
    await valkey.quit().catch(() => valkey.disconnect());
    await sql?.end();
    const main = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await main.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function signIn(email: string): Promise<string> {
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
  }

  async function createMember(role: string): Promise<{ token: string; email: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { token: await signIn(email), email };
  }

  async function portalUser(clientId: string): Promise<string> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role: 'client', clientId })
      .expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return signIn(email);
  }

  async function createWarehouse(code: string, name: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${code}-${ulid().slice(20)}`, name })
        .expect(201)
    ).body.id as string;
  }

  async function createClient(code: string, name: string): Promise<string> {
    return (
      await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name }).expect(201)
    ).body.client.id as string;
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,product,variant_values,kit_components', ...rows].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  async function adjust(skuId: string, quantityDelta: number): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta, reasonCode: 'stock-count', note: 'client-ref seed' })
      .expect(201);
  }

  function orderBody(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { warehouseId, lines: [{ skuId: sku.get(code)!, quantity: 1 }], destination: testAddress(), ...extra };
  }

  function staffCreate(payload: Record<string, unknown>, key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/orders`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send(payload);
  }

  function place(payload: Record<string, unknown>, token = portalA, key = ulid()) {
    return http().post(`${API}/${tenantId}/portal/orders`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(payload);
  }

  async function staffSearch(query: string, wh = warehouseId): Promise<OrderBody[]> {
    const res = await http().get(`${API}/${tenantId}/warehouses/${wh}/outbound/orders?limit=200&${query}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    return res.body.items as OrderBody[];
  }

  async function portalSearch(query: string, token = portalA): Promise<{ id: string; clientOrderRef: string | null; externalRef: string | null }[]> {
    const res = await http().get(`${API}/${tenantId}/portal/orders?limit=100&${query}`).set('Authorization', `Bearer ${token}`).expect(200);
    return res.body.items as { id: string; clientOrderRef: string | null; externalRef: string | null }[];
  }

  async function ordersWithRef(clientId: string, ref: string): Promise<number> {
    return (await sql`select count(*)::int as n from orders where tenant_id = ${tenantId} and client_id = ${clientId} and client_order_ref = ${ref}`)[0]!.n as number;
  }

  async function liveHolds(skuId: string): Promise<number> {
    return (await sql`select count(*)::int as n from reservations where tenant_id = ${tenantId} and sku_id = ${skuId} and state in ('held', 'committed')`)[0]!.n as number;
  }

  function scannedOf(picklist: Picklist): { skuId: string; qty: number }[] {
    const bySku = new Map<string, number>();
    for (const line of picklist.lines) bySku.set(line.skuId, (bySku.get(line.skuId) ?? 0) + line.qty);
    return [...bySku].map(([skuId, qty]) => ({ skuId, qty }));
  }

  // ── the CHECK, its mirror and the indexes ─────────────────────────────────

  describe('migration 0088', () => {
    it('the shape CHECK and CLIENT_ORDER_REF_RE agree on every probe — 64 accepted, 65 / a control character / a leading or trailing space / non-ASCII / empty refused', async () => {
      const probes = [
        'A',
        'SO-1042',
        'so-1042',
        'SO 1042/B#7',
        '~!@#$%^&*()_+{}|:"<>?`-=[]\\;\',./',
        `S${'x'.repeat(62)}Z`,
        `S${'x'.repeat(63)}Z`,
        '',
        ' SO-1',
        'SO-1 ',
        'SO\t1',
        'SO\n1',
        'SO-é',
        'SO-１',
        '\u007f',
      ];
      expect(`S${'x'.repeat(62)}Z`).toHaveLength(MAX_CLIENT_ORDER_REF_LENGTH);
      for (const probe of probes) {
        const accepted = await sql
          .begin(async (tx) => {
            await tx`insert into orders (id, tenant_id, client_id, warehouse_id, client_order_ref) values (${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${probe})`;
            throw new Error('rollback');
          })
          .catch((err: Error & { constraint_name?: string }) => {
            if (err.message === 'rollback') return true;
            expect(err.constraint_name).toBe('orders_client_order_ref_shape_check');
            return false;
          });
        expect({ probe, db: accepted }).toEqual({ probe, db: CLIENT_ORDER_REF_RE.test(probe) });
      }
      // The two ends of the length rule, by name.
      expect(CLIENT_ORDER_REF_RE.test(`S${'x'.repeat(62)}Z`)).toBe(true);
      expect(CLIENT_ORDER_REF_RE.test(`S${'x'.repeat(63)}Z`)).toBe(false);
    });

    it('the three partial indexes exist with their predicates (the live unique index excludes cancelled orders; the search index does not)', async () => {
      const rows = await sql`select indexname, indexdef from pg_indexes where tablename = 'orders' and indexname in ('orders_client_order_ref_live_unique', 'orders_client_order_ref_idx', 'orders_external_event_client_idx') order by indexname`;
      expect(rows.map((row) => row.indexname)).toEqual(['orders_client_order_ref_idx', 'orders_client_order_ref_live_unique', 'orders_external_event_client_idx']);
      expect(rows[0]!.indexdef).toMatch(/CREATE INDEX .* \(tenant_id, client_order_ref, client_id\) WHERE \(client_order_ref IS NOT NULL\)$/);
      expect(rows[1]!.indexdef).toMatch(/CREATE UNIQUE INDEX .* \(tenant_id, client_order_ref, client_id\) WHERE \(\(client_order_ref IS NOT NULL\) AND \(status <> 'cancelled'::text\)\)/);
      expect(rows[2]!.indexdef).toMatch(/CREATE INDEX .* \(tenant_id, external_event_id, client_id\) WHERE \(external_event_id IS NOT NULL\)/);
    });

    it('normalizeClientOrderRef: trims; blank and spaces-only read as absent', () => {
      expect([undefined, null, '', '   ', ' SO-7 ', 'SO-7'].map(normalizeClientOrderRef)).toEqual([null, null, null, null, 'SO-7', 'SO-7']);
    });
  });

  // ── the I/O matrix ────────────────────────────────────────────────────────

  describe('staff create and the order reads', () => {
    let orderId: string;

    it('staff create with a ref: stored; the create response, the detail and the list entry carry it raw', async () => {
      const res = await staffCreate(orderBody('A-1', { clientOrderRef: 'SO-1042' })).expect(201);
      orderId = res.body.order.id as string;
      expect(res.body.order).toMatchObject({ clientId: acme, clientOrderRef: 'SO-1042', externalEventId: null });
      const detail = await http().get(`${API}/${tenantId}/outbound/orders/${orderId}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect(detail.body.order.clientOrderRef).toBe('SO-1042');
      const entry = (await staffSearch('')).find((o) => o.id === orderId);
      expect(entry?.clientOrderRef).toBe('SO-1042');
      const stored = await sql`select client_order_ref from orders where id = ${orderId}`;
      expect(stored[0]!.client_order_ref).toBe('SO-1042');
    });

    it('no ref, or spaces only: the column and every read are null', async () => {
      for (const extra of [{}, { clientOrderRef: '' }, { clientOrderRef: '    ' }]) {
        const res = await staffCreate(orderBody('A-1', extra)).expect(201);
        expect(res.body.order.clientOrderRef).toBeNull();
        expect((await sql`select client_order_ref from orders where id = ${res.body.order.id as string}`)[0]!.client_order_ref).toBeNull();
      }
    });

    it('a duplicate among ACME’s live orders is 409 duplicate-client-order-ref — nothing written, nothing reserved', async () => {
      const before = { rows: await ordersWithRef(acme, 'SO-1042'), holds: await liveHolds(sku.get('A-1')!) };
      const res = await staffCreate(orderBody('A-1', { clientOrderRef: '  SO-1042 ' })).expect(409);
      expect({ code: res.body.code, detail: res.body.detail }).toEqual({ code: 'duplicate-client-order-ref', detail: STAFF_DUPLICATE('SO-1042', warehouseCode) });
      // The clashing order rides the extensions (staff only).
      const holder = await sql`select id from orders where tenant_id = ${tenantId} and client_id = ${acme} and client_order_ref = 'SO-1042'`;
      expect({ orderId: res.body.orderId, warehouseId: res.body.warehouseId }).toEqual({ orderId: holder[0]!.id, warehouseId });
      expect(await ordersWithRef(acme, 'SO-1042')).toBe(before.rows);
      expect(await liveHolds(sku.get('A-1')!)).toBe(before.holds);
      // The portal surface refuses the same, in its own words.
      const portal = await place(orderBody('A-1', { clientOrderRef: 'SO-1042' })).expect(409);
      expect({ code: portal.body.code, detail: portal.body.detail }).toEqual({ code: 'duplicate-client-order-ref', detail: PORTAL_DUPLICATE('SO-1042') });
      expect(portal.body.orderId).toBeUndefined();
      // Case-sensitive (decision 2): a lower-case twin is another number.
      expect((await staffCreate(orderBody('A-1', { clientOrderRef: 'so-1042' })).expect(201)).body.order.clientOrderRef).toBe('so-1042');
    });

    it('the same ref for another client (BETA) is accepted', async () => {
      const res = await staffCreate(orderBody('B-1', { clientOrderRef: 'SO-1042' })).expect(201);
      expect(res.body.order).toMatchObject({ clientId: beta, clientOrderRef: 'SO-1042' });
    });

    it('a cancelled order frees its number: cancel, then the new order takes it', async () => {
      const first = await staffCreate(orderBody('A-1', { clientOrderRef: 'SO-CXL' })).expect(201);
      expect((await staffCreate(orderBody('A-1', { clientOrderRef: 'SO-CXL' })).expect(409)).body.code).toBe('duplicate-client-order-ref');
      await http()
        .post(`${API}/${tenantId}/outbound/orders/${first.body.order.id as string}/cancel`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(200);
      const second = await staffCreate(orderBody('A-1', { clientOrderRef: 'SO-CXL' })).expect(201);
      expect(second.body.order.clientOrderRef).toBe('SO-CXL');
      // The search finds both — the cancelled order by its number too (code
      // review BH5), newest first.
      expect((await staffSearch('reference=SO-CXL')).map((o) => [o.id, o.status])).toEqual([
        [second.body.order.id, 'accepted'],
        [first.body.order.id, 'cancelled'],
      ]);
    });

    it('bad shapes are 400 validation-failed (65 characters, a control character, non-ASCII); an ingested order with a ref is 400, with a blank one is not', async () => {
      for (const ref of [`S${'x'.repeat(63)}Z`, 'SO\t1042', 'SO-10\n42', 'SO-é']) {
        const res = await staffCreate(orderBody('A-1', { clientOrderRef: ref })).expect(400);
        expect(res.body.code).toBe('validation-failed');
        expect((await place(orderBody('A-1', { clientOrderRef: ref })).expect(400)).body.code).toBe('validation-failed');
      }
      const ingested = await staffCreate(orderBody('A-1', { source: 'ingested', integrationId: uuidv7(), externalEventId: `evt-${ulid()}`, clientOrderRef: 'SO-CH' })).expect(400);
      expect({ code: ingested.body.code, detail: ingested.body.detail }).toEqual({
        code: 'validation-failed',
        detail: "clientOrderRef is a manual order's field — a channel order is named by its externalEventId.",
      });
      expect(await ordersWithRef(acme, 'SO-CH')).toBe(0);
      // Blank on an ingested order is ABSENT, not a refusal.
      const blank = await staffCreate(orderBody('A-1', { source: 'ingested', integrationId: uuidv7(), externalEventId: `evt-${ulid()}`, clientOrderRef: '   ' })).expect(201);
      expect(blank.body.order.clientOrderRef).toBeNull();
      // The character rule is reported before the length: a long non-ASCII value names the characters.
      const longBad = await staffCreate(orderBody('A-1', { clientOrderRef: `é${'x'.repeat(70)}` })).expect(400);
      expect(longBad.body.detail).toMatch(/^clientOrderRef must be plain ASCII/);
      const longOk = await staffCreate(orderBody('A-1', { clientOrderRef: 'x'.repeat(65) })).expect(400);
      expect(longOk.body.detail).toBe('clientOrderRef is at most 64 characters (got 65).');
    });

    it('a replay of a create stored before 4-1b (no clientOrderRef key) is served unchanged', async () => {
      const key = ulid();
      const created = await staffCreate(orderBody('A-1'), key).expect(201);
      // Rewrite the stored snapshot to the pre-4-1b shape: no clientOrderRef key at all.
      await sql`update idempotency_keys set response_snapshot = response_snapshot #- '{order,clientOrderRef}' where tenant_id = ${tenantId} and key = ${key}`;
      const stored = (await sql`select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.response_snapshot as { order: Record<string, unknown> };
      expect('clientOrderRef' in stored.order).toBe(false);
      const replayed = await staffCreate(orderBody('A-1'), key).expect(201);
      expect(replayed.body.order.id).toBe(created.body.order.id);
      expect('clientOrderRef' in replayed.body.order).toBe(false);
      expect(replayed.body).toEqual(JSON.parse(JSON.stringify({ order: { ...stored.order } })));
    });

    it('replay: the same key and body re-serve the cached order; the same key with a different ref is 422', async () => {
      const key = ulid();
      const first = await staffCreate(orderBody('A-1', { clientOrderRef: 'SO-RPL' }), key).expect(201);
      const again = await staffCreate(orderBody('A-1', { clientOrderRef: ' SO-RPL ' }), key).expect(201);
      expect(again.body.order.id).toBe(first.body.order.id);
      expect((await staffCreate(orderBody('A-1', { clientOrderRef: 'SO-RPL-2' }), key).expect(422)).body.code).toBe('idempotency-key-reuse');
      expect((await staffCreate(orderBody('A-1'), key).expect(422)).body.code).toBe('idempotency-key-reuse');
      const pkey = ulid();
      const placed = await place(orderBody('A-1', { clientOrderRef: 'SO-PRPL' }), portalA, pkey).expect(201);
      expect((await place(orderBody('A-1', { clientOrderRef: 'SO-PRPL' }), portalA, pkey).expect(201)).body).toEqual(placed.body);
      expect((await place(orderBody('A-1', { clientOrderRef: 'SO-PRPL-2' }), portalA, pkey).expect(422)).body.code).toBe('idempotency-key-reuse');
    });

    it('a concurrent duplicate: two keys racing on one ref — exactly one order row, one 409, the loser’s grant released', async () => {
      const inventory = app.get(InventoryFacade);
      const original = inventory.grantReservation.bind(inventory);
      let arrived = 0;
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const holdsBefore = await liveHolds(sku.get('A-1')!);
      // A barrier at the grant: both requests have passed phase 1's duplicate
      // check when they arrive, so only the partial unique index can refuse one.
      const spy = jest.spyOn(inventory, 'grantReservation').mockImplementation(async (args) => {
        arrived += 1;
        if (arrived === 2) openGate();
        await gate;
        return original(args);
      });
      let results: request.Response[];
      try {
        results = await Promise.all([staffCreate(orderBody('A-1', { clientOrderRef: 'SO-RACE' })), staffCreate(orderBody('A-1', { clientOrderRef: 'SO-RACE' }))]);
      } finally {
        spy.mockRestore();
      }
      expect(arrived).toBe(2);
      expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
      const loser = results.find((res) => res.status === 409)!;
      expect({ code: loser.body.code, detail: loser.body.detail }).toEqual({ code: 'duplicate-client-order-ref', detail: STAFF_DUPLICATE('SO-RACE', warehouseCode) });
      const winner = results.find((res) => res.status === 201)!;
      expect(loser.body.orderId).toBe(winner.body.order.id);
      expect(await ordersWithRef(acme, 'SO-RACE')).toBe(1);
      // One hold for the winner's line; the loser's grant was released.
      expect(await liveHolds(sku.get('A-1')!)).toBe(holdsBefore + 1);
    });

    it('a concurrent duplicate on the PORTAL: the index violation answers the portal wording, one order, the loser’s grant released', async () => {
      const inventory = app.get(InventoryFacade);
      const original = inventory.grantReservation.bind(inventory);
      let arrived = 0;
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const holdsBefore = await liveHolds(sku.get('A-1')!);
      const spy = jest.spyOn(inventory, 'grantReservation').mockImplementation(async (args) => {
        arrived += 1;
        if (arrived === 2) openGate();
        await gate;
        return original(args);
      });
      let results: request.Response[];
      try {
        results = await Promise.all([place(orderBody('A-1', { clientOrderRef: 'SO-PRACE' })), place(orderBody('A-1', { clientOrderRef: 'SO-PRACE' }))]);
      } finally {
        spy.mockRestore();
      }
      expect(arrived).toBe(2);
      expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
      const loser = results.find((res) => res.status === 409)!;
      expect({ code: loser.body.code, detail: loser.body.detail, orderId: loser.body.orderId }).toEqual({
        code: 'duplicate-client-order-ref',
        detail: PORTAL_DUPLICATE('SO-PRACE'),
        orderId: undefined,
      });
      expect(await ordersWithRef(acme, 'SO-PRACE')).toBe(1);
      expect(await liveHolds(sku.get('A-1')!)).toBe(holdsBefore + 1);
    });

    it('pack, dispatch, the register and the RMA all name the order by its number', async () => {
      const { orderId: shipped, picklist } = await fixtures.releasedWave([{ skuId: sku.get('A-1')!, quantity: 2 }], { clientOrderRef: 'SO-SHIP' });
      await fixtures.pickAllLines(picklist);
      const { pack, dispatch } = await fixtures.packAndDispatch(shipped, scannedOf(picklist));
      expect(pack).toMatchObject({ orderId: shipped, clientOrderRef: 'SO-SHIP', externalEventId: null });
      expect(dispatch).toMatchObject({ orderId: shipped, clientOrderRef: 'SO-SHIP' });

      // The outbound register's row (its column order is pinned in test/registers.spec.ts).
      const registerRows = await withTenantTransaction(db, tenantId, (tx) =>
        app.get(OutboundFacade).outboundRegisterInTx(
          tx,
          { tenantId, warehouseId, clientId: acme, from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' },
          5000,
        ),
      );
      expect(registerRows.filter((row) => row.orderId === shipped).map((row) => [row.clientOrderRef, row.channelOrderRef])).toEqual([['SO-SHIP', null]]);
      expect(registerRows.find((row) => row.orderId === orderId)?.clientOrderRef).toBe('SO-1042');

      // The RMA: the returnable preview and the stored order_reference agree — the client's number.
      const returnable = await http().get(`${API}/${tenantId}/returns/returnable?orderId=${shipped}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect(returnable.body.orderReference).toBe('SO-SHIP');
      const line = (returnable.body.lines as { orderLineId: string }[])[0]!;
      const rma = await http()
        .post(`${API}/${tenantId}/returns`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ orderId: shipped, lines: [{ orderLineId: line.orderLineId, qty: 1, reasonCode: 'damaged' }] })
        .expect(201);
      expect(rma.body.orderReference).toBe('SO-SHIP');
      expect((await sql`select order_reference from return_authorizations where id = ${rma.body.id as string}`)[0]!.order_reference).toBe('SO-SHIP');
    });

    it('a manual order with no number still stores a null RMA order reference', async () => {
      const { orderId: shipped, picklist } = await fixtures.releasedWave([{ skuId: sku.get('A-1')!, quantity: 1 }]);
      await fixtures.pickAllLines(picklist);
      await fixtures.packAndDispatch(shipped, scannedOf(picklist));
      const returnable = await http().get(`${API}/${tenantId}/returns/returnable?orderId=${shipped}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect(returnable.body.orderReference).toBeNull();
    });
  });

  // ── the label rule's backend arm: the wind-down blocker ────────────────────

  it('the wind-down blocker names open orders by the label rule: the client number, else the channel reference, else the id’s last 8 characters', async () => {
    const numbered = (await staffCreate(orderBody('G-1', { clientOrderRef: 'GM-1' })).expect(201)).body.order.id as string;
    const bare = (await staffCreate(orderBody('G-1')).expect(201)).body.order.id as string;
    const channelEvent = `GM-CH-${ulid().slice(-6)}`;
    await staffCreate(orderBody('G-1', { source: 'ingested', integrationId: uuidv7(), externalEventId: channelEvent })).expect(201);
    const blockers = await withTenantTransaction(db, tenantId, (tx) => clientWindDownBlockersInTx(tx, tenantId, gamma));
    // (The SQL orders the codes by the database collation — compare as sets.)
    expect(blockers.map((b) => ({ ...b, codes: [...(b.codes ?? [])].sort() }))).toEqual([
      { kind: 'open-orders', count: 3, codes: [bare.slice(-8), 'GM-1', channelEvent].sort() },
    ]);
    expect(numbered).not.toBe(bare);
  });

  // ── the portal ─────────────────────────────────────────────────────────────

  describe('the portal', () => {
    it('ACME places " SO-7 ": stored "SO-7"; the placed response and its list row carry it', async () => {
      const res = await place(orderBody('A-1', { clientOrderRef: ' SO-7 ' })).expect(201);
      expect(res.body).toEqual({ orderId: expect.any(String), warehouseName: 'Main', lineCount: 1, placedAt: expect.any(String), clientOrderRef: 'SO-7' });
      expect((await sql`select client_order_ref from orders where id = ${res.body.orderId as string}`)[0]!.client_order_ref).toBe('SO-7');
      const row = (await portalSearch('')).find((o) => o.id === res.body.orderId);
      expect(row).toMatchObject({ clientOrderRef: 'SO-7', externalRef: null });
      const detail = await http().get(`${API}/${tenantId}/portal/orders/${res.body.orderId as string}`).set('Authorization', `Bearer ${portalA}`).expect(200);
      expect(detail.body.clientOrderRef).toBe('SO-7');
    });

    it('the portal search finds ACME’s own order, never BETA’s; BETA cannot find ACME’s number', async () => {
      const acmeHits = await portalSearch('reference=SO-7');
      expect(acmeHits.map((o) => o.clientOrderRef)).toEqual(['SO-7']);
      // SO-1042 exists for ACME and for BETA: each portal sees only its own.
      const acmeSo1042 = await portalSearch('reference=SO-1042');
      const betaSo1042 = await portalSearch('reference=SO-1042', portalB);
      expect(acmeSo1042).toHaveLength(1);
      expect(betaSo1042).toHaveLength(1);
      expect(acmeSo1042[0]!.id).not.toBe(betaSo1042[0]!.id);
      const betaOwn = await sql`select id from orders where tenant_id = ${tenantId} and client_id = ${beta} and client_order_ref = 'SO-1042'`;
      expect(betaSo1042[0]!.id).toBe(betaOwn[0]!.id);
      expect(await portalSearch('reference=SO-7', portalB)).toEqual([]);
      // Over 200 characters is 400 (200 is accepted — a channel reference's ceiling); a blank reference is no search.
      await http().get(`${API}/${tenantId}/portal/orders?reference=${'x'.repeat(200)}`).set('Authorization', `Bearer ${portalA}`).expect(200);
      const long = await http().get(`${API}/${tenantId}/portal/orders?reference=${'x'.repeat(201)}`).set('Authorization', `Bearer ${portalA}`).expect(400);
      expect(long.body.code).toBe('validation-failed');
      expect((await portalSearch('reference=%20%20')).length).toBeGreaterThan(1);
    });
  });

  // ── the staff search ──────────────────────────────────────────────────────

  describe('the staff search', () => {
    let channelOrder: string;

    beforeAll(async () => {
      channelOrder = (
        await staffCreate(orderBody('A-1', { source: 'ingested', integrationId: uuidv7(), externalEventId: 'AMZ-9' })).expect(201)
      ).body.order.id as string;
    });

    it('?reference= finds the client number (both clients’) and the channel reference; exact, trimmed, case-sensitive', async () => {
      const both = await staffSearch('reference=SO-1042');
      expect(both.map((o) => [o.clientId, o.clientOrderRef]).sort()).toEqual([
        [acme, 'SO-1042'],
        [beta, 'SO-1042'],
      ].sort());
      expect((await staffSearch('reference=%20SO-1042%20')).length).toBe(2);
      expect((await staffSearch('reference=so-1042')).map((o) => o.clientOrderRef)).toEqual(['so-1042']);
      expect(await staffSearch('reference=SO-104')).toEqual([]);
      expect((await staffSearch('reference=AMZ-9')).map((o) => [o.id, o.externalEventId])).toEqual([[channelOrder, 'AMZ-9']]);
      // A portal order is found by its number too.
      expect((await staffSearch('reference=SO-7')).map((o) => o.clientId)).toEqual([acme]);
    });

    it('scoped as the list is: the client filter composes, another warehouse finds nothing; over 200 characters is 400', async () => {
      expect((await staffSearch(`reference=SO-1042&clientId=${beta}`)).map((o) => o.clientId)).toEqual([beta]);
      expect(await staffSearch(`reference=SO-1042&clientId=${gamma}`)).toEqual([]);
      expect(await staffSearch('reference=SO-1042', otherWarehouseId)).toEqual([]);
      const long = await http()
        .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/orders?reference=${'x'.repeat(201)}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(400);
      expect(long.body.code).toBe('validation-failed');
      // The orders-only subclass: the manifest and wave lists do not take it.
      for (const path of ['manifests', 'waves']) {
        const res = await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/${path}?reference=SO-1042`).set('Authorization', `Bearer ${opsToken}`).expect(400);
        expect(res.body.code).toBe('validation-failed');
      }
    });

    it('the search indexes are usable: each arm of the real reference predicate plans on its partial index', async () => {
      const plan = await withTenantTransaction(db, tenantId, async (tx) => {
        await tx.execute(dsql`set local enable_seqscan = off`);
        // The list's own shape (tenant, warehouse, keyset order, limit) around
        // the shared predicate `listOrders` and `portalOrdersInTx` both call.
        const query = tx
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.tenantId, tenantId), eq(orders.warehouseId, warehouseId), orderReferenceMatch(orders.id, tenantId, 'SO-1042')))
          .orderBy(desc(orders.createdAt), desc(orders.id))
          .limit(51)
          .toSQL();
        const rows = (await tx.execute(dsql.raw(`explain ${inline(query.sql, query.params)}`))) as unknown as Record<string, string>[];
        return rows.map((row) => Object.values(row)[0]).join('\n');
      });
      expect(plan).toContain('orders_client_order_ref_idx');
      expect(plan).toContain('orders_external_event_client_idx');
      // And the portal's arms (with the client predicate inside each) likewise.
      const portalPlan = await withTenantTransaction(db, tenantId, async (tx) => {
        await tx.execute(dsql`set local enable_seqscan = off`);
        const rows = (await tx.execute(
          dsql`explain select o.id from orders o where o.tenant_id = ${tenantId}::uuid and o.client_id = ${acme}::uuid and ${orderReferenceMatch(dsql`o.id`, tenantId, 'SO-7', acme)}`,
        )) as unknown as Record<string, string>[];
        return rows.map((row) => Object.values(row)[0]).join('\n');
      });
      expect(portalPlan).toContain('orders_client_order_ref_idx');
      expect(portalPlan).toContain('orders_external_event_client_idx');
    });
  });
});

/** Inline drizzle's `$n` parameters as literals for an EXPLAIN (test-only; the values are this suite's own). */
function inline(text: string, params: readonly unknown[]): string {
  return text.replace(/\$(\d+)/g, (_match, n: string) => {
    const value = params[Number(n) - 1];
    if (typeof value === 'number') return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
  });
}
