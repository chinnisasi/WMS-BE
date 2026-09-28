import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import {
  MAX_DIMENSION_MM,
  MAX_WEIGHT_GRAMS,
} from '../src/modules/outbound/pack.command';
import { SHIPMENT_STATUSES } from '../src/modules/outbound/shipment.command';
import { CAPABILITIES, ROLE_CAPABILITIES } from '../src/modules/tenancy/permissions';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions — the same bootstrap the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// Story 4.6c: the label path opens carrier credentials — the same e2e-only
// value the carriers/dispatch suites set (sealing happens at connect time).
process.env.CARRIER_ENCRYPTION_KEY ??= 'e2e-only-carrier-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(120_000);

interface PickLine {
  id: string;
  picklistId: string;
  orderId: string;
  orderLineId: string;
  skuId: string;
  binId: string | null;
  binCode: string | null;
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

/**
 * Story 4.6c — labels, manifests and tracking writeback, the matrix e2e.
 *
 * The scenario the spec pins: the sandbox carrier labels deterministically
 * in-process; the three DIRECT carriers refuse with the typed verbatim 501
 * (`carrier-transport-unconfigured`) and write NOTHING, so the retry is a
 * fresh submit against a sandbox connection; the order's status never moves
 * on a label (dispatch owns every order-state transition); the manifest is
 * an all-or-nothing set closure over ONE connection; and every table is RLS
 * fail-closed behind `app.tenant_id`.
 */
describe('labels and manifests: the shipment record and its closure (e2e, story 4.6c)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  let suiteDb: SuiteDatabase;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let accountantToken: string;
  /** A WEB session for an operator — the label desk rides the tenant guard. */
  let operatorWebToken: string;
  let warehouseId: string;
  let zoneId: string;
  let binA: string; // A-01-01
  const skuIds = new Map<string, string>();

  let deviceToken: string;
  let operatorToken: string; // the badge-in DEVICE session (picking)
  /** Story 4.6c — the tenant's carrier connections. */
  let sandboxConnectionId: string;
  let delhiveryConnectionId: string;
  /** A second tenant's sandbox connection — the tenant-predicate probe. */
  let foreignTenantId: string;
  let foreignConnectionId: string;
  /** A shipment row that belongs to the FOREIGN tenant (inserted by SQL). */
  let foreignShipmentId: string;

  /** SKU fixtures — one scenario each, so no two labels share an order. */
  const SKU_CODES = [
    'LBL-OK', // the happy path: measurement arms, outbox, audit
    'LBL-REPLAY', // byte-for-byte replay + the 422
    'LBL-ARGS', // the documented 400 arms
    'LBL-STATE', // an unpacked (accepted) order
    'LBL-DISP', // a dispatched order
    'LBL-DIRECT', // the unconfigured DIRECT carrier's verbatim 501
    'LBL-AGAIN', // the second label under a new key
    'LBL-KEY', // the 503 key-unavailable arm
    'LBL-FGN', // the tenant predicate (a foreign connection id)
    'LBL-M1', // the manifest's first member
    'LBL-M2', // …its second member
    'LBL-MMIX1', // the mixed-connections first shipment
    'LBL-MMIX2', // …and the second, through the RE-connected connection
    'LBL-AUTH', // the authority arms
  ] as const;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('label');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Label Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const signIn = (address: string, password: string) =>
      request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: address, password })
        .expect(200)
        .then((res) => res.body.accessToken as string);
    ownerToken = await signIn(email, 'correct-horse-battery');
    opsToken = await inviteAndSignIn('ops_manager', 'ops-password-123');
    accountantToken = await inviteAndSignIn('accountant', 'books-password-123');
    operatorWebToken = await inviteAndSignIn('operator', 'floor-password-123');

    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `LBL-${ulid().slice(10, 16).toUpperCase()}`, name: `Label WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
    zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binA = await createBin('A-01-01');

    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      ...SKU_CODES.map((code) => `${code},Label SKU ${code},pcs,,1800,,false,false,,,`),
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const catalog = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of catalog.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }
    expect(skuIds.size).toBeGreaterThanOrEqual(SKU_CODES.length);

    // The carrier connections: sandbox (the deterministic in-process arm the
    // whole matrix generates through) and a DIRECT carrier (delhivery — the
    // typed 501 refusal). The credential is a canary: the suite asserts it
    // never escapes into any written artifact.
    const sandbox = await connectSandbox().expect(201);
    sandboxConnectionId = sandbox.body.id as string;
    const delhivery = await connectDelhivery().expect(201);
    delhiveryConnectionId = delhivery.body.id as string;

    // The floor device + its badge-in operator (picking feeds every fixture).
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Label desk scanner', pin: '2468' })
      .expect(201);
    deviceToken = enrolled.body.deviceToken as string;
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
    const badged = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ operatorEmail, pin: '2468' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;

    // The foreign tenant: its own sandbox connection (the label tenant
    // predicate must not resolve it) and one SQL-seeded shipment row (the
    // manifest's missing-offender arm must read it as ABSENT through RLS).
    const foreignEmail = `foreign-${ulid().toLowerCase()}@example.com`;
    const foreign = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Foreign Co ${ulid()}`, ownerEmail: foreignEmail, password: 'correct-horse-battery' })
      .expect(201);
    foreignTenantId = foreign.body.tenant.id as string;
    createdTenantIds.push(foreignTenantId);
    const foreignToken = await signIn(foreignEmail, 'correct-horse-battery');
    foreignConnectionId = (
      await request(app.getHttpServer())
        .post(`${API}/${foreignTenantId}/carriers/connections`)
        .set('Authorization', `Bearer ${foreignToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          carrierCode: 'sandbox',
          accountLabel: `Foreign Sandbox ${ulid().slice(10, 16)}`,
          credential: { accountToken: 'e2e-sandbox-token' },
        })
        .expect(201)
    ).body.id as string;
    foreignShipmentId = uuidv7();
    await sql`
      insert into shipments
        (id, tenant_id, warehouse_id, order_id, status, carrier_connection_id,
         carrier_code, carrier_name, tracking_number, label_document_ref, labelled_by, labelled_at)
      values (${foreignShipmentId}::uuid, ${foreignTenantId}::uuid, ${uuidv7()}::uuid, ${uuidv7()}::uuid,
              'labelled', ${foreignConnectionId}::uuid, 'sandbox', 'Sandbox', 'SBX-FOREIGN0000',
              'sandbox://labels/foreign', ${uuidv7()}::uuid, now())
    `;

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
        'shipments',
        'manifests',
        'order_lines',
        'orders',
      ]) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      for (const table of [
        'carrier_connections',
        'reservations',
        'serials',
        'batch_on_hand',
        'stock_on_hand',
        'outbox_messages',
        'idempotency_keys',
        'audit_events',
        'catalog_import_errors',
        'catalog_imports',
        'uom_conversions',
        'batches',
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

  async function inviteAndSignIn(role: string, password: string): Promise<string> {
    const address = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: address, role })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password })
      .expect(200);
    return request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email: address, password })
      .expect(200)
      .then((res) => res.body.accessToken as string);
  }

  async function createBin(code: string): Promise<string> {
    return (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 10000, type: 'shelf', code })
        .expect(201)
    ).body.id as string;
  }

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  async function seedStock(skuId: string, binId: string, quantity: number): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId,
        quantityDelta: quantity,
        reasonCode: 'cycle-count',
        note: 'label-suite seed',
      })
      .expect(201);
  }

  async function createOrder(lines: { skuId: string; quantity: number }[]): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines, destination: testAddress() })
      .expect(201);
    return res.body.order.id as string;
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
    const orderId = await createOrder(lines);
    const policy = await policyId(`${tag}-${ulid().slice(10, 18)}`);
    const generated = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy, orderIds: [orderId] })
      .expect(201);
    const waveId = generated.body.wave.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const wave = await getWave(waveId);
    const picklist = wave.picklists[0];
    if (picklist === undefined) throw new Error('fixture produced no picklist');
    return { waveId, orderId, picklist };
  }

  async function getWave(waveId: string): Promise<Wave> {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    return res.body.wave as Wave;
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

  function dispatchOrder(orderId: string, body: Record<string, unknown> = {}): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, ulid())
      .send(body);
  }

  /** Story 4.6c — the label command through a named carrier connection. */
  function labelOrder(
    orderId: string,
    connectionId: string,
    body: Record<string, unknown> = {},
    token = operatorWebToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/label`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ carrierConnectionId: connectionId, ...body });
  }

  /** Story 4.6c — the manifest command over a named shipment set. */
  function createManifest(shipmentIds: string[], token = operatorWebToken, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/manifests`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ shipmentIds });
  }

  function listManifests(query = ''): SupertestTest {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/manifests${query}`)
      .set('Authorization', `Bearer ${operatorWebToken}`);
  }

  /** The shipment read-back — one row per order, null → 404 at the route. */
  function getShipment(orderId: string, token = operatorWebToken): SupertestTest {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/orders/${orderId}/shipment`)
      .set('Authorization', `Bearer ${token}`);
  }

  function connectSandbox(token = ownerToken): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/carriers/connections`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, ulid())
      .send({
        carrierCode: 'sandbox',
        accountLabel: `Sandbox ${ulid().slice(10, 16)}`,
        credential: { accountToken: 'canary-sandbox-token-4f2e1d' },
      });
  }

  function connectDelhivery(token = ownerToken): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/carriers/connections`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, ulid())
      .send({
        carrierCode: 'delhivery',
        accountLabel: `Delhivery ${ulid().slice(10, 16)}`,
        credential: { apiToken: 'canary-delhivery-token-f3a91c', clientName: 'canary-delhivery-client' },
      });
  }

  /** A fully-picked, PACKED order of ONE line in ONE bin — labellable. */
  async function packedOrder(
    code: string,
    quantity: number,
    tag: string,
    seed = quantity + 10,
  ): Promise<{ orderId: string; skuId: string }> {
    const skuId = sku(code);
    await seedStock(skuId, binA, seed);
    const { orderId, picklist } = await releasedWave([{ skuId, quantity }], tag);
    await pick(picklist.lines[0]!).expect(201);
    await packOrder(orderId, [{ skuId, qty: quantity }]).expect(201);
    return { orderId, skuId };
  }

  async function orderStatus(orderId: string): Promise<string> {
    const rows = await sql`select status from orders where id = ${orderId}`;
    return (rows[0] as unknown as { status: string }).status;
  }

  async function shipmentCount(orderId: string): Promise<number> {
    const rows = await sql`
      select count(*)::int as n from shipments
      where tenant_id = ${tenantId} and order_id = ${orderId}
    `;
    return Number((rows[0] as unknown as { n: number }).n);
  }

  // ── the grammar, the capability and the drift guards ──────────────────────

  it('the shipment lifecycle, the DB CHECK, the partial unique index and the capability are registered (the drift guards)', async () => {
    expect([...SHIPMENT_STATUSES]).toEqual(['labelled', 'manifested']);

    // The DB CHECK is the additive backstop to the TS constant (0024).
    const defs = await sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'shipments_status_check'
    `;
    const def = (defs[0] as unknown as { def: string }).def;
    const arms = [...def.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!).sort();
    expect(arms).toEqual([...SHIPMENT_STATUSES].sort());

    // The one-label-per-order race backstop exists, and is PARTIAL — it holds
    // only while the row is labelled (a manifested shipment keeps its history
    // without blocking anything).
    const indexes = await sql`
      select indexdef from pg_indexes where indexname = 'shipments_tenant_order_labelled_unique'
    `;
    expect((indexes[0] as unknown as { indexdef: string }).indexdef).toContain('WHERE');
    expect((indexes[0] as unknown as { indexdef: string }).indexdef).toContain("status = 'labelled'");

    expect((CAPABILITIES as readonly string[]).includes('labels.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.owner.has('labels.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.ops_manager.has('labels.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.operator.has('labels.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.accountant.has('labels.execute')).toBe(false);

    // The registry carries the sandbox stand-in the whole matrix rides.
    const carriers = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/carriers`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .expect(200);
    const codes = (carriers.body.items as { code: string }[]).map((item) => item.code);
    expect(codes).toContain('sandbox');
  });

  // ── the happy path ────────────────────────────────────────────────────────

  it('labels a packed order through the sandbox carrier: the shipment, the measurements, the outbox and the audit — and the order does not move', async () => {
    const { orderId } = await packedOrder('LBL-OK', 5, 'ok');

    const res = await labelOrder(orderId, sandboxConnectionId, {
      weightGrams: 1200,
      dimensionsMm: { lengthMm: 300, widthMm: 200, heightMm: 150 },
    }).expect(201);
    const shipment = res.body.shipment as Record<string, unknown>;
    expect(shipment.orderId).toBe(orderId);
    expect(shipment.tenantId).toBe(tenantId);
    expect(shipment.warehouseId).toBe(warehouseId);
    expect(shipment.status).toBe('labelled');
    expect(shipment.carrierConnectionId).toBe(sandboxConnectionId);
    expect(shipment.carrierCode).toBe('sandbox');
    expect(shipment.carrierName).toBe('Sandbox');
    expect(shipment.trackingNumber).toMatch(/^SBX-[0-9A-F]{12}$/);
    expect(shipment.labelDocumentRef).toMatch(/^sandbox:\/\/labels\/[0-9a-f]+$/);
    expect(shipment.weightGrams).toBe(1200);
    expect(shipment.dimensionsMm).toEqual({ lengthMm: 300, widthMm: 200, heightMm: 150 });
    expect(shipment.manifestId).toBeNull();

    // The label is a station act BESIDE the state machine — dispatch owns
    // every order transition.
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
    expect(await shipmentCount(orderId)).toBe(1);

    // The outbox row carries the writeback event (Epic 7's consumer
    // subscribes to it) — with the tracking in the payload…
    const outbox = await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'shipment.label-created'
    `;
    const mine = outbox.filter(
      (row) =>
        (row as unknown as { payload: { shipment: { orderId: string } } }).payload.shipment
          .orderId === orderId,
    );
    expect(mine).toHaveLength(1);
    expect(
      (mine[0] as unknown as { payload: { shipment: { trackingNumber: string } } }).payload.shipment
        .trackingNumber,
    ).toBe(shipment.trackingNumber);
    // …and the CREDENTIAL NEVER escapes: not into the outbox payload,…
    const leakedOutbox = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId}
        and (payload::text like '%canary-sandbox-token%' or payload::text like '%canary-delhivery-token%')
    `;
    expect(Number((leakedOutbox[0] as unknown as { n: number }).n)).toBe(0);
    // …not into the audit row (nor the response body, asserted above).
    const audit = await sql`
      select action from audit_events
      where tenant_id = ${tenantId} and target_id = ${orderId} and action = 'shipment.label-created'
    `;
    expect(audit).toHaveLength(1);
  });

  // ── idempotency ────────────────────────────────────────────────────────────

  it('replays byte for byte under the same key and 422s the same key with a different payload', async () => {
    const { orderId } = await packedOrder('LBL-REPLAY', 2, 'replay');
    const key = ulid();
    const body = { weightGrams: 800, dimensionsMm: { lengthMm: 200, widthMm: 150, heightMm: 100 } };

    const first = await labelOrder(orderId, sandboxConnectionId, body, operatorWebToken, key).expect(201);
    const replay = await labelOrder(orderId, sandboxConnectionId, body, operatorWebToken, key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(await shipmentCount(orderId)).toBe(1);

    // The measurements ARE intent — a re-weigh under the same key is the 422.
    const reused = await labelOrder(
      orderId,
      sandboxConnectionId,
      { weightGrams: 900 },
      operatorWebToken,
      key,
    ).expect(422);
    expect(reused.body.code).toBe('idempotency-key-reuse');
    expect(await shipmentCount(orderId)).toBe(1);

    // A NEW key against a labelled order is the 409 — no regeneration.
    const second = await labelOrder(orderId, sandboxConnectionId, {}, operatorWebToken, ulid()).expect(409);
    expect(second.body.code).toBe('conflict');
    expect(second.body.detail).toContain('no label regeneration');
    expect(await shipmentCount(orderId)).toBe(1);
  });

  // ── the documented argument arms ──────────────────────────────────────────

  it('refuses a malformed weight, a half-measured box, and a malformed connection id before anything is read', async () => {
    const { orderId } = await packedOrder('LBL-ARGS', 2, 'args');

    const zeroWeight = await labelOrder(orderId, sandboxConnectionId, { weightGrams: 0 }).expect(400);
    expect(zeroWeight.body.code).toBe('validation-failed');
    const overWeight = await labelOrder(orderId, sandboxConnectionId, {
      weightGrams: MAX_WEIGHT_GRAMS + 1,
    }).expect(400);
    expect(overWeight.body.code).toBe('validation-failed');
    const halfBox = await labelOrder(orderId, sandboxConnectionId, {
      dimensionsMm: { lengthMm: 300, widthMm: 200, heightMm: 0 },
    }).expect(400);
    expect(halfBox.body.detail).toContain('heightMm');
    const overSide = await labelOrder(orderId, sandboxConnectionId, {
      dimensionsMm: { lengthMm: MAX_DIMENSION_MM + 1, widthMm: 200, heightMm: 150 },
    }).expect(400);
    expect(overSide.body.code).toBe('validation-failed');
    const badConnection = await labelOrder(orderId, 'not-a-uuid').expect(400);
    expect(badConnection.body.code).toBe('validation-failed');

    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
    expect(await shipmentCount(orderId)).toBe(0);
  });

  // ── the state guards ──────────────────────────────────────────────────────

  it('refuses an order that was never packed, naming the status, writing nothing', async () => {
    const skuId = sku('LBL-STATE');
    await seedStock(skuId, binA, 20);
    const acceptedOrderId = await createOrder([{ skuId, quantity: 3 }]);
    const refused = await labelOrder(acceptedOrderId, sandboxConnectionId).expect(409);
    expect(refused.body.code).toBe('conflict');
    expect(refused.body.detail).toContain('accepted');
    expect(refused.body.detail).toContain('only a packed');
    expect(await orderStatus(acceptedOrderId)).toBe('accepted');
    expect(await shipmentCount(acceptedOrderId)).toBe(0);
  });

  it('refuses a label on a DISPATCHED order (the arc is closed) — nothing is written', async () => {
    const { orderId } = await packedOrder('LBL-DISP', 2, 'disp');
    await labelOrder(orderId, sandboxConnectionId).expect(201);
    await dispatchOrder(orderId).expect(201);

    // A manifested check rides the same guard family, but here the ORDER is
    // terminal: the label command reads the order first and names its status.
    const refused = await labelOrder(orderId, sandboxConnectionId).expect(409);
    expect(refused.body.code).toBe('conflict');
    expect(refused.body.detail).toContain('dispatched');
    expect(await shipmentCount(orderId)).toBe(1);
  });

  // ── the DIRECT carriers' typed refusal ────────────────────────────────────

  it('refuses a DIRECT carrier verbatim (501 carrier-transport-unconfigured), writes nothing, and the retry lands', async () => {
    const { orderId } = await packedOrder('LBL-DIRECT', 2, 'direct');

    const refused = await labelOrder(orderId, delhiveryConnectionId).expect(501);
    expect(refused.body.code).toBe('carrier-transport-unconfigured');
    expect(refused.body.status).toBe(501);
    expect(refused.body.detail).toContain('delhivery');

    // Nothing was written: no shipment row, the order still labellable.
    expect(await shipmentCount(orderId)).toBe(0);
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
    const outbox = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId} and type = 'shipment.label-created'
        and payload->'shipment'->>'orderId' = ${orderId}
    `;
    expect(Number((outbox[0] as unknown as { n: number }).n)).toBe(0);

    // The retry — a fresh submit against the sandbox connection — lands.
    const retry = await labelOrder(orderId, sandboxConnectionId, {}, operatorWebToken, ulid()).expect(201);
    expect(retry.body.shipment.carrierCode).toBe('sandbox');
    expect(await shipmentCount(orderId)).toBe(1);
  });

  // ── the tenant predicate ──────────────────────────────────────────────────

  it('resolves a FOREIGN tenant connection id to nothing (the 404 tenant predicate), writing nothing', async () => {
    const { orderId } = await packedOrder('LBL-FGN', 2, 'fgn');

    const crossed = await labelOrder(orderId, foreignConnectionId).expect(404);
    expect(crossed.body.code).toBe('not-found');
    expect(await shipmentCount(orderId)).toBe(0);
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
  });

  // ── the 503 key-unavailable arm ───────────────────────────────────────────

  it('refuses with 503 when the carrier encryption key is unavailable, writes nothing, and the retry lands once it is back', async () => {
    const { orderId } = await packedOrder('LBL-KEY', 2, 'key');
    const previous = process.env.CARRIER_ENCRYPTION_KEY;
    delete process.env.CARRIER_ENCRYPTION_KEY;
    try {
      const refused = await labelOrder(orderId, sandboxConnectionId).expect(503);
      expect(refused.body.code).toBe('carrier-encryption-unavailable');
      expect(await shipmentCount(orderId)).toBe(0);
      expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
    } finally {
      process.env.CARRIER_ENCRYPTION_KEY = previous;
    }

    // The retry — a fresh submit with a fresh key — lands once the key is back.
    const retry = await labelOrder(orderId, sandboxConnectionId, {}, operatorWebToken, ulid()).expect(201);
    expect(retry.body.shipment.status).toBe('labelled');
    expect(await shipmentCount(orderId)).toBe(1);
  });

  // ── the authority arms ────────────────────────────────────────────────────

  it('refuses the wrong authority on both commands: a role without labels.execute', async () => {
    const { orderId } = await packedOrder('LBL-AUTH', 2, 'auth');

    const labelDenied = await labelOrder(orderId, sandboxConnectionId, {}, accountantToken).expect(403);
    expect(labelDenied.body.code).toBe('role-denied');
    expect(labelDenied.body.detail).toContain('labels.execute');

    const manifestDenied = await createManifest([uuidv7()], accountantToken).expect(403);
    expect(manifestDenied.body.code).toBe('role-denied');
    expect(manifestDenied.body.detail).toContain('labels.execute');

    expect(await shipmentCount(orderId)).toBe(0);
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
  });

  // ── the manifest ───────────────────────────────────────────────────────────

  it('manifests a set of labelled shipments: the flip, the manifestId, the outbox and the audit — all-or-nothing', async () => {
    const first = await packedOrder('LBL-M1', 2, 'm1');
    const second = await packedOrder('LBL-M2', 3, 'm2');
    const firstLabel = await labelOrder(first.orderId, sandboxConnectionId).expect(201);
    const secondLabel = await labelOrder(second.orderId, sandboxConnectionId).expect(201);
    const firstShipmentId = firstLabel.body.shipment.id as string;
    const secondShipmentId = secondLabel.body.shipment.id as string;

    // The set is the intent: REVERSED order with a duplicate collapses to the
    // same sorted set — one manifest, not two, not a 422.
    const key = ulid();
    const res = await createManifest(
      [secondShipmentId, firstShipmentId, firstShipmentId],
      operatorWebToken,
      key,
    ).expect(201);
    const manifest = res.body.manifest as Record<string, unknown>;
    expect(manifest.carrierConnectionId).toBe(sandboxConnectionId);
    expect(manifest.carrierCode).toBe('sandbox');
    expect(manifest.shipmentCount).toBe(2);
    expect(manifest.shipmentIds).toEqual([firstShipmentId, secondShipmentId].sort());

    // The flip is visible on the read-back: both shipments read `manifested`
    // and point at the manifest.
    for (const [orderId, shipmentId] of [
      [first.orderId, firstShipmentId],
      [second.orderId, secondShipmentId],
    ] as const) {
      const read = await getShipment(orderId).expect(200);
      expect(read.body.shipment.id).toBe(shipmentId);
      expect(read.body.shipment.status).toBe('manifested');
      expect(read.body.shipment.manifestId).toBe(manifest.id as string);
    }

    // The replay re-serves the stored record; the re-manifest of a CLOSED
    // shipment is the named 409; and a manifest's shipment refuses a label
    // for the same reason (the arc is closed).
    const replay = await createManifest(
      [firstShipmentId, secondShipmentId],
      operatorWebToken,
      key,
    ).expect(201);
    expect(replay.body).toEqual(res.body);

    const relabelled = await labelOrder(first.orderId, sandboxConnectionId, {}, operatorWebToken, ulid()).expect(409);
    expect(relabelled.body.detail).toContain('manifested');

    const reManifested = await createManifest([firstShipmentId], operatorWebToken, ulid()).expect(409);
    expect(reManifested.body.code).toBe('conflict');
    expect(reManifested.body.detail).toContain('manifested');
    expect(reManifested.body.detail).toContain('not in the labelled state');

    // The writeback event and the audit row ride the same transaction.
    const outbox = await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'manifest.created'
    `;
    expect(
      outbox.some(
        (row) =>
          (row as unknown as { payload: { manifest: { id: string } } }).payload.manifest.id ===
          manifest.id,
      ),
    ).toBe(true);
    const audit = await sql`
      select action from audit_events
      where tenant_id = ${tenantId} and target_id = ${manifest.id as string} and action = 'manifest.created'
    `;
    expect(audit).toHaveLength(1);
  });

  it('refuses a manifest naming a MISSING or FOREIGN shipment id — the foreign row reads as ABSENT through RLS', async () => {
    const refused = await createManifest([uuidv7(), foreignShipmentId]).expect(409);
    expect(refused.body.code).toBe('conflict');
    expect(refused.body.detail).toContain('do not exist in this tenant');
    expect(refused.body.detail).toContain('2 of the named shipment(s)');

    // Nothing was written: the foreign shipment never flipped.
    const stillForeign = await sql`
      select status, manifest_id from shipments where id = ${foreignShipmentId}::uuid
    `;
    expect((stillForeign[0] as unknown as { status: string; manifest_id: string | null })).toEqual({
      status: 'labelled',
      manifest_id: null,
    });
  });

  it('refuses a manifest spanning TWO carrier connections, naming the connections, writing nothing', async () => {
    // Two shipments on two DIFFERENT connections: the first labels through the
    // sandbox connection, which is then DISCONNECTED (a hard delete, AD-15)
    // and re-connected as a new row — the second labels through the new one.
    const first = await packedOrder('LBL-MMIX1', 2, 'mmix1');
    const firstLabel = await labelOrder(first.orderId, sandboxConnectionId).expect(201);
    const firstShipmentId = firstLabel.body.shipment.id as string;

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/carriers/connections/${sandboxConnectionId}/disconnect`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const reconnected = await connectSandbox().expect(201);
    const secondConnectionId = reconnected.body.id as string;

    const second = await packedOrder('LBL-MMIX2', 2, 'mmix2');
    const secondLabel = await labelOrder(second.orderId, secondConnectionId).expect(201);
    const secondShipmentId = secondLabel.body.shipment.id as string;

    const refused = await createManifest([firstShipmentId, secondShipmentId]).expect(409);
    expect(refused.body.code).toBe('conflict');
    expect(refused.body.detail).toContain('different carrier connections');
    expect(refused.body.detail).toContain('one manifest closes one connection');
    expect(refused.body.detail).toContain(sandboxConnectionId);
    expect(refused.body.detail).toContain(secondConnectionId);

    // Nothing was written: both rows stay labelled with no manifest.
    const rows = (await sql`
      select id, status, manifest_id from shipments
      where tenant_id = ${tenantId} and id in (${firstShipmentId}::uuid, ${secondShipmentId}::uuid)
    `) as unknown as { status: string; manifest_id: string | null }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('labelled');
      expect(row.manifest_id).toBeNull();
    }
  });

  it('refuses a malformed manifest set before anything is read', async () => {
    const empty = await createManifest([]).expect(400);
    expect(empty.body.code).toBe('validation-failed');
    const nonUuid = await createManifest(['not-a-uuid']).expect(400);
    expect(nonUuid.body.code).toBe('validation-failed');
    expect(nonUuid.body.detail).toContain('shipmentIds');
  });

  it('lists the warehouse manifests newest first, with a keyset cursor that walks the pages', async () => {
    // Any labelled shipment closes onto a fresh manifest — the connection is
    // read FROM the shipment, and the manifest test left several labelled rows
    // unmanifested (the mixed-connection refusal wrote nothing).
    const leftover = (await sql`
      select id from shipments
      where tenant_id = ${tenantId} and status = 'labelled' and manifest_id is null
      order by id limit 1
    `) as unknown as { id: string }[];
    expect(leftover).toHaveLength(1);
    const newest = await createManifest([leftover[0]!.id]).expect(201);
    const newestId = newest.body.manifest.id as string;

    const page = await listManifests('?limit=1').expect(200);
    const items = page.body.items as { id: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(newestId);
    expect(page.body.nextCursor).not.toBeNull();

    const second = await listManifests(`?limit=5&cursor=${encodeURIComponent(page.body.nextCursor as string)}`).expect(200);
    const rest = second.body.items as { id: string }[];
    expect(rest.map((row) => row.id)).not.toContain(newestId);
    expect(rest.length).toBeGreaterThanOrEqual(1);
    // The first page's cursor carried its boundary — the walk terminates.
    expect(second.body.nextCursor).toBeNull();
  });

  // ── the DB-level backstops ────────────────────────────────────────────────

  it('the DB CHECKs and the partial unique index reject what the command guards against (meaningful backstops)', async () => {
    // The status CHECK: a typo status is rejected BY THE CHECK…
    await expect(
      sql`
        update shipments set status = 'bogus'
        where id = (select id from shipments where tenant_id = ${tenantId} limit 1)
      `,
    ).rejects.toMatchObject({ code: '23514' });
    const check = await sql`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'shipments_status_check'
    `;
    expect((check[0] as unknown as { def: string }).def).toContain("'labelled'");
    expect((check[0] as unknown as { def: string }).def).toContain("'manifested'");
    // …and the same row accepts its own real status, proving the CHECK — not
    // row visibility — rejected the typo above.
    const labelledRow = (await sql`
      select id from shipments where tenant_id = ${tenantId} and status = 'labelled' limit 1
    `) as unknown as { id: string }[];
    await sql`update shipments set status = 'labelled' where id = ${labelledRow[0]!.id}::uuid`;

    // The manifest count CHECK.
    await expect(
      sql`
        insert into manifests (id, tenant_id, warehouse_id, carrier_connection_id, carrier_code, shipment_count, created_by)
        values (${uuidv7()}::uuid, ${tenantId}::uuid, ${warehouseId}::uuid, ${sandboxConnectionId}::uuid, 'sandbox', 0, ${uuidv7()}::uuid)
      `,
    ).rejects.toMatchObject({ code: '23514' });

    // The one-label-per-order partial unique index: a second labelled row for
    // the same order is refused even by raw SQL.
    const original = (await sql`
      select order_id, warehouse_id, carrier_connection_id, carrier_code, carrier_name,
             tracking_number, label_document_ref, labelled_by, labelled_at
      from shipments where tenant_id = ${tenantId} and status = 'labelled' limit 1
    `) as unknown as {
      order_id: string;
      warehouse_id: string;
      carrier_connection_id: string;
      carrier_code: string;
      carrier_name: string;
      label_document_ref: string;
      labelled_by: string;
      labelled_at: string;
    }[];
    await expect(
      sql`
        insert into shipments (id, tenant_id, warehouse_id, order_id, status, carrier_connection_id,
          carrier_code, carrier_name, tracking_number, label_document_ref, labelled_by, labelled_at)
        values (${uuidv7()}::uuid, ${tenantId}::uuid, ${original[0]!.warehouse_id}::uuid,
          ${original[0]!.order_id}::uuid, 'labelled', ${original[0]!.carrier_connection_id}::uuid,
          ${original[0]!.carrier_code}, ${original[0]!.carrier_name}, 'SBX-DUPLICATE00',
          ${original[0]!.label_document_ref}, ${original[0]!.labelled_by}::uuid, ${original[0]!.labelled_at})
      `,
    ).rejects.toMatchObject({ code: '23505' });
  });

  // ── tenant isolation ──────────────────────────────────────────────────────

  it('RLS fails closed on shipments and manifests: unscoped and foreign-scoped reads see zero rows', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1 });
    try {
      // The rows exist through the privileged connection…
      const shipped = await sql`
        select count(*)::int as n from shipments where tenant_id = ${tenantId}
      `;
      expect(Number((shipped[0] as unknown as { n: number }).n)).toBeGreaterThan(0);
      const manifested = await sql`
        select count(*)::int as n from manifests where tenant_id = ${tenantId}
      `;
      expect(Number((manifested[0] as unknown as { n: number }).n)).toBeGreaterThan(0);

      // …and are invisible unscoped (the NULLIF empty-string guard)…
      const unscopedShipments = await rls`select id from shipments where tenant_id = ${tenantId}`;
      expect(unscopedShipments).toHaveLength(0);
      const unscopedManifests = await rls`select id from manifests where tenant_id = ${tenantId}`;
      expect(unscopedManifests).toHaveLength(0);

      // …and invisible when scoped to the FOREIGN tenant.
      const foreignScoped = await rls.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${foreignTenantId}, true)`;
        return tx`select id from shipments where tenant_id = ${tenantId}`;
      });
      expect(foreignScoped).toHaveLength(0);

      // The own-tenant arms are visible (the policies are not "deny all").
      const ownShipments = await rls.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        return tx`select id from shipments where tenant_id = ${tenantId}`;
      });
      expect(ownShipments).toHaveLength(Number((shipped[0] as unknown as { n: number }).n));
      const ownManifests = await rls.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        return tx`select id from manifests where tenant_id = ${tenantId}`;
      });
      expect(ownManifests).toHaveLength(Number((manifested[0] as unknown as { n: number }).n));

      // The write side fails closed too (the WITH CHECK arm).
      await expect(
        rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${foreignTenantId}, true)`;
          return tx.unsafe(
            `insert into shipments (id, tenant_id, warehouse_id, order_id, status, carrier_connection_id,
               carrier_code, carrier_name, tracking_number, label_document_ref, labelled_by)
             values ('${uuidv7()}'::uuid, '${tenantId}'::uuid, '${uuidv7()}'::uuid, '${uuidv7()}'::uuid,
               'labelled', '${uuidv7()}'::uuid, 'sandbox', 'Sandbox', 'SBX-SMUGGLED000',
               'sandbox://labels/smuggled', '${uuidv7()}'::uuid)`,
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await rls.end();
    }
  });
});

