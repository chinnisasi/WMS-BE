import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ORDER_STATUSES } from '../src/modules/outbound/order.command';
import {
  MAX_CARRIER_NAME_LENGTH,
  MAX_TRACKING_NUMBER_LENGTH,
} from '../src/modules/outbound/dispatch.command';
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

interface DispatchBody {
  carrierName?: string | null;
  trackingNumber?: string | null;
}

/**
 * Story 4.6 — dispatch, the order's terminal transition.
 *
 * The assertion this suite exists for is the ATP one. A picked order's units
 * were deducted from ATP TWICE — once as on-hand the `pick.picked` draw
 * removed, once as reserved that nothing ever restored — and the defect was
 * invisible to every parity guard in the repo, because the counter rebuild
 * sums `state in ('held','committed')` and reproduced the same wrong number
 * the live counter held. So the dispatch test must assert the RECOVERED
 * VALUE (ATP back to on-hand), never parity with the journal.
 */
describe('dispatch: the terminal order transition (e2e, story 4.6)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let accountantToken: string;
  /** A WEB session for an operator — the dispatch desk rides the tenant guard. */
  let operatorWebToken: string;
  let warehouseId: string;
  let zoneId: string;
  let binA: string; // A-01-01
  let binB: string; // A-01-02
  const skuIds = new Map<string, string>();

  let deviceToken: string;
  let operatorToken: string; // the badge-in DEVICE session (picking)

  /** SKU fixtures — one scenario each, so no two dispatches share stock. */
  const SKU_CODES = [
    'DSP-OK', // the happy path: events, flip, outbox, audit
    'DSP-ATP', // the ATP recovery — the reason this story exists
    'DSP-CARRIER', // the optional carrier / tracking arms + the replay
    'DSP-LONG', // an over-long carrier value
    'DSP-ACCEPTED', // an unpacked (accepted) order
    'DSP-CXL', // a cancelled order
    'DSP-SHORT', // a partially short-picked order (mixed hold states)
    'DSP-SHORTB', // …its sibling line, the fully-picked one
    'DSP-AUTH', // the authority arms
    'DSP-REWAVE', // a dispatched order must not be re-waved
    'DSP-BAIT', // …the auto-selection bait order that must be swept
    'DSP-REPICK', // …and must not accept a queued pick
    'DSP-REPACK', // …and must not be re-packed
    'DSP-RECXL', // …and must not be cancelled
    'DSP-ZERO', // a ZERO-unit short pick — nothing to retire, still dispatches
    'DSP-KEY', // one Idempotency-Key reused across cancel and dispatch
    'DSP-REAPED', // the reaper reclaimed its hold before dispatch ran
    'DSP-MULTIA', // a fully-picked TWO-line order — both holds must retire
    'DSP-MULTIB', // …its second line
    'DSP-SAME', // TWO lines naming the SAME sku — the per-sku accumulation
    'DSP-SPLIT', // one order line across TWO bins — two picks rows, one event
    'DSP-BLANK', // blank carrier / tracking strings
    'DSP-CHAIN', // the ledger's own invariants after a landed dispatch
    'DSP-ARGS', // the documented 400 arms
    'DSP-CONCA', // the concurrent same-key race…
    'DSP-CONCB', // …and its second order
  ] as const;

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('dispatch');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Dispatch Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
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
        .send({ code: `DSP-${ulid().slice(10, 16).toUpperCase()}`, name: `Dispatch WH ${ulid()}` })
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
      ...SKU_CODES.map((code) => `${code},Dispatch SKU ${code},pcs,,1800,,false,false,,,`),
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
      .send({ code: minted.body.code, label: 'Dispatch desk scanner', pin: '2468' })
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
        note: 'dispatch-suite seed',
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
    scanned: { skuId: string; qty: number }[],
    token = operatorWebToken,
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned });
  }

  function dispatchOrder(
    orderId: string,
    body: DispatchBody = {},
    token = operatorWebToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  /** A fully-picked, PACKED order of ONE line in ONE bin — dispatchable. */
  async function packedOrder(
    code: string,
    quantity: number,
    tag: string,
    seed = quantity + 10,
  ): Promise<{ orderId: string; skuId: string; line: PickLine }> {
    const skuId = sku(code);
    await seedStock(skuId, binA, seed);
    const { orderId, picklist } = await releasedWave([{ skuId, quantity }], tag);
    const line = picklist.lines[0]!;
    await pick(line).expect(201);
    await packOrder(orderId, [{ skuId, qty: quantity }]).expect(201);
    return { orderId, skuId, line };
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

  async function dispatchEvents(orderId: string): Promise<
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
      where tenant_id = ${tenantId} and type = 'dispatch.dispatched'
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

  it('the dispatched arm, the ledger grammar and the capability are registered (the drift guards)', async () => {
    expect([...ORDER_STATUSES]).toEqual([
      'accepted',
      'ready_to_dispatch',
      'dispatched',
      'cancelled',
    ]);

    // The DB CHECK is the additive backstop to the TS constant (0024).
    const defs = await sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'orders_status_check'
    `;
    const def = (defs[0] as unknown as { def: string }).def;
    const arms = [...def.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!).sort();
    expect(arms).toEqual([...ORDER_STATUSES].sort());

    // The dispatch event type: registered, `dispatch`-referenced, and both
    // identity arms CLOSED — a dispatch re-counts nothing, it ships exactly
    // the units `pick.picked` already drew (and those events carry the
    // batch/serial identity).
    const definition = getLedgerEventType('dispatch.dispatched');
    expect(definition).toBeDefined();
    expect(definition!.referenceKinds).toEqual(['dispatch']);
    expect(definition!.allowsBatchArm).toBe(false);
    expect(definition!.allowsSerialArm).toBe(false);

    expect((CAPABILITIES as readonly string[]).includes('dispatch.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.owner.has('dispatch.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.ops_manager.has('dispatch.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.operator.has('dispatch.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.accountant.has('dispatch.execute')).toBe(false);
  });

  // ── the happy path ────────────────────────────────────────────────────────

  it('dispatches a packed order: one zero-quantity event per line, the flip, the outbox and the audit — from ONE transaction', async () => {
    const { orderId, skuId } = await packedOrder('DSP-OK', 6, 'ok');
    const before = await onHand(skuId, binA);

    const res = await dispatchOrder(orderId).expect(201);
    const dispatch = res.body.dispatch as Record<string, unknown>;
    expect(dispatch.orderId).toBe(orderId);
    expect(dispatch.orderStatus).toBe('dispatched');
    expect(dispatch.totalUnits).toBe(6);
    expect(dispatch.carrierName).toBeNull();
    expect(dispatch.trackingNumber).toBeNull();
    const lines = dispatch.lines as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.skuId).toBe(skuId);
    expect(lines[0]!.skuCode).toBe('DSP-OK');
    expect(lines[0]!.skuName).toBe('Dispatch SKU DSP-OK');
    expect(lines[0]!.orderedQty).toBe(6);
    expect(lines[0]!.dispatchedQty).toBe(6);
    expect(lines[0]!.shortfallQty).toBe(0);
    expect(typeof lines[0]!.ledgerEventId).toBe('string');

    expect(await orderStatus(orderId)).toBe('dispatched');

    // The ledger: ONE zero-quantity event per ORDER LINE, both bin arms null.
    // The units left `stock_on_hand` at PICK (`pick.picked` carries
    // `toBinId: null`), so a dispatch has nothing left to move.
    const events = await dispatchEvents(orderId);
    expect(events).toHaveLength(1);
    expect(events[0]!.sku_id).toBe(skuId);
    expect(events[0]!.quantity_delta).toBe(0);
    expect(events[0]!.from_bin_id).toBeNull();
    expect(events[0]!.to_bin_id).toBeNull();
    expect(events[0]!.batch_ref).toBeNull();
    expect(events[0]!.serial_ref).toBeNull();
    expect(events[0]!.reference_doc).toMatchObject({ kind: 'dispatch', orderId, dispatchedQty: 6 });
    expect(events[0]!.reference_doc.carrierName).toBeUndefined();
    expect(events[0]!.reference_doc.trackingNumber).toBeUndefined();

    // The projection is untouched — a zero-quantity event folds nothing.
    expect(await onHand(skuId, binA)).toBe(before);

    const outbox = await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'order.dispatched'
    `;
    expect(
      outbox.some(
        (row) =>
          (row as unknown as { payload: { dispatch: { orderId: string } } }).payload.dispatch
            .orderId === orderId,
      ),
    ).toBe(true);
    const audit = await sql`
      select action from audit_events
      where tenant_id = ${tenantId} and target_id = ${orderId} and action = 'order.dispatched'
    `;
    expect(audit).toHaveLength(1);
  });

  // ── the ATP recovery: the reason this story exists ────────────────────────

  it('retires the committed hold and RECOVERS ATP — the double-deduction the pick→pack path left behind', async () => {
    const skuId = sku('DSP-ATP');
    await seedStock(skuId, binA, 100);
    expect(await atp(skuId)).toMatchObject({ onHand: 100, reserved: 0, atp: 100 });

    const { orderId, picklist } = await releasedWave([{ skuId, quantity: 10 }], 'atp');
    // Acceptance reserved 10 — ATP 90 is CORRECT here: the units are still
    // in the bin, promised to this order.
    expect(await atp(skuId)).toMatchObject({ onHand: 100, reserved: 10, atp: 90 });

    await pick(picklist.lines[0]!).expect(201);
    // The defect, verified live: the draw removed the units from on-hand AND
    // the hold committed without ever being retired, so the same 10 units are
    // subtracted twice. ATP reads 80 against an on-hand of 90.
    expect(await atp(skuId)).toMatchObject({ onHand: 90, reserved: 10, atp: 80 });
    const packedHolds = await holdsOfOrder(orderId);
    expect(packedHolds.filter((hold) => hold.state === 'committed')).toHaveLength(1);

    await packOrder(orderId, [{ skuId, qty: 10 }]).expect(201);
    // Pack releases only the DEAD (`held`) holds — the committed one is still
    // live, so the bad number survives the bench.
    expect(await atp(skuId)).toMatchObject({ onHand: 90, reserved: 10, atp: 80 });

    const res = await dispatchOrder(orderId).expect(201);
    expect((res.body.dispatch.retiredReservationIds as string[])).toHaveLength(1);

    // The journal half: the hold reads `released` — the lifecycle's own
    // documented exit, not a new state.
    const after = await holdsOfOrder(orderId);
    expect(after.filter((hold) => hold.state === 'committed')).toHaveLength(0);
    expect(after.every((hold) => hold.state === 'released')).toBe(true);

    // The RECOVERED VALUE, not parity: the counter rebuild reproduces the
    // same wrong number the live counter holds (it sums `held` + `committed`
    // alike), so a parity assertion passes while ATP is wrong. This asserts
    // what an operator would sell against.
    const recovered = await atp(skuId);
    expect(recovered).toMatchObject({ onHand: 90, reserved: 0, atp: 90 });
    expect(recovered.atp).toBe(recovered.onHand);

    // …and the Valkey mirror agrees with the journal, applied AFTER the
    // commit (journal first, mirror second).
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
    expect(await atp(skuId)).toMatchObject({ onHand: 90, reserved: 0, atp: 90 });
  });

  // ── the carrier arms ──────────────────────────────────────────────────────

  it('carries the optional carrier and tracking on every event, replays under the same key, and refuses a SECOND dispatch under a new one', async () => {
    const { orderId, skuId } = await packedOrder('DSP-CARRIER', 4, 'carrier');
    const key = ulid();
    const body = { carrierName: 'Manual Courier', trackingNumber: 'MC-0099-XZ' };

    const first = await dispatchOrder(orderId, body, operatorWebToken, key).expect(201);
    expect(first.body.dispatch.carrierName).toBe('Manual Courier');
    expect(first.body.dispatch.trackingNumber).toBe('MC-0099-XZ');
    const events = await dispatchEvents(orderId);
    expect(events).toHaveLength(1);
    expect(events[0]!.reference_doc).toMatchObject({
      kind: 'dispatch',
      carrierName: 'Manual Courier',
      trackingNumber: 'MC-0099-XZ',
    });

    // Replay under the SAME key re-serves the stored record and writes
    // nothing further.
    const replay = await dispatchOrder(orderId, body, operatorWebToken, key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(await dispatchEvents(orderId)).toHaveLength(1);

    // A blank is the same intent as absent — same hash, so it replays too
    // rather than colliding as a reused key with a different payload.
    await dispatchOrder(
      orderId,
      { carrierName: '  Manual Courier  ', trackingNumber: 'MC-0099-XZ' },
      operatorWebToken,
      key,
    ).expect(201);

    // The SAME key with a genuinely different payload is the deterministic 422.
    const reused = await dispatchOrder(
      orderId,
      { carrierName: 'Other Courier' },
      operatorWebToken,
      key,
    ).expect(422);
    expect(reused.body.code).toBe('idempotency-key-reuse');

    // A NEW key against a dispatched order is a 409 — an order dispatches once.
    const second = await dispatchOrder(orderId).expect(409);
    expect(second.body.code).toBe('conflict');
    expect(second.body.detail).toContain('dispatches once');
    expect(await dispatchEvents(orderId)).toHaveLength(1);
    expect(await orderStatus(orderId)).toBe('dispatched');
    // The ATP correction happened exactly ONCE: the second attempt retired
    // nothing, so no hold is double-released and no counter double-restored.
    const holds = await holdsOfOrder(orderId);
    expect(holds.filter((hold) => hold.state === 'released')).toHaveLength(holds.length);
    expect((await atp(skuId)).reserved).toBe(0);
  });

  it('refuses an over-long carrier or tracking value before anything is written', async () => {
    const { orderId } = await packedOrder('DSP-LONG', 2, 'long');
    const tooLong = 'x'.repeat(MAX_CARRIER_NAME_LENGTH + 1);
    const denied = await dispatchOrder(orderId, { carrierName: tooLong }).expect(400);
    expect(denied.body.code).toBe('validation-failed');

    const tooLongTracking = 'y'.repeat(MAX_TRACKING_NUMBER_LENGTH + 1);
    await dispatchOrder(orderId, { trackingNumber: tooLongTracking }).expect(400);

    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
    expect(await dispatchEvents(orderId)).toHaveLength(0);
  });

  it('does not collide with cancel: one Idempotency-Key reused across the two commands is REFUSED, never served the other command’s snapshot', async () => {
    // `JSON.stringify` drops `undefined` keys, so a dispatch carrying neither
    // carrier arm hashes the same bytes cancel does unless the fingerprint
    // names the COMMAND. And `replay()` runs BEFORE the status guard, so a
    // collision is not caught later: the stored cancel snapshot would be
    // returned straight out of the dispatch endpoint with the payload-hash
    // check — the very guard that exists to catch this — agreeing.
    const skuId = sku('DSP-KEY');
    await seedStock(skuId, binA, 20);
    const orderId = await createOrder([{ skuId, quantity: 3 }]);
    const key = ulid();

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({})
      .expect(200);

    const crossed = await dispatchOrder(orderId, {}, operatorWebToken, key).expect(422);
    expect(crossed.body.code).toBe('idempotency-key-reuse');
    // The decisive assertion: NOT the cancel's snapshot wearing a 201.
    expect(crossed.body.order).toBeUndefined();
    expect(crossed.body.dispatch).toBeUndefined();
    expect(await orderStatus(orderId)).toBe('cancelled');
    expect(await dispatchEvents(orderId)).toHaveLength(0);
  });

  // ── the retirement loop over MORE THAN ONE hold ───────────────────────────

  it('retires EVERY committed hold of a fully-picked two-line order, not just the first', async () => {
    // One committed hold is indistinguishable from a loop that retires only
    // `committedHolds[0]`. A second unretired hold would count against ATP
    // until the reaper's acceptance TTL elapsed — days, not never (the reaper
    // now sweeps `committed` too), but dispatch is still what closes it at
    // the moment the units actually ship.
    const skuA = sku('DSP-MULTIA');
    const skuB = sku('DSP-MULTIB');
    await seedStock(skuA, binA, 20);
    await seedStock(skuB, binB, 20);
    const { orderId, picklist } = await releasedWave(
      [
        { skuId: skuA, quantity: 3 },
        { skuId: skuB, quantity: 4 },
      ],
      'multi',
    );
    for (const line of picklist.lines) {
      await pick(line).expect(201);
    }
    await packOrder(orderId, [
      { skuId: skuA, qty: 3 },
      { skuId: skuB, qty: 4 },
    ]).expect(201);

    const before = await holdsOfOrder(orderId);
    const committedBefore = before.filter((hold) => hold.state === 'committed');
    expect(committedBefore).toHaveLength(2);
    expect((await atp(skuA)).reserved).toBe(3);
    expect((await atp(skuB)).reserved).toBe(4);

    const res = await dispatchOrder(orderId).expect(201);
    expect((res.body.dispatch.retiredReservationIds as string[]).slice().sort()).toEqual(
      committedBefore.map((hold) => hold.id).sort(),
    );

    const after = await holdsOfOrder(orderId);
    expect(after.filter((hold) => hold.state === 'committed')).toHaveLength(0);
    expect(after.every((hold) => hold.state === 'released')).toBe(true);
    expect((await atp(skuA)).reserved).toBe(0);
    expect((await atp(skuB)).reserved).toBe(0);
  });

  it('accumulates the counter restore PER SKU when two order lines name the same one', async () => {
    // Two lines, one SKU: the restores share a `counterRestores` map key, so a
    // last-write-wins `set` would mirror only the second line’s units and leave
    // the first line’s reserved against the scope permanently. The journal
    // would read `released` while Valkey still held them — a divergence only a
    // rebuild repairs, and one no parity assertion in the suite would notice.
    const skuId = sku('DSP-SAME');
    await seedStock(skuId, binA, 40);
    const { orderId, picklist } = await releasedWave(
      [
        { skuId, quantity: 3 },
        { skuId, quantity: 2 },
      ],
      'same',
    );
    for (const line of picklist.lines) {
      await pick(line).expect(201);
    }
    await packOrder(orderId, [{ skuId, qty: 5 }]).expect(201);

    const committedBefore = (await holdsOfOrder(orderId)).filter(
      (hold) => hold.state === 'committed',
    );
    expect(committedBefore).toHaveLength(2);
    // 3 + 2 against ONE scope.
    expect((await atp(skuId)).reserved).toBe(5);

    const res = await dispatchOrder(orderId).expect(201);
    expect(res.body.dispatch.retiredReservationIds).toHaveLength(2);

    // The whole 5 comes back — not just the 2 a last-write-wins would mirror.
    const recovered = await atp(skuId);
    expect(recovered.reserved).toBe(0);
    expect(recovered.atp).toBe(recovered.onHand);
    // …and the mirror already agreed with the journal before any rebuild.
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
    expect((await atp(skuId)).reserved).toBe(0);
  });

  it('sums a multi-slice order line into ONE event: two picks rows, one dispatched quantity', async () => {
    // `sum(picks.qty) group by order_line_id` is indistinguishable from
    // reading a single row until a line is drawn from two bins. An
    // understated quantity here is written into the APPEND-ONLY ledger, where
    // nothing can correct it afterwards.
    const skuId = sku('DSP-SPLIT');
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
    await packOrder(orderId, [
      { skuId, qty: 5 },
      { skuId, qty: 3 },
    ]).expect(201);

    const res = await dispatchOrder(orderId).expect(201);
    const lines = res.body.dispatch.lines as Record<string, unknown>[];
    // ONE order line, so ONE event — carrying the SUM of both slices.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.dispatchedQty).toBe(8);
    expect(lines[0]!.shortfallQty).toBe(0);
    expect(res.body.dispatch.totalUnits).toBe(8);
    const events = await dispatchEvents(orderId);
    expect(events).toHaveLength(1);
    expect(events[0]!.reference_doc.dispatchedQty).toBe(8);
  });

  // ── the ledger's own invariants ───────────────────────────────────────────

  it('leaves the hash chain and the replay intact — a zero-magnitude event with no bin arm must not make the ledger disagree with itself', async () => {
    const { orderId } = await packedOrder('DSP-CHAIN', 3, 'chain');
    await dispatchOrder(orderId, { carrierName: 'Chain Courier' }).expect(201);

    const inventory = app.get(InventoryFacade);
    const chain = await inventory.verifyChain(tenantId, warehouseId);
    expect(chain.ok).toBe(true);
    const replayed = await inventory.replay(tenantId, warehouseId);
    expect(replayed.matches).toBe(true);
    expect(replayed.divergences).toEqual([]);
  });

  // ── the blank-is-absent contract ──────────────────────────────────────────

  it('treats a BLANK carrier or tracking as absent: both read null, neither key reaches the reference doc, and the omitted-field replay matches', async () => {
    // The DTO’s `@Length(0, MAX)` admits `‘’` deliberately, so the command is
    // what normalizes it. Without that branch a `""` is persisted into the
    // append-only reference doc, and the same request sent again with the
    // fields simply omitted hashes differently and 422s on its own replay.
    const { orderId } = await packedOrder('DSP-BLANK', 2, 'blank');
    const key = ulid();

    const blank = await dispatchOrder(
      orderId,
      { carrierName: '', trackingNumber: '   ' },
      operatorWebToken,
      key,
    ).expect(201);
    expect(blank.body.dispatch.carrierName).toBeNull();
    expect(blank.body.dispatch.trackingNumber).toBeNull();

    const events = await dispatchEvents(orderId);
    expect(events).toHaveLength(1);
    expect(events[0]!.reference_doc).not.toHaveProperty('carrierName');
    expect(events[0]!.reference_doc).not.toHaveProperty('trackingNumber');

    // Blank and ABSENT are one intent, so the same key with the fields
    // omitted replays rather than colliding as a reused key.
    const omitted = await dispatchOrder(orderId, {}, operatorWebToken, key).expect(201);
    expect(omitted.body).toEqual(blank.body);
    expect(await dispatchEvents(orderId)).toHaveLength(1);
  });

  // ── the documented argument arms ──────────────────────────────────────────

  it('refuses a missing or malformed Idempotency-Key and a malformed orderId before anything is read', async () => {
    const { orderId } = await packedOrder('DSP-ARGS', 2, 'args');

    const missing = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .send({})
      .expect(400);
    expect(missing.body.code).toBe('idempotency-key-required');

    const malformedKey = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, 'not-a-ulid')
      .send({})
      .expect(400);
    expect(malformedKey.body.code).toBe('idempotency-key-invalid');

    const malformedId = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/not-a-uuid/dispatch`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(400);
    expect(malformedId.body.code).toBe('validation-failed');

    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
    expect(await dispatchEvents(orderId)).toHaveLength(0);
  });

  it('refuses the SECOND of two concurrent dispatches sharing one Idempotency-Key, and dispatches exactly one order', async () => {
    const first = await packedOrder('DSP-CONCA', 2, 'conca');
    const second = await packedOrder('DSP-CONCB', 2, 'concb');
    const key = ulid();

    const [left, right] = await Promise.all([
      dispatchOrder(first.orderId, {}, operatorWebToken, key),
      dispatchOrder(second.orderId, {}, operatorWebToken, key),
    ]);
    const codes = [left.status, right.status].sort();
    // Exactly one winner. The loser is refused by whichever guard it reached
    // first: `conflict` when both passed the replay read before either
    // committed (the unique index on (tenant, key) is the arbiter), or
    // `idempotency-key-reuse` when it read the winner’s committed row — the
    // two orders hash differently, so a REPLAY is impossible either way.
    expect(codes[0]).toBe(201);
    expect([409, 422]).toContain(codes[1]);
    const loser = left.status === 201 ? right : left;
    expect(['conflict', 'idempotency-key-reuse']).toContain(loser.body.code);

    const statuses = [await orderStatus(first.orderId), await orderStatus(second.orderId)];
    expect(statuses.filter((status) => status === 'dispatched')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'ready_to_dispatch')).toHaveLength(1);
  });

  // ── the refusals ──────────────────────────────────────────────────────────

  it('refuses an order that was never packed, and one that was cancelled — naming the status, writing nothing', async () => {
    // Accepted, never packed.
    const acceptedSku = sku('DSP-ACCEPTED');
    await seedStock(acceptedSku, binA, 20);
    const acceptedOrderId = await createOrder([{ skuId: acceptedSku, quantity: 3 }]);
    const notPacked = await dispatchOrder(acceptedOrderId).expect(409);
    expect(notPacked.body.code).toBe('conflict');
    expect(notPacked.body.detail).toContain('accepted');
    expect(notPacked.body.detail).toContain('only a packed');
    expect(await orderStatus(acceptedOrderId)).toBe('accepted');
    expect(await dispatchEvents(acceptedOrderId)).toHaveLength(0);

    // Cancelled.
    const cancelledSku = sku('DSP-CXL');
    await seedStock(cancelledSku, binA, 20);
    const cancelledOrderId = await createOrder([{ skuId: cancelledSku, quantity: 3 }]);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${cancelledOrderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const cancelled = await dispatchOrder(cancelledOrderId).expect(409);
    expect(cancelled.body.code).toBe('conflict');
    expect(cancelled.body.detail).toContain('cancelled');
    expect(await orderStatus(cancelledOrderId)).toBe('cancelled');
    expect(await dispatchEvents(cancelledOrderId)).toHaveLength(0);
  });

  it('refuses the wrong authority: a role without dispatch.execute, an unknown order, and a foreign tenant', async () => {
    const { orderId } = await packedOrder('DSP-AUTH', 2, 'auth');

    const denied = await dispatchOrder(orderId, {}, accountantToken).expect(403);
    expect(denied.body.code).toBe('role-denied');
    expect(denied.body.detail).toContain('dispatch.execute');

    await dispatchOrder('00000000-0000-7000-8000-00000000dead').expect(404);

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
    const crossed = await dispatchOrder(orderId, {}, foreignToken).expect(403);
    expect(crossed.body.code).toBe('permission-denied');

    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
    expect(await dispatchEvents(orderId)).toHaveLength(0);
  });

  // ── the mixed hold states ─────────────────────────────────────────────────

  it('dispatches a partially short-picked order: only the COMMITTED holds retire, the already-released ones are untouched', async () => {
    // Two lines: one fully picked (its hold settles `committed`), one short
    // (4.4 released the whole hold and re-granted the remainder, which 4.5's
    // pack then swept). Only the first has anything left to retire.
    const shortSku = sku('DSP-SHORT');
    const wholeSku = sku('DSP-SHORTB');
    await seedStock(shortSku, binA, 20);
    await seedStock(wholeSku, binB, 20);
    const { orderId, picklist } = await releasedWave(
      [
        { skuId: shortSku, quantity: 5 },
        { skuId: wholeSku, quantity: 4 },
      ],
      'short',
    );
    const shortLine = picklist.lines.find((line) => line.skuId === shortSku)!;
    const wholeLine = picklist.lines.find((line) => line.skuId === wholeSku)!;
    // The fixture's SKU lives in exactly one bin, so nothing can be
    // re-planned onto and no PLANNED slice survives the short pick.
    await pick(shortLine, { qty: 3, reasonCode: 'fewer-units-than-planned' }).expect(201);
    await pick(wholeLine).expect(201);
    await packOrder(orderId, [
      { skuId: shortSku, qty: 3 },
      { skuId: wholeSku, qty: 4 },
    ]).expect(201);

    const before = await holdsOfOrder(orderId);
    const committedBefore = before.filter((hold) => hold.state === 'committed');
    expect(committedBefore).toHaveLength(1);
    const releasedBefore = before.filter((hold) => hold.state === 'released');
    expect(releasedBefore.length).toBeGreaterThan(0);

    const res = await dispatchOrder(orderId).expect(201);
    const dispatch = res.body.dispatch as Record<string, unknown>;
    expect(dispatch.totalUnits).toBe(7);
    // Only the committed hold was retired — the already-released ones are not
    // touched, so nothing is double-restored.
    expect(dispatch.retiredReservationIds).toEqual(committedBefore.map((hold) => hold.id));

    const lines = (dispatch.lines as Record<string, unknown>[]).slice().sort((left, right) =>
      String(left.skuCode) < String(right.skuCode) ? -1 : 1,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ skuCode: 'DSP-SHORT', orderedQty: 5, dispatchedQty: 3, shortfallQty: 2 });
    expect(lines[1]).toMatchObject({ skuCode: 'DSP-SHORTB', orderedQty: 4, dispatchedQty: 4, shortfallQty: 0 });

    const after = await holdsOfOrder(orderId);
    expect(after.filter((hold) => hold.state === 'committed')).toHaveLength(0);
    expect(after).toHaveLength(before.length); // no hold was created or lost

    // Both SKUs recover: nothing of this order is reserved any more.
    expect((await atp(shortSku)).reserved).toBe(0);
    expect((await atp(wholeSku)).reserved).toBe(0);
  });

  it('dispatches an order whose every line short-picked to ZERO — nothing to retire, and the order still closes', async () => {
    const skuId = sku('DSP-ZERO');
    await seedStock(skuId, binA, 20);
    const { orderId, picklist } = await releasedWave([{ skuId, quantity: 4 }], 'zero');
    await pick(picklist.lines[0]!, { qty: 0, reasonCode: 'bin-empty' }).expect(201);
    await packOrder(orderId, []).expect(201);

    const res = await dispatchOrder(orderId).expect(201);
    expect(res.body.dispatch.totalUnits).toBe(0);
    expect(res.body.dispatch.retiredReservationIds).toEqual([]);
    // The event is still written: one per ORDER LINE, shipment or not — the
    // order's terminal fact is journalled either way.
    const events = await dispatchEvents(orderId);
    expect(events).toHaveLength(1);
    expect(events[0]!.reference_doc.dispatchedQty).toBe(0);
    expect(await orderStatus(orderId)).toBe('dispatched');
  });

  // ── `dispatched` is terminal everywhere ───────────────────────────────────

  it('a dispatched order is excluded from wave generation — both the explicit and the auto selection path', async () => {
    const { orderId } = await packedOrder('DSP-REWAVE', 3, 'rewave');
    await dispatchOrder(orderId).expect(201);

    // The EXPLICIT selection path names the status and refuses.
    const policy = await policyId(`rewave-${ulid().slice(10, 18)}`);
    const explicit = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy, orderIds: [orderId] })
      .expect(422);
    expect(explicit.body.code).toBe('no-eligible-orders');
    expect(explicit.body.detail).toContain('dispatched');
    expect(explicit.body.detail).toContain('a wave draws only accepted orders');

    // The AUTO-selection path sweeps `accepted` only.
    const baitSkuId = sku('DSP-BAIT');
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

  it('a queued pick against a dispatched order is refused as TERMINAL (the device quarantines, never retries)', async () => {
    const { orderId, line } = await packedOrder('DSP-REPICK', 3, 'repick');
    await dispatchOrder(orderId).expect(201);

    // The natural floor state cannot produce "a planned line on a dispatched
    // order", so the line is forced back to `planned` to reach the ORDER
    // status gate specifically — what an out-of-order offline replay finds.
    await sql`
      update picklist_lines set status = 'planned', shortfall_qty = 0, reason_code = null
      where id = ${line.id}
    `;
    await sql`delete from picks where tenant_id = ${tenantId} and picklist_line_id = ${line.id}`;

    const res = await pick(line).expect(409);
    // The defect this story fixed: without `dispatched` in the terminal
    // classification the refusal would have been a RETRYABLE `conflict`, and
    // the device would have retried a terminally-dead op forever instead of
    // quarantining it (AD-14).
    expect(res.body.code).toBe('pick-unresolvable');
    expect(res.body.detail).toContain('dispatched');
    expect(res.body.detail).toContain('it has shipped');
    expect(res.body.detail).not.toContain('its units are not picked');
    expect(await orderStatus(orderId)).toBe('dispatched');
  });

  it('a dispatched order is neither re-packed nor cancelled — both refuse it and nothing is written', async () => {
    const { orderId, skuId } = await packedOrder('DSP-REPACK', 3, 'repack');
    await dispatchOrder(orderId).expect(201);
    const holdsAfterDispatch = await holdsOfOrder(orderId);

    const repacked = await packOrder(orderId, [{ skuId, qty: 3 }]).expect(409);
    expect(repacked.body.code).toBe('conflict');
    expect(repacked.body.detail).toContain('dispatched');

    const cancelled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(409);
    expect(cancelled.body.code).toBe('conflict');
    expect(cancelled.body.detail).toContain('dispatched');

    // Cancel-vs-dispatch double-release stays impossible: the hold states are
    // exactly what the dispatch left.
    expect(await orderStatus(orderId)).toBe('dispatched');
    expect(await holdsOfOrder(orderId)).toEqual(holdsAfterDispatch);
    expect(await dispatchEvents(orderId)).toHaveLength(1);
  });

  it('dispatches cleanly when the reaper already reclaimed the hold — no double restore, no 409', async () => {
    // The reaper now sweeps `committed` rows past their acceptance TTL, so a
    // stalled order's hold can be `expired` BEFORE a late dispatch arrives.
    // The retirement loop reads `state = 'committed'`, so such a row is
    // simply invisible to it: nothing to retire, nothing to restore twice,
    // and no conditional-update 409 rolling the dispatch back.
    const skuId = sku('DSP-REAPED');
    const { orderId } = await packedOrder('DSP-REAPED', 4, 'reaped');

    const before = await holdsOfOrder(orderId);
    expect(before.filter((hold) => hold.state === 'committed')).toHaveLength(1);

    await sql`
      update reservations set expires_at = now() - interval '1 second'
      where tenant_id = ${tenantId} and state = 'committed'
        and owner_id in (
          select ol.id::text from order_lines ol
          where ol.tenant_id = ${tenantId} and ol.order_id = ${orderId}
        )`;
    expect(await app.get(InventoryFacade).expireDueReservations()).toBe(1);

    // The counter was already given back by the expiry.
    const reaped = await atp(skuId);
    expect(reaped.reserved).toBe(0);

    // The dispatch still succeeds and honestly reports retiring nothing.
    const res = await dispatchOrder(orderId).expect(201);
    expect(res.body.dispatch.retiredReservationIds).toEqual([]);
    expect(await orderStatus(orderId)).toBe('dispatched');

    // And ATP did not move again — no second restore.
    expect(await atp(skuId)).toMatchObject({ reserved: 0, atp: reaped.atp });
  });

  it('the dispatched order still reads back through the order surface, with its hold states intact', async () => {
    const { orderId } = await packedOrder('DSP-RECXL', 2, 'recxl');
    await dispatchOrder(orderId, { carrierName: 'Desk Courier' }).expect(201);

    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/orders/${orderId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    expect(detail.body.order.status).toBe('dispatched');
    // The line keeps naming the hold that served it (4.5's rule: the journal
    // is the state authority, so a retired hold already reads `released`).
    const reservationStates = (detail.body.order.lines as { reservationState: string | null }[]).map(
      (line) => line.reservationState,
    );
    expect(reservationStates).toEqual(['released']);
  });
});
