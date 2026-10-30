import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { getLedgerEventType } from '../src/modules/inventory/ledger-registry';
import { signedQuantity } from '../src/shared/primitives/quantity';
import { damagedPoolLockKey } from '../src/shared/primitives/damaged-pool';
import { RTV_BRAND_DOCUMENT_TYPES } from '../src/shared/primitives/consignment-capture';
import {
  RTV_CONSIGNEE_ADDRESS_KINDS,
  RTV_REASON_CODES,
  VENDOR_RETURN_STATUSES,
  vendorReturnClock,
} from '../src/modules/inbound/vendor-return.command';
import { REJECTED_OP_DECISIONS_BY_TYPE } from '../src/modules/tenancy/sync-report.command';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow } from './support/audit-guard';
import { linkVendor } from './support/linked-vendor';
import { parseZplLabels, readPdfLabels, zplTexts } from './support/labels';

// Story 2-8b — the return to vendor: DAMAGED units (2-4a receipt damage,
// 2-8a QC fails) created on the web as an RTV with the vendor and the brand
// frozen, picked scan-verified on the handheld (`rtv.pick`, nothing moves),
// dispatched on the web with the brand's challan / e-way bill / carrier
// captured — one `rtv.dispatched` draw out of DAMAGED per picked line —, or
// cancelled. The open RTVs claim the DAMAGED pool; a write-off respects the
// claims (A2).
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(180_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
/** IST 2026-10-19 10:00. */
const OCCURRED_AT = '2026-10-19T04:30:00.000Z';
/** The handheld's confirm instant every pick sends (fixed, so a same-key resend replays). */
const PICKED_AT = '2026-10-27T05:00:00.000Z';

interface RtvLine {
  id: string;
  lineNo: number;
  skuId: string;
  skuCode: string;
  batchId: string | null;
  batchCode: string | null;
  quantity: number;
  pickedQuantity: number | null;
  reasonCode: string;
  source: { grnLineId: string; grnCode: string | null; poCode: string | null } | null;
}

interface Rtv {
  id: string;
  code: string;
  status: string;
  warehouseId: string;
  clientId: string;
  vendorId: string;
  vendor: Record<string, unknown>;
  client: Record<string, unknown>;
  consigneeAddressKind: string;
  consigneeAddress: Record<string, unknown>;
  warehouse: Record<string, unknown> & { frozen: boolean };
  picked: Record<string, unknown> | null;
  dispatch: Record<string, unknown> | null;
  cancellation: Record<string, unknown> | null;
  lines: RtvLine[];
  totalQuantity: number;
  totalPickedQuantity: number | null;
}

describe('story 2-8b: the return to vendor (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let inventory: InventoryFacade;
  let db: Database;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorToken: string;
  let operatorUserId: string;
  let deviceId: string;
  let wh: string;
  let wh2: string;
  let brand: string;
  let other: string;
  let vendorV: string;
  let vendorW: string;
  let vendorBare: string;
  let transporter: string;
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const sku = (code: string): string => {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('vendor_returns');
    app = await createApp(false);
    await app.init();
    inventory = app.get(InventoryFacade);
    db = app.get<Database>(DATABASE);
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `RTV Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    const ownerSignIn = await mintSignIn(app, { email, password: 'correct-horse-battery' });
    ownerToken = ownerSignIn.body.accessToken as string;
    ownerUserId = ownerSignIn.body.user.id as string;

    wh = await newWarehouse('RTV');
    wh2 = await newWarehouse('RT2');
    await asOwner('post', `/warehouses/${wh}/zones`).send({ code: 'A', name: 'Aisle A' }).expect(201);

    brand = await newClient('BRD', 'Brand Co');
    other = await newClient('OTH', 'Other Co');
    await asOwner('patch', `/clients/${brand}/tax-details`).send({ legalName: 'Brand Co Private Limited', gstin: '29ABCDE1234F1Z5' }).expect(200);
    await asOwner('patch', `/clients/${brand}/addresses`)
      .send({ registered: { line1: '1 Brand Park', line2: null, city: 'Bengaluru', stateCode: '29', pincode: '560001' } })
      .expect(200);
    await importSkus(brand, 'BRD', [
      ['RB', 'pcs', true, false],
      ['RU', 'pcs', false, false],
      ['RK', 'kg', false, false],
      ['RS', 'pcs', false, true],
    ]);
    await importSkus(other, 'OTH', [['OU', 'pcs', false, false]]);

    vendorV = await newPartner({
      code: 'V-ONE',
      name: 'Vendor One',
      legalName: 'Vendor One Industries',
      roles: ['vendor'],
      gstin: '27VENDR1234Q1Z9',
      registeredAddress: { line1: '9 Vendor Road', city: 'Mumbai', stateCode: '27', pincode: '400001' },
      dispatchAddress: { line1: 'Gate 2, Vendor Yard', city: 'Thane', stateCode: '27', pincode: '400601' },
    });
    vendorW = await newPartner({
      code: 'V-TWO',
      name: 'Vendor Two',
      roles: ['vendor'],
      registeredAddress: { line1: '2 Other Road', city: 'Pune', stateCode: '27', pincode: '411001' },
    });
    vendorBare = await newPartner({ code: 'V-BARE', name: 'Vendor Bare', roles: ['vendor'] });
    for (const vendor of [vendorV, vendorW, vendorBare]) await linkVendor(app, tenantId, ownerToken, vendor, brand);
    transporter = await newPartner({ code: 'T-ONE', name: 'Fast Freight', roles: ['transporter'] });

    const operator = await createMember('operator');
    const ops = await createMember('ops_manager');
    const opsSignIn = await mintSignIn(app, { email: ops.email, password: 'correct-horse-battery' });
    opsToken = opsSignIn.body.accessToken as string;
    opsUserId = opsSignIn.body.user.id as string;
    const minted = await asOwner('post', '/devices/enrollment-codes').send({}).expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'RTV dock', pin: '2468' })
      .expect(201);
    deviceId = enrolled.body.device.id as string;
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail: operator.email, pin: '2468' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
    operatorUserId = ((await sql`select id from users where tenant_id = ${tenantId} and email = ${operator.email}`) as unknown as { id: string }[])[0]!.id;
    await inventory.rebuildReservationCounters(tenantId, wh);
  });

  afterAll(async () => {
    vendorReturnClock.now = () => Date.now();
    await sql?.end();
    const dbClient = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await dbClient.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  function asOwner(method: 'get' | 'post' | 'patch' | 'put', path: string, token = ownerToken): SupertestTest {
    const req = http()[method](`${API}/${tenantId}${path}`).set('Authorization', `Bearer ${token}`);
    return method === 'get' ? req : req.set(KEY_HEADER, ulid());
  }

  async function newWarehouse(prefix: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${prefix}-${ulid().slice(20)}`, name: `${prefix} warehouse` })
        .expect(201)
    ).body.id as string;
  }

  async function newClient(code: string, name: string): Promise<string> {
    return (await asOwner('post', '/clients').send({ code, name }).expect(201)).body.client.id as string;
  }

  async function newPartner(body: Record<string, unknown>): Promise<string> {
    return (await asOwner('post', '/partners').send(body).expect(201)).body.partner.id as string;
  }

  async function importSkus(clientId: string, prefix: string, rows: readonly (readonly [string, string, boolean, boolean])[]): Promise<void> {
    const csv = [
      'sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked',
      ...rows.map(([code, uom, batch, serial]) => `${code},${code} name,${uom},1800,${prefix}-${code}-BC,${batch},${serial}`),
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
    const invited = await asOwner('post', '/users').send({ email, role }).expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    return { email };
  }

  async function newPo(vendorId: string, skuId: string, orderedQty: number, warehouseId = wh): Promise<{ poId: string; lineId: string; code: string }> {
    const code = `PO-${ulid().slice(14)}`;
    const res = await asOwner('post', '/inbound/purchase-orders')
      .send({ warehouseId, vendorId, code, lines: [{ skuId, orderedQty, unitCostPaise: 100 }] })
      .expect(201);
    return { poId: res.body.purchaseOrder.id as string, lineId: res.body.purchaseOrder.lines[0].id as string, code };
  }

  /** A receipt (device) — returns the GRN id and line ids by SKU. */
  async function receive(body: Record<string, unknown>, warehouseId = wh): Promise<{ grnId: string; lineIds: string[] }> {
    const res = await http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, occurredAt: OCCURRED_AT, ...body })
      .expect(201);
    return { grnId: res.body.goodsReceipt.id as string, lineIds: (res.body.goodsReceipt.lines as { id: string }[]).map((line) => line.id) };
  }

  /** A PO receipt of `good` units plus `damaged` damaged units of one SKU (batch optional). */
  async function receiveDamagedOnPo(vendorId: string, skuCode: string, good: number, damaged: number, batchCode: string | null = null): Promise<{ grnLineId: string; poCode: string; grnId: string }> {
    const po = await newPo(vendorId, sku(skuCode), good + damaged);
    const grn = await receive({
      poId: po.poId,
      lines: [{ skuId: sku(skuCode), poLineId: po.lineId, batchCode, mfgDate: null, qty: good, damagedQty: damaged, damageReasonCode: 'crushed' }],
    });
    return { grnLineId: grn.lineIds[0]!, poCode: po.code, grnId: grn.grnId };
  }

  /** A blind receipt with damage (no PO, no vendor). */
  async function receiveDamagedBlind(skuCode: string, good: number, damaged: number, clientId = brand, warehouseId = wh, batchCode: string | null = null): Promise<string> {
    const grn = await receive(
      {
        poId: null,
        blindReasonCode: 'other',
        clientId,
        lines: [{ skuId: sku(skuCode), batchCode, mfgDate: null, qty: good, damagedQty: damaged, damageReasonCode: 'crushed' }],
      },
      warehouseId,
    );
    return grn.lineIds[0]!;
  }

  async function batchIdOf(skuCode: string, code: string): Promise<string> {
    const rows = (await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku(skuCode)} and code = ${code}`) as unknown as { id: string }[];
    return rows[0]!.id;
  }

  async function damagedBin(warehouseId = wh): Promise<string> {
    const rows = (await sql`select id from bins where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and code = 'DAMAGED' and system_owned`) as unknown as { id: string }[];
    return rows[0]!.id;
  }

  async function damagedOnHand(skuCode: string, batchId: string | null = null, warehouseId = wh): Promise<number> {
    const bin = await damagedBin(warehouseId);
    const rows =
      batchId === null
        ? ((await sql`select coalesce(sum(quantity),0)::bigint as n from stock_on_hand where tenant_id = ${tenantId} and bin_id = ${bin} and sku_id = ${sku(skuCode)}`) as unknown as { n: string }[])
        : ((await sql`select coalesce(sum(quantity),0)::bigint as n from batch_on_hand where tenant_id = ${tenantId} and bin_id = ${bin} and sku_id = ${sku(skuCode)} and batch_id = ${batchId}`) as unknown as { n: string }[]);
    return Number(rows[0]!.n) / 1000;
  }

  function line(skuCode: string, quantity: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { skuId: sku(skuCode), quantity, reasonCode: 'damaged', ...extra };
  }

  function create(body: Record<string, unknown>, key = ulid(), token = opsToken): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/vendor-returns`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: wh, vendorId: vendorV, consigneeAddress: 'dispatch', ...body });
  }

  async function createOk(lines: Record<string, unknown>[], extra: Record<string, unknown> = {}): Promise<Rtv> {
    return (await create({ lines, ...extra }).expect(201)).body as Rtv;
  }

  function pick(rtv: Rtv, picked: Record<string, number> | null = null, key = ulid(), extra: Record<string, unknown> = {}): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/vendor-returns/${rtv.id}/pick`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send({
        warehouseId: rtv.warehouseId,
        occurredAt: PICKED_AT,
        lines: rtv.lines.map((l) => ({ lineId: l.id, pickedQty: picked?.[l.id] ?? l.quantity })),
        ...extra,
      });
  }

  function captureBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    return { brandDocument: { type: 'challan', number: 'CH-77', date: today }, transporterId: transporter, trackingRef: 'AWB1234', packageCount: 1, ...extra };
  }

  function dispatch(rtv: Rtv, body: Record<string, unknown> = captureBody(), key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/vendor-returns/${rtv.id}/dispatch`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function cancel(rtv: Rtv, reason = 'vendor refused', key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/vendor-returns/${rtv.id}/cancel`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({ reason });
  }

  function writeOff(skuCode: string, quantity: number, batchCode: string | null = null, key = ulid(), token = ownerToken): Promise<request.Response> {
    return damagedBin().then((binId) =>
      http()
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send({
          warehouseId: wh,
          binId,
          skuId: sku(skuCode),
          quantityDelta: -quantity,
          reasonCode: 'damaged',
          note: 'write-off',
          ...(batchCode === null ? {} : { batch: { code: batchCode, overrideReason: 'damaged write-off' } }),
        }),
    );
  }

  async function rtvEvents(rtvId: string): Promise<{ type: string; quantity_delta: string; from_bin_id: string | null; to_bin_id: string | null; batch_ref: string | null; reference_doc: Record<string, unknown> }[]> {
    return (await sql`
      select type, quantity_delta::text as quantity_delta, from_bin_id, to_bin_id, batch_ref, reference_doc from ledger_events
      where tenant_id = ${tenantId} and reference_doc->>'vendorReturnId' = ${rtvId} order by seq`) as never;
  }

  async function atpOf(skuCode: string): Promise<number> {
    return (await inventory.atp(tenantId, wh, sku(skuCode))).atp;
  }

  /** Clears the DAMAGED stock of one SKU between scenarios by an unguarded raw write-off (no RTV open on it). */
  async function drainDamaged(skuCode: string): Promise<void> {
    const bin = await damagedBin();
    const arms = (await sql`select batch_id, quantity::bigint as q from batch_on_hand where tenant_id = ${tenantId} and bin_id = ${bin} and sku_id = ${sku(skuCode)} and quantity > 0`) as unknown as { batch_id: string; q: string }[];
    const plain = (await sql`select quantity::bigint as q from stock_on_hand where tenant_id = ${tenantId} and bin_id = ${bin} and sku_id = ${sku(skuCode)} and quantity > 0`) as unknown as { q: string }[];
    await withTenantTransaction(db, tenantId, async (tx) => {
      if (arms.length > 0) {
        for (const arm of arms) await rawDraw(tx, skuCode, Number(arm.q), arm.batch_id, bin);
      } else if (plain[0] !== undefined) {
        await rawDraw(tx, skuCode, Number(plain[0].q), null, bin);
      }
    });
  }

  async function rawDraw(tx: Parameters<Parameters<typeof withTenantTransaction>[2]>[0], skuCode: string, milli: number, batchId: string | null, bin: string): Promise<void> {
    await inventory.lockWarehouseInTx(tx, tenantId, wh);
    const at = new Date().toISOString();
    await inventory.appendLedgerEventInTx(tx, {
      tenantId,
      warehouseId: wh,
      type: 'stock.adjusted',
      skuId: sku(skuCode),
      quantityDelta: signedQuantity(-milli),
      fromBinId: bin,
      toBinId: null,
      batchRef: batchId,
      serialRef: null,
      actorUserId: ownerUserId,
      occurredAt: at,
      recordedAt: at,
      referenceDoc: { kind: 'manual-adjustment', reasonCode: 'damage', note: 'suite drain' },
    });
  }

  // ── AC1: receipt damage + a QC fail of one GRN line back to its vendor ─────

  it('AC1 — 3 damaged + 2 failed at QC of a PO line go back to its vendor: create (frozen parties, claimable 5), pick 5 on the handheld, dispatch with challan / transporter / AWB / 1 package: DAMAGED 0, one rtv.dispatched −5 naming the RTV, its line and the GRN line, ATP unchanged', async () => {
    await asOwner('put', `/clients/${brand}/receiving-policy`)
      .send({ receivingToleranceBps: 0, qcOnReceipt: true, expiryRequired: false, minShelfLifeDays: null })
      .expect(200);
    const received = await receiveDamagedOnPo(vendorV, 'RB', 10, 3, 'B1');
    await asOwner('put', `/clients/${brand}/receiving-policy`)
      .send({ receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null })
      .expect(200);
    const b1 = await batchIdOf('RB', 'B1');
    const holdId = ((await sql`select id from qc_holds where tenant_id = ${tenantId} and grn_line_id = ${received.grnLineId}`) as unknown as { id: string }[])[0]!.id;
    await http()
      .post(`${API}/${tenantId}/receiving/qc-holds/${holdId}/inspect`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ lines: [{ batchId: b1, passed: 8, failed: [{ reason: 'damaged', quantity: 2 }] }] })
      .expect(200);
    expect(await damagedOnHand('RB', b1)).toBe(5);

    // The returnable read: the arm, and the line as a source of V with 5 claimable.
    const returnable = await asOwner('get', `/warehouses/${wh}/vendor-returns/returnable?clientId=${brand}`, opsToken).expect(200);
    const arm = (returnable.body.arms as { skuId: string; batchId: string | null; onHand: number; available: number; sources: Record<string, unknown>[] }[]).find((a) => a.skuId === sku('RB') && a.batchId === b1)!;
    expect(arm).toMatchObject({ onHand: 5, available: 5 });
    expect(arm.sources).toEqual([
      expect.objectContaining({ kind: 'receipt-damage', grnLineId: received.grnLineId, vendorId: vendorV, vendorName: 'Vendor One', receiptDamagedQty: 3, qcFailedQty: 2, claimedQty: 0, claimableQty: 5, poCode: received.poCode }),
    ]);

    const atpBefore = await atpOf('RB');
    const createKey = ulid();
    const created = (await create({ lines: [line('RB', 5, { batchId: b1, grnLineId: received.grnLineId })], note: 'Debit note pending' }, createKey).expect(201)).body as Rtv;
    expect(created.code).toMatch(/^RTV-\d{4}$/);
    expect(created).toMatchObject({ status: 'draft', clientId: brand, vendorId: vendorV, consigneeAddressKind: 'dispatch', totalQuantity: 5, totalPickedQuantity: null, picked: null, dispatch: null });
    expect(created.vendor).toMatchObject({ v: 1, code: 'V-ONE', legalName: 'Vendor One Industries', gstin: '27VENDR1234Q1Z9', stateCode: '27' });
    expect(created.consigneeAddress).toEqual({ line1: 'Gate 2, Vendor Yard', line2: null, city: 'Thane', stateCode: '27', pincode: '400601' });
    expect(created.client).toEqual({
      v: 1,
      code: 'BRD',
      name: 'Brand Co',
      legalName: 'Brand Co Private Limited',
      gstin: '29ABCDE1234F1Z5',
      registeredAddress: { line1: '1 Brand Park', line2: null, city: 'Bengaluru', stateCode: '29', pincode: '560001' },
    });
    expect(created.warehouse.frozen).toBe(false);
    expect(created.lines).toEqual([
      expect.objectContaining({ lineNo: 1, skuCode: 'RB', batchCode: 'B1', quantity: 5, pickedQuantity: null, reasonCode: 'damaged', source: expect.objectContaining({ grnLineId: received.grnLineId, poCode: received.poCode }) }),
    ]);
    await expectAuditRow({ tenantId, key: createKey, action: 'vendor_return.created', targetType: 'vendor_return', targetId: created.id, actorUserId: opsUserId });
    // A replay re-serves the snapshot and writes nothing more.
    expect((await create({ lines: [line('RB', 5, { batchId: b1, grnLineId: received.grnLineId })], note: 'Debit note pending' }, createKey).expect(201)).body).toEqual(created);
    await expectAuditRow({ tenantId, key: createKey, action: 'vendor_return.created', targetType: 'vendor_return', targetId: created.id, actorUserId: opsUserId });
    // Nothing moved; the claim shows on the returnable read.
    expect(await damagedOnHand('RB', b1)).toBe(5);
    const after = await asOwner('get', `/warehouses/${wh}/vendor-returns/returnable?clientId=${brand}&skuId=${sku('RB')}`, opsToken).expect(200);
    expect(after.body.arms[0]).toMatchObject({ onHand: 5, claimed: 5, available: 0, claimedBy: [created.code], sources: [] });

    // The device snapshot lists the draft for the Returns out tab.
    const snapshot = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    expect(snapshot.body.openVendorReturns).toContainEqual(
      expect.objectContaining({ id: created.id, kind: 'vendor', code: created.code, vendorName: 'Vendor One', clientId: brand, lines: [expect.objectContaining({ skuCode: 'RB', batchCode: 'B1', qty: 5, uom: 'each' })] }),
    );

    const pickKey = ulid();
    const picked = (await pick(created, null, pickKey).expect(200)).body as Rtv;
    expect(picked).toMatchObject({ status: 'picked', totalPickedQuantity: 5, picked: expect.objectContaining({ by: operatorUserId, deviceId }) });
    await expectAuditRow({ tenantId, key: pickKey, action: 'vendor_return.picked', targetType: 'vendor_return', targetId: created.id, actorUserId: operatorUserId });
    expect((await pick(created, null, pickKey).expect(200)).body).toEqual(picked);
    const gone = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    expect((gone.body.openVendorReturns as { id: string }[]).map((r) => r.id)).not.toContain(created.id);

    const dispatchKey = ulid();
    const dispatched = (await dispatch(created, captureBody({ debitNoteNumber: 'DN-9', ewayBillNumber: '123456789012', ewayBillDate: captureBody().brandDocument && (captureBody().brandDocument as { date: string }).date, vehicleNumber: 'ka-01 ab 1234' }), dispatchKey).expect(200)).body as Rtv;
    expect(dispatched.status).toBe('dispatched');
    expect(dispatched.dispatch).toMatchObject({
      by: opsUserId,
      brandDocument: { type: 'challan', number: 'CH-77' },
      consignorGstin: '29ABCDE1234F1Z5',
      debitNoteNumber: 'DN-9',
      ewayBill: { number: '123456789012', validUntil: null },
      transporterId: transporter,
      transporter: expect.objectContaining({ code: 'T-ONE', name: 'Fast Freight' }),
      vehicleNumber: 'KA01AB1234',
      trackingRef: 'AWB1234',
      packageCount: 1,
    });
    expect(dispatched.warehouse.frozen).toBe(true);
    await expectAuditRow({ tenantId, key: dispatchKey, action: 'vendor_return.dispatched', targetType: 'vendor_return', targetId: created.id, actorUserId: opsUserId });
    expect((await dispatch(created, captureBody({ debitNoteNumber: 'DN-9', ewayBillNumber: '123456789012', ewayBillDate: (captureBody().brandDocument as { date: string }).date, vehicleNumber: 'ka-01 ab 1234' }), dispatchKey).expect(200)).body).toEqual(dispatched);

    expect(await damagedOnHand('RB', b1)).toBe(0);
    expect(await atpOf('RB')).toBe(atpBefore);
    const events = await rtvEvents(created.id);
    expect(events).toEqual([
      {
        type: 'rtv.dispatched',
        quantity_delta: '-5000',
        from_bin_id: await damagedBin(),
        to_bin_id: null,
        batch_ref: b1,
        reference_doc: { kind: 'vendor-return', vendorReturnId: created.id, vendorReturnLineId: created.lines[0]!.id, grnLineId: received.grnLineId },
      },
    ]);
    // The outbox: flat ids and counts, no PII.
    const outbox = (await sql`select type, payload from outbox_messages where tenant_id = ${tenantId} and payload->>'vendorReturnId' = ${created.id} order by created_at`) as unknown as { type: string; payload: Record<string, unknown> }[];
    expect(outbox.map((row) => row.type)).toEqual(['vendor_return.created', 'vendor_return.picked', 'vendor_return.dispatched']);
    expect(outbox[2]!.payload).toEqual({ vendorReturnId: created.id, code: created.code, clientId: brand, warehouseId: wh, vendorId: vendorV, status: 'dispatched', lineCount: 1, qty: '5', trackingRef: 'AWB1234' });
    // Terminal: no cancel.
    expect((await cancel(created).expect(409)).body.code).toBe('rtv-closed');

    // AC2 — the frozen parties survive a vendor edit, a brand rename and a deactivation.
    await asOwner('patch', `/partners/${vendorV}`).send({ dispatchAddress: { line1: 'New Yard', city: 'Nashik', stateCode: '27', pincode: '422001' } }).expect(200);
    await asOwner('patch', `/clients/${brand}/tax-details`).send({ legalName: 'Brand Renamed Ltd', gstin: '29ABCDE1234F1Z5' }).expect(200);
    const read = (await asOwner('get', `/vendor-returns/${created.id}`, opsToken).expect(200)).body as Rtv;
    expect(read.consigneeAddress).toEqual(created.consigneeAddress);
    expect(read.client).toEqual(created.client);
    expect(read.warehouse).toEqual(dispatched.warehouse);
    await asOwner('patch', `/clients/${brand}/tax-details`).send({ legalName: 'Brand Co Private Limited', gstin: '29ABCDE1234F1Z5' }).expect(200);
    await asOwner('patch', `/partners/${vendorV}`).send({ dispatchAddress: { line1: 'Gate 2, Vendor Yard', city: 'Thane', stateCode: '27', pincode: '400601' } }).expect(200);
  });

  it('the source cap counts dispatched claims: the same GRN line cannot be claimed again; the returnable read lists no source for it', async () => {
    const lineId = ((await sql`select reference_doc->>'grnLineId' as id from ledger_events where tenant_id = ${tenantId} and type = 'rtv.dispatched' limit 1`) as unknown as { id: string }[])[0]!.id;
    // Fresh units of the same arm from a blind receipt — the pool has room, the source does not.
    const b1 = await batchIdOf('RB', 'B1');
    await receiveDamagedBlind('RB', 0, 2, brand, wh, 'B1');
    const res = await create({ lines: [line('RB', 1, { batchId: b1, grnLineId: lineId })] }).expect(409);
    expect(res.body).toMatchObject({ code: 'rtv-exceeds-source', claimableQty: 0, requestedQty: 1 });
    await drainDamaged('RB');
  });

  // ── the I/O matrix ─────────────────────────────────────────────────────────

  describe('the matrix', () => {
    it('over the pool: a second draft cannot claim what the first claimed (409 rtv-exceeds-damaged naming on-hand and claimed); a cancel releases the claim', async () => {
      await receiveDamagedBlind('RU', 0, 10);
      const first = await createOk([line('RU', 6)]);
      const res = await create({ lines: [line('RU', 5)] }).expect(409);
      expect(res.body).toMatchObject({ code: 'rtv-exceeds-damaged', onHandQty: 10, claimedQty: 6, availableQty: 4, requestedQty: 5 });
      expect(res.body.detail).toContain(first.code);
      const second = await createOk([line('RU', 4)]);
      const cancelKey = ulid();
      const cancelled = (await cancel(first, 'wrong vendor', cancelKey).expect(200)).body as Rtv;
      expect(cancelled).toMatchObject({ status: 'cancelled', cancellation: expect.objectContaining({ by: opsUserId, reason: 'wrong vendor' }) });
      await expectAuditRow({ tenantId, key: cancelKey, action: 'vendor_return.cancelled', targetType: 'vendor_return', targetId: first.id, actorUserId: opsUserId });
      expect((await cancel(first, 'wrong vendor', cancelKey).expect(200)).body).toEqual(cancelled);
      await expectAuditRow({ tenantId, key: cancelKey, action: 'vendor_return.cancelled', targetType: 'vendor_return', targetId: first.id, actorUserId: opsUserId });
      expect((await cancel(first, 'again').expect(409)).body.code).toBe('rtv-closed');
      const third = await createOk([line('RU', 6)]);
      await cancel(second).expect(200);
      await cancel(third).expect(200);
    });

    it('A4 — two lines on one arm are summed: 4 sourced + 4 unsourced on an arm of 6 is rtv-exceeds-damaged; 4 + 2 is accepted as two lines', async () => {
      const grnLineId = await receiveDamagedBlind('RU', 0, 2);
      // DAMAGED RU = 10 (earlier) + 2 = 12; claim 6 so 6 remain.
      const hold = await createOk([line('RU', 6)]);
      const refused = await create({ lines: [line('RU', 4, { grnLineId: null }), line('RU', 4, { grnLineId })] }).expect(409);
      expect(refused.body).toMatchObject({ code: 'rtv-exceeds-damaged', availableQty: 6, requestedQty: 8 });
      const ok = await createOk([line('RU', 4), line('RU', 2, { grnLineId })]);
      expect(ok.lines.map((l) => [l.lineNo, l.quantity, l.source?.grnLineId ?? null])).toEqual([
        [1, 4, null],
        [2, 2, grnLineId],
      ]);
      await cancel(hold).expect(200);
      await cancel(ok).expect(200);
      await drainDamaged('RU');
    });

    it('wrong vendor: a PO line of V named on an RTV of W is 409 rtv-vendor-mismatch; a blind (PO-less) source admits any linked vendor', async () => {
      const onPo = await receiveDamagedOnPo(vendorV, 'RU', 1, 2);
      expect((await create({ vendorId: vendorW, consigneeAddress: 'registered', lines: [line('RU', 1, { grnLineId: onPo.grnLineId })] }).expect(409)).body.code).toBe('rtv-vendor-mismatch');
      const blind = await receiveDamagedBlind('RU', 0, 1);
      const rtv = await createOk([line('RU', 1, { grnLineId: blind })], { vendorId: vendorW, consigneeAddress: 'registered' });
      expect(rtv.consigneeAddress).toMatchObject({ line1: '2 Other Road' });
      await cancel(rtv).expect(200);
      await drainDamaged('RU');
    });

    it('source mismatch: a GRN line of another SKU or another warehouse is 422 rtv-source-mismatch', async () => {
      await receiveDamagedBlind('RU', 0, 3);
      const kgLine = await receiveDamagedBlind('RK', 0, 1);
      expect((await create({ lines: [line('RU', 1, { grnLineId: kgLine })] }).expect(422)).body.code).toBe('rtv-source-mismatch');
      const elsewhere = await receiveDamagedBlind('RU', 0, 1, brand, wh2);
      expect((await create({ lines: [line('RU', 1, { grnLineId: elsewhere })] }).expect(422)).body.code).toBe('rtv-source-mismatch');
      await drainDamaged('RU');
      await drainDamaged('RK');
    });

    it('refusals before any claim: mixed clients 409, a vendor not linked / inactive 409, a serial SKU 409 rtv-sku-unsupported, a missing batch on a tracked SKU 400, no consignee address 400, "other" without a note 400, no DAMAGED bin anywhere 409 with on-hand 0', async () => {
      await receiveDamagedBlind('RU', 0, 2);
      await receiveDamagedBlind('OU', 0, 2, other);
      expect((await create({ lines: [line('RU', 1), line('OU', 1)] }).expect(409)).body.code).toBe('mixed-client');
      const unlinked = await newPartner({ code: 'V-UNL', name: 'Unlinked', roles: ['vendor'], registeredAddress: { line1: 'x', city: 'y', stateCode: '27', pincode: '400001' } });
      const notLinked = await create({ vendorId: unlinked, consigneeAddress: 'registered', lines: [line('RU', 1)] }).expect(409);
      expect(notLinked.body.code).toBe('vendor-not-linked');
      await asOwner('patch', `/partners/${unlinked}/status`).send({ status: 'inactive', reason: 'gone' }).expect(200);
      const inactive = await create({ vendorId: unlinked, consigneeAddress: 'registered', lines: [line('RU', 1)] }).expect(409);
      expect(inactive.body).toMatchObject({ code: 'vendor-inactive' });
      expect(inactive.body.detail).toContain('a new return to vendor');
      expect((await create({ lines: [line('RS', 1)] }).expect(409)).body.code).toBe('rtv-sku-unsupported');
      expect((await create({ lines: [line('RB', 1)] }).expect(400)).body.detail).toMatch(/batch-tracked/);
      expect((await create({ vendorId: vendorBare, consigneeAddress: 'dispatch', lines: [line('RU', 1)] }).expect(400)).body.detail).toMatch(/no dispatch address/);
      expect((await create({ lines: [line('RU', 1, { reasonCode: 'other' })] }).expect(400)).body.code).toBe('validation-failed');
      const noBin = await create({ warehouseId: wh2, lines: [line('RK', 1)] }).expect(409);
      expect(noBin.body).toMatchObject({ code: 'rtv-exceeds-damaged', onHandQty: 0 });
      await drainDamaged('RU');
    });

    it('authority: an operator cannot create or cancel (403 role-denied, rtv.manage); a shape error is 400 before the replay', async () => {
      await receiveDamagedBlind('RU', 0, 1);
      const opToken = (await mintSignIn(app, { email: (await createMember('operator')).email, password: 'correct-horse-battery' })).body.accessToken as string;
      expect((await create({ lines: [line('RU', 1)] }, ulid(), opToken).expect(403)).body.code).toBe('role-denied');
      expect((await create({ lines: [] }).expect(400)).body.code).toBe('validation-failed');
      expect((await create({ lines: [line('RU', 1), line('RU', 1)] }).expect(400)).body.detail).toMatch(/same SKU, batch and source/);
      await drainDamaged('RU');
    });

    it('pick: short (4 of 6) is picked and the claim drops to 4; every line 0 is 422 rtv-pick-empty; a missing line or one over its quantity is 422 rtv-pick-mismatch; another warehouse is 404; a second pick is 409 rtv-not-draft', async () => {
      await receiveDamagedBlind('RU', 0, 6);
      const rtv = await createOk([line('RU', 6)]);
      expect((await pick(rtv, { [rtv.lines[0]!.id]: 0 }).expect(422)).body.code).toBe('rtv-pick-empty');
      expect((await pick(rtv, { [rtv.lines[0]!.id]: 7 }).expect(422)).body.code).toBe('rtv-pick-mismatch');
      expect(
        (
          await http()
            .post(`${API}/${tenantId}/vendor-returns/${rtv.id}/pick`)
            .set('Authorization', `Bearer ${operatorToken}`)
            .set(KEY_HEADER, ulid())
            .send({ warehouseId: wh, occurredAt: new Date().toISOString(), lines: [{ lineId: uuidv7(), pickedQty: 1 }] })
            .expect(422)
        ).body.code,
      ).toBe('rtv-pick-mismatch');
      expect((await pick(rtv, null, ulid(), { warehouseId: wh2 }).expect(404)).body.code).toBe('not-found');
      const picked = (await pick(rtv, { [rtv.lines[0]!.id]: 4 }).expect(200)).body as Rtv;
      expect(picked.lines[0]).toMatchObject({ quantity: 6, pickedQuantity: 4 });
      expect((await pick(rtv).expect(409)).body).toMatchObject({ code: 'rtv-not-draft', rtvStatus: 'picked' });
      // The claim is the picked 4: 2 of the 6 are free again.
      const extra = await createOk([line('RU', 2)]);
      expect((await create({ lines: [line('RU', 1)] }).expect(409)).body.code).toBe('rtv-exceeds-damaged');
      await cancel(extra).expect(200);
      await cancel(picked).expect(200);
      await drainDamaged('RU');
    });

    it('AC3 — a pick replayed after a web cancel is 409 rtv-not-draft; the device-uploaded refusal lands in review as Discard-only', async () => {
      await receiveDamagedBlind('RU', 0, 2);
      const rtv = await createOk([line('RU', 2)]);
      await cancel(rtv, 'not going back').expect(200);
      const opId = ulid();
      const refused = await pick(rtv, null, opId).expect(409);
      expect(refused.body).toMatchObject({ code: 'rtv-not-draft', rtvStatus: 'cancelled' });
      await http()
        .post(`${API}/${tenantId}/devices/sync-reports`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          rows: [
            {
              opId,
              opType: 'rtv.pick',
              classification: 'rejected',
              problemCode: 'rtv-not-draft',
              problemDetail: refused.body.detail,
              payload: { vendorReturnId: rtv.id, warehouseId: wh, occurredAt: new Date().toISOString(), lines: [{ lineId: rtv.lines[0]!.id, pickedQty: 2 }] },
              attribution: { deviceLabel: 'RTV dock', operatorEmail: 'operator@example.com' },
              opEnqueuedAt: new Date().toISOString(),
              opOccurredAt: new Date().toISOString(),
            },
          ],
        })
        .expect(201);
      const rows = (await sql`select id, op_type from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`) as unknown as { id: string; op_type: string }[];
      expect(rows.map((row) => row.op_type)).toEqual(['rtv.pick']);
      expect(REJECTED_OP_DECISIONS_BY_TYPE['rtv.pick']).toEqual(['discard']);
      const apply = await asOwner('post', `/review/rejected-ops/${rows[0]!.id}/resolve`).send({ decision: 'apply' });
      expect([404, 409]).toContain(apply.status);
      if (apply.status === 409) expect(apply.body.code).toBe('decision-not-available');
      await drainDamaged('RU');
    });

    it('dispatch refusals: before the pick 409 rtv-not-picked; no brand document, no carrier identity, an e-way number without its date, a document dated tomorrow or 31 days before creation → 400; a document exactly 30 days before is accepted', async () => {
      await receiveDamagedBlind('RU', 0, 3);
      const rtv = await createOk([line('RU', 3)]);
      expect((await dispatch(rtv).expect(409)).body).toMatchObject({ code: 'rtv-not-picked', rtvStatus: 'draft' });
      await pick(rtv).expect(200);
      expect((await dispatch(rtv, { ...captureBody(), brandDocument: undefined }).expect(400)).body.detail).toMatch(/brandDocument is required/);
      expect((await dispatch(rtv, { ...captureBody(), transporterId: undefined }).expect(400)).body.detail).toMatch(/who carries the goods/);
      expect((await dispatch(rtv, captureBody({ ewayBillNumber: '123456789012' })).expect(400)).body.detail).toMatch(/ewayBillDate is required/);
      expect((await dispatch(rtv, captureBody({ packageCount: 0 })).expect(400)).body.detail).toMatch(/packageCount/);
      const created = new Date(Date.now() + 5.5 * 3600 * 1000);
      const day = (offset: number): string => new Date(created.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
      expect((await dispatch(rtv, captureBody({ brandDocument: { type: 'challan', number: 'C', date: day(1) } })).expect(400)).body.detail).toMatch(/after today/);
      expect((await dispatch(rtv, captureBody({ brandDocument: { type: 'challan', number: 'C', date: day(-31) } })).expect(400)).body.detail).toMatch(/more than 30 days/);
      expect((await dispatch(rtv, captureBody({ brandDocument: { type: 'debit_note', number: 'C', date: day(0) } })).expect(400)).body.detail).toMatch(/brandDocument.type/);
      const ok = await dispatch(rtv, captureBody({ transporterId: null, carrierName: 'Hand delivery', brandDocument: { type: 'invoice', number: 'INV-1', date: day(-30) } })).expect(200);
      expect(ok.body.dispatch).toMatchObject({ transporterId: null, transporter: null, carrierName: 'Hand delivery', brandDocument: { type: 'invoice' } });
    });

    it('A8 — the document-date rule sits behind the replay: a committed dispatch replays after the clock moved past its window', async () => {
      await receiveDamagedBlind('RU', 0, 1);
      const rtv = await createOk([line('RU', 1)]);
      await pick(rtv).expect(200);
      const key = ulid();
      const body = captureBody();
      const first = await dispatch(rtv, body, key).expect(200);
      vendorReturnClock.now = () => Date.now() - 2 * 86_400_000;
      try {
        expect((await dispatch(rtv, body, key).expect(200)).body).toEqual(first.body);
      } finally {
        vendorReturnClock.now = () => Date.now();
      }
      // Story 4-6a (A22, D12) — the dispatch golden, written green on 4-5a's
      // code before the value joined the hash: a body without
      // declaredValuePaise must keep hashing byte for byte as below.
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
      expect(stored[0]!.payload_hash).toBe(
        hashCommandPayload({
          tenantId,
          arm: 'dispatch',
          vendorReturnId: rtv.id,
          brandDocumentType: 'challan',
          brandDocumentNumber: 'CH-77',
          brandDocumentDate: (body.brandDocument as { date: string }).date,
          consignorGstin: null,
          debitNoteNumber: null,
          ewayBillNumber: null,
          ewayBillDate: null,
          ewayValidUntil: null,
          transporterId: transporter,
          carrierName: null,
          vehicleNumber: null,
          trackingRef: 'AWB1234',
          packageCount: 1,
        }),
      );
    });

    it('story 4-6a (A22, A41) — a declared ₹75,000 above the threshold with no e-way bill is 409 eway-bill-required (the figures named); an exemption satisfies it; the value is stored; no value sent is unjudged', async () => {
      await receiveDamagedBlind('RU', 0, 3);
      const rtv = await createOk([line('RU', 1)]);
      await pick(rtv).expect(200);
      const refused = await dispatch(rtv, captureBody({ declaredValuePaise: 7_500_000 })).expect(409);
      expect(refused.body).toMatchObject({ code: 'eway-bill-required', declaredValuePaise: 7_500_000, thresholdPaise: 5_000_000, thresholdRule: 'national' });
      expect((await dispatch(rtv, captureBody({ declaredValuePaise: 7_500_000, ewayExemption: { reason: 'other' } })).expect(400)).body.detail).toMatch(/note is required/);
      const key = ulid();
      const shipped = (await dispatch(rtv, captureBody({ declaredValuePaise: 7_500_000, ewayExemption: { reason: 'exempt-goods' } }), key).expect(200)).body as Rtv;
      expect(shipped.dispatch).toMatchObject({ declaredValuePaise: 7_500_000, ewayUnjudged: false });
      const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`)[0]!.changes as Record<string, unknown>;
      expect(audit).toEqual({ declaredValuePaise: 7_500_000, ewayExemption: { reason: 'exempt-goods', note: null } });
      const old = await createOk([line('RU', 1)]);
      await pick(old).expect(200);
      expect(((await dispatch(old).expect(200)).body as Rtv).dispatch).toMatchObject({ declaredValuePaise: null, ewayUnjudged: true });
      const below = await createOk([line('RU', 1)]);
      await pick(below).expect(200);
      await dispatch(below, captureBody({ declaredValuePaise: 1_000_000 })).expect(200);
    });

    it('story 4-6a (A41) — a Karnataka vendor under a Karnataka intra-state override (₹1,00,000): ₹80,000 dispatches with no bill; an exemption without a value is 400', async () => {
      await asOwner('post', '/eway/state-thresholds').send({ stateCode: '29', thresholdPaise: 10_000_000, effectiveFrom: new Date(Date.now() + 5.5 * 3_600_000 - 86_400_000).toISOString().slice(0, 10) }).expect(201);
      const local = await newPartner({
        code: 'V-KA',
        name: 'Vendor Karnataka',
        roles: ['vendor'],
        gstin: '29VENDR1234Q1Z9',
        registeredAddress: { line1: '3 Peenya Road', city: 'Bengaluru', stateCode: '29', pincode: '560058' },
      });
      await linkVendor(app, tenantId, ownerToken, local, brand);
      await receiveDamagedBlind('RU', 0, 1);
      const rtv = await createOk([line('RU', 1)], { vendorId: local, consigneeAddress: 'registered' });
      await pick(rtv).expect(200);
      expect((await dispatch(rtv, captureBody({ ewayExemption: { reason: 'customs' } })).expect(400)).body.detail).toMatch(/goes with a declaredValuePaise/);
      expect(((await dispatch(rtv, captureBody({ declaredValuePaise: 8_000_000 })).expect(200)).body as Rtv).dispatch).toMatchObject({ declaredValuePaise: 8_000_000, ewayBill: null });
    });

    it('A7 — the vendor is not re-checked at dispatch: a picked RTV of a vendor deactivated meanwhile dispatches and prints the frozen vendor', async () => {
      const temp = await newPartner({ code: 'V-TMP', name: 'Temp Vendor', roles: ['vendor'], registeredAddress: { line1: '5 Temp', city: 'Pune', stateCode: '27', pincode: '411001' } });
      await linkVendor(app, tenantId, ownerToken, temp, brand);
      await receiveDamagedBlind('RU', 0, 1);
      const rtv = await createOk([line('RU', 1)], { vendorId: temp, consigneeAddress: 'registered' });
      await pick(rtv).expect(200);
      await asOwner('patch', `/partners/${temp}/status`).send({ status: 'inactive', reason: 'delisted' }).expect(200);
      const res = await dispatch(rtv).expect(200);
      expect(res.body.vendor).toMatchObject({ code: 'V-TMP', name: 'Temp Vendor' });
    });

    it('written off meanwhile (the create/write-off race): DAMAGED short of the picked units at dispatch is 409 rtv-damaged-short and nothing is written', async () => {
      await receiveDamagedBlind('RU', 0, 4);
      const rtv = await createOk([line('RU', 4)]);
      await pick(rtv).expect(200);
      // A write-off that slipped past the claim check (the A2 race) — an unguarded draw.
      await withTenantTransaction(db, tenantId, async (tx) => rawDraw(tx, 'RU', 2000, null, await damagedBin()));
      const res = await dispatch(rtv).expect(409);
      expect(res.body).toMatchObject({ code: 'rtv-damaged-short', onHandQty: 2, pickedQty: 4 });
      expect(await rtvEvents(rtv.id)).toEqual([]);
      expect(((await asOwner('get', `/vendor-returns/${rtv.id}`, opsToken).expect(200)).body as Rtv).status).toBe('picked');
      await cancel(rtv).expect(200);
      await drainDamaged('RU');
    });

    it('a reconcile quarantine on DAMAGED stops the dispatch (409 disposition-scope-quarantined)', async () => {
      await receiveDamagedBlind('RU', 0, 1);
      const rtv = await createOk([line('RU', 1)]);
      await pick(rtv).expect(200);
      const quarantineId = uuidv7();
      await sql`insert into inventory_quarantines (id, tenant_id, warehouse_id, sku_id, bin_id, from_seq, to_seq, reason, status)
        values (${quarantineId}, ${tenantId}, ${wh}, ${sku('RU')}, ${await damagedBin()}, 1, 1, 'suite probe', 'open')`;
      try {
        expect((await dispatch(rtv).expect(409)).body.code).toBe('disposition-scope-quarantined');
      } finally {
        await sql`update inventory_quarantines set status = 'resolved' where id = ${quarantineId}`;
      }
      await cancel(rtv).expect(200);
      await drainDamaged('RU');
    });

    it('A2 — a write-off of claimed units is 409 damaged-claimed-by-rtv naming the RTV; unclaimed units still write off; a pend raised before the claim is refused at its approval', async () => {
      await receiveDamagedBlind('RU', 0, 6);
      const rtv = await createOk([line('RU', 4)]);
      await pick(rtv).expect(200);
      const refused = await writeOff('RU', 3);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'damaged-claimed-by-rtv', vendorReturnCodes: [rtv.code], claimedQty: 4, onHandQty: 6 });
      expect((await writeOff('RU', 2)).status).toBe(201);
      // A pend raised over the threshold before a second claim, approved after it.
      await http().put(`${API}/${tenantId}/inventory/adjustment-policies`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ quantityThreshold: 0 }).expect(200);
      await cancel(rtv).expect(200);
      const pend = await writeOff('RU', 3, null, ulid(), opsToken);
      expect(pend.status).toBe(202);
      const second = await createOk([line('RU', 2)]);
      const approve = await http()
        .post(`${API}/${tenantId}/inventory/adjustment-pendings/${pend.body.pendingAdjustment.id as string}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({});
      expect(approve.status).toBe(409);
      expect(approve.body).toMatchObject({ code: 'damaged-claimed-by-rtv', vendorReturnCodes: [second.code] });
      await http().put(`${API}/${tenantId}/inventory/adjustment-policies`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ quantityThreshold: 1_000_000 }).expect(200);
      await cancel(second).expect(200);
      await drainDamaged('RU');
    });

    it('replay: the same key with the lines reordered replays; the same key with another body is 422 idempotency-key-reuse', async () => {
      await receiveDamagedBlind('RU', 0, 3);
      const grnLineId = await receiveDamagedBlind('RU', 0, 1);
      const key = ulid();
      const first = (await create({ lines: [line('RU', 2), line('RU', 1, { grnLineId })] }, key).expect(201)).body as Rtv;
      expect((await create({ lines: [line('RU', 1, { grnLineId }), line('RU', 2)] }, key).expect(201)).body).toEqual(first);
      expect((await create({ lines: [line('RU', 3)] }, key).expect(422)).body.code).toBe('idempotency-key-reuse');
      await cancel(first).expect(200);
      await drainDamaged('RU');
    });
  });

  describe('review round (code review C-rows)', () => {
    it('A2 on a batch arm: a write-off of a claimed batch is refused naming the RTV; another batch of the same SKU writes off', async () => {
      await receiveDamagedBlind('RB', 0, 3, brand, wh, 'WB1');
      await receiveDamagedBlind('RB', 0, 2, brand, wh, 'WB2');
      const wb1 = await batchIdOf('RB', 'WB1');
      const rtv = await createOk([line('RB', 3, { batchId: wb1 })]);
      const refused = await writeOff('RB', 1, 'WB1');
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'damaged-claimed-by-rtv', vendorReturnCodes: [rtv.code], claimedQty: 3, onHandQty: 3 });
      expect((await writeOff('RB', 1, 'WB2')).status).toBe(201);
      await cancel(rtv).expect(200);
      await drainDamaged('RB');
    });

    it('the source cap: a cancel releases the GRN line in full; a short-picked sourced line counts only its picked quantity', async () => {
      const src = await receiveDamagedOnPo(vendorV, 'RU', 0, 4);
      const first = await createOk([line('RU', 4, { grnLineId: src.grnLineId })]);
      await cancel(first).expect(200);
      const second = await createOk([line('RU', 4, { grnLineId: src.grnLineId })]);
      await pick(second, { [second.lines[0]!.id]: 1 }).expect(200);
      const read = await asOwner('get', `/warehouses/${wh}/vendor-returns/returnable?clientId=${brand}&skuId=${sku('RU')}`, opsToken).expect(200);
      const arm = (read.body.arms as { sources: { grnLineId: string; claimedQty: number; claimableQty: number }[]; claimed: number }[])[0]!;
      expect(arm.claimed).toBe(1);
      expect(arm.sources.find((source) => source.grnLineId === src.grnLineId)).toMatchObject({ claimedQty: 1, claimableQty: 3 });
      await cancel(second).expect(200);
      await drainDamaged('RU');
    });

    it('a multi-line dispatch: a line picked 0 writes no event; two lines on one arm are pre-checked summed and each writes its own draw', async () => {
      const srcLine = await receiveDamagedBlind('RU', 0, 5);
      await receiveDamagedBlind('RK', 0, 2);
      const rtv = await createOk([line('RU', 2), line('RU', 3, { grnLineId: srcLine }), line('RK', 2)]);
      const [u1, u2, k] = rtv.lines;
      await pick(rtv, { [u1!.id]: 2, [u2!.id]: 3, [k!.id]: 0 }).expect(200);
      await dispatch(rtv).expect(200);
      const events = await rtvEvents(rtv.id);
      expect(events.map((e) => [e.reference_doc.vendorReturnLineId, e.quantity_delta]).sort()).toEqual(
        [
          [u1!.id, '-2000'],
          [u2!.id, '-3000'],
        ].sort(),
      );
      expect(events.find((e) => e.reference_doc.vendorReturnLineId === u2!.id)!.reference_doc.grnLineId).toBe(srcLine);
      expect(await damagedOnHand('RU')).toBe(0);
      expect(await damagedOnHand('RK')).toBe(2);
      // The ledger register prints the RTV's code, not its id.
      const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      const csv = await http()
        .get(`${API}/${tenantId}/warehouses/${wh}/reports/ledger?format=csv&from=${today}&to=${today}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const rtvRows = csv.text.split('\n').filter((row) => row.includes('rtv.dispatched'));
      expect(rtvRows.length).toBeGreaterThan(1);
      expect(rtvRows.some((row) => row.includes(`return to vendor ${rtv.code}`))).toBe(true);
      expect(rtvRows.some((row) => row.includes(`return to vendor ${rtv.id}`))).toBe(false);
      await drainDamaged('RK');
    });

    it('the list: status and client filters, a cursor walk over every row exactly once, a malformed cursor is 400 invalid-cursor, the picked total null on a draft', async () => {
      await receiveDamagedBlind('RU', 0, 3);
      const a = await createOk([line('RU', 1)]);
      const b = await createOk([line('RU', 1)]);
      await pick(b).expect(200);
      const drafts = await asOwner('get', `/vendor-returns?status=draft&clientId=${brand}&warehouseId=${wh}&limit=100`, opsToken).expect(200);
      const draftRow = (drafts.body.items as { id: string; status: string; totalPickedQuantity: number | null; lineCount: number }[]).find((row) => row.id === a.id)!;
      expect(draftRow).toMatchObject({ status: 'draft', totalPickedQuantity: null, lineCount: 1 });
      expect((drafts.body.items as { status: string }[]).every((row) => row.status === 'draft')).toBe(true);
      const picked = await asOwner('get', `/vendor-returns?status=picked`, opsToken).expect(200);
      expect((picked.body.items as { id: string; totalPickedQuantity: number }[]).find((row) => row.id === b.id)).toMatchObject({ totalPickedQuantity: 1 });
      expect((await asOwner('get', `/vendor-returns?clientId=${other}`, opsToken).expect(200)).body.items).toEqual([]);
      const all = (await sql`select count(*)::int as n from vendor_returns where tenant_id = ${tenantId}`) as unknown as { n: number }[];
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await asOwner('get', `/vendor-returns?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, opsToken).expect(200);
        seen.push(...(page.body.items as { id: string }[]).map((row) => row.id));
        cursor = page.body.nextCursor as string | null;
      } while (cursor !== null);
      expect(seen).toHaveLength(Number(all[0]!.n));
      expect(new Set(seen).size).toBe(seen.length);
      expect((await asOwner('get', '/vendor-returns?cursor=not-a-cursor', opsToken).expect(400)).body.code).toBe('invalid-cursor');
      await cancel(a).expect(200);
      await cancel(b).expect(200);
      await drainDamaged('RU');
    });

    it('two different-key creates racing for one arm: the pool advisory serialises them — one 201, one 409 rtv-exceeds-damaged', async () => {
      await receiveDamagedBlind('RU', 0, 10);
      const [x, y] = await Promise.all([create({ lines: [line('RU', 6)] }), create({ lines: [line('RU', 6)] })]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
      const winner = (x.status === 201 ? x : y).body as Rtv;
      expect((x.status === 409 ? x : y).body.code).toBe('rtv-exceeds-damaged');
      await cancel(winner).expect(200);
      await drainDamaged('RU');
    });

    it('a same-key create parked on the DAMAGED pool lock replays the winner (one RTV, one key)', async () => {
      await receiveDamagedBlind('RU', 0, 4);
      const key = ulid();
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${damagedPoolLockKey(tenantId, wh)}, 0))`;
          const pid = ((await tx`select pg_backend_pid() as pid`) as unknown as { pid: number }[])[0]!.pid;
          first = (async () => create({ lines: [line('RU', 4)] }, key))();
          second = (async () => create({ lines: [line('RU', 4)] }, key))();
          const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
          try {
            const deadline = Date.now() + 10_000;
            for (;;) {
              const rows = (await probe`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and ${pid} = any(pg_blocking_pids(pid))`) as unknown as { n: number }[];
              if (Number(rows[0]!.n) >= 2 || Date.now() > deadline) break;
              await new Promise((r) => setTimeout(r, 25));
            }
          } finally {
            await probe.end();
          }
        });
        const [a, b] = await Promise.all([first!, second!]);
        expect([a.status, b.status]).toEqual([201, 201]);
        expect(a.body).toEqual(b.body);
        expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
        await cancel(a.body as Rtv).expect(200);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
      await drainDamaged('RU');
    });
  });

  // ── fractional quantities, the recall, races ────────────────────────────────

  it('AD-9 — a fractional kg line end to end: 2.5 kg damaged, 1.25 kg on an RTV, picked 1.25, dispatched; DAMAGED 1.25 left; a finer quantity is 400', async () => {
    await receiveDamagedBlind('RK', 0, 2.5);
    expect((await create({ lines: [line('RK', 1.2345)] }).expect(400)).body.code).toBe('validation-failed');
    const rtv = await createOk([line('RK', 1.25)]);
    expect(rtv.lines[0]).toMatchObject({ quantity: 1.25, uom: 'kg' });
    await pick(rtv).expect(200);
    await dispatch(rtv).expect(200);
    expect(await damagedOnHand('RK')).toBe(1.25);
    expect((await rtvEvents(rtv.id))[0]).toMatchObject({ quantity_delta: '-1250', batch_ref: null, reference_doc: { kind: 'vendor-return', vendorReturnId: rtv.id, vendorReturnLineId: rtv.lines[0]!.id } });
    await drainDamaged('RK');
  });

  it('3-7a — a lot on an open LIVE recall still goes back to its vendor (the RTV is exempt from the dispatch guard), and the recall report lists it under returned_to_vendor', async () => {
    await receiveDamagedBlind('RB', 0, 3, brand, wh, 'RC1');
    const lot = await batchIdOf('RB', 'RC1');
    const recall = await http()
      .post(`${API}/${tenantId}/inventory/recalls`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ batchIds: [lot], reasonNote: 'vendor recall', mode: 'live' })
      .expect(201);
    const recallId = (recall.body.recall?.id ?? recall.body.id) as string;
    const rtv = await createOk([line('RB', 3, { batchId: lot, reasonCode: 'recall' })]);
    await pick(rtv).expect(200);
    await dispatch(rtv).expect(200);
    expect(await damagedOnHand('RB', lot)).toBe(0);
    const report = await http().get(`${API}/${tenantId}/inventory/recalls/${recallId}/report?format=csv`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    const rows = report.text.split('\n').filter((row) => row.startsWith('returned_to_vendor,'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('DAMAGED');
    expect(rows[0]).toContain(rtv.code);
    expect(rows[0]).toContain('Vendor One Industries');
  });

  describe('same-key races (a raw holder takes the RTV row, two same-key requests park, then it commits)', () => {
    function handle(): postgres.Sql<Record<string, unknown>> {
      return postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    }

    async function waitParked(holderPid: number, min: number): Promise<void> {
      const probe = handle();
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active' and a.datname = current_database()
          `) as unknown as { pid: number; blockers: number[] }[];
          // The chain back to the holder: the first request waits on the RTV
          // row, the second on the device row the first holds (the pick's
          // device lock) — both lead back to the holder.
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
        throw new Error(`fewer than ${min} request(s) parked on the vendor_returns row`);
      } finally {
        await probe.end();
      }
    }

    async function raceTwice(rtvId: string, send: () => SupertestTest): Promise<[request.Response, request.Response]> {
      const holder = handle();
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from vendor_returns where tenant_id = ${tenantId} and id = ${rtvId} for update`) as unknown as { pid: number }[];
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

    it('pick: both same-key requests answer 200 with one body; one key, one audit row', async () => {
      await receiveDamagedBlind('RU', 0, 2);
      const rtv = await createOk([line('RU', 2)]);
      const key = ulid();
      const [a, b] = await raceTwice(rtv.id, () => pick(rtv, null, key));
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body).toEqual(b.body);
      expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
      expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${key}`).toHaveLength(1);

      const dkey = ulid();
      const [c, d] = await raceTwice(rtv.id, () => dispatch(rtv, captureBody(), dkey));
      expect([c.status, d.status]).toEqual([200, 200]);
      expect(c.body).toEqual(d.body);
      expect(await rtvEvents(rtv.id)).toHaveLength(1);
      expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${dkey}`).toHaveLength(1);
    });
  });

  // ── vocabularies, RLS, registry, contract ──────────────────────────────────

  it('the tuples mirror their DB CHECKs; the pool lock key bytes are pinned; rtv.dispatched registers at grammar v1, batch arm open, serial arm closed', async () => {
    const def = async (name: string): Promise<string> =>
      ((await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`) as unknown as { def: string }[])[0]!.def;
    const literals = (text: string): Set<string> => new Set(text.match(/'[a-z_-]+'/g));
    expect(literals(await def('vendor_returns_status_check'))).toEqual(new Set(VENDOR_RETURN_STATUSES.map((v) => `'${v}'`)));
    expect(literals(await def('vendor_returns_consignee_address_kind_check'))).toEqual(new Set(RTV_CONSIGNEE_ADDRESS_KINDS.map((v) => `'${v}'`)));
    expect(literals(await def('vendor_returns_brand_document_type_check'))).toEqual(new Set(RTV_BRAND_DOCUMENT_TYPES.map((v) => `'${v}'`)));
    expect(literals(await def('vendor_return_lines_reason_check'))).toEqual(new Set(RTV_REASON_CODES.map((v) => `'${v}'`)));
    expect(damagedPoolLockKey('t', 'w')).toBe('t:damaged-pool:w');
    expect(getLedgerEventType('rtv.dispatched')).toMatchObject({ type: 'rtv.dispatched', sinceVersion: 1, referenceKinds: ['vendor-return'], allowsBatchArm: true, allowsSerialArm: false });
  });

  it('the command invariant: a draft RTV has every picked_qty NULL; a picked or dispatched one has every picked_qty set', async () => {
    const rows = (await sql`
      select r.status, bool_and(l.picked_qty is null) as all_null, bool_and(l.picked_qty is not null) as all_set
      from vendor_returns r join vendor_return_lines l on l.vendor_return_id = r.id
      where r.tenant_id = ${tenantId} group by r.id, r.status`) as unknown as { status: string; all_null: boolean; all_set: boolean }[];
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      if (row.status === 'draft') expect(row.all_null).toBe(true);
      if (row.status === 'picked' || row.status === 'dispatched') expect(row.all_set).toBe(true);
    }
  });

  it('RLS: both tables are tenant-isolated (wms_rls_probe sees only its stamped tenant, cannot write another)', async () => {
    const foreign = uuidv7();
    const rtvId = uuidv7();
    try {
      await sql`insert into vendor_returns (id, tenant_id, warehouse_id, client_id, vendor_id, code, status, consignee_address_kind, vendor_snapshot, client_snapshot, created_by)
        values (${rtvId}, ${foreign}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 'RTV-0001', 'draft', 'registered', ${sql.json({})}, ${sql.json({})}, ${uuidv7()})`;
      await sql`insert into vendor_return_lines (id, tenant_id, vendor_return_id, line_no, sku_id, qty, reason_code, item_snapshot)
        values (${uuidv7()}, ${foreign}, ${rtvId}, 1, ${uuidv7()}, 1000, 'damaged', ${sql.json({})})`;
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        for (const table of ['vendor_returns', 'vendor_return_lines']) {
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
            await tx`insert into vendor_return_lines (id, tenant_id, vendor_return_id, line_no, sku_id, qty, reason_code, item_snapshot)
              values (${uuidv7()}, ${foreign}, ${rtvId}, 2, ${uuidv7()}, 1000, 'damaged', ${tx.json({})})`;
          }),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await rls.end();
      }
    } finally {
      await sql`delete from vendor_return_lines where tenant_id = ${foreign}`;
      await sql`delete from vendor_returns where tenant_id = ${foreign}`;
    }
  });

  it('story 4-5a (A22, A43, A45) — package labels: a picked RTV prints count=4 “PACKAGE 1/4…4/4” to the vendor’s address (ZPL first, PDF, A4); count required before dispatch; after it the dispatched count, a different one 409; slices; refusals', async () => {
    await receiveDamagedBlind('RU', 0, 4);
    const rtv = await createOk([line('RU', 4)]);
    const labels = (query: string, token = opsToken) =>
      http().get(`${API}/${tenantId}/vendor-returns/${rtv.id}/package-labels${query}`).set('Authorization', `Bearer ${token}`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const problem = (res: request.Response) => JSON.parse((res.body as Buffer).toString('utf8')) as { code: string };
    // A draft is not picked.
    expect(problem(await labels('?count=4').expect(409)).code).toBe('rtv-not-picked');
    await pick(rtv).expect(200);
    expect(problem(await labels('?count=0').expect(400)).code).toBe('validation-failed');
    expect(problem(await labels('').expect(400)).code).toBe('validation-failed');
    expect(problem(await labels('?count=4&format=zpl&layout=a4').expect(400)).code).toBe('validation-failed');
    expect(problem(await labels('?count=4&from=3&to=2').expect(400)).code).toBe('validation-failed');
    const zpl = await labels('?count=4').expect(200);
    expect(zpl.headers['content-type']).toBe('text/plain; charset=us-ascii');
    expect(zpl.headers['content-disposition']).toBe(`attachment; filename="${rtv.code}-package-labels.zpl"`);
    const parsed = parseZplLabels((zpl.body as Buffer).toString('ascii'));
    expect(parsed).toHaveLength(4);
    parsed.forEach((label, i) => {
      expect(label.barcodes.map((bar) => bar.payload)).toEqual([`${rtv.code}.${i + 1}`]);
    });
    const words = zplTexts(parsed[3]!.raw).join(' | ');
    expect(words).toContain(`RETURN TO VENDOR ${rtv.code}`);
    expect(words).toContain('4/4');
    expect(words).toContain('Gate 2, Vendor Yard');
    expect(words).toContain('Thane');
    expect(words).toContain('FROM Brand Co');
    // A slice.
    const slice = parseZplLabels((await labels('?count=4&from=2&to=3').expect(200)).body.toString('ascii'));
    expect(slice.map((label) => label.barcodes[0]!.payload)).toEqual([`${rtv.code}.2`, `${rtv.code}.3`]);
    // Over 1,000 labels in one print is 422, naming the range to ask for.
    const tooMany = await labels('?count=1500').expect(422);
    expect(problem(tooMany)).toMatchObject({ code: 'too-many-labels' });
    await labels('?count=1500&from=1001&to=1500').expect(200);
    // PDF: one 4×6 page per package, or two per A4 sheet.
    const pdf = await labels('?count=4&format=pdf').expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const pages = await readPdfLabels(pdf.body as Buffer);
    expect(pages.map((page) => page.payloads[0])).toEqual([1, 2, 3, 4].map((n) => `${rtv.code}.${n}`));
    await labels('?count=4&format=pdf&layout=a4').expect(200);
    // Dispatched with 3 packages: the count defaults to 3; count=4 is 409; the carrier and ref print.
    await dispatch(rtv, captureBody({ packageCount: 3 })).expect(200);
    const after = parseZplLabels((await labels('').expect(200)).body.toString('ascii'));
    expect(after).toHaveLength(3);
    expect(after[0]!.barcodes.map((bar) => bar.payload)).toEqual(['AWB1234', `${rtv.code}.1`]);
    const mismatch = await labels('?count=4').expect(409);
    expect(problem(mismatch).code).toBe('package-count-mismatch');
    await labels('?count=3').expect(200);
    // A45 — a vendor snapshot with no address of the consignee kind: print by hand.
    await sql`update vendor_returns set vendor_snapshot = jsonb_set(vendor_snapshot, '{dispatchAddress}', 'null'::jsonb) where id = ${rtv.id}`;
    expect(problem(await labels('').expect(409)).code).toBe('consignee-address-missing');
    // Unknown is 404; a role without labels.execute is 403 whatever it sent.
    expect(problem(await http().get(`${API}/${tenantId}/vendor-returns/${uuidv7()}/package-labels?count=1`).set('Authorization', `Bearer ${opsToken}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(404)).code).toBe('not-found');
    const accountantEmail = `accountant-${ulid().toLowerCase()}@example.com`;
    const invited = await asOwner('post', '/users').send({ email: accountantEmail, role: 'accountant' }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' }).expect(200);
    const accountant = (await mintSignIn(app, { email: accountantEmail, password: 'correct-horse-battery' })).body.accessToken as string;
    expect(problem(await labels('?format=nope', accountant).expect(403)).code).toBe('role-denied');
  });

  it('the OpenAPI document carries the six routes and the snapshot arm', () => {
    const doc = JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const base = '/tenants/{tenantId}';
    expect(Object.keys(doc.paths[`${base}/vendor-returns`] ?? {}).sort()).toEqual(['get', 'post']);
    expect(Object.keys(doc.paths[`${base}/vendor-returns/{vendorReturnId}`] ?? {})).toEqual(['get']);
    for (const verb of ['pick', 'dispatch', 'cancel']) expect(Object.keys(doc.paths[`${base}/vendor-returns/{vendorReturnId}/${verb}`] ?? {})).toEqual(['post']);
    expect(Object.keys(doc.paths[`${base}/warehouses/{warehouseId}/vendor-returns/returnable`] ?? {})).toEqual(['get']);
    expect(doc.components.schemas.CatalogSnapshotResponse?.properties).toHaveProperty('openVendorReturns');
  });
});
