import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { OrderCommandService } from '../src/modules/outbound/order.command';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { licenceClock } from '../src/modules/compliance/licence-enforcement';
import { PORTAL_SURFACE_DETAIL } from '../src/modules/clients/portal-session.guard';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 4-1a — portal order entry: a client user places an outbound order for
// its OWN active SKUs (`POST portal/orders`, the client taken from the
// session) through `OrderCommandService.placePortalOrder`, which shares the
// order pipeline with the staff `createOrder`. Like every jest e2e suite this
// connects as a superuser (RLS inert), so these HTTP tests prove the app
// predicate; the write set under a client stamp is proved as `wms_rls_probe`
// in test/client-isolation.spec.ts, the stamp itself by the architecture scan.
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
const TODAY = '2026-11-01';
const WIDE = { validFrom: '2026-01-01', validUntil: '2028-12-31' };
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
/** `testAddress()` exactly as the hash fingerprints it (already normalized). */
const DESTINATION_JSON =
  '{"contactName":"Priya Sharma","phone":"+91 98450 12345","line1":"12, Peenya Industrial Area","line2":"Gate 3","city":"Bengaluru","state":"Karnataka","pincode":"560066"}';
const GSTIN = '29AAACM4321K1Z8';
const GENERIC_LICENCE_DETAIL =
  'A licence for one of these products is not on file with the warehouse — nothing was placed. Contact the warehouse.';

interface Portal {
  userId: string;
  email: string;
  token: string;
}

describe('portal order entry (e2e, story 4-1a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let valkey: Redis;
  const realNow = licenceClock.now;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let whMain: string; // "Main" — the stock
  let whAnnex: string; // "Annex" — nothing on hand
  let binMain: string;
  let clientA: string; // ACME
  let clientB: string; // BETA
  const sku = new Map<string, string>();
  let portalA: Portal;
  let portalB: Portal;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('portalordercreate');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 3, onnotice: () => undefined });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });
    licenceClock.now = () => Date.parse(`${TODAY}T06:00:00Z`);

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Portal Orders 3PL ${ulid()}`, ownerEmail, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = await signIn(ownerEmail);

    whMain = await createWarehouse('PO-W1', 'Main');
    whAnnex = await createWarehouse('PO-W2', 'Annex');
    const zone = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${whMain}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' })
        .expect(201)
    ).body.id as string;
    binMain = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${whMain}/zones/${zone}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 1000000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;

    clientA = await createClient('ACME', 'Acme Apparel');
    clientB = await createClient('BETA', 'Beta Beauty');
    await importCsv(
      ['A-1,Acme tee,pcs,1800,,,', 'A-2,Acme cap,pcs,1800,,,', 'A-KG,Acme rice,kg,500,,,', 'A-OLD,Acme old tee,pcs,1800,,,', 'A-C1,Acme sock,pcs,1800,,,', 'A-KIT,Acme bundle,pcs,1800,,,'],
      clientA,
    );
    await importCsv(['B-1,Beta serum,pcs,1800,,,'], clientB);
    const listed = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of listed.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    await http()
      .post(`${API}/${tenantId}/catalog/skus/${sku.get('A-KIT')!}/kit`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: sku.get('A-C1')!, quantity: 1 }] })
      .expect(201);
    // Drug SKUs of ACME: H (Form 20B — the site AND ACME hold one) and NDPS
    // (nobody holds one).
    sku.set('A-DRUG', await createSku(clientA, 'A-DRUG', { drugSchedules: ['H'] }));
    sku.set('A-NDPS', await createSku(clientA, 'A-NDPS', { drugSchedules: ['NDPS'] }));

    for (const [code, qty] of [
      ['A-1', 100],
      ['A-2', 2],
      ['A-KG', 50],
      ['A-OLD', 5],
      ['A-C1', 10],
      ['A-DRUG', 10],
      ['A-NDPS', 10],
      ['B-1', 10],
    ] as const) {
      await adjust(whMain, binMain, sku.get(code)!, qty);
    }
    await sql`update skus set status = 'inactive' where id = ${sku.get('A-OLD')!}`;
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, whMain);
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, whAnnex);

    // Licences: the site and ACME both hold Form 20B; enforcement on.
    await addLicence({ warehouseId: whMain, kind: 'drug-20b', number: `MH/SITE/${ulid().slice(18)}`, ...WIDE });
    await addLicence({ clientId: clientA, kind: 'drug-20b', number: `MH/ACME/${ulid().slice(18)}`, ...WIDE });
    const shown = (await http().get(`${API}/${tenantId}/licence-policy`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body as { gapCount: number };
    await http()
      .put(`${API}/${tenantId}/licence-policy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ enforce: true, acknowledgedGapCount: shown.gapCount })
      .expect(200);

    portalA = await portalUser(clientA);
    portalB = await portalUser(clientB);
  });

  afterAll(async () => {
    licenceClock.now = realNow;
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

  // ── helpers ────────────────────────────────────────────────────────────────

  async function signIn(email: string): Promise<string> {
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
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
      await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name })
        .expect(201)
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

  async function createSku(clientId: string, code: string, goods: Record<string, unknown>): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name: `${code} goods`, uom: 'each', gstRate: 1800, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId, ...goods })
        .expect(201)
    ).body.sku.id as string;
  }

  async function addLicence(body: Record<string, unknown>): Promise<void> {
    await http().post(`${API}/${tenantId}/licences`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send(body).expect(201);
  }

  async function adjust(warehouseId: string, binId: string, skuId: string, quantityDelta: number): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta, reasonCode: 'stock-count', note: 'portal order seed' })
      .expect(201);
  }

  function invite(body: Record<string, unknown>) {
    return http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send(body);
  }

  async function portalUser(clientId: string): Promise<Portal> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await invite({ email, role: 'client', clientId }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { userId: invited.body.user.id as string, email, token: await signIn(email) };
  }

  function body(lines: { skuId: string; quantity: number }[], extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { warehouseId: whMain, lines, destination: testAddress(), ...extra };
  }

  function place(payload: Record<string, unknown>, token = portalA.token, key: string | null = ulid()) {
    const req = http().post(`${API}/${tenantId}/portal/orders`).set('Authorization', `Bearer ${token}`);
    return (key === null ? req : req.set(KEY_HEADER, key)).send(payload);
  }

  function portalGet(path: string, token = portalA.token) {
    return http().get(`${API}/${tenantId}/portal/${path}`).set('Authorization', `Bearer ${token}`);
  }

  function staffCreate(payload: Record<string, unknown>, key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/orders`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key).send(payload);
  }

  async function orderCount(clientId: string): Promise<number> {
    return (await sql`select count(*)::int as n from orders where tenant_id = ${tenantId} and client_id = ${clientId}`)[0]!.n as number;
  }

  async function liveHolds(skuId: string): Promise<number> {
    return (await sql`select count(*)::int as n from reservations where tenant_id = ${tenantId} and sku_id = ${skuId} and state in ('held', 'committed')`)[0]!
      .n as number;
  }

  const command = (overrides: Record<string, unknown> = {}) => ({
    tenantId,
    clientId: clientA,
    actorUserId: portalA.userId,
    warehouseId: whMain,
    lines: [{ skuId: sku.get('A-1')!, quantity: 1 }],
    destination: testAddress() as never,
    ...overrides,
  });

  /** A direct command call's refusal as `{status, code, detail}`. */
  async function refusal(run: Promise<unknown>): Promise<{ status: number; code: unknown; detail: unknown }> {
    try {
      await run;
    } catch (error) {
      if (error instanceof HttpException) {
        const res = error.getResponse() as { code?: unknown; detail?: unknown };
        return { status: error.getStatus(), code: res.code, detail: res.detail };
      }
      throw error;
    }
    throw new Error('expected a refusal, the command succeeded');
  }

  // ── place an order ─────────────────────────────────────────────────────────

  describe('place an order', () => {
    it('ACME places two in-stock SKUs: 201 {orderId, warehouseName, lineCount, placedAt} — an ordinary manual ACME order in both lists; the audit actor is the client user', async () => {
      const key = ulid();
      const payload = body([
        { skuId: sku.get('A-1')!, quantity: 3 },
        { skuId: sku.get('A-KG')!, quantity: 2.5 },
      ]);
      const res = await place(payload, portalA.token, key).expect(201);
      const orderId = res.body.orderId as string;
      // Exact keys — no reservation, rate, phone, status or line detail.
      expect(res.body).toEqual({ orderId, warehouseName: 'Main', lineCount: 2, placedAt: expect.any(String) });
      expect(res.body.placedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // The staff view: an ordinary manual order of ACME, fully reserved.
      const staff = await http().get(`${API}/${tenantId}/outbound/orders/${orderId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(staff.body.order).toMatchObject({ id: orderId, clientId: clientA, warehouseId: whMain, status: 'accepted', source: 'manual', integrationId: null, externalEventId: null, createdAt: res.body.placedAt });
      expect((staff.body.order.lines as { skuId: string; qty: number; reservedQty: number; status: string }[]).map((l) => [l.skuId, l.qty, l.reservedQty, l.status])).toEqual([
        [sku.get('A-1')!, 3, 3, 'open'],
        [sku.get('A-KG')!, 2.5, 2.5, 'open'],
      ]);
      const staffList = await http().get(`${API}/${tenantId}/warehouses/${whMain}/outbound/orders?limit=100`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect((staffList.body.items as { id: string }[]).map((o) => o.id)).toContain(orderId);

      // The portal view: in ACME's list and detail.
      const mine = await portalGet('orders').expect(200);
      expect((mine.body.items as { id: string; source: string; lineCount: number }[]).find((o) => o.id === orderId)).toMatchObject({ source: 'manual', lineCount: 2, warehouseName: 'Main' });
      await portalGet(`orders/${orderId}`).expect(200);

      // One outbox order.created carrying the OPERATOR payload; the audit row's actor is the client user.
      const outbox = await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'order.created' and payload->'order'->>'id' = ${orderId}`;
      expect(outbox).toHaveLength(1);
      expect((outbox[0]!.payload as { order: Record<string, unknown> }).order).toMatchObject({ id: orderId, clientId: clientA, source: 'manual' });
      await expectAuditRow({ tenantId, key, action: 'order.created', targetType: 'order', targetId: orderId, actorUserId: portalA.userId });

      // Replay: the same key and body re-serve the stored PORTAL shape (never the operator snapshot).
      expect((await place(payload, portalA.token, key).expect(201)).body).toEqual(res.body);
      const stored = await sql`select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
      expect(stored[0]!.response_snapshot).toEqual(res.body);
      await expectAuditRow({ tenantId, key, action: 'order.created', targetType: 'order', targetId: orderId, actorUserId: portalA.userId });
      // A different body under the key is 422.
      expect((await place(body([{ skuId: sku.get('A-1')!, quantity: 4 }]), portalA.token, key).expect(422)).body.code).toBe('idempotency-key-reuse');
    });

    it('isolation: BETA never sees ACME’s order — not in its list, 404 on the detail', async () => {
      const res = await place(body([{ skuId: sku.get('A-1')!, quantity: 1 }])).expect(201);
      const orderId = res.body.orderId as string;
      expect(((await portalGet('orders?limit=100', portalB.token).expect(200)).body.items as { id: string }[]).map((o) => o.id)).not.toContain(orderId);
      expect((await portalGet(`orders/${orderId}`, portalB.token).expect(404)).body.code).toBe('not-found');
      // And BETA places its own, attributed to BETA.
      const beta = await place(body([{ skuId: sku.get('B-1')!, quantity: 1 }]), portalB.token).expect(201);
      const row = await sql`select client_id from orders where id = ${beta.body.orderId as string}`;
      expect(row[0]!.client_id).toBe(clientB);
    });

    it('a short line refuses the WHOLE order: 409 order-backorder-rejected naming the short SKUs; nothing written, every grant released', async () => {
      const before = { orders: await orderCount(clientA), a1: await liveHolds(sku.get('A-1')!), a2: await liveHolds(sku.get('A-2')!) };
      // The portal never reaches the channel refusal fact (it carries no channel refs).
      const recordSpy = jest.spyOn(app.get(OrderCommandService) as unknown as { recordBackorderRefusal: () => Promise<void> }, 'recordBackorderRefusal');
      const facts = async () => (await sql`select count(*)::int as n from ingest_backorder_refusals where tenant_id = ${tenantId}`)[0]!.n as number;
      const factsBefore = await facts();
      const res = await place(body([
        { skuId: sku.get('A-1')!, quantity: 1 },
        { skuId: sku.get('A-2')!, quantity: 3 },
      ])).expect(409);
      expect(recordSpy).not.toHaveBeenCalled();
      recordSpy.mockRestore();
      expect(await facts()).toBe(factsBefore);
      expect(res.body.code).toBe('order-backorder-rejected');
      expect(res.body.skuCodes).toEqual(['A-2']);
      expect(res.body.detail).toBe('Not enough stock at this warehouse for "A-2" — nothing was placed. Lower the quantities or choose another warehouse.');
      expect(await orderCount(clientA)).toBe(before.orders);
      expect(await liveHolds(sku.get('A-1')!)).toBe(before.a1);
      expect(await liveHolds(sku.get('A-2')!)).toBe(before.a2);
      // A warehouse holding none of it: every line short, all named.
      const annex = await place({ ...body([{ skuId: sku.get('A-1')!, quantity: 1 }, { skuId: sku.get('A-KG')!, quantity: 1 }]), warehouseId: whAnnex }).expect(409);
      expect(annex.body.skuCodes).toEqual(['A-1', 'A-KG']);
      // Meaningful: within stock it places.
      await place(body([{ skuId: sku.get('A-2')!, quantity: 2 }])).expect(201);
    });

    it('a foreign, kit, inactive or unknown SKU is the same 404 "for this client" — another client’s SKU is never confirmed', async () => {
      for (const skuId of [sku.get('B-1')!, sku.get('A-KIT')!, sku.get('A-OLD')!, uuidv7()]) {
        const res = await place(body([{ skuId: sku.get('A-1')!, quantity: 1 }, { skuId, quantity: 1 }])).expect(404);
        expect({ code: res.body.code, detail: res.body.detail }).toEqual({ code: 'not-found', detail: `No SKU with id "${skuId}" exists for this client.` });
      }
    });

    it('bad bodies are 400: a ratePaise, a clientId, no lines, an incomplete address, a quantity finer than its unit, a legal name without a GSTIN', async () => {
      const line = { skuId: sku.get('A-1')!, quantity: 1 };
      for (const payload of [
        body([{ ...line, ratePaise: 12500 } as never]),
        body([line], { clientId: clientA }),
        body([line], { source: 'manual' }),
        body([]),
        body([line], { destination: testAddress({ pincode: undefined }) }),
        body([{ ...line, quantity: 1.5 }]),
        body([line], { consigneeLegalName: 'Acme Buyer Ltd' }),
      ]) {
        expect((await place(payload).expect(400)).body.code).toBe('validation-failed');
      }
    });

    it('the Idempotency-Key is required and must be a ULID (400); an unknown warehouse is 404', async () => {
      const payload = body([{ skuId: sku.get('A-1')!, quantity: 1 }]);
      expect((await place(payload, portalA.token, null).expect(400)).body.code).toBe('idempotency-key-required');
      expect((await place(payload, portalA.token, 'not-a-ulid').expect(400)).body.code).toBe('idempotency-key-invalid');
      expect((await place({ ...payload, warehouseId: uuidv7() }).expect(404)).body.code).toBe('not-found');
    });

    it('a key is never shared across surfaces: identical fields under one key are 422, in both directions', async () => {
      const lines = [{ skuId: sku.get('A-1')!, quantity: 1 }];
      const k1 = ulid();
      await staffCreate(body(lines), k1).expect(201);
      expect((await place(body(lines), portalA.token, k1).expect(422)).body.code).toBe('idempotency-key-reuse');
      const k2 = ulid();
      await place(body(lines), portalA.token, k2).expect(201);
      expect((await staffCreate(body(lines), k2).expect(422)).body.code).toBe('idempotency-key-reuse');
    });
  });

  // ── licences ───────────────────────────────────────────────────────────────

  describe('licence enforcement (on)', () => {
    it('a drug SKU covered by the SITE’s and ACME’s licences is accepted — the site licence is read despite the portal stamp', async () => {
      const res = await place(body([{ skuId: sku.get('A-DRUG')!, quantity: 1 }])).expect(201);
      expect(res.body.lineCount).toBe(1);
    });

    it('an uncovered drug SKU is the GENERIC 409 licence-not-covered — never the site, its code, the holder or the licence', async () => {
      const before = await liveHolds(sku.get('A-NDPS')!);
      const res = await place(body([{ skuId: sku.get('A-1')!, quantity: 1 }, { skuId: sku.get('A-NDPS')!, quantity: 1 }])).expect(409);
      expect(res.body).toMatchObject({ code: 'licence-not-covered', detail: GENERIC_LICENCE_DETAIL });
      expect(res.body.skuCodes).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/PO-W1|site|NDPS licence|holder/i);
      expect(await liveHolds(sku.get('A-NDPS')!)).toBe(before);
      // Meaningful: the staff surface names the gaps for the same SKU.
      const staff = await staffCreate(body([{ skuId: sku.get('A-NDPS')!, quantity: 1 }])).expect(409);
      expect(staff.body.detail).toContain('A-NDPS — needs an NDPS licence');
    });
  });

  describe('licence enforcement — the seam and the re-check', () => {
    async function setEnforcement(on: boolean): Promise<void> {
      const shown = (await http().get(`${API}/${tenantId}/licence-policy`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body as { gapCount: number };
      await http()
        .put(`${API}/${tenantId}/licence-policy`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send(on ? { enforce: true, acknowledgedGapCount: shown.gapCount } : { enforce: false })
        .expect(200);
    }

    it('control: the client licence alone (no SITE licence at Annex) is refused — the site licence is required, which only the unstamped seam can see', async () => {
      const res = await place({ ...body([{ skuId: sku.get('A-DRUG')!, quantity: 1 }]), warehouseId: whAnnex }).expect(409);
      expect(res.body).toMatchObject({ code: 'licence-not-covered', detail: GENERIC_LICENCE_DETAIL });
      // Meaningful: at Main (site licence held) the same SKU is accepted.
      await place(body([{ skuId: sku.get('A-DRUG')!, quantity: 1 }])).expect(201);
    });

    it('enforcement OFF: an uncovered drug SKU is accepted (201)', async () => {
      await setEnforcement(false);
      try {
        expect((await place(body([{ skuId: sku.get('A-NDPS')!, quantity: 1 }])).expect(201)).body.lineCount).toBe(1);
      } finally {
        await setEnforcement(true);
      }
      // And on again, it is refused.
      await place(body([{ skuId: sku.get('A-NDPS')!, quantity: 1 }])).expect(409);
    });

    it('the phase-3 RE-CHECK: a plain SKU that becomes an NDPS drug between the phases is refused with the generic 409 — no order, every grant released', async () => {
      const inventory = app.get(InventoryFacade);
      const original = inventory.grantReservation.bind(inventory);
      const before = { orders: await orderCount(clientA), holds: await liveHolds(sku.get('A-1')!) };
      const spy = jest.spyOn(inventory, 'grantReservation').mockImplementation(async (args) => {
        await sql`update skus set drug_schedules = array['NDPS']::text[] where id = ${sku.get('A-1')!}`;
        return original(args);
      });
      try {
        const res = await place(body([{ skuId: sku.get('A-1')!, quantity: 1 }])).expect(409);
        expect(res.body).toMatchObject({ code: 'licence-not-covered', detail: GENERIC_LICENCE_DETAIL });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
        await sql`update skus set drug_schedules = '{}'::text[] where id = ${sku.get('A-1')!}`;
      }
      expect(await orderCount(clientA)).toBe(before.orders);
      expect(await liveHolds(sku.get('A-1')!)).toBe(before.holds);
    });
  });

  it('a buyer GSTIN registered in another state than the ship-to is accepted (non-blocking) and stored as given', async () => {
    const res = await place(body([{ skuId: sku.get('A-1')!, quantity: 1 }], { consigneeGstin: GSTIN, destination: testAddress({ state: 'Maharashtra', city: 'Pune', pincode: '411001' }) })).expect(201);
    const row = await sql`select consignee_gstin, destination_state from orders where id = ${res.body.orderId as string}`;
    expect(row[0]).toEqual({ consignee_gstin: GSTIN, destination_state: 'Maharashtra' });
  });

  // ── the fingerprints ──────────────────────────────────────────────────────

  describe('the fingerprints (goldens read from idempotency_keys)', () => {
    it('the portal hash: surface first, the session client, the warehouse, the destination, the GSTIN (null when absent), the legal name only when given, lines in base units — written out key by key', async () => {
      const plainKey = ulid();
      await place(body([{ skuId: sku.get('A-1')!, quantity: 2 }, { skuId: sku.get('A-KG')!, quantity: 0.25 }]), portalA.token, plainKey).expect(201);
      const namedKey = ulid();
      await place(body([{ skuId: sku.get('A-1')!, quantity: 1 }], { consigneeGstin: GSTIN, consigneeLegalName: '  Mysore Spices Pvt Ltd ' }), portalA.token, namedKey).expect(201);
      const blankKey = ulid();
      await place(body([{ skuId: sku.get('A-1')!, quantity: 1 }], { consigneeGstin: GSTIN, consigneeLegalName: '   ' }), portalA.token, blankKey).expect(201);
      const rows = await sql`select key, payload_hash from idempotency_keys where tenant_id = ${tenantId} and key in (${plainKey}, ${namedKey}, ${blankKey})`;
      const hashOf = new Map(rows.map((row) => [row.key as string, row.payload_hash as string]));
      const head = `{"surface":"portal","tenantId":"${tenantId}","clientId":"${clientA}","warehouseId":"${whMain}","destination":${DESTINATION_JSON}`;
      expect(hashOf.get(plainKey)).toBe(
        sha256(`${head},"consigneeGstin":null,"lines":[{"skuId":"${sku.get('A-1')!}","quantity":2},{"skuId":"${sku.get('A-KG')!}","quantity":0.25}]}`),
      );
      expect(hashOf.get(namedKey)).toBe(
        sha256(`${head},"consigneeGstin":"${GSTIN}","consigneeLegalName":"Mysore Spices Pvt Ltd","lines":[{"skuId":"${sku.get('A-1')!}","quantity":1}]}`),
      );
      // A blank name is ABSENT — no key at all.
      expect(hashOf.get(blankKey)).toBe(sha256(`${head},"consigneeGstin":"${GSTIN}","lines":[{"skuId":"${sku.get('A-1')!}","quantity":1}]}`));
    });

    it('the staff create hash and response are UNCHANGED by 4-1a (pinned golden)', async () => {
      const key = ulid();
      const res = await staffCreate(body([{ skuId: sku.get('A-1')!, quantity: 2 }]), key).expect(201);
      const rows = await sql`select payload_hash, response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
      expect(rows[0]!.payload_hash).toBe(
        sha256(
          `{"tenantId":"${tenantId}","warehouseId":"${whMain}","source":"manual","integrationId":null,"externalEventId":null,"destination":${DESTINATION_JSON},"consigneeGstin":null,"lines":[{"skuId":"${sku.get('A-1')!}","quantity":2}]}`,
        ),
      );
      expect(Object.keys(res.body)).toEqual(['order']);
      expect(Object.keys(res.body.order as Record<string, unknown>)).toEqual([
        'id',
        'tenantId',
        'warehouseId',
        'status',
        'source',
        'integrationId',
        'externalEventId',
        'destination',
        'clientId',
        'createdAt',
        'updatedAt',
        'lines',
      ]);
      expect((rows[0]!.response_snapshot as { order: { id: string } }).order.id).toBe(res.body.order.id);
    });
  });

  // ── authority, re-read in the command's own transactions ──────────────────

  describe('the command re-reads its actor and client (direct calls — the guard would refuse first over HTTP)', () => {
    it('an owner (holds orders.place through everything, but has no client) is 403 role-denied', async () => {
      expect(await refusal(app.get(OrderCommandService).placePortalOrder(command({ actorUserId: ownerUserId }), ulid()))).toEqual({
        status: 403,
        code: 'role-denied',
        detail: 'Only a client-portal user of this client may place its orders.',
      });
    });

    it('a BETA user placing for ACME is 403 role-denied; an ops manager (no orders.place) is 403 naming the capability', async () => {
      expect(await refusal(app.get(OrderCommandService).placePortalOrder(command({ actorUserId: portalB.userId }), ulid()))).toMatchObject({ status: 403, code: 'role-denied' });
      const email = `ops-${ulid().toLowerCase()}@example.com`;
      const invited = await invite({ email, role: 'ops_manager' }).expect(201);
      await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
      expect(await refusal(app.get(OrderCommandService).placePortalOrder(command({ actorUserId: invited.body.user.id as string }), ulid()))).toEqual({
        status: 403,
        code: 'role-denied',
        detail: 'Role "ops_manager" does not include the "orders.place" capability.',
      });
    });

    it('a suspended client is 403 client-suspended and a departed one 403 client-departed — nothing written', async () => {
      for (const [status, code] of [
        ['suspended', 'client-suspended'],
        ['departed', 'client-departed'],
      ] as const) {
        const before = await orderCount(clientA);
        await sql`update clients set status = ${status} where id = ${clientA}`;
        try {
          expect(await refusal(app.get(OrderCommandService).placePortalOrder(command(), ulid()))).toMatchObject({ status: 403, code });
        } finally {
          await sql`update clients set status = 'active' where id = ${clientA}`;
        }
        expect(await orderCount(clientA)).toBe(before);
      }
    });

    it('a client suspended BETWEEN the phases is refused 403 at phase 3 — no order, every grant released', async () => {
      const inventory = app.get(InventoryFacade);
      const original = inventory.grantReservation.bind(inventory);
      const before = { orders: await orderCount(clientA), holds: await liveHolds(sku.get('A-1')!) };
      const spy = jest.spyOn(inventory, 'grantReservation').mockImplementation(async (args) => {
        // Phase 1 has committed (its FOR SHARE is gone): the suspend lands now.
        await sql`update clients set status = 'suspended' where id = ${clientA}`;
        return original(args);
      });
      try {
        expect(await refusal(app.get(OrderCommandService).placePortalOrder(command(), ulid()))).toMatchObject({ status: 403, code: 'client-suspended' });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
        await sql`update clients set status = 'active' where id = ${clientA}`;
      }
      expect(await orderCount(clientA)).toBe(before.orders);
      expect(await liveHolds(sku.get('A-1')!)).toBe(before.holds);
      // The grant that moved was released, not left to its TTL.
      const released = await sql`select count(*)::int as n from reservations where tenant_id = ${tenantId} and sku_id = ${sku.get('A-1')!} and state = 'released'`;
      expect(released[0]!.n).toBeGreaterThanOrEqual(1);
    });

    it('a user deactivated BETWEEN the phases is 401 at phase 3 — no order, every grant released', async () => {
      const user = await portalUser(clientA);
      const inventory = app.get(InventoryFacade);
      const original = inventory.grantReservation.bind(inventory);
      const before = { orders: await orderCount(clientA), holds: await liveHolds(sku.get('A-1')!) };
      const spy = jest.spyOn(inventory, 'grantReservation').mockImplementation(async (args) => {
        await sql`update users set status = 'deactivated', status_before_deactivation = 'active' where id = ${user.userId}`;
        return original(args);
      });
      try {
        expect(await refusal(app.get(OrderCommandService).placePortalOrder(command({ actorUserId: user.userId }), ulid()))).toMatchObject({ status: 401, code: 'unauthenticated' });
      } finally {
        spy.mockRestore();
      }
      expect(await orderCount(clientA)).toBe(before.orders);
      expect(await liveHolds(sku.get('A-1')!)).toBe(before.holds);
    });

    it('a SKU deactivated BETWEEN the phases is refused 409 sku-inactive even though it reserved in full — the portal never sells down; grants released', async () => {
      const inventory = app.get(InventoryFacade);
      const original = inventory.grantReservation.bind(inventory);
      const before = { orders: await orderCount(clientA), holds: await liveHolds(sku.get('A-1')!) };
      const spy = jest.spyOn(inventory, 'grantReservation').mockImplementation(async (args) => {
        await sql`update skus set status = 'inactive' where id = ${sku.get('A-1')!}`;
        return original(args);
      });
      try {
        expect(await refusal(app.get(OrderCommandService).placePortalOrder(command(), ulid()))).toMatchObject({ status: 409, code: 'sku-inactive' });
      } finally {
        spy.mockRestore();
        await sql`update skus set status = 'active' where id = ${sku.get('A-1')!}`;
      }
      expect(await orderCount(clientA)).toBe(before.orders);
      expect(await liveHolds(sku.get('A-1')!)).toBe(before.holds);
    });

    it('the portal never reaches the channel arms: placeOrder refuses channel refs on the portal surface, and the dedup-loser resolution refuses a portal surface', async () => {
      const cmd = app.get(OrderCommandService) as unknown as {
        placeOrder: (...args: unknown[]) => Promise<unknown>;
        resolveDedupLoser: (...args: unknown[]) => Promise<unknown>;
      };
      await expect(
        cmd.placeOrder({ ...command(), source: 'ingested' }, ulid(), { integrationId: uuidv7(), externalEventId: 'evt', consigneeGstin: null, consigneeLegalName: null, sourcePayloadHash: null, payloadHash: 'x' }, { kind: 'portal' }),
      ).rejects.toThrow('a portal order carries no channel refs');
      await expect(cmd.resolveDedupLoser({ tenantId }, ulid(), 'x', { kind: 'portal' })).rejects.toThrow('a portal order has no channel dedup to lose');
    });

    it('meaningful: the same direct call for the ACME user commits', async () => {
      const res = await app.get(OrderCommandService).placePortalOrder(command(), ulid());
      expect(res).toMatchObject({ warehouseName: 'Main', lineCount: 1 });
    });
  });

  // ── the same-key race ─────────────────────────────────────────────────────

  it('a same-key race: both requests pass phase 1 before either commits — one 201, the loser 409 conflict, one order, the loser’s grant released', async () => {
    const inventory = app.get(InventoryFacade);
    const original = inventory.grantReservation.bind(inventory);
    let arrived = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const before = { orders: await orderCount(clientA), holds: await liveHolds(sku.get('A-1')!) };
    // A barrier at the grant: each request has passed its phase-1 replay
    // lookup when it arrives, so neither can replay the other's key.
    const spy = jest.spyOn(inventory, 'grantReservation').mockImplementation(async (args) => {
      arrived += 1;
      if (arrived === 2) openGate();
      await gate;
      return original(args);
    });
    const key = ulid();
    const payload = body([{ skuId: sku.get('A-1')!, quantity: 1 }]);
    let results: request.Response[];
    try {
      results = await Promise.all([place(payload, portalA.token, key), place(payload, portalA.token, key)]);
    } finally {
      spy.mockRestore();
    }
    expect(arrived).toBeGreaterThanOrEqual(2);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(results.find((res) => res.status === 409)!.body.code).toBe('conflict');
    expect(await orderCount(clientA)).toBe(before.orders + 1);
    expect(await liveHolds(sku.get('A-1')!)).toBe(before.holds + 1);
    // The settled answer: a retry replays the winner.
    const winner = results.find((res) => res.status === 201)!.body;
    expect((await place(payload, portalA.token, key).expect(201)).body).toEqual(winner);
  });

  // ── the fences ─────────────────────────────────────────────────────────────

  describe('the fences', () => {
    it('an operator token on POST portal/orders is 403 role-denied with the portal detail', async () => {
      const res = await place(body([{ skuId: sku.get('A-1')!, quantity: 1 }]), ownerToken).expect(403);
      expect(res.body).toMatchObject({ code: 'role-denied', detail: PORTAL_SURFACE_DETAIL });
    });

    it('a suspended client is refused at the guard (403 client-suspended)', async () => {
      await sql`update clients set status = 'suspended' where id = ${clientA}`;
      try {
        expect((await place(body([{ skuId: sku.get('A-1')!, quantity: 1 }])).expect(403)).body.code).toBe('client-suspended');
      } finally {
        await sql`update clients set status = 'active' where id = ${clientA}`;
      }
    });
  });

  it('the OpenAPI document declares POST portal/orders beside the list, with its refusal arms', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const paths = doc.body.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths['/tenants/{tenantId}/portal/orders']!).sort()).toEqual(['get', 'post']);
    const post = paths['/tenants/{tenantId}/portal/orders']!.post as { responses: Record<string, unknown> };
    expect(Object.keys(post.responses).sort()).toEqual(['201', '400', '401', '403', '404', '409', '422', '503']);
  });
});
