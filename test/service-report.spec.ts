import type { INestApplication } from '@nestjs/common';
import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { addIsoDays, istDateOf, istMidnightOf } from '../src/shared/primitives/time';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { SignedQuantity } from '../src/shared/primitives/quantity';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ReportingFacade } from '../src/modules/reporting/reporting.facade';
import { readServiceFiguresInTx } from '../src/modules/reporting/service';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// Story 21-8 — per-client service reporting (CAP-10): one facade read behind
// an operator route and a portal route. The relational facts (orders, order
// lines, picklist lines, GRNs, placements, pack failures) are seeded by raw
// insert with chosen server stamps, and the dispatch events through the
// ledger facade with chosen `recordedAt` — the read model is what is under
// test, and every figure below is hand-computed from these fixtures. The
// fixtures sit in a period that ends 60 days before the run (never the
// future, whatever date CI runs on). This suite connects as a superuser
// (RLS inert): the HTTP tests prove the app predicate; the RLS layer is
// proved as `wms_rls_probe` in test/client-isolation.spec.ts.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.STORAGE_SNAPSHOT_POLL_MS;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('per-client service reporting (e2e, story 21-8)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let db: Database;
  let inventory: InventoryFacade;
  let reporting: ReportingFacade;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let wh1: string;
  let wh2: string;
  let selfClient: string;
  let clientA: string;
  let clientB: string;
  let portalA: string;
  let portalB: string;
  let countingSince: string | null;
  const sku = new Map<string, string>();

  /** The fixture period: 30 IST days ending 60 days before the run. */
  const today = istDateOf(new Date().toISOString());
  const D0 = addIsoDays(today, -90);
  const P = { from: D0, to: addIsoDays(D0, 29) };

  /** An instant on fixture day `day` (offset from D0), IST wall clock. */
  function at(day: number, hh: number, mm = 0, ss = 0): string {
    return new Date(Date.parse(istMidnightOf(addIsoDays(D0, day))) + hh * HOUR + mm * MINUTE + ss * 1000).toISOString();
  }

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('service_report');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    db = app.get<Database>(DATABASE);
    inventory = app.get(InventoryFacade);
    reporting = app.get(ReportingFacade);

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Service 3PL ${ulid()}`, ownerEmail, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = await signIn(ownerEmail);

    wh1 = await createWarehouse('S-W1');
    wh2 = await createWarehouse('S-W2');
    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    clientA = await createClient('BRAND-A', 'Brand A Apparel');
    clientB = await createClient('BRAND-B', 'Brand B Beauty');
    await importCsv(['A-1,Alpha tee,pcs,1800,,,', 'A-2,Alpha cap,pcs,1800,,,', 'A-3,Alpha sock,pcs,1800,,,'], clientA);
    await importCsv(['B-1,Beta serum,pcs,1800,,,'], clientB);
    const skus = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    portalA = await portalUser(clientA);
    portalB = await portalUser(clientB);

    const raw = (await sql`select value from app_metadata where key = 'reporting_facts_since' limit 1`)[0]?.value;
    countingSince = typeof raw === 'string' ? new Date(Date.parse(raw)).toISOString() : null;

    // ── dock-to-stock ──────────────────────────────────────────────────────
    await placement(wh1, 'A-1', at(4, 10), at(4, 10, 30)); // 30 min
    await placement(wh1, 'A-2', at(5, 10), at(5, 11, 30)); // 90 min
    await placement(wh2, 'A-3', at(6, 10), at(6, 12)); // 120 min, the other warehouse
    await placement(wh1, 'A-1', at(7, 10), at(7, 9)); // negative — excluded
    await placement(wh1, 'A-1', at(-1, 22), at(-1, 23)); // before the period
    await placement(wh1, 'B-1', at(4, 10), at(4, 10, 5)); // B's — 5 min
    await placement(wh1, 'A-1', at(31, 10), at(31, 11)); // after the period — the window's upper bound

    // ── orders and dispatches ──────────────────────────────────────────────
    // O1: three lines, received day 9 10:00, dispatched 20:00 (600 min).
    //   L0 — a short later recovered (a short slice AND a picked slice);
    //   L1 — a zero-unit short whose wave was then cancelled;
    //   L2 — clean. B's order rides the SAME wave and picklist, short too.
    const waveId = uuidv7();
    const picklistId = uuidv7();
    const o1 = await order(clientA, wh1, at(9, 10), 'dispatched', ['A-1', 'A-2', 'A-3']);
    await picklistLine({ waveId, picklistId, order: o1, line: 0, slice: 0, status: 'short', reasonCode: 'bin-empty', shortfall: 1000 });
    await picklistLine({ waveId, picklistId, order: o1, line: 0, slice: 1, status: 'picked', reasonCode: null, shortfall: 0 });
    await picklistLine({ waveId, picklistId, order: o1, line: 1, slice: 0, status: 'cancelled', reasonCode: 'stock-not-found', shortfall: 2000 });
    await picklistLine({ waveId, picklistId, order: o1, line: 2, slice: 0, status: 'picked', reasonCode: null, shortfall: 0 });
    await dispatch(o1, wh1, at(9, 20));
    // O2: exactly 24 h — on time.  O3 (wh2): 24 h + 1 s — late.
    await dispatch(await order(clientA, wh1, at(10, 10), 'dispatched', ['A-1']), wh1, at(11, 10));
    const o3 = await order(clientA, wh2, at(11, 10), 'dispatched', ['A-3']);
    await dispatch(o3, wh2, at(12, 10, 0, 1));
    // O4: received before the period, dispatched inside it (48 h — late).
    await dispatch(await order(clientA, wh1, at(-1, 10), 'dispatched', ['A-2']), wh1, at(1, 10));
    // O5: dispatched before the period — never counted.
    await dispatch(await order(clientA, wh1, at(-3, 10), 'dispatched', ['A-1']), wh1, at(-1, 10));
    // O6: received in the period, dispatched after it — not dispatched in P,
    // and not backlog either (it has a dispatch as of now).
    await dispatch(await order(clientA, wh1, at(28, 10), 'dispatched', ['A-1']), wh1, at(31, 10));
    // O7: a dispatch stamped BEFORE the order's receipt (skew) — clamped to 0, on time.
    await dispatch(await order(clientA, wh1, at(14, 10), 'dispatched', ['A-2']), wh1, at(14, 9));
    // O8: received in the period, never dispatched — late backlog. O9: cancelled — not.
    await order(clientA, wh1, at(19, 10), 'accepted', ['A-1']);
    await order(clientA, wh1, at(19, 11), 'cancelled', ['A-1']);
    // B: one order in the cross-client wave, received 09:00, dispatched 20:00 (660 min).
    const ob1 = await order(clientB, wh1, at(9, 9), 'dispatched', ['B-1']);
    await picklistLine({ waveId, picklistId, order: ob1, line: 0, slice: 0, status: 'short', reasonCode: 'damaged-units', shortfall: 1000 });
    await dispatch(ob1, wh1, at(9, 20));

    // ── pack failures ──────────────────────────────────────────────────────
    await packFailure(o1.orderId, wh1, at(9, 15));
    await packFailure(o3.orderId, wh2, at(11, 12));
    await packFailure(ob1.orderId, wh1, at(9, 16));
  });

  afterAll(async () => {
    reporting.serviceRead = readServiceFiguresInTx;
    await sql?.end();
    const appDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await appDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function signIn(email: string): Promise<string> {
    return (await http().post(`${API}/sign-in`).send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  }

  async function createWarehouse(code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${code}-${ulid().slice(20)}`, name: `${code} warehouse` })
        .expect(201)
    ).body.id as string;
  }

  async function createClient(code: string, name: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name })
        .expect(201)
    ).body.client.id as string;
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,product,variant_values,kit_components', ...rows].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  async function portalUser(clientId: string): Promise<string> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role: 'client', clientId })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    return signIn(email);
  }

  /** One GRN (recorded at `grnAt`) and one placement of `skuCode` recorded at `placedAt`. */
  async function placement(warehouseId: string, skuCode: string, grnAt: string, placedAt: string): Promise<void> {
    const grnId = uuidv7();
    const lineId = uuidv7();
    const skuId = sku.get(skuCode)!;
    await sql`insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, blind_reason_code, status, device_id, recorded_by, occurred_at, recorded_at, created_at, updated_at)
      values (${grnId}, ${tenantId}, ${warehouseId}, ${'GRN-' + ulid().slice(14)}, null, 'other', 'recorded', ${uuidv7()}, ${ownerUserId}, ${grnAt}, ${grnAt}, ${grnAt}, ${grnAt})`;
    await sql`insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty)
      values (${lineId}, ${tenantId}, ${grnId}, ${skuId}, 1000, 1000)`;
    await sql`insert into putaway_placements (id, tenant_id, warehouse_id, grn_id, grn_line_id, sku_id, qty, from_bin_id, to_bin_id, placed_by, placed_at, device_id, created_at, updated_at)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${grnId}, ${lineId}, ${skuId}, 1000, ${uuidv7()}, ${uuidv7()}, ${ownerUserId}, ${placedAt}, ${uuidv7()}, ${placedAt}, ${placedAt})`;
  }

  interface SeededOrder {
    readonly orderId: string;
    readonly lines: readonly { readonly id: string; readonly skuId: string }[];
  }

  /** One order of `clientId` received (`created_at`) at `createdAt`, one line per SKU code. */
  async function order(
    clientId: string,
    warehouseId: string,
    createdAt: string,
    status: 'accepted' | 'dispatched' | 'cancelled',
    skuCodes: readonly string[],
  ): Promise<SeededOrder> {
    const orderId = uuidv7();
    await sql`insert into orders (id, tenant_id, client_id, warehouse_id, status, source, created_at, updated_at)
      values (${orderId}, ${tenantId}, ${clientId}, ${warehouseId}, ${status}, 'manual', ${createdAt}, ${createdAt})`;
    const lines: { id: string; skuId: string }[] = [];
    for (const code of skuCodes) {
      const id = uuidv7();
      const skuId = sku.get(code)!;
      await sql`insert into order_lines (id, tenant_id, order_id, sku_id, qty, created_at, updated_at)
        values (${id}, ${tenantId}, ${orderId}, ${skuId}, 2000, ${createdAt}, ${createdAt})`;
      lines.push({ id, skuId });
    }
    return { orderId, lines };
  }

  async function picklistLine(input: {
    waveId: string;
    picklistId: string;
    order: SeededOrder;
    line: number;
    slice: number;
    status: 'picked' | 'short' | 'cancelled';
    reasonCode: string | null;
    shortfall: number;
  }): Promise<void> {
    const line = input.order.lines[input.line]!;
    await sql`insert into picklist_lines (id, tenant_id, picklist_id, wave_id, order_id, order_line_id, sku_id, bin_id, bin_code, qty, shortfall_qty, reason_code, slice_seq, walk_seq, status)
      values (${uuidv7()}, ${tenantId}, ${input.picklistId}, ${input.waveId}, ${input.order.orderId}, ${line.id}, ${line.skuId}, ${uuidv7()}, 'A-01-01',
        2000, ${input.shortfall}, ${input.reasonCode}, ${input.slice}, ${input.slice}, ${input.status})`;
  }

  /** The dispatch: one `dispatch.dispatched` event per order line, all at `recordedAt` (atomic, like the command). */
  async function dispatch(seeded: SeededOrder, warehouseId: string, recordedAt: string): Promise<void> {
    await withTenantTransaction(db, tenantId, async (tx) => {
      for (const line of seeded.lines) {
        await inventory.appendLedgerEventInTx(tx, {
          tenantId,
          warehouseId,
          type: 'dispatch.dispatched',
          skuId: line.skuId,
          quantityDelta: 0 as SignedQuantity,
          fromBinId: null,
          toBinId: null,
          batchRef: null,
          serialRef: null,
          actorUserId: ownerUserId,
          occurredAt: recordedAt,
          recordedAt,
          referenceDoc: { kind: 'dispatch', orderId: seeded.orderId, orderLineId: line.id, dispatchedQty: 2 },
        });
      }
    });
  }

  async function packFailure(orderId: string, warehouseId: string, createdAt: string): Promise<void> {
    await sql`insert into pack_verification_failures (id, tenant_id, warehouse_id, order_id, entry, actor_user_id, mismatch, idempotency_key, created_at)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${orderId}, 'tenant', ${ownerUserId}, ${sql.json({ seeded: true })}, ${ulid()}, ${createdAt})`;
  }

  function operator(clientId: string, query: string, token = ownerToken) {
    return http().get(`${API}/${tenantId}/reporting/clients/${clientId}/service?${query}`).set('Authorization', `Bearer ${token}`);
  }

  function portal(query: string, token = portalA) {
    return http().get(`${API}/${tenantId}/portal/service?${query}`).set('Authorization', `Bearer ${token}`);
  }

  function q(period: { from: string; to: string }, warehouseId?: string): string {
    return `from=${period.from}&to=${period.to}${warehouseId === undefined ? '' : `&warehouseId=${warehouseId}`}`;
  }

  interface Figures {
    dock: [number | null, number];
    pick: [number | null, number, number, number];
    time: [number, number, number | null, number | null, number];
  }

  /** The whole body, every key — the exact allowlist (and no clientId anywhere). */
  function body(period: { from: string; to: string }, warehouseId: string | null, f: Figures): Record<string, unknown> {
    return {
      from: period.from,
      to: period.to,
      warehouseId,
      asOf: expect.any(String),
      targetHours: 24,
      dockToStock: { medianMinutes: f.dock[0], placements: f.dock[1] },
      pickAccuracy: {
        accuracy: f.pick[0],
        linesDispatched: f.pick[1],
        linesShortPicked: f.pick[2],
        packFailures: f.pick[3],
        packFailuresCountingSince: countingSince,
      },
      dispatchTimeliness: {
        ordersDispatched: f.time[0],
        onTime: f.time[1],
        onTimeRate: f.time[2],
        medianMinutes: f.time[3],
        lateNotDispatched: f.time[4],
      },
    };
  }

  function withoutAsOf(value: Record<string, unknown>): Record<string, unknown> {
    const { asOf, ...rest } = value;
    expect(Number.isNaN(Date.parse(asOf as string))).toBe(false);
    return rest;
  }

  // ── the figures ────────────────────────────────────────────────────────────

  it('happy: BRAND-A over the period equals the hand-computed fixtures — and the portal answers the identical body', async () => {
    // dock: 30, 90, 120 → median 90 over 3 (the negative and the out-of-period placement excluded, B's not seen).
    // lines: O1 ×3, O2, O3, O4, O7 = 7; short: O1's L0 (recovered) and L1 (wave-cancelled) = 2 → 5/7.
    // orders: O1 600, O2 1440, O3 1440.0167, O4 2880, O7 0 (clamped) → 5, on time 3, median 1440.
    // backlog: O8 (O9 cancelled; O6 dispatched after the period).
    const expected = body(P, null, { dock: [90, 3], pick: [0.7143, 7, 2, 2], time: [5, 3, 0.6, 1440, 1] });
    const op = await operator(clientA, q(P)).expect(200);
    expect(op.body).toEqual(expected);
    expect(Object.keys(op.body).sort()).toEqual(
      ['asOf', 'dispatchTimeliness', 'dockToStock', 'from', 'pickAccuracy', 'targetHours', 'to', 'warehouseId'].sort(),
    );
    const pt = await portal(q(P)).expect(200);
    expect(pt.body).toEqual(expected);
    expect(withoutAsOf(pt.body)).toEqual(withoutAsOf(op.body));
  });

  it('one warehouse: the same read narrowed, on both routes', async () => {
    // wh1: dock 30, 90 → 60 over 2; lines 6 (O1 ×3, O2, O4, O7), short 2; orders 0, 600, 1440, 2880 → median 1020.
    const w1 = body(P, wh1, { dock: [60, 2], pick: [0.6667, 6, 2, 1], time: [4, 3, 0.75, 1020, 1] });
    expect((await operator(clientA, q(P, wh1)).expect(200)).body).toEqual(w1);
    expect((await portal(q(P, wh1)).expect(200)).body).toEqual(w1);
    // wh2: dock 120; O3 alone — 24 h + 1 s is late; its pack failure.
    const w2 = body(P, wh2, { dock: [120, 1], pick: [1, 1, 0, 1], time: [1, 0, 0, 1440, 0] });
    expect((await operator(clientA, q(P, wh2)).expect(200)).body).toEqual(w2);
    expect((await portal(q(P, wh2)).expect(200)).body).toEqual(w2);
  });

  it('isolation: B shares A’s wave and warehouse; each report counts only its own client’s rows, on either route', async () => {
    const expectedB = body(P, null, { dock: [5, 1], pick: [0, 1, 1, 1], time: [1, 1, 1, 660, 0] });
    expect((await operator(clientB, q(P)).expect(200)).body).toEqual(expectedB);
    expect((await portal(q(P), portalB).expect(200)).body).toEqual(expectedB);
  });

  it('multi-line and the recovered / wave-cancelled shorts: O1 alone is 1 order, 3 lines, 2 short (each once)', async () => {
    const day9 = { from: addIsoDays(D0, 9), to: addIsoDays(D0, 9) };
    const expected = body(day9, null, { dock: [null, 0], pick: [0.3333, 3, 2, 1], time: [1, 1, 1, 600, 0] });
    expect((await operator(clientA, q(day9)).expect(200)).body).toEqual(expected);
    expect((await portal(q(day9)).expect(200)).body).toEqual(expected);
  });

  it('boundary: dispatched at exactly 24 h is on time; at 24 h + 1 s it is late', async () => {
    const days = { from: addIsoDays(D0, 10), to: addIsoDays(D0, 12) };
    for (const res of [await operator(clientA, q(days)).expect(200), await portal(q(days)).expect(200)]) {
      // No placement falls inside days 10–12 (the later ones sit past its end).
      expect(res.body.dockToStock).toEqual({ medianMinutes: null, placements: 0 });
      expect(res.body.dispatchTimeliness).toEqual({ ordersDispatched: 2, onTime: 1, onTimeRate: 0.5, medianMinutes: 1440, lateNotDispatched: 0 });
    }
  });

  it('backlog: received 30 h ago and undispatched is late; 2 h ago is not yet; a cancelled order never', async () => {
    const now = Date.now();
    await order(clientA, wh1, new Date(now - 30 * HOUR).toISOString(), 'accepted', ['A-1']);
    await order(clientA, wh1, new Date(now - 2 * HOUR).toISOString(), 'accepted', ['A-1']);
    await order(clientA, wh1, new Date(now - 30 * HOUR).toISOString(), 'cancelled', ['A-1']);
    const recent = { from: addIsoDays(today, -2), to: today };
    const expected = body(recent, null, { dock: [null, 0], pick: [null, 0, 0, 0], time: [0, 0, null, null, 1] });
    expect((await operator(clientA, q(recent)).expect(200)).body).toEqual(expected);
    expect((await portal(q(recent)).expect(200)).body).toEqual(expected);
  });

  it('empty and future: no activity, or a from after today, is 0s and nulls (asOf still shown)', async () => {
    const zero = { dock: [null, 0], pick: [null, 0, 0, 0], time: [0, 0, null, null, 0] } satisfies Figures;
    // The tenant's own (self) client — the D2C case — is a valid client.
    expect((await operator(selfClient, q(P)).expect(200)).body).toEqual(body(P, null, zero));
    const future = { from: addIsoDays(today, 1), to: addIsoDays(today, 3) };
    expect((await operator(clientA, q(future)).expect(200)).body).toEqual(body(future, null, zero));
    expect((await portal(q(future)).expect(200)).body).toEqual(body(future, null, zero));
  });

  it('reconcile: ordersDispatched equals the invoiced dispatched-order count — 4 periods × (every warehouse, one warehouse)', async () => {
    const periods = [P, { from: addIsoDays(D0, 9), to: addIsoDays(D0, 12) }, { from: addIsoDays(D0, -5), to: addIsoDays(D0, 3) }, { from: addIsoDays(D0, 25), to: today }];
    let nonZero = 0;
    for (const period of periods) {
      for (const warehouseId of [undefined, wh1]) {
        const res = await operator(clientA, q(period, warehouseId)).expect(200);
        // The facade's own clipped window: [IST midnight of from, min(IST midnight after to, asOf)).
        const from = istMidnightOf(period.from);
        const end = istMidnightOf(addIsoDays(period.to, 1));
        const to = end < (res.body.asOf as string) ? end : (res.body.asOf as string);
        const oracle = await withTenantTransaction(db, tenantId, (tx) =>
          inventory.countDispatchedOrdersInTx(tx, { tenantId, clientId: clientA, warehouseIds: warehouseId === undefined ? undefined : [warehouseId] }, from, to),
        );
        expect({ period, warehouseId, n: res.body.dispatchTimeliness.ordersDispatched }).toEqual({ period, warehouseId, n: oracle });
        // The portal reads the same count for the same client.
        const viaPortal = await portal(q(period, warehouseId)).expect(200);
        expect(viaPortal.body.dispatchTimeliness.ordersDispatched).toBe(oracle);
        if (oracle > 0) nonZero += 1;
      }
    }
    // Meaningful: the oracle saw real dispatches in most of the cells.
    expect(nonZero).toBeGreaterThanOrEqual(6);
  });

  // ── the refusals ───────────────────────────────────────────────────────────

  it('period: a bad date, from after to, or 367 days is 400 validation-failed — the same detail on both routes', async () => {
    const cases: [string, string][] = [
      ['from=2026-02-31&to=2026-03-01', 'from must be a real calendar date YYYY-MM-DD (got "2026-02-31").'],
      ['from=2026-03-01&to=03/05/2026', 'to must be a real calendar date YYYY-MM-DD (got "03/05/2026").'],
      ['from=2026-03-05&to=2026-03-01', 'from (2026-03-05) is after to (2026-03-01).'],
      ['from=2025-01-01&to=2026-01-02', 'A period covers at most 366 days (got 367, 2025-01-01 → 2026-01-02).'],
    ];
    for (const [query, detail] of cases) {
      for (const res of [await operator(clientA, query), await portal(query)]) {
        // (The problem filter renders a ProblemException's `title` from its
        // message — the detail — codebase-wide; the metering read's 400s too.)
        expect({ status: res.status, code: res.body.code, title: res.body.title, detail: res.body.detail }).toEqual({
          status: 400,
          code: 'validation-failed',
          title: detail,
          detail,
        });
      }
    }
    // 366 days is admitted.
    await operator(clientA, 'from=2025-01-01&to=2026-01-01').expect(200);
    // A missing date is the query class's own 400.
    expect((await operator(clientA, 'from=2026-01-01').expect(400)).body.code).toBe('validation-failed');
  });

  it('unknown: a client or a warehouse not in the tenant is 404 not-found; a malformed id is 400', async () => {
    expect((await operator(uuidv7(), q(P)).expect(404)).body.code).toBe('not-found');
    expect((await operator(clientA, q(P, uuidv7())).expect(404)).body.code).toBe('not-found');
    expect((await portal(q(P, uuidv7())).expect(404)).body.code).toBe('not-found');
    expect((await operator('not-a-uuid', q(P)).expect(400)).body.code).toBe('validation-failed');
    expect((await operator(clientA, `${q(P)}&warehouseId=nope`).expect(400)).body.code).toBe('validation-failed');
    expect((await portal(`${q(P)}&warehouseId=nope`).expect(400)).body.code).toBe('validation-failed');
  });

  it('portal: a query clientId is 400; a suspended client is 403 client-suspended (the operator still reads it); the fences hold both ways', async () => {
    expect((await portal(`${q(P)}&clientId=${clientB}`).expect(400)).body.code).toBe('validation-failed');
    await sql`update clients set status = 'suspended' where id = ${clientA}`;
    try {
      expect((await portal(q(P)).expect(403)).body.code).toBe('client-suspended');
      // A suspended client stays reportable to the operator.
      expect((await operator(clientA, q(P)).expect(200)).body.dispatchTimeliness.ordersDispatched).toBe(5);
    } finally {
      await sql`update clients set status = 'active' where id = ${clientA}`;
    }
    expect((await portal(q(P), ownerToken).expect(403)).body.code).toBe('role-denied');
    expect((await operator(clientA, q(P), portalA).expect(403)).body.code).toBe('role-denied');
  });

  it('timeout: one transaction under a 5 s statement_timeout; a 57014 is 503 report-unavailable with nothing partial, on both routes', async () => {
    // `pg_settings.setting` is the timeout in ms, as text.
    const timeoutMs = async (tx: Parameters<typeof readServiceFiguresInTx>[0]): Promise<number> =>
      Number(((await tx.execute(dsql`select setting as v from pg_settings where name = 'statement_timeout'`)) as unknown as { v: string }[])[0]?.v);
    let armed: number | undefined;
    let rearmed: number | undefined;
    let budgetLeft: number | undefined;
    reporting.serviceRead = async (tx, scope, window) => {
      armed = await timeoutMs(tx);
      budgetLeft = window.deadlineAt - Date.now();
      const figures = await readServiceFiguresInTx(tx, scope, window);
      rearmed = await timeoutMs(tx);
      return figures;
    };
    try {
      await operator(clientA, q(P)).expect(200);
      // A WHOLE-read budget: armed at (at most) 5 s, and every statement
      // re-armed to the time left — never back to a fresh 5 s.
      expect(armed).toBeGreaterThan(0);
      expect(armed).toBeLessThanOrEqual(5000);
      expect(rearmed).toBeGreaterThan(0);
      expect(rearmed).toBeLessThanOrEqual(budgetLeft!);
      reporting.serviceRead = async (tx) => {
        await tx.execute(dsql`select set_config('statement_timeout', '50', true)`);
        await tx.execute(dsql`select pg_sleep(2)`);
        throw new Error('unreachable');
      };
      for (const res of [await operator(clientA, q(P)), await portal(q(P))]) {
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 503, code: 'report-unavailable' });
        expect(res.body.dispatchTimeliness).toBeUndefined();
      }
    } finally {
      reporting.serviceRead = readServiceFiguresInTx;
    }
  });

  it('both routes are in the OpenAPI document', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const paths = Object.keys(doc.body.paths as Record<string, unknown>);
    expect(paths).toContain('/tenants/{tenantId}/reporting/clients/{clientId}/service');
    expect(paths).toContain('/tenants/{tenantId}/portal/service');
  });
});
