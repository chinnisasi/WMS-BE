import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions — the same bootstrap the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(60_000);

/**
 * Story 10.7 — the mobile pack bench, backend half: the snapshot's `packTasks`
 * / `handlingUnits` arms and the device-guarded pack route
 * (`POST :tenantId/outbound/packs`).
 *
 * The one sentence this suite exists to keep true: **the bench pre-verifies
 * offline exactly what the server will verify** — the snapshot's per-SKU
 * `pickedQty` comes from the same grouped-`picks` roll-up
 * `packOrder`'s verification query runs, the packable predicate mirrors the
 * command's own guards, and the device route is the same command under the
 * device guard, with the same refusals and the same slip. Every assertion
 * hangs off that.
 *
 * The catch-weight arms of the device route (real `handling_units` from a
 * real receipt) live in `catch-weight.spec.ts`, which already owns the
 * receive → pick → pack fixtures.
 */

interface PickLine {
  id: string;
  picklistId: string;
  orderId: string;
  skuId: string;
  binId: string | null;
  qty: number;
  status: string;
}

describe('pack bench: device snapshot arms + device pack route (e2e, story 10.7)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let warehouseId: string;
  let zoneId: string;
  let binA: string;
  const skuIds = new Map<string, string>();

  let deviceToken: string; // the bare enrollment credential (no badge-in)
  let operatorToken: string; // the badge-in DEVICE session

  const SKU_CODES = ['BENCH-ALPHA', 'BENCH-BRAVO', 'BENCH-CHARLIE'] as const;

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('pack_bench');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Bench Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
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

    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: `BEN-${ulid().slice(10, 16).toUpperCase()}`, name: `Bench WH ${ulid()}` })
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
      ...SKU_CODES.map((code) => `${code},Bench SKU ${code},pcs,,1800,,false,false,,,`),
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

    // The floor device, its bare credential and its badge-in operator.
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Pack bench', pin: '2468' })
      .expect(201);
    deviceToken = enrolled.body.deviceToken as string;
    const operatorEmail = `bench-${ulid().toLowerCase()}@example.com`;
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
        'handling_units',
        'picks',
        'picklist_lines',
        'picklists',
        'waves',
        'wave_policies',
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
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta: quantity, reasonCode: 'cycle-count', note: 'bench seed' })
      .expect(201);
  }

  /**
   * Story 10.7's operator lacks `pack.execute` by design? No — an operator
   * carries it (the tenant route's own fixtures pack as `ops_manager`; the
   * DEVICE route's badge-in operator is the one the spec names the bench for).
   * This helper exists so the authority arm can demote explicitly.
   */
  async function createOrder(lines: { skuId: string; quantity: number }[]): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines })
      .expect(201);
    return res.body.order.id as string;
  }

  async function policyId(name: string): Promise<string> {
    return (
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/outbound/wave-policies`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId, name, grouping: 'single' })
          .expect(201)
      ).body.policy.id as string
    );
  }

  /** One released wave over one fresh order — the pick fixture in one call. */
  async function releasedWave(
    lines: { skuId: string; quantity: number }[],
    tag: string,
  ): Promise<{ waveId: string; orderId: string; picklist: { id: string; lines: PickLine[] } }> {
    const orderId = await createOrder(lines);
    const policy = await policyId(`${tag}-${ulid().slice(10, 18)}`);
    const generated = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy, orderIds: [orderId] })
      .expect(201);
    const waveId = generated.body.wave.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const wave = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body.wave as { picklists: { id: string; lines: PickLine[] }[] };
    const picklist = wave.picklists[0];
    if (picklist === undefined) throw new Error('fixture produced no picklist');
    return { waveId, orderId, picklist };
  }

  async function pick(line: PickLine): Promise<void> {
    await request(app.getHttpServer())
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
      })
      .expect(201);
  }

  /** A fully-picked, packable order of ONE line in ONE bin. */
  async function pickedOrder(
    code: string,
    quantity: number,
    tag: string,
  ): Promise<{ orderId: string; skuId: string; line: PickLine }> {
    const skuId = sku(code);
    await seedStock(skuId, binA, quantity + 10);
    const { orderId, picklist } = await releasedWave([{ skuId, quantity }], tag);
    const line = picklist.lines[0]!;
    await pick(line);
    return { orderId, skuId, line };
  }

  interface DevicePackBody {
    orderId: string;
    scanned: { skuId: string; qty: number; handlingUnitIds?: string[] }[];
    weightGrams?: number | null;
    /** Only sent by the review-W6 refusal test — the device payload has no dimensions arm. */
    dimensionsMm?: { lengthMm: number; widthMm: number; heightMm: number };
  }

  /** The story-10.7 device pack route, under the badge-in session. */
  function devicePack(body: DevicePackBody, token: string = operatorToken, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/packs`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  interface PackTaskWire {
    orderId: string;
    skuId: string;
    skuCode: string;
    pickedQty: number;
    catchWeightTracked: boolean;
  }

  async function snapshot(): Promise<{
    packTasks: PackTaskWire[];
    handlingUnits: { id: string; skuId: string }[];
  }> {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    return {
      packTasks: res.body.packTasks as PackTaskWire[],
      handlingUnits: res.body.handlingUnits as { id: string; skuId: string }[],
    };
  }

  /** Raw-seeds one active handling unit (the label the bench resolves). */
  async function seedHandlingUnit(skuId: string): Promise<string> {
    const id = uuidv7();
    await sql`
      insert into handling_units (id, tenant_id, warehouse_id, sku_id, grn_line_id, weight_grams, status)
      values (${id}, ${tenantId}, ${warehouseId}, ${skuId}, ${uuidv7()}, 18000, 'active')
    `;
    return id;
  }

  async function orderStatus(orderId: string): Promise<string> {
    const rows = await sql`select status from orders where id = ${orderId}`;
    return (rows[0] as unknown as { status: string }).status;
  }

  async function packEventCount(orderId: string): Promise<number> {
    const rows = (await sql`
      select count(*)::int as n from ledger_events
      where tenant_id = ${tenantId} and type = 'pack.packed'
        and reference_doc->>'orderId' = ${orderId}
    `) as unknown as { n: number }[];
    return rows[0]!.n;
  }

  // ── the snapshot's pack arm ────────────────────────────────────────────────

  it('the snapshot carries packTasks with the picked totals for a fully-picked order, and drops the order once it packs', async () => {
    const skuAlpha = sku('BENCH-ALPHA');
    const skuBravo = sku('BENCH-BRAVO');
    await seedStock(skuAlpha, binA, 12);
    await seedStock(skuBravo, binA, 12);
    const { waveId, orderId, picklist } = await releasedWave(
      [
        { skuId: skuAlpha, quantity: 3 },
        { skuId: skuBravo, quantity: 5 },
      ],
      'bench-snap',
    );

    // While a line is still planned the order is NOT packable work.
    let tasks = (await snapshot()).packTasks.filter((task) => task.orderId === orderId);
    expect(tasks).toHaveLength(0);

    // Pick every line — the order becomes bench work with exact totals.
    for (const line of picklist.lines) {
      if (line.binId !== null) await pick(line);
    }
    tasks = (await snapshot()).packTasks.filter((task) => task.orderId === orderId);
    expect(tasks).toHaveLength(2);
    const alpha = tasks.find((task) => task.skuId === skuAlpha)!;
    const bravo = tasks.find((task) => task.skuId === skuBravo)!;
    expect(alpha.pickedQty).toBe(3);
    expect(alpha.catchWeightTracked).toBe(false);
    expect(alpha.skuCode).toBe('BENCH-ALPHA');
    expect(bravo.pickedQty).toBe(5);

    // Pack it through the DEVICE route — the order and its totals drop out.
    await devicePack({
      orderId,
      scanned: [
        { skuId: skuAlpha, qty: 3 },
        { skuId: skuBravo, qty: 5 },
      ],
      weightGrams: 4200,
    }).expect(201);
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
    expect((await snapshot()).packTasks.some((task) => task.orderId === orderId)).toBe(false);

    // The wave itself no longer holds the order — nothing re-picks it.
    const wave = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body.wave as { status: string };
    expect(wave.status).toBe('released');
  });

  it('an order whose whole plan was withdrawn by a wave cancel is NOT packable work — and an unwaved order never was', async () => {
    const skuCharlie = sku('BENCH-CHARLIE');
    await seedStock(skuCharlie, binA, 8);
    const { waveId, orderId, picklist } = await releasedWave([{ skuId: skuCharlie, quantity: 2 }], 'bench-cxl');
    // Cancel BEFORE any pick: every line flips cancelled, the order stays accepted.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    expect(picklist.lines.length).toBeGreaterThan(0);
    // And an accepted order that never touched a wave at all:
    await createOrder([{ skuId: skuCharlie, quantity: 1 }]);
    const tasks = (await snapshot()).packTasks;
    expect(tasks.some((task) => task.orderId === orderId)).toBe(false);
  });

  it('the snapshot carries the warehouse\'s ACTIVE handling units (id + skuId), raw-seeded', async () => {
    const skuAlpha = sku('BENCH-ALPHA');
    const first = await seedHandlingUnit(skuAlpha);
    const second = await seedHandlingUnit(skuAlpha);
    const units = (await snapshot()).handlingUnits;
    const mine = units.filter((unit) => unit.id === first || unit.id === second);
    expect(mine).toHaveLength(2);
    expect(mine.every((unit) => unit.skuId === skuAlpha)).toBe(true);
    // Flip one to `packed` (the pack command's own write, imitated at the
    // table here so the suite does not owe a full CW receipt) — it drops out.
    await sql`update handling_units set status = 'packed' where id = ${first} and tenant_id = ${tenantId}`;
    const after = (await snapshot()).handlingUnits;
    expect(after.some((unit) => unit.id === first)).toBe(false);
    expect(after.some((unit) => unit.id === second)).toBe(true);
  });

  // ── the device pack route ──────────────────────────────────────────────────

  it('the device route packs a fully-picked order: slip, flip, ledger events, and a replay re-serves the slip', async () => {
    const { orderId, skuId, line } = await pickedOrder('BENCH-ALPHA', 4, 'bench-device');
    // The scanned content must be verified against the PICKED total first —
    // confirm the snapshot named it, then pack it.
    const tasks = (await snapshot()).packTasks.filter((task) => task.orderId === orderId);
    expect(tasks).toEqual([
      expect.objectContaining({ orderId, skuId, pickedQty: 4, skuCode: 'BENCH-ALPHA' }),
    ]);

    const key = ulid();
    const body: DevicePackBody = {
      orderId,
      scanned: [{ skuId: line.skuId, qty: 4 }],
      weightGrams: 1200,
    };
    const first = await devicePack(body, operatorToken, key).expect(201);
    expect(first.body.pack.orderStatus).toBe('ready_to_dispatch');
    expect(first.body.pack.packedBy).toBeTruthy();
    expect(first.body.pack.lines).toHaveLength(1);
    expect(first.body.pack.lines[0].packedQty).toBe(4);
    expect(first.body.pack.totalUnits).toBe(4);
    expect(first.body.pack.weightGrams).toBe(1200);
    expect(first.body.pack.dimensionsMm).toBeNull();
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
    expect(await packEventCount(orderId)).toBe(1);

    // A replay under the SAME key re-serves the stored slip — nothing re-packs.
    const replayed = await devicePack(body, operatorToken, key).expect(201);
    expect(replayed.body.pack).toEqual(first.body.pack);
    expect(await packEventCount(orderId)).toBe(1);

    // A SECOND pack under a NEW key is a 409 — an order packs once.
    await devicePack(body, operatorToken, ulid()).expect(409);
  });

  it('the device route refuses a scan that does not match what was picked (422, naming both quantities) and writes nothing', async () => {
    const { orderId, skuId, line } = await pickedOrder('BENCH-CHARLIE', 3, 'bench-mismatch');
    const before = await orderStatus(orderId);
    const res = await devicePack({
      orderId,
      scanned: [{ skuId: line.skuId, qty: 2 }],
    }).expect(422);
    expect(res.body.code).toBe('pack-mismatch');
    expect(res.body.detail).toContain(`SKU BENCH-CHARLIE (${skuId}): picked 3, scanned 2`);
    expect(await orderStatus(orderId)).toBe(before);
    expect(await packEventCount(orderId)).toBe(0);
  });

  it('the device route refuses a still-planned order (409) and the bare enrollment credential (401 — badge-in first)', async () => {
    const skuBravo = sku('BENCH-BRAVO');
    await seedStock(skuBravo, binA, 8);
    const { orderId, picklist } = await releasedWave([{ skuId: skuBravo, quantity: 2 }], 'bench-planned');
    const planned = picklist.lines[0]!;
    // A planned line and no picks at all — the completeness guard's answer.
    await devicePack({
      orderId,
      scanned: [{ skuId: planned.skuId, qty: 2 }],
    }).expect(409);

    const bare = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/packs`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .set(KEY_HEADER, ulid())
      .send({ orderId, scanned: [{ skuId: planned.skuId, qty: 2 }] })
      .expect(401);
    expect(bare.body.code).toBe('unauthenticated');

    // Nothing was consumed by the refusals — and the order was never bench
    // work in the first place: its pick line is still planned, so the
    // packable predicate does not list it (review W14 — the old comment
    // contradicted the assertion under it).
    const tasks = (await snapshot()).packTasks.filter((task) => task.orderId === orderId);
    expect(tasks).toHaveLength(0);
  });

  // ── the route's authority arms (review W11) ────────────────────────────────

  /** A second tenant's badge-in operator — the foreign-tenant arm's token. */
  async function secondTenantOperator(): Promise<string> {
    const email = `other-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Other Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    createdTenantIds.push(registered.body.tenant.id as string);
    const otherTenantId = registered.body.tenant.id as string;
    const otherToken = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email, password: 'correct-horse-battery' })
      .expect(200)
      .then((res) => res.body.accessToken as string);
    const minted = await request(app.getHttpServer())
      .post(`${API}/${otherTenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${otherToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${otherTenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Other tenant device', pin: '1357' })
      .expect(201);
    const operatorEmail = `other-op-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${otherTenantId}/users`)
      .set('Authorization', `Bearer ${otherToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: operatorEmail, role: 'operator' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${otherTenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const badged = await request(app.getHttpServer())
      .post(`${API}/${otherTenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail, pin: '1357' })
      .expect(200);
    return badged.body.accessToken as string;
  }

  it('the device route is authority-gated: the key is required and must parse, a foreign tenant is 403', async () => {
    const { orderId, line } = await pickedOrder('BENCH-BRAVO', 2, 'bench-authority');
    const body: DevicePackBody = { orderId, scanned: [{ skuId: line.skuId, qty: 2 }] };

    // No Idempotency-Key at all → 400, before any command logic runs.
    const missing = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/packs`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send(body)
      .expect(400);
    expect(missing.body.code).toBe('idempotency-key-required');

    // A value that is not a ULID → 400, same gate.
    const malformed = await devicePack(body, operatorToken, 'not-a-ulid').expect(400);
    expect(malformed.body.code).toBe('idempotency-key-invalid');

    // A valid badge-in session of ANOTHER tenant → 403 permission-denied,
    // and nothing is written (the order is still packable work afterwards).
    const foreignToken = await secondTenantOperator();
    const denied = await devicePack(body, foreignToken).expect(403);
    expect(denied.body.code).toBe('permission-denied');
    expect((await snapshot()).packTasks.some((task) => task.orderId === orderId)).toBe(true);

    // The order packs fine under its own tenant — the refusals never touched it.
    await devicePack(body).expect(201);
  });

  it('the device route normalizes an explicit weightGrams null to the unmeasured parcel, and no longer accepts dimensionsMm', async () => {
    const { orderId, line } = await pickedOrder('BENCH-CHARLIE', 2, 'bench-normalize');
    const packed = await devicePack({
      orderId,
      scanned: [{ skuId: line.skuId, qty: 2 }],
      // An explicit null is the same UNMEASURED parcel as an absent field —
      // the controller normalizes it away so both spellings hash identically.
      weightGrams: null,
    }).expect(201);
    expect(packed.body.pack.weightGrams).toBeNull();
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');

    // The device payload has NO dimensions arm (review W6): the DTO omits it,
    // so with the whitelist pipe a body that sends it is refused outright.
    await devicePack({
      orderId: uuidv7(),
      scanned: [{ skuId: line.skuId, qty: 2 }],
      dimensionsMm: { lengthMm: 100, widthMm: 100, heightMm: 100 },
    }).expect(400);
  });
});
