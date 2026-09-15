import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ORDER_STATUSES } from '../src/modules/outbound/order.command';
import { CAPABILITIES, ROLE_CAPABILITIES } from '../src/modules/tenancy/permissions';
import { getLedgerEventType } from '../src/modules/inventory/ledger-registry';
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

interface PackBody {
  scanned: { skuId: string; qty: number }[];
  weightGrams?: number | null;
  dimensionsMm?: { lengthMm: number; widthMm: number; heightMm: number } | null;
}

describe('packing: pack-station verification (e2e, story 4.5)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let accountantToken: string;
  /** A WEB session for an operator — the pack bench rides the tenant guard. */
  let operatorWebToken: string;
  let warehouseId: string;
  let zoneId: string;
  let binA: string; // A-01-01
  let binB: string; // A-01-02
  const skuIds = new Map<string, string>();

  let deviceToken: string;
  let operatorToken: string; // the badge-in DEVICE session (picking)

  /** SKU fixtures — one scenario each, so no two packs share stock. */
  const SKU_CODES = [
    'PAK-OK', // the happy path + the replay + the already-packed arm
    'PAK-DIMS', // the optional weight/dimensions
    'PAK-EXTRA', // a scan carrying a SKU the order never picked
    'PAK-NOISE', // …the extra SKU itself (never ordered)
    'PAK-MISSING', // a scan missing a picked SKU, and a wrong quantity
    'PAK-SHORT', // a short-picked order — verification is against PICKED
    'PAK-PLANNED', // a line still planned — the completeness refusal
    'PAK-UNWAVED', // never waved at all
    'PAK-CXLORDER', // a cancelled order
    'PAK-SPLIT', // one order line across TWO bins — two picks rows, one line
    'PAK-ZERO', // a ZERO-unit short pick — settled, but no picks row at all
    'PAK-AUTH', // the authority arms
    'PAK-REWAVE', // a packed order must not be re-waved
    'PAK-REPICK', // …and must not accept a queued pick
    'PAK-CANCEL', // …and must not silently cancel
    'PAK-CHAIN', // the zero-quantity event and the ledger's own invariants
    'PAK-WCXL', // review loop 1: a wave cancelled before any pick
    'PAK-MIXA', // …and the MIXED order that must stay packable (picked line)
    'PAK-MIXB', // …its sibling line, withdrawn by the same wave cancel
    'PAK-HOLD', // review loop 1: the short pick's orphaned remainder hold
    'PAK-KEYS', // review loop 1: replay with reordered dimension keys
  ] as const;

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('packing');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Pack Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
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
        .send({ code: `PAK-${ulid().slice(10, 16).toUpperCase()}`, name: `Pack WH ${ulid()}` })
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
    binB = await createBin('A-01-02');

    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      ...SKU_CODES.map((code) => `${code},Pack SKU ${code},pcs,,1800,,false,false,,,`),
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

    // The floor device + its badge-in operator (picking feeds every fixture).
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Pack bench scanner', pin: '2468' })
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
      for (const table of ['picks', 'picklist_lines', 'picklists', 'waves', 'wave_policies', 'order_lines', 'orders']) {
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
        note: 'packing-suite seed',
      })
      .expect(201);
  }

  async function createOrder(lines: { skuId: string; quantity: number }[]): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines })
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

  function packOrder(
    orderId: string,
    body: PackBody,
    token = operatorWebToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
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
    await pick(line).expect(201);
    return { orderId, skuId, line };
  }

  function cancelWave(waveId: string): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({});
  }

  async function atp(skuId: string): Promise<{ onHand: number; reserved: number; atp: number }> {
    return app.get(InventoryFacade).atp(tenantId, warehouseId, skuId);
  }

  /** Every journal hold owned by one order's LINES — id-free, like the command's read. */
  async function holdsOfOrder(
    orderId: string,
  ): Promise<{ id: string; state: string; quantity: number }[]> {
    return (await sql`
      select r.id, r.state, r.quantity from reservations r
      where r.tenant_id = ${tenantId}
        and r.owner_type = 'order'
        and r.owner_id in (
          select ol.id::text from order_lines ol
          where ol.tenant_id = ${tenantId} and ol.order_id = ${orderId}
        )
      order by r.id
    `) as unknown as { id: string; state: string; quantity: number }[];
  }

  async function orderStatus(orderId: string): Promise<string> {
    const rows = await sql`select status from orders where id = ${orderId}`;
    return (rows[0] as unknown as { status: string }).status;
  }

  async function packEvents(orderId: string): Promise<
    {
      sku_id: string;
      quantity_delta: number;
      from_bin_id: string | null;
      to_bin_id: string | null;
      batch_ref: string | null;
      serial_ref: string | null;
      reference_doc: Record<string, unknown>;
    }[]
  > {
    return (await sql`
      select sku_id, quantity_delta, from_bin_id, to_bin_id, batch_ref, serial_ref, reference_doc
      from ledger_events
      where tenant_id = ${tenantId} and type = 'pack.packed'
        and reference_doc->>'orderId' = ${orderId}
      order by seq
    `) as unknown as {
      sku_id: string;
      quantity_delta: number;
      from_bin_id: string | null;
      to_bin_id: string | null;
      batch_ref: string | null;
      serial_ref: string | null;
      reference_doc: Record<string, unknown>;
    }[];
  }

  async function onHand(skuId: string, binId: string): Promise<number> {
    const rows = await sql`
      select quantity from stock_on_hand
      where tenant_id = ${tenantId} and sku_id = ${skuId} and bin_id = ${binId}
    `;
    return (rows[0] as unknown as { quantity: number } | undefined)?.quantity ?? 0;
  }

  // ── the grammar, the constants and the capability ─────────────────────────

  it('the order arm, the ledger grammar and the capability are registered (the drift guards)', async () => {
    expect([...ORDER_STATUSES]).toEqual([
      'accepted',
      'ready_to_dispatch',
      'dispatched',
      'cancelled',
    ]);

    // The DB CHECK is the additive backstop to the TS constant (0023).
    const defs = await sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'orders_status_check'
    `;
    const def = (defs[0] as unknown as { def: string }).def;
    const arms = [...def.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!).sort();
    expect(arms).toEqual([...ORDER_STATUSES].sort());

    // The pack event type: registered, `pack`-referenced, and both identity
    // arms CLOSED — a pack verifies base units, it re-counts no batch or
    // serial, so the registry must refuse one.
    const definition = getLedgerEventType('pack.packed');
    expect(definition).toBeDefined();
    expect(definition!.referenceKinds).toEqual(['pack']);
    expect(definition!.allowsBatchArm).toBe(false);
    expect(definition!.allowsSerialArm).toBe(false);

    expect((CAPABILITIES as readonly string[]).includes('pack.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.owner.has('pack.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.ops_manager.has('pack.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.operator.has('pack.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.accountant.has('pack.execute')).toBe(false);
  });

  // ── the happy path ────────────────────────────────────────────────────────

  it('a matching scan packs the order: one zero-quantity event per line, the flip, the outbox, the audit and the slip — from ONE transaction', async () => {
    const { orderId, skuId } = await pickedOrder('PAK-OK', 7, 'ok');
    const before = await onHand(skuId, binA);

    const res = await packOrder(orderId, { scanned: [{ skuId, qty: 7 }] }).expect(201);
    const pack = res.body.pack as Record<string, unknown>;
    expect(pack.orderId).toBe(orderId);
    expect(pack.orderStatus).toBe('ready_to_dispatch');
    expect(pack.totalUnits).toBe(7);
    expect(pack.weightGrams).toBeNull();
    expect(pack.dimensionsMm).toBeNull();
    const lines = pack.lines as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.skuId).toBe(skuId);
    expect(lines[0]!.skuCode).toBe('PAK-OK');
    expect(lines[0]!.skuName).toBe('Pack SKU PAK-OK');
    expect(lines[0]!.orderedQty).toBe(7);
    expect(lines[0]!.packedQty).toBe(7);
    expect(lines[0]!.shortfallQty).toBe(0);
    expect(typeof lines[0]!.ledgerEventId).toBe('string');

    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');

    // The ledger: ONE zero-quantity event per ORDER LINE, both bin arms null.
    const events = await packEvents(orderId);
    expect(events).toHaveLength(1);
    expect(events[0]!.sku_id).toBe(skuId);
    expect(events[0]!.quantity_delta).toBe(0);
    expect(events[0]!.from_bin_id).toBeNull();
    expect(events[0]!.to_bin_id).toBeNull();
    expect(events[0]!.batch_ref).toBeNull();
    expect(events[0]!.serial_ref).toBeNull();
    expect(events[0]!.reference_doc).toMatchObject({
      kind: 'pack',
      orderId,
      orderLineId: lines[0]!.orderLineId,
      packedQty: 7,
    });
    // An unmeasured parcel carries NEITHER optional key (the canonical bytes
    // of a pack with no measurements must not gain null placeholders).
    expect(events[0]!.reference_doc.weightGrams).toBeUndefined();
    expect(events[0]!.reference_doc.lengthMm).toBeUndefined();

    // A zero-quantity, both-arms-null event folds NOTHING: the pick already
    // drew these units out of stock.
    expect(await onHand(skuId, binA)).toBe(before);

    const outbox = await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'order.packed'
    `;
    expect(
      outbox.some(
        (row) =>
          ((row as unknown as { payload: { pack: { orderId: string } } }).payload.pack.orderId) ===
          orderId,
      ),
    ).toBe(true);
    const audit = await sql`
      select action from audit_events
      where tenant_id = ${tenantId} and target_id = ${orderId} and action = 'order.packed'
    `;
    expect(audit).toHaveLength(1);
  });

  it('replays under the same key and refuses a SECOND pack under a new one', async () => {
    const { orderId, skuId } = await pickedOrder('PAK-DIMS', 4, 'dims');
    const key = ulid();
    const body: PackBody = {
      scanned: [{ skuId, qty: 4 }],
      weightGrams: 2500,
      dimensionsMm: { lengthMm: 300, widthMm: 200, heightMm: 150 },
    };
    const first = await packOrder(orderId, body, operatorWebToken, key).expect(201);
    expect(first.body.pack.weightGrams).toBe(2500);
    expect(first.body.pack.dimensionsMm).toEqual({ lengthMm: 300, widthMm: 200, heightMm: 150 });

    // The measurements ride the reference doc — there is nowhere else durable.
    const events = await packEvents(orderId);
    expect(events[0]!.reference_doc).toMatchObject({
      weightGrams: 2500,
      lengthMm: 300,
      widthMm: 200,
      heightMm: 150,
    });

    // Same key, same payload: the stored slip, byte for byte, no second pack.
    const replay = await packOrder(orderId, body, operatorWebToken, key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(await packEvents(orderId)).toHaveLength(1);

    // A NEW key against an order that already reached Ready-to-Dispatch: 409.
    const second = await packOrder(orderId, body).expect(409);
    expect(second.body.code).toBe('conflict');
    expect(second.body.detail).toContain('ready_to_dispatch');
    // The ALREADY-PACKED arm specifically, not the generic not-accepted one
    // beneath it: it is the arm that tells the caller a slip already exists
    // and how to get it back, which is the only actionable answer here.
    // (The wire `title` carries the detail — the ProblemDetailsFilter renders
    // `exception.message` into it — so the arm is pinned by its detail text.)
    expect(second.body.detail).toContain('reaches Ready-to-Dispatch once');
    expect(await packEvents(orderId)).toHaveLength(1);

    // Same key, DIFFERENT payload: the deterministic reuse 422.
    const reused = await packOrder(
      orderId,
      { ...body, weightGrams: 2600 },
      operatorWebToken,
      key,
    ).expect(422);
    expect(reused.body.code).toBe('idempotency-key-reuse');
  });

  it('refuses a non-positive weight or dimension without touching the order', async () => {
    const { orderId, skuId } = await pickedOrder('PAK-CHAIN', 3, 'chain');
    for (const body of [
      { scanned: [{ skuId, qty: 3 }], weightGrams: 0 },
      { scanned: [{ skuId, qty: 3 }], weightGrams: -5 },
      { scanned: [{ skuId, qty: 3 }], dimensionsMm: { lengthMm: 10, widthMm: 0, heightMm: 10 } },
    ] as PackBody[]) {
      const res = await packOrder(orderId, body).expect(400);
      expect(res.body.code).toBe('validation-failed');
    }
    // The per-LINE cap is not the whole bound: duplicate lines AGGREGATE, and
    // 500 of them naming one SKU would sail past int4 and die as a raw 22003
    // at the comparison against `picks`. The aggregate carries the same cap.
    const overflow = await packOrder(orderId, {
      scanned: [
        { skuId, qty: 2_000_000_000 },
        { skuId, qty: 2_000_000_000 },
      ],
    }).expect(400);
    expect(overflow.body.code).toBe('validation-failed');
    expect(overflow.body.detail).toContain('across every line naming it');

    expect(await orderStatus(orderId)).toBe('accepted');
    expect(await packEvents(orderId)).toHaveLength(0);

    // …and the pack that DOES land leaves the hash chain and the replay
    // intact: a zero-magnitude event with no bin arm folds no projection and
    // must not make the ledger's own invariants disagree with it.
    await packOrder(orderId, { scanned: [{ skuId, qty: 3 }] }).expect(201);
    const inventory = app.get(InventoryFacade);
    const chain = await inventory.verifyChain(tenantId, warehouseId);
    expect(chain.ok).toBe(true);
    const replay = await inventory.replay(tenantId, warehouseId);
    expect(replay.matches).toBe(true);
    expect(replay.divergences).toEqual([]);
  });

  // ── the refusals ──────────────────────────────────────────────────────────

  it('refuses a scan that differs from what was picked — naming the SKU and BOTH quantities — and writes nothing', async () => {
    const { orderId, skuId } = await pickedOrder('PAK-MISSING', 6, 'missing');
    const noiseSkuId = sku('PAK-NOISE');

    // A wrong quantity.
    const wrongQty = await packOrder(orderId, { scanned: [{ skuId, qty: 5 }] }).expect(422);
    expect(wrongQty.body.code).toBe('pack-mismatch');
    expect(wrongQty.body.detail).toContain('PAK-MISSING');
    expect(wrongQty.body.detail).toContain('picked 6');
    expect(wrongQty.body.detail).toContain('scanned 5');

    // A MISSING sku (scanned nothing at all).
    const missing = await packOrder(orderId, { scanned: [] }).expect(422);
    expect(missing.body.detail).toContain('picked 6, scanned 0');

    // An EXTRA sku the order never picked.
    const extra = await packOrder(orderId, {
      scanned: [
        { skuId, qty: 6 },
        { skuId: noiseSkuId, qty: 1 },
      ],
    }).expect(422);
    expect(extra.body.detail).toContain('PAK-NOISE');
    expect(extra.body.detail).toContain('picked 0, scanned 1');

    // Nothing was written by ANY of them — not the flip, not an event, and
    // not the idempotency key: the corrected scan under the SAME key that
    // was just refused succeeds.
    expect(await orderStatus(orderId)).toBe('accepted');
    expect(await packEvents(orderId)).toHaveLength(0);
    const key = ulid();
    await packOrder(orderId, { scanned: [{ skuId, qty: 4 }] }, operatorWebToken, key).expect(422);
    await packOrder(orderId, { scanned: [{ skuId, qty: 6 }] }, operatorWebToken, key).expect(201);
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
  });

  it('refuses an order with a line still planned, naming that line', async () => {
    const skuId = sku('PAK-PLANNED');
    await seedStock(skuId, binA, 20);
    const { orderId, picklist } = await releasedWave([{ skuId, quantity: 9 }], 'planned');
    const line = picklist.lines[0]!;
    expect(line.status).toBe('planned');

    const res = await packOrder(orderId, { scanned: [{ skuId, qty: 9 }] }).expect(409);
    expect(res.body.code).toBe('conflict');
    expect(res.body.detail).toContain(line.id);
    expect(await orderStatus(orderId)).toBe('accepted');
    expect(await packEvents(orderId)).toHaveLength(0);

    // Pick it and the very same scan lands.
    await pick(line).expect(201);
    await packOrder(orderId, { scanned: [{ skuId, qty: 9 }] }).expect(201);
  });

  it('refuses an order that was never waved — an unwaved order has not been picked', async () => {
    const skuId = sku('PAK-UNWAVED');
    await seedStock(skuId, binA, 20);
    const orderId = await createOrder([{ skuId, quantity: 2 }]);
    const res = await packOrder(orderId, { scanned: [{ skuId, qty: 2 }] }).expect(409);
    expect(res.body.code).toBe('conflict');
    expect(res.body.detail).toContain('on no picklist');
    expect(await orderStatus(orderId)).toBe('accepted');
    expect(await packEvents(orderId)).toHaveLength(0);
  });

  it('refuses an order whose plan was wholly withdrawn by a wave cancel — and it stays re-wavable', async () => {
    // The wedge review loop 1 found. `cancelWave` flips every non-drawing
    // line to `cancelled` and deliberately leaves the order `accepted` and
    // re-wavable. Without the floor clause this order has rows, none
    // `planned`, and no `picks` row — so an empty scan verified clean and it
    // flipped to `ready_to_dispatch` holding nothing, after which cancel
    // refuses it and both wave paths exclude it: unrecoverable.
    const skuId = sku('PAK-WCXL');
    await seedStock(skuId, binA, 20);
    const { orderId, waveId } = await releasedWave([{ skuId, quantity: 3 }], 'wcxl');
    await cancelWave(waveId).expect(200);
    const statuses = await sql`
      select status from picklist_lines where tenant_id = ${tenantId} and order_id = ${orderId}
    `;
    expect(statuses.map((row) => (row as unknown as { status: string }).status)).toEqual([
      'cancelled',
    ]);

    const res = await packOrder(orderId, { scanned: [] }).expect(409);
    expect(res.body.code).toBe('conflict');
    expect(res.body.detail).toContain('withdrawn');
    expect(await orderStatus(orderId)).toBe('accepted');
    expect(await packEvents(orderId)).toHaveLength(0);

    // …and the refusal keeps the order RECOVERABLE, which is the whole point:
    // it waves again, picks, and packs.
    const policy = await policyId(`wcxl2-${ulid().slice(10, 18)}`);
    const generated = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy, orderIds: [orderId] })
      .expect(201);
    const reWaveId = generated.body.wave.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${reWaveId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const reWave = await getWave(reWaveId);
    await pick(reWave.picklists[0]!.lines[0]!).expect(201);
    await packOrder(orderId, { scanned: [{ skuId, qty: 3 }] }).expect(201);
  });

  it('a MIXED order — one line picked, one withdrawn by the same wave cancel — still packs', async () => {
    // The floor clause refuses only a WHOLLY withdrawn plan. `cancelled` is
    // not dropped from the settled set generally: no path un-cancels a line,
    // so excluding it there would strand this order forever.
    const pickedSkuId = sku('PAK-MIXA');
    const withdrawnSkuId = sku('PAK-MIXB');
    await seedStock(pickedSkuId, binA, 20);
    await seedStock(withdrawnSkuId, binB, 20);
    const { orderId, waveId, picklist } = await releasedWave(
      [
        { skuId: pickedSkuId, quantity: 2 },
        { skuId: withdrawnSkuId, quantity: 4 },
      ],
      'mixed',
    );
    const pickedLine = picklist.lines.find((line) => line.skuId === pickedSkuId)!;
    await pick(pickedLine).expect(201);
    // The drawn line keeps its claim; the untouched one is withdrawn.
    await cancelWave(waveId).expect(200);
    const rows = await sql`
      select status from picklist_lines
      where tenant_id = ${tenantId} and order_id = ${orderId} order by sku_id
    `;
    const settled = rows.map((row) => (row as unknown as { status: string }).status).sort();
    expect(settled).toEqual(['cancelled', 'picked']);

    // Only the picked line's units are on the bench.
    const res = await packOrder(orderId, { scanned: [{ skuId: pickedSkuId, qty: 2 }] }).expect(201);
    expect(res.body.pack.totalUnits).toBe(2);
    expect(res.body.pack.lines).toHaveLength(2);
    const withdrawn = (res.body.pack.lines as Record<string, unknown>[]).find(
      (line) => line.skuId === withdrawnSkuId,
    )!;
    expect(withdrawn.packedQty).toBe(0);
    expect(withdrawn.shortfallQty).toBe(4);
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
  });

  it('releases the dead holds a packed order can no longer reach, and ATP recovers', async () => {
    // Story 4.4 releases a short-picked line's whole hold and re-grants the
    // REMAINDER. With the SKU in exactly one bin there is nowhere to re-plan
    // onto, so that fresh hold is referenced by no `order_lines` and no
    // `picklist_lines` column — its only link back is `owner_id`. 4.5 is what
    // makes it unreachable (cancel now refuses a packed order), so the pack
    // is where it must be released.
    const skuId = sku('PAK-HOLD');
    await seedStock(skuId, binA, 20);
    const { orderId, picklist } = await releasedWave([{ skuId, quantity: 5 }], 'hold');
    await pick(picklist.lines[0]!, { qty: 3, reasonCode: 'fewer-units-than-planned' }).expect(201);

    // The leak, before the pack: a live hold for the 2 units that never
    // shipped, counted against ATP and reachable by no order column.
    const before = await holdsOfOrder(orderId);
    const live = before.filter((hold) => hold.state === 'held');
    expect(live).toHaveLength(1);
    expect(live[0]!.quantity).toBe(2);
    const atpBefore = await atp(skuId);
    expect(atpBefore.reserved).toBe(2);

    await packOrder(orderId, { scanned: [{ skuId, qty: 3 }] }).expect(201);

    // The journal half…
    const after = await holdsOfOrder(orderId);
    expect(after.filter((hold) => hold.state === 'held')).toHaveLength(0);
    expect(after.find((hold) => hold.id === live[0]!.id)!.state).toBe('released');
    // …and the Valkey mirror, applied after the commit.
    const atpAfter = await atp(skuId);
    expect(atpAfter.reserved).toBe(0);
    expect(atpAfter.atp).toBe(atpBefore.atp + 2);
  });

  it('refuses a cancelled order', async () => {
    const skuId = sku('PAK-CXLORDER');
    await seedStock(skuId, binA, 20);
    const orderId = await createOrder([{ skuId, quantity: 2 }]);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const res = await packOrder(orderId, { scanned: [{ skuId, qty: 2 }] }).expect(409);
    expect(res.body.detail).toContain('cancelled');
    expect(await packEvents(orderId)).toHaveLength(0);
  });

  it('refuses a foreign order id (404) and a caller without pack.execute (403)', async () => {
    const { orderId, skuId } = await pickedOrder('PAK-AUTH', 2, 'auth');
    const denied = await packOrder(
      orderId,
      { scanned: [{ skuId, qty: 2 }] },
      accountantToken,
    ).expect(403);
    expect(denied.body.code).toBe('role-denied');
    expect(denied.body.detail).toContain('pack.execute');

    await packOrder(
      '00000000-0000-7000-8000-00000000dead',
      { scanned: [{ skuId, qty: 2 }] },
    ).expect(404);

    // A foreign tenant's session never reaches the command.
    const foreignEmail = `foreign-${ulid().toLowerCase()}@example.com`;
    const foreign = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Foreign Co ${ulid()}`, ownerEmail: foreignEmail, password: 'correct-horse-battery' })
      .expect(201);
    createdTenantIds.push(foreign.body.tenant.id as string);
    const foreignToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: foreignEmail, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    const crossed = await packOrder(
      orderId,
      { scanned: [{ skuId, qty: 2 }] },
      foreignToken,
    ).expect(403);
    expect(crossed.body.code).toBe('permission-denied');
    expect(await orderStatus(orderId)).toBe('accepted');
  });

  // ── completeness is LINE-STATUS based, never `picks`-based ────────────────

  it('packs a SHORT-picked order against what was picked, not what was ordered', async () => {
    const skuId = sku('PAK-SHORT');
    await seedStock(skuId, binA, 20);
    const { orderId, picklist } = await releasedWave([{ skuId, quantity: 5 }], 'short');
    const line = picklist.lines[0]!;
    await pick(line, { qty: 3, reasonCode: 'fewer-units-than-planned' }).expect(201);

    // Only the short line settled — a re-plan would leave a PLANNED slice, so
    // the fixture's SKU lives in exactly one bin (nothing to re-plan onto).
    const slices = await sql`
      select status from picklist_lines where tenant_id = ${tenantId} and order_id = ${orderId}
    `;
    expect(slices.map((row) => (row as unknown as { status: string }).status)).toEqual(['short']);

    // Verifying against ORDERED (5) would refuse this; against PICKED (3) it
    // lands — which is the whole reason story 4.4's short pick is usable.
    await packOrder(orderId, { scanned: [{ skuId, qty: 5 }] }).expect(422);
    const res = await packOrder(orderId, { scanned: [{ skuId, qty: 3 }] }).expect(201);
    expect(res.body.pack.totalUnits).toBe(3);
    expect(res.body.pack.lines[0].orderedQty).toBe(5);
    expect(res.body.pack.lines[0].packedQty).toBe(3);
    expect(res.body.pack.lines[0].shortfallQty).toBe(2);
    expect((await packEvents(orderId))[0]!.reference_doc.packedQty).toBe(3);
  });

  it('packs a ZERO-unit short pick, which writes NO picks row at all (the picks-based predicate would refuse it)', async () => {
    const skuId = sku('PAK-ZERO');
    await seedStock(skuId, binA, 20);
    const { orderId, picklist } = await releasedWave([{ skuId, quantity: 4 }], 'zero');
    const line = picklist.lines[0]!;
    await pick(line, { qty: 0, reasonCode: 'bin-empty' }).expect(201);

    // The evidence the predicate cannot be `picks`-based: the order has ONE
    // settled pick line and ZERO pick rows. "as many picks as lines" would
    // read this packable order as still outstanding forever.
    const pickRows = await sql`
      select id from picks where tenant_id = ${tenantId} and order_id = ${orderId}
    `;
    expect(pickRows).toHaveLength(0);
    const lineRows = await sql`
      select status from picklist_lines where tenant_id = ${tenantId} and order_id = ${orderId}
    `;
    expect(lineRows.map((row) => (row as unknown as { status: string }).status)).toEqual(['short']);

    // Nothing was picked, so the parcel is empty and an empty scan matches.
    await packOrder(orderId, { scanned: [{ skuId, qty: 1 }] }).expect(422);
    const res = await packOrder(orderId, { scanned: [] }).expect(201);
    expect(res.body.pack.totalUnits).toBe(0);
    expect(res.body.pack.lines[0].packedQty).toBe(0);
    expect(res.body.pack.lines[0].shortfallQty).toBe(4);
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
  });

  it('sums a multi-slice order line: two picks rows, one line, one pack event', async () => {
    const skuId = sku('PAK-SPLIT');
    // Neither bin covers the order alone — the planner splits the line.
    await seedStock(skuId, binA, 5);
    await seedStock(skuId, binB, 5);
    const { orderId, picklist } = await releasedWave([{ skuId, quantity: 8 }], 'split');
    expect(picklist.lines).toHaveLength(2);
    for (const line of picklist.lines) {
      await pick(line).expect(201);
    }
    const pickRows = await sql`
      select qty from picks where tenant_id = ${tenantId} and order_id = ${orderId}
    `;
    expect(pickRows).toHaveLength(2);

    // 8 units across two slices verify as ONE SKU total against ONE order
    // line — and one pack event, because events are per ORDER LINE.
    await packOrder(orderId, { scanned: [{ skuId, qty: 5 }] }).expect(422);
    const res = await packOrder(orderId, {
      // Two scan lines of the same SKU sum, exactly as the bench counts.
      scanned: [
        { skuId, qty: 5 },
        { skuId, qty: 3 },
      ],
    }).expect(201);
    expect(res.body.pack.lines).toHaveLength(1);
    expect(res.body.pack.lines[0].packedQty).toBe(8);
    const events = await packEvents(orderId);
    expect(events).toHaveLength(1);
    expect(events[0]!.reference_doc.packedQty).toBe(8);
  });

  // ── the `accepted` guards, audited (AC 4) ────────────────────────────────

  it('a packed order is excluded from wave generation — both selection paths', async () => {
    const { orderId, skuId } = await pickedOrder('PAK-REWAVE', 3, 'rewave');
    await packOrder(orderId, { scanned: [{ skuId, qty: 3 }] }).expect(201);

    // The EXPLICIT selection path names the status and refuses before it
    // reaches the open-claim check.
    const policy = await policyId(`rewave-${ulid().slice(10, 18)}`);
    const explicit = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy, orderIds: [orderId] })
      .expect(422);
    expect(explicit.body.code).toBe('no-eligible-orders');
    expect(explicit.body.detail).toContain('ready_to_dispatch');
    expect(explicit.body.detail).toContain('a wave draws only accepted orders');

    // The AUTO-selection path sweeps `accepted` only. (Its `not exists` claim
    // clause is a SECOND, independent reason a packed order never appears —
    // its picked lines still hold the order-line claim — so this assertion
    // pins the outcome, not that one clause.)
    const baitSkuId = sku('PAK-NOISE');
    await seedStock(baitSkuId, binB, 20);
    const baitOrderId = await createOrder([{ skuId: baitSkuId, quantity: 1 }]);
    const autoPolicy = await policyId(`auto-${ulid().slice(10, 18)}`);
    const auto = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: autoPolicy })
      .expect(201);
    const wavedOrderIds = (auto.body.wave.picklists as { orderId: string | null }[]).map(
      (picklist) => picklist.orderId,
    );
    expect(wavedOrderIds).toContain(baitOrderId);
    expect(wavedOrderIds).not.toContain(orderId);
  });

  it('a queued pick against a packed order is REFUSED as terminal (the device quarantines, never retries)', async () => {
    const { orderId, skuId, line } = await pickedOrder('PAK-REPICK', 3, 'repick');
    await packOrder(orderId, { scanned: [{ skuId, qty: 3 }] }).expect(201);

    // The natural floor state cannot produce "a planned line on a packed
    // order" — completeness forbids it — so the line is forced back to
    // `planned` to reach the ORDER-status gate specifically, which is what
    // an out-of-order replay against a re-opened line would find.
    await sql`
      update picklist_lines set status = 'planned', shortfall_qty = 0, reason_code = null
      where id = ${line.id}
    `;
    await sql`delete from picks where tenant_id = ${tenantId} and picklist_line_id = ${line.id}`;

    const res = await pick(line).expect(409);
    // TERMINAL, not retryable: `pick-unresolvable` is what makes the device
    // quarantine the op with session attribution instead of retrying it
    // forever against an order that will never go back to `accepted`.
    expect(res.body.code).toBe('pick-unresolvable');
    expect(res.body.detail).toContain('ready_to_dispatch');
    // …and the reason it gives is the true one. A packed order's units WERE
    // picked — that is why it is packed — so "its units are not picked" sent
    // the operator hunting for stock already sitting in a parcel.
    expect(res.body.detail).toContain('verified at the pack bench');
    expect(res.body.detail).not.toContain('its units are not picked');
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
  });

  it('a packed order is NOT silently cancelled — cancel refuses it and releases nothing', async () => {
    // A ZERO-unit short pick packs an order with NO drawn pick lines, so the
    // 4.4 "drawn lines" guard cannot fire: what refuses this cancel is the
    // order-status gate itself. Without it the conditional flip would simply
    // match nothing and the caller would get a 200 carrying an UNCANCELLED
    // order — success-shaped silence.
    const skuId = sku('PAK-CANCEL');
    await seedStock(skuId, binA, 20);
    const { orderId, picklist } = await releasedWave([{ skuId, quantity: 4 }], 'cancel');
    await pick(picklist.lines[0]!, { qty: 0, reasonCode: 'bin-empty' }).expect(201);
    await packOrder(orderId, { scanned: [] }).expect(201);

    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(409);
    expect(res.body.code).toBe('conflict');
    expect(res.body.detail).toContain('ready_to_dispatch');
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
  });

  it('replays under the same key when the dimension keys arrive in a different order', async () => {
    // Pinning an IMPLICIT guarantee, not fixing a bug: `plainToInstance`
    // yields the DTO's declaration order regardless of the order the client
    // sent, so `{heightMm, widthMm, lengthMm}` and `{lengthMm, widthMm,
    // heightMm}` reach the command — and the payload hash — identically. The
    // replay contract rests on that and nothing asserted it, so a future
    // change to the transform would break a retrying pack bench silently.
    const { orderId, skuId } = await pickedOrder('PAK-KEYS', 5, 'keys');
    const key = ulid();
    const first = await packOrder(
      orderId,
      {
        scanned: [{ skuId, qty: 5 }],
        dimensionsMm: { lengthMm: 400, widthMm: 250, heightMm: 120 },
      },
      operatorWebToken,
      key,
    ).expect(201);

    const reordered = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, key)
      // The SAME measurements, the keys transmitted in a different order.
      .send({
        scanned: [{ skuId, qty: 5 }],
        dimensionsMm: { heightMm: 120, widthMm: 250, lengthMm: 400 },
      })
      .expect(201);
    expect(reordered.body).toEqual(first.body);
    expect(await packEvents(orderId)).toHaveLength(1);
  });

  it('the order detail read reports the new arm', async () => {
    const { orderId, skuId } = await pickedOrder('PAK-EXTRA', 2, 'read');
    await packOrder(orderId, { scanned: [{ skuId, qty: 2 }] }).expect(201);
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/orders/${orderId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    expect(detail.body.order.status).toBe('ready_to_dispatch');
  });
});
