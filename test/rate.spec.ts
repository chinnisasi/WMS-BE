import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { MAX_QUANTITY_MILLI } from '../src/shared/primitives/quantity';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions — the same bootstrap the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// The rate read opens carrier credentials — the same e2e-only value the
// label/carriers/dispatch suites set (sealing happens at connect time).
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
 * One tenant's full fixture context. The MAIN tenant carries the two live
 * carrier connections (sandbox + delhivery) every rating scenario rides; the
 * BARE tenant is the same machinery with NO connections (the 200-empty arm)
 * and one packed order (the foreign-tenant 404 rides its order id).
 */
interface TenantCtx {
  readonly tenantId: string;
  readonly ownerToken: string;
  readonly opsToken: string;
  readonly operatorWebToken: string;
  readonly accountantToken: string;
  readonly operatorToken: string; // the badge-in DEVICE session (picking)
  readonly warehouseId: string;
  readonly binId: string;
  readonly skuIds: ReadonlyMap<string, string>;
}

/**
 * The sandbox rate formula, recomputed from ITS OWN design-notes form (the
 * label arm's recompute-the-expected precedent, `label.spec.ts:655`): base +
 * per-kg + the pincode-pair jitter band, all integer paise. The suite derives
 * the expected amount from the formula, never from a first response — a test
 * that asserts the server against itself proves nothing.
 */
function expectedSandboxPaise(origin: string, destination: string, weightGrams: number): number {
  const digest = createHash('sha256')
    .update(`sandbox-rate|${origin}|${destination}`)
    .digest();
  return 2500 + 500 * Math.ceil(weightGrams / 1000) + (digest.readUInt32BE(0) % 1500);
}

const ORIGIN_PINCODE = '560066'; // testAddress() — the warehouse's origin
const DESTINATION_PINCODE = '560092'; // every rate scenario's destination

/**
 * Story 4.6d — carrier rate shopping, the matrix e2e.
 *
 * The scenario the spec pins: rating is a READ (no ledger, outbox, audit or
 * idempotency row — nothing is written, twice-read is byte-identical); the
 * sandbox carrier quotes the formula's deterministic paise amount against the
 * order's aggregated shippable weight (kit component lines counted, kit
 * parent lines excluded); the DIRECT carrier answers its same typed verbatim
 * 501 `carrier-transport-unconfigured` as a refused ITEM while the sandbox
 * still quotes; missing weights refuse the whole quote naming the SKUs; a
 * not-ready order is a 409 naming the status; an order with no connections
 * reads 200 with an empty list; and a foreign tenant's order reads 404.
 */
describe('carrier rate shopping: the read that prices one order against every live connection (e2e, story 4.6d)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  let suiteDb: SuiteDatabase;
  const createdTenantIds: string[] = [];

  let main: TenantCtx;
  let bare: TenantCtx;
  let sandboxConnectionId: string;
  let delhiveryConnectionId: string;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('rate');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    main = await setupTenant('Rate Co');
    bare = await setupTenant('Bare Co');

    // The MAIN tenant's carrier connections: sandbox (the deterministic
    // in-process quote) and a DIRECT carrier (delhivery — the typed 501
    // item). The credential is a canary the suite asserts never escapes.
    sandboxConnectionId = (
      await request(app.getHttpServer())
        .post(`${API}/${main.tenantId}/carriers/connections`)
        .set('Authorization', `Bearer ${main.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          carrierCode: 'sandbox',
          accountLabel: `Sandbox ${ulid().slice(10, 16)}`,
          credential: { accountToken: 'canary-sandbox-token-4f2e1d' },
        })
        .expect(201)
    ).body.id as string;
    delhiveryConnectionId = (
      await request(app.getHttpServer())
        .post(`${API}/${main.tenantId}/carriers/connections`)
        .set('Authorization', `Bearer ${main.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          carrierCode: 'delhivery',
          accountLabel: `Delhivery ${ulid().slice(10, 16)}`,
          credential: { apiToken: 'canary-delhivery-token-f3a91c', clientName: 'canary-delhivery-client' },
        })
        .expect(201)
    ).body.id as string;

    await app.get(InventoryFacade).rebuildReservationCounters(main.tenantId, main.warehouseId);
    await app.get(InventoryFacade).rebuildReservationCounters(bare.tenantId, bare.warehouseId);
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
      // `ledger_events` is append-only (a trigger rejects every DELETE,
      // UPDATE and TRUNCATE) — the teardown disables the guard for its own
      // rows only and re-enables it.
      await cleaner.unsafe('ALTER TABLE ledger_events DISABLE TRIGGER ledger_events_append_only');
      try {
        await cleaner.unsafe(`DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])`, [
          createdTenantIds,
        ]);
      } finally {
        await cleaner.unsafe('ALTER TABLE ledger_events ENABLE TRIGGER ledger_events_append_only');
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

  /** One full tenant: warehouse (+ bin), two roles, the rate SKUs, the device. */
  async function setupTenant(name: string): Promise<TenantCtx> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `${name} ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    const tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const signIn = (address: string, password: string) =>
      request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: address, password })
        .expect(200)
        .then((res) => res.body.accessToken as string);
    const ownerToken = await signIn(email, 'correct-horse-battery');
    const opsToken = await inviteAndSignIn(tenantId, ownerToken, 'ops_manager', 'ops-password-123');
    const operatorWebToken = await inviteAndSignIn(tenantId, ownerToken, 'operator', 'floor-password-123');
    const accountantToken = await inviteAndSignIn(tenantId, ownerToken, 'accountant', 'books-password-123');

    const warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `RATE-${ulid().slice(10, 16).toUpperCase()}`, name: `${name} WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
    const zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    const binId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 10000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;

    // Weighted SKUs carry `weight_grams` in the import; the unweighted ones
    // leave the cell empty — exactly the catalog state the 409 arm prices.
    const skuCodes = [
      'RATE-OK', // the happy path: 1200 g
      'RATE-HEAVY', // the heavier-order quote: 3400 g
      'RATE-CHILD', // the kit COMPONENT line's weight: 1500 g
      'RATE-KIT', // the kit PARENT — unweighted, and EXCLUDED from the aggregate
      'RATE-UNWGT', // the missing-weight 409
      'BARE-OK', // the bare tenant's own weighted SKU
    ];
    const csvHeader = 'sku_code,name,uom,uom_conversions,gst_rate,hsn,weight_grams,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const weights: Record<string, string> = {
      'RATE-OK': '1200',
      'RATE-HEAVY': '3400',
      'RATE-CHILD': '1500',
      'RATE-KIT': '',
      'RATE-UNWGT': '',
      'BARE-OK': '1000',
    };
    const csv = [
      csvHeader,
      ...skuCodes.map((code) => `${code},Rate SKU ${code},pcs,,1800,,${weights[code]!},false,false,,,`),
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
    const skuIds = new Map<string, string>();
    for (const item of catalog.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }

    // The floor device + its badge-in operator (picking feeds every fixture).
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Rate desk scanner', pin: '2468' })
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
    const badged = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ operatorEmail, pin: '2468' })
      .expect(200);
    const operatorToken = badged.body.accessToken as string;

    return {
      tenantId,
      ownerToken,
      opsToken,
      operatorWebToken,
      accountantToken,
      operatorToken,
      warehouseId,
      binId,
      skuIds,
    };
  }

  async function inviteAndSignIn(
    tenantId: string,
    ownerToken: string,
    role: string,
    password: string,
  ): Promise<string> {
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

  function skuOf(ctx: TenantCtx, code: string): string {
    const id = ctx.skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  async function seedStock(ctx: TenantCtx, skuId: string, quantity: number): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${ctx.tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${ctx.opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: ctx.warehouseId,
        skuId,
        binId: ctx.binId,
        quantityDelta: quantity,
        reasonCode: 'cycle-count',
        note: 'rate-suite seed',
      })
      .expect(201);
  }

  async function createOrder(
    ctx: TenantCtx,
    lines: { skuId: string; quantity: number }[],
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${ctx.tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${ctx.opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: ctx.warehouseId, lines, destination: testAddress({ pincode: DESTINATION_PINCODE }) })
      .expect(201);
    return res.body.order.id as string;
  }

  /** A fully-picked, PACKED order of ONE line in ONE bin — ratable. */
  async function packedOrder(
    ctx: TenantCtx,
    code: string,
    quantity: number,
    tag: string,
    seed = quantity + 10,
  ): Promise<{ orderId: string; skuId: string }> {
    const skuId = skuOf(ctx, code);
    await seedStock(ctx, skuId, seed);
    const orderId = await createOrder(ctx, [{ skuId, quantity }]);
    const policy = (
      await request(app.getHttpServer())
        .post(`${API}/${ctx.tenantId}/outbound/wave-policies`)
        .set('Authorization', `Bearer ${ctx.opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: ctx.warehouseId, name: `${tag}-${ulid().slice(10, 18)}`, grouping: 'single' })
        .expect(201)
    ).body.policy.id as string;
    const generated = await request(app.getHttpServer())
      .post(`${API}/${ctx.tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${ctx.opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: ctx.warehouseId, policyId: policy, orderIds: [orderId] })
      .expect(201);
    const waveId = generated.body.wave.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${ctx.tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${ctx.opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const wave = (
      await request(app.getHttpServer())
        .get(`${API}/${ctx.tenantId}/outbound/waves/${waveId}`)
        .set('Authorization', `Bearer ${ctx.accountantToken}`)
        .expect(200)
    ).body.wave as Wave;
    const picklist = wave.picklists[0];
    if (picklist === undefined) throw new Error('fixture produced no picklist');
    const line = picklist.lines[0]!;
    await request(app.getHttpServer())
      .post(`${API}/${ctx.tenantId}/outbound/picks`)
      .set('Authorization', `Bearer ${ctx.operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: ctx.warehouseId,
        picklistId: line.picklistId,
        picklistLineId: line.id,
        skuId: line.skuId,
        binId: line.binId!,
        qty: line.qty,
        occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${ctx.tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${ctx.operatorWebToken}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned: [{ skuId, qty: quantity }] })
      .expect(201);
    return { orderId, skuId };
  }

  /** The rate-shopping read — a GET, no Idempotency-Key, any member. */
  function getRates(ctx: TenantCtx, orderId: string, token = ctx.ownerToken): SupertestTest {
    return request(app.getHttpServer())
      .get(`${API}/${ctx.tenantId}/outbound/orders/${orderId}/rates`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function writeCounts(tenantId: string): Promise<Record<string, number>> {
    const rows = await sql`
      select
        (select count(*)::int from outbox_messages where tenant_id = ${tenantId}) as outbox,
        (select count(*)::int from audit_events where tenant_id = ${tenantId}) as audit,
        (select count(*)::int from idempotency_keys where tenant_id = ${tenantId}) as idem,
        (select count(*)::int from ledger_events where tenant_id = ${tenantId}) as ledger,
        (select count(*)::int from shipments where tenant_id = ${tenantId}) as shipments
    `;
    const row = rows[0] as unknown as Record<string, number>;
    return {
      outbox: Number(row.outbox),
      audit: Number(row.audit),
      idem: Number(row.idem),
      ledger: Number(row.ledger),
      shipments: Number(row.shipments),
    };
  }

  // ── the happy path: the formula, the items, the read-only guarantee ───────

  it('quotes a packed order through the sandbox carrier at the formula’s deterministic paise — and writes NOTHING, twice', async () => {
    // qty 3 of a 1200 g SKU → 3600 g → the formula's ceil(3600/1000) = 4 kg arm.
    const { orderId } = await packedOrder(main, 'RATE-OK', 3, 'ok');
    const expected = expectedSandboxPaise(ORIGIN_PINCODE, DESTINATION_PINCODE, 3600);

    const before = await writeCounts(main.tenantId);
    const res = await getRates(main, orderId).expect(200);
    const rates = res.body.rates as {
      orderId: string;
      items: { connectionId: string; carrierCode: string; carrierName: string; quote: { amountPaise: number } | null; refusal: { code: string; status: number; detail: string } | null }[];
    };
    expect(rates.orderId).toBe(orderId);
    // The item order is the contract: carrierCode ascending.
    expect(rates.items.map((item) => item.carrierCode)).toEqual(['delhivery', 'sandbox']);
    // The DIRECT carrier's item is the typed verbatim 501 refusal…
    const direct = rates.items[0]!;
    expect(direct.connectionId).toBe(delhiveryConnectionId);
    expect(direct.carrierName).toBe('Delhivery');
    expect(direct.quote).toBeNull();
    expect(direct.refusal!.code).toBe('carrier-transport-unconfigured');
    expect(direct.refusal!.status).toBe(501);
    expect(direct.refusal!.detail).toContain('delhivery');
    // …and the sandbox item is the formula's exact paise amount.
    const quoted = rates.items[1]!;
    expect(quoted.connectionId).toBe(sandboxConnectionId);
    expect(quoted.carrierName).toBe('Sandbox');
    expect(quoted.refusal).toBeNull();
    expect(quoted.quote!.amountPaise).toBe(expected);

    // The same request again — byte-identical (determinism).
    const again = await getRates(main, orderId).expect(200);
    expect(again.body).toEqual(res.body);

    // And NOTHING was written by either read: no ledger, outbox, audit,
    // idempotency or shipment row appeared (rating is a read).
    expect(await writeCounts(main.tenantId)).toEqual(before);

    // A READ is never capability-gated: the accountant carries no
    // labels.execute and still rates the order.
    await getRates(main, orderId, main.accountantToken).expect(200);
  });

  it('quotes MORE for a heavier order — the per-kg arm moves, the jitter band does not', async () => {
    // The SAME pincode pair, a different weight: only the per-kg arm differs,
    // by exactly 500 paise per extra kilogram.
    const { orderId } = await packedOrder(main, 'RATE-HEAVY', 2, 'heavy');
    const expected = expectedSandboxPaise(ORIGIN_PINCODE, DESTINATION_PINCODE, 6800);
    const res = await getRates(main, orderId).expect(200);
    const rates = res.body.rates as {
      items: { carrierCode: string; quote: { amountPaise: number } | null; refusal: unknown }[];
    };
    const quoted = rates.items.find((item) => item.carrierCode === 'sandbox')!;
    expect(quoted.quote!.amountPaise).toBe(expected);
    expect(expected - expectedSandboxPaise(ORIGIN_PINCODE, DESTINATION_PINCODE, 3600)).toBe(500 * (7 - 4));
  });

  it('counts kit component lines and excludes kit parent lines from the aggregate', async () => {
    // The base order: 3 × 1200 g = 3600 g. Then a SQL-seeded kit line pair —
    // a parent whose SKU is UNWEIGHTED (a kit SKU carries no parcel weight;
    // its row must be EXCLUDED, or the read would 409) and a weighted
    // component CHILD the parent's id names (the physical goods, COUNTED).
    const { orderId } = await packedOrder(main, 'RATE-OK', 3, 'kit');
    const parentLineId = uuidv7();
    await sql`
      insert into order_lines (id, tenant_id, order_id, sku_id, qty, reserved_qty, status, parent_line_id)
      values (${parentLineId}::uuid, ${main.tenantId}::uuid, ${orderId}::uuid, ${skuOf(main, 'RATE-KIT')}::uuid,
              1000, 0, 'open', null)
    `;
    await sql`
      insert into order_lines (id, tenant_id, order_id, sku_id, qty, reserved_qty, status, parent_line_id)
      values (${uuidv7()}::uuid, ${main.tenantId}::uuid, ${orderId}::uuid, ${skuOf(main, 'RATE-CHILD')}::uuid,
              1000, 0, 'open', ${parentLineId}::uuid)
    `;

    // 3600 + 1500 = 5100 g → ceil = 6 kg — the child counted, the parent
    // neither refused (its own SKU is unweighted) nor double-counted.
    const expected = expectedSandboxPaise(ORIGIN_PINCODE, DESTINATION_PINCODE, 5100);
    const res = await getRates(main, orderId).expect(200);
    const rates = res.body.rates as {
      items: { carrierCode: string; quote: { amountPaise: number } | null }[];
    };
    const quoted = rates.items.find((item) => item.carrierCode === 'sandbox')!;
    expect(quoted.quote!.amountPaise).toBe(expected);
  });

  it('refuses cleanly when the aggregate crosses the JS safe-integer boundary, quoting nothing', async () => {
    // The pathological-but-accepted edge: a line at MAX_QUANTITY_MILLI against
    // a SKU weight at the 1,000,000 g cap aggregates past 2^53 grams, where a
    // JS Number silently loses precision. The aggregate is exact in SQL; the
    // JS boundary is guarded explicitly — a clean 409, never a wrong quote.
    const { orderId, skuId } = await packedOrder(main, 'RATE-OK', 2, 'overflow');
    try {
      await sql`
        update order_lines set qty = ${MAX_QUANTITY_MILLI}
        where tenant_id = ${main.tenantId}::uuid and order_id = ${orderId}::uuid and sku_id = ${skuId}::uuid
      `;
      await sql`update skus set weight_grams = 1000000 where id = ${skuId}::uuid`;

      const refused = await getRates(main, orderId).expect(409);
      expect(refused.body.code).toBe('conflict');
      expect(refused.body.detail).toContain('aggregated shippable weight');
      expect(refused.body.detail).toContain('ratable range');
    } finally {
      // Restore the SKU's fixture weight — later scenarios rate it.
      await sql`update skus set weight_grams = 1200 where id = ${skuId}::uuid`;
    }
  });

  // ── the missing-weight refusal ─────────────────────────────────────────────

  it('refuses the whole quote with 409 naming the unweighted SKUs, writing nothing', async () => {
    const { orderId } = await packedOrder(main, 'RATE-UNWGT', 2, 'unwgt');

    const before = await writeCounts(main.tenantId);
    const refused = await getRates(main, orderId).expect(409);
    expect(refused.body.code).toBe('missing-sku-weight');
    expect(refused.body.detail).toContain('RATE-UNWGT');
    expect(refused.body.detail).toContain('no weight_grams');

    // Nothing was quoted or written — the guard sits before every adapter.
    expect(await writeCounts(main.tenantId)).toEqual(before);
  });

  it('names every unweighted SKU up to the namedSample cap, then counts the rest (… and N more)', async () => {
    // The order gains unweighted contributing lines past the detail cap: two
    // fixture SKUs plus twenty SQL-seeded ones → 22 offenders. The sample
    // shows the first 20 code-sorted and the COUNT names the rest — the 21st
    // and 22nd codes must NOT appear (a multi-kilobyte detail is unreadable
    // to the operator and a payload amplification).
    const { orderId } = await packedOrder(main, 'RATE-UNWGT', 1, 'sample');
    await sql`
      insert into order_lines (id, tenant_id, order_id, sku_id, qty, reserved_qty, status, parent_line_id)
      values (${uuidv7()}::uuid, ${main.tenantId}::uuid, ${orderId}::uuid, ${skuOf(main, 'RATE-KIT')}::uuid,
              1000, 0, 'open', null)
    `;
    const clientIdRow = (await sql`
      select client_id from skus where tenant_id = ${main.tenantId}::uuid and code = 'RATE-KIT' limit 1
    `)[0] as { client_id: string };
    for (let i = 1; i <= 20; i += 1) {
      const code = `RATE-X${String(i).padStart(2, '0')}`;
      const skuId = uuidv7();
      await sql`
        insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode)
        values (${skuId}::uuid, ${main.tenantId}::uuid, ${clientIdRow.client_id}::uuid,
                ${code}, 'Rate sample overflow SKU', 'each', 1800, ${`RATE-SAMPLE-${ulid()}`})
      `;
      await sql`
        insert into order_lines (id, tenant_id, order_id, sku_id, qty, reserved_qty, status, parent_line_id)
        values (${uuidv7()}::uuid, ${main.tenantId}::uuid, ${orderId}::uuid, ${skuId}::uuid,
                1000, 0, 'open', null)
      `;
    }
    const refused = await getRates(main, orderId).expect(409);
    expect(refused.body.code).toBe('missing-sku-weight');
    expect(refused.body.detail).toContain('RATE-KIT');
    expect(refused.body.detail).toContain('RATE-UNWGT');
    expect(refused.body.detail).toContain('RATE-X18');
    expect(refused.body.detail).toContain('… and 2 more. Set the weights and retry.');
    expect(refused.body.detail).not.toContain('RATE-X19');
    expect(refused.body.detail).not.toContain('RATE-X20');
  });

  // ── the state and existence guards ─────────────────────────────────────────

  it('refuses an order that was never packed, naming the status', async () => {
    const skuId = skuOf(main, 'RATE-OK');
    await seedStock(main, skuId, 20);
    const acceptedOrderId = await createOrder(main, [{ skuId, quantity: 2 }]);
    const refused = await getRates(main, acceptedOrderId).expect(409);
    expect(refused.body.code).toBe('conflict');
    expect(refused.body.detail).toContain('accepted');
    expect(refused.body.detail).toContain('only a packed');
  });

  it('answers 404 for a nonexistent order and 400 for a malformed id', async () => {
    const missing = await getRates(main, uuidv7()).expect(404);
    expect(missing.body.code).toBe('not-found');
    const malformed = await getRates(main, 'not-a-uuid').expect(400);
    expect(malformed.body.code).toBe('validation-failed');
  });

  it('answers 404 for another tenant’s order — the tenant predicate holds on reads too', async () => {
    // The bare tenant's packed order id, requested under the MAIN tenant's
    // session: RLS stamps the read with the caller's tenant, so the order
    // reads as absent (404), never as another tenant's data.
    const { orderId } = await packedOrder(bare, 'BARE-OK', 2, 'foreign');
    const crossed = await getRates(main, orderId).expect(404);
    expect(crossed.body.code).toBe('not-found');
  });

  it('answers 403 when the SESSION belongs to another tenant than the path names', async () => {
    // The bare tenant's order id, requested on the BARE tenant's route under
    // the MAIN tenant's session: the tenancy guard refuses before anything
    // reads (the tenancy.spec.ts foreign-session precedent).
    const { orderId } = await packedOrder(bare, 'BARE-OK', 2, 'session-cross');
    const crossed = await request(app.getHttpServer())
      .get(`${API}/${bare.tenantId}/outbound/orders/${orderId}/rates`)
      .set('Authorization', `Bearer ${main.ownerToken}`)
      .expect(403);
    expect(crossed.body.code).toBe('permission-denied');
  });

  // ── the no-connections arm ─────────────────────────────────────────────────

  it('answers 200 with an EMPTY list when the tenant has no live carrier connection', async () => {
    // The bare tenant has a ratable order and zero connections — every item
    // would be a quote and none can exist.
    const { orderId } = await packedOrder(bare, 'BARE-OK', 2, 'empty');
    const before = await writeCounts(bare.tenantId);
    const res = await getRates(bare, orderId).expect(200);
    const rates = res.body.rates as { orderId: string; items: unknown[] };
    expect(rates.orderId).toBe(orderId);
    expect(rates.items).toEqual([]);
    expect(await writeCounts(bare.tenantId)).toEqual(before);
  });

  // ── the credential seam ────────────────────────────────────────────────────

  it('fails the WHOLE read with 503 when a stored credential does not open — a deployment fault is never a quote', async () => {
    const { orderId } = await packedOrder(main, 'RATE-OK', 1, 'corrupt');
    // Corrupt the DELHIVERY connection's sealed blob in place: the value
    // still passes the 0025 envelope CHECK (`v1:%`) but AES-GCM
    // authenticates — opening it under the suite's key fails closed (the
    // label suite's re-seal precedent). The credential open sits BEFORE the
    // adapter call, so the `throw err` rethrow fires: the whole read fails,
    // no item carries the broken connection.
    const original = (await sql`
      select credential_sealed from carrier_connections
      where id = ${delhiveryConnectionId}::uuid and tenant_id = ${main.tenantId}::uuid
    `)[0] as { credential_sealed: string };
    try {
      await sql`
        update carrier_connections set credential_sealed = 'v1:not-an-openable-blob'
        where id = ${delhiveryConnectionId}::uuid
      `;
      const failed = await getRates(main, orderId).expect(503);
      expect(failed.body.code).toBe('carrier-credential-unreadable');
      expect(failed.body.detail).toContain('rotate the connection');
      // No partial answer leaked: the read is all-or-nothing.
      expect(failed.body.rates).toBeUndefined();
    } finally {
      await sql`
        update carrier_connections set credential_sealed = ${original.credential_sealed}
        where id = ${delhiveryConnectionId}::uuid
      `;
    }
    // The read recovers once the credential opens again.
    const recovered = await getRates(main, orderId).expect(200);
    const rates = recovered.body.rates as { items: { connectionId: string }[] };
    expect(rates.items).toHaveLength(2);
    expect(rates.items.map((item) => item.connectionId)).toContain(delhiveryConnectionId);
  });

  it('never leaks the sealed credential through the rates response or anything it reads', async () => {
    const { orderId } = await packedOrder(main, 'RATE-OK', 1, 'seal');
    const res = await getRates(main, orderId).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('canary-sandbox-token');
    expect(JSON.stringify(res.body)).not.toContain('canary-delhivery-token');
  });
});