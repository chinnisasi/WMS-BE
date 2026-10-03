import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { nowIso } from '../src/shared/primitives/time';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { ProblemException } from '../src/shared/problem-details/problem.exception';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { InvoicingCommand } from '../src/modules/invoicing/command';
import { InvoicingFacade } from '../src/modules/invoicing/facade';
import { InvoiceDeliveryHandler } from '../src/modules/invoicing/delivery';
import { InvoiceGenerator, normalizeStateName } from '../src/modules/invoicing/generator';
import { ORDER_DISPATCHED_EVENT } from '../src/modules/invoicing/events';
import type { DomainEvent } from '../src/shared/events/event-bus.seam';
import { OUTBOX_RELAY } from '../src/shared/events/outbox.seam';
import type { OutboxRelay } from '../src/shared/events/outbox.seam';
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
// Background workers stay off in suites — this suite drives `drain()` (the
// sibling convention), so the relay's own poll loop must never boot.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(60_000);

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

interface OrderLineRow {
  id: string;
  skuId: string;
  parentLineId: string | null;
  qty: number;
}

interface InvoiceRow {
  id: string;
  status: string;
  invoice_no: string | null;
  fy_label: string | null;
  series_seq: string | number | null;
  place_of_supply: string | null;
  supply_type: string | null;
  origin_gstin: string | null;
  consignee_gstin: string | null;
  subtotal_paise: string | number;
  gst_paise: string | number;
  total_paise: string | number;
  revision: number;
  document: Record<string, unknown>;
}

/**
 * Asserts a promise rejects with the ProblemException contract: HTTP status
 * AND machine-readable code (HttpException hides `code` inside
 * `getResponse()` — `toMatchObject` cannot see it; the reservations idiom).
 */
async function expectProblem(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ProblemException);
  expect((error as ProblemException).getStatus()).toBe(status);
  expect(((error as ProblemException).getResponse() as { code: string }).code).toBe(code);
}

/**
 * Story 8-1 — GST-compliant invoicing. The suite drives BOTH generation
 * paths exactly as production does: the event path (dispatch.appends
 * `order.dispatched` in-tx; the suite drains the relay; the delivery
 * handler generates in its own tenant transaction) and the manual command
 * path (`InvoicingCommand.generate`, the operator's generate/regenerate
 * with per-line rate overrides). Most scenarios drive the module services
 * directly; the HTTP block at the end pins the controller's routes, guards
 * and error arms.
 *
 * The number assertions here are paise and milli-unit EXACT (the
 * arithmetic suite pins the math; this suite pins the SEAMS — the facts
 * re-derivation, the rate tiers, the FY numbering, the race, the gaps).
 */
describe('invoicing: GST invoice generation (e2e, story 8-1)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let opsToken: string;
  let accountantToken: string;
  let operatorWebToken: string;
  let deviceToken: string;
  let operatorToken: string;
  let warehouseId: string; // carries the warehouse GSTIN (supplier identity)
  let noGstinWarehouseId: string; // NO gstin → the tenant-gstin / text fallbacks
  let zoneId: string;
  let zone2Id: string;
  let binA: string;
  let bin2: string; // the no-gstin warehouse's bin
  const skuIds = new Map<string, string>();

  let command: InvoicingCommand;
  let facade: InvoicingFacade;
  let delivery: InvoiceDeliveryHandler;
  let relay: OutboxRelay;

  let suiteDb: SuiteDatabase;

  const SKU_CODES = [
    'IN-OK', // the happy intra-state path over the EVENT (drain) path
    'IN-UNPR', // no rate → parked awaiting-data → priced by command → issued
    'IN-CARRY', // manual override carried across a rate-less regenerate
    'IN-AUTH', // the command's refusal arms
    'IN-NOG', // no consignee GSTIN — the B2C text arm
    'IN-GAP', // destination state not on the CBIC list → blocking gap
    'IN-HSN', // blank HSN → issues WITH the hsn-gap warning
    'IN-MIS', // GSTIN says 27, address says Gujarat → pos-discrepancy, GSTIN wins
    'IN-INTER', // consignee 29 in Karnataka → inter-state → IGST only
    'IN-SERA', // the numbering series, first order
    'IN-SERB', // …and its successor
    'IN-RACE', // the command-vs-event generation race
    'IN-TWICE', // the double-delivery (at-least-once) idempotency
    'IN-KITP', // the kit parent (dropped at zero picks)
    'IN-KTC1', // …component 1
    'IN-KTC2', // …component 2
    'IN-TENANT', // the tenant-GSTIN fallback warehouse's order
    'IN-HTTP', // the controller's routes, guards and error arms
    'IN-RETRY', // AC2: a failed generation retried by the relay
    'IN-SUPP', // the supplier-GSTIN gap and the origin discrepancy
  ] as const;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('invoicing');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    command = app.get(InvoicingCommand);
    facade = app.get(InvoicingFacade);
    delivery = app.get(InvoiceDeliveryHandler);
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `GST Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    createdTenantIds.push(tenantId);
    expect((registered.body.tenant as { gstin: string | null }).gstin).toBeNull(); // no gstin given

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

    // The supplier warehouse: origin in Maharashtra + a GSTIN whose digits
    // are 27 — origin and text agree, so no origin gap in any scenario.
    const wh = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        gstin: '27AAAPZ1234C1ZV',
        origin: testAddress({ state: 'Maharashtra', city: 'Pune', line1: '22, Chakan MIDC', pincode: '410501' }),
        code: `GST-${ulid().slice(10, 16).toUpperCase()}`,
        name: `GST WH ${ulid()}`,
      })
      .expect(201);
    warehouseId = wh.body.id as string;
    expect((wh.body as { gstin: string | null }).gstin).toBe('27AAAPZ1234C1ZV');
    zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binA = await createBin(warehouseId, zoneId, 'A-01-01');

    // The NO-GSTIN warehouse — origin still Maharashtra, so the
    // tenant-gstin / origin-text fallbacks resolve (the fallback suite).
    const wh2 = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        origin: testAddress({ state: 'Maharashtra', city: 'Pune', line1: '23, Chakan MIDC', pincode: '410501' }),
        code: `NGS-${ulid().slice(10, 16).toUpperCase()}`,
        name: `No-Gstin WH ${ulid()}`,
      })
      .expect(201);
    noGstinWarehouseId = wh2.body.id as string;
    expect((wh2.body as { gstin: string | null }).gstin).toBeNull();
    zone2Id = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${noGstinWarehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'B', name: 'Aisle B' })
        .expect(201)
    ).body.id as string;
    bin2 = await createBin(noGstinWarehouseId, zone2Id, 'B-01-01');

    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      ...SKU_CODES.map((code) => {
        const hsn = code === 'IN-HSN' ? '' : '1008';
        return `${code},Invoicing SKU ${code},pcs,,1800,${hsn},false,false,,,`;
      }),
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const catalogList = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of catalogList.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }
    expect(skuIds.size).toBeGreaterThanOrEqual(SKU_CODES.length);

    // The kit: 1×IN-KTC1 + 2×IN-KTC2 (the parent never holds stock).
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/skus/${sku('IN-KITP')}/kit`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        components: [
          { skuId: sku('IN-KTC1'), quantity: 1 },
          { skuId: sku('IN-KTC2'), quantity: 2 },
        ],
      })
      .expect(201);

    // The floor device + its badge-in operator (picking feeds every fixture).
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Invoicing desk scanner', pin: '2468' })
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

    // The tenant-gstin fallback: the tenant row now carries a GSTIN (the
    // registration command's column; the registration route is the
    // create-only stamp — direct SQL here, the reservation-row precedent).
    await sql`update tenants set gstin = '27BBBPT5678M2AB' where id = ${tenantId}`;

    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, noGstinWarehouseId);
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
        'invoice_lines',
        'invoices',
        'invoice_series',
        'order_lines',
        'orders',
      ]) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      for (const table of [
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
        'kit_compositions',
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

  async function createBin(warehouse: string, zone: string, code: string): Promise<string> {
    return (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouse}/zones/${zone}/bins`)
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

  async function seedStock(skuId: string, binId: string, quantity: number, inWarehouseId = warehouseId): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: inWarehouseId,
        skuId,
        binId,
        quantityDelta: quantity,
        reasonCode: 'stock-count',
        note: 'invoicing-suite seed',
      })
      .expect(201);
  }

  /**
   * One order, accepted, with per-line paise rates (optional) + destination
   * + GSTIN. `ratePaise` rides the create (the frozen-acceptance stamp —
   * order_lines.rate_paise, written once at acceptance).
   */
  async function createOrder(
    lines: { skuId: string; quantity: number; ratePaise?: number }[],
    opts: { destination?: Record<string, unknown>; consigneeGstin?: string | null; warehouse?: string } = {},
  ): Promise<{ orderId: string; lineRows: OrderLineRow[] }> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: opts.warehouse ?? warehouseId,
        lines: lines.map((line) =>
          line.ratePaise === undefined
            ? { skuId: line.skuId, quantity: line.quantity }
            : { skuId: line.skuId, quantity: line.quantity, ratePaise: line.ratePaise },
        ),
        destination: opts.destination ?? testAddress({ state: 'Maharashtra', city: 'Pune', line1: '24, Chakan MIDC', pincode: '411042' }),
        ...(opts.consigneeGstin ? { consigneeGstin: opts.consigneeGstin } : {}),
      })
      .expect(201);
    const orderId = res.body.order.id as string;
    return { orderId, lineRows: await orderLinesOf(orderId) };
  }

  async function orderLinesOf(orderId: string): Promise<OrderLineRow[]> {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/orders/${orderId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    return (res.body.order.lines as { id: string; skuId: string; parentLineId: string | null; qty: number }[]).map(
      (line) => ({ id: line.id, skuId: line.skuId, parentLineId: line.parentLineId, qty: line.qty }),
    );
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
    lines: { skuId: string; quantity: number; ratePaise?: number }[],
    tag: string,
    opts: { destination?: Record<string, unknown>; consigneeGstin?: string | null } = {},
  ): Promise<{ orderId: string; lineRows: OrderLineRow[]; picklist: Picklist }> {
    const { orderId, lineRows } = await createOrder(lines, opts);
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
    return { orderId, lineRows, picklist };
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

  function dispatchOrder(orderId: string): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, ulid())
      .send({});
  }

  /**
   * The full floor flow for one order, ending DISPATCHED — dispatch
   * appends its `order.dispatched` outbox row in-tx; the caller decides
   * whether to DRIVE it (drain) or COMMAND it.
   */
  async function dispatchedOrder(
    lines: { skuId: string; quantity: number; ratePaise?: number }[],
    tag: string,
    opts: {
      destination?: Record<string, unknown>;
      consigneeGstin?: string | null;
      /**
       * The seed override: a KIT line's parent must never be seeded
       * (story 11.4 — a kit SKU cannot hold stock, the adjustment is a
       * 409) — name the COMPONENT SKUs at their composition quantities
       * and the explosion does the rest.
       */
      seed?: readonly { skuId: string; quantity: number }[];
    } = {},
    bin = binA,
  ): Promise<{ orderId: string; lineRows: OrderLineRow[] }> {
    const seed = opts.seed ?? lines;
    await Promise.all(seed.map((line) => seedStock(line.skuId, bin, line.quantity + 5)));
    const { orderId, lineRows, picklist } = await releasedWave(lines, tag, opts);
    for (const line of picklist.lines) {
      if (line.qty > 0) await pick(line).expect(201);
    }
    await packOrder(orderId, scannedOf(picklist)).expect(201);
    await dispatchOrder(orderId).expect(201);
    return { orderId, lineRows };
  }

  /** The pack scan: every DISTINCT picked sku with its pick quantity sum. */
  function scannedOf(picklist: Picklist): { skuId: string; qty: number }[] {
    const perSku = new Map<string, number>();
    for (const line of picklist.lines) {
      perSku.set(line.skuId, (perSku.get(line.skuId) ?? 0) + line.qty);
    }
    // Zero-picked rows (a kit parent's childless slot) scan nothing —
    // zero is not a pack quantity (the 4.5 pack's exact-match gate).
    const scanned: { skuId: string; qty: number }[] = [];
    for (const [skuId, qty] of perSku) {
      if (qty > 0) scanned.push({ skuId, qty });
    }
    return scanned;
  }

  /** Drives the relay past any backoff, then drains `limit` rows. */
  async function forceDue(): Promise<void> {
    await sql`update outbox_messages set next_attempt_at = now() where tenant_id = ${tenantId}`;
  }

  async function clearOutbox(): Promise<void> {
    await sql`delete from outbox_messages where tenant_id = ${tenantId}`;
  }

  /**
   * Drops the outbox rows of the EXTRA tenants a registration test creates
   * — the relay drains oldest-tenant-first under a row limit, so their
   * `tenant.registered` rows would otherwise eat a later drain's budget.
   */
  async function clearForeignOutbox(): Promise<void> {
    await sql`delete from outbox_messages where tenant_id <> ${tenantId}`;
  }

  /** The event the dispatch flow would have delivered (the at-least-once replay arm). */
  function dispatchedEvent(orderId: string): DomainEvent {
    return {
      eventId: uuidv7(),
      type: ORDER_DISPATCHED_EVENT,
      tenantId,
      occurredAt: nowIso(),
      payload: { dispatch: { orderId } },
    };
  }

  async function invoiceRow(orderId: string): Promise<InvoiceRow | undefined> {
    const rows = await sql`
      select id, status, invoice_no, fy_label, series_seq, place_of_supply, supply_type,
             origin_gstin, consignee_gstin, subtotal_paise, gst_paise, total_paise, revision, document
      from invoices where tenant_id = ${tenantId} and order_id = ${orderId}
    `;
    return rows[0] as unknown as InvoiceRow | undefined;
  }

  /** Every scenario's row must exist; read undefined → a named fixture miss. */
  function mustRow(row: InvoiceRow | undefined): InvoiceRow {
    expect(row).toBeDefined();
    return row!;
  }

  async function invoiceLineRows(invoiceId: string): Promise<
    { order_line_id: string; sku_code: string; hsn: string | null; qty_milli: string | number; rate_paise: string | number; rate_source: string; taxable_paise: string | number; cgst_paise: string | number; sgst_paise: string | number; igst_paise: string | number; hsn_gap: boolean }[]
  > {
    return (await sql`
      select order_line_id, sku_code, hsn, qty_milli, rate_paise, rate_source,
             taxable_paise, cgst_paise, sgst_paise, igst_paise, hsn_gap
      from invoice_lines where tenant_id = ${tenantId} and invoice_id = ${invoiceId}
      order by sku_code
    `) as never;
  }

  /**
   * One order dispatched end-to-end through the NO-GSTIN warehouse (the
   * tenant-GSTIN / supplier-gap fallbacks), its invoice NOT yet generated.
   */
  async function dispatchedFromSecondWarehouse(skuId: string, quantity: number, ratePaise: number): Promise<string> {
    await seedStock(skuId, bin2, quantity + 5, noGstinWarehouseId);
    const { orderId } = await createOrder(
      [{ skuId, quantity, ratePaise }],
      { warehouse: noGstinWarehouseId, destination: testAddress({ state: 'Maharashtra', city: 'Pune', line1: '24, Chakan MIDC', pincode: '411042' }) },
    );
    const policy = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/wave-policies`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: noGstinWarehouseId, name: `ngs-${ulid().slice(10, 18)}`, grouping: 'single' })
      .expect(201);
    const created = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: noGstinWarehouseId, policyId: (policy.body as { policy: { id: string } }).policy.id, orderIds: [orderId] })
      .expect(201);
    const waveId = (created.body as { wave: { id: string } }).wave.id;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    const picklist = (detail.body as { wave: Wave }).wave.picklists[0]!;
    for (const line of picklist.lines) {
      if (line.qty > 0) await pick(line, { warehouseId: noGstinWarehouseId }).expect(201);
    }
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned: [{ skuId, qty: quantity }] })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);

    return orderId;
  }

  /** Polls until some transaction is waiting on a lock (the forced-race barrier). */
  async function waitForLockWait(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const rows = (await sql`select count(*)::int as n from pg_locks where not granted`) as unknown as { n: number }[];
      if (Number(rows[0]!.n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('no transaction ever blocked — the forced race did not form');
  }

  /** The command's rate-input shape over an order's line rows (by sku code). */
  function ratesFor(lineRows: OrderLineRow[], priced: Partial<Record<string, number>>): { orderLineId: string; ratePaise: number }[] {
    const rates: { orderLineId: string; ratePaise: number }[] = [];
    for (const row of lineRows) {
      const code = [...skuIds].find(([, id]) => id === row.skuId)?.[0];
      const rate = code === undefined ? undefined : priced[code];
      if (rate !== undefined) {
        rates.push({ orderLineId: row.id, ratePaise: rate });
      }
    }
    return rates;
  }

  // ── the reference list + the registered grammar ───────────────────────────

  it('the capability is registered, and the CBIC list is seeded with its 38 OFFICIAL entries (the seed proof)', async () => {
    expect((CAPABILITIES as readonly string[]).includes('invoice.generate')).toBe(true);
    expect(ROLE_CAPABILITIES.owner.has('invoice.generate')).toBe(true);
    expect(ROLE_CAPABILITIES.ops_manager.has('invoice.generate')).toBe(true);
    expect(ROLE_CAPABILITIES.operator.has('invoice.generate')).toBe(false);
    expect(ROLE_CAPABILITIES.accountant.has('invoice.generate')).toBe(false);

    const rows = (await sql`
      select state_code, state_name from gst_state_codes order by state_code
    `) as unknown as { state_code: string; state_name: string }[];
    expect(rows).toHaveLength(38);
    expect(rows.map((row) => row.state_code)).not.toContain('25'); // the pre-2020-merger code
    expect(rows.map((row) => row.state_code)).not.toContain('28');
    expect(rows).toEqual(
      expect.arrayContaining([
        { state_code: '27', state_name: 'Maharashtra' },
        { state_code: '29', state_name: 'Karnataka' },
        { state_code: '24', state_name: 'Gujarat' },
        { state_code: '37', state_name: 'Andhra Pradesh' },
        { state_code: '38', state_name: 'Ladakh' },
        { state_code: '97', state_name: 'Other Territory' },
        { state_code: '99', state_name: 'Other Country' },
      ]),
    );
    // Every state the fixtures dispatch from or to resolves against the
    // seed (the spec's seed proof) — the deliberately-unknown 'Atlantis' of
    // the gap scenario is the one exclusion, and is pinned as unresolvable.
    const seeded = new Set(rows.map((row) => normalizeStateName(row.state_name)));
    for (const state of ['Maharashtra', 'Karnataka', 'Gujarat']) {
      expect(seeded.has(normalizeStateName(state))).toBe(true);
    }
    expect(seeded.has(normalizeStateName('Atlantis'))).toBe(false);
  });

  it('registers the invoicing module without disturbing the sibling modules (the boot-time drift guard)', async () => {
    // The delivery subscription is the module's OnModuleInit wiring.
    expect(delivery).toBeDefined();
    expect(relay).toBeDefined();
    // A dispatched event over a non-invoiced path still lands after a drain:
    // implicitly covered by the suites below — here, just the seams.
    expect(command).toBeDefined();
    expect(facade).toBeDefined();
  });

  // ── the event path: auto-generation on dispatch ─────────────────────────────

  it('the dispatch event auto-generates an INTRA-state invoice: taxes split CGST/SGST, totals reconcile, `invoice.issued` lands in-tx', async () => {
    await clearOutbox();
    // 2 units × ₹4.50 = ₹9.00; 18% GST = ₹1.62 → 81 + 81.
    const { orderId } = await dispatchedOrder(
      [{ skuId: sku('IN-OK'), quantity: 2, ratePaise: 450 }],
      'ok',
    );

    // Before the drain: NO invoice row (generation is the DELIVERY's job,
    // not the dispatch's — the outbox row is the only thing dispatch wrote).
    const outboxRowsBefore = await sql`
      select id, payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'order.dispatched'
    `;
    expect(outboxRowsBefore).toHaveLength(1);
    expect(await invoiceRow(orderId)).toBeUndefined();

    await forceDue();
    // forceDue makes the WHOLE order flow's outbox set due in one cycle
    // (stock.adjusted … order.dispatched) — assert MEMBERSHIP of the row
    // this suite drives, not the cycle's length.
    const drained = await relay.drain(10);
    expect(drained.map((row) => row.type)).toContain('order.dispatched');

    const row = mustRow(await invoiceRow(orderId));
    expect(row.status).toBe('issued');
    expect(row.invoice_no).toMatch(/^FY-\d{4}-\d{6}$/);
    expect(row.fy_label).toMatch(/^FY-\d{4}$/);
    expect(row.supply_type).toBe('intra');
    expect(row.place_of_supply).toBe('27');
    expect(row.origin_gstin).toBe('27AAAPZ1234C1ZV');
    expect(Number(row.subtotal_paise)).toBe(900);
    expect(Number(row.gst_paise)).toBe(162);
    expect(Number(row.total_paise)).toBe(1062);
    expect(row.revision).toBe(1);

    // The document's arithmetic: two-sum, split, order ref, revision stamp.
    const document = row.document as {
      header: { invoiceNo: string | null; issuedAt: string | null; orderRef: string; placeOfSupply: string | null; supplyType: string | null; consigneeAddress: { state: string } | null };
      seller: { gstin: string };
      lines: { skuCode: string; qtyMilli: number; ratePaise: number; rateSource: string; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; hsnGap: boolean }[];
      totals: { subtotal: number; gst: number; payAble: number };
      gaps: { kind: string }[];
      revision: number;
    };
    expect(document.header.invoiceNo).toBe(row.invoice_no);
    expect(document.header.orderRef).toBe(orderId);
    expect(document.header.supplyType).toBe('intra');
    expect(document.header.consigneeAddress!.state).toBe('Maharashtra');
    expect(document.seller.gstin).toBe('27AAAPZ1234C1ZV');
    expect(document.lines).toHaveLength(1);
    expect(document.lines[0]).toMatchObject({ skuCode: 'IN-OK', qtyMilli: 2000, ratePaise: 450, rateSource: 'order_line', taxablePaise: 900, gstBps: 1800, cgstPaise: 81, sgstPaise: 81, igstPaise: 0, hsnGap: false });
    expect(document.totals).toEqual({ subtotal: 900, gst: 162, payAble: 1062 });
    expect(document.gaps).toEqual([]);
    expect(document.revision).toBe(1);

    // The line rows: ONE priced line, the exact numbers.
    const lines = await invoiceLineRows(row.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      sku_code: 'IN-OK', qty_milli: '2000', rate_paise: '450', rate_source: 'order_line',
      taxable_paise: '900', cgst_paise: '81', sgst_paise: '81', igst_paise: '0', hsn_gap: false,
    });

    // `invoice.issued` appended IN the generation transaction — the
    // invoice.issued arm 21-5 reads.
    const issued = await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'invoice.issued'
    `;
    const payloads = issued.map((r) => (r as unknown as { payload: Record<string, unknown> }).payload);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      invoiceId: row.id, orderId, invoiceNo: row.invoice_no, fyLabel: row.fy_label,
      subtotalPaise: 900, gstPaise: 162, totalPaise: 1062, revision: 1,
    });

    // The delivery wrote NO audit row (actorUserId is NOT NULL, no actor
    // exists on an event) — a deliberate, documented disposition.
    const audits = await sql`
      select action from audit_events
      where tenant_id = ${tenantId} and target_id = ${orderId} and action = 'invoice.generated'
    `;
    expect(audits).toHaveLength(0);
  });

  it('an UNPRICED order parks `awaiting-data`, then the command prices it to issuance — with an UNCHANGED order_lines.rate_paise', async () => {
    await clearOutbox();
    const { orderId, lineRows } = await dispatchedOrder([{ skuId: sku('IN-UNPR'), quantity: 3 }], 'unpr');
    const okLine = lineRows.find((row) => row.skuId === sku('IN-UNPR'))!;

    await forceDue();
    await relay.drain(10);

    const parked = await invoiceRow(orderId);
    expect(parked).toBeDefined();
    expect(parked!.status).toBe('awaiting-data');
    expect(parked!.invoice_no).toBeNull();
    expect(parked!.fy_label).toBeNull();
    expect(Number(parked!.total_paise)).toBe(0);
    // The gap names its line STRUCTURALLY — the pricing dialog's input,
    // never parsed out of the detail prose.
    expect((parked!.document as { gaps: { kind: string; orderLineId?: string }[] }).gaps).toEqual([
      expect.objectContaining({ kind: 'unpriced-line', orderLineId: okLine.id }),
    ]);

    // Command path: price the line → the SAME invoice flips to issued.
    const priced = await command.generate(
      {
        tenantId,
        actorUserId: ownerUserId,
        orderId,
        rates: ratesFor(lineRows, { 'IN-UNPR': 500 }),
      },
      ulid(),
    );
    expect(priced.invoice.status).toBe('issued');
    expect(priced.invoice.invoiceNo).toMatch(/^FY-\d{4}-\d{6}$/);
    expect(priced.invoice.subtotalPaise).toBe(1500); // 3 × 500
    expect(priced.invoice.gstPaise).toBe(270);
    expect(priced.invoice.totalPaise).toBe(1770);
    // The rate override froze into the document as MANUAL — the acceptance
    // column is untouched (the frozen-acceptance rule).
    expect(priced.invoice.lines[0]).toMatchObject({ ratePaise: 500, rateSource: 'manual' });
    expect(priced.invoice.lines[0]!.orderLineId).toBe(okLine.id);
    // The flip is a CONTENT change: the revision numbers it, on the row and
    // inside the document alike.
    expect(priced.invoice.revision).toBe(parked!.revision + 1);
    expect((priced.invoice.document as { revision: number }).revision).toBe(parked!.revision + 1);
    // …and the command's awaiting-data → issued flip emits `invoice.issued`
    // exactly once, carrying the number it just took.
    const issuedRows = (await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'invoice.issued' and payload->>'orderId' = ${orderId}
    `) as unknown as { payload: { invoiceNo: string } }[];
    expect(issuedRows).toHaveLength(1);
    expect(issuedRows[0]!.payload.invoiceNo).toBe(priced.invoice.invoiceNo);

    const frozen = (await sql`
      select rate_paise from order_lines where id = ${okLine.id}
    `) as unknown as { rate_paise: string | number | null }[];
    expect(frozen[0]!.rate_paise).toBeNull();

    // Regenerate WITHOUT rates: the carried manual rate holds the document
    // IDENTICAL — no revision bump, no new number, no re-pricing.
    const second = await command.generate(
      { tenantId, actorUserId: ownerUserId, orderId, rates: [] },
      ulid(),
    );
    expect(second.invoice.revision).toBe(priced.invoice.revision);
    expect(second.invoice.invoiceNo).toBe(priced.invoice.invoiceNo);
    expect(second.invoice.document).toEqual(priced.invoice.document);
  });

  it(`audits the MANUAL path: one 'invoice.generated' row per generate call, none from deliveries`, async () => {
    await clearOutbox();
    const { orderId } = await dispatchedOrder([{ skuId: sku('IN-CARRY'), quantity: 1, ratePaise: 200 }], 'carry');
    await command.generate({ tenantId, actorUserId: ownerUserId, orderId }, ulid());
    const audits = (await sql`
      select action, actor_user_id, target_id, target_type from audit_events
      where tenant_id = ${tenantId} and target_id = ${orderId} and action = 'invoice.generated'
    `) as unknown as { action: string; actor_user_id: string; target_id: string; target_type: string }[];
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor_user_id).toBe(ownerUserId);
    expect(audits[0]!.target_type).toBe('order');
  });

  it('refuses the command arms: unknown order 404, non-dispatched 409, rate line not of this order 409, already-priced line 409', async () => {
    const { orderId, lineRows: authLines } = await dispatchedOrder([{ skuId: sku('IN-AUTH'), quantity: 1, ratePaise: 100 }], 'auth');

    // The acceptance-time rate is frozen: an override naming a priced line
    // is refused, never silently applied or ignored.
    await expectProblem(
      command.generate(
        { tenantId, actorUserId: ownerUserId, orderId, rates: [{ orderLineId: authLines[0]!.id, ratePaise: 999 }] },
        ulid(),
      ),
      409,
      'line-already-priced',
    );

    await expectProblem(
      command.generate(
        { tenantId, actorUserId: ownerUserId, orderId: '00000000-0000-7000-8000-00000000dead' },
        ulid(),
      ),
      404,
      'not-found',
    );

    const notDispatchedSku = sku('IN-GAP');
    const { orderId: acceptedId } = await createOrder([{ skuId: notDispatchedSku, quantity: 1, ratePaise: 100 }]);
    await expectProblem(
      command.generate({ tenantId, actorUserId: ownerUserId, orderId: acceptedId }, ulid()),
      409,
      'order-not-dispatched',
    );

    await expectProblem(
      command.generate(
        { tenantId, actorUserId: ownerUserId, orderId, rates: [{ orderLineId: uuidv7(), ratePaise: 100 }] },
        ulid(),
      ),
      409,
      'line-not-of-order',
    );
  });

  it('a B2C order (no consignee GSTIN) issues through the destination STATE text', async () => {
    await clearOutbox();
    const { orderId } = await dispatchedOrder(
      [{ skuId: sku('IN-NOG'), quantity: 1, ratePaise: 300 }],
      'b2c',
      { destination: testAddress({ state: 'Maharashtra' }) }, // intra again: 27→27
    );
    await forceDue();
    await relay.drain(10);
    const row = mustRow(await invoiceRow(orderId));
    expect(row.status).toBe('issued');
    expect(row.consignee_gstin).toBeNull();
    expect(row.place_of_supply).toBe('27'); // from the state TEXT, not a GSTIN
    expect(row.supply_type).toBe('intra');
    expect((row.document as { gaps: unknown[] }).gaps).toEqual([]);
  });

  it('a state text that is NOT on the CBIC list blocks issuance (parked, place-of-supply gap)', async () => {
    const { orderId } = await dispatchedOrder(
      [{ skuId: sku('IN-GAP'), quantity: 1, ratePaise: 300 }],
      'gap',
      { destination: testAddress({ state: 'Atlantis', city: 'Poseidonis' }) },
    );
    await delivery.deliver(dispatchedEvent(orderId));

    const row = mustRow(await invoiceRow(orderId));
    expect(row.status).toBe('awaiting-data');
    expect(row.place_of_supply).toBeNull();
    expect(row.supply_type).toBeNull();
    const doc = row.document as { gaps: { kind: string; detail: string }[]; totals: { subtotal: number; gst: number; payAble: number } };
    expect(doc.gaps.map((gap) => gap.kind)).toEqual(['place-of-supply']);
    expect(doc.gaps[0]!.detail).toContain('Atlantis');
    // The taxable value still computes (reviewable); NO tax charges.
    expect(doc.totals.subtotal).toBe(300);
    expect(doc.totals.gst).toBe(0);
    expect(doc.totals.payAble).toBe(300);
  });

  it('a blank-HSN line ISSUES with the hsn-gap warning (a non-blocking gap)', async () => {
    const { orderId } = await dispatchedOrder(
      [{ skuId: sku('IN-HSN'), quantity: 1, ratePaise: 300 }],
      'hsn',
    );
    await delivery.deliver(dispatchedEvent(orderId));

    const row = mustRow(await invoiceRow(orderId));
    expect(row.status).toBe('issued'); // the gap DOES NOT block
    expect(row.invoice_no).toMatch(/^FY-\d{4}-\d{6}$/);
    const doc = row.document as { gaps: { kind: string; detail: string; orderLineId?: string }[]; lines: { orderLineId: string; skuCode: string; hsn: string | null; hsnGap: boolean }[] };
    expect(doc.gaps.map((gap) => gap.kind)).toEqual(['hsn-gap']);
    expect(doc.gaps[0]!.orderLineId).toBe(doc.lines[0]!.orderLineId);
    expect(doc.lines[0]!.hsn).toBeNull();
    expect(doc.lines[0]!.hsnGap).toBe(true);
    const lines = await invoiceLineRows(row.id as string);
    expect(lines[0]!.hsn_gap).toBe(true);
    expect(lines[0]!.hsn).toBeNull();
  });

  it('the consignee GSTIN OUTRANKS the address text; the mismatch is a pos-discrepancy warning and issuance proceeds', async () => {
    const { orderId } = await dispatchedOrder(
      [{ skuId: sku('IN-MIS'), quantity: 1, ratePaise: 300 }],
      'mismatch',
      {
        consigneeGstin: '27COSGP8394M1ZB',
        destination: testAddress({ state: 'Gujarat', city: 'Ahmedabad', pincode: '380001' }),
      },
    );
    await delivery.deliver(dispatchedEvent(orderId));

    const row = mustRow(await invoiceRow(orderId));
    expect(row.status).toBe('issued');
    expect(row.place_of_supply).toBe('27'); // the GSTIN's digits, NOT 24
    expect(row.supply_type).toBe('intra'); // 27 → 27
    const doc = row.document as { gaps: { kind: string; detail: string }[] };
    expect(doc.gaps.map((gap) => gap.kind)).toEqual(['pos-discrepancy']);
    expect(doc.gaps[0]!.detail).toContain('27COSGP8394M1ZB');
    expect(doc.gaps[0]!.detail).toContain('24'); // the address code, reported
  });

  it('an INTER-state supply charges IGST only', async () => {
    const { orderId } = await dispatchedOrder(
      [{ skuId: sku('IN-INTER'), quantity: 4, ratePaise: 250 }],
      'inter',
      { consigneeGstin: '29AAACR5055K1Z5', destination: testAddress() }, // Karnataka
    );
    await delivery.deliver(dispatchedEvent(orderId));

    const row = mustRow(await invoiceRow(orderId));
    expect(row.status).toBe('issued');
    expect(row.supply_type).toBe('inter');
    expect(row.place_of_supply).toBe('29');
    // taxable 1000 paise; 18% = 180 → ALL of it IGST.
    expect(Number(row.gst_paise)).toBe(180);
    const lines = await invoiceLineRows(row.id);
    expect(lines[0]).toMatchObject({ taxable_paise: '1000', igst_paise: '180', cgst_paise: '0', sgst_paise: '0' });
  });

  it('the warehouse GSTIN OUTRANKS the tenant GSTIN on the origin arm (and both resolve code 27)', async () => {
    // The main warehouse carries 27AAAPZ1234C1ZV; the tenant was SQL-stamped
    // with a DIFFERENT gstin before all the invoice scenarios — the origin
    // arm must pick the WAREHOUSE's.
    const { orderId } = await dispatchedOrder(
      [{ skuId: sku('IN-TENANT'), quantity: 1, ratePaise: 300 }],
      'tenantgstin',
      { destination: testAddress({ state: 'Maharashtra' }) },
    );
    await delivery.deliver(dispatchedEvent(orderId));
    const row = mustRow(await invoiceRow(orderId));
    expect(row!.status).toBe('issued');
    expect(row!.origin_gstin).toBe('27AAAPZ1234C1ZV');
    expect(row!.supply_type).toBe('intra');
  });

  it('the TENANT GSTIN backs the origin when the warehouse carries none (second warehouse)', async () => {
    // An order THROUGH the no-gstin warehouse: the origin arm is
    // warehouseGstin ?? tenantGstin → '27BBBPT5678M2AB' → code 27.
    const orderId = await dispatchedFromSecondWarehouse(sku('IN-OK'), 2, 450);

    await delivery.deliver(dispatchedEvent(orderId));
    const row = mustRow(await invoiceRow(orderId));
    expect(row!.status).toBe('issued');
    expect(row!.origin_gstin).toBe('27BBBPT5678M2AB'); // the TENANT's — the warehouse had none
    expect(row!.supply_type).toBe('intra');
    expect(row!.place_of_supply).toBe('27');
    expect(Number(row!.gst_paise)).toBe(162); // 900 taxable, 18%
  });

  it('a KIT order invoices the COMPONENTS only: the zero-pick parent drops, children carry per-component manual rates', async () => {
    const { orderId, lineRows } = await dispatchedOrder(
      [{ skuId: sku('IN-KITP'), quantity: 1, ratePaise: 9999 }], // the parent's rate is INERT
      'kit',
      {
        destination: testAddress({ state: 'Maharashtra' }),
        // The parent is NEVER seeded (a kit SKU cannot hold stock — 11.4's
        // 409): the components are, at their composition quantities.
        seed: [
          { skuId: sku('IN-KTC1'), quantity: 1 },
          { skuId: sku('IN-KTC2'), quantity: 2 },
        ],
      },
    );
    const child1 = lineRows.find((row) => row.skuId === sku('IN-KTC1') && row.parentLineId !== null)!;
    const child2 = lineRows.find((row) => row.skuId === sku('IN-KTC2') && row.parentLineId !== null)!.id;
    expect(child1.parentLineId).not.toBeNull();
    expect(child2).toBeDefined();

    // The children were CREATED unpriced → the command prices them.
    const priced = await command.generate(
      {
        tenantId,
        actorUserId: ownerUserId,
        orderId,
        rates: ratesFor(lineRows, { 'IN-KTC1': 1000, 'IN-KTC2': 200 }),
      },
      ulid(),
    );
    expect(priced.invoice.status).toBe('issued');
    const codes = priced.invoice.lines.map((line) => line.skuCode).sort();
    expect(codes).toEqual(['IN-KTC1', 'IN-KTC2']); // the parent DROPPED
    const byCode = new Map(priced.invoice.lines.map((line) => [line.skuCode, line]));
    // Component 1: 1 unit × ₹10 = 1000 paise; 18% = 180 (90+90).
    expect(byCode.get('IN-KTC1')).toMatchObject({ qtyMilli: 1000, ratePaise: 1000, taxablePaise: 1000, gstBps: 1800, cgstPaise: 90, sgstPaise: 90 });
    // Component 2: 2 units (the ×2 composition) × ₹2 = 400; 18% = 72 (36+36).
    expect(byCode.get('IN-KTC2')).toMatchObject({ qtyMilli: 2000, ratePaise: 200, taxablePaise: 400, cgstPaise: 36, sgstPaise: 36 });
    expect(priced.invoice.subtotalPaise).toBe(1400);
    expect(priced.invoice.gstPaise).toBe(252);
    expect(priced.invoice.totalPaise).toBe(1652);
    // The parent's ₹99.99 never priced a line.
    expect(priced.invoice.lines.some((line) => line.ratePaise === 9999)).toBe(false);
  });

  it('at-least-once delivery re-derives IDENTICALLY: the same invoice, no revision bump, no second `invoice.issued`', async () => {
    await clearOutbox();
    const { orderId } = await dispatchedOrder([{ skuId: sku('IN-TWICE'), quantity: 2, ratePaise: 450 }], 'twice');

    const event = dispatchedEvent(orderId);
    await delivery.deliver(event);
    const first = mustRow(await invoiceRow(orderId));
    expect(first.status).toBe('issued');
    const issuedCount = async (): Promise<number> => {
      const rows = await sql`
        select count(*)::int as n from outbox_messages
        where tenant_id = ${tenantId} and type = 'invoice.issued' and payload->>'orderId' = ${orderId}
      `;
      return Number((rows[0] as unknown as { n: number }).n);
    };
    expect(await issuedCount()).toBe(1);

    // The redelivery (the same event — the relay's at-least-once posture).
    await delivery.deliver(event);
    const second = mustRow(await invoiceRow(orderId));
    expect(second.id).toBe(first.id);
    expect(second.invoice_no).toBe(first.invoice_no);
    expect(second.revision).toBe(first.revision);
    expect(second.document).toEqual(first.document);
    expect(await issuedCount()).toBe(1); // no second emission
  });

  it('the generation RACE, forced: the command loses the insert to the delivery, retries, and its rates still apply — one row, no double tax', async () => {
    await clearOutbox();
    const { orderId, lineRows } = await dispatchedOrder([{ skuId: sku('IN-RACE'), quantity: 2 }], 'race');
    await clearOutbox(); // the delivery runs by hand below, never through a drain

    // The barrier: the delivery's transaction INSERTS the invoice row, then
    // parks before its line write (uncommitted). The command starts while it
    // is parked, sees no row, inserts, and BLOCKS on the unique index; the
    // release commits the delivery, so the command's insert must fail with
    // the unique violation — the race-lost arm, every run.
    const proto = InvoiceGenerator.prototype as unknown as { writeLines: (...args: unknown[]) => Promise<void> };
    const original = proto.writeLines;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const atGate = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let first = true;
    proto.writeLines = async function (this: unknown, ...args: unknown[]): Promise<void> {
      if (first) {
        first = false;
        arrived();
        await gate;
      }
      return original.apply(this, args);
    };
    const key = ulid();
    const rates = ratesFor(lineRows, { 'IN-RACE': 450 });
    let result: Awaited<ReturnType<InvoicingCommand['generate']>>;
    try {
      const delivered = delivery.deliver(dispatchedEvent(orderId));
      await atGate;
      const commanded = command.generate({ tenantId, actorUserId: ownerUserId, orderId, rates }, key);
      await waitForLockWait();
      release();
      await delivered;
      result = await commanded;
    } finally {
      release();
      proto.writeLines = original;
    }

    // The delivery parked it (unpriced); the command's RETRY took the
    // regenerate path and its rates landed — not the winner's bare row.
    expect(result.invoice.status).toBe('issued');
    expect(result.invoice.lines[0]).toMatchObject({ ratePaise: 450, rateSource: 'manual' });
    expect(result.invoice.revision).toBe(2);
    expect(result.invoice.gstPaise).toBe(162); // 900 taxable, 18% — never doubled
    expect(result.invoice.totalPaise).toBe(1062);

    const rows = await sql`select id from invoices where tenant_id = ${tenantId} and order_id = ${orderId}`;
    expect(rows).toHaveLength(1);
    const issued = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId} and type = 'invoice.issued' and payload->>'orderId' = ${orderId}
    `;
    expect(Number((issued[0] as unknown as { n: number }).n)).toBe(1);
    // The retry wrote the audit row and the key: the same key REPLAYS.
    const audits = await sql`
      select count(*)::int as n from audit_events
      where tenant_id = ${tenantId} and target_id = ${orderId} and action = 'invoice.generated'
    `;
    expect(Number((audits[0] as unknown as { n: number }).n)).toBe(1);
    const replayed = await command.generate({ tenantId, actorUserId: ownerUserId, orderId, rates }, key);
    expect(replayed).toEqual(result);
  });

  it('numbering: gap-free, tenant-FY-scoped, monotonic under the series-row lock', async () => {
    // Two fresh orders issued back-to-back; the series advances by exactly
    // one each, in THIS tenant's own series row.
    const before = (await sql`
      select coalesce(max(last_seq), 0)::text as last_seq from invoice_series where tenant_id = ${tenantId}
    `) as unknown as { last_seq: string }[];
    const last = Number(before[0]?.last_seq ?? 0);

    const a = await command.generate(
      { tenantId, actorUserId: ownerUserId, orderId: (await newIssuanceOrder('IN-SERA', 'sera-a')).orderId },
      ulid(),
    );
    const b = await command.generate(
      { tenantId, actorUserId: ownerUserId, orderId: (await newIssuanceOrder('IN-SERB', 'sera-b')).orderId },
      ulid(),
    );
    expect(a.invoice.status).toBe('issued');
    expect(b.invoice.status).toBe('issued');
    expect(a.invoice.invoiceNo).toBe(a.invoice.fyLabel! + '-' + String(last + 1).padStart(6, '0'));
    expect(b.invoice.invoiceNo).toBe(b.invoice.fyLabel! + '-' + String(last + 2).padStart(6, '0'));
    expect(b.invoice.fyLabel).toBe(a.invoice.fyLabel);
    expect(b.invoice.seriesSeq).toBe(last + 2);

    // The series is tenant-scoped and FY-scoped: exactly one row for this
    // tenant's current FY, holding the last sequence (the RLS probe covers
    // the cross-tenant arm; this row is the numbering's own proof).
    const series = (await sql`
      select fy_label, last_seq from invoice_series where tenant_id = ${tenantId} order by fy_label
    `) as unknown as { fy_label: string; last_seq: string }[];
    const current = series.find((row) => row.fy_label === a.invoice.fyLabel)!;
    expect(Number(current.last_seq)).toBe(last + 2);
  });

  async function newIssuanceOrder(skuCode: string, tag: string): Promise<{ orderId: string }> {
    const { orderId } = await dispatchedOrder(
      [{ skuId: sku(skuCode), quantity: 1, ratePaise: 100 }],
      tag,
      { destination: testAddress({ state: 'Maharashtra' }) },
    );
    return { orderId };
  }

  it('NO supplier GSTIN parks the invoice (supplier-gstin gap); a tenant GSTIN from ANOTHER state warns on the origin and decides the supply type', async () => {
    try {
      // Neither the second warehouse nor the tenant carries a GSTIN: the
      // origin still resolves from the address text, but no tax invoice can
      // issue in the supplier's name.
      await sql`update tenants set gstin = null where id = ${tenantId}`;
      const parkedId = await dispatchedFromSecondWarehouse(sku('IN-SUPP'), 1, 300);
      await delivery.deliver(dispatchedEvent(parkedId));
      const parked = mustRow(await invoiceRow(parkedId));
      expect(parked.status).toBe('awaiting-data');
      expect(parked.invoice_no).toBeNull();
      expect(parked.origin_gstin).toBeNull();
      expect((parked.document as { gaps: { kind: string }[] }).gaps.map((gap) => gap.kind)).toEqual(['supplier-gstin']);

      // A tenant GSTIN registered in Karnataka (29) now backs a warehouse
      // that sits in Maharashtra: the GSTIN wins (inter-state against the
      // Maharashtra consignee) and the origin mismatch is a WARNING.
      await sql`update tenants set gstin = '29BBBPT5678M2AB' where id = ${tenantId}`;
      const regenerated = await command.generate({ tenantId, actorUserId: ownerUserId, orderId: parkedId }, ulid());
      expect(regenerated.invoice.status).toBe('issued');
      expect(regenerated.invoice.originGstin).toBe('29BBBPT5678M2AB');
      expect(regenerated.invoice.supplyType).toBe('inter');
      const gaps = regenerated.invoice.document.gaps;
      expect(gaps.map((gap) => gap.kind)).toEqual(['pos-discrepancy']);
      expect(gaps[0]!.detail).toContain('supply-origin discrepancy');
      // The seller of record is the TENANT, never the warehouse label.
      const seller = regenerated.invoice.document.seller;
      expect(seller.name).toMatch(/^GST Co /);
    } finally {
      await sql`update tenants set gstin = '27BBBPT5678M2AB' where id = ${tenantId}`;
    }
  });

  it('delivery postures: a malformed payload and a data fault ACK (the channel writeback after it is not starved); a transient failure RETHROWS', async () => {
    await expect(
      delivery.deliver({ ...dispatchedEvent(uuidv7()), payload: { dispatch: { orderId: 'not-a-uuid' } } }),
    ).resolves.toBeUndefined();

    const unknown = uuidv7();
    await expect(delivery.deliver(dispatchedEvent(unknown))).resolves.toBeUndefined();
    expect(await invoiceRow(unknown)).toBeUndefined();

    const { orderId: accepted } = await createOrder([{ skuId: sku('IN-RETRY'), quantity: 1, ratePaise: 100 }]);
    await expect(delivery.deliver(dispatchedEvent(accepted))).resolves.toBeUndefined(); // 409 order-not-dispatched
    expect(await invoiceRow(accepted)).toBeUndefined();

    const spy = jest
      .spyOn(app.get(InvoiceGenerator), 'generateCoreInTx')
      .mockRejectedValueOnce(new Error('connection reset by peer'));
    try {
      await expect(delivery.deliver(dispatchedEvent(accepted))).rejects.toThrow('connection reset by peer');
    } finally {
      spy.mockRestore();
    }
  });

  it('AC2: a transient generation failure leaves dispatch untouched; the relay retry issues exactly one invoice', async () => {
    await clearOutbox();
    const { orderId } = await dispatchedOrder([{ skuId: sku('IN-RETRY'), quantity: 1, ratePaise: 100 }], 'retry');

    const spy = jest
      .spyOn(app.get(InvoiceGenerator), 'generateCoreInTx')
      .mockRejectedValueOnce(new Error('deadlock detected'));
    try {
      await forceDue();
      await relay.drain(20);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await invoiceRow(orderId)).toBeUndefined();
    const order = (await sql`select status from orders where id = ${orderId}`) as unknown as { status: string }[];
    expect(order[0]!.status).toBe('dispatched'); // dispatch never rolls back
    const pending = (await sql`
      select attempts, last_error from outbox_messages
      where tenant_id = ${tenantId} and type = 'order.dispatched' and payload->'dispatch'->>'orderId' = ${orderId}
    `) as unknown as { attempts: number; last_error: string | null }[];
    expect(pending).toHaveLength(1);
    expect(Number(pending[0]!.attempts)).toBe(1);

    await forceDue();
    await relay.drain(20);
    const row = mustRow(await invoiceRow(orderId));
    expect(row.status).toBe('issued');
    const count = await sql`select count(*)::int as n from invoices where tenant_id = ${tenantId} and order_id = ${orderId}`;
    expect(Number((count[0] as unknown as { n: number }).n)).toBe(1);
    const issued = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId} and type = 'invoice.issued' and payload->>'orderId' = ${orderId}
    `;
    expect(Number((issued[0] as unknown as { n: number }).n)).toBe(1);
  });

  it('the 8-1 hash inputs are pinned: one key with a changed ratePaise, consigneeGstin, warehouse gstin or registration gstin answers 422', async () => {
    const reuse = async (path: string, key: string, first: object, second: object, token: string | null): Promise<void> => {
      const send = (body: object) => {
        const req = request(app.getHttpServer()).post(path).set(KEY_HEADER, key);
        return (token === null ? req : req.set('Authorization', `Bearer ${token}`)).send(body);
      };
      const created = await send(first).expect(201);
      if (path === API) createdTenantIds.push(created.body.tenant.id as string);
      expect((await send(second).expect(422)).body.code).toBe('idempotency-key-reuse');
    };
    const order = (ratePaise: number, consigneeGstin?: string) => ({
      warehouseId,
      lines: [{ skuId: sku('IN-HTTP'), quantity: 1, ratePaise }],
      destination: testAddress({ state: 'Maharashtra' }),
      ...(consigneeGstin === undefined ? {} : { consigneeGstin }),
    });
    await reuse(`${API}/${tenantId}/outbound/orders`, ulid(), order(100), order(101), opsToken);
    await reuse(`${API}/${tenantId}/outbound/orders`, ulid(), order(100, '27COSGP8394M1ZB'), order(100, '29COSGP8394M1ZB'), opsToken);
    const warehouse = (gstin: string) => ({
      gstin,
      origin: testAddress({ state: 'Maharashtra', city: 'Pune', line1: '9, Chakan MIDC', pincode: '410501' }),
      code: 'HSH-WH',
      name: 'Hash pin WH',
    });
    await reuse(`${API}/${tenantId}/warehouses`, ulid(), warehouse('27AAAPZ1234C1ZV'), warehouse('29AAAPZ1234C1ZV'), ownerToken);
    const registration = (gstin: string) => ({
      name: 'Hash Pin Co',
      ownerEmail: `hash-${ulid().toLowerCase()}@example.com`,
      password: 'correct-horse-battery',
      gstin,
    });
    const first = registration('27AAAPZ1234C1ZV');
    await reuse(API, ulid(), first, { ...first, gstin: '29AAAPZ1234C1ZV' }, null);
    await clearForeignOutbox();
  });

  it('GSTINs round-trip: registration normalizes, sign-in and the warehouse list echo; a BLANK one reads as absent on every edge', async () => {
    const email = `gstin-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Round Trip ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery', gstin: ' 27aaapz1234c1zv ' })
      .expect(201);
    const otherTenant = registered.body.tenant.id as string;
    createdTenantIds.push(otherTenant);
    expect(registered.body.tenant.gstin).toBe('27AAAPZ1234C1ZV');
    const stored = (await sql`select gstin from tenants where id = ${otherTenant}`) as unknown as { gstin: string }[];
    expect(stored[0]!.gstin).toBe('27AAAPZ1234C1ZV');
    const signedIn = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email, password: 'correct-horse-battery' })
      .expect(200);
    expect(signedIn.body.tenant.gstin).toBe('27AAAPZ1234C1ZV');

    const blank = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Blank ${ulid()}`, ownerEmail: `blank-${ulid().toLowerCase()}@example.com`, password: 'correct-horse-battery', gstin: '   ' })
      .expect(201);
    createdTenantIds.push(blank.body.tenant.id as string);
    expect(blank.body.tenant.gstin).toBeNull();

    const listed = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const items = listed.body.items as { id: string; gstin: string | null }[];
    expect(items.find((item) => item.id === warehouseId)!.gstin).toBe('27AAAPZ1234C1ZV');
    expect(items.find((item) => item.id === noGstinWarehouseId)!.gstin).toBeNull();

    const order = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines: [{ skuId: sku('IN-HTTP'), quantity: 1 }], destination: testAddress({ state: 'Maharashtra' }), consigneeGstin: '' })
      .expect(201);
    const consignee = (await sql`select consignee_gstin from orders where id = ${order.body.order.id as string}`) as unknown as { consignee_gstin: string | null }[];
    expect(consignee[0]!.consignee_gstin).toBeNull();
    await clearForeignOutbox();
  });

  // ── the HTTP surface ────────────────────────────────────────────────────────

  it('HTTP: POST /invoices prices an unpriced order to issuance; replays by key; list + detail read it back', async () => {
    await clearOutbox();
    const { orderId, lineRows } = await dispatchedOrder(
      [{ skuId: sku('IN-HTTP'), quantity: 2 }],
      'http',
      { destination: testAddress({ state: 'Maharashtra' }) },
    );
    await delivery.deliver(dispatchedEvent(orderId));
    expect(mustRow(await invoiceRow(orderId)).status).toBe('awaiting-data');
    // A second invoice of this test's own, so the pagination below never
    // depends on what earlier tests left behind.
    const { orderId: secondId } = await dispatchedOrder(
      [{ skuId: sku('IN-HTTP'), quantity: 1, ratePaise: 100 }],
      'http-2',
      { destination: testAddress({ state: 'Maharashtra' }) },
    );
    await delivery.deliver(dispatchedEvent(secondId));

    const key = ulid();
    const body = { orderId, rates: ratesFor(lineRows, { 'IN-HTTP': 250 }) };
    const generated = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(200);
    const invoice = generated.body.invoice as {
      id: string;
      status: string;
      invoiceNo: string;
      subtotalPaise: number;
      gstPaise: number;
      totalPaise: number;
      lines: { rateSource: string; ratePaise: number }[];
      document: { gaps: unknown[] };
    };
    expect(invoice.status).toBe('issued');
    expect(invoice.invoiceNo).toMatch(/^FY-\d{4}-\d{6}$/);
    expect(invoice.subtotalPaise).toBe(500);
    expect(invoice.gstPaise).toBe(90);
    expect(invoice.totalPaise).toBe(590);
    expect(invoice.lines[0]).toMatchObject({ ratePaise: 250, rateSource: 'manual' });
    expect(invoice.document.gaps).toEqual([]);

    // Same key, same body → the byte-identical snapshot; same key, other body → 422.
    const replayed = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(200);
    expect(replayed.body).toEqual(generated.body);
    const reused = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ orderId, rates: ratesFor(lineRows, { 'IN-HTTP': 251 }) })
      .expect(422);
    expect(reused.body.code).toBe('idempotency-key-reuse');

    // Reads are open to any member — the accountant reads both.
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices/${invoice.id}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    expect(detail.body.invoice).toEqual(generated.body.invoice);

    const firstPage = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices`)
      .query({ limit: 1 })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    expect(firstPage.body.items).toHaveLength(1);
    expect(typeof firstPage.body.nextCursor).toBe('string');
    expect(firstPage.body.items[0]).not.toHaveProperty('document');
    expect(firstPage.body.items[0]).not.toHaveProperty('lines');
    const secondPage = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices`)
      .query({ limit: 1, cursor: firstPage.body.nextCursor as string })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    expect(secondPage.body.items[0].id).not.toBe(firstPage.body.items[0].id);
  });

  it('HTTP: the refusal arms — role, tenant, key, body, path and domain', async () => {
    const { orderId, lineRows: refuseLines } = await dispatchedOrder(
      [{ skuId: sku('IN-HTTP'), quantity: 1, ratePaise: 100 }],
      'http-refuse',
      { destination: testAddress({ state: 'Maharashtra' }) },
    );
    const post = (token: string, payload: unknown, key: string | null = ulid()) => {
      const req = request(app.getHttpServer())
        .post(`${API}/${tenantId}/invoices`)
        .set('Authorization', `Bearer ${token}`);
      return (key === null ? req : req.set(KEY_HEADER, key)).send(payload as object);
    };

    // invoice.generate is owner + ops_manager only.
    expect((await post(accountantToken, { orderId }).expect(403)).body.code).toBe('role-denied');
    expect((await post(operatorWebToken, { orderId }).expect(403)).body.code).toBe('role-denied');
    // Another tenant's path.
    await request(app.getHttpServer())
      .post(`${API}/${uuidv7()}/invoices`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ orderId })
      .expect(403);
    // Missing key; malformed body arms.
    await post(ownerToken, { orderId }, null).expect(400);
    await post(ownerToken, { orderId: 'not-a-uuid' }).expect(400);
    await post(ownerToken, { orderId, rates: [{ orderLineId: uuidv7(), ratePaise: -1 }] }).expect(400);
    await post(ownerToken, { orderId, rates: [{ orderLineId: uuidv7(), ratePaise: 1.5 }] }).expect(400);
    // Domain arms.
    expect((await post(ownerToken, { orderId: uuidv7() }).expect(404)).body.code).toBe('not-found');
    const { orderId: acceptedId } = await createOrder([{ skuId: sku('IN-HTTP'), quantity: 1, ratePaise: 100 }]);
    expect((await post(ownerToken, { orderId: acceptedId }).expect(409)).body.code).toBe('order-not-dispatched');
    expect(
      (await post(ownerToken, { orderId, rates: [{ orderLineId: uuidv7(), ratePaise: 100 }] }).expect(409)).body.code,
    ).toBe('line-not-of-order');
    expect(
      (await post(ownerToken, { orderId, rates: [{ orderLineId: refuseLines[0]!.id, ratePaise: 200 }] }).expect(409)).body.code,
    ).toBe('line-already-priced');
    // A duplicate line in `rates` passes the DTO (each entry is valid) and
    // is refused by the command, behind its replay lookup.
    const dup = uuidv7();
    expect(
      (await post(ownerToken, { orderId, rates: [{ orderLineId: dup, ratePaise: 1 }, { orderLineId: dup, ratePaise: 2 }] }).expect(400)).body.code,
    ).toBe('validation-failed');

    // Detail: malformed id 400, unknown id 404; a malformed cursor 400.
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices/nope`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices/${uuidv7()}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices`)
      .query({ cursor: 'garbage' })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
    await request(app.getHttpServer()).get(`${API}/${tenantId}/invoices`).expect(401);
  });

  // ── the database itself ─────────────────────────────────────────────────────

  it('RLS holds on invoices / invoice_lines / invoice_series through the non-superuser probe (fail-closed)', async () => {
    // The probe role (the client-isolation precedent).
    const PROBE_LOCK = 5591;
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${PROBE_LOCK})`;
      await tx.unsafe(`
        do $$ begin
          if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
            create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
          end if;
        end $$;
      `);
      await tx.unsafe('grant usage on schema public to wms_rls_probe');
      await tx.unsafe(
        'grant select, insert, update, delete on all tables in schema public to wms_rls_probe',
      );
    });
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const probe = postgres(url.toString(), { max: 1 });
    try {
      const anyTenant = uuidv7();
      for (const table of ['invoices', 'invoice_lines', 'invoice_series']) {
        // No tenant variable → zero rows, even with the predicate in SQL.
        const unscoped = await probe.unsafe(
          `select count(*)::int as n from ${table} where tenant_id = '${tenantId}'::uuid`,
        );
        expect(Number((unscoped[0] as unknown as { n: number }).n)).toBe(0);
        // The WRONG tenant → zero rows too.
        const wrong = await probe.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${anyTenant}, true)`;
          return tx.unsafe(`select count(*)::int as n from ${table} where tenant_id = '${tenantId}'::uuid`);
        });
        expect(Number((wrong[0] as unknown as { n: number }).n)).toBe(0);
        // The RIGHT tenant → the suite's own rows are visible.
        const own = await probe.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
          return tx.unsafe(`select count(*)::int as n from ${table} where tenant_id = '${tenantId}'::uuid`);
        });
        expect(Number((own[0] as unknown as { n: number }).n)).toBeGreaterThan(0);
      }
      // …and the GLOBAL reference table carries NO RLS: visible to the probe
      // without any tenant variable.
      const global = await probe.unsafe(
        `select count(*)::int as n from gst_state_codes where state_code in ('27','29','24')`,
      );
      expect(Number((global[0] as unknown as { n: number }).n)).toBe(3);
    } finally {
      await probe.end();
    }
  });
});