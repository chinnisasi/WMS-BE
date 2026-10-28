import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { OutboundFacade } from '../src/modules/outbound/outbound.facade';
import { CANCEL_RESTOCK_COMMAND_KIND, outstandingDraws } from '../src/modules/outbound/cancel-restock.command';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { dispatchedOrderFixtures, type Picklist } from './support/dispatched-order';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.CARRIER_ENCRYPTION_KEY ??= 'e2e-only-carrier-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(300_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const SCALE = 1000;

function userIdOf(token: string): string {
  return (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string }).sub;
}

function nowZ(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

interface RestockLine {
  orderLineId: string;
  skuId: string;
  skuCode: string;
  toBinId: string;
  toBinCode: string;
  batchId: string | null;
  batchCode: string | null;
  qty: number;
  serialCount: number;
  recallCode: string | null;
}

/**
 * Story 4-2b — cancel a picked or packed order with restock: every row of the
 * spec's I/O matrix (pre-pick, mid-pick, packed + labelled + catch weight, one
 * bin, the gate and quarantine refusals, serials, manifested, dispatched, the
 * already-cancelled no-op, the replay, the pick race), the design review's
 * amendments (A2 the zero-unit short pick under the warehouse lock, A3 the
 * pack's case set, A4 a moved serial, A5 a hold the reaper ended, A6 the batch
 * picklist, A9 the restock plan's two lists, A11 the destination arms, A17
 * the blocked batch), the 3-7a fold-in (an order holding a recalled lot gets
 * out through this cancel; the lot stays blocked), the pack's
 * `order-cancelled` arm, the voided-shipment register exclusion, the
 * vocabulary pins and the audit rows.
 */
describe('story 4-2b: cancel with restock (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let db: Database;
  let inventory: InventoryFacade;
  let outbound: OutboundFacade;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorToken: string;
  let deviceOperatorToken: string;
  let wh: string;
  let wh2: string;
  let zoneId: string;
  let binA: string;
  let binB: string;
  let binR: string;
  let binC: string;
  let binF: string;
  let binX: string;
  let binY: string;
  let otherWhBin: string;
  let systemBin: string;
  let acme: string;
  let sandboxConnectionId: string;
  const skuIds = new Map<string, string>();
  /** Shipments the suite inserted by hand (deleted in their own test). */
  const seededShipments: string[] = [];
  const http = () => request(app.getHttpServer());
  const sku = (code: string): string => {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  };
  const fixtures = dispatchedOrderFixtures(() => ({
    app,
    tenantId,
    warehouseId: wh,
    opsToken,
    ownerToken,
    operatorToken: deviceOperatorToken,
  }));

  // code,name,uom,uom_conversions,gst_rate,hsn,batch,serial,catch_weight,rp,rq,barcode
  const SKU_ROWS: readonly string[] = [
    'CR-PRE,Pre-pick,pcs,,1800,,false,false,false,,,',
    'CR-MID1,Mid-pick lot,pcs,,1800,,true,false,false,,,',
    'CR-MID2,Mid-pick plain,pcs,,1800,,false,false,false,,,',
    'CR-PACK,Packed plain,pcs,,1800,,false,false,false,,,',
    'CR-CW,Packed catch weight,case,,1800,,false,false,true,,,',
    'CR-ONE,One bin,pcs,,1800,,false,false,false,,,',
    'CR-BLK,Origin blocked,pcs,,1800,,false,false,false,,,',
    'CR-FRZ,Frozen goods,pcs,,1800,,false,false,false,,,',
    'CR-QUA,Quarantined scope,pcs,,1800,,false,false,false,,,',
    'CR-SER,Serial tracked,pcs,,1800,,false,true,false,,,',
    'CR-SMV,Serial moved,pcs,,1800,,false,true,false,,,',
    'CR-SMV2,Serial drawn again,pcs,,1800,,false,true,false,,,',
    'CR-MAN,Manifested,pcs,,1800,,false,false,false,,,',
    'CR-DSP,Dispatched,pcs,,1800,,false,false,false,,,',
    'CR-AGN,Already cancelled,pcs,,1800,,false,false,false,,,',
    'CR-RACE,Same-key race,pcs,,1800,,false,false,false,,,',
    'CR-PRC1,Pick race drawn,pcs,,1800,,false,false,false,,,',
    'CR-PRC2,Pick race planned,pcs,,1800,,false,false,false,,,',
    'CR-ZERO,Zero-unit short pick,pcs,,1800,,false,false,false,,,',
    'CR-REAP,Reaper skip,pcs,,1800,,false,false,false,,,',
    'CR-BAT,Batch picklist,pcs,,1800,,false,false,false,,,',
    'CR-RCL,Recalled lot,pcs,,1800,,true,false,false,,,',
    'CR-EXP,Blocked batch,pcs,,1800,,true,false,false,,,',
    'CR-ARM,Destination arms,pcs,,1800,,false,false,false,,,',
    'CR-HU,Case moved,case,,1800,,false,false,true,,,',
    'CR-REG,Register voided,pcs,,1800,,false,false,false,,,',
  ];

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('order_cancel_restock');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    db = app.get<Database>(DATABASE);
    inventory = app.get(InventoryFacade);
    outbound = app.get(OutboundFacade);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Restock Co ${ulid()}`, ownerEmail: email, password: PASSWORD }).expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
    opsToken = (await createMember('ops_manager')).token;
    opsUserId = userIdOf(opsToken);
    operatorToken = (await createMember('operator')).token;

    wh = await createWarehouse(`CR-${ulid().slice(20)}`);
    zoneId = await createZone(wh, 'A');
    binA = await createBin(wh, zoneId, 'A-01-01');
    binB = await createBin(wh, zoneId, 'A-02-01');
    binR = await createBin(wh, zoneId, 'R-01-01');
    binC = await createBin(wh, zoneId, 'C-01-01');
    binF = await createBin(wh, zoneId, 'F-01-01', 'frozen');
    binX = await createBin(wh, zoneId, 'X-01-01');
    binY = await createBin(wh, zoneId, 'Y-01-01');
    wh2 = await createWarehouse(`CR2-${ulid().slice(20)}`);
    otherWhBin = await createBin(wh2, await createZone(wh2, 'B'), 'B-01-01');

    acme = await createClient('ACME', 'Acme Foods');
    const csv = ['sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode', ...SKU_ROWS].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', acme)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    for (const row of (await sql`select id, code from skus where tenant_id = ${tenantId}`) as unknown as { id: string; code: string }[]) skuIds.set(row.code, row.id);
    await http().patch(`${API}/${tenantId}/catalog/skus/${sku('CR-FRZ')}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ storageClass: 'frozen' }).expect(200);

    // The floor device and its operator (picks, catch-weight receipts).
    const floor = await createMember('operator');
    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({}).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'CR dock', pin: '2468' }).expect(201);
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail: floor.email, pin: '2468' })
      .expect(200);
    deviceOperatorToken = badged.body.accessToken as string;

    sandboxConnectionId = (
      await http()
        .post(`${API}/${tenantId}/carriers/connections`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ carrierCode: 'sandbox', accountLabel: 'Sandbox CR', credential: { accountToken: 'cr-sandbox-token' } })
        .expect(201)
    ).body.id as string;

    // A system bin of the warehouse (Receiving exists once a receipt landed — ensure it).
    await fixtures.seedCatchWeightCases(sku('CR-HU'), binC, [1_000], 'operator-preference');
    systemBin = ((await sql`select id from bins where tenant_id = ${tenantId} and warehouse_id = ${wh} and system_owned limit 1`) as unknown as { id: string }[])[0]!.id;

    await inventory.rebuildReservationCounters(tenantId, wh);
  });

  afterAll(async () => {
    await sql?.end();
    const dbClient = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await dbClient.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function createMember(role: 'ops_manager' | 'operator'): Promise<{ email: string; token: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { email, token: (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string };
  }

  async function createWarehouse(code: string): Promise<string> {
    return (await http().post(`${API}/${tenantId}/warehouses`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ origin: testAddress(), code, name: `Warehouse ${code}` }).expect(201)).body.id as string;
  }

  async function createZone(warehouseId: string, code: string): Promise<string> {
    return (await http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name: `Zone ${code}` }).expect(201)).body.id as string;
  }

  async function createBin(warehouseId: string, zone: string, code: string, storageClass?: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, capacity: 1_000_000, type: 'shelf', ...(storageClass === undefined ? {} : { storageClass }) })
        .expect(201)
    ).body.id as string;
  }

  async function createBinWithCapacity(code: string, capacity: number): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, capacity, type: 'shelf' })
        .expect(201)
    ).body.id as string;
  }

  async function createClient(code: string, name: string): Promise<string> {
    return (await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name }).expect(201)).body.client.id as string;
  }

  function adjust(body: Record<string, unknown>): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, reasonCode: 'stock-count', note: 'cancel-restock suite', ...body });
  }

  async function seed(skuCode: string, binId: string, qty: number, extra: Record<string, unknown> = {}): Promise<void> {
    await adjust({ skuId: sku(skuCode), binId, quantityDelta: qty, ...extra }).expect(201);
  }

  async function batchIdOf(skuCode: string, code: string): Promise<string> {
    return ((await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku(skuCode)} and code = ${code}`) as unknown as { id: string }[])[0]!.id;
  }

  async function atp(skuCode: string): Promise<{ onHand: number; atp: number }> {
    const snapshot = await inventory.atp(tenantId, wh, sku(skuCode));
    return { onHand: snapshot.onHand / SCALE, atp: snapshot.atp / SCALE };
  }

  async function count(query: PromiseLike<unknown>): Promise<number> {
    return Number(((await query) as { n: number | string }[])[0]!.n);
  }

  async function keyStored(key: string): Promise<boolean> {
    return (await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)) === 1;
  }

  function cancelRestock(orderId: string, body: Record<string, unknown> = {}, key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel-with-restock`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function plan(orderId: string, token = operatorToken): SupertestTest {
    return http().get(`${API}/${tenantId}/outbound/orders/${orderId}/restock-plan`).set('Authorization', `Bearer ${token}`);
  }

  function pack(orderId: string, scanned: { skuId: string; qty: number; handlingUnitIds?: string[] }[], key = ulid()): SupertestTest {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send({ scanned });
  }

  function label(orderId: string): SupertestTest {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/label`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ carrierConnectionId: sandboxConnectionId });
  }

  function pickLine(line: Picklist['lines'][number], body: Record<string, unknown> = {}): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/outbound/picks`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, picklistId: line.picklistId, picklistLineId: line.id, skuId: line.skuId, binId: line.binId!, qty: line.qty, occurredAt: nowZ(), ...body });
  }

  async function orderRow(orderId: string): Promise<{ status: string }> {
    return ((await sql`select status from orders where id = ${orderId}`) as unknown as { status: string }[])[0]!;
  }

  async function holdStates(orderId: string): Promise<string[]> {
    const rows = (await sql`
      select r.state from reservations r
      where r.tenant_id = ${tenantId} and r.owner_type = 'order'
        and r.owner_id in (select id::text from order_lines where order_id = ${orderId})
      order by r.state`) as unknown as { state: string }[];
    return rows.map((row) => row.state);
  }

  async function events(orderId: string, type: string): Promise<{ id: string; to_bin_id: string | null; from_bin_id: string | null; quantity_delta: string; batch_ref: string | null; serial_ref: string | null; reference_doc: Record<string, unknown> }[]> {
    return (await sql`
      select id, to_bin_id, from_bin_id, quantity_delta::text, batch_ref, serial_ref, reference_doc from ledger_events
      where tenant_id = ${tenantId} and type = ${type} and reference_doc ->> 'orderId' = ${orderId}
      order by id`) as unknown as never;
  }

  /** A picked-and-packed order of `qty` units of `skuCode`. */
  async function packedOrder(skuCode: string, qty: number): Promise<string> {
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku(skuCode), quantity: qty }]);
    await fixtures.pickAllLines(picklist);
    await pack(orderId, [{ skuId: sku(skuCode), qty }]).expect(201);
    return orderId;
  }

  /** Poll until `n` backends of this database wait on a lock held by another. */
  async function waitParked(n: number, timeoutMs = 15_000): Promise<void> {
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const rows = (await probe`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`) as unknown as { n: number }[];
        if (rows[0]!.n >= n) return;
        if (Date.now() > deadline) throw new Error(`fewer than ${n} backends parked on a lock`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await probe.end();
    }
  }

  async function holdingAdvisory(then: () => Promise<void>): Promise<void> {
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      await holder.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':' || ${wh}, 0))`;
        await then();
      });
    } finally {
      await holder.end();
    }
  }

  /** Nothing changed for a refused cancel: status, holds, restock events, the key. */
  async function expectUntouched(orderId: string, key: string, status: string, holds: string[]): Promise<void> {
    expect((await orderRow(orderId)).status).toBe(status);
    expect(await holdStates(orderId)).toEqual(holds);
    expect(await events(orderId, 'pick.restocked')).toEqual([]);
    expect(await keyStored(key)).toBe(false);
  }

  // ── vocabularies, routes ───────────────────────────────────────────────────

  it('the routes are published; pick.restocked is registered and nets the pick; the hash carries the command discriminator', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const paths = doc.body.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths['/api/v1/tenants/{tenantId}/outbound/orders/{orderId}/cancel-with-restock'] ?? paths['/tenants/{tenantId}/outbound/orders/{orderId}/cancel-with-restock'] ?? {})).toEqual(['post']);
    expect(Object.keys(paths['/api/v1/tenants/{tenantId}/outbound/orders/{orderId}/restock-plan'] ?? paths['/tenants/{tenantId}/outbound/orders/{orderId}/restock-plan'] ?? {})).toEqual(['get']);
    expect(CANCEL_RESTOCK_COMMAND_KIND).toBe('outbound.cancel-restock');
  });

  // ── matrix: pre-pick (AC3) ─────────────────────────────────────────────────

  it('pre-pick: an accepted order on no wave ends exactly as /cancel would — cancelled, lines reset, every hold released, ATP restored, restock.lines []', async () => {
    await seed('CR-PRE', binA, 10);
    expect(await atp('CR-PRE')).toEqual({ onHand: 10, atp: 10 });
    const viaCancel = await fixtures.createOrder([{ skuId: sku('CR-PRE'), quantity: 3 }]);
    const viaRestock = await fixtures.createOrder([{ skuId: sku('CR-PRE'), quantity: 4 }]);
    expect(await atp('CR-PRE')).toEqual({ onHand: 10, atp: 3 });

    await http().post(`${API}/${tenantId}/outbound/orders/${viaCancel}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
    const key = ulid();
    const res = await cancelRestock(viaRestock, {}, key).expect(200);
    expect(res.body.order.status).toBe('cancelled');
    expect(res.body.order.lines.map((line: { reservedQty: number; reservationId: string | null }) => [line.reservedQty, line.reservationId])).toEqual([[0, null]]);
    expect(res.body.restock).toMatchObject({ destination: 'origin', restockBinId: null, lines: [], totalUnits: 0, cancelledPickLineCount: 0, retiredReservationIds: [], handlingUnitIds: [], voidedShipment: null });
    expect(res.body.restock.releasedReservationIds).toHaveLength(1);
    // The END STATE equals cancelOrder's (A16): status, lines, holds, ATP.
    for (const orderId of [viaCancel, viaRestock]) {
      expect((await orderRow(orderId)).status).toBe('cancelled');
      expect(await holdStates(orderId)).toEqual(['released']);
      expect((await sql`select reserved_qty::text as q, reservation_id from order_lines where order_id = ${orderId}`) as unknown).toEqual([{ q: '0', reservation_id: null }]);
    }
    expect(await atp('CR-PRE')).toEqual({ onHand: 10, atp: 10 });
    await expectAuditRow({ tenantId, key, action: 'order.cancelled', targetType: 'order', targetId: viaRestock, actorUserId: opsUserId });

    // The same key replays the stored snapshot byte for byte; still one audit row.
    const replay = await cancelRestock(viaRestock, {}, key).expect(200);
    expect(replay.body).toEqual(res.body);
    await expectAuditRow({ tenantId, key, action: 'order.cancelled', targetType: 'order', targetId: viaRestock, actorUserId: opsUserId });
    // The discriminator (Gotcha 8): the same key on /cancel is a different command.
    const reuse = await http().post(`${API}/${tenantId}/outbound/orders/${viaRestock}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send({}).expect(422);
    expect(reuse.body.code).toBe('idempotency-key-reuse');
    // …and a /cancel key on this route.
    const cancelKey = ulid();
    const third = await fixtures.createOrder([{ skuId: sku('CR-PRE'), quantity: 1 }]);
    await http().post(`${API}/${tenantId}/outbound/orders/${third}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, cancelKey).send({}).expect(200);
    expect((await cancelRestock(third, {}, cancelKey).expect(422)).body.code).toBe('idempotency-key-reuse');
  });

  // ── matrix: mid-pick (AC1 ATP) ─────────────────────────────────────────────

  it('mid-pick: the drawn line is restocked into its origin bin on its lot, the planned line withdrawn, the held and committed holds ended — ATP back to its pre-order value; the plan reads both lists', async () => {
    await seed('CR-MID1', binA, 100, { batch: { code: 'L1' } });
    await seed('CR-MID2', binB, 50);
    const l1 = await batchIdOf('CR-MID1', 'L1');
    const { orderId, picklist } = await fixtures.releasedWave([
      { skuId: sku('CR-MID1'), quantity: 10 },
      { skuId: sku('CR-MID2'), quantity: 5 },
    ]);
    const drawn = picklist.lines.find((line) => line.skuId === sku('CR-MID1'))!;
    const planned = picklist.lines.find((line) => line.skuId === sku('CR-MID2'))!;
    await pickLine(drawn).expect(201);
    expect(await atp('CR-MID1')).toEqual({ onHand: 90, atp: 80 });
    expect((await holdStates(orderId)).sort()).toEqual(['committed', 'held']);

    const before = (await plan(orderId).expect(200)).body;
    expect(before).toMatchObject({ orderId, orderStatus: 'accepted', shipment: null, restocked: [] });
    expect(before.lines).toEqual([
      expect.objectContaining({ orderLineId: drawn.orderLineId, skuCode: 'CR-MID1', fromBinId: binA, fromBinCode: 'A-01-01', batchId: l1, batchCode: 'L1', qty: 10, serialNumbers: [], recallCode: null }),
    ]);

    const res = await cancelRestock(orderId).expect(200);
    expect(res.body.restock.lines).toEqual([
      expect.objectContaining({ orderLineId: drawn.orderLineId, skuCode: 'CR-MID1', toBinId: binA, toBinCode: 'A-01-01', batchId: l1, batchCode: 'L1', qty: 10, serialCount: 0, recallCode: null }),
    ]);
    expect(res.body.restock).toMatchObject({ totalUnits: 10, cancelledPickLineCount: 1 });
    expect(res.body.restock.releasedReservationIds).toHaveLength(1);
    expect(res.body.restock.retiredReservationIds).toHaveLength(1);
    expect(await atp('CR-MID1')).toEqual({ onHand: 100, atp: 100 });
    expect(await atp('CR-MID2')).toEqual({ onHand: 50, atp: 50 });
    expect(await holdStates(orderId)).toEqual(['released', 'released']);

    // The reversal is exact: one pick.restocked per draw, +qty into the draw's bin on its lot, naming the draw.
    const draws = await events(orderId, 'pick.picked');
    const restocks = await events(orderId, 'pick.restocked');
    expect(restocks).toHaveLength(draws.length);
    expect(restocks[0]).toMatchObject({ from_bin_id: null, to_bin_id: binA, quantity_delta: '10000', batch_ref: l1, serial_ref: null });
    expect(restocks[0]!.reference_doc).toEqual({
      kind: 'restock',
      restockId: res.body.restock.restockId,
      orderId,
      orderLineId: drawn.orderLineId,
      picklistLineId: drawn.id,
      drawEventId: draws[0]!.id,
    });
    const lines = (await sql`select id, status from picklist_lines where order_id = ${orderId}`) as unknown as { id: string; status: string }[];
    expect(new Map(lines.map((line) => [line.id, line.status]))).toEqual(new Map([[drawn.id, 'picked'], [planned.id, 'cancelled']]));
    // A drawn line is non-cancelled and bin-bearing, so its picklist stays `ready` (releaseWave's rule).
    expect(((await sql`select status from picklists where id = ${picklist.id}`) as unknown as { status: string }[])[0]!.status).toBe('ready');

    const after = (await plan(orderId).expect(200)).body;
    expect(after.orderStatus).toBe('cancelled');
    expect(after.lines).toEqual([]);
    expect(after.restocked).toEqual([
      expect.objectContaining({ orderLineId: drawn.orderLineId, skuCode: 'CR-MID1', toBinCode: 'A-01-01', batchCode: 'L1', qty: 10, serialCount: 0, restockId: res.body.restock.restockId }),
    ]);
  });

  // ── matrix: packed + labelled + catch weight (AC1) ────────────────────────

  it('packed + labelled: seed 100, accept 10, pick, pack, label, cancel → on-hand 100 and ATP 100; the label voided; the cases active again; order.cancelled and shipment.voided outbox and audit', async () => {
    await seed('CR-PACK', binA, 100);
    const cases = await fixtures.seedCatchWeightCases(sku('CR-CW'), binB, [2_100, 2_200, 2_300], 'operator-preference');
    const { orderId, picklist } = await fixtures.releasedWave([
      { skuId: sku('CR-PACK'), quantity: 10 },
      { skuId: sku('CR-CW'), quantity: 2 },
    ]);
    await fixtures.pickAllLines(picklist);
    await pack(orderId, [
      { skuId: sku('CR-PACK'), qty: 10 },
      { skuId: sku('CR-CW'), qty: 2, handlingUnitIds: [cases[0]!, cases[1]!] },
    ]).expect(201);
    const shipment = (await label(orderId).expect(201)).body.shipment as { id: string; carrierName: string; trackingNumber: string };
    expect(await atp('CR-PACK')).toEqual({ onHand: 90, atp: 80 });

    const pre = (await plan(orderId).expect(200)).body;
    expect(pre.orderStatus).toBe('ready_to_dispatch');
    expect(pre.shipment).toEqual({ id: shipment.id, status: 'labelled', carrierName: shipment.carrierName, trackingNumber: shipment.trackingNumber, manifestId: null });

    const key = ulid();
    const res = await cancelRestock(orderId, { restockBinId: binR.toUpperCase() }, key).expect(200);
    expect(res.body.restock).toMatchObject({ destination: 'bin', restockBinId: binR, totalUnits: 12, voidedShipment: { id: shipment.id, carrierName: shipment.carrierName, trackingNumber: shipment.trackingNumber } });
    expect(res.body.restock.handlingUnitIds).toEqual([cases[0]!, cases[1]!].sort());
    expect((res.body.restock.lines as RestockLine[]).map((line) => [line.skuCode, line.toBinCode, line.qty])).toEqual([
      ['CR-CW', 'R-01-01', 2],
      ['CR-PACK', 'R-01-01', 10],
    ]);
    expect(await atp('CR-PACK')).toEqual({ onHand: 100, atp: 100 });
    expect(await holdStates(orderId)).toEqual(['released', 'released']);

    const voided = (await sql`select status, voided_at, voided_by from shipments where id = ${shipment.id}`) as unknown as { status: string; voided_at: Date | null; voided_by: string | null }[];
    expect(voided[0]!.status).toBe('voided');
    expect(voided[0]!.voided_at).not.toBeNull();
    expect(voided[0]!.voided_by).toBe(opsUserId);
    const units = (await sql`select id, status, packed_order_line_id from handling_units where id = any(${[cases[0]!, cases[1]!, cases[2]!]}::uuid[]) order by id`) as unknown as { id: string; status: string; packed_order_line_id: string | null }[];
    expect(units.map((unit) => [unit.status, unit.packed_order_line_id])).toEqual([['active', null], ['active', null], ['active', null]]);
    // The order's timeline: a Restocked per draw.
    expect((await events(orderId, 'pick.restocked')).length).toBe((await events(orderId, 'pick.picked')).length);

    const outbox = (await sql`select type, payload from outbox_messages where tenant_id = ${tenantId} and type in ('order.cancelled', 'shipment.voided') and (payload -> 'order' ->> 'id' = ${orderId} or payload -> 'shipment' ->> 'orderId' = ${orderId}) order by type`) as unknown as { type: string; payload: Record<string, Record<string, unknown>> }[];
    expect(outbox.map((row) => row.type)).toEqual(['order.cancelled', 'shipment.voided']);
    expect(outbox[0]!.payload.restock!.restockId).toBe(res.body.restock.restockId);
    expect(outbox[1]!.payload.shipment).toMatchObject({ id: shipment.id, status: 'voided', trackingNumber: shipment.trackingNumber });
    // The new action's pin (AUDIT_NEW_ACTIONS): shipment.voided targets the order, beside order.cancelled.
    const audit = { tenantId, key, action: 'shipment.voided', targetType: 'order', targetId: orderId, actorUserId: opsUserId, alongside: [{ action: 'order.cancelled', targetType: 'order', targetId: orderId, actorUserId: opsUserId }] };
    await expectAuditRow({ tenantId, key, action: 'shipment.voided', targetType: 'order', targetId: orderId, actorUserId: opsUserId, alongside: audit.alongside });
    // The GET shipment read returns the voided row with its stamps.
    const read = (await http().get(`${API}/${tenantId}/outbound/orders/${orderId}/shipment`).set('Authorization', `Bearer ${operatorToken}`).expect(200)).body.shipment;
    expect(read).toMatchObject({ status: 'voided', voidedBy: opsUserId });
    expect(typeof read.voidedAt).toBe('string');

    // Replay: the stored snapshot, nothing twice.
    expect((await cancelRestock(orderId, { restockBinId: binR }, key).expect(200)).body).toEqual(res.body);
    await expectAuditRow(audit);

    // The bench's queued pack now meets a cancelled order: its own code (decision 15).
    const late = await pack(orderId, [{ skuId: sku('CR-PACK'), qty: 10 }]).expect(409);
    expect(late.body.code).toBe('order-cancelled');
    expect(late.body.detail).toContain('restock list is on the web');
    // The case is packable on another order again: a fresh order packs it.
    const again = await fixtures.releasedWave([{ skuId: sku('CR-CW'), quantity: 1 }]);
    await fixtures.pickAllLines(again.picklist);
    await pack(again.orderId, [{ skuId: sku('CR-CW'), qty: 1, handlingUnitIds: [cases[0]!] }]).expect(201);
  });

  // ── matrix: serials (A4) ───────────────────────────────────────────────────

  it('serials: three serials drawn from A-02 come back as three intakes into A-02, each located there again; the plan names them', async () => {
    await seed('CR-SER', binB, 3, { serials: ['CR-S1', 'CR-S2', 'CR-S3'] });
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-SER'), quantity: 3 }]);
    await fixtures.pickAllLines(picklist, undefined, new Map([[picklist.lines[0]!.id, ['CR-S1', 'CR-S2', 'CR-S3']]]));
    expect((await plan(orderId).expect(200)).body.lines[0].serialNumbers).toEqual(['CR-S1', 'CR-S2', 'CR-S3']);
    const res = await cancelRestock(orderId).expect(200);
    expect(res.body.restock.lines).toEqual([expect.objectContaining({ skuCode: 'CR-SER', toBinId: binB, qty: 3, serialCount: 3 })]);
    // A10 — the snapshot carries counts, never the serial list.
    expect(JSON.stringify(res.body)).not.toContain('CR-S1');
    const restocks = await events(orderId, 'pick.restocked');
    expect(restocks).toHaveLength(3);
    for (const event of restocks) {
      expect(await inventory.serialLocation(tenantId, event.serial_ref!)).toEqual({ warehouseId: wh, binId: binB });
    }
    expect((await plan(orderId).expect(200)).body.restocked).toEqual([expect.objectContaining({ qty: 3, serialCount: 3 })]);
  });

  it('A4: a serial adjusted back into stock while it sat in the tote refuses the cancel (restock-serial-moved, naming it) — nothing written', async () => {
    await seed('CR-SMV', binB, 2, { serials: ['CR-M1', 'CR-M2'] });
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-SMV'), quantity: 2 }]);
    await fixtures.pickAllLines(picklist, undefined, new Map([[picklist.lines[0]!.id, ['CR-M1', 'CR-M2']]]));
    // Someone found CR-M2 and booked it into another bin by adjustment.
    await adjust({ skuId: sku('CR-SMV'), binId: binC, quantityDelta: 1, serials: ['CR-M2'] }).expect(201);
    const key = ulid();
    const res = await cancelRestock(orderId, {}, key).expect(409);
    expect(res.body.code).toBe('restock-serial-moved');
    expect(res.body.detail).toContain('CR-M2');
    expect(res.body.detail).toContain('C-01-01');
    await expectUntouched(orderId, key, 'accepted', ['committed']);
  });

  // ── matrix: one bin; the destination refusals (A11) ───────────────────────

  it('one bin: restockBinId R lands every draw in R; the destination arms — malformed 400, unknown or another warehouse’s 404, a system bin 400', async () => {
    await seed('CR-ONE', binA, 4);
    await seed('CR-ONE', binX, 4);
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-ONE'), quantity: 6 }]);
    await fixtures.pickAllLines(picklist);
    expect(new Set((await events(orderId, 'pick.picked')).map((event) => event.from_bin_id))).toEqual(new Set([binA, binX]));

    const malformed = await cancelRestock(orderId, { restockBinId: 'not-a-uuid' }).expect(400);
    expect(malformed.body.code).toBe('validation-failed');
    expect((await cancelRestock(orderId, { restockBinId: uuidv7() }).expect(404)).body.code).toBe('not-found');
    expect((await cancelRestock(orderId, { restockBinId: otherWhBin }).expect(404)).body.code).toBe('not-found');
    const system = await cancelRestock(orderId, { restockBinId: systemBin }).expect(400);
    expect(system.body.code).toBe('validation-failed');
    expect((await orderRow(orderId)).status).toBe('accepted');

    const res = await cancelRestock(orderId, { restockBinId: binR }).expect(200);
    expect((res.body.restock.lines as RestockLine[]).map((line) => [line.toBinId, line.qty])).toEqual([[binR, 6]]);
    expect(new Set((await events(orderId, 'pick.restocked')).map((event) => event.to_bin_id))).toEqual(new Set([binR]));
  });

  it('origin bin refused: a draw whose origin bin is now blocked refuses the whole cancel with the gate’s code naming the bin — nothing written; "All into one bin" then succeeds', async () => {
    await seed('CR-BLK', binC, 5);
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-BLK'), quantity: 2 }]);
    await fixtures.pickAllLines(picklist);
    await sql`update bins set blocked = true where id = ${binC}`;
    try {
      const key = ulid();
      const res = await cancelRestock(orderId, {}, key).expect(409);
      expect(res.body.code).toBe('bin-blocked');
      expect(res.body.detail).toContain('C-01-01');
      await expectUntouched(orderId, key, 'accepted', ['committed']);
      await cancelRestock(orderId, { restockBinId: binR }).expect(200);
    } finally {
      await sql`update bins set blocked = false where id = ${binC}`;
    }
  });

  it('named bin of the wrong class: a frozen SKU into an ambient bin is bin-storage-mismatch — nothing written; back to its frozen origin succeeds', async () => {
    await seed('CR-FRZ', binF, 5);
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-FRZ'), quantity: 2 }]);
    await fixtures.pickAllLines(picklist);
    const key = ulid();
    const res = await cancelRestock(orderId, { restockBinId: binR }, key).expect(409);
    expect(res.body.code).toBe('bin-storage-mismatch');
    await expectUntouched(orderId, key, 'accepted', ['committed']);
    const ok = await cancelRestock(orderId).expect(200);
    expect(ok.body.restock.lines[0]).toMatchObject({ toBinId: binF, qty: 2 });
  });

  it('quarantined scope: (SKU, destination) under an open reconcile quarantine is restock-scope-quarantined — nothing written', async () => {
    await seed('CR-QUA', binA, 5);
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-QUA'), quantity: 2 }]);
    await fixtures.pickAllLines(picklist);
    const quarantineId = uuidv7();
    await sql`insert into inventory_quarantines (id, tenant_id, warehouse_id, sku_id, bin_id, from_seq, to_seq, reason, status)
      values (${quarantineId}, ${tenantId}, ${wh}, ${sku('CR-QUA')}, ${binA}, 1, 1, 'suite probe', 'open')`;
    try {
      const key = ulid();
      const res = await cancelRestock(orderId, {}, key).expect(409);
      expect(res.body.code).toBe('restock-scope-quarantined');
      expect(res.body.detail).toContain('A-01-01');
      await expectUntouched(orderId, key, 'accepted', ['committed']);
      // Another bin is not quarantined.
      await cancelRestock(orderId, { restockBinId: binR }).expect(200);
    } finally {
      await sql`update inventory_quarantines set status = 'resolved' where id = ${quarantineId}`;
    }
  });

  // ── matrix: manifested, dispatched, already cancelled ─────────────────────

  it('manifested: shipment-manifested naming the manifest — nothing written', async () => {
    await seed('CR-MAN', binA, 5);
    const orderId = await packedOrder('CR-MAN', 2);
    const shipment = (await label(orderId).expect(201)).body.shipment as { id: string };
    const manifest = await http().post(`${API}/${tenantId}/warehouses/${wh}/outbound/manifests`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ shipmentIds: [shipment.id] }).expect(201);
    const manifestId = manifest.body.manifest.id as string;
    const key = ulid();
    const res = await cancelRestock(orderId, {}, key).expect(409);
    expect(res.body.code).toBe('shipment-manifested');
    expect(res.body.detail).toContain(manifestId);
    expect(res.body).toMatchObject({ manifestId, shipmentId: shipment.id });
    await expectUntouched(orderId, key, 'ready_to_dispatch', ['committed']);
    expect((await plan(orderId).expect(200)).body.shipment).toMatchObject({ status: 'manifested', manifestId });
  });

  it('dispatched: order-dispatched — the parcel shipped, so it comes back as a return', async () => {
    await seed('CR-DSP', binA, 5);
    const orderId = await packedOrder('CR-DSP', 1);
    await http().post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(201);
    const key = ulid();
    const res = await cancelRestock(orderId, {}, key).expect(409);
    expect(res.body.code).toBe('order-dispatched');
    expect(await keyStored(key)).toBe(false);
    // The plan of a dispatched order lists nothing to put back.
    expect((await plan(orderId).expect(200)).body.lines).toEqual([]);
  });

  it('already cancelled under a new key: 200 with the current order, restock null, the key stored, no audit row; an unknown order 404; the plan of an unknown order 404', async () => {
    await seed('CR-AGN', binA, 5);
    const orderId = await packedOrder('CR-AGN', 1);
    await cancelRestock(orderId).expect(200);
    const auditsBefore = await count(sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and target_id = ${orderId}`);
    const key = noOpIdempotencyKey(tenantId, ulid(), 'orders.cancelOrderWithRestock:already-cancelled');
    const res = await cancelRestock(orderId, {}, key).expect(200);
    expect(res.body.restock).toBeNull();
    expect(res.body.order.status).toBe('cancelled');
    expect(await keyStored(key)).toBe(true);
    expect(await count(sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and target_id = ${orderId}`)).toBe(auditsBefore);
    expect((await cancelRestock(uuidv7()).expect(404)).body.code).toBe('not-found');
    await plan(uuidv7()).expect(404);
  });

  it('orders.manage only: an operator is 403 role-denied before anything is read', async () => {
    await seed('CR-ARM', binA, 3);
    const orderId = await fixtures.createOrder([{ skuId: sku('CR-ARM'), quantity: 1 }]);
    const key = ulid();
    expect((await cancelRestock(orderId, {}, key, operatorToken).expect(403)).body.code).toBe('role-denied');
    expect(await keyStored(key)).toBe(false);
    await cancelRestock(orderId).expect(200);
  });

  // ── code review: the remaining destination arms, the void precondition ──

  it('code review: a named bin that cannot take the summed intake is refused by its load gate (bin-full) — nothing written', async () => {
    const small = await createBinWithCapacity('S-01-01', 1);
    await seed('CR-ONE', binA, 5);
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-ONE'), quantity: 3 }]);
    await fixtures.pickAllLines(picklist);
    const key = ulid();
    const res = await cancelRestock(orderId, { restockBinId: small }, key).expect(409);
    expect(res.body.code).toBe('bin-full');
    expect(res.body.detail).toContain('S-01-01');
    await expectUntouched(orderId, key, 'accepted', ['committed']);
    await cancelRestock(orderId).expect(200);
  });

  it('code review: on an order with no draws a named bin still meets the structural arms — retired and blocked are refused by their own codes', async () => {
    const retired = await createBin(wh, zoneId, 'T-01-01');
    const blocked = await createBin(wh, zoneId, 'T-01-02');
    await sql`update bins set retired_at = now(), retired_by = ${opsUserId} where id = ${retired}`;
    await sql`update bins set blocked = true where id = ${blocked}`;
    await seed('CR-ARM', binA, 3);
    const orderId = await fixtures.createOrder([{ skuId: sku('CR-ARM'), quantity: 1 }]);
    expect((await cancelRestock(orderId, { restockBinId: retired }).expect(409)).body.code).toBe('bin-retired');
    expect((await cancelRestock(orderId, { restockBinId: blocked }).expect(409)).body.code).toBe('bin-blocked');
    expect((await orderRow(orderId)).status).toBe('accepted');
    await cancelRestock(orderId).expect(200);
  });

  it('code review: a serial drawn again by another event while in the tote is restock-serial-moved ("drawn by another event")', async () => {
    await seed('CR-SMV2', binB, 1, { serials: ['CR-M9'] });
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-SMV2'), quantity: 1 }]);
    await fixtures.pickAllLines(picklist, undefined, new Map([[picklist.lines[0]!.id, ['CR-M9']]]));
    // Found, booked in, and written off again — its latest event is another draw.
    await adjust({ skuId: sku('CR-SMV2'), binId: binC, quantityDelta: 1, serials: ['CR-M9'] }).expect(201);
    await adjust({ skuId: sku('CR-SMV2'), binId: binC, quantityDelta: -1, serials: ['CR-M9'], reasonCode: 'damaged' }).expect(201);
    const key = ulid();
    const res = await cancelRestock(orderId, {}, key).expect(409);
    expect(res.body.code).toBe('restock-serial-moved');
    expect(res.body.detail).toContain('CR-M9 was drawn by another event');
    await expectUntouched(orderId, key, 'accepted', ['committed']);
  });

  it('code review: a label booked with a real courier is not voided locally — shipment-void-unsupported, nothing written', async () => {
    await seed('CR-MAN', binA, 3);
    const orderId = await packedOrder('CR-MAN', 1);
    const shipmentId = uuidv7();
    seededShipments.push(shipmentId);
    await sql`insert into shipments (id, tenant_id, warehouse_id, order_id, status, carrier_connection_id, carrier_code, carrier_name, tracking_number, label_document_ref, labelled_by, labelled_at)
      values (${shipmentId}, ${tenantId}, ${wh}, ${orderId}, 'labelled', ${sandboxConnectionId}, 'delhivery', 'Delhivery', 'DLV-1', 'delhivery://label/1', ${opsUserId}, now())`;
    try {
      const key = ulid();
      const res = await cancelRestock(orderId, {}, key).expect(409);
      expect(res.body.code).toBe('shipment-void-unsupported');
      expect(res.body).toMatchObject({ shipmentId, carrierCode: 'delhivery' });
      await expectUntouched(orderId, key, 'ready_to_dispatch', ['committed']);
      expect(((await sql`select status from shipments where id = ${shipmentId}`) as unknown as { status: string }[])[0]!.status).toBe('labelled');
    } finally {
      await sql`delete from shipments where id = ${shipmentId}`;
    }
    await cancelRestock(orderId).expect(200);
  });

  it('code review: a pick that waited on the warehouse lock behind a cancel is refused naming the cancel, and tells the picker to put the units back', async () => {
    await seed('CR-PRE', binX, 5);
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-PRE'), quantity: 1 }]);
    let picking: Promise<request.Response> | undefined;
    let cancelling: Promise<request.Response> | undefined;
    await holdingAdvisory(async () => {
      cancelling = (async () => cancelRestock(orderId))();
      await waitParked(1);
      picking = (async () => pickLine(picklist.lines[0]!))();
      await waitParked(2);
    });
    expect((await cancelling!).status).toBe(200);
    const res = await picking!;
    expect([res.status, res.body.code]).toEqual([409, 'pick-unresolvable']);
    expect(res.body.detail).toContain('reads "cancelled"');
    expect(res.body.detail).toContain('put them back in the bin you picked from');
    expect(await events(orderId, 'pick.picked')).toEqual([]);
  });

  // ── the races ──────────────────────────────────────────────────────────────

  it('same-key race: two identical cancels parked on the order row answer the same body — one restock, one key', async () => {
    await seed('CR-RACE', binA, 5);
    const orderId = await packedOrder('CR-RACE', 2);
    const key = ulid();
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        await tx`select 1 from orders where id = ${orderId} for update`;
        first = (async () => cancelRestock(orderId, {}, key))();
        second = (async () => cancelRestock(orderId, {}, key))();
        await waitParked(2);
      });
      const [a, b] = await Promise.all([first!, second!]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(b.body).toEqual(a.body);
    } finally {
      await Promise.allSettled([first, second]);
      await holder.end();
    }
    expect(await events(orderId, 'pick.restocked')).toHaveLength(1);
    expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${key}`)).toBe(1);
  });

  it('pick races cancel: a pick committing between the first draw read and the warehouse lock is 409 conflict — nothing written', async () => {
    await seed('CR-PRC1', binA, 5);
    await seed('CR-PRC2', binB, 5);
    const { orderId, picklist } = await fixtures.releasedWave([
      { skuId: sku('CR-PRC1'), quantity: 1 },
      { skuId: sku('CR-PRC2'), quantity: 1 },
    ]);
    await pickLine(picklist.lines.find((line) => line.skuId === sku('CR-PRC1'))!).expect(201);
    const key = ulid();
    let picking: Promise<request.Response> | undefined;
    let cancelling: Promise<request.Response> | undefined;
    await holdingAdvisory(async () => {
      picking = (async () => pickLine(picklist.lines.find((line) => line.skuId === sku('CR-PRC2'))!))();
      await waitParked(1);
      cancelling = (async () => cancelRestock(orderId, {}, key))();
      await waitParked(2);
    });
    expect((await picking!).status).toBe(201);
    const res = await cancelling!;
    expect([res.status, res.body.code]).toEqual([409, 'conflict']);
    expect(res.body.detail).toContain('was picked while it was being cancelled');
    await expectUntouched(orderId, key, 'accepted', ['committed', 'committed']);
    // Cancel again: both draws come back.
    expect((await cancelRestock(orderId).expect(200)).body.restock.lines).toHaveLength(2);
  });

  it('A2: a zero-unit short pick held on the warehouse lock while the cancel waits — the cancel sees its re-planned slice and re-granted hold, and leaves no held hold and no planned line', async () => {
    await seed('CR-ZERO', binX, 5);
    await seed('CR-ZERO', binY, 5);
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-ZERO'), quantity: 3 }]);
    const line = picklist.lines[0]!;
    let picking: Promise<request.Response> | undefined;
    let cancelling: Promise<request.Response> | undefined;
    await holdingAdvisory(async () => {
      picking = (async () => pickLine(line, { qty: 0, reasonCode: 'bin-empty' }))();
      await waitParked(1);
      cancelling = (async () => cancelRestock(orderId))();
      await waitParked(2);
    });
    expect((await picking!).status).toBe(201);
    const res = await cancelling!;
    expect(res.status).toBe(200);
    expect(res.body.restock.lines).toEqual([]);
    expect(await holdStates(orderId)).not.toContain('held');
    expect(await count(sql`select count(*)::int as n from picklist_lines where order_id = ${orderId} and status = 'planned'`)).toBe(0);
    expect(await atp('CR-ZERO')).toEqual({ onHand: 10, atp: 10 });
  });

  it('A5: a hold the reaper expires while the cancel waits on it is skipped, not fatal — the cancel commits', async () => {
    await seed('CR-REAP', binA, 5);
    const orderId = await fixtures.createOrder([{ skuId: sku('CR-REAP'), quantity: 2 }]);
    const holdId = ((await sql`select reservation_id from order_lines where order_id = ${orderId}`) as unknown as { reservation_id: string }[])[0]!.reservation_id;
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    let cancelling: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        await tx`update reservations set state = 'expired' where id = ${holdId}`;
        cancelling = (async () => cancelRestock(orderId))();
        await waitParked(1);
      });
    } finally {
      await holder.end();
    }
    const res = await cancelling!;
    expect(res.status).toBe(200);
    expect(res.body.restock.releasedReservationIds).toEqual([]);
    expect((await orderRow(orderId)).status).toBe('cancelled');
    expect(await holdStates(orderId)).toEqual(['expired']);
    await inventory.rebuildReservationCounters(tenantId, wh);
  });

  // ── A6: the batch picklist ─────────────────────────────────────────────────

  it('A6: a batch picklist spanning orders X and Y — X cancelled mid-pick withdraws X’s planned lines only; Y’s stay planned and the picklist stays ready', async () => {
    await seed('CR-BAT', binA, 20);
    await seed('CR-MID2', binB, 20);
    const x = await fixtures.createOrder([{ skuId: sku('CR-BAT'), quantity: 2 }, { skuId: sku('CR-MID2'), quantity: 1 }]);
    const y = await fixtures.createOrder([{ skuId: sku('CR-BAT'), quantity: 3 }]);
    const policyId = (await http().post(`${API}/${tenantId}/outbound/wave-policies`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ warehouseId: wh, name: `batch-${ulid().slice(10, 18)}`, grouping: 'batch' }).expect(201)).body.policy.id as string;
    const waveId = (await http().post(`${API}/${tenantId}/outbound/waves`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ warehouseId: wh, policyId, orderIds: [x, y] }).expect(201)).body.wave.id as string;
    await http().post(`${API}/${tenantId}/outbound/waves/${waveId}/release`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
    const wave = (await http().get(`${API}/${tenantId}/outbound/waves/${waveId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.wave as { picklists: Picklist[] };
    expect(wave.picklists).toHaveLength(1);
    const picklist = wave.picklists[0]!;
    await pickLine(picklist.lines.find((line) => line.orderId === x && line.skuId === sku('CR-BAT'))!).expect(201);
    await cancelRestock(x).expect(200);
    const lines = (await sql`select order_id, status from picklist_lines where picklist_id = ${picklist.id} order by order_id, status`) as unknown as { order_id: string; status: string }[];
    expect(lines.filter((line) => line.order_id === x).map((line) => line.status).sort()).toEqual(['cancelled', 'picked']);
    expect(lines.filter((line) => line.order_id === y).map((line) => line.status)).toEqual(['planned']);
    expect(((await sql`select status from picklists where id = ${picklist.id}`) as unknown as { status: string }[])[0]!.status).toBe('ready');
    expect(((await sql`select status from waves where id = ${waveId}`) as unknown as { status: string }[])[0]!.status).toBe('released');
    expect((await orderRow(y)).status).toBe('accepted');
  });

  // ── A3: the pack's case set ────────────────────────────────────────────────

  it('A3: a case the pack recorded that is no longer packed into the order refuses the cancel (handling-unit-not-packed, naming it and its status) — nothing written', async () => {
    const cases = await fixtures.seedCatchWeightCases(sku('CR-HU'), binB, [1_500], 'operator-preference');
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-HU'), quantity: 1 }]);
    await fixtures.pickAllLines(picklist);
    await pack(orderId, [{ skuId: sku('CR-HU'), qty: 1, handlingUnitIds: [cases[0]!] }]).expect(201);
    await sql`update handling_units set status = 'rejected', packed_order_line_id = null where id = ${cases[0]!}`;
    try {
      const key = ulid();
      const res = await cancelRestock(orderId, {}, key).expect(409);
      expect(res.body.code).toBe('handling-unit-not-packed');
      expect(res.body.detail).toContain(`${cases[0]!} (rejected)`);
      await expectUntouched(orderId, key, 'ready_to_dispatch', ['committed']);
    } finally {
      const line = ((await sql`select id from order_lines where order_id = ${orderId}`) as unknown as { id: string }[])[0]!.id;
      await sql`update handling_units set status = 'packed', packed_order_line_id = ${line} where id = ${cases[0]!}`;
    }
    await cancelRestock(orderId).expect(200);
  });

  // ── the 3-7a fold-in: an order holding a recalled lot ─────────────────────

  it('3-7a: an order holding a recalled lot (dispatch refused) gets out through cancel-with-restock — its hold retired, the units back on hand but the lot stays blocked and out of ATP; the plan and the put-back name the recall; the recall’s held figure drops to 0', async () => {
    await seed('CR-RCL', binA, 10, { batch: { code: 'RL-1' } });
    const lot = await batchIdOf('CR-RCL', 'RL-1');
    const orderId = await packedOrder('CR-RCL', 4);
    const opened = await http().post(`${API}/${tenantId}/inventory/recalls`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ batchIds: [lot], reasonNote: 'cancel-restock suite' }).expect(201);
    const recall = opened.body.recall as { id: string; code: string };
    const refused = await http().post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(409);
    expect(refused.body.code).toBe('order-holds-recalled-batch');
    const heldBefore = (await http().get(`${API}/${tenantId}/inventory/recalls/${recall.id}`).set('Authorization', `Bearer ${operatorToken}`).expect(200)).body.lots[0].figures;
    expect(heldBefore).toMatchObject({ heldInOpenOrders: 4, onHand: 6 });

    expect((await plan(orderId).expect(200)).body.lines).toEqual([expect.objectContaining({ batchId: lot, batchCode: 'RL-1', qty: 4, recallCode: recall.code })]);
    const res = await cancelRestock(orderId, { restockBinId: binR }).expect(200);
    expect(res.body.restock.lines).toEqual([expect.objectContaining({ toBinId: binR, batchId: lot, qty: 4, recallCode: recall.code })]);
    expect(res.body.restock.retiredReservationIds).toHaveLength(1);
    expect(await holdStates(orderId)).toEqual(['released']);
    // A recall moves no stock: the lot stays blocked wherever it lands, so ATP stays 0 (A17).
    expect(((await sql`select status, blocked_reason from batches where id = ${lot}`) as unknown as { status: string; blocked_reason: string }[])[0]).toEqual({ status: 'blocked', blocked_reason: 'recall' });
    expect(await atp('CR-RCL')).toEqual({ onHand: 10, atp: 0 });
    const after = (await http().get(`${API}/${tenantId}/inventory/recalls/${recall.id}`).set('Authorization', `Bearer ${operatorToken}`).expect(200)).body;
    expect(after.lots[0].figures).toMatchObject({ heldInOpenOrders: 0, onHand: 10, dispatched: 0, unaccounted: 0 });
    expect(after.heldOrders).toEqual([]);
    expect((await plan(orderId).expect(200)).body.restocked).toEqual([expect.objectContaining({ toBinCode: 'R-01-01', qty: 4, recallCode: recall.code })]);
  });

  it('A17: a batch blocked since the pick is restocked into on-hand but stays out of ATP', async () => {
    await seed('CR-EXP', binA, 5, { batch: { code: 'EX-1' } });
    const lot = await batchIdOf('CR-EXP', 'EX-1');
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('CR-EXP'), quantity: 2 }]);
    await fixtures.pickAllLines(picklist);
    await http().post(`${API}/${tenantId}/inventory/batches/${lot}/block`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ reason: 'qc-failed', note: 'suite' }).expect(201);
    await cancelRestock(orderId).expect(200);
    expect(await atp('CR-EXP')).toEqual({ onHand: 5, atp: 0 });
  });

  // ── the register ───────────────────────────────────────────────────────────

  it('the outbound register no longer names a voided label as the order’s shipment', async () => {
    await seed('CR-REG', binA, 5);
    const orderId = await packedOrder('CR-REG', 1);
    await label(orderId).expect(201);
    const rowsOf = async (): Promise<{ orderId: string; shipmentTracking: string | null }[]> =>
      withTenantTransaction(db, tenantId, (tx) =>
        outbound.outboundRegisterInTx(tx, { tenantId, warehouseId: wh, clientId: null, from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' }, 5_000),
      ) as unknown as Promise<{ orderId: string; shipmentTracking: string | null }[]>;
    expect((await rowsOf()).find((row) => row.orderId === orderId)!.shipmentTracking).not.toBeNull();
    await cancelRestock(orderId).expect(200);
    expect((await rowsOf()).find((row) => row.orderId === orderId)!.shipmentTracking).toBeNull();
  });

  // ── the pure draw rule ─────────────────────────────────────────────────────

  it('outstandingDraws: a draw a pick.restocked names is no longer outstanding; a non-pick event never is', () => {
    const base = { tenantId, warehouseId: wh, skuId: sku('CR-PRE'), batchRef: null, serialRef: null, toBinId: null } as const;
    const draw = { ...base, id: 'd1', type: 'pick.picked', quantityDelta: -1000, fromBinId: binA, referenceDoc: { kind: 'pick' } } as never;
    const other = { ...base, id: 'd2', type: 'pick.picked', quantityDelta: -1000, fromBinId: binA, referenceDoc: { kind: 'pick' } } as never;
    const restock = { ...base, id: 'r1', type: 'pick.restocked', quantityDelta: 1000, fromBinId: null, toBinId: binA, referenceDoc: { kind: 'restock', drawEventId: 'd1' } } as never;
    const packed = { ...base, id: 'p1', type: 'pack.packed', quantityDelta: 0, fromBinId: null, referenceDoc: { kind: 'pack' } } as never;
    expect(outstandingDraws([draw, other, restock, packed]).map((event: { id: string }) => event.id)).toEqual(['d2']);
  });

});
