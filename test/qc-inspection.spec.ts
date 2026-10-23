import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { getLedgerEventType } from '../src/modules/inventory/ledger-registry';
import { QC_FAIL_REASONS, QC_HOLD_STATUSES } from '../src/modules/inbound/qc.command';
import { EVENT_ROUTES, SOURCE_RESOLUTIONS, decodeResolve } from '../src/modules/notifications/notification-sources';
import { NotificationsDeliveryHandler } from '../src/modules/notifications/notifications.delivery';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow } from './support/audit-guard';
import { createLinkedVendor } from './support/linked-vendor';

// Story 2-8a — the QC inspection outcome: an open hold (QC on receipt, or a
// manual scope hold) is inspected per held batch arm — passed units go back
// exactly as a release returns them, failed units move QC-HOLD → DAMAGED
// (`qc.failed`) with a reason, the hold closes `inspected` and the outcome
// is stored. Putaway and the awaiting-putaway tile net the failed units out;
// the notifications resolve as `inspected`; the failed units then follow
// 2-4a's DAMAGED rules (ATP-excluded, write-off only).
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
/** IST 2026-10-19 10:00. */
const OCCURRED_AT = '2026-10-19T04:30:00.000Z';

interface GoodsReceipt {
  id: string;
  code: string;
  lines: { id: string; skuId: string; qty: number; appliedQty: number; batchId: string | null }[];
  qcHeldLines?: number;
}

interface InspectLine {
  batchId: string | null;
  passed: number;
  failed: { reason: string; quantity: number }[];
}

describe('story 2-8a: the QC inspection outcome (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let inventory: InventoryFacade;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorToken: string;
  let wh: string;
  let zoneId: string;
  let storageBin: string;
  let qcClient: string;
  let plainClient: string;
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const sku = (code: string): string => {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('qc_inspection');
    app = await createApp(false);
    await app.init();
    inventory = app.get(InventoryFacade);
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `QCI Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;

    wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `QCI-${ulid().slice(20)}`, name: 'QCI warehouse' })
        .expect(201)
    ).body.id as string;
    zoneId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    storageBin = await newBin('A-01');

    for (const [code, name] of [
      ['QCI', 'QC Brand'],
      ['PLN', 'Plain Brand'],
    ] as const) {
      const res = await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name })
        .expect(201);
      if (code === 'QCI') qcClient = res.body.client.id as string;
      else plainClient = res.body.client.id as string;
    }
    await importSkus(qcClient, 'QCI', [
      ['QI-B', 'pcs', true],
      ['QI-U', 'pcs', false],
      ['QI-K', 'kg', false],
    ]);
    await importSkus(plainClient, 'PLN', [
      ['PM-U', 'pcs', false],
      ['PM-B', 'pcs', true],
    ]);
    await http()
      .put(`${API}/${tenantId}/clients/${qcClient}/receiving-policy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ receivingToleranceBps: 0, qcOnReceipt: true, expiryRequired: false, minShelfLifeDays: null })
      .expect(200);

    const operator = await createMember('operator');
    const ops = await createMember('ops_manager');
    const opsSignIn = await mintSignIn(app, { email: ops.email, password: 'correct-horse-battery' });
    opsToken = opsSignIn.body.accessToken as string;
    opsUserId = opsSignIn.body.user.id as string;
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'QCI dock', pin: '2468' })
      .expect(201);
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail: operator.email, pin: '2468' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
    await inventory.rebuildReservationCounters(tenantId, wh);
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

  async function newBin(code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, capacity: 100_000, type: 'shelf' })
        .expect(201)
    ).body.id as string;
  }

  async function importSkus(clientId: string, prefix: string, rows: readonly (readonly [string, string, boolean])[]): Promise<void> {
    const csv = [
      'sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked',
      ...rows.map(([code, uom, batch]) => `${code},${code} name,${uom},1800,${prefix}-${code}-BC,${batch},false`),
    ].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const stored = (await sql`select id, code from skus where tenant_id = ${tenantId} and client_id = ${clientId}`) as unknown as { id: string; code: string }[];
    for (const row of stored) skuIds.set(row.code, row.id);
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

  async function setQcOnReceipt(on: boolean): Promise<void> {
    await http()
      .put(`${API}/${tenantId}/clients/${qcClient}/receiving-policy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ receivingToleranceBps: 0, qcOnReceipt: on, expiryRequired: false, minShelfLifeDays: null })
      .expect(200);
  }

  function receive(lines: Record<string, unknown>[], clientId = qcClient): request.Test {
    return http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, occurredAt: OCCURRED_AT, poId: null, blindReasonCode: 'other', clientId, lines });
  }

  function grnLine(skuId: string, qty: number, batchCode: string | null = null, expiryDate?: string): Record<string, unknown> {
    return { skuId, batchCode, mfgDate: null, qty, ...(expiryDate === undefined ? {} : { expiryDate }) };
  }

  async function receiptHoldOf(grnLineId: string): Promise<string> {
    const rows = (await sql`select id from qc_holds where tenant_id = ${tenantId} and grn_line_id = ${grnLineId}`) as unknown as { id: string }[];
    if (rows[0] === undefined) throw new Error(`no receipt hold for ${grnLineId}`);
    return rows[0].id;
  }

  function inspect(holdId: string, body: Record<string, unknown>, key = ulid(), token = opsToken): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/receiving/qc-holds/${holdId}/inspect`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function release(holdId: string, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/receiving/qc-holds/${holdId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key);
  }

  async function placeManualHold(skuId: string, binId: string): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/receiving/qc-holds`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, skuId, binId, reason: 'suspect seal' })
      .expect(201);
    return res.body.qcHold.id as string;
  }

  function adjust(body: Record<string, unknown>): request.Test {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, reasonCode: 'found', note: 'seed', ...body });
  }

  async function onHandIn(binCode: 'RECEIVING' | 'QC-HOLD' | 'DAMAGED', skuId: string): Promise<number> {
    const rows = (await sql`
      select coalesce(sum(s.quantity), 0)::bigint as q
      from stock_on_hand s join bins b on b.id = s.bin_id
      where s.tenant_id = ${tenantId} and s.warehouse_id = ${wh} and s.sku_id = ${skuId}
        and b.code = ${binCode} and b.system_owned`) as unknown as { q: string }[];
    return Number(rows[0]!.q) / 1000;
  }

  async function onHandInBin(binId: string, skuId: string): Promise<number> {
    const rows = (await sql`select coalesce(sum(quantity), 0)::bigint as q from stock_on_hand where tenant_id = ${tenantId} and bin_id = ${binId} and sku_id = ${skuId}`) as unknown as {
      q: string;
    }[];
    return Number(rows[0]!.q) / 1000;
  }

  async function systemBin(code: 'DAMAGED' | 'RECEIVING' | 'QC-HOLD'): Promise<string> {
    const rows = (await sql`select id from bins where tenant_id = ${tenantId} and warehouse_id = ${wh} and code = ${code} and system_owned`) as unknown as { id: string }[];
    return rows[0]!.id;
  }

  async function events(holdId: string): Promise<{ type: string; quantity_delta: string; from_bin_id: string | null; to_bin_id: string | null; batch_ref: string | null; reference_doc: Record<string, unknown> }[]> {
    return (await sql`
      select type, quantity_delta::text as quantity_delta, from_bin_id, to_bin_id, batch_ref, reference_doc
      from ledger_events where tenant_id = ${tenantId} and reference_doc->>'holdId' = ${holdId}
      order by seq`) as never;
  }

  async function holdStatus(holdId: string): Promise<{ status: string; released_by: string | null }> {
    const rows = (await sql`select status, released_by from qc_holds where id = ${holdId}`) as unknown as { status: string; released_by: string | null }[];
    return rows[0]!;
  }

  async function inspectionCount(holdId: string): Promise<number> {
    const rows = (await sql`select count(*)::int as n from qc_inspections where tenant_id = ${tenantId} and hold_id = ${holdId}`) as unknown as { n: number }[];
    return rows[0]!.n;
  }

  async function putawayTasks(): Promise<{ grnLineId: string; qty: number }[]> {
    const res = await http().get(`${API}/${tenantId}/putaway/tasks?warehouseId=${wh}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    return (res.body.items ?? res.body) as { grnLineId: string; qty: number }[];
  }

  async function awaitingPutawayTile(): Promise<number> {
    const res = await http().get(`${API}/${tenantId}/warehouses/${wh}/reporting/overview`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    return (res.body as { tiles: { dockToStock: { awaitingPutaway: { value: number } } } }).tiles.dockToStock.awaitingPutaway.value;
  }

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

  async function notificationOf(sourceType: string, sourceId: string): Promise<Record<string, unknown> | undefined> {
    const res = await http().get(`${API}/${tenantId}/notifications?limit=100`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    return (res.body.items as Record<string, unknown>[]).find((item) => item.sourceType === sourceType && item.sourceId === sourceId);
  }

  // ── the acceptance case ────────────────────────────────────────────────────

  it('AC: a receipt hold of 10 on batch B inspected 7 pass / 3 fail damaged — Receiving +7, DAMAGED +3, QC-HOLD 0, ATP excludes the 3, hold inspected; putaway nets the 3 out beside an unheld same-batch line', async () => {
    const skuB = sku('QI-B');
    // A second, UNHELD line of the same (sku, batch) already in Receiving (QC off for it).
    await setQcOnReceipt(false);
    const unheld = (await receive([grnLine(skuB, 4, 'B-AC', '2027-06-30')]).expect(201)).body.goodsReceipt as GoodsReceipt;
    await setQcOnReceipt(true);
    const grn = (await receive([grnLine(skuB, 10, 'B-AC', '2027-06-30')]).expect(201)).body.goodsReceipt as GoodsReceipt;
    expect(grn.qcHeldLines).toBe(1);
    const holdId = await receiptHoldOf(grn.lines[0]!.id);
    const batchId = grn.lines[0]!.batchId!;
    expect(await onHandIn('QC-HOLD', skuB)).toBe(10);
    expect(await onHandIn('RECEIVING', skuB)).toBe(4);
    const atpBefore = await inventory.atp(tenantId, wh, skuB);
    await deliverOutbox('qc_hold.receipt_placed', 'grnId', grn.id);
    expect(await notificationOf('qc-receipt', grn.id)).toMatchObject({ resolution: null });

    // The detail read offers the arm with its code and expiry.
    const detail = await http().get(`${API}/${tenantId}/receiving/qc-holds/${holdId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(detail.body.arms).toEqual([{ batchId, batchCode: 'B-AC', expiryDate: '2027-06-30', quantity: 10 }]);
    expect(detail.body.inspection).toBeNull();
    expect(detail.body.qcHold).toMatchObject({ id: holdId, status: 'open', kind: 'receipt', grnId: grn.id, heldQty: 10, failedQuantity: null });

    const key = ulid();
    const body = { lines: [{ batchId, passed: 7, failed: [{ reason: 'damaged', quantity: 3 }] }] };
    const res = await inspect(holdId, body, key).expect(200);
    expect(res.body.qcHold).toMatchObject({ id: holdId, status: 'inspected', releasedBy: opsUserId, kind: 'receipt', grnLineId: grn.lines[0]!.id });
    expect(res.body.inspection).toMatchObject({
      holdId,
      note: null,
      inspectedBy: opsUserId,
      inspectedAt: res.body.qcHold.releasedAt,
      passedQuantity: 7,
      failedQuantity: 3,
      lines: [
        { batchId, outcome: 'passed', failReason: null, quantity: 7 },
        { batchId, outcome: 'failed', failReason: 'damaged', quantity: 3 },
      ],
    });

    expect(await onHandIn('RECEIVING', skuB)).toBe(4 + 7);
    expect(await onHandIn('DAMAGED', skuB)).toBe(3);
    expect(await onHandIn('QC-HOLD', skuB)).toBe(0);
    const atpAfter = await inventory.atp(tenantId, wh, skuB);
    expect(atpAfter.damaged - atpBefore.damaged).toBe(3000);
    // The 7 come back to Receiving (on-hand, still ATP — as a release does); the 3 never do.
    expect(atpAfter.atp - atpBefore.atp).toBe(7000);
    expect(await holdStatus(holdId)).toEqual({ status: 'inspected', released_by: opsUserId });
    const stored = (await sql`select l.batch_id, l.outcome, l.fail_reason, l.quantity::text as quantity from qc_inspection_lines l join qc_inspections i on i.id = l.inspection_id where i.hold_id = ${holdId} order by l.outcome desc`) as unknown as Record<string, unknown>[];
    expect(stored).toEqual([
      { batch_id: batchId, outcome: 'passed', fail_reason: null, quantity: '7000' },
      { batch_id: batchId, outcome: 'failed', fail_reason: 'damaged', quantity: '3000' },
    ]);

    // The ledger: qc.released for the 7, qc.failed QC-HOLD → DAMAGED for the 3.
    const qcBin = await systemBin('QC-HOLD');
    const damagedBin = await systemBin('DAMAGED');
    const receivingBin = await systemBin('RECEIVING');
    const moved = (await events(holdId)).filter((event) => event.type !== 'qc.held');
    expect(moved).toEqual([
      { type: 'qc.released', quantity_delta: '7000', from_bin_id: qcBin, to_bin_id: receivingBin, batch_ref: batchId, reference_doc: { kind: 'qc-hold', holdId, inspectionId: res.body.inspection.id } },
      {
        type: 'qc.failed',
        quantity_delta: '3000',
        from_bin_id: qcBin,
        to_bin_id: damagedBin,
        batch_ref: batchId,
        reference_doc: { kind: 'qc-hold', holdId, grnLineId: grn.lines[0]!.id, inspectionId: res.body.inspection.id },
      },
    ]);
    expect(getLedgerEventType('qc.failed')).toMatchObject({ sinceVersion: 1, referenceKinds: ['qc-hold'], allowsBatchArm: true, allowsSerialArm: false });

    // Putaway: the inspected line is work for its 7 only; the unheld line keeps its own 4; the tile agrees.
    const tasks = await putawayTasks();
    expect(tasks.find((task) => task.grnLineId === grn.lines[0]!.id)).toMatchObject({ qty: 7 });
    expect(tasks.find((task) => task.grnLineId === unheld.lines[0]!.id)).toMatchObject({ qty: 4 });
    expect(await awaitingPutawayTile()).toBe(tasks.length);
    // The placement bound: 8 of the inspected line is refused (only 7 remain there).
    const place = (qty: number) =>
      http()
        .post(`${API}/${tenantId}/putaway/placements`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, grnId: grn.id, grnLineId: grn.lines[0]!.id, skuId: skuB, batchId, qty, toBinId: storageBin, reasonCode: 'operator-preference', occurredAt: OCCURRED_AT });
    await place(8).expect(400);
    await place(7).expect((r) => expect([200, 201]).toContain(r.status));
    // (Task quantities pool per (sku, batch) on the Receiving on-hand — the 1-2b shape — so no further assertion here.)

    // The outbox and the receipt's notification (resolved as inspected).
    const inspected = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'qc_hold.inspected' and payload->>'holdId' = ${holdId}`) as unknown as { payload: Record<string, unknown> }[];
    expect(inspected.map((row) => row.payload)).toEqual([
      expect.objectContaining({
        holdId,
        warehouseId: wh,
        inspectionId: res.body.inspection.id,
        passedQuantity: 7,
        failedQuantity: 3,
        lines: [
          { batchId, outcome: 'passed', reason: null, quantity: '7' },
          { batchId, outcome: 'failed', reason: 'damaged', quantity: '3' },
        ],
        inspectedBy: opsUserId,
        kind: 'receipt',
      }),
    ]);
    await deliverOutbox('qc_hold.inspected', 'holdId', holdId);
    await deliverOutbox('qc_hold.receipt_cleared', 'placementId', grn.id);
    expect(await notificationOf('qc-receipt', grn.id)).toMatchObject({ resolution: 'inspected' });
    expect(await notificationOf('qc-hold', holdId)).toBeUndefined();

    // The audit row, then a replay re-serves the answer and writes nothing more.
    await expectAuditRow({ tenantId, key, action: 'qc_hold.inspected', targetType: 'qc_hold', targetId: holdId, actorUserId: opsUserId });
    const replay = await inspect(holdId, body, key).expect(200);
    expect(replay.body).toEqual(res.body);
    await expectAuditRow({ tenantId, key, action: 'qc_hold.inspected', targetType: 'qc_hold', targetId: holdId, actorUserId: opsUserId });
    expect(await inspectionCount(holdId)).toBe(1);
    // Same key, different body → 422.
    const reused = await inspect(holdId, { lines: [{ batchId, passed: 10, failed: [] }] }, key).expect(422);
    expect(reused.body.code).toBe('idempotency-key-reuse');

    // The reads: detail carries the inspection; the list filters inspected and closed.
    const after = await http().get(`${API}/${tenantId}/receiving/qc-holds/${holdId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(after.body.inspection).toEqual(res.body.inspection);
    expect(after.body.qcHold).toMatchObject({ status: 'inspected', failedQuantity: 3, heldQty: 10 });
    for (const status of ['inspected', 'closed'] as const) {
      const list = await http().get(`${API}/${tenantId}/receiving/qc-holds?warehouseId=${wh}&status=${status}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect((list.body.items as { id: string; failedQuantity: number | null }[]).find((item) => item.id === holdId)).toMatchObject({ failedQuantity: 3 });
    }
    const open = await http().get(`${API}/${tenantId}/receiving/qc-holds?warehouseId=${wh}&status=open`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect((open.body.items as { id: string }[]).some((item) => item.id === holdId)).toBe(false);

    // Already closed: a second inspection and a release both 409 qc-hold-released.
    const again = await inspect(holdId, { lines: [{ batchId, passed: 10, failed: [] }] }).expect(409);
    expect(again.body.code).toBe('qc-hold-released');
    expect(again.body.detail).toContain('already closed (inspected)');
    const released = await release(holdId).expect(409);
    expect(released.body.code).toBe('qc-hold-released');

    // Write-off after: the failed batch leaves DAMAGED by the 2-4a write-off, unchanged.
    await adjust({ skuId: skuB, binId: damagedBin, quantityDelta: -2, reasonCode: 'damaged', note: 'scrap QC fail', batch: { code: 'B-AC', overrideReason: 'QC fail write-off' } }).expect(201);
    expect(await onHandIn('DAMAGED', skuB)).toBe(1);
    const into = await adjust({ skuId: skuB, binId: damagedBin, quantityDelta: 1, batch: { code: 'B-AC' } }).expect(400);
    expect(into.body.code).toBe('damaged-bin-write-off-only');
    expect(into.body.detail).toContain('received damaged or failed at QC');
  });

  // ── the matrix ─────────────────────────────────────────────────────────────

  it('all pass on a MANUAL hold: units back to the origin, no qc.failed, the qc-hold entry resolves inspected', async () => {
    const skuU = sku('PM-U');
    await adjust({ skuId: skuU, binId: storageBin, quantityDelta: 6 }).expect(201);
    const holdId = await placeManualHold(skuU, storageBin);
    expect(await onHandInBin(storageBin, skuU)).toBe(0);
    await deliverOutbox('qc_hold.placed', 'holdId', holdId);
    const key = ulid();
    const res = await inspect(holdId, { lines: [{ batchId: null, passed: 6, failed: [] }], note: '  all good  ' }, key).expect(200);
    expect(res.body.qcHold).toMatchObject({ status: 'inspected' });
    expect(res.body.qcHold.kind).toBeUndefined();
    expect(res.body.inspection).toMatchObject({ note: 'all good', passedQuantity: 6, failedQuantity: 0, lines: [{ batchId: null, outcome: 'passed', failReason: null, quantity: 6 }] });
    expect(await onHandInBin(storageBin, skuU)).toBe(6);
    expect((await events(holdId)).map((event) => event.type)).toEqual(['qc.held', 'qc.released']);
    await deliverOutbox('qc_hold.inspected', 'holdId', holdId);
    expect(await notificationOf('qc-hold', holdId)).toMatchObject({ resolution: 'inspected' });
    await expectAuditRow({ tenantId, key, action: 'qc_hold.inspected', targetType: 'qc_hold', targetId: holdId, actorUserId: opsUserId });
  });

  it('mixed reasons in one batch, two batches: one qc.failed per arm, one row per (batch, outcome, reason)', async () => {
    const skuB = sku('PM-B');
    await adjust({ skuId: skuB, binId: storageBin, quantityDelta: 5, batch: { code: 'M-1' } }).expect(201);
    await adjust({ skuId: skuB, binId: storageBin, quantityDelta: 3, batch: { code: 'M-2' } }).expect(201);
    const batches = (await sql`select id, code from batches where tenant_id = ${tenantId} and sku_id = ${skuB}`) as unknown as { id: string; code: string }[];
    const m1 = batches.find((b) => b.code === 'M-1')!.id;
    const m2 = batches.find((b) => b.code === 'M-2')!.id;
    const holdId = await placeManualHold(skuB, storageBin);
    const res = await inspect(holdId, {
      lines: [
        { batchId: m2, passed: 0, failed: [{ reason: 'other', quantity: 3 }] },
        { batchId: m1, passed: 1, failed: [{ reason: 'expired', quantity: 2 }, { reason: 'contaminated', quantity: 2 }] },
      ],
      note: 'M-2 leaking',
    }).expect(200);
    const sorted = [m1, m2].sort();
    const lines = res.body.inspection.lines as { batchId: string; outcome: string; failReason: string | null; quantity: number }[];
    expect(lines.map((l) => [l.batchId, l.outcome, l.failReason, l.quantity])).toEqual(
      sorted[0] === m1
        ? [[m1, 'passed', null, 1], [m1, 'failed', 'contaminated', 2], [m1, 'failed', 'expired', 2], [m2, 'failed', 'other', 3]]
        : [[m2, 'failed', 'other', 3], [m1, 'passed', null, 1], [m1, 'failed', 'contaminated', 2], [m1, 'failed', 'expired', 2]],
    );
    const failed = (await events(holdId)).filter((event) => event.type === 'qc.failed');
    expect(failed.map((event) => [event.batch_ref, event.quantity_delta]).sort()).toEqual([[m1, '4000'], [m2, '3000']].sort());
    expect(failed.every((event) => event.reference_doc.grnLineId === undefined)).toBe(true); // a manual hold names no line
    expect(await onHandInBin(storageBin, skuB)).toBe(1);
    expect(await onHandIn('DAMAGED', skuB)).toBe(7);
    // `other` with its note, end to end: stored, read back by the detail, carried by the event.
    const detail = await http().get(`${API}/${tenantId}/receiving/qc-holds/${holdId}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(detail.body.inspection).toMatchObject({ note: 'M-2 leaking', failedQuantity: 7 });
    expect(detail.body.inspection.lines).toContainEqual({ batchId: m2, outcome: 'failed', failReason: 'other', quantity: 3 });
    const event = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'qc_hold.inspected' and payload->>'holdId' = ${holdId}`) as unknown as { payload: { lines: unknown[] } }[];
    expect(event[0]!.payload.lines).toContainEqual({ batchId: m2, outcome: 'failed', reason: 'other', quantity: '3' });
  });

  it('all fail: nothing goes to the origin — a RETIRED origin does not block it; one that passes units is 409 qc-hold-origin-bin-gone', async () => {
    const skuU = sku('PM-U');
    const doomed = await newBin('A-09');
    await adjust({ skuId: skuU, binId: doomed, quantityDelta: 4 }).expect(201);
    const holdId = await placeManualHold(skuU, doomed);
    await sql`update bins set retired_at = now(), retired_by = ${opsUserId} where id = ${doomed}`;
    const gone = await inspect(holdId, { lines: [{ batchId: null, passed: 1, failed: [{ reason: 'damaged', quantity: 3 }] }] }).expect(409);
    expect(gone.body.code).toBe('qc-hold-origin-bin-gone');
    expect(await holdStatus(holdId)).toMatchObject({ status: 'open' });
    expect(await inspectionCount(holdId)).toBe(0);
    await inspect(holdId, { lines: [{ batchId: null, passed: 0, failed: [{ reason: 'spec-failure', quantity: 4 }] }] }).expect(200);
    expect((await events(holdId)).map((event) => event.type)).toEqual(['qc.held', 'qc.failed']);
    expect(await holdStatus(holdId)).toMatchObject({ status: 'inspected' });
  });

  it('mismatch: a sum off the held arm, a missing arm, an extra batch — 422 qc-inspection-mismatch, nothing written', async () => {
    const skuB = sku('PM-B');
    const bin = await newBin('A-10');
    await adjust({ skuId: skuB, binId: bin, quantityDelta: 2, batch: { code: 'X-1' } }).expect(201);
    await adjust({ skuId: skuB, binId: bin, quantityDelta: 2, batch: { code: 'X-2' } }).expect(201);
    const ids = (await sql`select id, code from batches where tenant_id = ${tenantId} and sku_id = ${skuB} and code in ('X-1', 'X-2')`) as unknown as { id: string; code: string }[];
    const x1 = ids.find((b) => b.code === 'X-1')!.id;
    const x2 = ids.find((b) => b.code === 'X-2')!.id;
    const holdId = await placeManualHold(skuB, bin);
    const cases: InspectLine[][] = [
      [{ batchId: x1, passed: 1, failed: [] }, { batchId: x2, passed: 2, failed: [] }],
      [{ batchId: x1, passed: 2, failed: [] }],
      [{ batchId: x1, passed: 2, failed: [] }, { batchId: x2, passed: 2, failed: [] }, { batchId: uuidv7(), passed: 1, failed: [] }],
      [{ batchId: x1, passed: 2, failed: [] }, { batchId: null, passed: 2, failed: [] }],
    ];
    for (const lines of cases) {
      const res = await inspect(holdId, { lines }).expect(422);
      expect(res.body.code).toBe('qc-inspection-mismatch');
    }
    expect(await holdStatus(holdId)).toMatchObject({ status: 'open' });
    expect(await inspectionCount(holdId)).toBe(0);
    expect((await events(holdId)).map((event) => event.type)).toEqual(['qc.held', 'qc.held']);
    expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and response_snapshot->'inspection'->>'holdId' = ${holdId}`).toHaveLength(0);
  });

  it('shape and precision: 400 for a duplicate batch, a duplicate reason, `other` without a note, a long note, an unknown reason, a fractional each; 403 without qc.manage', async () => {
    const skuU = sku('PM-U');
    const bin = await newBin('A-11');
    await adjust({ skuId: skuU, binId: bin, quantityDelta: 3 }).expect(201);
    const holdId = await placeManualHold(skuU, bin);
    const bad: [Record<string, unknown>, string][] = [
      [{ lines: [{ batchId: null, passed: 1, failed: [] }, { batchId: null, passed: 2, failed: [] }] }, 'twice'],
      [{ lines: [{ batchId: null, passed: 1, failed: [{ reason: 'damaged', quantity: 1 }, { reason: 'damaged', quantity: 1 }] }] }, 'twice'],
      [{ lines: [{ batchId: null, passed: 2, failed: [{ reason: 'other', quantity: 1 }] }] }, 'needs a note'],
      [{ lines: [{ batchId: null, passed: 2, failed: [{ reason: 'other', quantity: 1 }] }], note: '   ' }, 'needs a note'],
      [{ lines: [{ batchId: null, passed: 3, failed: [] }], note: 'x'.repeat(501) }, '500'],
      [{ lines: [{ batchId: null, passed: 2, failed: [{ reason: 'smelly', quantity: 1 }] }] }, 'reason'],
      [{ lines: [{ batchId: null, passed: 2, failed: [{ quantity: 1 }] }] }, 'reason'],
      [{ lines: [] }, 'lines'],
      [{ lines: [{ batchId: null, passed: 2.5, failed: [{ reason: 'damaged', quantity: 0.5 }] }] }, 'precision'],
    ];
    for (const [body, hint] of bad) {
      const res = await inspect(holdId, body).expect(400);
      expect(res.body.code).toBe('validation-failed');
      if (hint === 'precision') expect(res.body.detail).toMatch(/whole number/);
    }
    // A note of exactly 500 (after trimming) is accepted; the reason `other` with it too.
    const operatorWeb = await createMember('operator');
    const opWeb = (await mintSignIn(app, { email: operatorWeb.email, password: 'correct-horse-battery' })).body.accessToken as string;
    const denied = await inspect(holdId, { lines: [{ batchId: null, passed: 3, failed: [] }] }, ulid(), opWeb).expect(403);
    expect(denied.body.code).toBe('role-denied');
    await inspect(holdId, { lines: [{ batchId: null, passed: 2, failed: [{ reason: 'other', quantity: 1 }] }], note: ` ${'n'.repeat(500)} ` }).expect(200);
    const unknown = await inspect(uuidv7(), { lines: [{ batchId: null, passed: 1, failed: [] }] }).expect(404);
    expect(unknown.body.code).toBe('not-found');
  });

  it('a fractional kg arm inspects at its precision (AD-9)', async () => {
    const skuK = sku('QI-K');
    const grn = (await receive([grnLine(skuK, 2.5)]).expect(201)).body.goodsReceipt as GoodsReceipt;
    const holdId = await receiptHoldOf(grn.lines[0]!.id);
    const res = await inspect(holdId, { lines: [{ batchId: null, passed: 1.75, failed: [{ reason: 'contaminated', quantity: 0.75 }] }] }).expect(200);
    expect(res.body.inspection).toMatchObject({ passedQuantity: 1.75, failedQuantity: 0.75 });
    expect(await onHandIn('DAMAGED', skuK)).toBe(0.75);
    expect((await putawayTasks()).find((task) => task.grnLineId === grn.lines[0]!.id)).toMatchObject({ qty: 1.75 });
  });

  /** The receipt's `qc_hold.receipt_cleared` payloads. */
  async function clearedOf(grnId: string): Promise<Record<string, unknown>[]> {
    const rows = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'qc_hold.receipt_cleared' and payload->>'placementId' = ${grnId}`) as unknown as {
      payload: Record<string, unknown>;
    }[];
    return rows.map((row) => row.payload);
  }

  it('a placement with any inspected hold resolves inspected — inspect one, then release the other', async () => {
    const grn = (await receive([grnLine(sku('QI-U'), 2), grnLine(sku('QI-B'), 3, 'B-TWO')]).expect(201)).body.goodsReceipt as GoodsReceipt;
    const [lineU, lineB] = [grn.lines.find((l) => l.skuId === sku('QI-U'))!, grn.lines.find((l) => l.skuId === sku('QI-B'))!];
    await inspect(await receiptHoldOf(lineB.id), { lines: [{ batchId: lineB.batchId, passed: 3, failed: [] }] }).expect(200);
    expect(await clearedOf(grn.id)).toHaveLength(0);
    await release(await receiptHoldOf(lineU.id)).expect(200);
    expect(await clearedOf(grn.id)).toEqual([{ placementId: grn.id, grnId: grn.id, warehouseId: wh, resolution: 'inspected' }]);
  });

  it('a placement with any inspected hold resolves inspected — release one, then inspect the other; only releases keep the 1-2b bytes', async () => {
    const grn = (await receive([grnLine(sku('QI-U'), 2), grnLine(sku('QI-B'), 3, 'B-THREE')]).expect(201)).body.goodsReceipt as GoodsReceipt;
    const [lineU, lineB] = [grn.lines.find((l) => l.skuId === sku('QI-U'))!, grn.lines.find((l) => l.skuId === sku('QI-B'))!];
    await release(await receiptHoldOf(lineU.id)).expect(200);
    expect(await clearedOf(grn.id)).toHaveLength(0);
    await inspect(await receiptHoldOf(lineB.id), { lines: [{ batchId: lineB.batchId, passed: 2, failed: [{ reason: 'expired', quantity: 1 }] }] }).expect(200);
    expect(await clearedOf(grn.id)).toEqual([{ placementId: grn.id, grnId: grn.id, warehouseId: wh, resolution: 'inspected' }]);
    // Releases only: no resolution key.
    const plain = (await receive([grnLine(sku('QI-U'), 1)]).expect(201)).body.goodsReceipt as GoodsReceipt;
    await release(await receiptHoldOf(plain.lines[0]!.id)).expect(200);
    expect(await clearedOf(plain.id)).toEqual([{ placementId: plain.id, grnId: plain.id, warehouseId: wh }]);
  });

  it('three places agree on failed units: task list, placement limit and awaiting-putaway tile (all-fail beside an unheld same-batch line, two inspected holds on one line incl. an over-receipt, a released hold)', async () => {
    const skuB = sku('QI-B');
    const BATCH = 'B-AGREE';
    // U — unheld, QC off.
    await setQcOnReceipt(false);
    const lineU = ((await receive([grnLine(skuB, 5, BATCH)]).expect(201)).body.goodsReceipt as GoodsReceipt).lines[0]!;
    await setQcOnReceipt(true);
    // A — all fail.
    const grnA = (await receive([grnLine(skuB, 4, BATCH)]).expect(201)).body.goodsReceipt as GoodsReceipt;
    const lineA = grnA.lines[0]!;
    await inspect(await receiptHoldOf(lineA.id), { lines: [{ batchId: lineA.batchId, passed: 0, failed: [{ reason: 'contaminated', quantity: 4 }] }] }).expect(200);
    // B — a PO line received 12 of 10: the applied 10 held at receipt, the approved excess 2 held at approval.
    const vendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: `V-${ulid().slice(20)}`, name: 'QCI Vendor', clientIds: [qcClient] });
    const po = await http()
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, vendorId, code: `PO-${ulid().slice(14)}`, lines: [{ skuId: skuB, orderedQty: 10, unitCostPaise: 100 }] })
      .expect(201);
    const grnB = (
      await http()
        .post(`${API}/${tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId: wh,
          occurredAt: OCCURRED_AT,
          poId: po.body.purchaseOrder.id,
          lines: [{ ...grnLine(skuB, 12, BATCH), poLineId: po.body.purchaseOrder.lines[0].id }],
        })
        .expect(201)
    ).body.goodsReceipt as GoodsReceipt;
    const lineB = grnB.lines[0]!;
    const pending = (await sql`select id from over_receipts where grn_id = ${grnB.id} and status = 'pending'`) as unknown as { id: string }[];
    await http().post(`${API}/${tenantId}/receiving/over-receipts/${pending[0]!.id}/approve`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(200);
    const holdsB = (await sql`select id, over_receipt_id from qc_holds where tenant_id = ${tenantId} and grn_line_id = ${lineB.id} order by over_receipt_id nulls first`) as unknown as {
      id: string;
      over_receipt_id: string | null;
    }[];
    expect(holdsB).toHaveLength(2);
    await inspect(holdsB[0]!.id, { lines: [{ batchId: lineB.batchId, passed: 6, failed: [{ reason: 'damaged', quantity: 4 }] }] }).expect(200);
    await inspect(holdsB[1]!.id, { lines: [{ batchId: lineB.batchId, passed: 1, failed: [{ reason: 'wrong-item', quantity: 1 }] }] }).expect(200);
    // C — released.
    const lineC = ((await receive([grnLine(skuB, 3, BATCH)]).expect(201)).body.goodsReceipt as GoodsReceipt).lines[0]!;
    await release(await receiptHoldOf(lineC.id)).expect(200);

    // The task list: U 5, A none (all failed), B 12 − 5 failed = 7, C 3.
    const tasks = await putawayTasks();
    const task = (id: string) => tasks.find((t) => t.grnLineId === id);
    expect(task(lineU.id)).toMatchObject({ qty: 5 });
    expect(task(lineA.id)).toBeUndefined();
    expect(task(lineB.id)).toMatchObject({ qty: 7 });
    expect(task(lineC.id)).toMatchObject({ qty: 3 });
    // The tile counts exactly the task list's lines (it would count A without its failed term).
    expect(await awaitingPutawayTile()).toBe(tasks.length);
    // The placement limit.
    const place = (grnId: string, line: GoodsReceipt['lines'][number], qty: number) =>
      http()
        .post(`${API}/${tenantId}/putaway/placements`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, grnId, grnLineId: line.id, skuId: skuB, batchId: line.batchId, qty, toBinId: storageBin, reasonCode: 'operator-preference', occurredAt: OCCURRED_AT });
    const refusedA = await place(grnA.id, lineA, 1).expect(400);
    expect(refusedA.body.detail).toContain('failed its QC inspection');
    await place(grnB.id, lineB, 8).expect(400);
    await place(grnB.id, lineB, 7).expect((r) => expect([200, 201]).toContain(r.status));
  });

  it('?status=closed returns released and inspected holds, never an open one', async () => {
    const skuU = sku('PM-U');
    const bin = await newBin('A-20');
    await adjust({ skuId: skuU, binId: bin, quantityDelta: 3 }).expect(201);
    const released = await placeManualHold(skuU, bin);
    await release(released).expect(200);
    // The released 3 are back in the bin: the second hold sweeps 3 + 2.
    await adjust({ skuId: skuU, binId: bin, quantityDelta: 2 }).expect(201);
    const inspected = await placeManualHold(skuU, bin);
    await inspect(inspected, { lines: [{ batchId: null, passed: 5, failed: [] }] }).expect(200);
    await adjust({ skuId: skuU, binId: bin, quantityDelta: 1 }).expect(201);
    const open = await placeManualHold(skuU, bin);
    const res = await http().get(`${API}/${tenantId}/receiving/qc-holds?warehouseId=${wh}&status=closed&limit=200`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    const items = res.body.items as { id: string; status: string }[];
    expect(items.find((i) => i.id === released)).toMatchObject({ status: 'released' });
    expect(items.find((i) => i.id === inspected)).toMatchObject({ status: 'inspected' });
    expect(items.some((i) => i.id === open)).toBe(false);
    expect(items.every((i) => i.status !== 'open')).toBe(true);
  });

  it('409 damaged-bin-conflict when a user location holds the DAMAGED code — nothing written', async () => {
    const w2 = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `QCJ-${ulid().slice(20)}`, name: 'QCI conflict warehouse' })
        .expect(201)
    ).body.id as string;
    const z2 = (
      await http().post(`${API}/${tenantId}/warehouses/${w2}/zones`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'B', name: 'B' }).expect(201)
    ).body.id as string;
    const b2 = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${w2}/zones/${z2}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'B-01', capacity: 1000, type: 'shelf' })
        .expect(201)
    ).body.id as string;
    // The pre-rule collision, below the API (create refuses the reserved code).
    await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned) values (${uuidv7()}, ${tenantId}, ${w2}, ${z2}, 'DAMAGED', 10000, 'shelf', false)`;
    const skuU = sku('PM-U');
    await http().post(`${API}/${tenantId}/inventory/adjustments`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ warehouseId: w2, skuId: skuU, binId: b2, quantityDelta: 2, reasonCode: 'found', note: 'seed' }).expect(201);
    const holdId = (
      await http().post(`${API}/${tenantId}/receiving/qc-holds`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ warehouseId: w2, skuId: skuU, binId: b2, reason: 'suspect' }).expect(201)
    ).body.qcHold.id as string;
    const res = await inspect(holdId, { lines: [{ batchId: null, passed: 1, failed: [{ reason: 'damaged', quantity: 1 }] }] }).expect(409);
    expect(res.body.code).toBe('damaged-bin-conflict');
    expect(await holdStatus(holdId)).toMatchObject({ status: 'open' });
    expect(await inspectionCount(holdId)).toBe(0);
    expect((await events(holdId)).map((e) => e.type)).toEqual(['qc.held']);
    // All-pass needs no DAMAGED bin and still inspects.
    await inspect(holdId, { lines: [{ batchId: null, passed: 2, failed: [] }] }).expect(200);
  });

  it('secure origin (12-3): an inspection that passes units back to a secure bin runs the gate and passes for a holder', async () => {
    const binSecure = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A-95', capacity: 1000, type: 'shelf', storageClass: 'secure' })
        .expect(201)
    ).body.id as string;
    const skuU = sku('PM-U');
    await adjust({ skuId: skuU, binId: binSecure, quantityDelta: 3 }).expect(201);
    const holdId = await placeManualHold(skuU, binSecure);
    await inspect(holdId, { lines: [{ batchId: null, passed: 2, failed: [{ reason: 'damaged', quantity: 1 }] }] }).expect(200);
    expect(await onHandInBin(binSecure, skuU)).toBe(2);
    const released = (await events(holdId)).find((e) => e.type === 'qc.released')!;
    expect(released.to_bin_id).toBe(binSecure);
  });

  it('the new routes: GET 404 for an unknown and for another tenant\'s hold; a malformed holdId is 400 on both', async () => {
    const unknown = await http().get(`${API}/${tenantId}/receiving/qc-holds/${uuidv7()}`).set('Authorization', `Bearer ${opsToken}`).expect(404);
    expect(unknown.body.code).toBe('not-found');
    const foreignTenant = uuidv7();
    const foreignHold = uuidv7();
    try {
      await sql`insert into qc_holds (id, tenant_id, warehouse_id, sku_id, bin_id, reason, status, held_by, held_at) values (${foreignHold}, ${foreignTenant}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 'foreign', 'open', ${uuidv7()}, now())`;
      const foreign = await http().get(`${API}/${tenantId}/receiving/qc-holds/${foreignHold}`).set('Authorization', `Bearer ${opsToken}`).expect(404);
      expect(foreign.body.code).toBe('not-found');
      const foreignInspect = await inspect(foreignHold, { lines: [{ batchId: null, passed: 1, failed: [] }] }).expect(404);
      expect(foreignInspect.body.code).toBe('not-found');
    } finally {
      await sql`delete from qc_holds where tenant_id = ${foreignTenant}`;
    }
    const badGet = await http().get(`${API}/${tenantId}/receiving/qc-holds/not-a-uuid`).set('Authorization', `Bearer ${opsToken}`).expect(400);
    expect(badGet.body.code).toBe('validation-failed');
    const badPost = await inspect('not-a-uuid', { lines: [{ batchId: null, passed: 1, failed: [] }] }).expect(400);
    expect(badPost.body.code).toBe('validation-failed');
  });

  it('a broken inspection record is a 500 data-fault, never a clean hold: no qc_inspections row, or no lines', async () => {
    const skuU = sku('PM-U');
    const bin = await newBin('A-21');
    await adjust({ skuId: skuU, binId: bin, quantityDelta: 2 }).expect(201);
    const holdId = await placeManualHold(skuU, bin);
    const res = await inspect(holdId, { lines: [{ batchId: null, passed: 1, failed: [{ reason: 'damaged', quantity: 1 }] }] }).expect(200);
    const inspectionId = res.body.inspection.id as string;
    const detail = () => http().get(`${API}/${tenantId}/receiving/qc-holds/${holdId}`).set('Authorization', `Bearer ${opsToken}`);
    const list = () => http().get(`${API}/${tenantId}/receiving/qc-holds?warehouseId=${wh}&status=inspected&limit=200`).set('Authorization', `Bearer ${opsToken}`);
    const parked = uuidv7();
    // No lines: move them to a parked inspection id, then back.
    await sql`update qc_inspection_lines set inspection_id = ${parked} where inspection_id = ${inspectionId}`;
    try {
      for (const read of [detail, list]) {
        const broken = await read().expect(500);
        expect(broken.body.code).toBe('data-fault');
        expect(broken.body.detail).toContain(holdId);
      }
    } finally {
      await sql`update qc_inspection_lines set inspection_id = ${inspectionId} where inspection_id = ${parked}`;
    }
    // No inspection row: point it at another hold, then back.
    await sql`update qc_inspections set hold_id = ${parked} where id = ${inspectionId}`;
    try {
      for (const read of [detail, list]) {
        const broken = await read().expect(500);
        expect(broken.body.code).toBe('data-fault');
      }
    } finally {
      await sql`update qc_inspections set hold_id = ${holdId} where id = ${inspectionId}`;
    }
    await detail().expect(200);
  });

  it('same-key race: two inspections parked on the hold lock answer the same body — one inspection, one key', async () => {
    const skuU = sku('PM-U');
    const bin = await newBin('A-12');
    await adjust({ skuId: skuU, binId: bin, quantityDelta: 2 }).expect(201);
    const holdId = await placeManualHold(skuU, bin);
    const key = ulid();
    const outcome = (res: request.Response): number | string => (res.status === 200 ? 200 : `${res.status} ${(res.body as { code?: string }).code}`);
    const [a, b] = await raceTwice(holdId, () => inspect(holdId, { lines: [{ batchId: null, passed: 1, failed: [{ reason: 'damaged', quantity: 1 }] }] }, key));
    expect([outcome(a), outcome(b)]).toEqual([200, 200]);
    expect(a.body).toEqual(b.body);
    expect(await inspectionCount(holdId)).toBe(1);
    expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
    expect((await events(holdId)).map((event) => event.type)).toEqual(['qc.held', 'qc.released', 'qc.failed']);
  });

  // ── vocabularies, RLS, notifications, contract ─────────────────────────────

  it('the status and fail-reason tuples mirror their DB CHECKs', async () => {
    const def = async (name: string): Promise<string> =>
      ((await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`) as unknown as { def: string }[])[0]!.def;
    const statuses = await def('qc_holds_status_check');
    for (const status of QC_HOLD_STATUSES) expect(statuses).toContain(`'${status}'`);
    expect(statuses.match(/'[a-z-]+'/g)).toHaveLength(QC_HOLD_STATUSES.length);
    const reasons = await def('qc_inspection_lines_outcome_check');
    for (const reason of QC_FAIL_REASONS) expect(reasons).toContain(`'${reason}'`);
    // The CHECK's literals: the two outcomes plus exactly the reasons.
    expect(new Set(reasons.match(/'[a-z-]+'/g))).toEqual(new Set(['passed', 'failed', ...QC_FAIL_REASONS].map((v) => `'${v}'`)));
  });

  it('RLS: both inspection tables are tenant-isolated (wms_rls_probe sees only its stamped tenant, cannot write another)', async () => {
    const foreign = uuidv7();
    const inspectionId = uuidv7();
    try {
      await sql`insert into qc_inspections (id, tenant_id, hold_id) values (${inspectionId}, ${foreign}, ${uuidv7()})`;
      await sql`insert into qc_inspection_lines (id, tenant_id, inspection_id, batch_id, outcome, fail_reason, quantity) values (${uuidv7()}, ${foreign}, ${inspectionId}, null, 'passed', null, 1000)`;
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        for (const table of ['qc_inspections', 'qc_inspection_lines']) {
          await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
          const hidden = await rls.unsafe(`select count(*)::int as n from ${table} where tenant_id = '${foreign}'::uuid`);
          expect(Number((hidden[0] as unknown as { n: number }).n)).toBe(0);
          await rls.unsafe(`select set_config('app.tenant_id', '${foreign}', false)`);
          const own = await rls.unsafe(`select count(*)::int as n from ${table}`);
          expect(Number((own[0] as unknown as { n: number }).n)).toBe(1);
        }
        await expect(
          rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            await tx`insert into qc_inspections (id, tenant_id, hold_id) values (${uuidv7()}, ${foreign}, ${uuidv7()})`;
          }),
        ).rejects.toThrow(/row-level security/i);
        await expect(
          rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            await tx`insert into qc_inspection_lines (id, tenant_id, inspection_id, outcome, quantity) values (${uuidv7()}, ${foreign}, ${inspectionId}, 'passed', 1000)`;
          }),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await rls.end();
      }
    } finally {
      await sql`delete from qc_inspection_lines where tenant_id = ${foreign}`;
      await sql`delete from qc_inspections where tenant_id = ${foreign}`;
    }
  });

  it('the notification sources: qc_hold.inspected resolves a manual hold as inspected and ignores a receipt hold; receipt_cleared reads its resolution', () => {
    expect(SOURCE_RESOLUTIONS['qc-hold']).toEqual(['released', 'inspected']);
    expect(SOURCE_RESOLUTIONS['qc-receipt']).toEqual(['released', 'inspected']);
    const holdId = '01900000-0000-7000-8000-0000000000c1';
    const warehouseId = '01900000-0000-7000-8000-0000000000c2';
    const inspected = EVENT_ROUTES.get('qc_hold.inspected');
    expect(decodeResolve(inspected as never, { holdId, warehouseId })).toMatchObject({ kind: 'resolve', sourceType: 'qc-hold', sourceId: holdId, resolution: 'inspected' });
    expect(decodeResolve(inspected as never, { holdId, warehouseId, kind: 'receipt' })).toEqual({ kind: 'ignore' });
    const cleared = EVENT_ROUTES.get('qc_hold.receipt_cleared');
    expect(decodeResolve(cleared as never, { placementId: holdId, grnId: holdId, warehouseId, resolution: 'inspected' })).toMatchObject({ resolution: 'inspected' });
    expect(decodeResolve(cleared as never, { placementId: holdId, grnId: holdId, warehouseId })).toMatchObject({ resolution: 'released' });
  });

  it('OpenAPI lists the inspect and detail routes', () => {
    const doc = JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const path = (p: string) => doc.paths[`/api/v1/tenants/{tenantId}${p}`] ?? doc.paths[`/tenants/{tenantId}${p}`] ?? {};
    expect(Object.keys(path('/receiving/qc-holds/{holdId}/inspect'))).toEqual(['post']);
    expect(Object.keys(path('/receiving/qc-holds/{holdId}'))).toEqual(['get']);
  });

  // ── the race helpers (the 21-11a pattern) ──────────────────────────────────

  const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

  async function waitParked(holderPid: number, min: number): Promise<void> {
    const probe = handle();
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active'
            and a.query ilike '%"qc_holds"%' and a.query ilike '%for update%'
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
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`fewer than ${min} request(s) parked on the qc_holds row`);
    } finally {
      await probe.end();
    }
  }

  async function raceTwice(holdId: string, send: () => SupertestTest): Promise<[request.Response, request.Response]> {
    const holder = handle();
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`select pg_backend_pid() as pid from qc_holds where tenant_id = ${tenantId} and id = ${holdId} for update`) as unknown as { pid: number }[];
        first = (async () => send())();
        second = (async () => send())();
        await waitParked(locked[0]!.pid, 2);
      });
      return await Promise.all([first!, second!]);
    } finally {
      await Promise.allSettled([first, second]);
      await holder.end();
    }
  }
});
