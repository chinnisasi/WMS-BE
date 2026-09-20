import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { fromMilli } from '../src/shared/primitives/quantity';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions — the same bootstrap the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// A host that exports any poll interval would boot background workers and
// race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(60_000);

/**
 * One SKU per scenario — no two tests share stock or a composition, so a
 * failed assertion can never poison its siblings. `KIT-KG`/`COMP-G` are the
 * kilogram pair: the sub-milli explosion refusal needs a component whose
 * per-kit milli quantity is NOT a multiple of the milli scale, and only a
 * fractional unit (each = 0 places, kg = 3) can produce one.
 */
const SKU_CODES = [
  // explode: 1 kit = 2×E1 + 3×E2
  'KIT-KE1', 'COMP-E1', 'COMP-E2',
  // short: 1 kit = 2×S1 + 3×S2 (S2 starves)
  'KIT-KS1', 'COMP-S1', 'COMP-S2',
  // mixed order: the kit line + the ordinary line
  'KIT-KM1', 'COMP-M1', 'COMP-M2', 'PLAIN-M',
  // point-in-time: the composition edited under an accepted order
  'KIT-KN1', 'COMP-N1',
  // cancel
  'KIT-KC1', 'COMP-C1', 'COMP-C2',
  // the wave→pick→pack→dispatch flow
  'KIT-KF1', 'COMP-F1', 'COMP-F2',
  // PUT arms
  'KIT-KPUT', 'COMP-P1', 'COMP-P2',
  // flat BOM: KISRC is the kit that then becomes a component
  'KIT-KISRC', 'COMP-ISA',
  // the mutual-composition race
  'KIT-RACEA', 'KIT-RACEB',
  // list pagination
  'KIT-LISTA', 'KIT-LISTB', 'COMP-LIST',
  // the overflow refusal (a per-kit quantity that explodes past any line)
  'KIT-KO', 'COMP-O1',
  // a SKU with on-hand / a live reservation cannot become a kit
  'HOLD-C1', 'HOLD-R1',
  // the precision refusal: a kit in kg whose component is a 0-decimal unit
  'COMP-PE1',
  // the over-receipt approval arm (a kit that arrives between GRN and decision)
  'OVR-KIT',
] as const;
const KG_CODES = ['KIT-KG', 'COMP-G', 'KIT-KPREC'] as const; // the sub-milli/precision kit pairs

interface KitComponent {
  skuId: string;
  code: string;
  qty: number;
}

interface Kit {
  skuId: string;
  tenantId: string;
  code: string;
  name: string;
  components: KitComponent[];
  createdAt: string;
}

interface OrderLine {
  id: string;
  orderId: string;
  skuId: string;
  qty: number;
  reservedQty: number;
  shortfallQty: number;
  status: string;
  reservationId: string | null;
  reservationState: string | null;
  parentLineId: string | null;
}

interface PickLine {
  id: string;
  picklistId: string;
  orderId: string;
  orderLineId: string;
  skuId: string;
  binId: string | null;
  qty: number;
  status: string;
}

interface Picklist {
  id: string;
  waveId: string;
  orderId: string | null;
  status: string;
  lines: PickLine[];
}

interface Wave {
  id: string;
  status: string;
  picklists: Picklist[];
}

describe('kits: kit_compositions, the never-independent-stock guards, order explosion (e2e, story 11.4)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  /** A WEB operator session — the pack bench rides the tenant guard. */
  let operatorWebToken: string;
  /** The badge-in DEVICE session — picking and blind receiving. */
  let operatorToken: string;
  let warehouseId: string;
  let binA: string;
  /** The over-receipt test's PO needs a vendor (the receiving.spec fixture). */
  let vendorId: string;
  // The KE1 create key — the replay and divergent-retry tests re-send it.
  let ke1CreateKey: string;
  const skuIds = new Map<string, string>();

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('kits');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    // ── tenant + three roles (owner, ops_manager, operator) ───────────────
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Kit Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ke1CreateKey = ulid();
    const signIn = (address: string, password: string) =>
      request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: address, password })
        .expect(200)
        .then((res) => res.body.accessToken as string);
    ownerToken = await signIn(email, 'correct-horse-battery');
    const invite = async (role: string, password: string): Promise<string> => {
      const inviteeEmail = `${role}-${ulid().toLowerCase()}@example.com`;
      const invited = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/users`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email: inviteeEmail, role })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password })
        .expect(200);
      return signIn(inviteeEmail, password);
    };
    opsToken = await invite('ops_manager', 'ops-password-123');
    operatorWebToken = await invite('operator', 'floor-password-123');

    // ── warehouse → zone → bin ─────────────────────────────────────────────
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ origin: testAddress(), code: `KIT-${ulid().slice(10, 16).toUpperCase()}`, name: `Kit WH ${ulid()}` })
      .expect(201);
    warehouseId = warehouse.body.id as string;
    const zone = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' })
        .expect(201)
    ).body as { id: string };
    binA = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.id}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;

    // ── the over-receipt test's vendor ────────────────────────────────────
    vendorId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/vendors`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'KIT-VEND-1', name: 'Kit Vendor 1' })
        .expect(201)
    ).body.vendor.id as string;

    // ── all scenario SKUs via catalog import ───────────────────────────────
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      ...SKU_CODES.map((code) => `${code},Kit SKU ${code},pcs,,1800,,,,,`),
      ...KG_CODES.map((code) => `${code},Kit SKU ${code},kg,,1800,,,,,`),
    ].join('\n');
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
      if ((SKU_CODES as readonly string[]).includes(item.code) || (KG_CODES as readonly string[]).includes(item.code)) {
        skuIds.set(item.code, item.id);
      }
    }
    expect(skuIds.size).toBe(SKU_CODES.length + KG_CODES.length);

    // The floor device + its badge-in operator (picking and blind receiving).
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Kit floor scanner', pin: '1357' })
      .expect(201);
    const deviceToken = enrolled.body.deviceToken as string;
    const operatorEmail = `picker-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: operatorEmail, role: 'operator' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    operatorToken = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${deviceToken}`)
        .send({ operatorEmail, pin: '1357' })
        .expect(200)
    ).body.accessToken as string;

    // Cold-start bootstrap: seed the tenant's reservation counters + ready
    // marker from the (still empty) journal.
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
  });

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      await cleanupRows();
    } catch (err) {
      cleanupError = err;
    }
    await valkey.quit().catch(() => valkey.disconnect());
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
    if (cleanupError !== undefined) throw cleanupError;
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      for (const table of [
        'picks',
        'picklist_lines',
        'picklists',
        'waves',
        'wave_policies',
        'over_receipts',
        'goods_receipt_lines',
        'goods_receipt_notes',
        'purchase_order_lines',
        'purchase_orders',
        'vendors',
        'order_lines',
        'orders',
      ]) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      await cleaner.unsafe('set session_replication_role = replica');
      for (const table of ['ledger_events', 'ledger_anchors']) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      for (const table of [
        'kit_compositions', // before skus — kit-ness is relational, the rows must go first
        'reservations',
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
      for (const tenant of createdTenantIds) {
        const keys = await valkey.keys(`wms:{${tenant}}:*`);
        if (keys.length > 0) await valkey.del(...keys);
      }
    } finally {
      await cleaner.end();
    }
  }

  // ── fixtures ───────────────────────────────────────────────────────────────

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  function createKit(
    kitSkuId: string,
    components: { skuId: string; quantity: number }[],
    key: string = ulid(),
    token = opsToken,
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/skus/${kitSkuId}/kit`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ components });
  }

  function putKit(
    kitSkuId: string,
    components: { skuId: string; quantity: number }[],
    key: string = ulid(),
    token = opsToken,
  ): SupertestTest {
    return request(app.getHttpServer())
      .put(`${API}/${tenantId}/catalog/skus/${kitSkuId}/kit`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ components });
  }

  function listKits(query: string = ''): SupertestTest {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/kits${query}`)
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  /** Seeds committed on-hand via the stock.adjustment command (HTTP). */
  async function seedStock(skuId: string, quantity: number): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId: binA,
        quantityDelta: quantity,
        reasonCode: 'cycle-count',
        note: 'kits-suite seed',
      })
      .expect(201);
  }

  function postOrder(
    lines: { skuId: string; quantity: number }[],
    key: string = ulid(),
    token = opsToken,
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, lines, destination: testAddress() });
  }

  /**
   * The real-time ATP read (facade — there is no ATP HTTP route). The facade
   * speaks milli-units, so this helper is the suite's own `fromMilli` edge
   * and every assertion below stays in base units.
   */
  async function atp(skuId: string): Promise<{ onHand: number; reserved: number; atp: number }> {
    const snapshot = await app.get(InventoryFacade).atp(tenantId, warehouseId, skuId);
    return {
      onHand: fromMilli(snapshot.onHand),
      reserved: fromMilli(snapshot.reserved),
      atp: fromMilli(snapshot.atp),
    };
  }

  /** Every journal hold owned by one order's LINES — children included. */
  async function holdsOfOrder(
    orderId: string,
  ): Promise<{ id: string; state: string; quantity: number }[]> {
    const rows = (await sql`
      select r.id, r.state, r.quantity from reservations r
      where r.tenant_id = ${tenantId}
        and r.owner_type = 'order'
        and r.owner_id in (
          select ol.id::text from order_lines ol
          where ol.tenant_id = ${tenantId} and ol.order_id = ${orderId}
        )
      order by r.id
    `) as unknown as { id: string; state: string; quantity: number }[];
    // The column holds milli-units; the suite asserts base units.
    return rows.map((row) => ({ ...row, quantity: fromMilli(Number(row.quantity)) }));
  }

  async function orderStatus(orderId: string): Promise<string> {
    const rows = await sql`select status from orders where id = ${orderId}`;
    return (rows[0] as unknown as { status: string }).status;
  }

  async function lineRows(orderId: string): Promise<
    { id: string; sku_id: string; qty: string; reserved_qty: string; parent_line_id: string | null; status: string }[]
  > {
    return (await sql`
      select id, sku_id, qty, reserved_qty, parent_line_id, status from order_lines
      where tenant_id = ${tenantId} and order_id = ${orderId}
      order by created_at, id
    `) as unknown as {
      id: string;
      sku_id: string;
      qty: string;
      reserved_qty: string;
      parent_line_id: string | null;
      status: string;
    }[];
  }

  function lineOf(order: { lines: OrderLine[] }, skuId: string): OrderLine {
    const line = order.lines.find((candidate) => candidate.skuId === skuId);
    if (line === undefined) throw new Error(`order has no line for SKU ${skuId}`);
    return line;
  }

  /** The outbox rows of one kit event type, keyed by the kit's skuId. */
  async function kitEvents(type: string, kitSkuId: string): Promise<Record<string, unknown>[]> {
    const rows = (await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = ${type}
        and payload->>'skuId' = ${kitSkuId}
    `) as unknown as { payload: Record<string, unknown> }[];
    return rows.map((row) => row.payload);
  }

  /** The order.created payload(s) for one order. */
  async function orderCreatedPayloads(orderId: string): Promise<{ order: { lines: OrderLine[] } }[]> {
    const rows = (await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'order.created'
        and payload->'order'->>'id' = ${orderId}
    `) as unknown as { payload: { order: { lines: OrderLine[] } } }[];
    return rows.map((row) => row.payload);
  }

  async function policyId(name: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/wave-policies`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, name, grouping: 'single' })
      .expect(201);
    return res.body.policy.id as string;
  }

  /** One released wave over one fresh order — the pick fixture in one call. */
  async function releasedWave(
    lines: { skuId: string; quantity: number }[],
    tag: string,
  ): Promise<{ waveId: string; orderId: string; picklist: Picklist }> {
    const created = await postOrder(lines).expect(201);
    const orderId = (created.body.order as { id: string }).id;
    const policy = await policyId(`${tag}-${ulid().slice(10, 18)}`);
    const generated = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy, orderIds: [orderId] })
      .expect(201);
    const waveId = (generated.body.wave as { id: string }).id;
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
    ).body.wave as Wave;
    const picklist = wave.picklists[0];
    if (picklist === undefined) throw new Error('fixture produced no picklist');
    return { waveId, orderId, picklist };
  }

  /** Records one pick through the device session (the 4.3 command). */
  function pick(line: PickLine, overrides: Record<string, unknown> = {}): SupertestTest {
    return request(app.getHttpServer())
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
        ...overrides,
      });
  }

  function packOrder(orderId: string, scanned: { skuId: string; qty: number }[]): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned });
  }

  function dispatchOrder(orderId: string): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, ulid())
      .send({});
  }

  // ── catalog: the kit commands ──────────────────────────────────────────────

  describe('kit create / replace / list', () => {
    it('creates a composition on an imported SKU: 201, the snapshot in composition order, one catalog.kit_created event with the BOM', async () => {
      const res = await createKit(sku('KIT-KE1'), [
        { skuId: sku('COMP-E1'), quantity: 2 },
        { skuId: sku('COMP-E2'), quantity: 3 },
      ], ke1CreateKey).expect(201);
      const kit = res.body as Kit;
      expect(kit).toMatchObject({
        skuId: sku('KIT-KE1'),
        code: 'KIT-KE1',
        name: 'Kit SKU KIT-KE1',
      });
      // The BOM in caller order, per ONE kit, base units on the way out.
      expect(kit.components).toEqual([
        { skuId: sku('COMP-E1'), code: 'COMP-E1', qty: 2 },
        { skuId: sku('COMP-E2'), code: 'COMP-E2', qty: 3 },
      ]);
      // The rows: one per component, milli below (2000 / 3000 milli).
      const rows = (await sql`
        select component_sku_id, qty from kit_compositions
        where tenant_id = ${tenantId} and kit_sku_id = ${sku('KIT-KE1')}
        order by id
      `) as unknown as { component_sku_id: string; qty: string }[];
      expect(rows).toHaveLength(2);
      expect(Number(rows[0]!.qty)).toBe(2000);
      expect(Number(rows[1]!.qty)).toBe(3000);
      // The event carries the named BOM.
      const events = await kitEvents('catalog.kit_created', sku('KIT-KE1'));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        skuId: sku('KIT-KE1'),
        code: 'KIT-KE1',
        components: [
          { skuId: sku('COMP-E1'), code: 'COMP-E1', qty: 2 },
          { skuId: sku('COMP-E2'), code: 'COMP-E2', qty: 3 },
        ],
      });
    });

    it('replays a same-key retry: the same snapshot, no second event, no duplicate rows', async () => {
      const res = await createKit(sku('KIT-KE1'), [
        { skuId: sku('COMP-E1'), quantity: 2 },
        { skuId: sku('COMP-E2'), quantity: 3 },
      ], ke1CreateKey).expect(201);
      expect((res.body as Kit).skuId).toBe(sku('KIT-KE1'));
      expect(await kitEvents('catalog.kit_created', sku('KIT-KE1'))).toHaveLength(1);
      const rows = (await sql`
        select count(*)::int as n from kit_compositions where kit_sku_id = ${sku('KIT-KE1')}
      `) as unknown as { n: number }[];
      expect(Number(rows[0]!.n)).toBe(2);
    });

    it('rejects a same-key retry with a DIFFERENT payload: 422 idempotency-key-reuse', async () => {
      const res = await createKit(sku('KIT-KE1'), [
        { skuId: sku('COMP-E1'), quantity: 5 },
        { skuId: sku('COMP-E2'), quantity: 3 },
      ], ke1CreateKey).expect(422);
      expect(res.body).toMatchObject({ status: 422, code: 'idempotency-key-reuse' });
    });

    it('409 duplicate-kit-component when the same component SKU appears twice', async () => {
      const res = await createKit(sku('KIT-KS1'), [
        { skuId: sku('COMP-S1'), quantity: 2 },
        { skuId: sku('COMP-S1'), quantity: 1 },
      ]).expect(409);
      expect(res.body).toMatchObject({ status: 409, code: 'duplicate-kit-component' });
    });

    it('400 kit-self-reference when the kit names itself as a component', async () => {
      const res = await createKit(sku('KIT-KS1'), [
        { skuId: sku('KIT-KS1'), quantity: 1 },
        { skuId: sku('COMP-S1'), quantity: 2 },
      ]).expect(400);
      expect(res.body).toMatchObject({ status: 400, code: 'kit-self-reference' });
    });

    it('404 for an unknown kit SKU and 404 kit-component-not-found for an unknown component', async () => {
      await createKit(uuidv7(), [{ skuId: sku('COMP-S1'), quantity: 1 }]).expect(404);
      const res = await createKit(sku('KIT-KS1'), [{ skuId: uuidv7(), quantity: 1 }]).expect(404);
      expect(res.body).toMatchObject({ code: 'kit-component-not-found' });
    });

    it('409 kit-component-is-kit: a component cannot itself be a kit (flat BOM)', async () => {
      // The source kit first.
      await createKit(sku('KIT-KISRC'), [{ skuId: sku('COMP-ISA'), quantity: 1 }]).expect(201);
      const res = await createKit(sku('KIT-KS1'), [
        { skuId: sku('KIT-KISRC'), quantity: 1 },
        { skuId: sku('COMP-S2'), quantity: 3 },
      ]).expect(409);
      expect(res.body).toMatchObject({ status: 409, code: 'kit-component-is-kit' });
      // Nothing was written to the refused kit.
      const rows = (await sql`
        select count(*)::int as n from kit_compositions where kit_sku_id = ${sku('KIT-KS1')}
      `) as unknown as { n: number }[];
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it('409 kit-already-composed: create is the only door into kit-ness', async () => {
      const res = await createKit(sku('KIT-KE1'), [{ skuId: sku('COMP-E1'), quantity: 1 }]).expect(409);
      expect(res.body).toMatchObject({ status: 409, code: 'kit-already-composed' });
    });

    it('400 empty-kit-composition on an empty composition (the NAMED arm, create and PUT) and 400 on a non-integer quantity for a whole-unit component', async () => {
      // No DTO edge validator eats the arm: an empty array reaches the
      // command, whose guard answers the named 400 (the DTO carries no
      // @ArrayMinSize for exactly this reason).
      const empty = await createKit(sku('KIT-KS1'), []).expect(400);
      expect(empty.body).toMatchObject({ status: 400, code: 'empty-kit-composition' });
      // PUT: the shape check runs before the not-found door check.
      const putEmpty = await putKit(sku('KIT-KPUT'), []).expect(400);
      expect(putEmpty.body).toMatchObject({ status: 400, code: 'empty-kit-composition' });
      // `each` declares zero decimal places — 1.5 of a component is not a
      // quantity that unit can express.
      const fine = await createKit(sku('KIT-KS1'), [{ skuId: sku('COMP-S1'), quantity: 1.5 }]).expect(400);
      expect(fine.body).toMatchObject({ status: 400, code: 'validation-failed' });
    });

    it('400 when a kit carries more than 50 components', async () => {
      const tooMany = Array.from({ length: 51 }, () => ({ skuId: uuidv7(), quantity: 1 }));
      const res = await createKit(sku('KIT-KS1'), tooMany).expect(400);
      expect(res.body).toMatchObject({ status: 400, code: 'validation-failed' });
    });

    it('403 role-denied: a composition is a sku.edit, which the operator role does not carry', async () => {
      const res = await createKit(sku('KIT-KS1'), [{ skuId: sku('COMP-S1'), quantity: 2 }], ulid(), operatorWebToken)
        .expect(403);
      expect(res.body).toMatchObject({ status: 403, code: 'role-denied' });
      const rows = (await sql`
        select count(*)::int as n from kit_compositions where kit_sku_id = ${sku('KIT-KS1')}
      `) as unknown as { n: number }[];
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it('PUT replaces the whole BOM: 200, catalog.kit_edited, and the replay pins the replaced snapshot', async () => {
      await createKit(sku('KIT-KPUT'), [{ skuId: sku('COMP-P1'), quantity: 1 }]).expect(201);
      const key = ulid();
      const res = await putKit(sku('KIT-KPUT'), [
        { skuId: sku('COMP-P1'), quantity: 5 },
        { skuId: sku('COMP-P2'), quantity: 2 },
      ], key).expect(200);
      expect((res.body as Kit).components).toEqual([
        { skuId: sku('COMP-P1'), code: 'COMP-P1', qty: 5 },
        { skuId: sku('COMP-P2'), code: 'COMP-P2', qty: 2 },
      ]);
      const rows = (await sql`
        select component_sku_id, qty from kit_compositions
        where tenant_id = ${tenantId} and kit_sku_id = ${sku('KIT-KPUT')}
        order by id
      `) as unknown as { component_sku_id: string; qty: string }[];
      expect(rows).toHaveLength(2);
      expect(Number(rows[1]!.qty)).toBe(2000);
      const events = await kitEvents('catalog.kit_edited', sku('KIT-KPUT'));
      expect(events).toHaveLength(1);
      // The replay returns the same snapshot and appends no second event.
      const replayed = await putKit(sku('KIT-KPUT'), [
        { skuId: sku('COMP-P1'), quantity: 5 },
        { skuId: sku('COMP-P2'), quantity: 2 },
      ], key).expect(200);
      expect((replayed.body as Kit).skuId).toBe(sku('KIT-KPUT'));
      expect(await kitEvents('catalog.kit_edited', sku('KIT-KPUT'))).toHaveLength(1);
    });

    it('PUT on a non-kit SKU is a 404 — replace never creates kit-ness', async () => {
      const res = await putKit(sku('COMP-P1'), [{ skuId: sku('COMP-P2'), quantity: 1 }]).expect(404);
      expect(res.body).toMatchObject({ status: 404, code: 'not-found' });
      const rows = (await sql`
        select count(*)::int as n from kit_compositions where kit_sku_id = ${sku('COMP-P1')}
      `) as unknown as { n: number }[];
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it('list: keyset pages walk every kit exactly once, components stitched per page', async () => {
      await createKit(sku('KIT-LISTA'), [{ skuId: sku('COMP-LIST'), quantity: 1 }]).expect(201);
      await createKit(sku('KIT-LISTB'), [
        { skuId: sku('COMP-LIST'), quantity: 2 },
        { skuId: sku('COMP-P1'), quantity: 1 },
      ]).expect(201);

      const seen = new Map<string, Kit>();
      let cursor: string | null = null;
      for (let page = 0; page < 50; page += 1) {
        const query = cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
        const res = await listKits(query).expect(200);
        const body = res.body as { items: Kit[]; nextCursor: string | null };
        for (const item of body.items) {
          expect(seen.has(item.skuId)).toBe(false);
          seen.set(item.skuId, item);
        }
        cursor = body.nextCursor;
        if (cursor === null) break;
      }
      expect(cursor).toBeNull();
      // Every kit the suite has created so far, with its stitched BOM.
      const expected: [string, KitComponent[]][] = [
        ['KIT-KE1', [
          { skuId: sku('COMP-E1'), code: 'COMP-E1', qty: 2 },
          { skuId: sku('COMP-E2'), code: 'COMP-E2', qty: 3 },
        ]],
        ['KIT-KISRC', [{ skuId: sku('COMP-ISA'), code: 'COMP-ISA', qty: 1 }]],
        ['KIT-KPUT', [
          { skuId: sku('COMP-P1'), code: 'COMP-P1', qty: 5 },
          { skuId: sku('COMP-P2'), code: 'COMP-P2', qty: 2 },
        ]],
        ['KIT-LISTA', [{ skuId: sku('COMP-LIST'), code: 'COMP-LIST', qty: 1 }]],
        ['KIT-LISTB', [
          { skuId: sku('COMP-LIST'), code: 'COMP-LIST', qty: 2 },
          { skuId: sku('COMP-P1'), code: 'COMP-P1', qty: 1 },
        ]],
      ];
      for (const [code, components] of expected) {
        const kit = seen.get(sku(code));
        expect(kit).toBeDefined();
        expect(kit!.components).toEqual(components);
      }
      // A malformed cursor is a 400, not a crash.
      const bad = await listKits('?cursor=bogus').expect(400);
      expect(bad.body).toMatchObject({ status: 400, code: 'invalid-cursor' });
    });

    it('the concurrent mutual-composition cycle: A∋B and B∋A race, exactly one wins', async () => {
      const settled = await Promise.allSettled([
        createKit(sku('KIT-RACEA'), [{ skuId: sku('KIT-RACEB'), quantity: 1 }], ulid()),
        createKit(sku('KIT-RACEB'), [{ skuId: sku('KIT-RACEA'), quantity: 1 }], ulid()),
      ]);
      const responses = settled.map((outcome) => {
        if (outcome.status !== 'fulfilled') throw outcome.reason;
        return outcome.value;
      });
      const statuses = responses.map((res) => res.status).sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);
      const loser = responses.find((res) => res.status === 409)!;
      expect(loser.body).toMatchObject({ code: 'kit-component-is-kit' });
      // Exactly one kit exists, and it names the OTHER sku — no cycle.
      const rows = (await sql`
        select kit_sku_id, component_sku_id from kit_compositions
        where tenant_id = ${tenantId}
          and kit_sku_id in (${sku('KIT-RACEA')}, ${sku('KIT-RACEB')})
      `) as unknown as { kit_sku_id: string; component_sku_id: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.component_sku_id).not.toBe(rows[0]!.kit_sku_id);
      expect(await kitEvents('catalog.kit_created', rows[0]!.kit_sku_id)).toHaveLength(1);
    });
  });

  // ── the never-independent-stock guards ────────────────────────────────────

  describe('a kit never holds stock', () => {
    it('stock.adjustment on a kit SKU is 409 kit-cannot-hold-stock and writes nothing', async () => {
      const before = (await sql`
        select count(*)::int as n from stock_on_hand where tenant_id = ${tenantId} and sku_id = ${sku('KIT-KE1')}
      `) as unknown as { n: number }[];
      const res = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId: sku('KIT-KE1'),
          binId: binA,
          quantityDelta: 5,
          reasonCode: 'cycle-count',
          note: 'kit-suite guard probe',
        })
        .expect(409);
      expect(res.body).toMatchObject({ status: 409, code: 'kit-cannot-hold-stock' });
      const after = (await sql`
        select count(*)::int as n from stock_on_hand where tenant_id = ${tenantId} and sku_id = ${sku('KIT-KE1')}
      `) as unknown as { n: number }[];
      expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    });

    it('a GRN line against a kit SKU is 409 kit-cannot-hold-stock (blind receipt)', async () => {
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          poId: null,
          blindReasonCode: 'unannounced-delivery',
          occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          lines: [
            { poLineId: null, skuId: sku('KIT-KE1'), batchCode: null, mfgDate: null, qty: 3 },
          ],
        })
        .expect(409)
        .then((res) => expect(res.body).toMatchObject({ status: 409, code: 'kit-cannot-hold-stock' }));
      const rows = (await sql`
        select count(*)::int as n from stock_on_hand where tenant_id = ${tenantId} and sku_id = ${sku('KIT-KE1')}
      `) as unknown as { n: number }[];
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it('409 kit-sku-holds-stock: a SKU with on-hand stock cannot become a kit', async () => {
      // A kit never reserves, receives or adjusts stock, and no order line can
      // ever reserve one — a kit created ON stock would strand it forever.
      await seedStock(sku('HOLD-C1'), 5);
      const res = await createKit(sku('HOLD-C1'), [{ skuId: sku('COMP-E1'), quantity: 1 }]).expect(409);
      expect(res.body).toMatchObject({ status: 409, code: 'kit-sku-holds-stock' });
      expect(res.body.detail as string).toContain('on hand');
      const rows = (await sql`
        select count(*)::int as n from kit_compositions where kit_sku_id = ${sku('HOLD-C1')}
      `) as unknown as { n: number }[];
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it('409 kit-sku-holds-stock: a SKU with a live reservation cannot become a kit', async () => {
      await seedStock(sku('HOLD-R1'), 10);
      await postOrder([{ skuId: sku('HOLD-R1'), quantity: 5 }]).expect(201);
      // Zero the on-hand first — the guard's stock arm would otherwise answer
      // (the on-hand check precedes the reservation check by design).
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId: sku('HOLD-R1'),
          binId: binA,
          quantityDelta: -10,
          reasonCode: 'cycle-count',
          note: 'kits-suite: isolate the reservation arm',
        })
        .expect(201);
      const res = await createKit(sku('HOLD-R1'), [{ skuId: sku('COMP-E1'), quantity: 1 }]).expect(409);
      expect(res.body).toMatchObject({ status: 409, code: 'kit-sku-holds-stock' });
      expect(res.body.detail as string).toContain('reservation');
    });

    it('over-receipt approval on a SKU that became a kit after the GRN: 409 kit-cannot-hold-stock, the excess stays unapplied', async () => {
      // The GRN applies its within-open portion (10) and pends the excess
      // (5) for approval — a decision that can land days later.
      const po = (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/inbound/purchase-orders`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({
            warehouseId,
            vendorId,
            code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
            lines: [{ skuId: sku('OVR-KIT'), orderedQty: 10, unitCostPaise: 1250 }],
          })
          .expect(201)
      ).body.purchaseOrder as { id: string; lines: { id: string }[] };
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          poId: po.id,
          blindReasonCode: null,
          occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          lines: [{ poLineId: po.lines[0]!.id, skuId: sku('OVR-KIT'), batchCode: null, mfgDate: null, qty: 15 }],
        })
        .expect(201);
      const pending = (await sql`
        select id from over_receipts
        where tenant_id = ${tenantId} and sku_id = ${sku('OVR-KIT')} and status = 'pending'
      `) as unknown as { id: string }[];
      expect(pending).toHaveLength(1);
      const overReceiptId = pending[0]!.id;
      // Move the applied stock away (to binA) and zero the SKU: the
      // kit-create stock guard refuses a SKU still holding stock, so the
      // reachable window for this refusal is an emptied SKU.
      const recvBin = (await sql`
        select bin_id from stock_on_hand
        where tenant_id = ${tenantId} and sku_id = ${sku('OVR-KIT')} and quantity > 0 limit 1
      `) as unknown as { bin_id: string }[];
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId: sku('OVR-KIT'),
          binId: recvBin[0]!.bin_id,
          quantityDelta: -10,
          reasonCode: 'cycle-count',
          note: 'kits-suite: empty the SKU',
        })
        .expect(201);
      await createKit(sku('OVR-KIT'), [{ skuId: sku('COMP-E1'), quantity: 1 }]).expect(201);
      // The approval is a +stock writer in its own right — it must refuse.
      const res = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/over-receipts/${overReceiptId}/approve`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .expect(409);
      expect(res.body).toMatchObject({ status: 409, code: 'kit-cannot-hold-stock' });
      // Nothing applied: the decision is terminal-refused, the row stays
      // pending for a human reject.
      const after = (await sql`
        select status from over_receipts where id = ${overReceiptId}
      `) as unknown as { status: string }[];
      expect(after[0]!.status).toBe('pending');
    });

    it('CHECKs on kit_compositions: a zero quantity and a self-row are DB-rejected', async () => {
      await expect(sql`
        insert into kit_compositions (id, tenant_id, kit_sku_id, component_sku_id, qty)
        values (${uuidv7()}, ${tenantId}, ${sku('KIT-KE1')}, ${sku('COMP-E1')}, 0)
      `).rejects.toThrow(/kit_compositions_qty_positive/);
      await expect(sql`
        insert into kit_compositions (id, tenant_id, kit_sku_id, component_sku_id, qty)
        values (${uuidv7()}, ${tenantId}, ${sku('KIT-KE1')}, ${sku('KIT-KE1')}, 1000)
      `).rejects.toThrow(/kit_compositions_no_self/);
    });

    it('RLS on kit_compositions: an un-scoped session sees zero rows; a scoped one sees its own', async () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1 });
      try {
        const unscoped = (await rls.unsafe('select count(*)::int as n from kit_compositions')) as unknown as { n: number }[];
        expect(Number(unscoped[0]!.n)).toBe(0);
        await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
        const scoped = (await rls.unsafe('select count(*)::int as n from kit_compositions')) as unknown as { n: number }[];
        expect(Number(scoped[0]!.n)).toBeGreaterThan(0);
      } finally {
        await rls.end();
      }
    });
  });

  // ── order explosion ────────────────────────────────────────────────────────

  describe('order acceptance explodes kit lines', () => {
    it('explodes a kit line: parent holds nothing, children hold their own reservations, order.created carries the children', async () => {
      await seedStock(sku('COMP-E1'), 100);
      await seedStock(sku('COMP-E2'), 100);
      const key = ulid();
      const res = await postOrder([{ skuId: sku('KIT-KE1'), quantity: 10 }], key).expect(201);
      const order = res.body.order as { id: string; status: string; lines: OrderLine[] };
      expect(order.status).toBe('accepted');
      expect(order.lines).toHaveLength(3);

      // The parent: no hold, no shortfall — the kit's components reserved.
      const parent = lineOf(order, sku('KIT-KE1'));
      expect(parent).toMatchObject({
        qty: 10,
        reservedQty: 0,
        shortfallQty: 0,
        status: 'open',
        reservationId: null,
        reservationState: null,
        parentLineId: null,
      });
      // The children: one per component, exploded qty, own holds, linked up.
      const child1 = lineOf(order, sku('COMP-E1'));
      const child2 = lineOf(order, sku('COMP-E2'));
      expect(child1).toMatchObject({
        qty: 20,
        reservedQty: 20,
        shortfallQty: 0,
        status: 'open',
        reservationState: 'held',
        parentLineId: parent.id,
      });
      expect(child2).toMatchObject({
        qty: 30,
        reservedQty: 30,
        shortfallQty: 0,
        status: 'open',
        reservationState: 'held',
        parentLineId: parent.id,
      });
      // The journal: two holds owned by the CHILD line ids.
      expect(await holdsOfOrder(order.id)).toHaveLength(2);
      // ATP moved on the components, never on the kit.
      expect(await atp(sku('COMP-E1'))).toMatchObject({ onHand: 100, reserved: 20, atp: 80 });
      expect(await atp(sku('COMP-E2'))).toMatchObject({ onHand: 100, reserved: 30, atp: 70 });
      expect(await atp(sku('KIT-KE1'))).toMatchObject({ onHand: 0, reserved: 0, atp: 0 });
      // order.created carries the exploded snapshot (children included).
      const payloads = await orderCreatedPayloads(order.id);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]!.order.lines).toHaveLength(3);
      expect(lineOf(payloads[0]!.order, sku('COMP-E1'))).toMatchObject({ parentLineId: parent.id, qty: 20 });

      // A replay under the original key: the same order, no double explosion.
      const replayed = await postOrder([{ skuId: sku('KIT-KE1'), quantity: 10 }], key).expect(201);
      expect((replayed.body.order as { id: string }).id).toBe(order.id);
      expect((replayed.body.order as { lines: OrderLine[] }).lines).toHaveLength(3);
      expect(await orderCreatedPayloads(order.id)).toHaveLength(1);
      expect(await holdsOfOrder(order.id)).toHaveLength(2);
    });

    it('rejects a same-key retry with a different quantity: 422, no second order', async () => {
      const key = ulid();
      await postOrder([{ skuId: sku('KIT-KE1'), quantity: 1 }], key).expect(201);
      const res = await postOrder([{ skuId: sku('KIT-KE1'), quantity: 2 }], key).expect(422);
      expect(res.body).toMatchObject({ status: 422, code: 'idempotency-key-reuse' });
    });

    it('a short component backorders the WHOLE kit — no holds, the granted sibling released', async () => {
      await createKit(sku('KIT-KS1'), [
        { skuId: sku('COMP-S1'), quantity: 2 },
        { skuId: sku('COMP-S2'), quantity: 3 },
      ]).expect(201);
      await seedStock(sku('COMP-S1'), 100); // covers 2×10
      await seedStock(sku('COMP-S2'), 5); // covers only 3×1 — 10 kits need 30
      const res = await postOrder([{ skuId: sku('KIT-KS1'), quantity: 10 }]).expect(201);
      const order = res.body.order as { id: string; status: string; lines: OrderLine[] };
      const parent = lineOf(order, sku('KIT-KS1'));
      // The all-or-nothing outcome: the parent's shortfall IS the kit qty.
      expect(parent).toMatchObject({ reservedQty: 0, shortfallQty: 10, status: 'backordered', reservationId: null });
      expect(lineOf(order, sku('COMP-S1'))).toMatchObject({
        reservedQty: 0,
        status: 'backordered',
        reservationId: null,
        parentLineId: parent.id,
      });
      expect(lineOf(order, sku('COMP-S2'))).toMatchObject({
        reservedQty: 0,
        status: 'backordered',
        reservationId: null,
        parentLineId: parent.id,
      });
      // No LIVE holds anywhere — the granted sibling AND the partial hold
      // released with the kit (the journal keeps the trail as released rows).
      const holds = await holdsOfOrder(order.id);
      expect(holds).toHaveLength(2);
      expect(holds.every((hold) => hold.state === 'released')).toBe(true);
      expect(await atp(sku('COMP-S1'))).toMatchObject({ onHand: 100, reserved: 0, atp: 100 });
      expect(await atp(sku('COMP-S2'))).toMatchObject({ onHand: 5, reserved: 0, atp: 5 });
    });

    it('mixed order: the ordinary line reserves exactly as before', async () => {
      await seedStock(sku('COMP-M1'), 100);
      await seedStock(sku('COMP-M2'), 100);
      await seedStock(sku('PLAIN-M'), 10);
      await createKit(sku('KIT-KM1'), [
        { skuId: sku('COMP-M1'), quantity: 2 },
        { skuId: sku('COMP-M2'), quantity: 3 },
      ]).expect(201);
      const res = await postOrder([
        { skuId: sku('PLAIN-M'), quantity: 5 },
        { skuId: sku('KIT-KM1'), quantity: 4 },
      ]).expect(201);
      const order = res.body.order as { id: string; status: string; lines: OrderLine[] };
      expect(order.lines).toHaveLength(4); // PLAIN + parent + 2 children
      const plain = lineOf(order, sku('PLAIN-M'));
      expect(plain).toMatchObject({
        qty: 5,
        reservedQty: 5,
        shortfallQty: 0,
        status: 'open',
        reservationState: 'held',
        parentLineId: null,
      });
      const parent = lineOf(order, sku('KIT-KM1'));
      expect(parent).toMatchObject({ reservedQty: 0, shortfallQty: 0, status: 'open', parentLineId: null });
      expect(lineOf(order, sku('COMP-M1'))).toMatchObject({ qty: 8, reservedQty: 8, parentLineId: parent.id });
      expect(lineOf(order, sku('COMP-M2'))).toMatchObject({ qty: 12, reservedQty: 12, parentLineId: parent.id });
      expect(await holdsOfOrder(order.id)).toHaveLength(3);
    });

    it('an accepted order is immune to a later composition edit (point-in-time children)', async () => {
      await seedStock(sku('COMP-N1'), 100);
      await createKit(sku('KIT-KN1'), [{ skuId: sku('COMP-N1'), quantity: 1 }]).expect(201);
      const before = await postOrder([{ skuId: sku('KIT-KN1'), quantity: 5 }]).expect(201);
      const beforeOrder = before.body.order as { id: string; lines: OrderLine[] };
      const beforeChild = lineOf(beforeOrder, sku('COMP-N1'));
      expect(beforeChild.qty).toBe(5);

      // The edit: the same kit now carries TWO components per kit.
      await putKit(sku('KIT-KN1'), [{ skuId: sku('COMP-N1'), quantity: 2 }]).expect(200);
      const childRows = (await sql`
        select qty from order_lines where id = ${beforeChild.id}
      `) as unknown as { qty: string }[];
      expect(fromMilli(Number(childRows[0]!.qty))).toBe(5); // unchanged

      // New orders explode against the NEW composition.
      const after = await postOrder([{ skuId: sku('KIT-KN1'), quantity: 5 }]).expect(201);
      expect(lineOf(after.body.order as { lines: OrderLine[] }, sku('COMP-N1')).qty).toBe(10);
    });

    it('an explosion past the quantity ceiling is a 400 before any grant moves', async () => {
      await createKit(sku('KIT-KO'), [{ skuId: sku('COMP-O1'), quantity: 1000000 }]).expect(201);
      const res = await postOrder([{ skuId: sku('KIT-KO'), quantity: 100000000 }]).expect(400);
      expect(res.body).toMatchObject({ status: 400, code: 'validation-failed' });
      expect(res.body.detail as string).toContain('Split the order line');
      // No child rows exist for the refused plan (no order was created).
      const rows = (await sql`
        select count(*)::int as n from order_lines ol
        join skus s on s.id = ol.sku_id
        where ol.tenant_id = ${tenantId} and s.code = 'KIT-KO'
      `) as unknown as { n: number }[];
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it('a sub-milli explosion is a 400 — the component UoM cannot express it', async () => {
      // kg × kg: a per-kit quantity of 0.001 kg is 1 milli; a line of 0.5 kg
      // is 500 milli — the child 0.5 milli is below the kg unit's own milli
      // resolution.
      await createKit(sku('KIT-KG'), [{ skuId: sku('COMP-G'), quantity: 0.001 }]).expect(201);
      const res = await postOrder([{ skuId: sku('KIT-KG'), quantity: 0.5 }]).expect(400);
      expect(res.body).toMatchObject({ status: 400, code: 'validation-failed' });
      expect(res.body.detail as string).toContain('cannot express');
    });

    it('an explosion below the component unit\'s declared precision is a 400 — 0.5 of a 0-decimal component can never be picked', async () => {
      // A kit in kg whose component is `each` (0 decimal places): 0.5 kg of
      // the kit explodes to 0.5 each — milli-expressible, so the old
      // sub-milli check passed it, but no pick could ever record it.
      await createKit(sku('KIT-KPREC'), [{ skuId: sku('COMP-PE1'), quantity: 1 }]).expect(201);
      const res = await postOrder([{ skuId: sku('KIT-KPREC'), quantity: 0.5 }]).expect(400);
      expect(res.body).toMatchObject({ status: 400, code: 'validation-failed' });
      expect(res.body.detail as string).toContain('cannot express');
      const rows = (await sql`
        select count(*)::int as n from order_lines ol
        join skus s on s.id = ol.sku_id
        where ol.tenant_id = ${tenantId} and s.code = 'KIT-KPREC'
      `) as unknown as { n: number }[];
      expect(Number(rows[0]!.n)).toBe(0);
      // Whole kilograms explode fine: 2 kg → 2 each.
      await seedStock(sku('COMP-PE1'), 10);
      await postOrder([{ skuId: sku('KIT-KPREC'), quantity: 2 }]).expect(201);
    });

    it('cancel releases the CHILD holds and restores ATP', async () => {
      await seedStock(sku('COMP-C1'), 100);
      await seedStock(sku('COMP-C2'), 100);
      await createKit(sku('KIT-KC1'), [
        { skuId: sku('COMP-C1'), quantity: 2 },
        { skuId: sku('COMP-C2'), quantity: 3 },
      ]).expect(201);
      const created = await postOrder([{ skuId: sku('KIT-KC1'), quantity: 3 }]).expect(201);
      const order = created.body.order as { id: string; lines: OrderLine[] };
      expect(await holdsOfOrder(order.id)).toHaveLength(2);
      expect(await atp(sku('COMP-C1'))).toMatchObject({ reserved: 6, atp: 94 });

      const cancelled = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/orders/${order.id}/cancel`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(200);
      const cancelledOrder = cancelled.body.order as { status: string; lines: OrderLine[] };
      expect(cancelledOrder.status).toBe('cancelled');
      // Every line stops claiming stock in the same commit as the flip.
      for (const line of cancelledOrder.lines) {
        expect(line).toMatchObject({ reservedQty: 0, reservationId: null, reservationState: null });
      }
      // The journal keeps the trail: terminal-released, never deleted.
      const holds = await holdsOfOrder(order.id);
      expect(holds).toHaveLength(2);
      expect(holds.every((hold) => hold.state === 'released')).toBe(true);
      expect(await atp(sku('COMP-C1'))).toMatchObject({ onHand: 100, reserved: 0, atp: 100 });
      expect(await atp(sku('COMP-C2'))).toMatchObject({ onHand: 100, reserved: 0, atp: 100 });
    });

    it('wave → pick → pack → dispatch on a kit order: the picklist carries children only, the bench scans components', async () => {
      await seedStock(sku('COMP-F1'), 100);
      await seedStock(sku('COMP-F2'), 100);
      await createKit(sku('KIT-KF1'), [
        { skuId: sku('COMP-F1'), quantity: 2 },
        { skuId: sku('COMP-F2'), quantity: 3 },
      ]).expect(201);
      const { orderId, picklist } = await releasedWave([{ skuId: sku('KIT-KF1'), quantity: 2 }], 'kitflow');

      // The picklist carries the exploded CHILD lines only — the parent
      // contributes no picklist rows (it holds nothing).
      expect(picklist.lines).toHaveLength(2);
      expect(picklist.lines.find((line) => line.skuId === sku('KIT-KF1'))).toBeUndefined();
      const childF1 = picklist.lines.find((line) => line.skuId === sku('COMP-F1'))!;
      const childF2 = picklist.lines.find((line) => line.skuId === sku('COMP-F2'))!;
      expect(childF1.qty).toBe(4);
      expect(childF2.qty).toBe(6);

      // The children's parentLineId points at the kit line; the parent row
      // carries no hold and the children carry the order's holds.
      const rows = await lineRows(orderId);
      const parentRow = rows.find((row) => row.parent_line_id === null)!;
      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => row.parent_line_id === parentRow.id)).toHaveLength(2);

      // Pick both children, then pack: the bench scans per component SKU.
      await pick(childF1).expect(201);
      await pick(childF2).expect(201);
      const packed = await packOrder(orderId, [
        { skuId: sku('COMP-F1'), qty: 4 },
        { skuId: sku('COMP-F2'), qty: 6 },
      ]).expect(201);
      expect(packed.body.pack).toMatchObject({ orderId, orderStatus: 'ready_to_dispatch', totalUnits: 10 });

      // Dispatch: the child holds retire (exactly one exit each).
      const dispatched = await dispatchOrder(orderId).expect(201);
      const dispatch = dispatched.body.dispatch as {
        orderStatus: string;
        totalUnits: number;
        retiredReservationIds: string[];
        lines: { skuId: string; dispatchedQty: number }[];
      };
      expect(dispatch.orderStatus).toBe('dispatched');
      expect(dispatch.totalUnits).toBe(10); // the components' units, never the kit's
      expect(dispatch.retiredReservationIds).toHaveLength(2);
      const holds = await holdsOfOrder(orderId);
      expect(holds.every((hold) => hold.state === 'released')).toBe(true);
      expect(await orderStatus(orderId)).toBe('dispatched');
    });
  });
});