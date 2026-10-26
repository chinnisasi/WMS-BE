import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ReceivingFacade } from '../src/modules/inbound/receiving.facade';
import { InboundFacade } from '../src/modules/inbound/inbound.facade';
import { ensureDamagedBinInTx } from '../src/modules/tenancy/receiving-bin';
import { DAMAGE_REASON_CODES, SHORT_REASON_CODES } from '../src/modules/inbound/receipt-condition';
import { getLedgerEventType } from '../src/modules/inventory/ledger-registry';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { createLinkedVendor, linkVendor } from './support/linked-vendor';

// Story 2-4a — damaged and short receipt quantities: each `grn.submit` line
// splits into good (`qty`), damaged (`damagedQty` + reason → the system
// DAMAGED bin, outside ATP, never crediting a document line) and short
// (`shortQty` + reason, recorded only). Every I/O-matrix row, the hash
// goldens (an old op byte for byte; a new op with all four fields), the ATP
// exclusion, the write-off and its refusals, an old payload re-applying, the
// reserved code and the ensure conflict, the lines route and the vocabularies.
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

interface GrnLine {
  poLineId?: string | null;
  skuId: string;
  batchCode: string | null;
  mfgDate: string | null;
  expiryDate?: string;
  qty: number;
  damagedQty?: number;
  damageReasonCode?: string;
  shortQty?: number;
  shortReasonCode?: string;
  weightsGrams?: number[];
}

interface GrnLineSnapshot {
  id: string;
  skuId: string;
  poLineId: string | null;
  qty: number;
  appliedQty: number;
  excessQty: number;
  damagedQty?: number;
  damageReasonCode?: string;
  shortQty?: number;
  shortReasonCode?: string;
}

interface GoodsReceipt {
  id: string;
  code: string;
  lines: GrnLineSnapshot[];
  rejectedLines?: Record<string, unknown>[];
  unmatchedLines?: { index: number; reason: string }[];
  shelfLifeReviewOpId?: string;
  reviewOpId?: string;
  qcHeldLines?: number;
}

describe('story 2-4a: damaged and short receipt quantities (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let inventory: InventoryFacade;

  let tenantId: string;
  let ownerToken: string;
  let wh: string;
  let vendorId: string;
  let deviceId: string;
  let operatorToken: string;
  let operatorUserId: string;
  const clientIds = new Map<string, string>();
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const client = (code: string): string => clientIds.get(code)!;
  const sku = (clientCode: string, code: string): string => {
    const id = skuIds.get(`${clientCode}:${code}`);
    if (id === undefined) throw new Error(`unknown fixture SKU ${clientCode}:${code}`);
    return id;
  };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('receipt_condition');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    inventory = app.get(InventoryFacade);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `RC Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    const signedIn = await mintSignIn(app, { email, password: 'correct-horse-battery' });
    ownerToken = signedIn.body.accessToken as string;

    wh = await createWarehouse('RC');
    await http()
      .post(`${API}/${tenantId}/warehouses/${wh}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Aisle A' })
      .expect(201);
    vendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: 'V-RC', name: 'RC Vendor' });

    for (const [code, name] of [
      ['PLAIN', 'Plain Brand'],
      ['OTHER', 'Other Brand'],
      ['QC', 'QC Brand'],
      ['EXP', 'Expiry Brand'],
    ] as const) {
      clientIds.set(code, await createClient(code, name));
    }
    // code, uom, batch, serial, catch weight
    await importSkus('PLAIN', [
      ['P-A', 'pcs', false, false, false],
      ['P-B', 'pcs', true, false, false],
      ['P-S', 'pcs', false, true, false],
      ['P-CW', 'pcs', false, false, true],
      ['P-ATP', 'pcs', false, false, false],
      ['P-OLD', 'pcs', false, false, false],
    ]);
    await importSkus('OTHER', [['O-A', 'pcs', false, false, false]]);
    await importSkus('QC', [['Q-A', 'pcs', false, false, false]]);
    await importSkus('EXP', [['E-B', 'pcs', true, false, false]]);

    const operator = await createMember('operator');
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'RC dock', pin: '2468' })
      .expect(201);
    deviceId = enrolled.body.device.id as string;
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail: operator.email, pin: '2468' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
    operatorUserId = badged.body.operator.id as string;

    await setPolicy('QC', { receivingToleranceBps: 0, qcOnReceipt: true, expiryRequired: false, minShelfLifeDays: null });
    await setPolicy('EXP', { receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: true, minShelfLifeDays: 90 });
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

  async function createWarehouse(prefix: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${prefix}-${ulid().slice(20)}`, name: `${prefix} warehouse` })
        .expect(201)
    ).body.id as string;
  }

  async function createClient(code: string, name: string): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/clients`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code, name })
      .expect(201);
    await linkVendor(app, tenantId, ownerToken, vendorId, res.body.client.id as string);
    return res.body.client.id as string;
  }

  async function importSkus(
    clientCode: string,
    rows: readonly (readonly [string, string, boolean, boolean, boolean])[],
  ): Promise<void> {
    const csv = [
      'sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked,catch_weight_tracked',
      ...rows.map(([code, uom, batch, serial, cw]) => `${code},${code} name,${uom},1800,${clientCode}-${code}-BC,${batch},${serial},${cw}`),
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

  async function setPolicy(
    clientCode: string,
    policy: { receivingToleranceBps: number; qcOnReceipt: boolean; expiryRequired: boolean; minShelfLifeDays: number | null },
  ): Promise<void> {
    await http()
      .put(`${API}/${tenantId}/clients/${client(clientCode)}/receiving-policy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send(policy)
      .expect(200);
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

  async function poLineReceived(lineId: string): Promise<number> {
    const rows = (await sql`select received_qty from purchase_order_lines where id = ${lineId}`) as unknown as { received_qty: string }[];
    return Number(rows[0]!.received_qty) / 1000;
  }

  function line(skuId: string, qty: number, extra: Partial<GrnLine> = {}): GrnLine {
    return { skuId, batchCode: null, mfgDate: null, qty, ...extra };
  }

  function damaged(n: number, reason = 'crushed'): Partial<GrnLine> {
    return { damagedQty: n, damageReasonCode: reason };
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

  async function count(query: PromiseLike<unknown>): Promise<number> {
    const rows = (await query) as { n: number | string }[];
    return Number(rows[0]!.n);
  }

  async function systemBin(code: 'DAMAGED' | 'RECEIVING' | 'QC-HOLD', warehouseId = wh): Promise<string | undefined> {
    const rows = (await sql`select id from bins where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and code = ${code} and system_owned`) as unknown as { id: string }[];
    return rows[0]?.id;
  }

  async function onHandIn(code: 'DAMAGED' | 'RECEIVING' | 'QC-HOLD', skuId: string): Promise<number> {
    return (
      (await count(sql`
        select coalesce(sum(s.quantity), 0)::bigint as n from stock_on_hand s join bins b on b.id = s.bin_id
        where s.tenant_id = ${tenantId} and s.warehouse_id = ${wh} and s.sku_id = ${skuId} and b.code = ${code} and b.system_owned`)) / 1000
    );
  }

  async function events(grnId: string, type: string): Promise<{ quantity_delta: string; to_bin_id: string; reference_doc: Record<string, unknown>; batch_ref: string | null }[]> {
    return (await sql`
      select quantity_delta::text as quantity_delta, to_bin_id, reference_doc, batch_ref from ledger_events
      where tenant_id = ${tenantId} and type = ${type} and reference_doc->>'grnId' = ${grnId}
      order by seq`) as never;
  }

  async function overReceiptCount(grnId: string): Promise<number> {
    return count(sql`select count(*)::int as n from over_receipts where tenant_id = ${tenantId} and grn_id = ${grnId}`);
  }

  async function storedLine(lineId: string): Promise<Record<string, unknown>> {
    const rows = (await sql`
      select qty::text, applied_qty::text, damaged_qty::text, damage_reason_code, short_qty::text, short_reason_code
      from goods_receipt_lines where id = ${lineId}`) as unknown as Record<string, unknown>[];
    return rows[0]!;
  }

  function adjust(body: Record<string, unknown>, key = ulid()): request.Test {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: wh, reasonCode: 'damaged', note: 'damaged write-off', ...body });
  }

  async function rejectedOp(opId: string): Promise<{ id: string; payload: Record<string, unknown> }> {
    const rows = (await sql`select id, payload from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`) as unknown as {
      id: string;
      payload: Record<string, unknown>;
    }[];
    if (rows[0] === undefined) throw new Error(`no rejected op ${opId}`);
    return rows[0];
  }

  // ── the I/O matrix ─────────────────────────────────────────────────────────

  describe('the I/O matrix', () => {
    it('split line: 90 good credit the PO (grn.received into Receiving), 10 damaged go to DAMAGED (grn.damaged); the line stays open 10', async () => {
      const po = await newPo(sku('PLAIN', 'P-A'), 100);
      const res = await receive({ poId: po.poId, lines: [line(sku('PLAIN', 'P-A'), 90, { poLineId: po.lineId, ...damaged(10) })] }).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines[0]).toMatchObject({ qty: 90, appliedQty: 90, excessQty: 0, damagedQty: 10, damageReasonCode: 'crushed', poLineId: po.lineId });
      expect(grn.lines[0]!.shortQty).toBeUndefined();
      expect(await poLineReceived(po.lineId)).toBe(90);
      const received = await events(grn.id, 'grn.received');
      expect(received.map((event) => event.quantity_delta)).toEqual(['90000']);
      expect(received[0]!.to_bin_id).toBe(await systemBin('RECEIVING'));
      const damagedEvents = await events(grn.id, 'grn.damaged');
      expect(damagedEvents.map((event) => event.quantity_delta)).toEqual(['10000']);
      const damagedBin = await systemBin('DAMAGED');
      expect(damagedEvents[0]!.to_bin_id).toBe(damagedBin);
      // The reference: the GRN, the header's PO (never a line) and the GRN line.
      expect(damagedEvents[0]!.reference_doc).toEqual({ kind: 'grn-receipt', grnId: grn.id, poId: po.poId, grnLineId: grn.lines[0]!.id });
      // grn.received is unchanged — no grnLineId key on it.
      expect(received[0]!.reference_doc).toEqual({ kind: 'grn-receipt', grnId: grn.id, poId: po.poId, poLineId: po.lineId });
      expect(await storedLine(grn.lines[0]!.id)).toEqual({
        qty: '90000',
        applied_qty: '90000',
        damaged_qty: '10000',
        damage_reason_code: 'crushed',
        short_qty: '0',
        short_reason_code: null,
      });
      // The DAMAGED bin is a system bin of the warehouse, staging, outside putaway.
      const bin = (await sql`select system_owned, type from bins where id = ${damagedBin!}`) as unknown as { system_owned: boolean; type: string }[];
      expect(bin[0]).toEqual({ system_owned: true, type: 'staging' });
      // The registry: grn.damaged opens the batch arm, closes the serial arm.
      expect(getLedgerEventType('grn.damaged')).toMatchObject({ sinceVersion: 1, referenceKinds: ['grn-receipt'], allowsBatchArm: true, allowsSerialArm: false });
    });

    it('all damaged on an open document: applied 0, no grn.received, no credit, no over-receipt, no unmatched entry; 5 → DAMAGED', async () => {
      const po = await newPo(sku('PLAIN', 'P-A'), 20);
      const before = await onHandIn('DAMAGED', sku('PLAIN', 'P-A'));
      const res = await receive({ poId: po.poId, lines: [line(sku('PLAIN', 'P-A'), 0, { poLineId: po.lineId, ...damaged(5, 'wet') })] }).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines[0]).toMatchObject({ qty: 0, appliedQty: 0, excessQty: 0, damagedQty: 5, damageReasonCode: 'wet' });
      expect(grn.unmatchedLines).toBeUndefined();
      expect(grn.rejectedLines).toBeUndefined();
      expect(await events(grn.id, 'grn.received')).toEqual([]);
      expect(await poLineReceived(po.lineId)).toBe(0);
      expect(await overReceiptCount(grn.id)).toBe(0);
      expect(await onHandIn('DAMAGED', sku('PLAIN', 'P-A'))).toBe(before + 5);
    });

    it('all damaged on a terminal (closed) PO: no over_receipts row (R1 — never an excess_qty 0 500); 5 → DAMAGED', async () => {
      const po = await newPo(sku('PLAIN', 'P-A'), 10);
      await http()
        .post(`${API}/${tenantId}/inbound/purchase-orders/${po.poId}/close`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ lines: [{ lineId: po.lineId, disposition: 'cancelled' }] })
        .expect(200);
      const res = await receive({
        poId: po.poId,
        lines: [line(sku('PLAIN', 'P-A'), 0, { poLineId: po.lineId, ...damaged(5) }), line(sku('PLAIN', 'P-A'), 2, { poLineId: po.lineId })],
      }).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      // The good line pends whole (21-9); the all-damaged line pends nothing.
      expect(await overReceiptCount(grn.id)).toBe(1);
      expect(grn.lines[0]).toMatchObject({ qty: 0, appliedQty: 0, damagedQty: 5 });
      expect((await events(grn.id, 'grn.damaged')).map((event) => event.quantity_delta)).toEqual(['5000']);
      expect(await events(grn.id, 'grn.received')).toEqual([]);
    });

    it('all damaged on a re-targeted PO (closed with an open successor): no over-receipt row; damage → DAMAGED naming the successor', async () => {
      const po = await newPo(sku('PLAIN', 'P-A'), 10);
      const closed = await http()
        .post(`${API}/${tenantId}/inbound/purchase-orders/${po.poId}/close`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ lines: [{ lineId: po.lineId, disposition: 'carried' }] })
        .expect(200);
      const successorId = closed.body.successor.id as string;
      // Two successor lines of no other SKU → this SKU's ONE open line; a line
      // of another SKU (zero candidates) would pend with no line — both 0 good.
      const res = await receive({
        poId: po.poId,
        lines: [line(sku('PLAIN', 'P-A'), 0, { poLineId: po.lineId, ...damaged(3) }), line(sku('OTHER', 'O-A'), 0, { poLineId: po.lineId, ...damaged(1) })],
      }).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt & { poId: string };
      expect(grn.poId).toBe(successorId);
      expect(await overReceiptCount(grn.id)).toBe(0);
      const damagedEvents = await events(grn.id, 'grn.damaged');
      expect(damagedEvents.map((event) => event.quantity_delta)).toEqual(['3000', '1000']);
      expect(damagedEvents.every((event) => event.reference_doc.poId === successorId && event.reference_doc.poLineId === undefined)).toBe(true);
    });

    it('all damaged, blind and unmatched: applied 0, damage → DAMAGED, no unmatched entry', async () => {
      const res = await receive(blind('PLAIN', [line(sku('PLAIN', 'P-A'), 0, damaged(2))])).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines[0]).toMatchObject({ qty: 0, appliedQty: 0, damagedQty: 2 });
      expect(await events(grn.id, 'grn.received')).toEqual([]);
      expect((await events(grn.id, 'grn.damaged')).map((event) => event.quantity_delta)).toEqual(['2000']);
      // No line reference on a PO receipt: an unmatched all-damaged line lists nothing.
      const po = await newPo(sku('PLAIN', 'P-A'), 5);
      const unmatched = await receive({ poId: po.poId, lines: [line(sku('PLAIN', 'P-A'), 0, damaged(2)), line(sku('PLAIN', 'P-A'), 1)] }).expect(201);
      expect((unmatched.body.goodsReceipt as GoodsReceipt).unmatchedLines).toEqual([{ index: 1, reason: 'no-line-reference' }]);
      expect(await poLineReceived(po.lineId)).toBe(0);
    });

    it('short only: 95 settle as today; short_qty 5 stored with its reason, no stock and no document effect', async () => {
      const po = await newPo(sku('PLAIN', 'P-A'), 100);
      const res = await receive({
        poId: po.poId,
        lines: [line(sku('PLAIN', 'P-A'), 95, { poLineId: po.lineId, shortQty: 5, shortReasonCode: 'not-shipped' })],
      }).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines[0]).toMatchObject({ qty: 95, appliedQty: 95, shortQty: 5, shortReasonCode: 'not-shipped' });
      expect(grn.lines[0]!.damagedQty).toBeUndefined();
      expect(await poLineReceived(po.lineId)).toBe(95);
      expect(await events(grn.id, 'grn.damaged')).toEqual([]);
      expect(await storedLine(grn.lines[0]!.id)).toMatchObject({ short_qty: '5000', short_reason_code: 'not-shipped', damaged_qty: '0', damage_reason_code: null });
    });

    it('over-receipt + damage: open 10, qty 12 + damaged 3 → 10 applied, 2 pend, 3 → DAMAGED', async () => {
      const po = await newPo(sku('PLAIN', 'P-A'), 10);
      const res = await receive({ poId: po.poId, lines: [line(sku('PLAIN', 'P-A'), 12, { poLineId: po.lineId, ...damaged(3, 'broken') })] }).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines[0]).toMatchObject({ qty: 12, appliedQty: 10, excessQty: 2, damagedQty: 3, damageReasonCode: 'broken' });
      const pending = (await sql`select excess_qty::text from over_receipts where grn_id = ${grn.id}`) as unknown as { excess_qty: string }[];
      expect(pending.map((row) => row.excess_qty)).toEqual(['2000']);
      expect((await events(grn.id, 'grn.damaged')).map((event) => event.quantity_delta)).toEqual(['3000']);
    });

    it('QC client: the hold moves the 8 applied; the 2 damaged go UNHELD into DAMAGED', async () => {
      const res = await receive(blind('QC', [line(sku('QC', 'Q-A'), 8, damaged(2, 'leaking'))])).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.qcHeldLines).toBe(1);
      expect(await onHandIn('QC-HOLD', sku('QC', 'Q-A'))).toBe(8);
      expect(await onHandIn('DAMAGED', sku('QC', 'Q-A'))).toBe(2);
      const held = (await sql`
        select coalesce(sum(quantity_delta), 0)::text as q from ledger_events
        where tenant_id = ${tenantId} and type = 'qc.held' and sku_id = ${sku('QC', 'Q-A')}`) as unknown as { q: string }[];
      expect(held[0]!.q).toBe('8000');
    });

    it('short-dated, all damaged (decision 6): min life 90 d, expiry 10 d away — books to DAMAGED, no shelf-life row', async () => {
      const res = await receive(
        blind('EXP', [line(sku('EXP', 'E-B'), 0, { batchCode: 'B-SD', expiryDate: '2026-10-29', ...damaged(4, 'pest') })]),
      ).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.shelfLifeReviewOpId).toBeUndefined();
      expect(grn.rejectedLines).toBeUndefined();
      const damagedEvents = await events(grn.id, 'grn.damaged');
      expect(damagedEvents.map((event) => event.quantity_delta)).toEqual(['4000']);
      // The batch arm rides the damaged intake.
      expect(damagedEvents[0]!.batch_ref).not.toBeNull();
      // The same line with ONE good unit is judged as before (refused short-dated).
      const judged = await receive(
        blind('EXP', [line(sku('EXP', 'E-B'), 1, { batchCode: 'B-SD', expiryDate: '2026-10-29', ...damaged(4, 'pest') })]),
      ).expect(201);
      expect(judged.body.goodsReceipt).toBeNull();
      expect(judged.body.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'shelf-life-short', qty: 1, damagedQty: 4, damageReasonCode: 'pest' });
    });

    it('refused mixed line: a sku-client-mismatch line goes to review WHOLE — rejectedLines and the row carry damagedQty; nothing of it books', async () => {
      const res = await receive(
        blind('PLAIN', [line(sku('PLAIN', 'P-A'), 1), line(sku('OTHER', 'O-A'), 3, { ...damaged(1, 'torn-packaging'), shortQty: 2, shortReasonCode: 'short-packed' })]),
      ).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.rejectedLines).toEqual([
        expect.objectContaining({
          code: 'sku-client-mismatch',
          qty: 3,
          damagedQty: 1,
          damageReasonCode: 'torn-packaging',
          shortQty: 2,
          shortReasonCode: 'short-packed',
        }),
      ]);
      expect(await events(grn.id, 'grn.damaged')).toEqual([]);
      const row = await rejectedOp(grn.reviewOpId!);
      expect((row.payload.lines as Record<string, unknown>[])[0]).toMatchObject({
        qty: 3,
        damagedQty: 1,
        damageReasonCode: 'torn-packaging',
        shortQty: 2,
        shortReasonCode: 'short-packed',
      });
    });

    it('refused mixed line, Apply: a short-dated line with damage goes to review whole; Accept re-books BOTH parts', async () => {
      const res = await receive(
        blind('EXP', [line(sku('EXP', 'E-B'), 3, { batchCode: 'B-MIX', expiryDate: '2026-11-01', ...damaged(1, 'wet') })]),
      ).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      const opId = res.body.refusedReceipt.shelfLifeReviewOpId as string;
      expect(res.body.refusedReceipt.rejectedLines[0]).toMatchObject({ qty: 3, damagedQty: 1, damageReasonCode: 'wet' });
      const row = await rejectedOp(opId);
      expect((row.payload.lines as Record<string, unknown>[])[0]).toMatchObject({ qty: 3, damagedQty: 1, damageReasonCode: 'wet' });
      const applied = await http()
        .post(`${API}/${tenantId}/rejected-ops/${row.id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'apply', note: 'Client accepts' })
        .expect(200);
      const snapshot = (applied.body.outcome as { snapshot: { goodsReceipt: GoodsReceipt } }).snapshot.goodsReceipt;
      expect(snapshot.lines[0]).toMatchObject({ qty: 3, appliedQty: 3, damagedQty: 1, damageReasonCode: 'wet' });
      expect((await events(snapshot.id, 'grn.received')).map((event) => event.quantity_delta)).toEqual(['3000']);
      expect((await events(snapshot.id, 'grn.damaged')).map((event) => event.quantity_delta)).toEqual(['1000']);
    });

    it('bad shape: every one a whole-op 400 validation-failed, nothing written', async () => {
      const grnsBefore = await count(sql`select count(*)::int as n from goods_receipt_notes where tenant_id = ${tenantId}`);
      const cases: [string, GrnLine][] = [
        ['damage without a reason', line(sku('PLAIN', 'P-A'), 1, { damagedQty: 1 })],
        ['a damage reason with 0', line(sku('PLAIN', 'P-A'), 1, { damagedQty: 0, damageReasonCode: 'wet' })],
        ['a damage reason alone', line(sku('PLAIN', 'P-A'), 1, { damageReasonCode: 'wet' })],
        ['a short without a reason', line(sku('PLAIN', 'P-A'), 1, { shortQty: 1 })],
        ['a short reason with 0', line(sku('PLAIN', 'P-A'), 1, { shortQty: 0, shortReasonCode: 'other' })],
        ['qty 0 with no damage', line(sku('PLAIN', 'P-A'), 0)],
        ['qty 0 short only', line(sku('PLAIN', 'P-A'), 0, { shortQty: 3, shortReasonCode: 'not-shipped' })],
        ['damage on a serial-tracked SKU', line(sku('PLAIN', 'P-S'), 1, damaged(1))],
        ['damage on a catch-weight SKU', line(sku('PLAIN', 'P-CW'), 1, { ...damaged(1), weightsGrams: [1000] })],
        ['damage at an each-precision fraction', line(sku('PLAIN', 'P-A'), 1, damaged(0.5))],
      ];
      for (const [label, bad] of cases) {
        const res = await receive(blind('PLAIN', [bad]));
        expect(`${label}: ${res.status} ${String(res.body.code)}`).toBe(`${label}: 400 validation-failed`);
      }
      // The DTO tier: an unknown code, a negative value, one over the maximum.
      for (const [label, bad] of [
        ['an unknown damage code', line(sku('PLAIN', 'P-A'), 1, { damagedQty: 1, damageReasonCode: 'dented' })],
        ['an unknown short code', line(sku('PLAIN', 'P-A'), 1, { shortQty: 1, shortReasonCode: 'stolen' })],
        ['a negative damaged', line(sku('PLAIN', 'P-A'), 1, { damagedQty: -1, damageReasonCode: 'wet' })],
        ['a negative qty', line(sku('PLAIN', 'P-A'), -1, damaged(1))],
        ['damage over the maximum', line(sku('PLAIN', 'P-A'), 1, { damagedQty: 1e13, damageReasonCode: 'wet' })],
      ] as const) {
        const res = await receive(blind('PLAIN', [bad]));
        expect(`${label}: ${res.status} ${String(res.body.code)}`).toBe(`${label}: 400 validation-failed`);
      }
      // Decision 9 refuses the whole op even when the serial line would also be client-refused.
      const mixed = await receive(blind('OTHER', [line(sku('PLAIN', 'P-S'), 1, damaged(1)), line(sku('OTHER', 'O-A'), 1)]));
      expect(mixed.status).toBe(400);
      expect(mixed.body.detail).toContain('serial-tracked');
      expect(await count(sql`select count(*)::int as n from goods_receipt_notes where tenant_id = ${tenantId}`)).toBe(grnsBefore);
    });
  });

  // ── the write-off ──────────────────────────────────────────────────────────

  describe('the write-off out of DAMAGED', () => {
    it('a −4 write-off of a named batch: stock.adjusted out of DAMAGED, ATP unchanged — an EXPIRED batch included', async () => {
      const skuB = sku('PLAIN', 'P-B');
      // An expired batch (PLAIN requires no expiry, so it books): 6 damaged.
      await receive(blind('PLAIN', [line(skuB, 0, { batchCode: 'B-EXPIRED', expiryDate: '2025-01-01', ...damaged(6, 'crushed') })])).expect(201);
      const damagedBin = (await systemBin('DAMAGED'))!;
      const atpBefore = await inventory.atp(tenantId, wh, skuB);
      expect(atpBefore.damaged).toBe(6000);
      const res = await adjust({ skuId: skuB, binId: damagedBin, quantityDelta: -4, batch: { code: 'B-EXPIRED', overrideReason: 'damaged write-off' } }).expect(201);
      expect(JSON.stringify(res.body)).toContain('stock.adjusted');
      expect(await onHandIn('DAMAGED', skuB)).toBe(2);
      const batchLeft = await count(sql`
        select coalesce(sum(b.quantity), 0)::bigint as n from batch_on_hand b join batches bt on bt.id = b.batch_id
        where b.tenant_id = ${tenantId} and b.bin_id = ${damagedBin} and bt.code = 'B-EXPIRED'`);
      expect(batchLeft).toBe(2000);
      const atpAfter = await inventory.atp(tenantId, wh, skuB);
      expect(atpAfter.atp).toBe(atpBefore.atp);
      expect(atpAfter.damaged).toBe(2000);
    });

    it('over the threshold the write-off pends (202) and applies on approval', async () => {
      const skuA = sku('PLAIN', 'P-A');
      const damagedBin = (await systemBin('DAMAGED'))!;
      await http()
        .put(`${API}/${tenantId}/inventory/adjustment-policies`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ quantityThreshold: 2 })
        .expect(200);
      const before = await onHandIn('DAMAGED', skuA);
      const pended = await adjust({ skuId: skuA, binId: damagedBin, quantityDelta: -3 }).expect(202);
      const pendingId = pended.body.pendingAdjustment.id as string;
      expect(await onHandIn('DAMAGED', skuA)).toBe(before);
      await http()
        .post(`${API}/${tenantId}/inventory/adjustment-pendings/${pendingId}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(200);
      expect(await onHandIn('DAMAGED', skuA)).toBe(before - 3);
      await sql`delete from stock_adjustment_policies where tenant_id = ${tenantId}`;
    });

    it('a + adjustment on DAMAGED is 400 damaged-bin-write-off-only; so is a positive pend approved after the guard', async () => {
      const skuA = sku('PLAIN', 'P-A');
      const damagedBin = (await systemBin('DAMAGED'))!;
      const into = await adjust({ skuId: skuA, binId: damagedBin, quantityDelta: 4 }).expect(400);
      expect(into.body.code).toBe('damaged-bin-write-off-only');
      // A positive pend that predates the rule (seeded below the API): its
      // approval re-runs the guard set and is refused, the row stays pending.
      const owner = (await sql`select id from users where tenant_id = ${tenantId} and role = 'owner' limit 1`) as unknown as { id: string }[];
      const pendingId = uuidv7();
      await sql`
        insert into stock_adjustment_pendings (id, tenant_id, warehouse_id, bin_id, sku_id, quantity_milli, reason_code, note, occurred_at, requested_by, requested_at, status, threshold_quantity_at_request)
        values (${pendingId}, ${tenantId}, ${wh}, ${damagedBin}, ${skuA}, 4000, 'found', 'seeded before the rule', now(), ${owner[0]!.id}, now(), 'pending', 2)`;
      const approved = await http()
        .post(`${API}/${tenantId}/inventory/adjustment-pendings/${pendingId}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(400);
      expect(approved.body.code).toBe('damaged-bin-write-off-only');
      const status = (await sql`select status from stock_adjustment_pendings where id = ${pendingId}`) as unknown as { status: string }[];
      expect(status[0]!.status).toBe('pending');
      // DAMAGED cannot be a QC hold origin.
      const held = await http()
        .post(`${API}/${tenantId}/receiving/qc-holds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, skuId: skuA, binId: damagedBin, reason: 'inspect' })
        .expect(400);
      expect(held.body.detail).toContain('DAMAGED');
    });
  });

  // ── ATP ────────────────────────────────────────────────────────────────────

  it('ATP, reservations and the channel-visible figure exclude DAMAGED; the ledger replays to the projections', async () => {
    const skuX = sku('PLAIN', 'P-ATP');
    await receive(blind('PLAIN', [line(skuX, 5, damaged(10, 'crushed'))])).expect(201);
    const atp = await inventory.atp(tenantId, wh, skuX);
    expect(atp.onHand).toBe(15_000);
    expect(atp.damaged).toBe(10_000);
    expect(atp.atp).toBe(5_000);
    expect(atp.atp).toBe(Math.max(0, atp.onHand - atp.reserved - atp.qcHeld - atp.inTransit - atp.returnsAwaiting - atp.damaged));
    const visible = await inventory.channelVisibleQuantity(tenantId, wh, skuX, uuidv7());
    expect(visible.damaged).toBe(10_000);
    expect(visible.poolAtp).toBe(5_000);
    // An order for 6 reserves the 5 sellable units and backorders the sixth —
    // the 10 damaged are never granted.
    const order = await http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, lines: [{ skuId: skuX, quantity: 6 }], destination: testAddress() })
      .expect(201);
    expect(JSON.stringify(order.body)).toMatch(/backorder/i);
    const replay = await inventory.replay(tenantId, wh);
    expect(replay.divergences).toEqual([]);
    expect(replay.matches).toBe(true);
  });

  // ── the hash, old payloads, the review rows ────────────────────────────────

  describe('the hash and old payloads', () => {
    it('a pre-2-4a op hashes byte for byte as before; a 0 damaged/short hashes as absent (goldens)', async () => {
      const occurredAt = '2026-10-19T05:00:00.000Z';
      const golden =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${client('PLAIN')}","occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('PLAIN', 'P-OLD')}","batchCode":null,"mfgDate":null,"qty":1}]}`;
      const digest = createHash('sha256').update(golden, 'utf8').digest('hex');
      const key = ulid();
      await receive(blind('PLAIN', [line(sku('PLAIN', 'P-OLD'), 1)], { occurredAt }), key).expect(201);
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
      expect(stored[0]!.payload_hash).toBe(digest);
      // Explicit zeros and nulls are the same act: the same hash.
      const key2 = ulid();
      await receive(
        blind('PLAIN', [line(sku('PLAIN', 'P-OLD'), 1, { damagedQty: 0, damageReasonCode: null as never, shortQty: 0, shortReasonCode: null as never })], { occurredAt }),
        key2,
      ).expect(201);
      const stored2 = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key2}`) as unknown as { payload_hash: string }[];
      expect(stored2[0]!.payload_hash).toBe(digest);
    });

    it('a 2-4a op with all four fields hashes them after weightsGrams, damage then short (golden)', async () => {
      const occurredAt = '2026-10-19T05:30:00.000Z';
      const key = ulid();
      await receive(
        blind('PLAIN', [line(sku('PLAIN', 'P-OLD'), 2, { ...damaged(1, 'wet'), shortQty: 3, shortReasonCode: 'lost-in-transit' })], { occurredAt }),
        key,
      ).expect(201);
      const golden =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${client('PLAIN')}","occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('PLAIN', 'P-OLD')}","batchCode":null,"mfgDate":null,"qty":2,` +
        `"damagedQty":1,"damageReasonCode":"wet","shortQty":3,"shortReasonCode":"lost-in-transit"}]}`;
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
      expect(stored[0]!.payload_hash).toBe(createHash('sha256').update(golden, 'utf8').digest('hex'));
      // A same-key replay re-serves the snapshot; another damage is 422.
      const replayed = await receive(
        blind('PLAIN', [line(sku('PLAIN', 'P-OLD'), 2, { ...damaged(1, 'wet'), shortQty: 3, shortReasonCode: 'lost-in-transit' })], { occurredAt }),
        key,
      ).expect(201);
      expect((replayed.body.goodsReceipt as GoodsReceipt).lines[0]).toMatchObject({ damagedQty: 1, shortQty: 3 });
      await receive(blind('PLAIN', [line(sku('PLAIN', 'P-OLD'), 2, { ...damaged(2, 'wet') })], { occurredAt }), key).expect(422);
    });

    it('an old stored payload (no condition keys, no weightsGrams) re-applies through the facade exactly as before (R5)', async () => {
      const receiving = app.get(ReceivingFacade);
      const snapshot = await receiving.submitGoodsReceipt(
        {
          tenantId,
          deviceId,
          operatorUserId,
          warehouseId: wh,
          poId: null,
          blindReasonCode: 'other',
          clientId: client('PLAIN'),
          occurredAt: OCCURRED_AT,
          // A raw stored line, as the sync-report rebuild passes it.
          lines: [{ poLineId: null, skuId: sku('PLAIN', 'P-OLD'), batchCode: null, mfgDate: null, qty: 2 } as never],
        },
        ulid(),
      );
      const grn = (snapshot as unknown as { goodsReceipt: GoodsReceipt }).goodsReceipt;
      expect(grn.lines[0]).toEqual(expect.objectContaining({ qty: 2, appliedQty: 2 }));
      expect(Object.keys(grn.lines[0]!)).not.toEqual(expect.arrayContaining(['damagedQty']));
      expect(await storedLine(grn.lines[0]!.id)).toMatchObject({ damaged_qty: '0', damage_reason_code: null, short_qty: '0', short_reason_code: null });
    });

    it('a pre-2-4a review row (lines without the keys) is byte-identical and its Apply books as before', async () => {
      const res = await receive(blind('EXP', [line(sku('EXP', 'E-B'), 2, { batchCode: 'B-OLDROW', expiryDate: '2026-11-02' })])).expect(201);
      const row = await rejectedOp(res.body.refusedReceipt.shelfLifeReviewOpId as string);
      expect(Object.keys((row.payload.lines as Record<string, unknown>[])[0]!).sort()).toEqual(['batchCode', 'expiryDate', 'mfgDate', 'poLineId', 'qty', 'skuId']);
      const applied = await http()
        .post(`${API}/${tenantId}/rejected-ops/${row.id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'apply', note: 'ok' })
        .expect(200);
      const snapshot = (applied.body.outcome as { snapshot: { goodsReceipt: GoodsReceipt } }).snapshot.goodsReceipt;
      expect(snapshot.lines[0]).toMatchObject({ qty: 2, appliedQty: 2 });
      expect(snapshot.lines[0]!.damagedQty).toBeUndefined();
    });
  });

  // ── the bin code ───────────────────────────────────────────────────────────

  it('DAMAGED is reserved at create (409 reserved-location-code); a pre-rule collision is 409 damaged-bin-conflict at ensure — and blocks only damage', async () => {
    const db = app.get<Database>(DATABASE);
    const other = await createWarehouse('DB');
    const zone = (
      await http().post(`${API}/${tenantId}/warehouses/${other}/zones`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'Z', name: 'Z' }).expect(201)
    ).body.id as string;
    const bin = await http()
      .post(`${API}/${tenantId}/warehouses/${other}/zones/${zone}/bins`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ capacity: 10, type: 'shelf', code: 'DAMAGED' })
      .expect(409);
    expect(bin.body.code).toBe('reserved-location-code');
    expect(bin.body.detail).toContain('damaged');
    const zoneRes = await http()
      .post(`${API}/${tenantId}/warehouses/${other}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'DAMAGED', name: 'Our damaged' })
      .expect(409);
    expect(zoneRes.body.code).toBe('reserved-location-code');

    // A collision that predates the rule (seeded below the API).
    await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned) values (${uuidv7()}, ${tenantId}, ${other}, ${zone}, 'DAMAGED', 10000, 'shelf', false)`;
    await expect(withTenantTransaction(db, tenantId, (tx) => ensureDamagedBinInTx(tx, tenantId, other))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'damaged-bin-conflict' }),
    });
    const withZone = await createWarehouse('DZ');
    await sql`insert into zones (id, tenant_id, warehouse_id, code, name) values (${uuidv7()}, ${tenantId}, ${withZone}, 'DAMAGED', 'Our damaged')`;
    await expect(withTenantTransaction(db, tenantId, (tx) => ensureDamagedBinInTx(tx, tenantId, withZone))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'damaged-bin-conflict' }),
    });
    // Through the receipt: a good-only receipt books; a damaged one is the 409.
    const goodOnly = await receive({ warehouseId: other, ...blind('PLAIN', [line(sku('PLAIN', 'P-A'), 1)]) });
    expect(goodOnly.status).toBe(201);
    const withDamage = await receive({ warehouseId: other, ...blind('PLAIN', [line(sku('PLAIN', 'P-A'), 1, damaged(1))]) });
    expect(withDamage.status).toBe(409);
    expect(withDamage.body.code).toBe('damaged-bin-conflict');
    // CR1 — a defensive arm only (0087 re-codes pre-rule collisions): the
    // detail names the colliding location and never advises a retire.
    const userBin = (await sql`select id from bins where warehouse_id = ${other} and code = 'DAMAGED' and not system_owned`) as unknown as { id: string }[];
    expect(withDamage.body.detail).toContain(userBin[0]!.id);
    expect(withDamage.body.detail).toContain('re-codes');
    expect(withDamage.body.detail).not.toMatch(/retire/i);
    expect(await count(sql`select count(*)::int as n from bins where warehouse_id in (${other}, ${withZone}) and code = 'DAMAGED' and system_owned`)).toBe(0);
    // A fresh warehouse ensures cleanly and re-selects the same bin.
    const fresh = await createWarehouse('DF');
    const first = await withTenantTransaction(db, tenantId, (tx) => ensureDamagedBinInTx(tx, tenantId, fresh));
    expect(await withTenantTransaction(db, tenantId, (tx) => ensureDamagedBinInTx(tx, tenantId, fresh))).toEqual(first);
  });

  // ── reads ──────────────────────────────────────────────────────────────────

  it('the reads: the GRN lines route, the list sums, the snapshot vocabularies; the OpenAPI publishes the route', async () => {
    const res = await receive(
      blind('PLAIN', [line(sku('PLAIN', 'P-B'), 4, { batchCode: 'B-READ', ...damaged(2, 'broken'), shortQty: 1, shortReasonCode: 'other' }), line(sku('PLAIN', 'P-A'), 3)]),
    ).expect(201);
    const grn = res.body.goodsReceipt as GoodsReceipt;
    const lines = await http()
      .get(`${API}/${tenantId}/receiving/goods-receipts/${grn.id}/lines`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(lines.body.items).toEqual([
      {
        id: grn.lines[0]!.id,
        skuId: sku('PLAIN', 'P-B'),
        skuCode: 'P-B',
        skuName: 'P-B name',
        batchId: expect.any(String),
        batchCode: 'B-READ',
        qty: 4,
        appliedQty: 4,
        damagedQty: 2,
        damageReasonCode: 'broken',
        shortQty: 1,
        shortReasonCode: 'other',
        // Story 2-5a — the read now always carries the line's photo counts.
        photoCount: 0,
        pendingPhotoCount: 0,
      },
      { id: grn.lines[1]!.id, skuId: sku('PLAIN', 'P-A'), skuCode: 'P-A', skuName: 'P-A name', batchId: null, batchCode: null, qty: 3, appliedQty: 3, photoCount: 0, pendingPhotoCount: 0 },
    ]);
    await http().get(`${API}/${tenantId}/receiving/goods-receipts/${uuidv7()}/lines`).set('Authorization', `Bearer ${ownerToken}`).expect(404);
    await http().get(`${API}/${tenantId}/receiving/goods-receipts/not-a-uuid/lines`).set('Authorization', `Bearer ${ownerToken}`).expect(400);

    const list = await http()
      .get(`${API}/${tenantId}/receiving/goods-receipts`)
      .query({ warehouseId: wh, limit: 5 })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const entry = (list.body.items as Record<string, unknown>[]).find((item) => item.id === grn.id)!;
    expect(entry).toMatchObject({ lineCount: 2, totalUnits: 7, appliedUnits: 7, damagedUnits: 2, shortUnits: 1 });

    const snapshot = await http()
      .get(`${API}/${tenantId}/devices/catalog-snapshot`)
      .query({ warehouseId: wh })
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    expect(snapshot.body.receiptDamageReasons).toEqual([...DAMAGE_REASON_CODES]);
    expect(snapshot.body.receiptShortReasons).toEqual([...SHORT_REASON_CODES]);

    const doc = JSON.parse(readFileSync(resolvePath(process.cwd(), 'openapi/openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(doc.paths['/tenants/{tenantId}/receiving/goods-receipts/{grnId}/lines']!)).toEqual(['get']);
  });

  it('the inactive-SKU flag lists a damaged-only booked line, carrying damagedQty (R12)', async () => {
    const skuA = sku('PLAIN', 'P-A');
    await sql`update skus set status = 'inactive' where id = ${skuA}`;
    try {
      const res = await receive(blind('PLAIN', [line(skuA, 0, damaged(2))])).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt & { inactiveSkuReviewOpId?: string };
      expect(grn.inactiveSkuReviewOpId).toBeDefined();
      const row = await rejectedOp(grn.inactiveSkuReviewOpId!);
      expect((row.payload.lines as Record<string, unknown>[])[0]).toMatchObject({ skuId: skuA, qty: 0, damagedQty: 2 });
    } finally {
      await sql`update skus set status = 'active' where id = ${skuA}`;
    }
  });

  // ── the vocabularies ───────────────────────────────────────────────────────

  it('DAMAGE_REASON_CODES and SHORT_REASON_CODES are pinned against their CHECKs; the CHECK swap refuses what it must', async () => {
    const def = async (name: string) =>
      ((await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`) as unknown as { def: string }[])[0]!.def;
    const damage = await def('goods_receipt_lines_damage_pairing');
    expect([...damage.matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1]).sort()).toEqual([...DAMAGE_REASON_CODES].sort());
    const short = await def('goods_receipt_lines_short_pairing');
    expect([...short.matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1]).sort()).toEqual([...SHORT_REASON_CODES].sort());
    expect(await def('goods_receipt_lines_received_positive')).toContain('(qty + damaged_qty) > 0');
    expect(await count(sql`select count(*)::int as n from pg_constraint where conname = 'goods_receipt_lines_qty_positive'`)).toBe(0);
    const t = uuidv7();
    const refused = (statement: PromiseLike<unknown>, constraint: string) =>
      expect(Promise.resolve(statement)).rejects.toMatchObject({ code: '23514', constraint_name: constraint });
    const insert = (qty: number, damagedQty: number, reason: string | null) =>
      sql`insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty, damaged_qty, damage_reason_code)
          values (${uuidv7()}, ${t}, ${t}, ${t}, ${qty}, 0, ${damagedQty}, ${reason})`;
    await refused(insert(0, 0, null), 'goods_receipt_lines_received_positive');
    await refused(insert(1000, 1000, null), 'goods_receipt_lines_damage_pairing');
    await refused(insert(1000, 0, 'wet'), 'goods_receipt_lines_damage_pairing');
    await refused(insert(1000, 1000, 'dented'), 'goods_receipt_lines_damage_pairing');
    // BH6 — the short side.
    const shortRow = (shortQty: number, reason: string | null) =>
      sql`insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty, short_qty, short_reason_code)
          values (${uuidv7()}, ${t}, ${t}, ${t}, 1000, 1000, ${shortQty}, ${reason})`;
    await refused(shortRow(1000, null), 'goods_receipt_lines_short_pairing');
    await refused(shortRow(0, 'other'), 'goods_receipt_lines_short_pairing');
    await refused(shortRow(1000, 'stolen'), 'goods_receipt_lines_short_pairing');
    await refused(shortRow(-1000, 'other'), 'goods_receipt_lines_short_pairing');
    // An accepted short-only good line, rolled back.
    await sql.begin(async (tx) => {
      await tx`insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty, short_qty, short_reason_code)
               values (${uuidv7()}, ${t}, ${t}, ${t}, 95000, 95000, 5000, 'not-shipped')`;
      await tx`select 1`;
      throw new Error('rollback');
    }).catch((error: Error) => expect(error.message).toBe('rollback'));
  });

  // ── code review additions ─────────────────────────────────────────────────

  it('VG2: a po-line-not-found line with damage is rejected whole — the entry carries it, no grn.damaged, no DAMAGED bin ensured (EC3)', async () => {
    const fresh = await createWarehouse('EC3');
    const po = await http()
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: fresh, vendorId, code: `PO-${ulid().slice(14)}`, lines: [{ skuId: sku('PLAIN', 'P-A'), orderedQty: 10, unitCostPaise: 100 }] })
      .expect(201);
    const res = await receive({
      warehouseId: fresh,
      poId: po.body.purchaseOrder.id as string,
      lines: [line(sku('PLAIN', 'P-A'), 2, { poLineId: uuidv7(), ...damaged(3, 'broken') }), line(sku('PLAIN', 'P-A'), 1, { poLineId: po.body.purchaseOrder.lines[0].id as string })],
    }).expect(201);
    const grn = res.body.goodsReceipt as GoodsReceipt;
    expect(grn.rejectedLines).toEqual([
      expect.objectContaining({ code: 'po-line-not-found', qty: 2, damagedQty: 3, damageReasonCode: 'broken' }),
    ]);
    expect(await events(grn.id, 'grn.damaged')).toEqual([]);
    expect(await systemBin('DAMAGED', fresh)).toBeUndefined();
  });

  it('VG2: a licence-not-covered line with damage — the row carries damagedQty; the owner\'s Apply books grn.received AND grn.damaged', async () => {
    const food = (
      await http()
        .post(`${API}/${tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'RICE-DMG', name: 'Rice', uom: 'each', gstRate: 1800, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId: client('PLAIN'), foodCategory: 'bakery-cereals' })
        .expect(201)
    ).body.sku.id as string;
    const shown = (await http().get(`${API}/${tenantId}/licence-policy`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body as { gapCount: number };
    await http()
      .put(`${API}/${tenantId}/licence-policy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ enforce: true, acknowledgedGapCount: shown.gapCount })
      .expect(200);
    try {
      const res = await receive(blind('PLAIN', [line(food, 3, damaged(2, 'wet'))])).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      expect(res.body.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'licence-not-covered', qty: 3, damagedQty: 2, damageReasonCode: 'wet' });
      const row = await rejectedOp(res.body.refusedReceipt.licenceReviewOpId as string);
      expect((row.payload.lines as Record<string, unknown>[])[0]).toMatchObject({ qty: 3, damagedQty: 2, damageReasonCode: 'wet' });
      const applied = await http()
        .post(`${API}/${tenantId}/rejected-ops/${row.id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'apply', note: 'Licence renewal in progress' })
        .expect(200);
      const snapshot = (applied.body.outcome as { snapshot: { goodsReceipt: GoodsReceipt } }).snapshot.goodsReceipt;
      expect(snapshot.lines[0]).toMatchObject({ qty: 3, appliedQty: 3, damagedQty: 2, damageReasonCode: 'wet' });
      expect((await events(snapshot.id, 'grn.received')).map((event) => event.quantity_delta)).toEqual(['3000']);
      expect((await events(snapshot.id, 'grn.damaged')).map((event) => event.quantity_delta)).toEqual(['2000']);
    } finally {
      await http()
        .put(`${API}/${tenantId}/licence-policy`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ enforce: false })
        .expect(200);
    }
  });

  it('BH10b: the lines route answers 403 to a portal session and 404 to another tenant', async () => {
    const res = await receive(blind('PLAIN', [line(sku('PLAIN', 'P-A'), 1)])).expect(201);
    const grnId = (res.body.goodsReceipt as GoodsReceipt).id;
    const email = `client-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role: 'client', clientId: client('PLAIN') })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const portalToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
    const portal = await http().get(`${API}/${tenantId}/receiving/goods-receipts/${grnId}/lines`).set('Authorization', `Bearer ${portalToken}`);
    expect(portal.status).toBe(403);
    expect(portal.body.code).toBe('role-denied');

    const otherEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const other = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `RC Other ${ulid()}`, ownerEmail: otherEmail, password: 'correct-horse-battery' })
      .expect(201);
    const otherTenant = other.body.tenant.id as string;
    const otherToken = (await mintSignIn(app, { email: otherEmail, password: 'correct-horse-battery' })).body.accessToken as string;
    await http().get(`${API}/${otherTenant}/receiving/goods-receipts/${grnId}/lines`).set('Authorization', `Bearer ${otherToken}`).expect(404);
  });

  it('VG1: the billing receipt-line drill carries damaged_qty — on a split and an all-damaged line, 0 on a good-only one', async () => {
    const res = await receive(
      blind('OTHER', [line(sku('OTHER', 'O-A'), 2, damaged(1, 'crushed')), line(sku('OTHER', 'O-A'), 0, damaged(3, 'wet')), line(sku('OTHER', 'O-A'), 4)]),
    ).expect(201);
    const grn = res.body.goodsReceipt as GoodsReceipt;
    const inbound = app.get(InboundFacade);
    const rows = await withTenantTransaction(app.get<Database>(DATABASE), tenantId, (tx) =>
      inbound.receiptLineRecordsInTx(tx, { tenantId, clientId: client('OTHER') }, '2000-01-01T00:00:00Z', '2200-01-01T00:00:00Z', { after: null, limit: 500 }),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(grn.lines.map((l) => [byId.get(l.id)!.qtyMilli, byId.get(l.id)!.damagedQtyMilli])).toEqual([
      ['2000', '1000'],
      ['0', '3000'],
      ['4000', '0'],
    ]);
  });
});
