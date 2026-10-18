import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { istMidnightOf } from '../src/shared/primitives/time';
import {
  LINES_REFUSED_CODE_PRECEDENCE,
  REJECTED_GRN_LINE_CODES,
  istDaysBetween,
  refusedGrnLinesOpId,
  shelfLifeRefusedOpId,
  toleranceMilli,
} from '../src/modules/inbound/receiving.command';
import { QC_HOLD_KINDS } from '../src/modules/inbound/qc.command';
import { REJECTED_OP_DECISIONS_BY_TYPE } from '../src/modules/tenancy/sync-report.command';
import { SKU_NAMING_OP_TYPES } from '../src/modules/tenancy/client-wind-down';
import { EVENT_ROUTES, decodeRaise, decodeResolve } from '../src/modules/notifications/notification-sources';
import { NotificationsDeliveryHandler } from '../src/modules/notifications/notifications.delivery';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';

// Story 1-2b — the client receiving policy: the policy on the client row
// (read, full-replace write, the no-op, the field 400s), the receipt's
// tolerance, the five per-line expiry refusals and their two review rows
// (Accept anyway with a note re-runs the short-dated lines under the
// waiver), QC on receipt (line-scoped holds, the narrowed one-open-hold
// index, release-receipt, the notification events), putaway work net of
// held units, the old-op hash golden and the shared device golden cases.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
/** IST 2026-10-19 10:00 — every receipt's business date below is 2026-10-19 unless a test says otherwise. */
const OCCURRED_AT = '2026-10-19T04:30:00.000Z';

interface GrnLine {
  poLineId?: string | null;
  asnLineId?: string | null;
  skuId: string;
  batchCode: string | null;
  mfgDate: string | null;
  expiryDate?: string;
  qty: number;
}

interface RejectedLine {
  poLineId: string | null;
  skuId: string;
  qty: number;
  code: string;
  reason: string;
  index?: number;
  batchCode?: string | null;
  expiryDate?: string | null;
  minShelfLifeDays?: number;
}

interface GoodsReceipt {
  id: string;
  code: string;
  lines: { id: string; skuId: string; qty: number; appliedQty: number; excessQty: number; toleranceQty?: number; batchId: string | null }[];
  rejectedLines?: RejectedLine[];
  reviewOpId?: string;
  shelfLifeReviewOpId?: string;
  qcHeldLines?: number;
  qcSkippedLines?: number;
}

describe('story 1-2b: the client receiving policy (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let opsToken: string;
  let wh: string;
  let vendorId: string;
  let storageBinId: string;
  let selfClient: string;
  let deviceId: string;
  let operatorToken: string;
  let operatorUserId: string;
  /** client code → id */
  const clientIds = new Map<string, string>();
  /** `${clientCode}:${skuCode}` → id */
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const client = (code: string): string => {
    const id = clientIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture client ${code}`);
    return id;
  };
  const sku = (clientCode: string, code: string): string => {
    const id = skuIds.get(`${clientCode}:${code}`);
    if (id === undefined) throw new Error(`unknown fixture SKU ${clientCode}:${code}`);
    return id;
  };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('client_receiving_policy');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `CRP Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    const signedIn = await mintSignIn(app, { email, password: 'correct-horse-battery' });
    ownerToken = signedIn.body.accessToken as string;
    ownerUserId = signedIn.body.user.id as string;

    wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `CRP-${ulid().slice(20)}`, name: 'CRP warehouse' })
        .expect(201)
    ).body.id as string;
    const zoneId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    storageBinId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A-01', capacity: 100_000, type: 'shelf' })
        .expect(201)
    ).body.id as string;
    vendorId = (
      await http()
        .post(`${API}/${tenantId}/vendors`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'V-CRP', name: 'CRP Vendor' })
        .expect(201)
    ).body.vendor.id as string;

    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    for (const [code, name] of [
      ['TOL', 'Tolerance Brand'],
      ['EXP', 'Expiry Brand'],
      ['EXP0', 'Expired Brand'],
      ['QC', 'QC Brand'],
      ['PLAIN', 'Plain Brand'],
      ['GONE', 'Gone Brand'],
    ] as const) {
      clientIds.set(code, await createClient(code, name));
    }

    // code, uom, batch, serial
    await importSkus('TOL', [
      ['TOL-EA', 'pcs', false, false],
      ['TOL-KG', 'kg', false, false],
    ]);
    await importSkus('EXP', [
      ['EXP-B', 'pcs', true, false],
      ['EXP-U', 'pcs', false, false],
      ['EXP-K', 'pcs', true, false],
    ]);
    await importSkus('EXP0', [['EXP0-B', 'pcs', true, false]]);
    await importSkus('QC', [
      ['QC-A', 'pcs', false, false],
      ['QC-B', 'pcs', true, false],
      ['QC-SER', 'pcs', false, true],
    ]);
    await importSkus('PLAIN', [
      ['PL-B', 'pcs', true, false],
      ['PL-U', 'pcs', false, false],
    ]);
    await importSkus('GONE', [['GONE-1', 'pcs', false, false]]);

    const operator = await createMember('operator');
    const ops = await createMember('ops_manager');
    opsToken = (await mintSignIn(app, { email: ops.email, password: 'correct-horse-battery' })).body.accessToken as string;
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'CRP dock', pin: '2468' })
      .expect(201);
    deviceId = enrolled.body.device.id as string;
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail: operator.email, pin: '2468' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
    operatorUserId = badged.body.operator.id as string;

    // The policies under test (GONE departs: it has nothing open).
    await setPolicy('TOL', { receivingToleranceBps: 500, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null });
    await setPolicy('EXP', { receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: true, minShelfLifeDays: 90 });
    await setPolicy('EXP0', { receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: true, minShelfLifeDays: null });
    await setPolicy('QC', { receivingToleranceBps: 0, qcOnReceipt: true, expiryRequired: false, minShelfLifeDays: null });
    await http()
      .patch(`${API}/${tenantId}/clients/${client('GONE')}/status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ status: 'departed' })
      .expect(200);
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

  async function createClient(code: string, name: string): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/clients`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code, name })
      .expect(201);
    return res.body.client.id as string;
  }

  async function importSkus(clientCode: string, rows: readonly (readonly [string, string, boolean, boolean])[]): Promise<void> {
    const csv = [
      'sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked',
      ...rows.map(([code, uom, batch, serial]) => `${code},${code} name,${uom},1800,${clientCode}-${code}-BC,${batch},${serial}`),
    ].join('\n');
    const res = await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', client(clientCode))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    expect(res.body).toMatchObject({ committedRows: rows.length, failedRows: 0 });
    const stored = (await sql`select id, code from skus where tenant_id = ${tenantId} and client_id = ${client(clientCode)}`) as unknown as {
      id: string;
      code: string;
    }[];
    for (const row of stored) skuIds.set(`${clientCode}:${row.code}`, row.id);
  }

  async function createMember(role: 'ops_manager' | 'operator'): Promise<{ email: string }> {
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
    return { email };
  }

  interface Policy {
    receivingToleranceBps: number;
    qcOnReceipt: boolean;
    expiryRequired: boolean;
    minShelfLifeDays: number | null;
  }

  function putPolicy(clientId: string, body: Partial<Policy> | Record<string, unknown>, key = ulid(), token = ownerToken): request.Test {
    return http()
      .put(`${API}/${tenantId}/clients/${clientId}/receiving-policy`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function setPolicy(clientCode: string, policy: Policy): Promise<void> {
    await putPolicy(client(clientCode), policy).expect(200);
  }

  async function newPo(skuId: string, orderedQty: number): Promise<{ poId: string; lineId: string }> {
    const res = await http()
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, vendorId, code: `PO-${ulid().slice(14)}`, lines: [{ skuId, orderedQty, unitCostPaise: 100 }] })
      .expect(201);
    return { poId: res.body.purchaseOrder.id as string, lineId: res.body.purchaseOrder.lines[0].id as string };
  }

  function line(skuId: string, qty: number, extra: Partial<GrnLine> = {}): GrnLine {
    return { skuId, batchCode: null, mfgDate: null, qty, ...extra };
  }

  function receive(body: Record<string, unknown>, key = ulid()): request.Test {
    return http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: wh, occurredAt: OCCURRED_AT, ...body });
  }

  function blind(clientCode: string | null, lines: GrnLine[], extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { poId: null, blindReasonCode: 'other', ...(clientCode === null ? {} : { clientId: client(clientCode) }), lines, ...extra };
  }

  async function rejectedOp(opId: string): Promise<{
    id: string;
    opId: string;
    opType: string;
    decisions: string[];
    problemCode: string;
    problemDetail: string;
    status: string;
    payload: Record<string, unknown>;
  }> {
    const rows = (await sql`select id from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`) as unknown as { id: string }[];
    if (rows[0] === undefined) throw new Error(`no rejected op ${opId}`);
    const listed = await http()
      .get(`${API}/${tenantId}/rejected-ops`)
      .query({ limit: 200 })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return (listed.body.items as { id: string }[]).find((item) => item.id === rows[0]!.id) as never;
  }

  function resolve(rejectedOpId: string, body: Record<string, unknown>, key = ulid()): request.Test {
    return http()
      .post(`${API}/${tenantId}/rejected-ops/${rejectedOpId}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function batchExpiry(skuId: string, code: string): Promise<string | null> {
    const rows = (await sql`select expiry_date from batches where tenant_id = ${tenantId} and sku_id = ${skuId} and code = ${code}`) as unknown as {
      expiry_date: Date | null;
    }[];
    if (rows[0] === undefined) throw new Error(`no batch ${code}`);
    return rows[0].expiry_date === null ? null : rows[0].expiry_date.toISOString();
  }

  async function batchCount(skuId: string, code: string): Promise<number> {
    const rows = (await sql`select count(*)::int as n from batches where tenant_id = ${tenantId} and sku_id = ${skuId} and code = ${code}`) as unknown as {
      n: number;
    }[];
    return rows[0]!.n;
  }

  async function onHandInSystemBin(binCode: 'RECEIVING' | 'QC-HOLD', skuId: string): Promise<number> {
    const rows = (await sql`
      select coalesce(sum(s.quantity), 0)::bigint as q
      from stock_on_hand s join bins b on b.id = s.bin_id
      where s.tenant_id = ${tenantId} and s.warehouse_id = ${wh} and s.sku_id = ${skuId}
        and b.code = ${binCode} and b.system_owned`) as unknown as { q: string }[];
    return Number(rows[0]!.q) / 1000;
  }

  async function putawayTasks(): Promise<{ grnLineId: string; skuId: string; qty: number }[]> {
    const res = await http()
      .get(`${API}/${tenantId}/putaway/tasks?warehouseId=${wh}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return (res.body.items ?? res.body) as { grnLineId: string; skuId: string; qty: number }[];
  }

  async function outboxOf(type: string, field: string, value: string): Promise<Record<string, unknown>[]> {
    const rows = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = ${type} and payload->>${field} = ${value}`) as unknown as {
      payload: Record<string, unknown>;
    }[];
    return rows.map((row) => row.payload);
  }

  /** The Overview "awaiting putaway" tile — it must agree with the task list (§7f as amended). */
  async function awaitingPutawayTile(): Promise<number> {
    const res = await http()
      .get(`${API}/${tenantId}/warehouses/${wh}/reporting/overview`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return (res.body as { tiles: { dockToStock: { awaitingPutaway: { value: number } } } }).tiles.dockToStock.awaitingPutaway.value;
  }

  /** Delivers this tenant's outbox rows of `type` naming `value` to the notification projection (the relay is off in suites). */
  async function deliverOutbox(type: string, field: string, value: string): Promise<void> {
    const rows = (await sql`select id, payload, occurred_at from outbox_messages where tenant_id = ${tenantId} and type = ${type} and payload->>${field} = ${value}`) as unknown as {
      id: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }[];
    const delivery = app.get(NotificationsDeliveryHandler);
    for (const row of rows) {
      await delivery.deliver({ eventId: row.id, type, tenantId, occurredAt: row.occurred_at.toISOString(), payload: row.payload });
    }
  }

  async function notificationOf(sourceId: string): Promise<Record<string, unknown> | undefined> {
    const res = await http().get(`${API}/${tenantId}/notifications?limit=100`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    return (res.body.items as Record<string, unknown>[]).find((item) => item.sourceType === 'qc-receipt' && item.sourceId === sourceId);
  }

  async function openPutawayLines(): Promise<Set<string>> {
    return new Set((await putawayTasks()).map((task) => task.grnLineId));
  }

  // ── the shared golden cases (the device pins the same numbers) ───────────

  describe('golden cases shared with wms-mobile', () => {
    it('tolerance: ceiling = ordered + floor_to_uom_step(ordered × bps / 10000)', () => {
      // G1: 100 each at 5 % → 105.
      expect(100_000 + toleranceMilli(100_000, 500, 0)).toBe(105_000);
      // G2: 10 each at 5 % → 10 (0.5 floors to the unit step).
      expect(10_000 + toleranceMilli(10_000, 500, 0)).toBe(10_000);
      // G3: 2.5 kg at 3 % → 2.575 (a kg line steps by 1 g).
      expect(2_500 + toleranceMilli(2_500, 300, 3)).toBe(2_575);
      // The default policy never moves the ceiling.
      expect(toleranceMilli(100_000, 0, 0)).toBe(0);
      // Exact past 2^53 / bps (BigInt): no float drift.
      expect(toleranceMilli(9_000_000_000_000, 10_000, 3)).toBe(9_000_000_000_000);
    });

    it('shelf life: IST calendar days from the receipt date to the expiry', () => {
      const istDate = (instant: string) => new Date(Date.parse(instant) + 5.5 * 3_600_000).toISOString().slice(0, 10);
      // S1 / S2: the IST-midnight edge — one millisecond moves the receipt's date.
      expect(istDaysBetween(istDate('2026-10-18T18:29:59.999Z'), '2026-11-17')).toBe(30);
      expect(istDaysBetween(istDate('2026-10-18T18:30:00.000Z'), '2026-11-17')).toBe(29);
      // S3: exactly 90.
      expect(istDaysBetween(istDate('2026-10-19T04:30:00.000Z'), '2027-01-17')).toBe(90);
      // S4: expired yesterday.
      expect(istDaysBetween(istDate('2026-10-19T04:30:00.000Z'), '2026-10-18')).toBe(-1);
    });
  });

  // ── the policy surface ─────────────────────────────────────────────────────

  describe('the policy on the client row', () => {
    it('every client starts at the defaults — self included — and the read counts untracked SKUs', async () => {
      const self = await http()
        .get(`${API}/${tenantId}/clients/${selfClient}/receiving-policy`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200);
      expect(self.body).toEqual({
        clientId: selfClient,
        receivingToleranceBps: 0,
        qcOnReceipt: false,
        expiryRequired: false,
        minShelfLifeDays: null,
        untrackedSkuCount: 0,
      });
      const exp = await http()
        .get(`${API}/${tenantId}/clients/${client('EXP')}/receiving-policy`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200);
      // EXP-U is the one untracked SKU of three.
      expect(exp.body).toMatchObject({ expiryRequired: true, minShelfLifeDays: 90, untrackedSkuCount: 1 });
      // The clients list carries it too.
      const list = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      const tol = (list.body.items as { id: string; receivingPolicy?: unknown }[]).find((c) => c.id === client('TOL'));
      expect(tol!.receivingPolicy).toEqual({ receivingToleranceBps: 500, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null });
    });

    it('an owner replaces it whole; audited; a replay re-serves; the same policy again is a no-op that stores its key', async () => {
      const policy = { receivingToleranceBps: 250, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null };
      const key = ulid();
      const res = await putPolicy(client('PLAIN'), policy, key).expect(200);
      expect(res.body.client.receivingPolicy).toEqual(policy);
      await expectAuditRow({ tenantId, key, action: 'client.receiving_policy_updated', targetType: 'client', targetId: client('PLAIN'), actorUserId: ownerUserId });
      const replay = await putPolicy(client('PLAIN'), policy, key).expect(200);
      expect(replay.body).toEqual(res.body);
      await expectAuditRow({ tenantId, key, action: 'client.receiving_policy_updated', targetType: 'client', targetId: client('PLAIN'), actorUserId: ownerUserId });
      // The hash is over the bps integer: another value under the key is 422.
      await putPolicy(client('PLAIN'), { ...policy, receivingToleranceBps: 251 }, key).expect(422);

      const noOpKey = noOpIdempotencyKey(tenantId, ulid(), 'clients.receivingPolicy:unchanged');
      const unchanged = await putPolicy(client('PLAIN'), policy, noOpKey).expect(200);
      expect(unchanged.body.client.receivingPolicy).toEqual(policy);
      expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${noOpKey}`).toHaveLength(0);
      expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${noOpKey}`).toHaveLength(1);

      // Back to the defaults (the rest of the suite expects PLAIN default).
      await putPolicy(client('PLAIN'), { receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null }).expect(200);
    });

    it('each rule is a 400 validation-failed naming its field; nothing changes', async () => {
      const base = { receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null };
      // [body, field, refused by the command (a structured `field` member) or by the DTO]
      const cases: [Record<string, unknown>, string, boolean][] = [
        [{ ...base, receivingToleranceBps: 10_001 }, 'receivingToleranceBps', true],
        [{ ...base, receivingToleranceBps: -1 }, 'receivingToleranceBps', true],
        [{ ...base, receivingToleranceBps: 2.5 }, 'receivingToleranceBps', false],
        [{ ...base, expiryRequired: true, minShelfLifeDays: 0 }, 'minShelfLifeDays', true],
        [{ ...base, expiryRequired: true, minShelfLifeDays: 3651 }, 'minShelfLifeDays', true],
        [{ ...base, minShelfLifeDays: 30 }, 'minShelfLifeDays', true],
      ];
      for (const [body, field, byCommand] of cases) {
        const res = await putPolicy(client('PLAIN'), body).expect(400);
        expect(res.body.code).toBe('validation-failed');
        expect(res.body.detail).toContain(field);
        if (byCommand) expect(res.body.field).toBe(field);
      }
      const after = await http()
        .get(`${API}/${tenantId}/clients/${client('PLAIN')}/receiving-policy`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(after.body).toMatchObject(base);
    });

    it('only the owner writes (clients.manage); an unknown client is 404; a departed client\'s policy stays editable', async () => {
      const denied = await putPolicy(client('PLAIN'), { receivingToleranceBps: 0, qcOnReceipt: true, expiryRequired: false, minShelfLifeDays: null }, ulid(), opsToken).expect(403);
      expect(denied.body.code).toBe('role-denied');
      await putPolicy('01900000-0000-7000-8000-00000000abcd', { receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null }).expect(404);
      await http()
        .get(`${API}/${tenantId}/clients/01900000-0000-7000-8000-00000000abcd/receiving-policy`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      await putPolicy(client('GONE'), { receivingToleranceBps: 100, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null }).expect(200);
    });

    it('the device snapshot carries each client\'s policy', async () => {
      const res = await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      const exp = (res.body.clients as { id: string; receivingPolicy?: unknown }[]).find((c) => c.id === client('EXP'));
      expect(exp!.receivingPolicy).toEqual({ receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: true, minShelfLifeDays: 90 });
    });

    it('the CHECKs back the command (0078)', async () => {
      await expect(sql`update clients set min_shelf_life_days = 10 where id = ${client('PLAIN')}`).rejects.toMatchObject({
        constraint_name: 'clients_min_shelf_life_needs_expiry',
      });
      await expect(sql`update clients set receiving_tolerance_bps = 10001 where id = ${client('PLAIN')}`).rejects.toMatchObject({
        constraint_name: 'clients_receiving_tolerance_range',
      });
    });
  });

  // ── tolerance ──────────────────────────────────────────────────────────────

  describe('the receiving tolerance (PO and ASN lines of an open document)', () => {
    it('within tolerance: 104 of 100 at 5 % books at once — tolerance_qty 4, no over-receipt; openQty reads 0', async () => {
      const po = await newPo(sku('TOL', 'TOL-EA'), 100);
      const res = await receive({ poId: po.poId, lines: [line(sku('TOL', 'TOL-EA'), 104, { poLineId: po.lineId })] }).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines[0]).toMatchObject({ qty: 104, appliedQty: 104, excessQty: 0, toleranceQty: 4 });
      const stored = (await sql`select tolerance_qty from goods_receipt_lines where id = ${grn.lines[0]!.id}`) as unknown as { tolerance_qty: string }[];
      expect(Number(stored[0]!.tolerance_qty)).toBe(4_000);
      expect(await sql`select 1 from over_receipts where grn_id = ${grn.id}`).toHaveLength(0);
      const detail = await http()
        .get(`${API}/${tenantId}/inbound/purchase-orders/${po.poId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(detail.body.purchaseOrder.lines[0]).toMatchObject({ receivedQty: 104, openQty: 0 });
    });

    it('past tolerance: 108 of 100 → 105 books, 3 pend', async () => {
      const po = await newPo(sku('TOL', 'TOL-EA'), 100);
      const res = await receive({ poId: po.poId, lines: [line(sku('TOL', 'TOL-EA'), 108, { poLineId: po.lineId })] }).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines[0]).toMatchObject({ appliedQty: 105, excessQty: 3, toleranceQty: 5 });
      const pending = (await sql`select excess_qty from over_receipts where grn_id = ${grn.id} and status = 'pending'`) as unknown as { excess_qty: string }[];
      expect(pending.map((row) => Number(row.excess_qty))).toEqual([3_000]);
    });

    it('cumulative: 103 then 3 → the second applies 2 (G4) and 1 pends', async () => {
      const po = await newPo(sku('TOL', 'TOL-EA'), 100);
      await receive({ poId: po.poId, lines: [line(sku('TOL', 'TOL-EA'), 103, { poLineId: po.lineId })] }).expect(201);
      const second = (await receive({ poId: po.poId, lines: [line(sku('TOL', 'TOL-EA'), 3, { poLineId: po.lineId })] }).expect(201)).body
        .goodsReceipt as GoodsReceipt;
      expect(second.lines[0]).toMatchObject({ appliedQty: 2, excessQty: 1, toleranceQty: 2 });
    });

    it('the unit step floors: 10 each at 5 % → ceiling 10 (11 → 1 pends)', async () => {
      const po = await newPo(sku('TOL', 'TOL-EA'), 10);
      const grn = (await receive({ poId: po.poId, lines: [line(sku('TOL', 'TOL-EA'), 11, { poLineId: po.lineId })] }).expect(201)).body
        .goodsReceipt as GoodsReceipt;
      expect(grn.lines[0]).toMatchObject({ appliedQty: 10, excessQty: 1 });
      expect(grn.lines[0]!.toleranceQty).toBeUndefined();
    });

    it('a kg line steps by its precision: 2.5 kg at 5 % → 2.625', async () => {
      const po = await newPo(sku('TOL', 'TOL-KG'), 2.5);
      const grn = (await receive({ poId: po.poId, lines: [line(sku('TOL', 'TOL-KG'), 2.7, { poLineId: po.lineId })] }).expect(201)).body
        .goodsReceipt as GoodsReceipt;
      expect(grn.lines[0]).toMatchObject({ appliedQty: 2.625, excessQty: 0.075, toleranceQty: 0.125 });
    });

    it('an ASN line takes the tolerance too (announced 100 → 105)', async () => {
      const asn = await http()
        .post(`${API}/${tenantId}/inbound/asns`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ clientId: client('TOL'), warehouseId: wh, asnCode: `ASN-${ulid().slice(16)}`, lines: [{ skuId: sku('TOL', 'TOL-EA'), announcedQty: 100 }] })
        .expect(201);
      const asnId = asn.body.asn.id as string;
      const lineId = asn.body.asn.lines[0].id as string;
      const grn = (
        await receive({ asnId, lines: [line(sku('TOL', 'TOL-EA'), 106, { asnLineId: lineId, poLineId: null })] }).expect(201)
      ).body.goodsReceipt as GoodsReceipt;
      expect(grn.lines[0]).toMatchObject({ appliedQty: 105, excessQty: 1, toleranceQty: 5 });
      const read = await http().get(`${API}/${tenantId}/inbound/asns/${asnId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(read.body.asn.lines[0]).toMatchObject({ receivedQty: 105, openQty: 0 });
    });

    it('the default policy is the pre-1-2b fold: 104 of 100 → 100 books, 4 pend, no toleranceQty key', async () => {
      const po = await newPo(sku('PLAIN', 'PL-U'), 100);
      const grn = (await receive({ poId: po.poId, lines: [line(sku('PLAIN', 'PL-U'), 104, { poLineId: po.lineId })] }).expect(201)).body
        .goodsReceipt as GoodsReceipt;
      expect(grn.lines[0]).toEqual(expect.objectContaining({ appliedQty: 100, excessQty: 4 }));
      expect(Object.keys(grn.lines[0]!)).not.toContain('toleranceQty');
      expect(Object.keys(grn)).not.toEqual(expect.arrayContaining(['qcHeldLines']));
    });
  });

  // ── expiry ─────────────────────────────────────────────────────────────────

  describe('expiry on the line (per-line refusals)', () => {
    it('expiry required, a new batch with none: `expiry-required`, the rest books, a review row; no batch created', async () => {
      const key = ulid();
      const res = await receive(
        blind('EXP', [line(sku('EXP', 'EXP-B'), 5, { batchCode: 'B-MISS' }), line(sku('EXP', 'EXP-U'), 2)]),
        key,
      ).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines).toHaveLength(1);
      expect(grn.lines[0]!.skuId).toBe(sku('EXP', 'EXP-U'));
      expect(grn.rejectedLines).toEqual([
        expect.objectContaining({ code: 'expiry-required', index: 0, batchCode: 'B-MISS', expiryDate: null, skuId: sku('EXP', 'EXP-B'), qty: 5 }),
      ]);
      expect(grn.reviewOpId).toBe(refusedGrnLinesOpId(key));
      expect(grn.shelfLifeReviewOpId).toBeUndefined();
      expect(await batchCount(sku('EXP', 'EXP-B'), 'B-MISS')).toBe(0);
      const row = await rejectedOp(grn.reviewOpId!);
      expect(row).toMatchObject({ opType: 'grn.lines-refused', problemCode: 'expiry-required', decisions: ['discard'] });
      expect((row.payload.refusals as Record<string, unknown>[])[0]).toMatchObject({ reason: 'expiry-required', batchCode: 'B-MISS', expiryDate: null });
    });

    it('a batch that already has an expiry satisfies the rule; the same IST date at another instant is no mismatch', async () => {
      await receive(blind('EXP', [line(sku('EXP', 'EXP-B'), 1, { batchCode: 'B-OK', expiryDate: '2027-06-30' })])).expect(201);
      // Stored as the instant its IST date begins (18:30Z the day before).
      expect(await batchExpiry(sku('EXP', 'EXP-B'), 'B-OK')).toBe(istMidnightOf('2027-06-30'));
      expect(istMidnightOf('2027-06-30')).toBe('2027-06-29T18:30:00.000Z');
      const omitted = (await receive(blind('EXP', [line(sku('EXP', 'EXP-B'), 1, { batchCode: 'B-OK' })])).expect(201)).body
        .goodsReceipt as GoodsReceipt;
      expect(omitted.rejectedLines).toBeUndefined();
      const same = (await receive(blind('EXP', [line(sku('EXP', 'EXP-B'), 1, { batchCode: 'B-OK', expiryDate: '2027-06-30' })])).expect(201))
        .body.goodsReceipt as GoodsReceipt;
      expect(same.rejectedLines).toBeUndefined();
    });

    it('fill: an existing batch with a NULL expiry takes the line\'s; never overwritten after', async () => {
      // Make the null-expiry batch under the default policy (PLAIN, any client).
      await receive(blind('PLAIN', [line(sku('PLAIN', 'PL-B'), 1, { batchCode: 'B-FILL' })])).expect(201);
      expect(await batchExpiry(sku('PLAIN', 'PL-B'), 'B-FILL')).toBeNull();
      await receive(blind('PLAIN', [line(sku('PLAIN', 'PL-B'), 1, { batchCode: 'B-FILL', expiryDate: '2027-01-31' })])).expect(201);
      expect(await batchExpiry(sku('PLAIN', 'PL-B'), 'B-FILL')).toBe(istMidnightOf('2027-01-31'));
      // `batch-expiry-mismatch` applies to ANY client — a default-policy one too.
      const other = (await receive(blind('PLAIN', [line(sku('PLAIN', 'PL-B'), 1, { batchCode: 'B-FILL', expiryDate: '2027-02-28' })])).expect(201))
        .body as { goodsReceipt: null; refusedReceipt: { rejectedLines: RejectedLine[] } };
      expect(other.goodsReceipt).toBeNull();
      expect(other.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'batch-expiry-mismatch', expiryDate: '2027-02-28', batchCode: 'B-FILL' });
      expect(await batchExpiry(sku('PLAIN', 'PL-B'), 'B-FILL')).toBe(istMidnightOf('2027-01-31'));
    });

    it('intra-receipt: A (no expiry), B (X), C (Y) on one batch → A and B book with X; C `batch-expiry-mismatch`', async () => {
      const res = await receive(
        blind('EXP', [
          line(sku('EXP', 'EXP-K'), 1, { batchCode: 'B-ABC' }),
          line(sku('EXP', 'EXP-K'), 2, { batchCode: 'B-ABC', expiryDate: '2027-08-31' }),
          line(sku('EXP', 'EXP-K'), 3, { batchCode: 'B-ABC', expiryDate: '2027-09-30' }),
        ]),
      ).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines.map((l) => l.qty)).toEqual([1, 2]);
      expect(grn.rejectedLines).toEqual([expect.objectContaining({ code: 'batch-expiry-mismatch', index: 2, expiryDate: '2027-09-30' })]);
      expect(await batchExpiry(sku('EXP', 'EXP-K'), 'B-ABC')).toBe(istMidnightOf('2027-08-31'));
    });

    it('short: 60 IST days left against a 90-day minimum → `shelf-life-short`, its OWN review row (apply + discard)', async () => {
      const key = ulid();
      const res = await receive(
        blind('EXP', [line(sku('EXP', 'EXP-B'), 4, { batchCode: 'B-SHORT', expiryDate: '2026-12-18' }), line(sku('EXP', 'EXP-U'), 1)]),
        key,
      ).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines).toHaveLength(1);
      expect(grn.rejectedLines).toEqual([
        expect.objectContaining({ code: 'shelf-life-short', index: 0, batchCode: 'B-SHORT', expiryDate: '2026-12-18', minShelfLifeDays: 90 }),
      ]);
      expect(grn.reviewOpId).toBeUndefined();
      expect(grn.shelfLifeReviewOpId).toBe(shelfLifeRefusedOpId(key));
      expect(shelfLifeRefusedOpId(key)).not.toBe(refusedGrnLinesOpId(key));
      const row = await rejectedOp(grn.shelfLifeReviewOpId!);
      expect(row).toMatchObject({ opType: 'grn.shelf-life-refused', problemCode: 'shelf-life-short', decisions: ['apply', 'discard'] });
      expect(row.payload).toMatchObject({ warehouseId: wh, poId: null, blindReasonCode: 'other', clientId: client('EXP'), occurredAt: OCCURRED_AT, grnId: grn.id });
      expect(row.payload.lines).toEqual([
        { poLineId: null, skuId: sku('EXP', 'EXP-B'), batchCode: 'B-SHORT', mfgDate: null, expiryDate: '2026-12-18', qty: 4 },
      ]);
      expect((row.payload.refusals as Record<string, unknown>[])[0]).toMatchObject({ reason: 'shelf-life-short', remainingDays: 60, minShelfLifeDays: 90 });
      expect(await batchCount(sku('EXP', 'EXP-B'), 'B-SHORT')).toBe(0);
    });

    it('the edge: exactly 90 days books', async () => {
      const grn = (await receive(blind('EXP', [line(sku('EXP', 'EXP-B'), 1, { batchCode: 'B-EDGE', expiryDate: '2027-01-17' })])).expect(201))
        .body.goodsReceipt as GoodsReceipt;
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.lines[0]!.qty).toBe(1);
    });

    it('expired with no minimum: expiry required alone refuses a batch past its date (`shelf-life-short`, minimum 0)', async () => {
      const res = await receive(blind('EXP0', [line(sku('EXP0', 'EXP0-B'), 1, { batchCode: 'B-OLD', expiryDate: '2026-10-18' })])).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      expect(res.body.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'shelf-life-short', minShelfLifeDays: 0, expiryDate: '2026-10-18' });
      expect(res.body.refusedReceipt.shelfLifeReviewOpId).toBeDefined();
      expect(res.body.refusedReceipt.reviewOpId).toBeUndefined();
    });

    it('an expiry on an untracked SKU: `expiry-on-untracked`, the rest books', async () => {
      const grn = (
        await receive(blind('PLAIN', [line(sku('PLAIN', 'PL-U'), 1, { expiryDate: '2027-01-01' }), line(sku('PLAIN', 'PL-U'), 2)])).expect(201)
      ).body.goodsReceipt as GoodsReceipt;
      expect(grn.lines.map((l) => l.qty)).toEqual([2]);
      expect(grn.rejectedLines).toEqual([expect.objectContaining({ code: 'expiry-on-untracked', index: 0, expiryDate: '2027-01-01' })]);
      const row = await rejectedOp(grn.reviewOpId!);
      expect(row.problemCode).toBe('expiry-on-untracked');
    });

    it('an expiry before the line\'s mfg date: `expiry-before-mfg` (by IST date)', async () => {
      const res = await receive(
        blind('PLAIN', [line(sku('PLAIN', 'PL-B'), 1, { batchCode: 'B-MFG', mfgDate: '2026-10-01T00:00:00.000Z', expiryDate: '2026-09-30' })]),
      ).expect(201);
      expect(res.body.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'expiry-before-mfg', batchCode: 'B-MFG' });
    });

    it('a malformed expiry is a whole-op 400 (the request\'s shape)', async () => {
      const res = await receive(blind('PLAIN', [line(sku('PLAIN', 'PL-B'), 1, { batchCode: 'B-BAD', expiryDate: '2026-13-01' })])).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(res.body.detail).toContain('expiryDate');
    });

    it('mixed refusals: a departed client\'s line and a short-dated one raise TWO rows; the precedence keeps the departure', async () => {
      const key = ulid();
      // An older build's blind op (no clientId): every line books to its own SKU's client.
      const res = await receive(
        blind(null, [line(sku('GONE', 'GONE-1'), 1), line(sku('EXP', 'EXP-B'), 1, { batchCode: 'B-MIX', expiryDate: '2026-11-01' })]),
        key,
      ).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      const refused = res.body.refusedReceipt as { rejectedLines: RejectedLine[]; reviewOpId?: string; shelfLifeReviewOpId?: string };
      expect(refused.rejectedLines.map((l) => l.code)).toEqual(['client-departed', 'shelf-life-short']);
      // A client refusal's entry is unchanged by 1-2b (no index / batch keys).
      expect(Object.keys(refused.rejectedLines[0]!).sort()).toEqual(['code', 'poLineId', 'qty', 'reason', 'skuId']);
      expect((await rejectedOp(refused.reviewOpId!)).problemCode).toBe('client-departed');
      expect((await rejectedOp(refused.shelfLifeReviewOpId!)).problemCode).toBe('shelf-life-short');
      expect(LINES_REFUSED_CODE_PRECEDENCE[0]).toBe('client-departed');
    });

    it('Accept anyway: Apply without a note is 400 and the row stays open; with a note the short lines book under the waiver, audited', async () => {
      const res = await receive(blind('EXP', [line(sku('EXP', 'EXP-B'), 6, { batchCode: 'B-WAIVE', expiryDate: '2026-12-01' })])).expect(201);
      const opId = res.body.refusedReceipt.shelfLifeReviewOpId as string;
      const row = await rejectedOp(opId);

      const noNote = await resolve(row.id, { decision: 'apply' }).expect(400);
      expect(noNote.body.code).toBe('validation-failed');
      expect(noNote.body.detail).toContain('note');
      expect((await rejectedOp(opId)).status).toBe('open');
      await resolve(row.id, { decision: 'apply', note: '   ' }).expect(400);
      await resolve(row.id, { decision: 'recount', note: 'x' }).expect(409);

      const applied = await resolve(row.id, { decision: 'apply', note: 'Client approved short-dated stock by email' }).expect(200);
      expect(applied.body.rejectedOp.status).toBe('applied');
      expect(applied.body.outcome).toMatchObject({ kind: 'applied', note: 'Client approved short-dated stock by email' });
      const snapshot = (applied.body.outcome as { snapshot: { goodsReceipt: GoodsReceipt } }).snapshot.goodsReceipt;
      expect(snapshot.lines).toEqual([expect.objectContaining({ qty: 6, appliedQty: 6 })]);
      expect(snapshot.rejectedLines).toBeUndefined();
      expect(await batchExpiry(sku('EXP', 'EXP-B'), 'B-WAIVE')).toBe(istMidnightOf('2026-12-01'));
      // The re-run's key is the row's op id; the reviewer waived, the operator received.
      await expectAuditRow({
        tenantId,
        key: opId,
        action: 'goods_receipt.shelf_life_waived',
        targetType: 'goods_receipt',
        targetId: snapshot.id,
        actorUserId: ownerUserId,
        alongside: [{ action: 'goods_receipt.submitted', targetType: 'goods_receipt', targetId: snapshot.id, actorUserId: operatorUserId }],
      });
    });

    it('Discard closes a shelf-life row and books nothing', async () => {
      const res = await receive(blind('EXP', [line(sku('EXP', 'EXP-B'), 1, { batchCode: 'B-DISC', expiryDate: '2026-11-30' })])).expect(201);
      const row = await rejectedOp(res.body.refusedReceipt.shelfLifeReviewOpId as string);
      await resolve(row.id, { decision: 'discard' }).expect(200);
      expect(await batchCount(sku('EXP', 'EXP-B'), 'B-DISC')).toBe(0);
    });

    it('an older op (no expiryDate) hashes byte-for-byte as before; an expiry joins the line after mfgDate (goldens)', async () => {
      const occurredAt = '2026-10-19T05:00:00.000Z';
      const key = ulid();
      await receive(blind('PLAIN', [line(sku('PLAIN', 'PL-U'), 1)], { occurredAt }), key).expect(201);
      const golden =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${client('PLAIN')}","occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('PLAIN', 'PL-U')}","batchCode":null,"mfgDate":null,"qty":1}]}`;
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
      expect(stored[0]!.payload_hash).toBe(createHash('sha256').update(golden, 'utf8').digest('hex'));

      const key2 = ulid();
      await receive(blind('PLAIN', [line(sku('PLAIN', 'PL-B'), 1, { batchCode: 'B-GOLD', expiryDate: '2027-03-31' })], { occurredAt }), key2).expect(201);
      const golden2 =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${client('PLAIN')}","occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('PLAIN', 'PL-B')}","batchCode":"B-GOLD","mfgDate":null,"expiryDate":"2027-03-31","qty":1}]}`;
      const stored2 = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key2}`) as unknown as { payload_hash: string }[];
      expect(stored2[0]!.payload_hash).toBe(createHash('sha256').update(golden2, 'utf8').digest('hex'));
    });

    it('the vocabularies: the five codes, the two server-raised review types, wind-down reads the new type', () => {
      expect(REJECTED_GRN_LINE_CODES).toEqual(
        expect.arrayContaining(['expiry-on-untracked', 'expiry-before-mfg', 'batch-expiry-mismatch', 'expiry-required', 'shelf-life-short']),
      );
      expect(REJECTED_OP_DECISIONS_BY_TYPE['grn.shelf-life-refused']).toEqual(['apply', 'discard']);
      expect(REJECTED_OP_DECISIONS_BY_TYPE['grn.lines-refused']).toEqual(['discard']);
      expect(SKU_NAMING_OP_TYPES).toContain('grn.shelf-life-refused');
    });
  });

  // ── QC on receipt ──────────────────────────────────────────────────────────

  describe('QC on receipt', () => {
    it('two booked lines → two receipt holds, ONE event, ONE audit row; the units sit in QC-HOLD; no putaway work for either', async () => {
      const key = ulid();
      const before = await onHandInSystemBin('QC-HOLD', sku('QC', 'QC-A'));
      const res = await receive(blind('QC', [line(sku('QC', 'QC-A'), 3), line(sku('QC', 'QC-B'), 2, { batchCode: 'QB-1' })]), key).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.qcHeldLines).toBe(2);
      expect(grn.qcSkippedLines).toBeUndefined();
      const holds = (await sql`select id, kind, grn_line_id, over_receipt_id, status, bin_id, held_by from qc_holds where tenant_id = ${tenantId} and grn_line_id in ${sql(grn.lines.map((l) => l.id))}`) as unknown as {
        id: string;
        kind: string;
        grn_line_id: string;
        over_receipt_id: string | null;
        status: string;
        held_by: string;
      }[];
      expect(holds).toHaveLength(2);
      expect(holds.every((hold) => hold.kind === 'receipt' && hold.status === 'open' && hold.over_receipt_id === null && hold.held_by === operatorUserId)).toBe(true);
      expect(await onHandInSystemBin('QC-HOLD', sku('QC', 'QC-A'))).toBe(before + 3);
      const placed = await outboxOf('qc_hold.receipt_placed', 'grnId', grn.id);
      expect(placed).toEqual([expect.objectContaining({ placementId: grn.id, grnCode: grn.code, count: 2, warehouseId: wh })]);
      expect(await outboxOf('qc_hold.placed', 'skuId', sku('QC', 'QC-B'))).toHaveLength(0);
      await expectAuditRow({
        tenantId,
        key,
        action: 'qc_hold.receipt_placed',
        targetType: 'goods_receipt',
        targetId: grn.id,
        actorUserId: operatorUserId,
        alongside: [{ action: 'goods_receipt.submitted', targetType: 'goods_receipt', targetId: grn.id, actorUserId: operatorUserId }],
      });
      // ONE panel entry for the receipt, routed to qc.manage (the Ops Manager).
      await deliverOutbox('qc_hold.receipt_placed', 'grnId', grn.id);
      expect(await notificationOf(grn.id)).toMatchObject({ summary: { grnId: grn.id, grnCode: grn.code, count: 2 }, resolution: null });
      const open = await openPutawayLines();
      expect(grn.lines.some((l) => open.has(l.id))).toBe(false);
      expect(await awaitingPutawayTile()).toBe(open.size);

      // The list shows them as receipt holds with their GRN, client, batch and quantity.
      const list = await http()
        .get(`${API}/${tenantId}/receiving/qc-holds?grnId=${grn.id}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200);
      expect(list.body.items).toHaveLength(2);
      expect(list.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'receipt', grnId: grn.id, grnCode: grn.code, clientId: client('QC'), batchCode: 'QB-1', heldQty: 2 }),
          expect.objectContaining({ kind: 'receipt', grnId: grn.id, clientId: client('QC'), batchId: null, heldQty: 3 }),
        ]),
      );

      // Release receipt: all released in one call, the units become work, the entry resolves.
      const releaseKey = ulid();
      const released = await http()
        .post(`${API}/${tenantId}/receiving/qc-holds/release-receipt`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, releaseKey)
        .send({ grnId: grn.id })
        .expect(200);
      expect(released.body).toMatchObject({ grnId: grn.id, grnCode: grn.code });
      expect(released.body.qcHolds).toHaveLength(2);
      expect(released.body.qcHolds.every((h: { status: string; kind: string }) => h.status === 'released' && h.kind === 'receipt')).toBe(true);
      const opsUser = (await sql`select actor_user_id from audit_events where tenant_id = ${tenantId} and reference = ${releaseKey}`) as unknown as {
        actor_user_id: string;
      }[];
      await expectAuditRow({ tenantId, key: releaseKey, action: 'qc_hold.receipt_released', targetType: 'goods_receipt', targetId: grn.id, actorUserId: opsUser[0]!.actor_user_id });
      const reopened = await openPutawayLines();
      expect(grn.lines.every((l) => reopened.has(l.id))).toBe(true);
      expect(await awaitingPutawayTile()).toBe(reopened.size);
      expect(await outboxOf('qc_hold.receipt_cleared', 'placementId', grn.id)).toHaveLength(1);
      // The per-hold releases resolve no `qc-hold` entry (no tombstones); the receipt's entry resolves.
      await deliverOutbox('qc_hold.released', 'kind', 'receipt');
      await deliverOutbox('qc_hold.receipt_cleared', 'placementId', grn.id);
      expect(await notificationOf(grn.id)).toMatchObject({ resolution: 'released' });
      expect(await sql`select 1 from notifications where tenant_id = ${tenantId} and source_type = 'qc-hold'`).toHaveLength(0);
      // A replay re-serves; nothing more to release is a 409.
      const replay = await http()
        .post(`${API}/${tenantId}/receiving/qc-holds/release-receipt`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, releaseKey)
        .send({ grnId: grn.id })
        .expect(200);
      expect(replay.body).toEqual(released.body);
      const none = await http()
        .post(`${API}/${tenantId}/receiving/qc-holds/release-receipt`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ grnId: grn.id })
        .expect(409);
      expect(none.body.code).toBe('qc-hold-released');
    });

    it('a pooled batch: the held line shows no task; the earlier unheld line of the same (sku, batch) keeps its own', async () => {
      await setPolicy('QC', { receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null });
      const first = (await receive(blind('QC', [line(sku('QC', 'QC-B'), 5, { batchCode: 'QB-POOL' })])).expect(201)).body.goodsReceipt as GoodsReceipt;
      await setPolicy('QC', { receivingToleranceBps: 0, qcOnReceipt: true, expiryRequired: false, minShelfLifeDays: null });
      const held = (await receive(blind('QC', [line(sku('QC', 'QC-B'), 4, { batchCode: 'QB-POOL' })])).expect(201)).body.goodsReceipt as GoodsReceipt;
      expect(held.qcHeldLines).toBe(1);
      const tasks = await putawayTasks();
      expect(tasks.find((t) => t.grnLineId === first.lines[0]!.id)).toMatchObject({ qty: 5 });
      expect(tasks.find((t) => t.grnLineId === held.lines[0]!.id)).toBeUndefined();
      expect(await awaitingPutawayTile()).toBe(tasks.length);
      // The placement bound refuses the held line by name.
      const place = await http()
        .post(`${API}/${tenantId}/putaway/placements`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId: wh,
          grnId: held.id,
          grnLineId: held.lines[0]!.id,
          skuId: sku('QC', 'QC-B'),
          batchId: held.lines[0]!.batchId,
          qty: 1,
          toBinId: storageBinId,
          reasonCode: null,
          occurredAt: OCCURRED_AT,
        })
        .expect(400);
      expect(place.body.detail).toContain('QC-on-receipt hold');
      // …while the earlier unheld line of the same (sku, batch) places.
      await http()
        .post(`${API}/${tenantId}/putaway/placements`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId: wh,
          grnId: first.id,
          grnLineId: first.lines[0]!.id,
          skuId: sku('QC', 'QC-B'),
          batchId: first.lines[0]!.batchId,
          qty: 5,
          toBinId: storageBinId,
          reasonCode: 'operator-preference',
          occurredAt: OCCURRED_AT,
        })
        .expect((res) => expect([200, 201]).toContain(res.status));
    });

    it('QC + manual: a receipt hold beside an open MANUAL hold on (sku, Receiving); a second manual hold still 409s', async () => {
      const receiving = (await sql`select id from bins where tenant_id = ${tenantId} and warehouse_id = ${wh} and code = 'RECEIVING' and system_owned`) as unknown as { id: string }[];
      // An OPEN receipt hold of QC-A first (QC on) — it must not block a manual hold.
      const firstHeld = (await receive(blind('QC', [line(sku('QC', 'QC-A'), 1)])).expect(201)).body.goodsReceipt as GoodsReceipt;
      expect(firstHeld.qcHeldLines).toBe(1);
      // Unheld stock of QC-A in Receiving (the policy off for one receipt).
      await setPolicy('QC', { receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null });
      await receive(blind('QC', [line(sku('QC', 'QC-A'), 2)])).expect(201);
      await setPolicy('QC', { receivingToleranceBps: 0, qcOnReceipt: true, expiryRequired: false, minShelfLifeDays: null });
      const manual = (body: Record<string, unknown>) =>
        http()
          .post(`${API}/${tenantId}/receiving/qc-holds`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send(body);
      const unheldInReceiving = await onHandInSystemBin('RECEIVING', sku('QC', 'QC-A'));
      expect(unheldInReceiving).toBeGreaterThanOrEqual(2);
      await manual({ warehouseId: wh, skuId: sku('QC', 'QC-A'), binId: receiving[0]!.id, reason: 'manual on receiving' }).expect(201);
      const grn = (await receive(blind('QC', [line(sku('QC', 'QC-A'), 1)])).expect(201)).body.goodsReceipt as GoodsReceipt;
      expect(grn.qcHeldLines).toBe(1);
      // The receipt's units came in after the manual hold swept the scope:
      // it is the receipt hold, not a second manual one, that holds them.
      const again = await manual({ warehouseId: wh, skuId: sku('QC', 'QC-A'), binId: receiving[0]!.id, reason: 'second manual' }).expect(409);
      expect(again.body.code).toBe('qc-hold-open');
      const kinds = (await sql`select kind, count(*)::int as n from qc_holds where tenant_id = ${tenantId} and sku_id = ${sku('QC', 'QC-A')} and status = 'open' group by kind order by kind`) as unknown as {
        kind: string;
        n: number;
      }[];
      expect(kinds.find((k) => k.kind === 'manual')!.n).toBe(1);
      expect(kinds.find((k) => k.kind === 'receipt')!.n).toBeGreaterThanOrEqual(2);
      // The manual hold swept only the unheld Receiving units, never the receipt-held ones.
      const manualHeld = (await sql`
        select sum(abs(e.quantity_delta))::bigint as q from ledger_events e join qc_holds h on e.reference_doc->>'holdId' = h.id::text
        where h.tenant_id = ${tenantId} and h.kind = 'manual' and h.sku_id = ${sku('QC', 'QC-A')} and e.type = 'qc.held'`) as unknown as { q: string }[];
      expect(Number(manualHeld[0]!.q)).toBe(unheldInReceiving * 1000);
    });

    it('a serial-tracked line of a QC client books unheld and is counted (qcSkippedLines)', async () => {
      const grn = (await receive(blind('QC', [line(sku('QC', 'QC-SER'), 1)])).expect(201)).body.goodsReceipt as GoodsReceipt;
      expect(grn.qcSkippedLines).toBe(1);
      expect(grn.qcHeldLines).toBeUndefined();
      expect(await sql`select 1 from qc_holds where grn_line_id = ${grn.lines[0]!.id}`).toHaveLength(0);
    });

    it('an approved excess of a QC client is held too: its own hold naming the over-receipt, the approver as actor', async () => {
      const po = await newPo(sku('QC', 'QC-A'), 10);
      const grn = (await receive({ poId: po.poId, lines: [line(sku('QC', 'QC-A'), 12, { poLineId: po.lineId })] }).expect(201)).body
        .goodsReceipt as GoodsReceipt;
      expect(grn.qcHeldLines).toBe(1);
      const pending = (await sql`select id from over_receipts where grn_id = ${grn.id} and status = 'pending'`) as unknown as { id: string }[];
      const key = ulid();
      const approved = await http()
        .post(`${API}/${tenantId}/receiving/over-receipts/${pending[0]!.id}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, key)
        .expect(200);
      const holdId = approved.body.overReceipt.qcHoldId as string;
      expect(holdId).toBeDefined();
      const hold = (await sql`select kind, grn_line_id, over_receipt_id, held_by from qc_holds where id = ${holdId}`) as unknown as {
        kind: string;
        grn_line_id: string;
        over_receipt_id: string;
        held_by: string;
      }[];
      expect(hold[0]).toMatchObject({ kind: 'receipt', grn_line_id: grn.lines[0]!.id, over_receipt_id: pending[0]!.id, held_by: ownerUserId });
      await expectAuditRow({
        tenantId,
        key,
        action: 'qc_hold.receipt_placed',
        targetType: 'goods_receipt',
        targetId: grn.id,
        actorUserId: ownerUserId,
        alongside: [{ action: 'over_receipt.approved', targetType: 'over_receipt', targetId: pending[0]!.id, actorUserId: ownerUserId }],
      });
      expect(await outboxOf('qc_hold.receipt_placed', 'placementId', pending[0]!.id)).toHaveLength(1);
      // Neither the line's applied 10 nor the approved 2 is work while held.
      expect((await openPutawayLines()).has(grn.lines[0]!.id)).toBe(false);
      // Releasing the excess hold alone resolves ITS entry; the receipt's stays open.
      await http()
        .post(`${API}/${tenantId}/receiving/qc-holds/${holdId}/release`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .expect(200);
      expect(await outboxOf('qc_hold.receipt_cleared', 'placementId', pending[0]!.id)).toHaveLength(1);
      expect(await outboxOf('qc_hold.receipt_cleared', 'placementId', grn.id)).toHaveLength(0);
      const task = (await putawayTasks()).find((t) => t.grnLineId === grn.lines[0]!.id);
      expect(task).toMatchObject({ qty: 2 });
    });

    it('the notification source decodes one entry per placement and ignores a receipt hold\'s per-hold release', () => {
      const raise = EVENT_ROUTES.get('qc_hold.receipt_placed');
      expect(raise).toMatchObject({ arm: 'raise', sourceType: 'qc-receipt' });
      const grnId = '01900000-0000-7000-8000-0000000000a1';
      const warehouseId = '01900000-0000-7000-8000-0000000000b2';
      expect(decodeRaise(raise as never, { placementId: grnId, grnId, grnCode: 'GRN-0001', warehouseId, holdIds: [], count: 2 })).toMatchObject({
        sourceType: 'qc-receipt',
        sourceId: grnId,
        summary: { grnId, grnCode: 'GRN-0001', count: 2 },
      });
      const cleared = EVENT_ROUTES.get('qc_hold.receipt_cleared');
      expect(decodeResolve(cleared as never, { placementId: grnId, grnId, warehouseId })).toMatchObject({ kind: 'resolve', sourceId: grnId, resolution: 'released' });
      const released = EVENT_ROUTES.get('qc_hold.released');
      expect(decodeResolve(released as never, { holdId: grnId, warehouseId, kind: 'receipt' })).toEqual({ kind: 'ignore' });
      expect(decodeResolve(released as never, { holdId: grnId, warehouseId })).toMatchObject({ kind: 'resolve', sourceType: 'qc-hold' });
    });

    it('the hold kinds mirror the DB CHECK; the open-scope index names its narrowed predicate', async () => {
      const check = (await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'qc_holds_kind_check'`) as unknown as { def: string }[];
      for (const kind of QC_HOLD_KINDS) expect(check[0]!.def).toContain(`'${kind}'`);
      const index = (await sql`select indexdef from pg_indexes where indexname = 'qc_holds_open_scope_unique'`) as unknown as { indexdef: string }[];
      expect(index[0]!.indexdef).toContain("kind = 'manual'");
    });
  });

  // ── the contract ───────────────────────────────────────────────────────────

  it('OpenAPI lists the new routes', () => {
    const doc = JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.paths['/api/v1/tenants/{tenantId}/clients/{clientId}/receiving-policy'] ?? doc.paths['/tenants/{tenantId}/clients/{clientId}/receiving-policy'] ?? {}).sort()).toEqual(['get', 'put']);
    expect(doc.paths['/api/v1/tenants/{tenantId}/receiving/qc-holds/release-receipt'] ?? doc.paths['/tenants/{tenantId}/receiving/qc-holds/release-receipt']).toBeDefined();
  });
});
