import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ValkeyClient } from '../src/shared/valkey/valkey.client';
import { licenceClock } from '../src/modules/compliance/licence-enforcement';
import { orderImportHooks } from '../src/modules/outbound/order-import.command';
import { orderImportOrderKey } from '../src/modules/outbound/order-import.parse';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 4-1c — the CLIENT PORTAL order import (`POST portal/order-imports`):
// the client is the session's, the SKUs are its own active non-kit ones, each
// order is placed through `placePortalOrder` (a shortage refuses that order),
// the import's transactions are client-stamped and gated, and the response is
// an exact key allowlist. Like every jest e2e suite this connects as a
// superuser (RLS inert); the write set under the stamp is proved as
// `wms_rls_probe` in test/client-isolation.spec.ts, the stamp by the
// architecture scan.
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
const TODAY = '2026-11-02';
// `client` and `rate` are staff columns: a portal file carrying them has them ignored.
const HEADER = 'order_ref,client,sku,quantity,rate,ship_to_name,ship_to_phone,ship_to_line1,ship_to_line2,ship_to_city,ship_to_state,ship_to_pincode,order_type,priority';
const ADDR = 'Priya Sharma,9845012345,12 Peenya Industrial Area,,Bengaluru,Karnataka,560066';
const BLANK_ADDR = ',,,,,,';
const row = (ref: string, sku: string, quantity: string, extra: { client?: string; rate?: string; addr?: string; type?: string; priority?: string } = {}): string =>
  [ref, extra.client ?? '', sku, quantity, extra.rate ?? '', extra.addr ?? ADDR, extra.type ?? '', extra.priority ?? ''].join(',');
const file = (...rows: string[]): string => [HEADER, ...rows].join('\n');
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Portal {
  userId: string;
  token: string;
}

describe('order import — client portal (e2e, story 4-1c)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let valkey: Redis;
  const realNow = licenceClock.now;

  let tenantId: string;
  let ownerToken: string;
  let wh: string;
  let bin: string;
  let acme: string;
  let beta: string;
  let portalA: Portal;
  let portalB: Portal;
  const sku = new Map<string, string>();

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('portalorderimport');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 3, onnotice: () => undefined });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });
    licenceClock.now = () => Date.parse(`${TODAY}T06:00:00Z`);

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Portal Import 3PL ${ulid()}`, ownerEmail, password: PASSWORD }).expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = await signIn(ownerEmail);
    wh = (await authed(http().post(`${API}/${tenantId}/warehouses`)).send({ origin: testAddress(), code: `PI-W1-${ulid().slice(20)}`, name: 'Main' }).expect(201)).body.id as string;
    const zone = (await authed(http().post(`${API}/${tenantId}/warehouses/${wh}/zones`)).send({ code: 'A', name: 'Zone A' }).expect(201)).body.id as string;
    bin = (await authed(http().post(`${API}/${tenantId}/warehouses/${wh}/zones/${zone}/bins`)).send({ capacity: 1_000_000, type: 'shelf', code: 'A-01-01' }).expect(201)).body.id as string;
    acme = (await authed(http().post(`${API}/${tenantId}/clients`)).send({ code: 'ACME', name: 'Acme Apparel' }).expect(201)).body.client.id as string;
    beta = (await authed(http().post(`${API}/${tenantId}/clients`)).send({ code: 'BETA', name: 'Beta Beauty' }).expect(201)).body.client.id as string;
    await importCsv(['A-1,Acme tee,pcs,1800,,false,false', 'A-2,Acme cap,pcs,1800,,false,false', 'A-3,Acme sock,pcs,1800,,false,false', 'A-OLD,Acme old,pcs,1800,,false,false', 'A-C1,Acme band,pcs,1800,,false,false', 'A-KIT,Acme bundle,pcs,1800,,false,false', 'A-LOT,Acme balm,pcs,1800,,true,false'], acme);
    await importCsv(['B-1,Beta serum,pcs,1800,,false,false'], beta);
    for (const item of (await authed(http().get(`${API}/${tenantId}/catalog/skus?limit=200`)).expect(200)).body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    await authed(http().post(`${API}/${tenantId}/catalog/skus/${sku.get('A-KIT')!}/kit`)).send({ components: [{ skuId: sku.get('A-C1')!, quantity: 1 }] }).expect(201);
    for (const [code, qty] of [
      ['A-1', 500],
      ['A-2', 2],
      ['A-3', 500],
      ['A-OLD', 5],
      ['A-C1', 10],
      ['B-1', 10],
    ] as const) {
      await adjust(sku.get(code)!, qty);
    }
    await adjust(sku.get('A-LOT')!, 10, { code: 'L1' });
    await sql`update skus set status = 'inactive' where id = ${sku.get('A-OLD')!}`;
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, wh);
    portalA = await portalUser(acme);
    portalB = await portalUser(beta);
  });

  afterAll(async () => {
    licenceClock.now = realNow;
    orderImportHooks.afterOrder = null;
    const keys = await valkey.keys(`wms:{${tenantId}}:*`).catch(() => [] as string[]);
    if (keys.length > 0) await valkey.del(...keys);
    await valkey.quit().catch(() => valkey.disconnect());
    await sql?.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  afterEach(async () => {
    orderImportHooks.afterOrder = null;
    jest.restoreAllMocks();
    await sql`update clients set status = 'active' where id = ${acme}`;
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  function authed(req: request.Test, token = ownerToken): request.Test {
    return req.set('Authorization', `Bearer ${token}`).set(KEY_HEADER, ulid());
  }

  async function signIn(email: string): Promise<string> {
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked', ...rows].join('\n');
    await authed(http().post(`${API}/${tenantId}/catalog/imports`))
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  async function adjust(skuId: string, quantityDelta: number, batch?: { code: string }): Promise<void> {
    await authed(http().post(`${API}/${tenantId}/inventory/adjustments`))
      .send({ warehouseId: wh, skuId, binId: bin, quantityDelta, reasonCode: 'stock-count', note: 'portal import seed', ...(batch === undefined ? {} : { batch }) })
      .expect(201);
  }

  async function portalUser(clientId: string): Promise<Portal> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await authed(http().post(`${API}/${tenantId}/users`)).send({ email, role: 'client', clientId }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { userId: invited.body.user.id as string, token: await signIn(email) };
  }

  function upload(content: string, opts: { dryRun?: boolean; key?: string; token?: string; route?: 'portal' | 'staff' } = {}): request.Test {
    const path = opts.route === 'staff' ? 'outbound/order-imports' : 'portal/order-imports';
    const req = http().post(`${API}/${tenantId}/${path}`).set('Authorization', `Bearer ${opts.token ?? portalA.token}`);
    const keyed = opts.dryRun === true ? req : req.set(KEY_HEADER, opts.key ?? ulid());
    const fields = keyed.field('warehouseId', wh);
    return (opts.dryRun === true ? fields.field('dryRun', 'true') : fields).attach('file', Buffer.from(content, 'utf8'), { filename: 'orders.csv', contentType: 'text/csv' });
  }

  async function count(query: PromiseLike<unknown>): Promise<number> {
    return Number(((await query) as { n: number }[])[0]!.n);
  }
  const ordersOf = (ref: string) => sql`select count(*)::int as n from orders where tenant_id = ${tenantId} and client_order_ref = ${ref}`;
  const refs = (): string => `P${ulid().slice(16)}`;

  // ── the happy path ────────────────────────────────────────────────────────

  it('AC2: ACME checks then imports — exact keys, ordinary manual ACME orders in its portal list and the staff list; BETA sees none; client and rate columns are ignored', async () => {
    const p = refs();
    const content = file(
      row(`${p}-1`, 'A-1', '2', { client: 'BETA', rate: '999', type: 'B2C', priority: 'High' }),
      row(`${p}-1`, 'A-3', '1', { addr: BLANK_ADDR }),
      row(`${p}-2`, 'A-1', '1'),
    );
    const checked = await upload(content, { dryRun: true }).expect(200);
    expect(checked.body).toEqual({
      importId: null,
      dryRun: true,
      warehouseId: wh,
      fileSha256: sha(content),
      rowCount: 3,
      orderCount: 2,
      acceptedCount: 2,
      refusedCount: 0,
      complete: true,
      notAttemptedCount: 0,
      orders: [
        { orderId: null, clientOrderRef: `${p}-1`, lineCount: 2, firstRow: 2, replayed: false },
        { orderId: null, clientOrderRef: `${p}-2`, lineCount: 1, firstRow: 4, replayed: false },
      ],
      errors: [],
    });
    expect(await count(ordersOf(`${p}-1`))).toBe(0);

    const key = ulid();
    const imported = (await upload(content, { key }).expect(201)).body;
    expect(Object.keys(imported).sort()).toEqual(
      ['importId', 'dryRun', 'warehouseId', 'fileSha256', 'rowCount', 'orderCount', 'acceptedCount', 'refusedCount', 'complete', 'notAttemptedCount', 'orders', 'errors'].sort(),
    );
    expect(Object.keys(imported.orders[0]).sort()).toEqual(['clientOrderRef', 'firstRow', 'lineCount', 'orderId', 'replayed']);
    expect(imported).toMatchObject({ acceptedCount: 2, complete: true });
    await expectAuditRow({ tenantId, key, action: 'order_import.executed', targetType: 'order_import', targetId: imported.importId as string, actorUserId: portalA.userId });
    for (const order of imported.orders as { orderId: string; clientOrderRef: string }[]) {
      const derived = orderImportOrderKey(key, { surface: 'portal', fileSha256: sha(content), warehouseId: wh, client: acme, orderRef: order.clientOrderRef });
      await expectAuditRow({ tenantId, key: derived, action: 'order.created', targetType: 'order', targetId: order.orderId, actorUserId: portalA.userId });
    }
    const stored = (await sql`select client_id, source, order_type, priority from orders where id = ${imported.orders[0].orderId as string}`)[0];
    expect(stored).toEqual({ client_id: acme, source: 'manual', order_type: 'b2c', priority: 'high' });
    const rates = await sql`select rate_paise from order_lines where order_id = ${imported.orders[0].orderId as string}`;
    expect(rates.map((line) => line.rate_paise)).toEqual([null, null]);

    const portalList = (await http().get(`${API}/${tenantId}/portal/orders?limit=100`).set('Authorization', `Bearer ${portalA.token}`).expect(200)).body.items as { orderId?: string; id?: string }[];
    const listedIds = portalList.map((item) => item.orderId ?? item.id);
    expect(listedIds).toEqual(expect.arrayContaining(imported.orders.map((order: { orderId: string }) => order.orderId)));
    const betaList = (await http().get(`${API}/${tenantId}/portal/orders?limit=100`).set('Authorization', `Bearer ${portalB.token}`).expect(200)).body.items as { orderId?: string; id?: string }[];
    expect(betaList.map((item) => item.orderId ?? item.id)).not.toEqual(expect.arrayContaining([imported.orders[0].orderId]));
    const staffList = (await http().get(`${API}/${tenantId}/warehouses/${wh}/outbound/orders?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.items as { id: string }[];
    expect(staffList.map((item) => item.id)).toEqual(expect.arrayContaining(imported.orders.map((order: { orderId: string }) => order.orderId)));

    // The replay re-serves the stored response; the portal duplicate sentence on a re-upload.
    expect((await upload(content, { key }).expect(201)).body).toEqual(imported);
    const again = (await upload(content).expect(201)).body;
    expect(again.errors.map((error: { code: string }) => error.code)).toEqual(['duplicate-client-order-ref', 'duplicate-client-order-ref']);
    expect(again.errors[0].detail).toContain('is already used by another of your orders');
  });

  it('the population: BETA’s code, an inactive SKU, a kit and an unknown code are the same unknown-sku; urgent is the portal sentence; a shortage refuses only its order', async () => {
    const p = refs();
    const content = file(
      row(`${p}-OK`, 'A-1', '1'),
      row(`${p}-B`, 'B-1', '1'),
      row(`${p}-OLD`, 'A-OLD', '1'),
      row(`${p}-KIT`, 'A-KIT', '1'),
      row(`${p}-NO`, 'NOPE', '1'),
      row(`${p}-URG`, 'A-1', '1', { priority: 'Urgent' }),
      row(`${p}-SHORT`, 'A-2', '10'),
    );
    const body = (await upload(content).expect(201)).body;
    expect(body.orders.map((order: { clientOrderRef: string }) => order.clientOrderRef)).toEqual([`${p}-OK`]);
    expect(body.errors.map((error: { orderRef: string; code: string }) => [error.orderRef, error.code])).toEqual([
      [`${p}-B`, 'unknown-sku'],
      [`${p}-OLD`, 'unknown-sku'],
      [`${p}-KIT`, 'unknown-sku'],
      [`${p}-NO`, 'unknown-sku'],
      [`${p}-URG`, 'validation-failed'],
      [`${p}-SHORT`, 'order-backorder-rejected'],
    ]);
    // Another client's code is never confirmed to exist: the same words as an unknown one.
    const words = body.errors.slice(0, 4).map((error: { detail: string; sku: string }) => error.detail.replace(`"${error.sku}"`, '<code>'));
    expect(new Set(words).size).toBe(1);
    expect(body.errors[4].detail).toBe('Urgent priority is set by the warehouse — choose Normal or High.');
    expect(body.errors[5].detail).toContain('"A-2"');
    expect(await count(sql`select count(*)::int as n from reservations where tenant_id = ${tenantId} and sku_id = ${sku.get('A-2')!} and state in ('held', 'committed')`)).toBe(0);
  });

  it('3-7a: an order of a SKU whose only lot is under a live recall is refused order-backorder-rejected (the portal never backorders)', async () => {
    const lot = ((await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku.get('A-LOT')!} and code = 'L1'`)[0] as { id: string }).id;
    await authed(http().post(`${API}/${tenantId}/inventory/recalls`)).send({ batchIds: [lot], reasonNote: 'contamination', mode: 'live' }).expect(201);
    const p = refs();
    const body = (await upload(file(row(`${p}-1`, 'A-LOT', '1'), row(`${p}-2`, 'A-1', '1'))).expect(201)).body;
    expect(body.errors.map((error: { orderRef: string; code: string }) => [error.orderRef, error.code])).toEqual([[`${p}-1`, 'order-backorder-rejected']]);
    expect(body.orders.map((order: { clientOrderRef: string }) => order.clientOrderRef)).toEqual([`${p}-2`]);
  });

  // ── the gate and the surfaces ─────────────────────────────────────────────

  it('A16: a client suspended between orders aborts the run 403 — created orders stay, no import key; after reactivation the same key replays them and places the rest', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'A-1', '1'), row(`${p}-2`, 'A-1', '1'));
    const key = ulid();
    orderImportHooks.afterOrder = async (index) => {
      if (index === 0) await sql`update clients set status = 'suspended' where id = ${acme}`;
    };
    expect((await upload(content, { key }).expect(403)).body.code).toBe('client-suspended');
    expect(await count(ordersOf(`${p}-1`))).toBe(1);
    expect(await count(ordersOf(`${p}-2`))).toBe(0);
    expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(0);
    orderImportHooks.afterOrder = null;
    await sql`update clients set status = 'active' where id = ${acme}`;
    const resumed = (await upload(content, { key }).expect(201)).body;
    expect(resumed.orders.map((order: { clientOrderRef: string; replayed: boolean }) => [order.clientOrderRef, order.replayed])).toEqual([
      [`${p}-1`, true],
      [`${p}-2`, false],
    ]);
  });

  it('A2: a resume after the first order’s SKU was deactivated replays that order (no rule re-runs on it) and places the rest', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'A-3', '1'), row(`${p}-2`, 'A-1', '1'));
    const key = ulid();
    const store = app.get(ValkeyClient);
    const real = ValkeyClient.prototype.grantReservation;
    let grants = 0;
    jest.spyOn(store, 'grantReservation').mockImplementation(async (...args) => {
      grants += 1;
      if (grants === 1) return real.apply(store, args as Parameters<ValkeyClient['grantReservation']>);
      throw new Error('connection refused');
    });
    expect((await upload(content, { key }).expect(503)).body.detail).toContain('1 order was created');
    jest.restoreAllMocks();
    await sql`update skus set status = 'inactive' where id = ${sku.get('A-3')!}`;
    try {
      const resumed = (await upload(content, { key }).expect(201)).body;
      expect(resumed.errors).toEqual([]);
      expect(resumed.orders.map((order: { clientOrderRef: string; replayed: boolean }) => [order.clientOrderRef, order.replayed])).toEqual([
        [`${p}-1`, true],
        [`${p}-2`, false],
      ]);
    } finally {
      await sql`update skus set status = 'active' where id = ${sku.get('A-3')!}`;
    }
  });

  it('surfaces: a staff import key replayed on the portal route is 422 (the fingerprint starts with surface); an operator token is fenced off the portal route and a client token off the staff one', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'A-1', '1'));
    const key = ulid();
    await upload(content, { key, token: ownerToken, route: 'staff' }).expect(201);
    expect((await upload(content, { key }).expect(422)).body.code).toBe('idempotency-key-reuse');
    expect((await upload(content, { dryRun: true, token: ownerToken }).expect(403)).body.detail).toBe('This is a client-portal surface.');
    expect((await upload(content, { dryRun: true, route: 'staff' }).expect(403)).body.detail).toBe('This is an operator surface.');
  });

  it('C13: authority is re-read in Transaction B — a client suspended during the LAST order aborts 403 with no import key and no import audit row; the orders stay', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'A-1', '1'), row(`${p}-2`, 'A-1', '1'));
    const key = ulid();
    orderImportHooks.afterOrder = async (index) => {
      if (index === 1) await sql`update clients set status = 'suspended' where id = ${acme}`;
    };
    expect((await upload(content, { key }).expect(403)).body.code).toBe('client-suspended');
    expect(await count(ordersOf(`${p}-1`))).toBe(1);
    expect(await count(ordersOf(`${p}-2`))).toBe(1);
    expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${key}`)).toBe(0);
  });
});
