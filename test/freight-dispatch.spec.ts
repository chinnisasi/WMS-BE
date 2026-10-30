import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { AttachmentsFacade } from '../src/modules/attachments/attachments.facade';
import type { FileStore, FilePut, PresignGet, PresignedUrl } from '../src/modules/attachments/file-store';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { REJECTED_OP_DECISIONS_BY_TYPE } from '../src/modules/tenancy/sync-report.command';
import { parcelTagCode } from '../src/shared/primitives/parcel-tag';
import { cartonCode } from '../src/shared/primitives/carton-code';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { mintSignIn } from './support/sign-in';
import { testAddress } from './support/shipment-address';
import { dispatchedOrderFixtures, type Picklist } from './support/dispatched-order';
import { pdfText } from './support/pdf-text';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { removeFromFreightOnCancelInTx } from '../src/modules/outbound/freight-support';

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
const JPEG = readFileSync(join(__dirname, 'fixtures', 'images', 'baseline.jpg'));

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
describe('B2B freight dispatch (e2e, story 4-9a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let relay: OutboxRelay;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsId: string;
  let floorWebToken: string;
  let operatorToken: string;
  let operatorId: string;
  let deviceToken: string;
  let warehouseId: string;
  let binId: string;
  let acme: string;
  let beta: string;
  let acmePortal: string;
  let betaPortal: string;
  let transporterId: string;
  const sku = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('freightdispatch');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    app.get(AttachmentsFacade).fileStore = new MemoryFileStore();

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Truck Co ${ulid()}`, ownerEmail, password: PASSWORD }).expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email: ownerEmail, password: PASSWORD })).body.accessToken as string;
    const ops = await member('ops_manager');
    opsToken = ops.token;
    opsId = ops.userId;
    const floor = await member('operator');
    floorWebToken = floor.token;
    operatorId = floor.userId;

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
    await importCsv(['A-TEE,Acme tee,pcs,1800,,false,false'], acme);
    await importCsv(['B-TEE,Beta tee,pcs,1800,,false,false'], beta);
    const listed = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of listed.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    for (const code of ['A-TEE', 'B-TEE']) {
      await http().post(`${API}/${tenantId}/inventory/adjustments`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: sku.get(code), binId, quantityDelta: 100000, reasonCode: 'stock-count', note: 'seed' }).expect(201);
    }
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'Dock scanner', pin: '2468' }).expect(201);
    deviceToken = enrolled.body.deviceToken as string;
    operatorToken = (
      await http().post(`${API}/${tenantId}/devices/badge-in`).set('Authorization', `Bearer ${deviceToken}`).send({ operatorEmail: floor.email, pin: '2468' }).expect(200)
    ).body.accessToken as string;

    acmePortal = await portalUser(acme);
    betaPortal = await portalUser(beta);
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

  async function portalUser(clientId: string): Promise<string> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role: 'client', clientId }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
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

  /** An ACCEPTED order (not yet waved). */
  async function acceptedOrder(code = 'A-TEE'): Promise<string> {
    return fixtures.createOrder([{ skuId: sku.get(code)!, quantity: 1 }], undefined, { clientOrderRef: `SO-${ulid().slice(18)}` });
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

  function deviceScan(loadId: string, packageCode: string, occurredAt = new Date().toISOString(), key = ulid()) {
    return scan(loadId, packageCode, key, { occurredAt, warehouseId }, operatorToken);
  }

  function depart(loadId: string, consignments: Record<string, unknown>[], extra: Record<string, unknown> = {}, key = ulid(), token = opsToken) {
    return post(`freight-loads/${loadId}/dispatch`, { vehicleNumber: 'ka 01 ab 1234', driverName: 'Ravi', seals: ['s-991'], consignments, ...extra }, key, token);
  }

  async function storedHash(key: string): Promise<string> {
    return (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.payload_hash as string;
  }

  async function orderStatus(orderId: string): Promise<string> {
    return (await sql`select status from orders where id = ${orderId}`)[0]!.status as string;
  }

  async function consignmentOf(orderId: string): Promise<Record<string, unknown>> {
    return (await sql`select * from freight_consignments where order_id = ${orderId} order by created_at desc limit 1`)[0] as Record<string, unknown>;
  }

  const drain = async () => {
    await sql`update outbox_messages set next_attempt_at = now() where tenant_id = ${tenantId} and status = 'pending' and next_attempt_at > now()`;
    return relay.drain(500);
  };

  // ── AC1: an LTL truck for two brands ──────────────────────────────────────

  it('AC1 — create with two brands’ orders, load on the web and the handheld, depart, the ledger carries the transporter and the LR; the sheet, the note, the portal truck block; replays; the goldens', async () => {
    const so1 = await packedOrder('A-TEE', 3, 2);
    const so3 = await packedOrder('B-TEE', 1);
    const createKey = ulid();
    const created = await createLoad({ orderIds: [so3, so1], vehicleType: 'hcv', vehicleCapacityKg: 20000, note: '  Back gate  ' }, createKey).expect(201);
    const load = created.body.load;
    expect(load).toMatchObject({ status: 'open', mode: 'ltl', dockDoor: 'D-3', transporter: { partnerId: transporterId, name: 'VRL Logistics' }, note: 'Back gate' });
    expect(load.code).toMatch(/^LD-\d{4,}$/);
    expect(load.consignments.map((c: { orderId: string; stopSeq: number; status: string }) => [c.orderId, c.stopSeq, c.status])).toEqual([
      [so3, 1, 'planned'],
      [so1, 2, 'planned'],
    ]);
    expect(load.consignments[1].packages).toMatchObject({ total: 3, pallets: 2, loaded: 0, packed: true });
    await expectAuditRow({
      tenantId,
      key: createKey,
      action: 'freight_load.created',
      targetType: 'freight_load',
      targetId: load.id,
      actorUserId: opsId,
      alongside: [{ action: 'freight_load.orders_added', targetType: 'freight_load', targetId: load.id, actorUserId: opsId }],
    });
    // D20 — the create's literal golden.
    expect(await storedHash(createKey)).toBe(
      hashCommandPayload({
        arm: 'freight-load-create',
        tenantId,
        warehouseId,
        mode: 'ltl',
        transporterId,
        transporterName: null,
        vehicleType: 'hcv',
        vehicleNumber: null,
        containerNumber: null,
        vehicleCapacityKg: 20000,
        driverName: null,
        driverPhone: null,
        driverLicenceNumber: null,
        dockDoor: 'D-3',
        vehicleReportedAt: null,
        note: 'Back gate',
        orderIds: [so3, so1].sort(),
      }),
    );
    const replay = await createLoad({ orderIds: [so1, so3], vehicleType: 'hcv', vehicleCapacityKg: 20000, note: 'Back gate' }, createKey).expect(201);
    expect(replay.body.load.id).toBe(load.id);

    // Loading: the web scans so1's three packages; the handheld scans so3's parcel tag (one package).
    const webKey = ulid();
    const first = await scan(load.id, cartonCode(so1, 1, 1).toLowerCase(), webKey).expect(201);
    expect(first.body).toEqual({ scan: { packageCode: cartonCode(so1, 1, 1), orderId: so1, status: 'loaded' }, alreadyLoaded: false, progress: { consignmentId: load.consignments[1].id, loaded: 1, total: 3 } });
    await expectAuditRow({ tenantId, key: webKey, action: 'freight_load.package_loaded', targetType: 'freight_load', targetId: load.id, actorUserId: opsId });
    expect(await storedHash(webKey)).toBe(
      hashCommandPayload({ arm: 'freight-scan', surface: 'web', tenantId, loadId: load.id, warehouseId: null, packageCode: cartonCode(so1, 1, 1), action: 'load', occurredAt: null, reason: null }),
    );
    await scan(load.id, cartonCode(so1, 1, 2)).expect(201);
    await scan(load.id, cartonCode(so1, 1, 3)).expect(201);
    const deviceKey = ulid();
    const scannedAt = new Date(Date.now() - 60_000).toISOString();
    const device = await deviceScan(load.id, parcelTagCode(so3), scannedAt, deviceKey).expect(201);
    expect(device.body.scan).toEqual({ packageCode: cartonCode(so3, 1, 1), orderId: so3, status: 'loaded' });
    expect(await storedHash(deviceKey)).toBe(
      hashCommandPayload({ arm: 'freight-scan', surface: 'device', tenantId, loadId: load.id, warehouseId, packageCode: parcelTagCode(so3), action: 'load', occurredAt: scannedAt, reason: null }),
    );
    // A second device scanning the same package: one row, the no-op stores the key.
    const twice = noOpIdempotencyKey(tenantId, ulid(), 'freight.scan:already-loaded');
    const again = await scan(load.id, cartonCode(so3, 1, 1), twice).expect(201);
    expect(again.body.alreadyLoaded).toBe(true);
    expect(await sql`select count(*)::int as n from freight_load_scans where consignment_id = ${load.consignments[0].id as string} and status = 'loaded'`).toEqual([{ n: 1 }]);

    const detail = await http().get(`${API}/${tenantId}/outbound/freight-loads/${load.id}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(detail.body.totals).toMatchObject({ consignments: 2, packages: 4, loaded: 4, pallets: 2, grossWeightGrams: 805_900, weightKnown: true, overCapacity: false });

    // The plan sheet prints before departure.
    const plan = await http().get(`${API}/${tenantId}/outbound/freight-loads/${load.id}/loading-sheet?format=pdf`).set('Authorization', `Bearer ${opsToken}`).buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
    expect(plan.headers['content-type']).toBe('application/pdf');
    const planText = await pdfText(plan.body as Buffer);
    expect(planText).toContain('PLAN');
    expect(planText).toContain(load.code);

    // The web departure.
    const departKey = ulid();
    const departed = await depart(
      load.id,
      [
        { orderId: so1, decision: 'dispatch', lrNumber: '4410', freightTerms: 'paid' },
        { orderId: so3, decision: 'dispatch', lrNumber: 'lr-77' },
      ],
      {},
      departKey,
    ).expect(201);
    expect(departed.body.load).toMatchObject({ status: 'dispatched', vehicle: { number: 'KA01AB1234' }, driver: { name: 'Ravi' }, seals: ['S-991'], dispatchSource: 'web' });
    expect(departed.body.dispatched.map((d: { orderId: string; lrNumber: string }) => [d.orderId, d.lrNumber]).sort()).toEqual([[so1, '4410'], [so3, 'LR77']].sort());
    expect(departed.body.refused).toEqual([]);
    expect(await orderStatus(so1)).toBe('dispatched');
    expect(await orderStatus(so3)).toBe('dispatched');
    const events = (await sql`select reference_doc from ledger_events where tenant_id = ${tenantId} and type = 'dispatch.dispatched' and reference_doc->>'orderId' = ${so1}`) as unknown as { reference_doc: Record<string, unknown> }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.reference_doc).toMatchObject({ carrierName: 'VRL Logistics', trackingNumber: '4410' });
    const c1 = await consignmentOf(so1);
    expect(c1).toMatchObject({ status: 'dispatched', package_count: 3, pallet_count: 2, loaded_package_count: 3, load_exception: null, lr_number: '4410', freight_terms: 'paid' });
    expect(c1.carriage_snapshot).toMatchObject({ v: 1, loadCode: load.code, consignmentRef: `${load.code}/02`, transporterName: 'VRL Logistics', vehicleNumber: 'KA01AB1234', driverName: 'Ravi', seals: ['S-991'] });
    expect(Object.keys(c1.carriage_snapshot as object).sort()).toEqual(
      ['v', 'loadCode', 'consignmentRef', 'mode', 'transporterName', 'transporterGstin', 'transporter', 'vehicleNumber', 'vehicleType', 'containerNumber', 'driverName', 'seals', 'dispatchedAt', 'warehouse'].sort(),
    );
    expect(JSON.stringify(c1.carriage_snapshot)).not.toContain('phone');
    await expectAuditRow({
      tenantId,
      key: departKey,
      action: 'freight_load.dispatched',
      targetType: 'freight_load',
      targetId: load.id,
      actorUserId: opsId,
      alongside: [
        { action: 'order.dispatched', targetType: 'order', targetId: so1, actorUserId: opsId },
        { action: 'order.dispatched', targetType: 'order', targetId: so3, actorUserId: opsId },
      ],
    });
    expect(await storedHash(departKey)).toBe(
      hashCommandPayload({
        arm: 'freight-dispatch',
        surface: 'web',
        tenantId,
        loadId: load.id,
        warehouseId: null,
        vehicleNumber: 'KA01AB1234',
        vehicleType: null,
        containerNumber: null,
        driverName: 'Ravi',
        driverPhone: null,
        driverLicenceNumber: null,
        seals: ['S-991'],
        departedAt: null,
        occurredAt: null,
        ewayPartBConfirmed: false,
        overCapacityAcknowledged: false,
        note: null,
        consignments: [
          { orderId: so1, decision: 'dispatch', lrNumber: '4410', lrDate: null, freightTerms: 'paid', unscannedAcknowledged: false },
          { orderId: so3, decision: 'dispatch', lrNumber: 'LR77', lrDate: null, freightTerms: null, unscannedAcknowledged: false },
        ].sort((a, b) => (a.orderId < b.orderId ? -1 : 1)),
        photoRefs: null,
      }),
    );
    // A replay serves the snapshot; another key meets a truck that has left.
    const replayed = await depart(load.id, [{ orderId: so3, decision: 'dispatch', lrNumber: 'LR77' }, { orderId: so1, decision: 'dispatch', lrNumber: '4410', freightTerms: 'paid' }], {}, departKey).expect(201);
    expect(replayed.body).toEqual(departed.body);
    const late = await depart(load.id, [{ orderId: so1, decision: 'dispatch' }]).expect(409);
    expect(late.body.code).toBe('load-dispatched');
    // A38 — the dispatched event drains (no consumer).
    expect(await sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'freight_load.dispatched'`).toEqual([{ n: 1 }]);
    await drain();
    expect(await sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'freight_load.dispatched' and status = 'pending'`).toEqual([{ n: 0 }]);

    // The prints: the final sheet and the staff freight note.
    const sheet = await http().get(`${API}/${tenantId}/outbound/freight-loads/${load.id}/loading-sheet`).set('Authorization', `Bearer ${opsToken}`).buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
    const sheetText = await pdfText(sheet.body as Buffer);
    expect(sheetText).toContain('Dispatched');
    expect(sheetText).not.toContain('PLAN');
    const note = await http().get(`${API}/${tenantId}/outbound/freight-consignments/${c1.id as string}/note?format=pdf`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(note.headers['content-type']).toBe('application/pdf');

    // The portal: client A sees only its own truck block; B cannot read A's note.
    const portal = await http().get(`${API}/${tenantId}/portal/orders/${so1}/shipping`).set('Authorization', `Bearer ${acmePortal}`).expect(200);
    expect(portal.body.status).toBe('freight-dispatched');
    expect(portal.body.freight).toMatchObject({ status: 'dispatched', consignmentRef: `${load.code}/02`, transporterName: 'VRL Logistics', vehicleNumber: 'KA01AB1234', lrNumber: '4410', packageCount: 3, palletCount: 2, seals: null });
    expect(JSON.stringify(portal.body.freight)).not.toMatch(/phone|licence|loadId|scan/i);
    await http().get(`${API}/${tenantId}/portal/orders/${so1}/freight-note`).set('Authorization', `Bearer ${acmePortal}`).expect(200);
    await http().get(`${API}/${tenantId}/portal/orders/${so1}/freight-note`).set('Authorization', `Bearer ${betaPortal}`).expect(404);
    await http().get(`${API}/${tenantId}/portal/orders/${so1}/shipping`).set('Authorization', `Bearer ${betaPortal}`).expect(404);
    const list = await http().get(`${API}/${tenantId}/portal/orders?limit=50`).set('Authorization', `Bearer ${acmePortal}`).expect(200);
    const row = (list.body.items as { id: string; freight?: unknown }[]).find((item) => item.id === so1);
    expect(row?.freight).toMatchObject({ lrNumber: '4410', transporterName: 'VRL Logistics', deliveredAt: null, outcome: null });
    // The staff order read's freight block.
    const shipping = await http().get(`${API}/${tenantId}/outbound/orders/${so1}/shipping`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(shipping.body.freight).toMatchObject({ loadId: load.id, loadCode: load.code, status: 'dispatched', lrNumber: '4410', transporterName: 'VRL Logistics', packageCount: 3 });
    // The list views.
    const dispatchedList = await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/freight-loads?view=dispatched&clientId=${beta}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(dispatchedList.body.items.map((i: { id: string }) => i.id)).toContain(load.id);
    const podPending = await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/freight-loads?view=pod-pending`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(podPending.body.items.map((i: { id: string }) => i.id)).toContain(load.id);

    // ── A17: the proof of delivery ──
    const early = await post(`freight-consignments/${c1.id as string}/delivery`, { outcome: 'delivered', deliveredAt: new Date(Date.parse(c1.dispatched_at as string) - 60_000).toISOString() }).expect(400);
    expect(early.body.detail).toMatch(/before the truck left/);
    await post(`freight-consignments/${c1.id as string}/delivery`, { outcome: 'delivered-with-exceptions', deliveredAt: new Date().toISOString(), damagedPackageCount: 4, note: 'x' }).expect(400);
    const deliveryKey = ulid();
    const deliveredAt = new Date().toISOString();
    const delivered = await post(
      `freight-consignments/${c1.id as string}/delivery`,
      { outcome: 'delivered-with-exceptions', deliveredAt, receiverName: 'A. Kumar', damagedPackageCount: 1, note: 'pallet 2 crushed corner' },
      deliveryKey,
    ).expect(200);
    expect(delivered.body.consignment.delivery).toMatchObject({ outcome: 'delivered-with-exceptions', damaged: 1, deliverySeq: 1, receiverName: 'A. Kumar' });
    await expectAuditRow({ tenantId, key: deliveryKey, action: 'freight_consignment.delivery_recorded', targetType: 'order', targetId: so1, actorUserId: opsId });
    expect(await storedHash(deliveryKey)).toBe(
      hashCommandPayload({ arm: 'freight-delivery', tenantId, consignmentId: c1.id, outcome: 'delivered-with-exceptions', deliveredAt, receiverName: 'A. Kumar', shortPackageCount: null, damagedPackageCount: 1, note: 'pallet 2 crushed corner', reason: null }),
    );
    const outbox = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'freight_consignment.delivered'`) as unknown as { payload: Record<string, unknown> }[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload).toMatchObject({ orderId: so1, clientId: acme, deliverySeq: 1, outcome: 'delivered-with-exceptions', lrNumber: '4410', transporterName: 'VRL Logistics', amended: false });
    const portalAfter = await http().get(`${API}/${tenantId}/portal/orders/${so1}/shipping`).set('Authorization', `Bearer ${acmePortal}`).expect(200);
    expect(portalAfter.body.status).toBe('delivered-with-exceptions');
    // An unchanged resend is the 200 no-op (any role); an amendment needs orders.manage and a reason.
    const same = noOpIdempotencyKey(tenantId, ulid(), 'freight.delivery:unchanged');
    const unchanged = await post(`freight-consignments/${c1.id as string}/delivery`, { outcome: 'delivered-with-exceptions', deliveredAt, receiverName: 'A. Kumar', damagedPackageCount: 1, note: 'pallet 2 crushed corner' }, same, floorWebToken).expect(200);
    expect(unchanged.body.unchanged).toBe(true);
    const denied = await post(`freight-consignments/${c1.id as string}/delivery`, { outcome: 'delivered', deliveredAt, reason: 'fixed' }, ulid(), floorWebToken).expect(403);
    expect(denied.body).toMatchObject({ code: 'role-denied', detail: 'Only an office role can amend a recorded delivery.' });
    await post(`freight-consignments/${c1.id as string}/delivery`, { outcome: 'delivered', deliveredAt }).expect(400);
    const amended = await post(`freight-consignments/${c1.id as string}/delivery`, { outcome: 'delivered', deliveredAt, reason: 'The damage was cosmetic' }).expect(200);
    expect(amended.body.consignment.delivery).toMatchObject({ outcome: 'delivered', deliverySeq: 2 });

    // ── A16: the LR after departure needs a reason ──
    await post(`freight-consignments/${c1.id as string}/lr`, { lrNumber: '4411' }).expect(400);
    const lrKey = ulid();
    await post(`freight-consignments/${c1.id as string}/lr`, { lrNumber: '4411', reason: 'Typo on the LR' }, lrKey).expect(200);
    await expectAuditRow({ tenantId, key: lrKey, action: 'freight_consignment.lr_recorded', targetType: 'order', targetId: so1, actorUserId: opsId });
    expect(await storedHash(lrKey)).toBe(hashCommandPayload({ arm: 'freight-lr', tenantId, consignmentId: c1.id, lrNumber: '4411', lrDate: null, freightTerms: null, reason: 'Typo on the LR' }));
    const sameLr = noOpIdempotencyKey(tenantId, ulid(), 'freight.lr:unchanged');
    expect((await post(`freight-consignments/${c1.id as string}/lr`, { lrNumber: '4411', reason: 'again' }, sameLr).expect(200)).body.unchanged).toBe(true);
    // A69 — the carriage snapshot is written once: the LR change and two deliveries left it as the departure wrote it.
    expect((await consignmentOf(so1)).carriage_snapshot).toEqual(c1.carriage_snapshot);
    expect((await consignmentOf(so1)).client_snapshot).toEqual(c1.client_snapshot);
  });

  // ── AC3: the web departure's refusals, acknowledgement and leave ──────────

  it('AC3 — a partly loaded order is refused until acknowledged; a left order stays packed and can ride the next truck; the members must match', async () => {
    const so2 = await packedOrder('A-TEE', 2);
    const so4 = await packedOrder('A-TEE', 1);
    const so5 = await packedOrder('A-TEE', 1);
    const load = (await createLoad({ transporter: { name: '  Shree Roadways ' }, orderIds: [so2, so4, so5] }).expect(201)).body.load;
    expect(load.transporter).toEqual({ partnerId: null, name: 'Shree Roadways', snapshot: null });
    await scan(load.id, cartonCode(so2, 1, 1)).expect(201);
    await scan(load.id, cartonCode(so5, 1, 1)).expect(201);
    const all = [
      { orderId: so2, decision: 'dispatch' },
      { orderId: so4, decision: 'dispatch' },
      { orderId: so5, decision: 'dispatch' },
    ];
    const refused = await depart(load.id, all).expect(409);
    expect(refused.body.code).toBe('freight-orders-refused');
    expect(refused.body.orders.map((o: { orderId: string; code: string }) => [o.orderId, o.code])).toEqual([
      [so2, 'packages-not-loaded'],
      [so4, 'packages-not-loaded'],
    ]);
    const changed = await depart(load.id, all.slice(0, 2)).expect(409);
    expect(changed.body).toMatchObject({ code: 'freight-members-changed' });
    expect([...changed.body.orderIds].sort()).toEqual([so2, so4, so5].sort());
    const res = await depart(load.id, [
      { orderId: so2, decision: 'dispatch', unscannedAcknowledged: true },
      { orderId: so4, decision: 'leave' },
      { orderId: so5, decision: 'dispatch' },
    ]).expect(201);
    expect(res.body.left).toEqual([{ orderId: so4, reason: 'Left on the dock at departure' }]);
    expect(await consignmentOf(so2)).toMatchObject({ status: 'dispatched', load_exception: 'packages-unscanned', loaded_package_count: 1, package_count: 2 });
    expect(await consignmentOf(so4)).toMatchObject({ status: 'removed', remove_reason: 'Left on the dock at departure' });
    expect(await orderStatus(so4)).toBe('ready_to_dispatch');
    expect(res.body.load.removed.map((r: { orderId: string }) => r.orderId)).toEqual([so4]);
    // The left order rides the next truck.
    const next = await createLoad({ orderIds: [so4] }).expect(201);
    expect(next.body.load.consignments[0]).toMatchObject({ orderId: so4, status: 'planned', packages: { loaded: 0, total: 1 } });
  });

  // ── AC7: the guards on a planned order's other exits; the cancels ─────────

  it('AC7 — a planned order is refused by the per-order dispatch, the handover and a courier label, and by a second load; cancelling it removes it; remove, reorder, update and cancel the load', async () => {
    const so6 = await packedOrder('A-TEE', 1);
    const so7 = await acceptedOrder('A-TEE');
    const so8 = await packedOrder('A-TEE', 1);
    const load = (await createLoad({ orderIds: [so6, so7, so8] }).expect(201)).body.load;
    const dispatch = await http().post(`${API}/${tenantId}/outbound/orders/${so6}/dispatch`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(409);
    expect(dispatch.body).toMatchObject({ code: 'dispatch-via-freight', loadCode: load.code });
    const handover = await http().post(`${API}/${tenantId}/outbound/handovers`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
      .send({ warehouseId, clientId: acme, courier: { courierName: 'Delhivery' }, pickupPersonName: 'Ravi', parcels: [{ orderId: so6, awb: 'AWB9001' }] }).expect(409);
    expect(handover.body.parcels.map((p: { code: string }) => p.code)).toEqual(['order-on-freight-load']);
    const awb = await http().post(`${API}/${tenantId}/outbound/orders/${so6}/shipment/awb`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
      .send({ awb: 'AWB9002', courierName: 'Delhivery' }).expect(409);
    expect(awb.body.code).toBe('order-on-freight-load');
    const other = await createLoad({ orderIds: [so6] }).expect(409);
    expect(other.body).toMatchObject({ code: 'freight-orders-refused', orders: [{ orderId: so6, code: 'order-on-freight-load', loadCode: load.code }] });
    // A web handover candidate list no longer offers it.
    const parcels = await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/handover-candidates?clientId=${acme}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(JSON.stringify(parcels.body)).not.toContain(so6);

    // Cancel the accepted order: its consignment is removed, its audit row under the cancel's key.
    const cancelKey = ulid();
    await http().post(`${API}/${tenantId}/outbound/orders/${so7}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, cancelKey).send({}).expect(200);
    expect(await consignmentOf(so7)).toMatchObject({ status: 'removed', remove_reason: 'Order cancelled' });

    // Remove so6 (its scan unloaded), reorder, update, cancel the load.
    await scan(load.id, cartonCode(so6, 1, 1)).expect(201);
    const removeKey = ulid();
    await post(`freight-loads/${load.id}/orders/${so6}/remove`, { reason: 'Customer wants courier' }, removeKey).expect(200);
    await expectAuditRow({ tenantId, key: removeKey, action: 'freight_load.order_removed', targetType: 'freight_load', targetId: load.id, actorUserId: opsId });
    expect(await sql`select status, unload_reason from freight_load_scans where order_id = ${so6}`).toEqual([{ status: 'unloaded', unload_reason: 'Customer wants courier' }]);
    const add = await post(`freight-loads/${load.id}/orders`, { orderIds: [so6] }).expect(200);
    expect(add.body.load.consignments.find((c: { orderId: string }) => c.orderId === so6).packages.loaded).toBe(0);
    const stopsKey = ulid();
    const reordered = await post(`freight-loads/${load.id}/stops`, { orderIds: [so6, so8] }, stopsKey).expect(200);
    expect(reordered.body.load.consignments.map((c: { orderId: string; stopSeq: number }) => [c.orderId, c.stopSeq])).toEqual([
      [so6, 1],
      [so8, 2],
    ]);
    await expectAuditRow({ tenantId, key: stopsKey, action: 'freight_load.stops_reordered', targetType: 'freight_load', targetId: load.id, actorUserId: opsId });
    await post(`freight-loads/${load.id}/stops`, { orderIds: [so6, so8] }, noOpIdempotencyKey(tenantId, ulid(), 'freight.stops:unchanged')).expect(200);
    await post(`freight-loads/${load.id}/stops`, { orderIds: [so8] }).expect(409);
    const updateKey = ulid();
    const updated = await post(`freight-loads/${load.id}`, { mode: 'ftl', transporter: { transporterId }, dockDoor: 'D-3', vehicleNumber: 'MH12 AB 0001', driverPhone: '+91 98000 00000' }, updateKey).expect(200);
    expect(updated.body.load).toMatchObject({ mode: 'ftl', vehicle: { number: 'MH12AB0001' }, driver: { phone: '+919800000000' } });
    await expectAuditRow({ tenantId, key: updateKey, action: 'freight_load.updated', targetType: 'freight_load', targetId: load.id, actorUserId: opsId });
    await post(
      `freight-loads/${load.id}`,
      { mode: 'ftl', transporter: { transporterId }, dockDoor: 'D-3', vehicleNumber: 'MH12AB0001', driverPhone: '+919800000000' },
      noOpIdempotencyKey(tenantId, ulid(), 'freight.load-update:unchanged'),
    ).expect(200);
    const masked = await http().get(`${API}/${tenantId}/outbound/freight-loads/${load.id}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(masked.body.driver.phone).toBe('+919800000000');
    const cancelLoadKey = ulid();
    const cancelled = await post(`freight-loads/${load.id}/cancel`, { reason: 'Truck did not report' }, cancelLoadKey).expect(200);
    expect(cancelled.body.load).toMatchObject({ status: 'cancelled', cancel: { reason: 'Truck did not report' } });
    await expectAuditRow({ tenantId, key: cancelLoadKey, action: 'freight_load.cancelled', targetType: 'freight_load', targetId: load.id, actorUserId: opsId });
    expect(await orderStatus(so8)).toBe('ready_to_dispatch');
    expect(await consignmentOf(so8)).toMatchObject({ status: 'removed', remove_reason: 'Load cancelled: Truck did not report' });
    expect((await post(`freight-loads/${load.id}/cancel`, { reason: 'again' }).expect(409)).body.code).toBe('load-not-open');
    // Freed, the order now dispatches per order.
    await http().post(`${API}/${tenantId}/outbound/orders/${so8}/dispatch`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect((r) => expect([200, 201]).toContain(r.status));
  });

  // ── A13: the scan refusals; the unload ───────────────────────────────────

  it('A13 — unreadable, ambiguous, another truck’s, a stale label; an unload and its no-op twin', async () => {
    const two = await packedOrder('A-TEE', 2);
    const elsewhere = await packedOrder('A-TEE', 1);
    const load = (await createLoad({ orderIds: [two] }).expect(201)).body.load;
    const otherLoad = (await createLoad({ orderIds: [elsewhere] }).expect(201)).body.load;
    expect((await scan(load.id, '4410').expect(422)).body.code).toBe('package-code-invalid');
    expect((await scan(load.id, parcelTagCode(two)).expect(422)).body).toMatchObject({ code: 'package-code-ambiguous', packageCount: 2 });
    expect((await scan(load.id, cartonCode(elsewhere, 1, 1)).expect(409)).body).toMatchObject({ code: 'package-not-on-load', loadCode: otherLoad.code });
    expect((await scan(load.id, cartonCode(two, 2, 1)).expect(409)).body.code).toBe('carton-not-current');
    expect((await scan(load.id, cartonCode(two, 1, 3)).expect(409)).body.code).toBe('carton-not-current');
    await scan(load.id, cartonCode(two, 1, 1)).expect(201);
    await post(`freight-loads/${load.id}/scans`, { packageCode: cartonCode(two, 1, 1), action: 'unload' }).expect(400);
    const unloadKey = ulid();
    const unloaded = await post(`freight-loads/${load.id}/scans`, { packageCode: cartonCode(two, 1, 1), action: 'unload', reason: 'Wrong truck' }, unloadKey).expect(201);
    expect(unloaded.body).toMatchObject({ scan: { status: 'unloaded' }, progress: { loaded: 0, total: 2 } });
    await expectAuditRow({ tenantId, key: unloadKey, action: 'freight_load.package_unloaded', targetType: 'freight_load', targetId: load.id, actorUserId: opsId });
    const nothing = await post(`freight-loads/${load.id}/scans`, { packageCode: cartonCode(two, 1, 1), action: 'unload', reason: 'Again' }, noOpIdempotencyKey(tenantId, ulid(), 'freight.scan:not-loaded')).expect(201);
    expect(nothing.body.alreadyLoaded).toBe(false);
    // The web sends no device time; the device names its warehouse.
    await scan(load.id, cartonCode(two, 1, 2), ulid(), { occurredAt: new Date().toISOString() }).expect(400);
    await scan(load.id, cartonCode(two, 1, 2), ulid(), { occurredAt: new Date().toISOString() }, operatorToken).expect(400);
    expect((await scan(load.id, cartonCode(two, 1, 2), ulid(), { occurredAt: new Date().toISOString(), warehouseId: uuidv7() }, operatorToken).expect(409)).body.code).toBe('warehouse-mismatch');
  });

  // ── AC4 / A41 / A42 / A44 / A50: the handheld departure ──────────────────

  it('A14 device — settles partially: an unlisted order with scans leaves flagged, one without stays; a refused order becomes one Discard-only review row; the photos are claimed; a late scan counts', async () => {
    const a = await packedOrder('A-TEE', 2);
    const b = await packedOrder('A-TEE', 1);
    const c = await packedOrder('A-TEE', 1);
    const load = (await createLoad({ orderIds: [a, b, c] }).expect(201)).body.load;
    const before = new Date(Date.now() - 120_000).toISOString();
    await deviceScan(load.id, cartonCode(a, 1, 1), before).expect(201);
    await deviceScan(load.id, cartonCode(b, 1, 1), before).expect(201);
    const photo = ulid();
    const staged = await http().post(`${API}/${tenantId}/outbound/freight-photos`).set('Authorization', `Bearer ${deviceToken}`).set(KEY_HEADER, photo)
      .set('x-op-operator', operatorId).field('capturedAt', new Date().toISOString()).attach('file', JPEG, { filename: 'sheet.jpg', contentType: 'image/jpeg' }).expect(201);
    expect(staged.body).toEqual({ ref: photo, status: 'staged' });
    await expectAuditRow({ tenantId, key: photo, action: 'freight_photo.uploaded', targetType: 'attachment', targetId: (await sql`select id from attachments where client_ref = ${photo}`)[0]!.id as string, actorUserId: operatorId });
    const ghost = uuidv7();
    const key = ulid();
    const departedAt = new Date(Date.now() - 30_000).toISOString();
    const res = await depart(
      load.id,
      [
        { orderId: a, decision: 'dispatch', lrNumber: 'D-1001' },
        { orderId: ghost, decision: 'dispatch' },
      ],
      { occurredAt: departedAt, warehouseId, photoRefs: [photo] },
      key,
      operatorToken,
    );
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    expect(res.body.refused).toEqual([{ orderId: ghost, code: 'consignment-removed', detail: expect.any(String) }]);
    expect(res.body.rejectedOpId).toEqual(expect.any(String));
    expect(res.body.left).toEqual([{ orderId: c, reason: "Not on the device's dispatch list" }]);
    expect(await consignmentOf(a)).toMatchObject({ status: 'dispatched', load_exception: 'packages-unscanned', loaded_package_count: 1 });
    expect(await consignmentOf(b)).toMatchObject({ status: 'dispatched', load_exception: 'not-on-device-list' });
    expect(await consignmentOf(c)).toMatchObject({ status: 'removed' });
    expect(await orderStatus(b)).toBe('dispatched');
    expect(await orderStatus(c)).toBe('ready_to_dispatch');
    const review = (await sql`select op_type, problem_code from rejected_ops where tenant_id = ${tenantId} and op_id = ${res.body.rejectedOpId as string}`)[0]!;
    expect(review).toEqual({ op_type: 'freight.dispatch', problem_code: 'freight-orders-refused' });
    expect(REJECTED_OP_DECISIONS_BY_TYPE['freight.dispatch']).toEqual(['discard']);
    expect(await sql`select owner_type, purpose, client_id from attachments where client_ref = ${photo} and owner_id = ${load.id}`).toEqual([{ owner_type: 'freight_load', purpose: 'loading-sheet', client_id: null }]);
    expect(await sql`select dispatch_source, dispatch_device_id is not null as device from freight_loads where id = ${load.id}`).toEqual([{ dispatch_source: 'handheld', device: true }]);
    // A44 — a second device's scan taken before the departure, synced after: counted, the exception clears.
    const dispatchedAt = (await sql`select dispatched_at from freight_loads where id = ${load.id}`)[0]!.dispatched_at as Date;
    await deviceScan(load.id, cartonCode(a, 1, 2), new Date(dispatchedAt.getTime() + 60_000).toISOString()).expect(409);
    await deviceScan(load.id, cartonCode(a, 1, 2), new Date(dispatchedAt.getTime() - 10_000).toISOString()).expect(201);
    expect(await consignmentOf(a)).toMatchObject({ loaded_package_count: 2, load_exception: null });
    expect((await sql`select after_departure from freight_load_scans where package_code = ${cartonCode(a, 1, 2)}`)[0]).toEqual({ after_departure: true });
    // A57 — a dispatched load takes a signed sheet page; its audit targets the load.
    const sheetKey = ulid();
    await http().post(`${API}/${tenantId}/outbound/freight-loads/${load.id}/sheet`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, sheetKey)
      .attach('file', JPEG, { filename: 'sheet.jpg', contentType: 'image/jpeg' }).expect(201);
    await expectAuditRow({ tenantId, key: sheetKey, action: 'freight_load.sheet_attached', targetType: 'freight_load', targetId: load.id, actorUserId: opsId });
    const detail = await http().get(`${API}/${tenantId}/outbound/freight-loads/${load.id}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(detail.body.sheet.length).toBe(2);
    expect(await sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'shipment.document-shared' and payload->>'attachmentId' in (select id::text from attachments where owner_id = ${load.id})`).toEqual([{ n: 0 }]);
  });

  // ── Part B, capacity, and the departure that dispatches nothing ──────────

  it('A14 web — an e-way bill needs the Part B confirmation (naming the bills); an overloaded truck needs the acknowledgement (A66); both recorded on the load', async () => {
    const order = await packedOrder('A-TEE', 2);
    const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const until = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await sql`insert into order_consignment_records (id, tenant_id, client_id, warehouse_id, order_id, seq, status, brand_document_type, brand_document_number, brand_document_date,
        consignor_gstin, consignor_snapshot, declared_value_paise, destination_state_code, supply_type, threshold_paise, threshold_rule, eway_required, eway_status,
        eway_bill_number, eway_bill_date, eway_valid_until, recorded_after_dispatch, source, recorded_by, recorded_at)
      values (${uuidv7()}, ${tenantId}, ${acme}, ${warehouseId}, ${order}, 1, 'live', 'invoice', 'INV-4409', ${today},
        '29ABCDE1234F1Z5', '{"v":1,"code":"ACME","name":"ACME Brand"}'::jsonb, 11800000, '27', 'inter', 5000000, 'national', true, 'recorded',
        '123456789012', ${today}, ${until}, false, 'web', ${opsId}, now())`;
    const load = (await createLoad({ orderIds: [order], vehicleCapacityKg: 1 }).expect(201)).body.load;
    expect(load.partB.required).toBe(true);
    expect(load.consignments[0].eway).toEqual({ number: '123456789012', validUntil: until });
    await scan(load.id, cartonCode(order, 1, 1)).expect(201);
    await scan(load.id, cartonCode(order, 1, 2)).expect(201);
    const consignments = [{ orderId: order, decision: 'dispatch' }];
    const partB = await depart(load.id, consignments).expect(409);
    expect(partB.body).toMatchObject({ code: 'eway-part-b-unconfirmed', orders: [{ orderId: order, ewayBillNumber: '123456789012' }], vehicleNumber: 'KA01AB1234' });
    const heavy = await depart(load.id, consignments, { ewayPartBConfirmed: true }).expect(409);
    expect(heavy.body).toMatchObject({ code: 'load-over-capacity', grossWeightGrams: 10_000, capacityKg: 1 });
    const ok = await depart(load.id, consignments, { ewayPartBConfirmed: true, overCapacityAcknowledged: true }).expect(201);
    expect(ok.body.load).toMatchObject({ capacityExceeded: true, partB: { required: true, confirmedBy: opsId } });
    expect(ok.body.load.partB.confirmedAt).toEqual(expect.any(String));
    // The stamped version is the one the truck left under.
    expect((await sql`select dispatched_at is not null as stamped from order_consignment_records where order_id = ${order}`)[0]).toEqual({ stamped: true });
  });

  it('A50 — a handheld departure whose every order is refused closes the load (cancelled, the vehicle kept, one review row); later scans answer load-cancelled', async () => {
    const order = await packedOrder('A-TEE', 1);
    const load = (await createLoad({ orderIds: [order] }).expect(201)).body.load;
    const ghost = uuidv7();
    const res = await depart(load.id, [{ orderId: ghost, decision: 'dispatch' }], { occurredAt: new Date().toISOString(), warehouseId }, ulid(), operatorToken).expect(201);
    expect(res.body).toMatchObject({ dispatched: [], refused: [{ orderId: ghost, code: 'consignment-removed' }], left: [{ orderId: order, reason: "Not on the device's dispatch list" }] });
    expect(res.body.load.status).toBe('cancelled');
    expect(res.body.load.cancel.reason).toMatch(/^Departed with no dispatchable order — see review /);
    expect(res.body.load.vehicle.number).toBe('KA01AB1234');
    expect(await orderStatus(order)).toBe('ready_to_dispatch');
    expect((await deviceScan(load.id, cartonCode(order, 1, 1)).expect(409)).body.code).toBe('load-cancelled');
  });

  // ── the device snapshot, the pallet package and load-full ─────────────────

  it('A23 — the device snapshot carries the open loads with their consignments and loaded codes; A10 — a full load refuses one more', async () => {
    const p = await packedOrder('A-TEE', 3, 3);
    const load = (await createLoad({ orderIds: [p] }).expect(201)).body.load;
    await scan(load.id, cartonCode(p, 1, 2)).expect(201);
    const snapshot = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    {
      const entry = (snapshot.body.freightLoads as { loadId: string; consignments: { orderId: string; packageCount: number; palletCount: number; parcelTagCode: string }[]; loadedCodes: string[] }[]).find((l) => l.loadId === load.id)!;
      expect(entry.consignments[0]).toMatchObject({ orderId: p, packageCount: 3, palletCount: 3, parcelTagCode: parcelTagCode(p) });
      expect(entry.loadedCodes).toEqual([cartonCode(p, 1, 2)]);
      expect(snapshot.body.freightLoadsTruncated).toBe(false);
    }
    // 100 live consignments seeded on a load; one more is load-full.
    const full = (await createLoad({}).expect(201)).body.load;
    for (let i = 0; i < 100; i += 1) {
      await sql`insert into freight_consignments (id, tenant_id, warehouse_id, load_id, order_id, client_id, status, stop_seq, added_by) values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${full.id}, ${uuidv7()}, ${acme}, 'planned', ${i + 1}, ${opsId})`;
    }
    const extra = await packedOrder('A-TEE', 1);
    const refused = await post(`freight-loads/${full.id}/orders`, { orderIds: [extra] }).expect(409);
    expect(refused.body).toMatchObject({ code: 'load-full', current: 100, adding: 1, max: 100 });
    await sql`update freight_consignments set status = 'removed', removed_at = now(), removed_by = ${opsId}, remove_reason = 'test' where load_id = ${full.id}`;
  });

  // ── 4-6a's gate at departure, the exceptions union, frozen parties, unstamped writes ──

  it('4-6a at departure — the web refuses an order without the brand’s documents; the handheld dispatches it flagged and the documents worklist lists it with its load (A20); renaming the transporter after departure changes no print (AC6); a freight write refuses a client stamp (A64)', async () => {
    await sql`update clients set consignment_document_rule = 'all' where id = ${beta}`;
    try {
      const order = await packedOrder('B-TEE', 1);
      const load = (await createLoad({ orderIds: [order] }).expect(201)).body.load;
      expect(load.consignments[0].gate).toMatchObject({ blocking: true });
      await deviceScan(load.id, cartonCode(order, 1, 1)).expect(201);
      const web = await depart(load.id, [{ orderId: order, decision: 'dispatch' }]).expect(409);
      expect(web.body).toMatchObject({ code: 'freight-orders-refused', orders: [{ orderId: order, code: 'consignment-documents-missing' }] });
      const device = await depart(load.id, [{ orderId: order, decision: 'dispatch' }], { occurredAt: new Date().toISOString(), warehouseId }, ulid(), operatorToken).expect(201);
      expect(device.body.dispatched).toEqual([expect.objectContaining({ orderId: order, complianceException: 'consignment-documents-missing', loadException: null })]);
      expect(await consignmentOf(order)).toMatchObject({ status: 'dispatched', compliance_exception: 'consignment-documents-missing' });
      const worklist = await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/consignments?view=exceptions`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      const row = (worklist.body.exceptions as { orderId: string; shipmentId: string | null; freight?: { loadCode: string } }[]).find((r) => r.orderId === order);
      expect(row).toMatchObject({ shipmentId: null, code: 'consignment-documents-missing', freight: { loadId: load.id, loadCode: load.code } });

      // AC6 — the partner renamed after departure: the frozen load prints the old name.
      await sql`update business_partners set name = 'VRL Renamed Ltd' where id = ${transporterId}`;
      const sheet = await http().get(`${API}/${tenantId}/outbound/freight-loads/${load.id}/loading-sheet`).set('Authorization', `Bearer ${opsToken}`).buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        }).expect(200);
      const text = await pdfText(sheet.body as Buffer);
      expect(text).toContain('VRL Logistics');
      expect(text).not.toContain('VRL Renamed');
      await sql`update business_partners set name = 'VRL Logistics' where id = ${transporterId}`;

      // A64 — the cancels' freight arm refuses a client-stamped transaction.
      const planned = await acceptedOrder('A-TEE');
      await createLoad({ orderIds: [planned] }).expect(201);
      await expect(
        withTenantTransaction(app.get(DATABASE), tenantId, (tx) => removeFromFreightOnCancelInTx(tx, { tenantId, orderId: planned, actorUserId: opsId, at: new Date().toISOString(), idempotencyKey: ulid() }), { clientId: acme }),
      ).rejects.toThrow(/client-stamped/);
      expect(await consignmentOf(planned)).toMatchObject({ status: 'planned' });
    } finally {
      await sql`update clients set consignment_document_rule = 'b2b' where id = ${beta}`;
    }
  });
});
