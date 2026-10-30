import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { AttachmentsFacade } from '../src/modules/attachments/attachments.facade';
import type { FileStore, FilePut, PresignGet, PresignedUrl } from '../src/modules/attachments/file-store';
import { cartonCode } from '../src/shared/primitives/carton-code';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { noOpIdempotencyKey } from './support/audit-guard';
import { mintSignIn } from './support/sign-in';
import { testAddress } from './support/shipment-address';
import { dispatchedOrderFixtures, type Picklist } from './support/dispatched-order';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { TenantTx } from '../src/shared/db/tenant-scope';
import { FreightDispatchCommand } from '../src/modules/outbound/freight-dispatch.command';
import { freightLoadsListQuery } from '../src/modules/outbound/freight.service';
import { freightLrSearchQuery } from '../src/modules/outbound/freight.read';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.CARRIER_ENCRYPTION_KEY ??= 'e2e-only-carrier-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.EMAIL_SEND_POLL_MS;
delete process.env.WEBHOOK_SEND_POLL_MS;
process.env.EMAIL_PROVIDER = 'log';
process.env.EMAIL_FROM = 'no-reply@mail.wms.test';
process.env.WEB_BASE_URL = 'https://app.wms.test/';
process.env.EMAIL_SEAL_KEY = 'e2e-only-email-seal-key-0123456789abcdef';
process.env.CLIENT_EMAIL_ENABLED = 'true';

jest.setTimeout(300_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

class MemoryFileStore implements FileStore {
  readonly mode = 'local' as const;
  readonly objects = new Map<string, Buffer>();
  async put(input: FilePut): Promise<void> {
    this.objects.set(input.key, Buffer.from(input.bytes));
  }
  async presignGet(input: PresignGet): Promise<PresignedUrl> {
    return { url: `https://files.example/${input.key}`, expiresAt: new Date(Date.now() + 300_000).toISOString() };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async get(key: string): Promise<Uint8Array> {
    return this.objects.get(key)!;
  }
}

/**
 * Story 4-9a — B2B freight dispatch, end to end: a load for two brands
 * created with its orders, loaded package by package on the web and the
 * handheld, departed (web all-or-nothing; the handheld settling partially
 * with its review row), its LR and proof of delivery, the prints, the portal
 * truck block and freight note (and their isolation), the guards on the
 * other exits of a planned order, the cancels, the pallet package type, the
 * load-full bound, the literal goldens of the new hashes, and every new audit
 * action.
 */
describe('B2B freight dispatch — races, lock order, plans and the 100-order bound (e2e, story 4-9a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsId: string;
  let operatorToken: string;
  let deviceToken: string;
  let warehouseId: string;
  let binId: string;
  let acme: string;
  let beta: string;
  let transporterId: string;
  const sku = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('freightraces');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    app.get(AttachmentsFacade).fileStore = new MemoryFileStore();

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Truck Co ${ulid()}`, ownerEmail, password: PASSWORD }).expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email: ownerEmail, password: PASSWORD })).body.accessToken as string;
    const ops = await member('ops_manager');
    opsToken = ops.token;
    opsId = ops.userId;
    const floor = await member('operator');

    warehouseId = (
      await http().post(`${API}/${tenantId}/warehouses`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `WH-${ulid().slice(20)}`, name: 'Main' }).expect(201)
    ).body.id as string;
    const zone = (
      await http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' }).expect(201)
    ).body.id as string;
    binId = (
      await http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone}/bins`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ capacity: 10000000, type: 'shelf', code: 'A-01-01' }).expect(201)
    ).body.id as string;

    acme = await createClient('ACME', 'ACME Brand');
    beta = await createClient('BETA', 'Beta Brand');
    await importCsv(['A-TEE,Acme tee,pcs,1800,,false,false', 'A-2,Acme two,pcs,1800,,false,false', 'A-3,Acme three,pcs,1800,,false,false', 'A-LOT,Acme lot,pcs,1800,,true,false'], acme);
    await importCsv(['B-TEE,Beta tee,pcs,1800,,false,false'], beta);
    const listed = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of listed.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    for (const code of ['A-TEE', 'B-TEE', 'A-2', 'A-3']) {
      await http().post(`${API}/${tenantId}/inventory/adjustments`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: sku.get(code), binId, quantityDelta: 100000, reasonCode: 'stock-count', note: 'seed' }).expect(201);
    }
    await http().post(`${API}/${tenantId}/inventory/adjustments`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: sku.get('A-LOT'), binId, quantityDelta: 1000, reasonCode: 'stock-count', note: 'seed', batch: { code: 'LOT-R1' } }).expect(201);
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'Dock scanner', pin: '2468' }).expect(201);
    deviceToken = enrolled.body.deviceToken as string;
    operatorToken = (
      await http().post(`${API}/${tenantId}/devices/badge-in`).set('Authorization', `Bearer ${deviceToken}`).send({ operatorEmail: floor.email, pin: '2468' }).expect(200)
    ).body.accessToken as string;

    transporterId = (
      await http().post(`${API}/${tenantId}/partners`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ code: 'VRL', name: 'VRL Logistics', roles: ['transporter'] }).expect(201)
    ).body.partner.id as string;
  });

  afterAll(async () => {
    try {
      await sql?.end();
      const main = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
      await main.$client?.end();
      const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
      await authDb.$client?.end();
      await app.close();
    } finally {
      await suiteDb.drop();
    }
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function member(role: string): Promise<{ token: string; email: string; userId: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { token: (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string, email, userId: invited.body.user.id as string };
  }



  async function createClient(code: string, name: string): Promise<string> {
    return (await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name }).expect(201)).body.client.id as string;
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked', ...rows].join('\n');
    await http().post(`${API}/${tenantId}/catalog/imports`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
      .field('mode', 'initial').field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' }).expect(201);
  }

  function scannedOf(picklist: Picklist): { skuId: string; qty: number }[] {
    const by = new Map<string, number>();
    for (const line of picklist.lines) by.set(line.skuId, (by.get(line.skuId) ?? 0) + line.qty);
    return [...by.entries()].map(([skuId, qty]) => ({ skuId, qty }));
  }



  /** A PACKED order of `packages` packages (one unit each), the first `pallets` of them pallets (STC 40 each). */
  async function packedOrder(code = 'A-TEE', packages = 1, pallets = 0): Promise<string> {
    const ready = await fixtures.releasedWave([{ skuId: sku.get(code)!, quantity: packages }], { clientOrderRef: `SO-${ulid().slice(18)}` });
    await fixtures.pickAllLines(ready.picklist);
    const skuId = sku.get(code)!;
    const body =
      packages === 1 && pallets === 0
        ? { scanned: scannedOf(ready.picklist), weightGrams: 900 }
        : {
            scanned: scannedOf(ready.picklist),
            cartons: Array.from({ length: packages }, (_, i) =>
              i < pallets ? { scanned: [{ skuId, qty: 1 }], weightGrams: 400_000, type: 'pallet', innerCount: 40 } : { scanned: [{ skuId, qty: 1 }], weightGrams: 5_000 },
            ),
          };
    await http().post(`${API}/${tenantId}/outbound/orders/${ready.orderId}/pack`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send(body).expect(201);
    return ready.orderId;
  }

  function createLoad(body: Record<string, unknown>, key = ulid(), token = opsToken) {
    return http().post(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/freight-loads`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key)
      .send({ mode: 'ltl', transporter: { transporterId }, dockDoor: 'd-3', ...body });
  }

  function post(path: string, body: Record<string, unknown>, key = ulid(), token = opsToken) {
    return http().post(`${API}/${tenantId}/outbound/${path}`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function scan(loadId: string, packageCode: string, key = ulid(), extra: Record<string, unknown> = {}, token = opsToken) {
    return post(`freight-loads/${loadId}/scans`, { packageCode, action: 'load', ...extra }, key, token);
  }



  function depart(loadId: string, consignments: Record<string, unknown>[], extra: Record<string, unknown> = {}, key = ulid(), token = opsToken) {
    return post(`freight-loads/${loadId}/dispatch`, { vehicleNumber: 'ka 01 ab 1234', driverName: 'Ravi', seals: ['s-991'], consignments, ...extra }, key, token);
  }



  async function orderStatus(orderId: string): Promise<string> {
    return (await sql`select status from orders where id = ${orderId}`)[0]!.status as string;
  }

  async function consignmentOf(orderId: string): Promise<Record<string, unknown>> {
    return (await sql`select * from freight_consignments where order_id = ${orderId} order by created_at desc limit 1`)[0] as Record<string, unknown>;
  }


  // ── the parked-waiter harness (guide §1; the 4-4a / 4-6a precedent) ───────

  async function waitParked(holderPid: number, min: number): Promise<void> {
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active' and a.datname = current_database()
        `) as unknown as { pid: number; blockers: number[] }[];
        const chain = new Set<number>([holderPid]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const row of waiting) {
            if (!chain.has(row.pid) && row.blockers.some((pid) => chain.has(pid))) {
              chain.add(row.pid);
              grew = true;
            }
          }
        }
        if (chain.size - 1 >= min) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`fewer than ${min} request(s) parked on the held row`);
    } finally {
      await probe.end();
    }
  }

  /** Holds one row `FOR UPDATE` (the table and id given) while `sends` park on it, then releases. */
  async function raceOn(table: 'orders' | 'freight_loads', id: string, sends: (() => request.Test)[], parked = sends.length): Promise<request.Response[]> {
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    const pending: Promise<request.Response>[] = [];
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx.unsafe(`select pg_backend_pid() as pid from ${table} where tenant_id = $1 and id = $2 for update`, [tenantId, id])) as unknown as { pid: number }[];
        for (const send of sends) pending.push((async () => send())());
        await waitParked(locked[0]!.pid, parked);
      });
      return await Promise.all(pending);
    } finally {
      await Promise.allSettled(pending);
      await holder.end();
    }
  }

  async function keyRows(key: string): Promise<{ keys: number; audits: number }> {
    const keys = (await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.n as number;
    const audits = (await sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${key}`)[0]!.n as number;
    return { keys, audits };
  }

  // ── 1. same-key races ─────────────────────────────────────────────────────

  it('same-key race — createFreightLoad: two creates parked on the order lock answer the same 201 body; one load, one key, one audit pair (the replay under the locks)', async () => {
    const order = await packedOrder('A-TEE', 1);
    const key = ulid();
    const send = () => createLoad({ orderIds: [order] }, key);
    const [a, b] = await raceOn('orders', order, [send, send]);
    expect([a!.status, b!.status]).toEqual([201, 201]);
    expect(a!.body).toEqual(b!.body);
    expect(await sql`select count(*)::int as n from freight_consignments where order_id = ${order}`).toEqual([{ n: 1 }]);
    expect(await keyRows(key)).toEqual({ keys: 1, audits: 2 });
  });

  it('same-key race — recordFreightScan: two scans parked on the load answer the same body; one loaded row, one key, one audit row', async () => {
    const order = await packedOrder('A-TEE', 1);
    const load = (await createLoad({ orderIds: [order] }).expect(201)).body.load;
    const key = ulid();
    const send = () => scan(load.id, cartonCode(order, 1, 1), key);
    const [a, b] = await raceOn('freight_loads', load.id, [send, send]);
    expect([a!.status, b!.status]).toEqual([201, 201]);
    expect(a!.body).toEqual(b!.body);
    expect(a!.body.alreadyLoaded).toBe(false);
    expect(await sql`select count(*)::int as n from freight_load_scans where order_id = ${order} and status = 'loaded'`).toEqual([{ n: 1 }]);
    expect(await keyRows(key)).toEqual({ keys: 1, audits: 1 });
  });

  it('two devices, two keys, one package: parked on the load, one scan loads it and the other answers the alreadyLoaded no-op; one loaded row', async () => {
    const order = await packedOrder('A-TEE', 1);
    const load = (await createLoad({ orderIds: [order] }).expect(201)).body.load;
    const keys = [ulid(), ulid()];
    const at = new Date().toISOString();
    const [a, b] = await raceOn('freight_loads', load.id, keys.map((key) => () => scan(load.id, cartonCode(order, 1, 1), key, { occurredAt: at, warehouseId }, operatorToken)));
    // The I/O matrix: the scan that loads answers 201, the no-op 200.
    expect([a!, b!].map((r) => [r.body.alreadyLoaded, r.status]).sort()).toEqual([[false, 201], [true, 200]]);
    noOpIdempotencyKey(tenantId, a!.body.alreadyLoaded ? keys[0]! : keys[1]!, 'freight.scan:already-loaded');
    expect(await sql`select count(*)::int as n from freight_load_scans where order_id = ${order} and status = 'loaded'`).toEqual([{ n: 1 }]);
  });

  it('same-key race — dispatchFreightLoad: two departures parked on the load answer the same 201 body; the order dispatched once, one key', async () => {
    const order = await packedOrder('A-TEE', 1);
    const load = (await createLoad({ orderIds: [order] }).expect(201)).body.load;
    await scan(load.id, cartonCode(order, 1, 1)).expect(201);
    const key = ulid();
    const send = () => depart(load.id, [{ orderId: order, decision: 'dispatch', lrNumber: 'RACE1' }], {}, key);
    const [a, b] = await raceOn('freight_loads', load.id, [send, send]);
    expect([a!.status, b!.status]).toEqual([201, 201]);
    expect(a!.body).toEqual(b!.body);
    expect(await sql`select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and type = 'dispatch.dispatched' and reference_doc->>'orderId' = ${order}`).toEqual([{ n: 1 }]);
    expect((await keyRows(key)).keys).toBe(1);
  });

  it('same-key race — recordFreightDelivery: two records parked on the order answer the same 200 body; delivery_seq 1, one outbox row, one audit row', async () => {
    const order = await packedOrder('A-TEE', 1);
    const load = (await createLoad({ orderIds: [order] }).expect(201)).body.load;
    await scan(load.id, cartonCode(order, 1, 1)).expect(201);
    await depart(load.id, [{ orderId: order, decision: 'dispatch' }]).expect(201);
    const consignmentId = (await consignmentOf(order)).id as string;
    const key = ulid();
    const body = { outcome: 'delivered', deliveredAt: new Date().toISOString(), receiverName: 'A. Kumar' };
    const send = () => post(`freight-consignments/${consignmentId}/delivery`, body, key);
    const [a, b] = await raceOn('orders', order, [send, send]);
    expect([a!.status, b!.status]).toEqual([200, 200]);
    expect(a!.body).toEqual(b!.body);
    expect((await consignmentOf(order)).delivery_seq).toBe(1);
    expect(await sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'freight_consignment.delivered' and payload->>'orderId' = ${order}`).toEqual([{ n: 1 }]);
    expect(await keyRows(key)).toEqual({ keys: 1, audits: 1 });
  });

  // ── 2. the departure's lock order against the order's other writers ──────

  /** Every outcome is a deliberate answer: never a 500, never a deadlock (40P01 surfaces as a 500). */
  function settled(responses: request.Response[]): void {
    for (const res of responses) {
      expect(res.status).toBeLessThan(500);
      expect(JSON.stringify(res.body)).not.toMatch(/deadlock/i);
    }
  }

  it('lock order — a departure racing a cancel-with-restock of a member order (both orders of the race, each parked behind the other): no deadlock; the order ends dispatched XOR cancelled, its consignment agreeing', async () => {
    for (const first of ['depart', 'cancel'] as const) {
      const order = await packedOrder('A-TEE', 1);
      const other = await packedOrder('A-TEE', 1);
      const load = (await createLoad({ orderIds: [order, other] }).expect(201)).body.load;
      await scan(load.id, cartonCode(order, 1, 1)).expect(201);
      await scan(load.id, cartonCode(other, 1, 1)).expect(201);
      const departSend = () => depart(load.id, [{ orderId: order, decision: 'dispatch' }, { orderId: other, decision: 'dispatch' }]);
      const cancelSend = () => http().post(`${API}/${tenantId}/outbound/orders/${order}/cancel-with-restock`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({});
      // Hold the ORDER: both writers take it (the departure after its load lock), so both park; release and let them race.
      const responses = await raceOn('orders', order, first === 'depart' ? [departSend, cancelSend] : [cancelSend, departSend]);
      settled(responses);
      const status = await orderStatus(order);
      const consignment = await consignmentOf(order);
      if (status === 'dispatched') {
        expect(consignment.status).toBe('dispatched');
      } else {
        expect(status).toBe('cancelled');
        expect(consignment).toMatchObject({ status: 'removed', remove_reason: 'Order cancelled' });
        expect(await sql`select count(*)::int as n from freight_load_scans where order_id = ${order} and status = 'loaded'`).toEqual([{ n: 0 }]);
      }
    }
  });

  it('lock order — a departure racing a re-carton of a member order: no deadlock; either the order left on the old pack, or the re-carton won and the departure refused it (its scans now stale)', async () => {
    const order = await packedOrder('A-TEE', 2);
    const load = (await createLoad({ orderIds: [order] }).expect(201)).body.load;
    await scan(load.id, cartonCode(order, 1, 1)).expect(201);
    await scan(load.id, cartonCode(order, 1, 2)).expect(201);
    const skuId = sku.get('A-TEE')!;
    const recarton = () =>
      http().post(`${API}/${tenantId}/outbound/orders/${order}/cartons`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
        .send({ reason: 'One carton', cartons: [{ scanned: [{ skuId, qty: 2 }], weightGrams: 10_000 }] });
    const departSend = () => depart(load.id, [{ orderId: order, decision: 'dispatch' }]);
    const responses = await raceOn('orders', order, [departSend, recarton]);
    settled(responses);
    const [departed, recartoned] = responses;
    if (departed!.status === 201) {
      expect(await orderStatus(order)).toBe('dispatched');
      expect([200, 201, 409]).toContain(recartoned!.status);
    } else {
      expect(departed!.body).toMatchObject({ code: 'freight-orders-refused', orders: [{ orderId: order, code: 'packages-not-loaded' }] });
      expect([200, 201]).toContain(recartoned!.status);
    }
  });

  it('lock order — a departure racing a recall opening on a picked lot: no deadlock; the recall committed first refuses the order (order-holds-recalled-batch), else the order left and the recall traces it', async () => {
    const lotSku = sku.get('A-LOT')!;
    const batchId = (await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${lotSku} and code = 'LOT-R1'`)[0]!.id as string;
    for (const first of ['depart', 'recall'] as const) {
      const order = await packedOrder('A-LOT', 1);
      const load = (await createLoad({ orderIds: [order] }).expect(201)).body.load;
      await scan(load.id, cartonCode(order, 1, 1)).expect(201);
      const departSend = () => depart(load.id, [{ orderId: order, decision: 'dispatch' }]);
      const recallSend = () => http().post(`${API}/${tenantId}/inventory/recalls`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ batchIds: [batchId], reasonNote: 'Race recall' });
      const responses = await Promise.all(first === 'depart' ? [departSend(), recallSend()] : [recallSend(), departSend()]);
      settled(responses);
      const departed = responses[first === 'depart' ? 0 : 1]!;
      if (departed.status === 201) {
        expect(await orderStatus(order)).toBe('dispatched');
      } else {
        expect(departed.body).toMatchObject({ code: 'freight-orders-refused', orders: [{ orderId: order, code: 'order-holds-recalled-batch' }] });
        expect(await orderStatus(order)).toBe('ready_to_dispatch');
      }
      // Close any recall the race opened so the next round starts clean.
      for (const row of (await sql`select id from batch_recalls where tenant_id = ${tenantId} and status = 'open'`) as unknown as { id: string }[]) {
        await http().post(`${API}/${tenantId}/inventory/recalls/${row.id}/close`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
          .send({ releaseBatchIds: [batchId], note: 'Race done', acknowledgeUnaccounted: true, overrideReason: 'Test lot, not a real recall' })
          .expect((res) => {
            if (res.status >= 300) throw new Error(`recall close ${res.status}: ${JSON.stringify(res.body)}`);
          });
      }
    }
  });

  it('lock order — a departure racing a per-order dispatch of a member order: no deadlock; the order leaves once, with the truck (the per-order dispatch answers dispatch-via-freight or already-dispatched)', async () => {
    const order = await packedOrder('A-TEE', 1);
    const load = (await createLoad({ orderIds: [order] }).expect(201)).body.load;
    await scan(load.id, cartonCode(order, 1, 1)).expect(201);
    const departSend = () => depart(load.id, [{ orderId: order, decision: 'dispatch' }]);
    const dispatchSend = () => http().post(`${API}/${tenantId}/outbound/orders/${order}/dispatch`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({});
    const [departed, single] = await raceOn('orders', order, [departSend, dispatchSend]);
    settled([departed!, single!]);
    expect(departed!.status).toBe(201);
    expect(single!.status).toBe(409);
    expect(['dispatch-via-freight', 'conflict', 'order-already-dispatched']).toContain(single!.body.code);
    expect(await sql`select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and type = 'dispatch.dispatched' and reference_doc->>'orderId' = ${order}`).toEqual([{ n: 1 }]);
  });

  // ── 3. the 100-order bound (A37) and the linear statement count (A58) ─────

  /** `count` packed orders of three lines each (A-TEE, A-2, A-3), one wave. */
  async function packedThreeLineOrders(count: number): Promise<string[]> {
    const skus = ['A-TEE', 'A-2', 'A-3'].map((code) => sku.get(code)!);
    const orderIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      orderIds.push(await fixtures.createOrder(skus.map((skuId) => ({ skuId, quantity: 1 })), undefined, { clientOrderRef: `BULK-${ulid().slice(16)}` }));
    }
    const policyId = (
      await http().post(`${API}/${tenantId}/outbound/wave-policies`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
        .send({ warehouseId, name: `bulk-${ulid().slice(10, 18)}`, grouping: 'single' }).expect(201)
    ).body.policy.id as string;
    const waveId = (
      await http().post(`${API}/${tenantId}/outbound/waves`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ warehouseId, policyId, orderIds }).expect(201)
    ).body.wave.id as string;
    await http().post(`${API}/${tenantId}/outbound/waves/${waveId}/release`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
    const wave = (await http().get(`${API}/${tenantId}/outbound/waves/${waveId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.wave as { picklists: Picklist[] };
    for (const picklist of wave.picklists) await fixtures.pickAllLines(picklist);
    for (const picklist of wave.picklists) {
      const orderId = (picklist as unknown as { orderIds?: string[]; orderId?: string }).orderIds?.[0] ?? (picklist as unknown as { orderId: string }).orderId;
      await http().post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
        .send({ scanned: scannedOf(picklist), weightGrams: 900 }).expect(201);
    }
    return orderIds;
  }

  /** The departure's statements, counted on a connection of its own (the 2-9a precedent). */
  async function countedDeparture(orderIds: string[]): Promise<{ statements: number; ms: number }> {
    const load = (await createLoad({ orderIds }).expect(201)).body.load;
    let statements = 0;
    let counting = false;
    const client = postgres(process.env.DATABASE_URL!, {
      max: 1,
      onnotice: () => undefined,
      debug: () => {
        if (counting) statements += 1;
      },
    });
    const command = app.get(FreightDispatchCommand) as unknown as { db: unknown };
    const original = command.db;
    try {
      command.db = drizzle(client);
      counting = true;
      const started = Date.now();
      await depart(load.id, orderIds.map((orderId) => ({ orderId, decision: 'dispatch', unscannedAcknowledged: true }))).expect(201);
      const ms = Date.now() - started;
      counting = false;
      return { statements, ms };
    } finally {
      command.db = original;
      await client.end();
    }
  }

  it('A58 — the departure’s statement count is linear in its orders (1, 2, 4 orders of three lines: equal increments per order)', async () => {
    const one = await countedDeparture(await packedThreeLineOrders(1));
    const two = await countedDeparture(await packedThreeLineOrders(2));
    const four = await countedDeparture(await packedThreeLineOrders(4));
    const perOrder = two.statements - one.statements;
    expect(perOrder).toBeGreaterThan(0);
    expect(four.statements - two.statements).toBe(2 * perOrder);
  });

  it('A37 — a 100-order × 3-line departure commits (timing logged; asserted under 5 s only with PERF_ASSERT=1)', async () => {
    const orders = await packedThreeLineOrders(100);
    const { statements, ms } = await countedDeparture(orders);
    // eslint-disable-next-line no-console
    console.log(`A37: a 100-order × 3-line freight departure committed in ${ms} ms over ${statements} statements`);
    expect(await sql`select count(*)::int as n from orders where id = any(${orders}) and status = 'dispatched'`).toEqual([{ n: 100 }]);
    if (process.env.PERF_ASSERT === '1') expect(ms).toBeLessThan(5_000);
  }, 900_000);

  // ── 4. the plans (A60) ────────────────────────────────────────────────────

  it('A60 — EXPLAIN after ANALYZE: the client filter rides freight_consignments_client_live_idx, POD pending freight_consignments_pod_pending_idx, delivery exceptions freight_consignments_delivery_exceptions_idx, the LR search freight_consignments_lr_idx, the open set a freight_loads index; never a Seq Scan on freight_consignments', async () => {
    const wh = uuidv7();
    const client = uuidv7();
    // 4,000 loads of a fake warehouse (mostly dispatched) with 40,000 consignments of several clients.
    await sql`
      insert into freight_loads (id, tenant_id, warehouse_id, code, status, mode, transporter_name, created_by, created_at, dispatched_at, dispatched_by, dispatch_source,
        vehicle_number, driver_name, warehouse_snapshot, dispatched_order_count, package_count)
      select gen_random_uuid(), ${tenantId}, ${wh}, 'LD-' || lpad((900000 + g)::text, 7, '0'), case when g % 20 = 0 then 'open' else 'dispatched' end, 'ltl', 'VRL', ${opsId},
        now() - (g || ' minutes')::interval,
        case when g % 20 = 0 then null else now() - (g || ' minutes')::interval end,
        case when g % 20 = 0 then null else ${opsId}::uuid end,
        case when g % 20 = 0 then null else 'web' end,
        case when g % 20 = 0 then null else 'KA01AB1234' end,
        case when g % 20 = 0 then null else 'Ravi' end,
        case when g % 20 = 0 then null else '{"v":1}'::jsonb end,
        case when g % 20 = 0 then null else 10 end,
        case when g % 20 = 0 then null else 10 end
      from generate_series(1, 4000) g`;
    await sql`
      insert into freight_consignments (id, tenant_id, warehouse_id, load_id, order_id, client_id, status, stop_seq, added_by, dispatched_at, package_count, loaded_package_count,
        client_snapshot, carriage_snapshot, lr_number, lr_recorded_at, lr_recorded_by, delivery_outcome, delivered_at, delivery_seq, delivery_recorded_at, delivery_recorded_by, delivery_note)
      select gen_random_uuid(), ${tenantId}, ${wh}, l.id, gen_random_uuid(),
        case when s.n = 1 then ${client}::uuid else gen_random_uuid() end,
        case when l.status = 'open' then 'planned' else 'dispatched' end, s.n, ${opsId},
        case when l.status = 'open' then null else l.dispatched_at end,
        case when l.status = 'open' then null else 1 end,
        case when l.status = 'open' then null else 1 end,
        case when l.status = 'open' then null else '{"v":1}'::jsonb end,
        case when l.status = 'open' then null else '{"v":1}'::jsonb end,
        'LRX' || substr(l.code, 4) || s.n, now(), ${opsId},
        case when l.status = 'open' or s.n > 9 then null when s.n = 9 then 'refused' else 'delivered' end,
        case when l.status = 'open' or s.n > 9 then null else now() end,
        case when l.status = 'open' or s.n > 9 then 0 else 1 end,
        case when l.status = 'open' or s.n > 9 then null else now() end,
        case when l.status = 'open' or s.n > 9 then null else ${opsId}::uuid end,
        case when l.status = 'open' or s.n <> 9 then null else 'wrong item' end
      from freight_loads l, generate_series(1, 10) s(n) where l.tenant_id = ${tenantId} and l.warehouse_id = ${wh}`;
    await sql`analyze freight_loads`;
    await sql`analyze freight_consignments`;
    await sql`analyze orders`;
    const db = app.get<unknown>(DATABASE) as unknown as TenantTx;
    const plan = async (query: { toSQL(): { sql: string; params: unknown[] } }) => {
      const { sql: text, params } = query.toSQL();
      return (await sql.unsafe(`explain ${text}`, params as never[])).map((row) => Object.values(row)[0]).join('\n');
    };
    const byClient = await plan(freightLoadsListQuery(db, tenantId, wh, { view: 'dispatched', clientId: client }, 51));
    expect(byClient).toContain('freight_consignments_client_live_idx');
    const pod = await plan(freightLoadsListQuery(db, tenantId, wh, { view: 'pod-pending' }, 51));
    expect(pod).toContain('freight_consignments_pod_pending_idx');
    const exceptions = await plan(freightLoadsListQuery(db, tenantId, wh, { view: 'delivery-exceptions' }, 51));
    expect(exceptions).toContain('freight_consignments_delivery_exceptions_idx');
    const open = await plan(freightLoadsListQuery(db, tenantId, wh, { view: 'open' }, 51));
    expect(open).toMatch(/freight_loads_open_idx|freight_loads_tenant_warehouse_created_idx/);
    expect(open).not.toMatch(/Seq Scan on freight_loads/);
    const lr = await plan(freightLrSearchQuery(db, tenantId, client, wh, 'lrx-0900020 1'));
    expect(lr).toContain('freight_consignments_lr_idx');
    for (const text of [byClient, pod, exceptions, open, lr]) expect(text).not.toMatch(/Seq Scan on freight_consignments/);
  });
});
