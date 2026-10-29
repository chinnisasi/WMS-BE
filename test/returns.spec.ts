import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { ReturnsController } from '../src/api/returns.controller';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import {
  RETURN_REASON_CODES,
  RMA_STATUSES,
  createPayloadHash,
  normalizeCreate,
  rmaOrderLockKey,
  rmaSequenceLockKey,
} from '../src/modules/returns/return-authorization.command';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { expectAuditRow } from './support/audit-guard';
import { dispatchedOrderFixtures, type Picklist } from './support/dispatched-order';
import { mintSignIn } from './support/sign-in';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
/** The advisory key every suite uses to serialize wms_rls_probe role setup. */
const PROBE_LOCK = 742105;

interface RmaSerialBody {
  id: string;
  serialNumber: string;
}

interface RmaBody {
  id: string;
  code: string;
  status: string;
  orderId: string;
  orderReference: string | null;
  warehouseId: string;
  clientId: string;
  externalReference: string | null;
  orderDispatchedAt: string;
  createdAt: string;
  createdBy: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  lines: {
    id: string;
    orderLineId: string;
    skuId: string;
    authorizedQty: number;
    receivedQty: number;
    reasonCode: string;
    reasonNote: string | null;
    serials: RmaSerialBody[];
  }[];
}

interface ReturnableBody {
  orderId: string;
  status: string;
  warehouseId: string;
  orderReference: string | null;
  dispatchedAt: string | null;
  lines: {
    orderLineId: string;
    parentLineId: string | null;
    skuId: string;
    kitParent: boolean;
    dispatchedQty: number;
    authorizedQty: number;
    returnableQty: number;
    serialTracked: boolean;
    returnableSerials: RmaSerialBody[];
  }[];
}

/**
 * Story 13-1 (FR-46) — return authorizations: an operator authorizes part of a
 * dispatched order for return. Every backend row of the spec's I/O matrix is
 * driven here through real HTTP against a really dispatched order (the
 * extracted `test/support/dispatched-order.ts` flow: order → wave → picks →
 * pack → dispatch), plus the vocabulary pins, the hash golden, the route
 * order and the wms_rls_probe isolation proof.
 */
describe('return authorizations (e2e, story 13-1)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let memberOperatorToken: string;
  let accountantToken: string;
  let operatorToken: string; // the badge-in device session (picks)
  let warehouseId: string;
  let zoneId: string;
  let binId: string;
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('returns');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Returns Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body
      .accessToken as string;
    const ops = await createMember('ops_manager');
    opsToken = ops.token;
    opsUserId = ops.userId;
    const floor = await createMember('operator');
    memberOperatorToken = floor.token;
    accountantToken = (await createMember('accountant')).token;

    warehouseId = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `RT-${ulid().slice(20)}`, name: 'Returns WH' })
        .expect(201)
    ).body.id as string;
    zoneId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code: 'A-01' })
        .expect(201)
    ).body.id as string;

    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
      'RT-A,Return line A,pcs,,1800,,false,false,,,',
      'RT-B,Return line B,pcs,,1800,,false,false,,,',
      'RT-KG,Return by weight,kg,,1800,,false,false,,,',
      'RT-SER,Return serial,pcs,,1800,,false,true,,,',
      'RT-KIT,Return kit,pcs,,1800,,false,false,,,',
      'RT-C1,Kit component one,pcs,,1800,,false,false,,,',
      'RT-C2,Kit component two,pcs,,1800,,false,false,,,',
      'RT-CW,Return catch-weight,kg,,1800,,false,false,,,',
    ].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const catalog = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of catalog.body.items as { code: string; id: string }[]) skuIds.set(item.code, item.id);
    await http()
      .post(`${API}/${tenantId}/catalog/skus/${sku('RT-KIT')}/kit`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: sku('RT-C1'), quantity: 1 }, { skuId: sku('RT-C2'), quantity: 2 }] })
      .expect(201);
    for (const code of ['RT-A', 'RT-B', 'RT-C1', 'RT-C2']) await seedStock(sku(code), 1000);
    await seedStock(sku('RT-KG'), 500);
    await seedStock(sku('RT-CW'), 100);

    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Returns scanner', pin: '2468' })
      .expect(201);
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail: floor.email, pin: '2468' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
  });

  afterAll(async () => {
    await sql?.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  async function createMember(role: string): Promise<{ userId: string; token: string; email: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const token = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body
      .accessToken as string;
    return { userId: invited.body.user.id as string, token, email };
  }

  async function seedStock(skuId: string, quantity: number, serials?: string[]): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId,
        quantityDelta: quantity,
        reasonCode: 'stock-count',
        note: 'returns-suite seed',
        ...(serials === undefined ? {} : { serials }),
      })
      .expect(201);
  }

  /** A really dispatched order of `lines`; serial-tracked lines pick the given serial numbers. */
  async function dispatchedOrder(
    lines: { skuId: string; quantity: number }[],
    serials?: string[],
  ): Promise<{ orderId: string; returnable: ReturnableBody }> {
    const { orderId, picklist } = await fixtures.releasedWave(lines);
    await fixtures.pickAllLines(picklist, undefined, serials === undefined ? undefined : serialMap(picklist, serials));
    await fixtures.packAndDispatch(orderId, scannedOf(picklist));
    return { orderId, returnable: (await returnable(orderId).expect(200)).body as ReturnableBody };
  }

  function serialMap(picklist: Picklist, serials: string[]): Map<string, string[]> {
    const line = picklist.lines.find((l) => l.skuId === sku('RT-SER'))!;
    return new Map([[line.id, serials]]);
  }

  function scannedOf(picklist: Picklist): { skuId: string; qty: number }[] {
    const bySku = new Map<string, number>();
    for (const line of picklist.lines) bySku.set(line.skuId, (bySku.get(line.skuId) ?? 0) + line.qty);
    return [...bySku].map(([skuId, qty]) => ({ skuId, qty }));
  }

  function lineOf(read: ReturnableBody, code: string): ReturnableBody['lines'][number] {
    const line = read.lines.find((l) => l.skuId === sku(code));
    if (line === undefined) throw new Error(`no ${code} line`);
    return line;
  }

  function createRma(body: Record<string, unknown>, token = opsToken, key = ulid()): SupertestTest {
    return http().post(`${API}/${tenantId}/returns`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function cancelRma(rmaId: string, reason: string, token = opsToken, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/returns/${rmaId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ reason });
  }

  function returnable(orderId: string, token = memberOperatorToken): SupertestTest {
    return http().get(`${API}/${tenantId}/returns/returnable?orderId=${orderId}`).set('Authorization', `Bearer ${token}`);
  }

  async function count(query: PromiseLike<unknown>): Promise<number> {
    const rows = (await query) as { n: number | string }[];
    return Number(rows[0]!.n);
  }

  async function outboxCount(type: string, rmaId: string): Promise<number> {
    return count(sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = ${type} and payload->>'rmaId' = ${rmaId}`);
  }

  /** Wait until `min` sessions are parked on an advisory lock chain held by `holderPid`. */
  async function waitParked(holderPid: number, min: number): Promise<void> {
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.wait_event = 'advisory' and a.state = 'active'
        `) as unknown as { pid: number; blockers: number[] }[];
        const chain = new Set<number>([holderPid]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const row of waiting) {
            if (!chain.has(row.pid) && row.blockers.some((pid) => chain.has(pid))) {
              chain.add(row.pid);
              grew = true;
            }
          }
        }
        if (chain.size - 1 >= min) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`fewer than ${min} request(s) parked on the advisory lock`);
    } finally {
      await probe.end();
    }
  }

  /** Holds the advisory lock `lockKey` while two requests park on it, then releases them together. */
  async function raceOnLock(lockKey: string, send: () => SupertestTest, sendSecond = send): Promise<[request.Response, request.Response]> {
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        const [held] = (await tx`
          select pg_backend_pid() as pid, pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) as locked
        `) as unknown as { pid: number }[];
        first = (async () => send())();
        second = (async () => sendSecond())();
        await waitParked(held!.pid, 2);
      });
      return await Promise.all([first!, second!]);
    } finally {
      await Promise.allSettled([first, second]);
      await holder.end();
    }
  }

  // ── the happy path ─────────────────────────────────────────────────────────

  it('happy path: 2 of 3 dispatched units of line A, damaged → 201 RMA-0001, open, order reference and dispatch instant recorded; returnable drops to 1; one audit row, one outbox event', async () => {
    const { orderId, returnable: before } = await dispatchedOrder([
      { skuId: sku('RT-A'), quantity: 3 },
      { skuId: sku('RT-B'), quantity: 1 },
    ]);
    // A channel order's reference (external_event_id) — set on the order row
    // so the snapshot has something to snapshot (a manual order carries null).
    await sql`update orders set external_event_id = ${'SHOP-#1001'} where tenant_id = ${tenantId} and id = ${orderId}`;
    expect(before.status).toBe('dispatched');
    expect(before.dispatchedAt).not.toBeNull();
    const lineA = lineOf(before, 'RT-A');
    expect(lineA).toMatchObject({ dispatchedQty: 3, authorizedQty: 0, returnableQty: 3, serialTracked: false, kitParent: false });

    const key = ulid();
    const res = await createRma(
      { orderId, externalReference: '  CH-RMA-77  ', lines: [{ orderLineId: lineA.orderLineId, qty: 2, reasonCode: 'damaged' }] },
      opsToken,
      key,
    ).expect(201);
    const rma = res.body as RmaBody;
    expect(rma).toMatchObject({
      code: 'RMA-0001',
      status: 'open',
      orderId,
      orderReference: 'SHOP-#1001',
      warehouseId,
      externalReference: 'CH-RMA-77',
      createdBy: opsUserId,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
    });
    expect(rma.orderDispatchedAt).toBe(before.dispatchedAt);
    // The dispatch instant is the earliest dispatch.dispatched event of the order.
    const [dispatchEvent] = (await sql`
      select min(occurred_at) as at from ledger_events
      where tenant_id = ${tenantId} and type = 'dispatch.dispatched' and reference_doc->>'orderId' = ${orderId}
    `) as unknown as { at: Date }[];
    expect(rma.orderDispatchedAt).toBe(new Date(dispatchEvent!.at).toISOString());
    // The client is the order's.
    const [order] = (await sql`select client_id from orders where id = ${orderId}`) as unknown as { client_id: string }[];
    expect(rma.clientId).toBe(order!.client_id);
    expect(rma.lines).toEqual([
      {
        id: expect.any(String),
        orderLineId: lineA.orderLineId,
        skuId: sku('RT-A'),
        authorizedQty: 2,
        receivedQty: 0,
        reasonCode: 'damaged',
        reasonNote: null,
        serials: [],
      },
    ]);

    const after = (await returnable(orderId).expect(200)).body as ReturnableBody;
    expect(lineOf(after, 'RT-A')).toMatchObject({ dispatchedQty: 3, authorizedQty: 2, returnableQty: 1 });
    expect(lineOf(after, 'RT-B')).toMatchObject({ dispatchedQty: 1, authorizedQty: 0, returnableQty: 1 });
    expect(after.orderReference).toBe('SHOP-#1001');

    await expectAuditRow({ tenantId, key, action: 'return_authorization.created', targetType: 'return_authorization', targetId: rma.id, actorUserId: opsUserId });
    expect(await outboxCount('return_authorization.created', rma.id)).toBe(1);
    const [event] = (await sql`
      select payload from outbox_messages where tenant_id = ${tenantId} and type = 'return_authorization.created' and payload->>'rmaId' = ${rma.id}
    `) as unknown as { payload: Record<string, unknown> }[];
    expect(event!.payload).toEqual({ rmaId: rma.id, code: 'RMA-0001', orderId, warehouseId, clientId: rma.clientId });
    // No stock moved: no ledger event names the RMA, and nothing new was appended for the order.
    expect(await count(sql`select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and reference_doc::text like ${`%${rma.id}%`}`)).toBe(0);

    // Replay: the same key and body re-serve the 201 — one RMA, one audit row, one event.
    const replayed = await createRma(
      { orderId, externalReference: 'CH-RMA-77', lines: [{ orderLineId: lineA.orderLineId, qty: 2, reasonCode: 'damaged' }] },
      opsToken,
      key,
    ).expect(201);
    expect(replayed.body).toEqual(rma);
    await expectAuditRow({ tenantId, key, action: 'return_authorization.created', targetType: 'return_authorization', targetId: rma.id, actorUserId: opsUserId });
    expect(await outboxCount('return_authorization.created', rma.id)).toBe(1);
    expect(await count(sql`select count(*)::int as n from return_authorizations where tenant_id = ${tenantId} and order_id = ${orderId}`)).toBe(1);
    // A different body under the same key is 422.
    const reuse = await createRma({ orderId, lines: [{ orderLineId: lineA.orderLineId, qty: 1, reasonCode: 'damaged' }] }, opsToken, key).expect(422);
    expect(reuse.body.code).toBe('idempotency-key-reuse');

    // Get reads the same document; the list carries it.
    const got = await http().get(`${API}/${tenantId}/returns/${rma.id}`).set('Authorization', `Bearer ${memberOperatorToken}`).expect(200);
    // Story 13-2: the detail read is the same document PLUS its receipts
    // (detail-only; none yet). The create response — a stored snapshot —
    // carries no `receipts` key at all.
    expect(rma).not.toHaveProperty('receipts');
    // Story 4-7b: the detail (and list) read also always emits the origin and
    // review keys; the stored create snapshot above still carries none of
    // them (pinned in test/blind-returns.spec.ts), so a replay is unchanged.
    expect(rma).not.toHaveProperty('origin');
    expect(got.body).toEqual({
      ...rma,
      receipts: [],
      origin: 'authorized',
      reviewStatus: null,
      parcelReference: null,
      suggestedOrderId: null,
      matchKind: null,
      clientPrompted: null,
      reviewedAt: null,
      reviewedBy: null,
      reviewReasonCode: null,
      reviewNote: null,
    });

    // Over-authorize after the earlier RMA: 2 more of line A when 1 is left.
    const over = await createRma({ orderId, lines: [{ orderLineId: lineA.orderLineId, qty: 2, reasonCode: 'defective' }] }).expect(409);
    expect(over.body).toMatchObject({ code: 'exceeds-returnable', orderLineId: lineA.orderLineId, returnableQty: 1 });
    expect(over.body.detail).toContain('only 1 can still be returned');
  });

  it('a fractional unit returns at its own precision; a value finer than the unit is 400', async () => {
    const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-KG'), quantity: 2.5 }]);
    const line = lineOf(read, 'RT-KG');
    expect(line).toMatchObject({ dispatchedQty: 2.5, returnableQty: 2.5 });
    const fine = await createRma({ orderId, lines: [{ orderLineId: line.orderLineId, qty: 1.2505, reasonCode: 'damaged' }] }).expect(400);
    expect(fine.body.code).toBe('validation-failed');
    const rma = (await createRma({ orderId, lines: [{ orderLineId: line.orderLineId, qty: 1.25, reasonCode: 'not-as-described' }] }).expect(201)).body as RmaBody;
    expect(rma.lines[0]!.authorizedQty).toBe(1.25);
    expect(lineOf((await returnable(orderId).expect(200)).body as ReturnableBody, 'RT-KG')).toMatchObject({ authorizedQty: 1.25, returnableQty: 1.25 });
    const over = await createRma({ orderId, lines: [{ orderLineId: line.orderLineId, qty: 1.251, reasonCode: 'damaged' }] }).expect(409);
    expect(over.body).toMatchObject({ code: 'exceeds-returnable', returnableQty: 1.25 });
  });

  // ── serials ────────────────────────────────────────────────────────────────

  describe('a serial-tracked line', () => {
    let orderId: string;
    let lineId: string;
    let serials: string[];
    let stranger: string; // a serial of the SKU that was never dispatched

    beforeAll(async () => {
      serials = ['A', 'B', 'C'].map((s) => `RT-SN-${s}-${ulid().slice(16)}`);
      stranger = `RT-SN-X-${ulid().slice(16)}`;
      await seedStock(sku('RT-SER'), 4, [...serials, stranger]);
      const seeded = await dispatchedOrder([{ skuId: sku('RT-SER'), quantity: 3 }], serials);
      orderId = seeded.orderId;
      const line = lineOf(seeded.returnable, 'RT-SER');
      lineId = line.orderLineId;
      expect(line.serialTracked).toBe(true);
      expect(line.returnableSerials.map((s) => s.serialNumber)).toEqual([...serials].sort());
    });

    it('2 of 3 returnable serial numbers: 201 with {id, serialNumber}; those leave returnableSerials', async () => {
      const rma = (
        await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 2, reasonCode: 'wrong-item', serialNumbers: [serials[1], serials[0]] }] }).expect(201)
      ).body as RmaBody;
      const ids = (await sql`select id, serial_number from serials where tenant_id = ${tenantId} and serial_number in ${sql([serials[0]!, serials[1]!])}`) as unknown as {
        id: string;
        serial_number: string;
      }[];
      const idOf = new Map(ids.map((row) => [row.serial_number, row.id]));
      expect(rma.lines[0]!.serials).toEqual(
        [serials[0]!, serials[1]!].sort().map((serialNumber) => ({ id: idOf.get(serialNumber)!, serialNumber })),
      );
      // The store holds the catalog ids — the ledger's serial_ref form.
      const [stored] = (await sql`select serial_ids from return_authorization_lines where rma_id = ${rma.id}`) as unknown as { serial_ids: string[] }[];
      expect([...stored!.serial_ids].sort()).toEqual([idOf.get(serials[0]!)!, idOf.get(serials[1]!)!].sort());
      const after = lineOf((await returnable(orderId).expect(200)).body as ReturnableBody, 'RT-SER');
      expect(after).toMatchObject({ dispatchedQty: 3, authorizedQty: 2, returnableQty: 1 });
      expect(after.returnableSerials.map((s) => s.serialNumber)).toEqual([serials[2]]);
    });

    it('an undispatched or unknown number is 409 serial-not-dispatched; an authorized one is 409 serial-already-authorized', async () => {
      const notDispatched = await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 1, reasonCode: 'damaged', serialNumbers: [stranger] }] }).expect(409);
      expect(notDispatched.body).toMatchObject({ code: 'serial-not-dispatched', orderLineId: lineId, serialNumber: stranger });
      const unknown = await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 1, reasonCode: 'damaged', serialNumbers: ['NO-SUCH-SERIAL'] }] }).expect(409);
      expect(unknown.body.code).toBe('serial-not-dispatched');
      const already = await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 1, reasonCode: 'damaged', serialNumbers: [serials[0]] }] }).expect(409);
      expect(already.body).toMatchObject({ code: 'serial-already-authorized', serialNumber: serials[0] });
    });

    it('a count unequal to qty, more than 500, none on a serial line, or repeated numbers is 400', async () => {
      const unequal = await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 1, reasonCode: 'damaged', serialNumbers: [serials[2], stranger] }] }).expect(400);
      expect(unequal.body).toMatchObject({ code: 'validation-failed' });
      expect(unequal.body.detail).toContain('lines[0]');
      const many = Array.from({ length: 501 }, (_, i) => `SN-${i}`);
      const tooMany = await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 501, reasonCode: 'damaged', serialNumbers: many }] }).expect(400);
      expect(tooMany.body.code).toBe('validation-failed');
      const none = await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 1, reasonCode: 'damaged' }] }).expect(400);
      expect(none.body.detail).toContain('serial-tracked');
      const repeated = await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 2, reasonCode: 'damaged', serialNumbers: [serials[2], serials[2]] }] }).expect(400);
      expect(repeated.body.detail).toContain('more than once');
    });

    it('the 500-serial cap is per request as well as per line', () => {
      const line = (n: number, offset: number) => ({
        orderLineId: uuidv7(),
        qty: n,
        reasonCode: 'damaged',
        serialNumbers: Array.from({ length: n }, (_, i) => `S-${offset + i}`),
      });
      expect(() => normalizeCreate({ lines: [line(250, 0), line(250, 1000)] })).not.toThrow();
      expect(() => normalizeCreate({ lines: [line(250, 0), line(251, 1000)] })).toThrow(/at most 500 serial numbers in all/);
    });
  });

  // ── order state and line refusals ──────────────────────────────────────────

  it('an order that is not dispatched reads returnable 0 and refuses create 409 order-not-dispatched; an unknown order is 404', async () => {
    const accepted = await fixtures.createOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
    const ready = await fixtures.releasedWave([{ skuId: sku('RT-B'), quantity: 1 }]);
    await fixtures.pickAllLines(ready.picklist);
    await http()
      .post(`${API}/${tenantId}/outbound/orders/${ready.orderId}/pack`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned: scannedOf(ready.picklist) })
      .expect(201);
    const cancelled = await fixtures.createOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
    await http()
      .post(`${API}/${tenantId}/outbound/orders/${cancelled}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);

    for (const [orderId, status] of [
      [accepted, 'accepted'],
      [ready.orderId, 'ready_to_dispatch'],
      [cancelled, 'cancelled'],
    ] as const) {
      const read = (await returnable(orderId).expect(200)).body as ReturnableBody;
      expect(read.status).toBe(status);
      expect(read.dispatchedAt).toBeNull();
      expect(read.lines.length).toBeGreaterThan(0);
      for (const line of read.lines) expect(line).toMatchObject({ dispatchedQty: 0, returnableQty: 0, returnableSerials: [] });
      const refused = await createRma({ orderId, lines: [{ orderLineId: read.lines[0]!.orderLineId, qty: 1, reasonCode: 'damaged' }] }).expect(409);
      expect(refused.body).toMatchObject({ code: 'order-not-dispatched' });
    }
    const unknown = uuidv7();
    expect((await returnable(unknown).expect(404)).body.code).toBe('not-found');
    const refused = await createRma({ orderId: unknown, lines: [{ orderLineId: uuidv7(), qty: 1, reasonCode: 'damaged' }] }).expect(404);
    expect(refused.body.code).toBe('not-found');
    expect(await count(sql`select count(*)::int as n from return_authorizations where tenant_id = ${tenantId} and order_id in ${sql([accepted, ready.orderId, cancelled, unknown])}`)).toBe(0);
  });

  it('a kit parent line is 400 kit-parent-not-returnable; its components are returnable', async () => {
    const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-KIT'), quantity: 2 }]);
    const parent = lineOf(read, 'RT-KIT');
    const c1 = lineOf(read, 'RT-C1');
    const c2 = lineOf(read, 'RT-C2');
    expect(parent).toMatchObject({ kitParent: true, parentLineId: null, dispatchedQty: 0, returnableQty: 0 });
    expect(c1).toMatchObject({ kitParent: false, parentLineId: parent.orderLineId, dispatchedQty: 2, returnableQty: 2 });
    expect(c2).toMatchObject({ parentLineId: parent.orderLineId, dispatchedQty: 4, returnableQty: 4 });
    const refused = await createRma({ orderId, lines: [{ orderLineId: parent.orderLineId, qty: 1, reasonCode: 'damaged' }] }).expect(400);
    expect(refused.body).toMatchObject({ code: 'kit-parent-not-returnable', orderLineId: parent.orderLineId });
    const rma = (
      await createRma({
        orderId,
        lines: [
          { orderLineId: c2.orderLineId, qty: 4, reasonCode: 'changed-mind' },
          { orderLineId: c1.orderLineId, qty: 1, reasonCode: 'other', reasonNote: '  missing a screw  ' },
        ],
      }).expect(201)
    ).body as RmaBody;
    // Lines come back in the order they were named; the note is trimmed.
    expect(rma.lines.map((l) => [l.orderLineId, l.authorizedQty, l.reasonCode, l.reasonNote])).toEqual([
      [c2.orderLineId, 4, 'changed-mind', null],
      [c1.orderLineId, 1, 'other', 'missing a screw'],
    ]);
    // The read order is the stored request order (`line_no` 1..n), never the ids' order.
    const stored = (await sql`select order_line_id, line_no from return_authorization_lines where rma_id = ${rma.id} order by line_no`) as unknown as {
      order_line_id: string;
      line_no: number;
    }[];
    expect(stored.map((row) => [row.order_line_id, row.line_no])).toEqual([
      [c2.orderLineId, 1],
      [c1.orderLineId, 2],
    ]);
  });

  it('a line of another order is 400 line-not-of-order; serials on a line that is not serial-tracked are 400', async () => {
    const one = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
    const two = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
    const foreign = lineOf(two.returnable, 'RT-A').orderLineId;
    const refused = await createRma({ orderId: one.orderId, lines: [{ orderLineId: foreign, qty: 1, reasonCode: 'damaged' }] }).expect(400);
    expect(refused.body).toMatchObject({ code: 'line-not-of-order', orderLineId: foreign });
    const serialsOnPlain = await createRma({
      orderId: one.orderId,
      lines: [{ orderLineId: lineOf(one.returnable, 'RT-A').orderLineId, qty: 1, reasonCode: 'damaged', serialNumbers: ['X-1'] }],
    }).expect(400);
    expect(serialsOnPlain.body).toMatchObject({ code: 'validation-failed' });
    expect(serialsOnPlain.body.detail).toContain('not serial-tracked');
  });

  it('shape: other without a note, a repeated orderLineId, an unknown reason, no lines — 400 above the transaction, never a replay', async () => {
    const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 2 }]);
    const lineId = lineOf(read, 'RT-A').orderLineId;
    const key = ulid();
    const noNote = await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 1, reasonCode: 'other', reasonNote: '   ' }] }, opsToken, key).expect(400);
    expect(noNote.body).toMatchObject({ code: 'validation-failed' });
    expect(noNote.body.detail).toContain('lines[0]');
    const repeated = await createRma(
      { orderId, lines: [{ orderLineId: lineId, qty: 1, reasonCode: 'damaged' }, { orderLineId: lineId, qty: 1, reasonCode: 'damaged' }] },
      opsToken,
      key,
    ).expect(400);
    expect(repeated.body.detail).toContain('lines[1]');
    expect((await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 1, reasonCode: 'lost' }] }, opsToken, key).expect(400)).body.code).toBe(
      'validation-failed',
    );
    expect((await createRma({ orderId, lines: [] }, opsToken, key).expect(400)).body.code).toBe('validation-failed');
    // None of them stored the key: the same key now authorizes cleanly.
    expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(0);
    await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 1, reasonCode: 'other', reasonNote: 'scuffed' }] }, opsToken, key).expect(201);
  });

  it('operators and accountants cannot create or cancel (403 role-denied); nothing is written', async () => {
    const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
    const body = { orderId, lines: [{ orderLineId: lineOf(read, 'RT-A').orderLineId, qty: 1, reasonCode: 'damaged' }] };
    for (const token of [memberOperatorToken, accountantToken]) {
      expect((await createRma(body, token).expect(403)).body.code).toBe('role-denied');
    }
    expect(await count(sql`select count(*)::int as n from return_authorizations where tenant_id = ${tenantId} and order_id = ${orderId}`)).toBe(0);
    const rma = (await createRma(body, ownerToken).expect(201)).body as RmaBody;
    for (const token of [memberOperatorToken, accountantToken]) {
      expect((await cancelRma(rma.id, 'no', token).expect(403)).body.code).toBe('role-denied');
    }
    expect((await http().get(`${API}/${tenantId}/returns/${rma.id}`).set('Authorization', `Bearer ${accountantToken}`).expect(200)).body.status).toBe('open');
  });

  // ── cancel ─────────────────────────────────────────────────────────────────

  it('cancel: 200 cancelled, quantity and serials returnable again, audited; a second cancel is 409; a replay re-serves the 200', async () => {
    const serials = ['P', 'Q'].map((s) => `RT-CX-${s}-${ulid().slice(16)}`);
    await seedStock(sku('RT-SER'), 2, serials);
    const { orderId, returnable: read } = await dispatchedOrder(
      [
        { skuId: sku('RT-A'), quantity: 2 },
        { skuId: sku('RT-SER'), quantity: 2 },
      ],
      serials,
    );
    const rma = (
      await createRma({
        orderId,
        lines: [
          { orderLineId: lineOf(read, 'RT-A').orderLineId, qty: 2, reasonCode: 'damaged' },
          { orderLineId: lineOf(read, 'RT-SER').orderLineId, qty: 2, reasonCode: 'defective', serialNumbers: serials },
        ],
      }).expect(201)
    ).body as RmaBody;
    const held = (await returnable(orderId).expect(200)).body as ReturnableBody;
    expect(lineOf(held, 'RT-A').returnableQty).toBe(0);
    expect(lineOf(held, 'RT-SER').returnableSerials).toEqual([]);

    const key = ulid();
    const cancelled = (await cancelRma(rma.id, '  customer kept it  ', opsToken, key).expect(200)).body as RmaBody;
    expect(cancelled).toMatchObject({ id: rma.id, status: 'cancelled', cancelledBy: opsUserId, cancelReason: 'customer kept it' });
    expect(cancelled.cancelledAt).not.toBeNull();
    await expectAuditRow({ tenantId, key, action: 'return_authorization.cancelled', targetType: 'return_authorization', targetId: rma.id, actorUserId: opsUserId });
    expect(await outboxCount('return_authorization.cancelled', rma.id)).toBe(1);

    const freed = (await returnable(orderId).expect(200)).body as ReturnableBody;
    expect(lineOf(freed, 'RT-A')).toMatchObject({ authorizedQty: 0, returnableQty: 2 });
    expect(lineOf(freed, 'RT-SER').returnableSerials.map((s) => s.serialNumber)).toEqual([...serials].sort());

    const replay = await cancelRma(rma.id, 'customer kept it', opsToken, key).expect(200);
    expect(replay.body).toEqual(cancelled);
    await expectAuditRow({ tenantId, key, action: 'return_authorization.cancelled', targetType: 'return_authorization', targetId: rma.id, actorUserId: opsUserId });
    const again = await cancelRma(rma.id, 'twice').expect(409);
    expect(again.body).toMatchObject({ code: 'rma-transition-invalid' });
    // The serials can be authorized again.
    await createRma({ orderId, lines: [{ orderLineId: lineOf(read, 'RT-SER').orderLineId, qty: 1, reasonCode: 'damaged', serialNumbers: [serials[0]] }] }).expect(201);
  });

  it('cancel refuses an RMA with anything received (409), an unknown id (404), a blank reason (400)', async () => {
    const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
    const rma = (await createRma({ orderId, lines: [{ orderLineId: lineOf(read, 'RT-A').orderLineId, qty: 1, reasonCode: 'damaged' }] }).expect(201)).body as RmaBody;
    // 13-2 writes received_qty; the guard is proved here by setting it directly.
    await sql`update return_authorization_lines set received_qty = 1000 where rma_id = ${rma.id}`;
    const received = await cancelRma(rma.id, 'too late').expect(409);
    expect(received.body.code).toBe('rma-transition-invalid');
    expect(received.body.detail).toContain('received');
    expect((await cancelRma(uuidv7(), 'nothing').expect(404)).body.code).toBe('not-found');
    expect((await cancelRma(rma.id, '   ').expect(400)).body.code).toBe('validation-failed');
    expect((await cancelRma('not-a-uuid', 'x').expect(400)).body.code).toBe('validation-failed');
  });

  // ── races ──────────────────────────────────────────────────────────────────

  it('concurrent different-key creates on one order, each within the bound alone but over it together: one 201, one 409 exceeds-returnable', async () => {
    const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 3 }]);
    const lineId = lineOf(read, 'RT-A').orderLineId;
    const body = { orderId, lines: [{ orderLineId: lineId, qty: 2, reasonCode: 'damaged' }] };
    const [a, b] = await raceOnLock(rmaOrderLockKey(tenantId, orderId), () => createRma(body), () => createRma(body));
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.body).toMatchObject({ code: 'exceeds-returnable', returnableQty: 1 });
    expect(await count(sql`select count(*)::int as n from return_authorizations where tenant_id = ${tenantId} and order_id = ${orderId}`)).toBe(1);
  });

  it('same-key race: two creates parked on the order lock — one RMA, the loser replays the winner’s 201', async () => {
    const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 2 }]);
    const key = ulid();
    const body = { orderId, lines: [{ orderLineId: lineOf(read, 'RT-A').orderLineId, qty: 2, reasonCode: 'damaged' }] };
    const [a, b] = await raceOnLock(rmaOrderLockKey(tenantId, orderId), () => createRma(body, opsToken, key));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body).toEqual(a.body);
    expect(await count(sql`select count(*)::int as n from return_authorizations where tenant_id = ${tenantId} and order_id = ${orderId}`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(1);
  });

  it('codes: concurrent creates on different orders get distinct consecutive codes; the next one follows', async () => {
    const one = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
    const two = await dispatchedOrder([{ skuId: sku('RT-B'), quantity: 1 }]);
    const [a, b] = await raceOnLock(
      rmaSequenceLockKey(tenantId),
      () => createRma({ orderId: one.orderId, lines: [{ orderLineId: lineOf(one.returnable, 'RT-A').orderLineId, qty: 1, reasonCode: 'damaged' }] }),
      () => createRma({ orderId: two.orderId, lines: [{ orderLineId: lineOf(two.returnable, 'RT-B').orderLineId, qty: 1, reasonCode: 'damaged' }] }),
    );
    expect([a.status, b.status]).toEqual([201, 201]);
    const codes = [a.body.code as string, b.body.code as string];
    expect(new Set(codes).size).toBe(2);
    const numbers = codes.map((code) => Number(code.slice(4))).sort((x, y) => x - y);
    expect(numbers[1]! - numbers[0]!).toBe(1);
    const three = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
    const next = (await createRma({ orderId: three.orderId, lines: [{ orderLineId: lineOf(three.returnable, 'RT-A').orderLineId, qty: 1, reasonCode: 'damaged' }] }).expect(201)).body as RmaBody;
    expect(next.code).toBe(`RMA-${String(numbers[1]! + 1).padStart(4, '0')}`);
    // The newest code is the highest one.
    const [max] = (await sql`select max(code) as code from return_authorizations where tenant_id = ${tenantId}`) as unknown as { code: string }[];
    expect(max!.code).toBe(next.code);
  });

  // ── review fixes: uuid case, catch-weight, empty serial lists ─────────────

  it('uuid case: an UPPERCASE orderId create and a lowercase one share the order lock and cannot exceed the bound together', async () => {
    const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 3 }]);
    const lineId = lineOf(read, 'RT-A').orderLineId;
    const upper = { orderId: orderId.toUpperCase(), lines: [{ orderLineId: lineId.toUpperCase(), qty: 2, reasonCode: 'damaged' }] };
    const lower = { orderId, lines: [{ orderLineId: lineId, qty: 2, reasonCode: 'damaged' }] };
    // Both park on the ONE (lowercase) order lock — a differently-cased key
    // would not park, and the race would time out.
    const [a, b] = await raceOnLock(rmaOrderLockKey(tenantId, orderId), () => createRma(upper), () => createRma(lower));
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const created = (a.status === 201 ? a : b).body as RmaBody;
    expect(created.orderId).toBe(orderId);
    expect(created.lines[0]!.orderLineId).toBe(lineId);
    expect(await count(sql`select count(*)::int as n from return_authorizations where tenant_id = ${tenantId} and order_id = ${orderId}`)).toBe(1);
  });

  it('uuid case: an uppercase line is accepted and de-duplicated against its lowercase spelling; the reads take either case', async () => {
    const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 2 }]);
    const lineId = lineOf(read, 'RT-A').orderLineId;
    const dup = await createRma({
      orderId,
      lines: [
        { orderLineId: lineId.toUpperCase(), qty: 1, reasonCode: 'damaged' },
        { orderLineId: lineId, qty: 1, reasonCode: 'damaged' },
      ],
    }).expect(400);
    expect(dup.body.detail).toContain('more than once');
    const rma = (await createRma({ orderId: orderId.toUpperCase(), lines: [{ orderLineId: lineId.toUpperCase(), qty: 1, reasonCode: 'damaged' }] }).expect(201))
      .body as RmaBody;
    expect(rma.lines[0]!.orderLineId).toBe(lineId);
    expect(lineOf((await returnable(orderId.toUpperCase()).expect(200)).body as ReturnableBody, 'RT-A')).toMatchObject({ returnableQty: 1 });
    expect((await http().get(`${API}/${tenantId}/returns/${rma.id.toUpperCase()}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.id).toBe(rma.id);
    const listed = await http().get(`${API}/${tenantId}/returns?orderId=${orderId.toUpperCase()}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((listed.body.items as RmaBody[]).map((r) => r.id)).toEqual([rma.id]);
  });

  it('a catch-weight line returns whole cases only: a fractional quantity is 400, a whole one 201', async () => {
    const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-CW'), quantity: 3 }]);
    // The SKU becomes catch-weight after dispatch (a fixture shortcut: the
    // rule reads the SKU's flag at authorization; the kg unit itself admits 1.5).
    await sql`update skus set catch_weight_tracked = true where tenant_id = ${tenantId} and id = ${sku('RT-CW')}`;
    const lineId = lineOf(read, 'RT-CW').orderLineId;
    const fractional = await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 1.5, reasonCode: 'damaged' }] }).expect(400);
    expect(fractional.body.code).toBe('validation-failed');
    expect(fractional.body.detail).toContain('catch-weight');
    await createRma({ orderId, lines: [{ orderLineId: lineId, qty: 1, reasonCode: 'damaged' }] }).expect(201);
  });

  it('an empty serialNumbers list on a non-serial line reads as absent', async () => {
    const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-B'), quantity: 1 }]);
    const rma = (
      await createRma({ orderId, lines: [{ orderLineId: lineOf(read, 'RT-B').orderLineId, qty: 1, reasonCode: 'damaged', serialNumbers: [] }] }).expect(201)
    ).body as RmaBody;
    expect(rma.lines[0]!.serials).toEqual([]);
  });

  it('every returns route refuses a foreign tenant session with 403 permission-denied', async () => {
    const foreign = uuidv7();
    const expectDenied = (res: request.Response) => expect(res.body).toMatchObject({ status: 403, code: 'permission-denied' });
    expectDenied(
      await http()
        .post(`${API}/${foreign}/returns`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ orderId: uuidv7(), lines: [{ orderLineId: uuidv7(), qty: 1, reasonCode: 'damaged' }] })
        .expect(403),
    );
    expectDenied(
      await http()
        .post(`${API}/${foreign}/returns/${uuidv7()}/cancel`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ reason: 'x' })
        .expect(403),
    );
    expectDenied(await http().get(`${API}/${foreign}/returns/returnable?orderId=${uuidv7()}`).set('Authorization', `Bearer ${ownerToken}`).expect(403));
    expectDenied(await http().get(`${API}/${foreign}/returns`).set('Authorization', `Bearer ${ownerToken}`).expect(403));
    expectDenied(await http().get(`${API}/${foreign}/returns/${uuidv7()}`).set('Authorization', `Bearer ${ownerToken}`).expect(403));
  });

  it('cancel key reuse: the same key with another rmaId, or another reason, is 422 idempotency-key-reuse', async () => {
    const one = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
    const two = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
    const first = (await createRma({ orderId: one.orderId, lines: [{ orderLineId: lineOf(one.returnable, 'RT-A').orderLineId, qty: 1, reasonCode: 'damaged' }] }).expect(201))
      .body as RmaBody;
    const second = (await createRma({ orderId: two.orderId, lines: [{ orderLineId: lineOf(two.returnable, 'RT-A').orderLineId, qty: 1, reasonCode: 'damaged' }] }).expect(201))
      .body as RmaBody;
    const key = ulid();
    await cancelRma(first.id, 'kept it', opsToken, key).expect(200);
    expect((await cancelRma(second.id, 'kept it', opsToken, key).expect(422)).body.code).toBe('idempotency-key-reuse');
    expect((await cancelRma(first.id, 'another reason', opsToken, key).expect(422)).body.code).toBe('idempotency-key-reuse');
    expect((await http().get(`${API}/${tenantId}/returns/${second.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.status).toBe('open');
  });

  // ── reads ──────────────────────────────────────────────────────────────────

  it('the list: newest first, paged with the full-precision cursor, per warehouse or tenant-wide, status and order filters; a bad cursor is 400', async () => {
    const all: RmaBody[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await http()
        .get(`${API}/${tenantId}/returns?warehouseId=${warehouseId}&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200);
      all.push(...(res.body.items as RmaBody[]));
      cursor = (res.body.nextCursor as string | null) ?? null;
    } while (cursor !== null);
    const total = await count(sql`select count(*)::int as n from return_authorizations where tenant_id = ${tenantId}`);
    expect(total).toBeGreaterThan(3);
    expect(all).toHaveLength(total);
    expect(new Set(all.map((r) => r.id)).size).toBe(total);
    const created = all.map((r) => r.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    // Tenant-wide (no warehouse) reads the same set.
    const wide = await http().get(`${API}/${tenantId}/returns?limit=100`).set('Authorization', `Bearer ${accountantToken}`).expect(200);
    expect((wide.body.items as RmaBody[]).map((r) => r.id)).toEqual(all.map((r) => r.id));
    // Another warehouse has none.
    const otherWh = uuidv7();
    expect((await http().get(`${API}/${tenantId}/returns?warehouseId=${otherWh}`).set('Authorization', `Bearer ${accountantToken}`).expect(200)).body.items).toEqual([]);
    // Status filter.
    const cancelled = await http().get(`${API}/${tenantId}/returns?status=cancelled&limit=100`).set('Authorization', `Bearer ${accountantToken}`).expect(200);
    expect((cancelled.body.items as RmaBody[]).length).toBeGreaterThan(0);
    expect((cancelled.body.items as RmaBody[]).every((r) => r.status === 'cancelled')).toBe(true);
    // Order filter.
    const one = all[all.length - 1]!;
    const byOrder = await http().get(`${API}/${tenantId}/returns?orderId=${one.orderId}`).set('Authorization', `Bearer ${accountantToken}`).expect(200);
    expect((byOrder.body.items as RmaBody[]).every((r) => r.orderId === one.orderId)).toBe(true);
    // Refusals.
    expect((await http().get(`${API}/${tenantId}/returns?cursor=garbage`).set('Authorization', `Bearer ${ownerToken}`).expect(400)).body.code).toBe('invalid-cursor');
    expect((await http().get(`${API}/${tenantId}/returns?limit=101`).set('Authorization', `Bearer ${ownerToken}`).expect(400)).body.code).toBe('validation-failed');
    expect((await http().get(`${API}/${tenantId}/returns?status=closed`).set('Authorization', `Bearer ${ownerToken}`).expect(400)).body.code).toBe('validation-failed');
    expect((await http().get(`${API}/${tenantId}/returns/${uuidv7()}`).set('Authorization', `Bearer ${ownerToken}`).expect(404)).body.code).toBe('not-found');
    expect((await http().get(`${API}/${tenantId}/returns/returnable`).set('Authorization', `Bearer ${ownerToken}`).expect(400)).body.code).toBe('validation-failed');
  });

  it('the list pages a same-microsecond tie completely, with no skips (limit=1)', async () => {
    const tied: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { orderId, returnable: read } = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
      tied.push(((await createRma({ orderId, lines: [{ orderLineId: lineOf(read, 'RT-A').orderLineId, qty: 1, reasonCode: 'damaged' }] }).expect(201)).body as RmaBody).id);
    }
    await sql`update return_authorizations set created_at = '2030-01-01 00:00:00.123456+00' where id in ${sql(tied)}`;
    const seen: string[] = [];
    let cursor: string | null = null;
    let hops = 0;
    do {
      const res: request.Response = await http()
        .get(`${API}/${tenantId}/returns?warehouseId=${warehouseId}&limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      seen.push(...(res.body.items as RmaBody[]).map((r) => r.id));
      cursor = (res.body.nextCursor as string | null) ?? null;
      hops += 1;
    } while (cursor !== null && hops < 500);
    const total = await count(sql`select count(*)::int as n from return_authorizations where tenant_id = ${tenantId}`);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    // The tie sorts first (newest) and in id order, descending.
    expect(seen.slice(0, 3)).toEqual([...tied].sort().reverse());
  });

  it('route order: the literal `returnable` is declared before `:rmaId` and answers its own read', async () => {
    const names = Object.getOwnPropertyNames(ReturnsController.prototype);
    expect(names.indexOf('returnable')).toBeGreaterThan(-1);
    expect(names.indexOf('returnable')).toBeLessThan(names.indexOf('get'));
    const { orderId } = await dispatchedOrder([{ skuId: sku('RT-A'), quantity: 1 }]);
    const res = await returnable(orderId).expect(200);
    expect(res.body.orderId).toBe(orderId);
  });

  it('the OpenAPI document lists the return routes', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const paths = Object.keys(doc.body.paths as Record<string, unknown>);
    for (const path of [
      '/tenants/{tenantId}/returns',
      '/tenants/{tenantId}/returns/returnable',
      '/tenants/{tenantId}/returns/{rmaId}',
      '/tenants/{tenantId}/returns/{rmaId}/cancel',
    ]) {
      expect(paths).toContain(path);
    }
  });

  // ── vocabularies, the fingerprint, the CHECKs ──────────────────────────────

  describe('the 0072 vocabularies and CHECKs', () => {
    async function constraintDef(name: string): Promise<string> {
      const rows = (await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`) as unknown as { def: string }[];
      return rows[0]!.def;
    }

    it('RMA_STATUSES and RETURN_REASON_CODES are pinned against their CHECKs', async () => {
      const status = await constraintDef('return_authorizations_status_check');
      expect([...status.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort()).toEqual([...RMA_STATUSES].sort());
      const reasons = await constraintDef('return_authorization_lines_reason_code_check');
      expect([...reasons.matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1]).sort()).toEqual([...RETURN_REASON_CODES].sort());
    });

    it('each new CHECK refuses what it must (23514), below the API', async () => {
      const t = uuidv7();
      const refused = (statement: PromiseLike<unknown>, constraint: string) =>
        expect(Promise.resolve(statement)).rejects.toMatchObject({ code: '23514', constraint_name: constraint });
      const header = (status: string, extra: { cancelled?: boolean; reason?: string | null; external?: string | null } = {}) =>
        sql`insert into return_authorizations (id, tenant_id, client_id, warehouse_id, order_id, code, external_reference, status, order_dispatched_at, created_by, cancelled_by, cancelled_at, cancel_reason)
            values (${uuidv7()}, ${t}, ${t}, ${t}, ${t}, ${`P-${ulid()}`}, ${extra.external ?? null}, ${status}, now(), ${t},
                    ${extra.cancelled === true ? t : null}, ${extra.cancelled === true ? new Date().toISOString() : null}, ${extra.reason ?? null})`;
      const line = (qty: number, reasonCode: string, note: string | null, lineNo = 1) =>
        sql`insert into return_authorization_lines (id, tenant_id, rma_id, line_no, order_line_id, sku_id, authorized_qty, reason_code, reason_note)
            values (${uuidv7()}, ${t}, ${t}, ${lineNo}, ${uuidv7()}, ${t}, ${qty}, ${reasonCode}, ${note})`;
      // What this pins: the status CHECK refuses a status outside the
      // vocabulary. 13-1 probed with `received`; story 13-2 made `received`
      // a real status (0073 widened the CHECK), so the probe now names one
      // no story has designed yet.
      await refused(header('dispositioned'), 'return_authorizations_status_check');
      await refused(header('cancelled'), 'return_authorizations_cancel_shape');
      await refused(header('open', { reason: 'x' }), 'return_authorizations_cancel_shape');
      await refused(header('cancelled', { cancelled: true, reason: ' padded' }), 'return_authorizations_cancel_reason_length');
      await refused(header('open', { external: '' }), 'return_authorizations_external_reference_length');
      await refused(line(1000, 'damaged', null, 0), 'return_authorization_lines_line_no_positive');
      await refused(line(0, 'damaged', null), 'return_authorization_lines_authorized_qty_positive');
      await refused(line(1000, 'lost', null), 'return_authorization_lines_reason_code_check');
      await refused(line(1000, 'other', null), 'return_authorization_lines_other_needs_note');
      await refused(line(1000, 'damaged', ''), 'return_authorization_lines_reason_note_length');
      expect(await count(sql`select count(*)::int as n from return_authorizations where tenant_id = ${t}`)).toBe(0);
    });

    it('the create fingerprint is pinned: arm first, request-order lines, canonical qty, serials sorted, text trimmed', () => {
      const orderId = '01900000-0000-7000-8000-0000000000aa';
      const lineA = '01900000-0000-7000-8000-0000000000a1';
      const lineB = '01900000-0000-7000-8000-0000000000a2';
      const normalized = normalizeCreate({
        externalReference: '  EXT-1 ',
        lines: [
          { orderLineId: lineB, qty: 2, reasonCode: 'defective', serialNumbers: [' S-2', 'S-1 '] },
          { orderLineId: lineA, qty: 1.5, reasonCode: 'other', reasonNote: ' torn ' },
        ],
      });
      const golden = hashCommandPayload({
        arm: 'rma-create',
        tenantId: 't-1',
        orderId,
        externalReference: 'EXT-1',
        lines: [
          { orderLineId: lineB, qty: 2, reasonCode: 'defective', reasonNote: null, serialNumbers: ['S-1', 'S-2'] },
          { orderLineId: lineA, qty: 1.5, reasonCode: 'other', reasonNote: 'torn', serialNumbers: null },
        ],
      });
      expect(createPayloadHash('t-1', orderId, normalized)).toBe(golden);
      // Serial order does not change the fingerprint; line order does.
      const reordered = normalizeCreate({
        externalReference: 'EXT-1',
        lines: [
          { orderLineId: lineB, qty: 2, reasonCode: 'defective', serialNumbers: ['S-1', 'S-2'] },
          { orderLineId: lineA, qty: 1.5, reasonCode: 'other', reasonNote: 'torn' },
        ],
      });
      expect(createPayloadHash('t-1', orderId, reordered)).toBe(golden);
      const swapped = normalizeCreate({ externalReference: 'EXT-1', lines: [...reordered.lines].reverse().map((l) => ({ ...l })) });
      expect(createPayloadHash('t-1', orderId, swapped)).not.toBe(golden);
    });
  });

  // ── RLS: the database, not the app, keeps another client's RMAs out ───────

  describe('client isolation (wms_rls_probe)', () => {
    let probe: postgres.Sql<Record<string, unknown>>;

    beforeAll(async () => {
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
        await tx.unsafe('grant select, insert, update, delete on all tables in schema public to wms_rls_probe');
      });
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      probe = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    });

    afterAll(async () => {
      await probe?.end();
    });

    function stamped(client: string | null, run: (tx: postgres.TransactionSql<Record<string, unknown>>) => PromiseLike<unknown>): Promise<number> {
      return probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        if (client !== null) await tx`select set_config('app.client_id', ${client}, true)`;
        const rows = (await run(tx)) as { n: number }[];
        return Number(rows[0]!.n);
      }) as Promise<number>;
    }

    it("client B's portal-scoped session sees none of client A's RMAs or their lines; A's own session and an operator session see them", async () => {
      const [owned] = (await sql`select id, client_id from return_authorizations where tenant_id = ${tenantId} limit 1`) as unknown as {
        id: string;
        client_id: string;
      }[];
      const clientA = owned!.client_id;
      const clientB = uuidv7();
      const headers = (tx: postgres.TransactionSql<Record<string, unknown>>) =>
        tx`select count(*)::int as n from return_authorizations where id = ${owned!.id}`;
      const lines = (tx: postgres.TransactionSql<Record<string, unknown>>) =>
        tx`select count(*)::int as n from return_authorization_lines where rma_id = ${owned!.id}`;
      expect(await stamped(clientB, headers)).toBe(0);
      expect(await stamped(clientB, lines)).toBe(0);
      expect(await stamped(clientA, headers)).toBe(1);
      expect(await stamped(clientA, lines)).toBeGreaterThan(0);
      expect(await stamped(null, headers)).toBe(1);
      expect(await stamped(null, lines)).toBeGreaterThan(0);
      // Without a tenant stamp nothing is visible at all.
      const blind = await probe.begin(async (tx) => (await tx`select count(*)::int as n from return_authorizations`) as unknown as { n: number }[]);
      expect(Number(blind[0]!.n)).toBe(0);
    });
  });
});
