import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { sql as dsql } from 'drizzle-orm';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { OutboundFacade } from '../src/modules/outbound/outbound.facade';
import { cancelOrderTestHooks } from '../src/modules/outbound/order.command';
import {
  ALLOCATE_COMMAND_KIND,
  AllocationCommandService,
  backorderAllocationClock,
  backorderCandidatesSql,
} from '../src/modules/outbound/allocation.command';
import { readServiceFiguresInTx } from '../src/modules/reporting/service';
import { BackorderAllocationWorker } from '../src/jobs/jobs.module';
import { ProblemException } from '../src/shared/problem-details/problem.exception';
import { orderLabelOf, orderLabelSql } from '../src/shared/primitives/order-label';
import { SYSTEM_ACTOR_ID } from '../src/shared/primitives/audit';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import type { Picklist, Wave } from './support/dispatched-order';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.CARRIER_ENCRYPTION_KEY ??= 'e2e-only-carrier-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.BACKORDER_ALLOCATION_POLL_MS;

jest.setTimeout(300_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

function userIdOf(token: string): string {
  return (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string }).sub;
}

function nowZ(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Today's IST date (the ship-by bound is today..today+365 on the real clock). */
function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

interface OrderLineView {
  id: string;
  skuId: string;
  qty: number;
  reservedQty: number;
  shortfallQty: number;
  status: string;
  reservationId: string | null;
  reservationState: string | null;
  parentLineId: string | null;
}

interface OrderView {
  id: string;
  status: string;
  clientOrderRef: string | null;
  codAmountPaise: number | null;
  shipByDate: string | null;
  priority: string;
  orderType: string | null;
  followOnOfOrderId: string | null;
  followOnRootOrderId: string | null;
  followOnSeq: number | null;
  followOnOrderId: string | null;
  lines: OrderLineView[];
}

/**
 * Story 4-2c — the backorder follow-on: a short dispatch opens a follow-on
 * order for the unshipped remainder (decisions 1–4, A9, A10, A12), and the
 * backorder allocation re-reserves hold-less backordered lines (decision 5,
 * A1–A8): the sweep job, the after-dispatch attempt and "Allocate now". Every
 * row of the spec's I/O matrix and amended matrix that is not a channel row
 * (those are in test/channel-writeback.spec.ts), AC1–AC3, AC5 and the code
 * review's patches (C-numbered in the spec's triage log).
 */
describe('story 4-2c: the backorder follow-on and the allocation (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let db: Database;
  let inventory: InventoryFacade;
  let outbound: OutboundFacade;
  let allocation: AllocationCommandService;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorWebToken: string;
  let deviceOperatorToken: string;
  let wh: string;
  let zoneId: string;
  let binA: string;
  let binB: string;
  let acme: string;
  let beta: string;
  const skuIds = new Map<string, string>();
  const http = () => request(app.getHttpServer());
  const sku = (code: string): string => {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  };

  // code,name,uom,uom_conversions,gst_rate,hsn,batch,serial,catch_weight,rp,rq,barcode
  const SKU_ROWS: readonly string[] = [
    'FO-A,Short shipped,pcs,,1800,,false,false,false,,,',
    'FO-B,Shipped in full,pcs,,1800,,false,false,false,,,',
    'FO-AC2,Stock arrives,pcs,,1800,,false,false,false,,,',
    'FO-TWICE,Second short,pcs,,1800,,false,false,false,,,',
    'FO-FULL,Full dispatch,pcs,,1800,,false,false,false,,,',
    'FO-NOW,After dispatch,pcs,,1800,,false,false,false,,,',
    'FO-WHOLE,Wholly backordered,pcs,,1800,,false,false,false,,,',
    'FO-WAVE,On a wave,pcs,,1800,,false,false,false,,,',
    'FO-VERB,Allocate now,pcs,,1800,,false,false,false,,,',
    'FO-PART,Partial allocation,pcs,,1800,,false,false,false,,,',
    'FO-ZERO,Zero-unit pack,pcs,,1800,,false,false,false,,,',
    'FO-KIT,Gift kit,pcs,,1800,,false,false,false,,,',
    'FO-KA,Kit part A,pcs,,1800,,false,false,false,,,',
    'FO-KB,Kit part B,pcs,,1800,,false,false,false,,,',
    'FO-COD,Cash order,pcs,,1800,,false,false,false,,,',
    'FO-KG,Weighed,kg,,500,,false,false,false,,,',
    'FO-EXP,Expired hold,pcs,,1800,,false,false,false,,,',
    'FO-ORPH,Orphan hold,pcs,,1800,,false,false,false,,,',
    'FO-RACE,Two allocators,pcs,,1800,,false,false,false,,,',
    'FO-VRACE,Verb same-key race,pcs,,1800,,false,false,false,,,',
    'FO-CXL,Cancel race,pcs,,1800,,false,false,false,,,',
    'FO-INACT,Inactive SKU,pcs,,1800,,false,false,false,,,',
    'FO-DRUG,Scheduled drug,pcs,,1200,,false,false,false,,,',
    'FO-LOT,Blocked lot,pcs,,1800,,true,false,false,,,',
    'FO-CROWD,Sweep crowding,pcs,,1800,,false,false,false,,,',
    'FO-ROUT,Sweep routine,pcs,,1800,,false,false,false,,,',
    'FO-PT1,Pack task picked,pcs,,1800,,false,false,false,,,',
    'FO-PT2,Pack task unpicked,pcs,,1800,,false,false,false,,,',
    'FO-KG2,Weighed bench,kg,,500,,false,false,false,,,',
    'FO-503,Store outage,pcs,,1800,,false,false,false,,,',
    'FO-5032,Store outage second,pcs,,1800,,false,false,false,,,',
    'FO-NT,After dispatch never throws,pcs,,1800,,false,false,false,,,',
    'FO-GONE,Released before the write,pcs,,1800,,false,false,false,,,',
    'FO-TICK,Worker tick,pcs,,1800,,false,false,false,,,',
  ];

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('order_follow_on');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 6, onnotice: () => undefined });
    db = app.get<Database>(DATABASE);
    inventory = app.get(InventoryFacade);
    outbound = app.get(OutboundFacade);
    allocation = app.get(AllocationCommandService);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Follow-on Co ${ulid()}`, ownerEmail: email, password: PASSWORD }).expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
    opsToken = (await createMember('ops_manager')).token;
    opsUserId = userIdOf(opsToken);
    operatorWebToken = (await createMember('operator')).token;

    wh = await createWarehouse(`FO-${ulid().slice(20)}`);
    zoneId = await createZone(wh, 'A');
    binA = await createBin(wh, zoneId, 'A-01-01');
    binB = await createBin(wh, zoneId, 'B-01-01');

    acme = await createClient('ACME', 'Acme Foods');
    beta = await createClient('BETA', 'Beta Brands');
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
    // The kit: FO-KIT = 1 × FO-KA + 2 × FO-KB.
    await http()
      .post(`${API}/${tenantId}/catalog/skus/${sku('FO-KIT')}/kit`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: sku('FO-KA'), quantity: 1 }, { skuId: sku('FO-KB'), quantity: 2 }] })
      .expect(201);

    const floor = await createMember('operator');
    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({}).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'FO dock', pin: '2468' }).expect(201);
    deviceOperatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: floor.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;
    await inventory.rebuildReservationCounters(tenantId, wh);
  });

  afterAll(async () => {
    cancelOrderTestHooks.afterPrecheck = undefined;
    backorderAllocationClock.now = () => new Date();
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

  async function createBin(warehouseId: string, zone: string, code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, capacity: 1_000_000, type: 'shelf' })
        .expect(201)
    ).body.id as string;
  }

  async function createClient(code: string, name: string): Promise<string> {
    return (await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name }).expect(201)).body.client.id as string;
  }

  async function seed(skuCode: string, qty: number, binId = binA, extra: Record<string, unknown> = {}, warehouseId = wh): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: sku(skuCode), binId, quantityDelta: qty, reasonCode: 'stock-count', note: 'follow-on suite', ...extra })
      .expect(201);
  }

  async function createOrder(lines: { skuId: string; quantity: number; ratePaise?: number }[], extra: Record<string, unknown> = {}, warehouseId = wh): Promise<OrderView> {
    const res = await http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines, destination: testAddress(), ...extra })
      .expect(201);
    return res.body.order as OrderView;
  }

  async function getOrder(orderId: string): Promise<OrderView> {
    return (await http().get(`${API}/${tenantId}/outbound/orders/${orderId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.order as OrderView;
  }

  /** A released single-order wave over these existing orders. */
  async function wave(orderIds: string[], warehouseId = wh, maxOrders?: number): Promise<Wave> {
    const policyId = (
      await http()
        .post(`${API}/${tenantId}/outbound/wave-policies`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, name: `fo-${ulid().slice(10, 20)}`, grouping: 'single', ...(maxOrders === undefined ? {} : { maxOrders }) })
        .expect(201)
    ).body.policy.id as string;
    const generated = await http()
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId, ...(orderIds.length === 0 ? {} : { orderIds }) })
      .expect(201);
    const waveId = generated.body.wave.id as string;
    await http().post(`${API}/${tenantId}/outbound/waves/${waveId}/release`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
    return (await http().get(`${API}/${tenantId}/outbound/waves/${waveId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.wave as Wave;
  }

  function pickLine(line: Picklist['lines'][number], qty = line.qty, reasonCode?: string): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/outbound/picks`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: wh,
        picklistId: line.picklistId,
        picklistLineId: line.id,
        skuId: line.skuId,
        binId: line.binId!,
        qty,
        occurredAt: nowZ(),
        ...(reasonCode === undefined ? {} : { reasonCode }),
      });
  }

  async function pickAll(picklist: Picklist): Promise<void> {
    for (const line of picklist.lines) {
      if (line.binId === null) continue;
      await pickLine(line).expect(201);
    }
  }

  function pack(orderId: string, scanned: { skuId: string; qty: number }[], key = ulid()): SupertestTest {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send({ scanned });
  }

  function dispatch(orderId: string, key = ulid()): SupertestTest {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send({});
  }

  function allocate(orderId: string, key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/allocate`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({});
  }

  /** Wave → pick all → pack what was picked → dispatch; the dispatch body. */
  async function shipWhatIsReserved(orderId: string, scanned: { skuId: string; qty: number }[]): Promise<Record<string, unknown>> {
    const waved = await wave([orderId]);
    await pickAll(waved.picklists[0]!);
    await pack(orderId, scanned).expect(201);
    return (await dispatch(orderId).expect(201)).body.dispatch as Record<string, unknown>;
  }

  async function heldHoldsOf(orderId: string): Promise<{ id: string; owner_id: string; quantity: string }[]> {
    return (await sql`
      select r.id, r.owner_id, r.quantity::text as quantity from reservations r
      where r.tenant_id = ${tenantId} and r.owner_type = 'order' and r.state = 'held'
        and r.owner_id in (select id::text from order_lines where order_id = ${orderId})
      order by r.id`) as unknown as { id: string; owner_id: string; quantity: string }[];
  }

  async function count(query: PromiseLike<unknown>): Promise<number> {
    return Number(((await query) as { n: number | string }[])[0]!.n);
  }

  // ── the migration (A10) ─────────────────────────────────────────────────────

  it('0104: three columns, the NOT VALID pairing CHECK, the root identity indexes under NEW names (the old ones gone), the follow-on and sweep indexes', async () => {
    const columns = (await sql`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_name = 'orders' and column_name like 'follow_on_%' order by column_name`) as unknown as { column_name: string; data_type: string; is_nullable: string }[];
    expect(columns).toEqual([
      { column_name: 'follow_on_of_order_id', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'follow_on_root_order_id', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'follow_on_seq', data_type: 'integer', is_nullable: 'YES' },
    ]);
    const check = (await sql`select convalidated, pg_get_constraintdef(oid) as def from pg_constraint where conname = 'orders_follow_on_pairing'`) as unknown as { convalidated: boolean; def: string }[];
    expect(check).toHaveLength(1);
    expect(check[0]!.convalidated).toBe(false);
    const indexes = new Map(
      ((await sql`select indexname, indexdef from pg_indexes where tablename = 'orders'`) as unknown as { indexname: string; indexdef: string }[]).map((row) => [row.indexname, row.indexdef]),
    );
    expect(indexes.has('orders_source_event_unique')).toBe(false);
    expect(indexes.has('orders_client_order_ref_live_unique')).toBe(false);
    expect(indexes.get('orders_source_event_root_unique')).toMatch(/UNIQUE.*follow_on_of_order_id IS NULL/);
    expect(indexes.get('orders_client_order_ref_live_root_unique')).toMatch(/UNIQUE.*follow_on_of_order_id IS NULL/);
    expect(indexes.get('orders_follow_on_of_unique')).toMatch(/UNIQUE.*\(tenant_id, follow_on_of_order_id\).*follow_on_of_order_id IS NOT NULL/);
    expect(indexes.get('orders_follow_on_root_idx')).toMatch(/\(tenant_id, follow_on_root_order_id\)/);
    expect(indexes.get('orders_accepted_tenant_warehouse_idx')).toMatch(/\(tenant_id, warehouse_id, created_at, id\).*status = 'accepted'/);
  });

  it('the allocate route is published, and its hash carries the command discriminator', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const paths = doc.body.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths['/api/v1/tenants/{tenantId}/outbound/orders/{orderId}/allocate'] ?? paths['/tenants/{tenantId}/outbound/orders/{orderId}/allocate'] ?? {})).toEqual(['post']);
    expect(ALLOCATE_COMMAND_KIND).toBe('outbound.order.allocate');
  });

  // ── AC1 — the short ship ────────────────────────────────────────────────────

  let ac1Root: OrderView;
  let ac1FollowOn: OrderView;

  it('AC1 / "Short dispatch": 1042 for 10 A (7 in stock) + 5 B ships 7 + 5; the dispatch names the follow-on — accepted, seq 1, one line of 3 backordered, nothing reserved, the identity and urgency copied, no COD', async () => {
    await seed('FO-A', 7);
    await seed('FO-B', 5);
    const shipBy = istToday();
    const order = await createOrder(
      [{ skuId: sku('FO-A'), quantity: 10, ratePaise: 4999 }, { skuId: sku('FO-B'), quantity: 5, ratePaise: 1000 }],
      { clientOrderRef: '1042', priority: 'high', shipByDate: shipBy, orderType: 'b2c' },
    );
    expect(order.lines.map((line) => [line.qty, line.reservedQty, line.status])).toEqual([[10, 7, 'backordered'], [5, 5, 'open']]);
    expect(order.followOnOrderId).toBeNull();
    const key = ulid();
    const waved = await wave([order.id]);
    await pickAll(waved.picklists[0]!);
    await pack(order.id, [{ skuId: sku('FO-A'), qty: 7 }, { skuId: sku('FO-B'), qty: 5 }]).expect(201);
    const dispatched = (await dispatch(order.id, key).expect(201)).body.dispatch as Record<string, unknown> & { followOnOrderId: string; lines: { shortfallQty: number }[] };
    expect(dispatched.followOnOrderId).toEqual(expect.any(String));
    expect(dispatched.followOnSeq).toBeNull();
    expect(dispatched.lines.map((line) => line.shortfallQty)).toEqual([3, 0]);

    const followOn = await getOrder(dispatched.followOnOrderId);
    expect(followOn).toMatchObject({
      status: 'accepted',
      clientOrderRef: '1042',
      priority: 'high',
      shipByDate: shipBy,
      orderType: 'b2c',
      codAmountPaise: null,
      followOnOfOrderId: order.id,
      followOnRootOrderId: order.id,
      followOnSeq: 1,
      followOnOrderId: null,
    });
    expect(followOn.lines.map((line) => [line.skuId, line.qty, line.reservedQty, line.shortfallQty, line.status, line.reservationId])).toEqual([
      [sku('FO-A'), 3, 0, 3, 'backordered', null],
    ]);
    const rate = (await sql`select rate_paise from order_lines where order_id = ${followOn.id}`) as unknown as { rate_paise: string }[];
    expect(Number(rate[0]!.rate_paise)).toBe(4999);
    const row = ((await sql`select source_payload_hash, client_id from orders where id = ${followOn.id}`) as unknown as { source_payload_hash: string | null; client_id: string }[])[0]!;
    expect(row).toEqual({ source_payload_hash: null, client_id: acme });

    const root = await getOrder(order.id);
    expect(root.status).toBe('dispatched');
    expect(root.followOnOrderId).toBe(followOn.id);

    // A12 — its own event, never `order.created`; the audit row names the dispatcher and the key.
    const events = (await sql`select type, payload from outbox_messages where tenant_id = ${tenantId} and (payload -> 'order' ->> 'id') = ${followOn.id}`) as unknown as { type: string; payload: { parentOrderId: string } }[];
    expect(events.map((event) => event.type)).toEqual(['order.follow-on-created']);
    expect(events[0]!.payload.parentOrderId).toBe(order.id);
    const alongside = [{ action: 'order.dispatched', targetType: 'order', targetId: order.id, actorUserId: opsUserId }];
    await expectAuditRow({ tenantId, key, action: 'order.follow-on-created', targetType: 'order', targetId: followOn.id, actorUserId: opsUserId, alongside });

    // "Dispatch replay" — the stored record, no second follow-on.
    const replayed = await dispatch(order.id, key).expect(201);
    expect(replayed.body.dispatch.followOnOrderId).toBe(followOn.id);
    expect(await count(sql`select count(*)::int as n from orders where follow_on_of_order_id = ${order.id}`)).toBe(1);
    await expectAuditRow({ tenantId, key, action: 'order.follow-on-created', targetType: 'order', targetId: followOn.id, actorUserId: opsUserId, alongside });
    ac1Root = root;
    ac1FollowOn = followOn;
  });

  it('"Identity": a search by 1042 or by the printed 1042-BO1 finds the chain; a new manual 1042 is 409 (the root holds it)', async () => {
    for (const reference of ['1042', '1042-BO1']) {
      const res = await http().get(`${API}/${tenantId}/warehouses/${wh}/outbound/orders?reference=${reference}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect((res.body.items as { id: string }[]).map((item) => item.id).sort()).toEqual([ac1Root.id, ac1FollowOn.id].sort());
    }
    const list = await http().get(`${API}/${tenantId}/warehouses/${wh}/outbound/orders?reference=1042`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const entry = (list.body.items as Record<string, unknown>[]).find((item) => item.id === ac1FollowOn.id)!;
    expect(entry).toMatchObject({ followOnOfOrderId: ac1Root.id, followOnRootOrderId: ac1Root.id, followOnSeq: 1, followOnOrderId: null });
    const rootEntry = (list.body.items as Record<string, unknown>[]).find((item) => item.id === ac1Root.id)!;
    expect(rootEntry).toMatchObject({ followOnSeq: null, followOnOrderId: ac1FollowOn.id });
    // A15 — the list's `followOn` filter.
    const only = await http().get(`${API}/${tenantId}/warehouses/${wh}/outbound/orders?reference=1042&followOn=true`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((only.body.items as { id: string }[]).map((item) => item.id)).toEqual([ac1FollowOn.id]);
    const roots = await http().get(`${API}/${tenantId}/warehouses/${wh}/outbound/orders?reference=1042&followOn=false`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((roots.body.items as { id: string }[]).map((item) => item.id)).toEqual([ac1Root.id]);

    const clash = await http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, lines: [{ skuId: sku('FO-B'), quantity: 1 }], destination: testAddress(), clientOrderRef: '1042' })
      .expect(409);
    expect(clash.body.code).toBe('duplicate-client-order-ref');
    expect(clash.body.orderId ?? clash.body.extensions?.orderId).toBe(ac1Root.id);
  });

  it('"Portal": ACME reads "shipped 7 of 10" on the root and the follow-on link; BETA sees nothing (null → the route\'s 404)', async () => {
    const detail = (await outbound.portalOrder(tenantId, acme, ac1Root.id))!;
    expect(detail).toMatchObject({ followOnOrderId: ac1FollowOn.id, followOnOfOrderId: null, followOnSeq: null });
    expect(detail.lines.map((line) => [line.skuCode, line.qty, line.shippedQty])).toEqual([['FO-A', 10, 7], ['FO-B', 5, 5]]);
    const followOn = (await outbound.portalOrder(tenantId, acme, ac1FollowOn.id))!;
    expect(followOn).toMatchObject({ followOnOfOrderId: ac1Root.id, followOnRootOrderId: ac1Root.id, followOnSeq: 1, followOnOrderId: null });
    // Not dispatched → shippedQty null (A14).
    expect(followOn.lines.map((line) => line.shippedQty)).toEqual([null]);
    expect(await outbound.portalOrder(tenantId, beta, ac1Root.id)).toBeNull();
    const rows = await outbound.portalOrders(tenantId, acme, { reference: '1042-BO1' });
    expect(rows.items.map((item) => [item.id, item.followOnSeq])).toEqual(
      expect.arrayContaining([[ac1Root.id, null], [ac1FollowOn.id, 1]]),
    );
  });

  it('"Register": the follow-on\'s lines carry follow_on_of_order_id and follow_on_seq 1; a root line carries nulls', async () => {
    const rows = await withTenantTransaction(db, tenantId, (tx) =>
      outbound.outboundRegisterInTx(tx, { tenantId, warehouseId: wh, clientId: null, from: '2020-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' }, 10_000),
    );
    expect(rows.filter((row) => row.orderId === ac1FollowOn.id).map((row) => [row.followOnOfOrderId, row.followOnSeq])).toEqual([[ac1Root.id, 1]]);
    expect(rows.filter((row) => row.orderId === ac1Root.id).map((row) => [row.followOnOfOrderId, row.followOnSeq])).toEqual([[null, null], [null, null]]);
  });

  it('billing: the follow-on is its own per_order (two dispatched orders once it ships) — checked after AC2', async () => {
    // Asserted in the AC2 test below, once the follow-on has dispatched.
    expect(ac1FollowOn.followOnSeq).toBe(1);
  });

  // ── AC2 — the stock arrives ─────────────────────────────────────────────────

  it('AC2 / "Allocation job": 3 units of A arrive → the sweep reserves the follow-on (order.allocated, the system audit row) → it waves, ships, and no further follow-on is created', async () => {
    await seed('FO-A', 3);
    const report = await outbound.sweepBackorders(tenantId);
    expect(report.allocatedOrders).toBeGreaterThanOrEqual(1);
    const followOn = await getOrder(ac1FollowOn.id);
    expect(followOn.lines.map((line) => [line.reservedQty, line.shortfallQty, line.reservationState, line.status])).toEqual([[3, 0, 'held', 'backordered']]);
    const allocated = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'order.allocated' and payload -> 'allocation' ->> 'orderId' = ${followOn.id}`) as unknown as { payload: { entry: string } }[];
    expect(allocated.map((row) => row.payload.entry)).toEqual(['job']);
    const audits = (await sql`select actor_user_id, reference from audit_events where tenant_id = ${tenantId} and action = 'order.allocated' and target_id = ${followOn.id}`) as unknown as { actor_user_id: string; reference: string | null }[];
    expect(audits).toEqual([{ actor_user_id: SYSTEM_ACTOR_ID, reference: null }]);

    const shipped = await shipWhatIsReserved(followOn.id, [{ skuId: sku('FO-A'), qty: 3 }]);
    expect(shipped.followOnOrderId).toBeNull();
    expect(shipped).toMatchObject({ followOnOfOrderId: ac1Root.id, followOnRootOrderId: ac1Root.id, followOnSeq: 1, totalUnits: 3 });
    expect(await count(sql`select count(*)::int as n from orders where follow_on_root_order_id = ${ac1Root.id}`)).toBe(1);

    // 5-5a billing — `per_order` counts by order id: the root and its follow-on are two dispatched orders.
    const perOrder = await withTenantTransaction(db, tenantId, (tx) =>
      inventory.countDispatchedOrdersInTx(tx, { tenantId, clientId: acme }, '2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z'),
    );
    const ids = ((await sql`select distinct reference_doc ->> 'orderId' as id from ledger_events where tenant_id = ${tenantId} and type = 'dispatch.dispatched'`) as unknown as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([ac1Root.id, ac1FollowOn.id]));
    expect(perOrder).toBe(ids.length);
  });

  it('"Second short" / "Label": a follow-on that ships 2 of 3 opens seq 2 for 1 — the chain root and the 1042 number carried', async () => {
    await seed('FO-TWICE', 1);
    const root = await createOrder([{ skuId: sku('FO-TWICE'), quantity: 4 }], { clientOrderRef: 'SO-TWICE' });
    const first = await shipWhatIsReserved(root.id, [{ skuId: sku('FO-TWICE'), qty: 1 }]);
    const bo1 = first.followOnOrderId as string;
    await seed('FO-TWICE', 2);
    const allocated = await allocate(bo1).expect(200);
    expect(allocated.body.allocation.allocated.map((line: { reservedQty: number }) => line.reservedQty)).toEqual([2]);
    expect(allocated.body.allocation.stillShort.map((line: { shortQty: number }) => line.shortQty)).toEqual([1]);
    const second = await shipWhatIsReserved(bo1, [{ skuId: sku('FO-TWICE'), qty: 2 }]);
    const bo2 = await getOrder(second.followOnOrderId as string);
    expect(bo2).toMatchObject({ clientOrderRef: 'SO-TWICE', followOnOfOrderId: bo1, followOnRootOrderId: root.id, followOnSeq: 2 });
    expect(bo2.lines.map((line) => line.qty)).toEqual([1]);
    // The label rule (A10) in SQL: the wind-down / recall-trace arm.
    const labels = (await withTenantTransaction(db, tenantId, (tx) =>
      tx.execute(dsql`select ${orderLabelSql('o')} as label from orders o where o.id = ${root.id} or o.follow_on_root_order_id = ${root.id} order by o.follow_on_seq nulls first`),
    )) as unknown as { label: string }[];
    expect(labels.map((row) => row.label)).toEqual(['SO-TWICE', 'SO-TWICE-BO1', 'SO-TWICE-BO2']);
    // An unnamed chain takes the ROOT's short id (A10), in SQL and in TS alike.
    await sql`update orders set client_order_ref = null where id = ${root.id} or follow_on_root_order_id = ${root.id}`;
    const unnamed = (await withTenantTransaction(db, tenantId, (tx) =>
      tx.execute(dsql`select ${orderLabelSql('o')} as label, o.id, o.follow_on_seq as "followOnSeq", o.follow_on_root_order_id as "followOnRootOrderId" from orders o where o.follow_on_root_order_id = ${root.id} order by o.follow_on_seq`),
    )) as unknown as { label: string; id: string; followOnSeq: number; followOnRootOrderId: string }[];
    expect(unnamed.map((row) => row.label)).toEqual([`${root.id.slice(-8)}-BO1`, `${root.id.slice(-8)}-BO2`]);
    expect(unnamed.map((row) => orderLabelOf(row))).toEqual(unnamed.map((row) => row.label));
    await sql`update orders set client_order_ref = 'SO-TWICE' where id = ${root.id} or follow_on_root_order_id = ${root.id}`;
  });

  it('"Full dispatch": every line picked in full → no follow-on, followOnOrderId null', async () => {
    await seed('FO-FULL', 2);
    const order = await createOrder([{ skuId: sku('FO-FULL'), quantity: 2 }]);
    const shipped = await shipWhatIsReserved(order.id, [{ skuId: sku('FO-FULL'), qty: 2 }]);
    expect(shipped.followOnOrderId).toBeNull();
    expect(await count(sql`select count(*)::int as n from orders where follow_on_of_order_id = ${order.id}`)).toBe(0);
  });

  it('decision 6 — after a short dispatch commits, one best-effort allocation reserves the follow-on from stock already free', async () => {
    await seed('FO-NOW', 2);
    const order = await createOrder([{ skuId: sku('FO-NOW'), quantity: 5 }]);
    const waved = await wave([order.id]);
    await pickAll(waved.picklists[0]!);
    // Units arrive between the pick and the dispatch — free ATP.
    await seed('FO-NOW', 3, binB);
    await pack(order.id, [{ skuId: sku('FO-NOW'), qty: 2 }]).expect(201);
    const dispatched = (await dispatch(order.id).expect(201)).body.dispatch as { followOnOrderId: string };
    const followOn = await getOrder(dispatched.followOnOrderId);
    expect(followOn.lines.map((line) => [line.qty, line.reservedQty, line.reservationState])).toEqual([[3, 3, 'held']]);
    const entries = (await sql`select payload ->> 'entry' as entry from outbox_messages where tenant_id = ${tenantId} and type = 'order.allocated' and payload -> 'allocation' ->> 'orderId' = ${followOn.id}`) as unknown as { entry: string }[];
    expect(entries.map((row) => row.entry)).toEqual(['dispatch']);
  });

  // ── AC3 — wholly backordered ────────────────────────────────────────────────

  it('AC3 / "Wholly backordered": an order accepted with nothing reserved cannot wave (A4); once stock arrives the allocation reserves it and it ships with no follow-on', async () => {
    const order = await createOrder([{ skuId: sku('FO-WHOLE'), quantity: 2 }]);
    expect(order.lines.map((line) => [line.reservedQty, line.reservationId])).toEqual([[0, null]]);
    // An explicit selection of it is refused by name (it holds nothing).
    const policyId = (await http().post(`${API}/${tenantId}/outbound/wave-policies`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ warehouseId: wh, name: `fo-whole-${ulid().slice(10, 20)}`, grouping: 'single' }).expect(201)).body.policy.id as string;
    const refused = await http().post(`${API}/${tenantId}/outbound/waves`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ warehouseId: wh, policyId, orderIds: [order.id] }).expect(422);
    expect(refused.body.code).toBe('no-eligible-orders');
    await seed('FO-WHOLE', 2);
    const outcome = await allocation.allocateOrderCore(tenantId, order.id, { entry: 'job' });
    expect(outcome.kind).toBe('allocated');
    const shipped = await shipWhatIsReserved(order.id, [{ skuId: sku('FO-WHOLE'), qty: 2 }]);
    expect(shipped.followOnOrderId).toBeNull();
    expect(shipped.totalUnits).toBe(2);
  });

  // ── "Allocate now" (A7) ──────────────────────────────────────────────────────

  it('"Allocate now": 200 with the result, the audit row, the replay; nothing to allocate is 200 empty (a declared no-op); not accepted 409; on a wave 409; unknown 404; an operator 403', async () => {
    const order = await createOrder([{ skuId: sku('FO-VERB'), quantity: 4 }], { clientOrderRef: 'SO-VERB' });
    // Nothing in stock yet: nothing granted — 200, the key stored, no audit row.
    const emptyKey = noOpIdempotencyKey(tenantId, ulid(), 'orders.allocate:nothing-granted');
    const empty = await allocate(order.id, emptyKey).expect(200);
    expect(empty.body.allocation).toMatchObject({ orderId: order.id, warehouseId: wh, allocated: [], skipped: [] });
    expect(empty.body.allocation.stillShort.map((line: { skuCode: string; shortQty: number }) => [line.skuCode, line.shortQty])).toEqual([['FO-VERB', 4]]);
    expect(await count(sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${emptyKey}`)).toBe(0);

    await seed('FO-VERB', 4);
    const key = ulid();
    const res = await allocate(order.id, key).expect(200);
    expect(res.body.allocation.allocated.map((line: { skuCode: string; qty: number; reservedQty: number }) => [line.skuCode, line.qty, line.reservedQty])).toEqual([['FO-VERB', 4, 4]]);
    expect(res.body.allocation.stillShort).toEqual([]);
    await expectAuditRow({ tenantId, key, action: 'order.allocated', targetType: 'order', targetId: order.id, actorUserId: opsUserId });
    const replay = await allocate(order.id, key).expect(200);
    expect(replay.body).toEqual(res.body);
    await expectAuditRow({ tenantId, key, action: 'order.allocated', targetType: 'order', targetId: order.id, actorUserId: opsUserId });
    // "Nothing to allocate": every line holds.
    const held = await allocate(order.id, noOpIdempotencyKey(tenantId, ulid(), 'orders.allocate:nothing-granted')).expect(200);
    expect(held.body.allocation).toMatchObject({ allocated: [], stillShort: [], skipped: [] });

    // On a wave → 409 order-on-open-wave naming the wave.
    const waved = await wave([order.id]);
    const onWave = await allocate(order.id).expect(409);
    expect(onWave.body.code).toBe('order-on-open-wave');
    expect(onWave.body.detail).toContain(waved.id);
    // Dispatched → 409 order-not-accepted.
    await pickAll(waved.picklists[0]!);
    await pack(order.id, [{ skuId: sku('FO-VERB'), qty: 4 }]).expect(201);
    await dispatch(order.id).expect(201);
    expect((await allocate(order.id).expect(409)).body.code).toBe('order-not-accepted');
    // Unknown / another tenant's → 404; an operator lacks orders.manage → 403.
    expect((await allocate('019a0000-0000-7000-8000-000000000000').expect(404)).body.code).toBe('not-found');
    expect((await allocate(order.id, ulid(), operatorWebToken).expect(403)).body.code).toBe('role-denied');
  });

  it('"Allocation partial": qty 3, ATP 2 → reserved 2 (like acceptance); the remainder ships short and becomes its own follow-on', async () => {
    const order = await createOrder([{ skuId: sku('FO-PART'), quantity: 3 }]);
    await seed('FO-PART', 2);
    const res = await allocate(order.id).expect(200);
    expect(res.body.allocation.allocated.map((line: { reservedQty: number }) => line.reservedQty)).toEqual([2]);
    expect(res.body.allocation.stillShort.map((line: { shortQty: number }) => line.shortQty)).toEqual([1]);
    const view = await getOrder(order.id);
    expect(view.lines.map((line) => [line.reservedQty, line.shortfallQty])).toEqual([[2, 1]]);
    // No top-up: a line holding part is not eligible again.
    await seed('FO-PART', 1);
    expect((await allocate(order.id, noOpIdempotencyKey(tenantId, ulid(), 'orders.allocate:nothing-granted')).expect(200)).body.allocation.allocated).toEqual([]);
    const shipped = await shipWhatIsReserved(order.id, [{ skuId: sku('FO-PART'), qty: 2 }]);
    const followOn = await getOrder(shipped.followOnOrderId as string);
    expect(followOn.lines.map((line) => line.qty)).toEqual([1]);
  });

  // ── decision 10 — the zero-unit pack ────────────────────────────────────────

  it('"Zero-unit pack": every slice settled without drawing (a zero-unit short pick) → 409 pack-nothing-picked; nothing written; the wave cancel frees it to re-wave', async () => {
    await seed('FO-ZERO', 2);
    const order = await createOrder([{ skuId: sku('FO-ZERO'), quantity: 2 }]);
    const waved = await wave([order.id]);
    const line = waved.picklists[0]!.lines[0]!;
    await pickLine(line, 0, 'bin-empty').expect(201);
    const key = ulid();
    const refused = await pack(order.id, [], key).expect(409);
    expect(refused.body.code).toBe('pack-nothing-picked');
    expect(refused.body.detail).toMatch(/Cancel the wave to re-plan it, or cancel the order/);
    expect(((await sql`select status from orders where id = ${order.id}`) as unknown as { status: string }[])[0]!.status).toBe('accepted');
    expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(0);
    await http().post(`${API}/${tenantId}/outbound/waves/${waved.id}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
  });

  // ── decision 2 / A8 / A9 — kits and the sub-unit remainder ───────────────────

  it('"Kit partial": kit Q 2 (A×1, B×2) picked A 2, B 3 → follow-on parent 1 + child B 1 (A owed 0); its allocation makes the parent\'s LIVE shortfall 0 (A8)', async () => {
    await seed('FO-KA', 2);
    await seed('FO-KB', 4);
    const order = await createOrder([{ skuId: sku('FO-KIT'), quantity: 2 }]);
    const waved = await wave([order.id]);
    for (const line of waved.picklists[0]!.lines) {
      if (line.skuId === sku('FO-KB')) await pickLine(line, 3, 'fewer-units-than-planned').expect(201);
      else await pickLine(line).expect(201);
    }
    await pack(order.id, [{ skuId: sku('FO-KA'), qty: 2 }, { skuId: sku('FO-KB'), qty: 3 }]).expect(201);
    // The B unit the picker could not find is written off (else the
    // after-dispatch attempt would reserve it at once).
    await http().post(`${API}/${tenantId}/inventory/adjustments`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, skuId: sku('FO-KB'), binId: binA, quantityDelta: -1, reasonCode: 'stock-count', note: 'not found' }).expect(201);
    const shipped = (await dispatch(order.id).expect(201)).body.dispatch as { followOnOrderId: string };
    const followOn = await getOrder(shipped.followOnOrderId);
    const parent = followOn.lines.find((line) => line.parentLineId === null)!;
    expect([parent.skuId, parent.qty, parent.shortfallQty, parent.reservationId]).toEqual([sku('FO-KIT'), 1, 1, null]);
    expect(followOn.lines.filter((line) => line.parentLineId === parent.id).map((line) => [line.skuId, line.qty])).toEqual([[sku('FO-KB'), 1]]);
    // The B unit the short pick found missing turns up — the kit block allocates it.
    await seed('FO-KB', 1, binB);
    const res = await allocate(followOn.id).expect(200);
    expect(res.body.allocation.allocated.map((line: { skuCode: string; reservedQty: number }) => [line.skuCode, line.reservedQty])).toEqual([['FO-KB', 1]]);
    const after = await getOrder(followOn.id);
    expect(after.lines.find((line) => line.id === parent.id)!.shortfallQty).toBe(0);
    // The portal reads the root kit as 1 complete kit shipped (A14).
    const portal = (await outbound.portalOrder(tenantId, acme, order.id))!;
    expect(portal.lines.map((line) => [line.skuCode, line.qty, line.shippedQty, line.components.map((c) => [c.skuCode, c.shippedQty])])).toEqual([
      ['FO-KIT', 2, 1, [['FO-KA', 2], ['FO-KB', 3]]],
    ]);
  });

  it('"Sub-unit remainder" (A9): 1 kg picked 0.998 kg → no follow-on; the dispatch record keeps shortfallQty 0.002', async () => {
    await seed('FO-KG', 1);
    const order = await createOrder([{ skuId: sku('FO-KG'), quantity: 1 }]);
    const waved = await wave([order.id]);
    await pickLine(waved.picklists[0]!.lines[0]!, 0.998, 'fewer-units-than-planned').expect(201);
    await pack(order.id, [{ skuId: sku('FO-KG'), qty: 0.998 }]).expect(201);
    const shipped = (await dispatch(order.id).expect(201)).body.dispatch as { followOnOrderId: string | null; lines: { shortfallQty: number }[] };
    expect(shipped.followOnOrderId).toBeNull();
    expect(shipped.lines.map((line) => line.shortfallQty)).toEqual([0.002]);
  });

  // ── decision 4 / A16 — COD and the pack task ─────────────────────────────────

  it('"COD short": the pack task warns before (orderShortfall, orderedQty); the follow-on is prepaid (codAmountPaise null)', async () => {
    await seed('FO-COD', 1);
    const order = await createOrder([{ skuId: sku('FO-COD'), quantity: 3 }], { codAmountPaise: 149_900 });
    const waved = await wave([order.id]);
    await pickAll(waved.picklists[0]!);
    const tasks = (await outbound.getPackTasks(tenantId, wh, istToday())).packTasks.filter((task) => task.orderId === order.id);
    expect(tasks.map((task) => [task.pickedQty, task.orderedQty, task.orderShortfall, task.followOnSeq, task.codAmountPaise])).toEqual([[1, 3, true, null, 149_900]]);
    await pack(order.id, [{ skuId: sku('FO-COD'), qty: 1 }]).expect(201);
    const shipped = (await dispatch(order.id).expect(201)).body.dispatch as { followOnOrderId: string; codAmountPaise: number };
    expect(shipped.codAmountPaise).toBe(149_900);
    expect((await getOrder(shipped.followOnOrderId)).codAmountPaise).toBeNull();
  });

  // ── A1 / A2 — the journal decides eligibility; orphans and races ────────────

  it('"Expired hold" (A1): an accepted, unwaved line whose 7-day hold expired is re-granted by the job', async () => {
    await seed('FO-EXP', 2);
    const order = await createOrder([{ skuId: sku('FO-EXP'), quantity: 2 }]);
    const firstHold = order.lines[0]!.reservationId!;
    await sql`update reservations set expires_at = now() - interval '1 minute' where id = ${firstHold}`;
    await inventory.expireDueReservations();
    expect((await getOrder(order.id)).lines[0]!.reservationState).toBe('expired');
    const outcome = await allocation.allocateOrderCore(tenantId, order.id, { entry: 'job' });
    expect(outcome.kind === 'allocated' && outcome.grantedAny).toBe(true);
    const line = (await getOrder(order.id)).lines[0]!;
    expect(line.reservationId).not.toBe(firstHold);
    expect([line.reservedQty, line.reservationState]).toEqual([2, 'held']);
  });

  it('"Orphan" (A2): a held hold owned by the line that the line does not point at is ADOPTED — no 409 loop, one live hold, on the line', async () => {
    const order = await createOrder([{ skuId: sku('FO-ORPH'), quantity: 2 }]);
    await seed('FO-ORPH', 2);
    const orphan = await inventory.grantReservation({ tenantId, warehouseId: wh, skuId: sku('FO-ORPH'), ownerType: 'order', ownerId: order.lines[0]!.id, quantity: 2_000, ttlSeconds: 3600 });
    const res = await allocate(order.id).expect(200);
    expect(res.body.allocation.allocated.map((line: { reservedQty: number }) => line.reservedQty)).toEqual([2]);
    expect((await getOrder(order.id)).lines[0]!.reservationId).toBe(orphan.id);
    expect((await heldHoldsOf(order.id)).map((hold) => hold.id)).toEqual([orphan.id]);
  });

  /** Fire `run` twice while a raw holder has the order row FOR UPDATE; release once both are parked on it. */
  async function parkedTwice<T>(orderId: string, run: () => Promise<T>): Promise<[PromiseSettledResult<T>, PromiseSettledResult<T>]> {
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    let first: Promise<T> | undefined;
    let second: Promise<T> | undefined;
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`select pg_backend_pid() as pid from orders where id = ${orderId} for update`) as unknown as { pid: number }[];
        first = run();
        second = run();
        const deadline = Date.now() + 15_000;
        for (;;) {
          const parked = (await sql`
            select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and ${locked[0]!.pid} = any(pg_blocking_pids(pid))`) as unknown as { n: number }[];
          const chained = (await sql`
            select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`) as unknown as { n: number }[];
          if (parked[0]!.n >= 1 && chained[0]!.n >= 2) break;
          if (Date.now() > deadline) throw new Error('the two runs did not both park on the order row');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      });
      return (await Promise.allSettled([first!, second!])) as [PromiseSettledResult<T>, PromiseSettledResult<T>];
    } finally {
      await Promise.allSettled([first, second]);
      await holder.end();
    }
  }

  it('"Two allocators" (A2): the job and a second run on one line at once, both parked on the order lock → one live hold, on the line; nothing double-held', async () => {
    const order = await createOrder([{ skuId: sku('FO-RACE'), quantity: 3 }]);
    await seed('FO-RACE', 5);
    const [a, b] = await parkedTwice(order.id, () => allocation.allocateOrderCore(tenantId, order.id, { entry: 'job' }));
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled']);
    const held = await heldHoldsOf(order.id);
    expect(held).toHaveLength(1);
    const line = (await getOrder(order.id)).lines[0]!;
    expect([line.reservationId, line.reservedQty]).toEqual([held[0]!.id, 3]);
    expect((await inventory.atp(tenantId, wh, sku('FO-RACE'))).atp).toBe(2_000);
  });

  it('a same-key "Allocate now" duplicate parked on the lock serves the winner\'s answer — one effect, one key, one audit row', async () => {
    const order = await createOrder([{ skuId: sku('FO-VRACE'), quantity: 2 }]);
    await seed('FO-VRACE', 2);
    const key = ulid();
    const [a, b] = await parkedTwice(order.id, async () => allocate(order.id, key).then((res) => res));
    expect(a.status === 'fulfilled' && b.status === 'fulfilled').toBe(true);
    const ra = (a as PromiseFulfilledResult<request.Response>).value;
    const rb = (b as PromiseFulfilledResult<request.Response>).value;
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(rb.body).toEqual(ra.body);
    expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(1);
    await expectAuditRow({ tenantId, key, action: 'order.allocated', targetType: 'order', targetId: order.id, actorUserId: opsUserId });
    expect(await heldHoldsOf(order.id)).toHaveLength(1);
  });

  it('"Cancel race" (A3): an allocation committing between cancel\'s pre-check and its flip leaves no live hold on the cancelled order', async () => {
    const order = await createOrder([{ skuId: sku('FO-CXL'), quantity: 2 }]);
    await seed('FO-CXL', 2);
    cancelOrderTestHooks.afterPrecheck = async (orderId) => {
      if (orderId !== order.id) return;
      const outcome = await allocation.allocateOrderCore(tenantId, order.id, { entry: 'job' });
      expect(outcome.kind === 'allocated' && outcome.grantedAny).toBe(true);
    };
    try {
      await http().post(`${API}/${tenantId}/outbound/orders/${order.id}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
    } finally {
      cancelOrderTestHooks.afterPrecheck = undefined;
    }
    expect(await heldHoldsOf(order.id)).toEqual([]);
    expect((await inventory.atp(tenantId, wh, sku('FO-CXL'))).atp).toBe(2_000);
  });

  it('a cancelled order is never allocated: the core answers not-eligible and grants nothing', async () => {
    const order = await createOrder([{ skuId: sku('FO-CXL'), quantity: 1 }]);
    await http().post(`${API}/${tenantId}/outbound/orders/${order.id}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
    expect(await allocation.allocateOrderCore(tenantId, order.id, { entry: 'job' })).toEqual({ kind: 'not-eligible', reason: 'order-not-accepted' });
    expect(await heldHoldsOf(order.id)).toEqual([]);
  });

  // ── A6 — the acceptance rules at allocation ──────────────────────────────────

  it('"Inactive SKU" (A6): a line of an inactive SKU is granted only when ATP covers it in full — skipped sku-inactive otherwise', async () => {
    const order = await createOrder([{ skuId: sku('FO-INACT'), quantity: 3 }]);
    await http().patch(`${API}/${tenantId}/catalog/skus/${sku('FO-INACT')}/status`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ status: 'inactive', reason: 'discontinued' }).expect(200);
    await seed('FO-INACT', 2);
    const partial = await allocate(order.id, noOpIdempotencyKey(tenantId, ulid(), 'orders.allocate:nothing-granted')).expect(200);
    expect(partial.body.allocation.allocated).toEqual([]);
    expect(partial.body.allocation.skipped.map((line: { skuCode: string; reason: string }) => [line.skuCode, line.reason])).toEqual([['FO-INACT', 'sku-inactive']]);
    await seed('FO-INACT', 1);
    const full = await allocate(order.id).expect(200);
    expect(full.body.allocation.allocated.map((line: { reservedQty: number }) => line.reservedQty)).toEqual([3]);
  });

  it('"Licence lapsed" (A6): with enforcement on and the SKU uncovered, the order is skipped licence-not-covered and nothing is reserved', async () => {
    const order = await createOrder([{ skuId: sku('FO-DRUG'), quantity: 1 }]);
    await sql`update skus set drug_schedules = '{H}' where id = ${sku('FO-DRUG')}`;
    await sql`insert into licence_policies (id, tenant_id, enforce, updated_by) values (gen_random_uuid(), ${tenantId}, true, ${opsUserId})`;
    try {
      await seed('FO-DRUG', 1);
      const res = await allocate(order.id, noOpIdempotencyKey(tenantId, ulid(), 'orders.allocate:nothing-granted')).expect(200);
      expect(res.body.allocation.allocated).toEqual([]);
      expect(res.body.allocation.skipped.map((line: { reason: string }) => line.reason)).toEqual(['licence-not-covered']);
      expect(await heldHoldsOf(order.id)).toEqual([]);
    } finally {
      await sql`delete from licence_policies where tenant_id = ${tenantId}`;
    }
  });

  it('3-7a / 3-3a: a follow-on never reserves a blocked (recalled) lot — the lot is outside ATP', async () => {
    const order = await createOrder([{ skuId: sku('FO-LOT'), quantity: 2 }]);
    await seed('FO-LOT', 2, binA, { batch: { code: 'LOT-RCL' } });
    // A recall blocks the lot (3-7a) — the same status 3-3a's block writes.
    await sql`update batches set status = 'blocked', blocked_reason = 'recall', blocked_at = now(), blocked_by = ${opsUserId} where tenant_id = ${tenantId} and sku_id = ${sku('FO-LOT')} and code = 'LOT-RCL'`;
    const res = await allocate(order.id, noOpIdempotencyKey(tenantId, ulid(), 'orders.allocate:nothing-granted')).expect(200);
    expect(res.body.allocation.allocated).toEqual([]);
    expect(await heldHoldsOf(order.id)).toEqual([]);
  });

  // ── AC5 — the floor ──────────────────────────────────────────────────────────

  it('AC5 / "Sweep crowding" (A4): cap 1, an overdue hold-less order and a reserved routine order → the wave takes the reserved one', async () => {
    const wh2 = await createWarehouse(`FOC-${ulid().slice(20)}`);
    const bin2 = await createBin(wh2, await createZone(wh2, 'C'), 'C-01-01');
    const overdue = await createOrder([{ skuId: sku('FO-CROWD'), quantity: 1 }], { priority: 'urgent', shipByDate: istToday() }, wh2);
    expect(overdue.lines[0]!.reservedQty).toBe(0);
    await seed('FO-ROUT', 1, bin2, {}, wh2);
    const routine = await createOrder([{ skuId: sku('FO-ROUT'), quantity: 1 }], {}, wh2);
    const waved = await wave([], wh2, 1);
    expect(waved.picklists.map((picklist) => picklist.orderId)).toEqual([routine.id]);
  });

  it('A18 — the sweep candidate read plans on orders_accepted_tenant_warehouse_idx', async () => {
    const plan = await withTenantTransaction(db, tenantId, async (tx) => {
      await tx.execute(dsql`set local enable_seqscan = off`);
      const query = backorderCandidatesSql(tenantId, istToday(), 500);
      const rows = (await tx.execute(dsql`explain ${query}`)) as unknown as Record<string, string>[];
      return rows.map((row) => Object.values(row)[0]).join('\n');
    });
    expect(plan).toContain('orders_accepted_tenant_warehouse_idx');
  });

  it('A15 — the client service report does not count a follow-on waiting for stock as a late order', async () => {
    const late = async (): Promise<number> =>
      withTenantTransaction(db, tenantId, async (tx) => {
        const figures = await readServiceFiguresInTx(
          tx,
          { tenantId, clientId: acme, warehouseId: wh },
          { from: new Date(Date.now() - 7 * 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), asOf: new Date().toISOString(), deadlineAt: Date.now() + 30_000 },
        );
        return figures.dispatchTimeliness.lateNotDispatched;
      });
    const order = await createOrder([{ skuId: sku('FO-CROWD'), quantity: 1 }], { clientOrderRef: 'SO-LATE' });
    await sql`update orders set created_at = now() - interval '3 days' where id = ${order.id}`;
    const baseline = await late();
    // A follow-on of it, waiting 3 days for the client's stock.
    await sql`
      insert into orders (id, tenant_id, client_id, warehouse_id, status, client_order_ref, follow_on_of_order_id, follow_on_root_order_id, follow_on_seq, created_at, updated_at)
      values (gen_random_uuid(), ${tenantId}, ${acme}, ${wh}, 'accepted', 'SO-LATE', ${order.id}, ${order.id}, 1, now() - interval '3 days', now() - interval '3 days')`;
    expect(await late()).toBe(baseline);
    await sql`delete from orders where follow_on_of_order_id = ${order.id}`;
  });

  // ── code review patches ──────────────────────────────────────────────────────

  it('C18 / C5 — orderShortfall is ORDER-level (a fully picked SKU row warns when another SKU picked nothing), and a sub-unit short opens no follow-on so it does not warn', async () => {
    await seed('FO-PT1', 2);
    await seed('FO-PT2', 2);
    const order = await createOrder([{ skuId: sku('FO-PT1'), quantity: 2 }, { skuId: sku('FO-PT2'), quantity: 2 }]);
    const waved = await wave([order.id]);
    for (const line of waved.picklists[0]!.lines) {
      if (line.skuId === sku('FO-PT2')) await pickLine(line, 0, 'bin-empty').expect(201);
      else await pickLine(line).expect(201);
    }
    const tasks = (await outbound.getPackTasks(tenantId, wh, istToday())).packTasks.filter((task) => task.orderId === order.id);
    expect(tasks.map((task) => [task.skuId, task.pickedQty, task.orderedQty, task.orderShortfall])).toEqual([[sku('FO-PT1'), 2, 2, true]]);

    await seed('FO-KG2', 1);
    const kg = await createOrder([{ skuId: sku('FO-KG2'), quantity: 1 }]);
    const kgWave = await wave([kg.id]);
    await pickLine(kgWave.picklists[0]!.lines[0]!, 0.998, 'fewer-units-than-planned').expect(201);
    const kgTasks = (await outbound.getPackTasks(tenantId, wh, istToday())).packTasks.filter((task) => task.orderId === kg.id);
    expect(kgTasks.map((task) => [task.pickedQty, task.orderedQty, task.orderShortfall])).toEqual([[0.998, 1, false]]);
  });

  it('C19 — the invoice drills name a follow-on: orderRefsInTx and pickRecordsInTx carry its seq and its root', async () => {
    const refs = await withTenantTransaction(db, tenantId, (tx) => outbound.orderRefsInTx(tx, tenantId, [ac1Root.id, ac1FollowOn.id]));
    expect(refs.get(ac1FollowOn.id)).toMatchObject({ clientOrderRef: '1042', followOnSeq: 1, followOnRootOrderId: ac1Root.id });
    expect(refs.get(ac1Root.id)).toMatchObject({ clientOrderRef: '1042', followOnSeq: null, followOnRootOrderId: null });
    const picks = await withTenantTransaction(db, tenantId, (tx) =>
      outbound.pickRecordsInTx(tx, { tenantId, clientId: acme }, '2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z', { after: null, limit: 1000 }),
    );
    const followOnPicks = picks.filter((row) => row.orderId === ac1FollowOn.id);
    expect(followOnPicks.length).toBeGreaterThan(0);
    expect(followOnPicks.every((row) => Number(row.orderFollowOnSeq) === 1 && row.orderFollowOnRootOrderId === ac1Root.id)).toBe(true);
  });

  it('C16 — a reservation-store failure mid-run answers 503 and gives back every fresh grant (nothing reserved, nothing written)', async () => {
    const order = await createOrder([{ skuId: sku('FO-503'), quantity: 1 }, { skuId: sku('FO-5032'), quantity: 1 }]);
    await seed('FO-503', 1);
    await seed('FO-5032', 1);
    const real = inventory.grantReservation.bind(inventory);
    let calls = 0;
    const spy = jest.spyOn(inventory, 'grantReservation').mockImplementation(async (command) => {
      calls += 1;
      if (calls === 2) throw new ProblemException('reservation-store-unavailable', 503, 'Reservation store unavailable', 'The reservation store is unreachable.');
      return real(command);
    });
    try {
      const key = ulid();
      const res = await allocate(order.id, key).expect(503);
      expect(res.body.code).toBe('reservation-store-unavailable');
      expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(await heldHoldsOf(order.id)).toEqual([]);
    expect((await getOrder(order.id)).lines.map((line) => line.reservedQty)).toEqual([0, 0]);
    expect((await inventory.atp(tenantId, wh, sku('FO-503'))).atp).toBe(1_000);
    expect(await count(sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'order.allocated' and payload -> 'allocation' ->> 'orderId' = ${order.id}`)).toBe(0);
  });

  it('C17 — the after-dispatch allocation never throws: a failing attempt still answers 201 with the follow-on (accepted, nothing reserved)', async () => {
    await seed('FO-NT', 1);
    const order = await createOrder([{ skuId: sku('FO-NT'), quantity: 3 }]);
    const waved = await wave([order.id]);
    await pickAll(waved.picklists[0]!);
    await pack(order.id, [{ skuId: sku('FO-NT'), qty: 1 }]).expect(201);
    const spy = jest.spyOn(allocation, 'allocateOrderCore').mockRejectedValueOnce(new Error('the store is down'));
    try {
      const res = await dispatch(order.id).expect(201);
      expect(res.body.dispatch.followOnOrderId).toEqual(expect.any(String));
      const followOn = await getOrder(res.body.dispatch.followOnOrderId as string);
      expect([followOn.status, followOn.lines[0]!.reservedQty]).toEqual(['accepted', 0]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('C24 — a grant another run released before this run\'s write is never written to the line (contended, the line holds nothing)', async () => {
    const order = await createOrder([{ skuId: sku('FO-GONE'), quantity: 1 }]);
    await seed('FO-GONE', 1);
    const real = inventory.grantReservation.bind(inventory);
    const spy = jest.spyOn(inventory, 'grantReservation').mockImplementation(async (command) => {
      const granted = await real(command);
      // Another run's abort released it (under the order lock) between this
      // run's grant and its write.
      await inventory.releaseReservation(tenantId, granted.id);
      return granted;
    });
    try {
      const res = await allocate(order.id, noOpIdempotencyKey(tenantId, ulid(), 'orders.allocate:nothing-granted')).expect(200);
      expect(res.body.allocation.allocated).toEqual([]);
      expect(res.body.allocation.skipped.map((line: { reason: string }) => line.reason)).toEqual(['contended']);
    } finally {
      spy.mockRestore();
    }
    const line = (await getOrder(order.id)).lines[0]!;
    expect([line.reservationId, line.reservedQty]).toEqual([null, 0]);
  });

  it('C1 — a kit component\'s PARTIAL orphan is released and the kit is granted whole (never skipped until the orphan\'s TTL)', async () => {
    const order = await createOrder([{ skuId: sku('FO-KIT'), quantity: 1 }]);
    const children = order.lines.filter((line) => line.parentLineId !== null);
    const childB = children.find((line) => line.skuId === sku('FO-KB'))!;
    expect(children.every((line) => line.reservedQty === 0)).toBe(true);
    await seed('FO-KB', 1, binB);
    const orphan = await inventory.grantReservation({ tenantId, warehouseId: wh, skuId: sku('FO-KB'), ownerType: 'order', ownerId: childB.id, quantity: 1_000, ttlSeconds: 3600 });
    await seed('FO-KA', 1, binB);
    await seed('FO-KB', 1, binB);
    const res = await allocate(order.id).expect(200);
    expect(res.body.allocation.allocated.map((line: { skuCode: string; reservedQty: number }) => [line.skuCode, line.reservedQty]).sort()).toEqual([['FO-KA', 1], ['FO-KB', 2]]);
    const states = (await sql`select state from reservations where id = ${orphan.id}`) as unknown as { state: string }[];
    expect(states[0]!.state).toBe('released');
    expect((await heldHoldsOf(order.id)).length).toBe(2);
  });

  it('C15 — the worker\'s tick() sweeps the tenants with an accepted order and allocates', async () => {
    const order = await createOrder([{ skuId: sku('FO-TICK'), quantity: 1 }]);
    await seed('FO-TICK', 1);
    const worker = new BackorderAllocationWorker(app.get(AUTH_DATABASE), outbound);
    expect(await worker.tick()).toContain(tenantId);
    expect((await getOrder(order.id)).lines[0]!.reservedQty).toBe(1);
  });

  // ── the IST "today" and starvation (A5, A18) — a tenant of their own ─────────

  describe('the sweep on its own tenant: the IST today, the starvation guard', () => {
    let tenant2: string;
    let owner2: string;
    let ops2: string;
    let wh2: string;
    let bin2: string;
    const sku2 = new Map<string, string>();

    beforeAll(async () => {
      const email = `owner2-${ulid().toLowerCase()}@example.com`;
      tenant2 = (await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Sweep Co ${ulid()}`, ownerEmail: email, password: PASSWORD }).expect(201)).body.tenant.id as string;
      owner2 = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
      const opsEmail = `ops2-${ulid().toLowerCase()}@example.com`;
      const invited = await http().post(`${API}/${tenant2}/users`).set('Authorization', `Bearer ${owner2}`).set(KEY_HEADER, ulid()).send({ email: opsEmail, role: 'ops_manager' }).expect(201);
      await http().post(`${API}/${tenant2}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
      ops2 = (await mintSignIn(app, { email: opsEmail, password: PASSWORD })).body.accessToken as string;
      wh2 = (await http().post(`${API}/${tenant2}/warehouses`).set('Authorization', `Bearer ${owner2}`).set(KEY_HEADER, ulid()).send({ origin: testAddress(), code: 'SW1', name: 'Sweep 1' }).expect(201)).body.id as string;
      const zone = (await http().post(`${API}/${tenant2}/warehouses/${wh2}/zones`).set('Authorization', `Bearer ${owner2}`).set(KEY_HEADER, ulid()).send({ code: 'S', name: 'S' }).expect(201)).body.id as string;
      bin2 = (await http().post(`${API}/${tenant2}/warehouses/${wh2}/zones/${zone}/bins`).set('Authorization', `Bearer ${owner2}`).set(KEY_HEADER, ulid()).send({ code: 'S-01-01', capacity: 1_000_000, type: 'shelf' }).expect(201)).body.id as string;
      const csv = [
        'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode',
        'SW-OUT,Out of stock,pcs,,1800,,false,false,false,,,',
        'SW-IN,Has stock,pcs,,1800,,false,false,false,,,',
        'SW-T1,IST before,pcs,,1800,,false,false,false,,,',
        'SW-T2,IST after,pcs,,1800,,false,false,false,,,',
        'SW-ROT,Rotation in stock,pcs,,1800,,false,false,false,,,',
        'SW-ROTOUT,Rotation out of stock,pcs,,1800,,false,false,false,,,',
        'SW-INACT,Inactive cache,pcs,,1800,,false,false,false,,,',
      ].join('\n');
      await http().post(`${API}/${tenant2}/catalog/imports`).set('Authorization', `Bearer ${owner2}`).set(KEY_HEADER, ulid()).field('mode', 'initial').attach('file', Buffer.from(csv, 'utf8'), { filename: 'c.csv', contentType: 'text/csv' }).expect(201);
      for (const row of (await sql`select id, code from skus where tenant_id = ${tenant2}`) as unknown as { id: string; code: string }[]) sku2.set(row.code, row.id);
    });

    async function order2(code: string, extra: Record<string, unknown> = {}): Promise<string> {
      const res = await http()
        .post(`${API}/${tenant2}/outbound/orders`)
        .set('Authorization', `Bearer ${ops2}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh2, lines: [{ skuId: sku2.get(code)!, quantity: 1 }], destination: testAddress(), ...extra })
        .expect(201);
      return res.body.order.id as string;
    }

    async function seed2(code: string, qty: number): Promise<void> {
      await http().post(`${API}/${tenant2}/inventory/adjustments`).set('Authorization', `Bearer ${ops2}`).set(KEY_HEADER, ulid()).send({ warehouseId: wh2, skuId: sku2.get(code)!, binId: bin2, quantityDelta: qty, reasonCode: 'stock-count', note: 'sweep' }).expect(201);
    }

    async function reserved(orderId: string): Promise<number> {
      return Number(((await sql`select reserved_qty::text as q from order_lines where order_id = ${orderId}`) as unknown as { q: string }[])[0]!.q);
    }

    it('"Starvation" (A5): 51 overdue out-of-stock orders ahead of one with stock — one tick allocates it (out-of-stock orders count against the scan, never the batch)', async () => {
      const urgent: string[] = [];
      for (let index = 0; index < 51; index += 1) urgent.push(await order2('SW-OUT', { priority: 'urgent', shipByDate: istToday() }));
      const routine = await order2('SW-IN');
      await seed2('SW-IN', 1);
      const report = await outbound.sweepBackorders(tenant2);
      expect(await reserved(routine)).toBe(1_000);
      expect(report).toMatchObject({ allocatedOrders: 1, unitsReserved: 1 });
      expect(report.scanned).toBe(52);
      expect(report.stillShortOrders).toBe(51);
      for (const orderId of urgent.slice(0, 3)) expect(await reserved(orderId)).toBe(0);
      // Tidy: the out-of-stock orders leave the tenant for the IST test.
      for (const orderId of urgent) {
        await http().post(`${API}/${tenant2}/outbound/orders/${orderId}/cancel`).set('Authorization', `Bearer ${ops2}`).set(KEY_HEADER, ulid()).send({}).expect(200);
      }
    });

    it('C4 — the rotating window: with more waiting orders ahead than the scan cap, the next tick scans on from where the last stopped', async () => {
      allocation.scanCap = 2;
      try {
        const ahead: string[] = [];
        for (let index = 0; index < 3; index += 1) ahead.push(await order2('SW-ROTOUT', { priority: 'urgent', shipByDate: istToday() }));
        const behind = await order2('SW-ROT');
        await seed2('SW-ROT', 1);
        const first = await outbound.sweepBackorders(tenant2);
        expect(first.allocatedOrders).toBe(0);
        expect(await reserved(behind)).toBe(0);
        const second = await outbound.sweepBackorders(tenant2);
        expect(second.allocatedOrders).toBe(1);
        expect(await reserved(behind)).toBe(1_000);
        for (const orderId of ahead) {
          await http().post(`${API}/${tenant2}/outbound/orders/${orderId}/cancel`).set('Authorization', `Bearer ${ops2}`).set(KEY_HEADER, ulid()).send({}).expect(200);
        }
      } finally {
        allocation.scanCap = 500;
        allocation.scanOffsets.delete(tenant2);
      }
    });

    it('C3 — an inactive SKU\'s whole-only miss does not mark the SKU exhausted: a smaller order of it behind is still allocated this tick', async () => {
      const bigger = await http()
        .post(`${API}/${tenant2}/outbound/orders`)
        .set('Authorization', `Bearer ${ops2}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh2, lines: [{ skuId: sku2.get('SW-INACT')!, quantity: 5 }], destination: testAddress(), priority: 'urgent' })
        .expect(201);
      const small = await order2('SW-INACT');
      await seed2('SW-INACT', 2);
      await http().patch(`${API}/${tenant2}/catalog/skus/${sku2.get('SW-INACT')!}/status`).set('Authorization', `Bearer ${owner2}`).set(KEY_HEADER, ulid()).send({ status: 'inactive', reason: 'discontinued' }).expect(200);
      await outbound.sweepBackorders(tenant2);
      expect(await reserved(bigger.body.order.id as string)).toBe(0);
      expect(await reserved(small)).toBe(1_000);
      await http().post(`${API}/${tenant2}/outbound/orders/${bigger.body.order.id as string}/cancel`).set('Authorization', `Bearer ${ops2}`).set(KEY_HEADER, ulid()).send({}).expect(200);
    });

    it('A18 — the job\'s urgency "today" is istDateOf(clock): at 18:29:59Z a ship-by of the next IST day is not yet due (high priority first); at 18:30:00Z it is (it goes first)', async () => {
      const day = '2026-11-02';
      const nextDay = '2026-11-03';
      // Pair 1 (SW-T1): judged at 18:29:59Z — IST is still 2026-11-02.
      const dueA1 = await order2('SW-T1', { shipByDate: nextDay });
      const highB1 = await order2('SW-T1', { priority: 'high' });
      // Pair 2 (SW-T2): judged at 18:30:00Z — IST is 2026-11-03.
      const dueA2 = await order2('SW-T2', { shipByDate: nextDay });
      const highB2 = await order2('SW-T2', { priority: 'high' });
      try {
        await seed2('SW-T1', 1);
        backorderAllocationClock.now = () => new Date(`${day}T18:29:59.000Z`);
        await outbound.sweepBackorders(tenant2);
        expect([await reserved(dueA1), await reserved(highB1)]).toEqual([0, 1_000]);
        await seed2('SW-T2', 1);
        backorderAllocationClock.now = () => new Date(`${day}T18:30:00.000Z`);
        await outbound.sweepBackorders(tenant2);
        expect([await reserved(dueA2), await reserved(highB2)]).toEqual([1_000, 0]);
      } finally {
        backorderAllocationClock.now = () => new Date();
      }
    });
  });
});
