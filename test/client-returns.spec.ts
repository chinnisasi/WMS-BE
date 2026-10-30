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
import { RTV_BRAND_DOCUMENT_TYPES } from '../src/shared/primitives/consignment-capture';
import { damagedPoolLockKey } from '../src/shared/primitives/damaged-pool';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { REJECTED_OP_DECISIONS_BY_TYPE } from '../src/modules/tenancy/sync-report.command';
import { damagedArmKey } from '../src/modules/inbound/vendor-return-claims';
import { clientReturnArmKey } from '../src/modules/returns/client-return-claims';
import {
  CLIENT_RETURN_STATUSES,
  RETURN_DISPOSITION_REASONS,
  RTC_ADDRESS_KINDS,
  RTC_LINE_SOURCES,
  clientReturnClock,
} from '../src/modules/returns/returns.facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow } from './support/audit-guard';
import { linkVendor } from './support/linked-vendor';
import { parseZplLabels, readPdfLabels, zplTexts } from './support/labels';

// Story 4-7c — the return to client: returned units awaiting disposition
// (RETURNS — the fourth disposition outcome, claimed out of the receipt
// line's open_qty at create) and damaged units (DAMAGED — the pool shared
// with 2-8b's RTVs) shipped back to the brand. Created on the web with the
// brand and its address frozen, picked scan-verified on the handheld
// (`rtc.pick`, nothing moves), dispatched on the web — one `rtc.dispatched`
// draw per picked line (per serial unit) —, or cancelled. Read in the portal.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(240_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
/** The advisory key every suite uses to serialize wms_rls_probe role setup. */
const PROBE_LOCK = 742105;
/** The handheld's confirm instant every pick sends (fixed, so a same-key resend replays). */
const PICKED_AT = '2026-10-27T05:00:00.000Z';

function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

interface RtcLine {
  id: string;
  lineNo: number;
  source: string;
  skuId: string;
  skuCode: string;
  batchId: string | null;
  batchCode: string | null;
  serialId: string | null;
  serialNumber: string | null;
  returnReceiptLineId: string | null;
  rmaId: string | null;
  rmaCode: string | null;
  orderReference: string | null;
  condition: string | null;
  reasonCode: string;
  quantity: number;
  pickedQuantity: number | null;
}

interface Rtc {
  id: string;
  code: string;
  status: string;
  warehouseId: string;
  clientId: string;
  client: Record<string, unknown> & { gstin: string | null };
  consigneeAddressKind: string;
  consigneeAddress: Record<string, unknown>;
  warehouse: Record<string, unknown> & { frozen: boolean };
  picked: Record<string, unknown> | null;
  dispatch: (Record<string, unknown> & { consigneeGstin: string | null; consignorGstin: string | null }) | null;
  cancellation: Record<string, unknown> | null;
  lines: RtcLine[];
  totalQuantity: number;
  totalPickedQuantity: number | null;
}

interface ReceiptLineView {
  id: string;
  skuId: string;
  qty: number;
  condition: string;
  openQty: number;
  returningToClientQty?: number;
  returnedToClientQty?: number;
}

describe('story 4-7c: the return to client (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let inventory: InventoryFacade;
  let db: Database;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorToken: string;
  let operatorUserId: string;
  let deviceId: string;
  let wh: string;
  let wh2: string;
  let stockBin: string;
  let brand: string;
  let other: string;
  let bare: string;
  let vendor: string;
  let transporter: string;
  let portalBrand: string;
  let portalOther: string;
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const sku = (code: string): string => {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('client_returns');
    app = await createApp(false);
    await app.init();
    inventory = app.get(InventoryFacade);
    db = app.get<Database>(DATABASE);
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `RTC Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;

    wh = await newWarehouse('RTC');
    wh2 = await newWarehouse('RC2');
    const zoneId = (await asOwner('post', `/warehouses/${wh}/zones`).send({ code: 'A', name: 'Aisle A' }).expect(201)).body.id as string;
    stockBin = (await asOwner('post', `/warehouses/${wh}/zones/${zoneId}/bins`).send({ capacity: 100000, type: 'shelf', code: 'A-01' }).expect(201)).body.id as string;

    brand = await newClient('BRD', 'Brand Co');
    other = await newClient('OTH', 'Other Co');
    bare = await newClient('BAR', 'Bare Co');
    await asOwner('patch', `/clients/${brand}/tax-details`).send({ legalName: 'Brand Co Private Limited', gstin: '29ABCDE1234F1Z5' }).expect(200);
    await asOwner('patch', `/clients/${brand}/addresses`)
      .send({
        registered: { line1: '1 Brand Park', line2: null, city: 'Bengaluru', stateCode: '29', pincode: '560001' },
        return: testAddress({ contactName: 'Returns Desk', line1: '7 Returns Lane', city: 'Mysuru', pincode: '570001' }),
      })
      .expect(200);
    await importSkus(brand, [
      'CA,Return A,pcs,,1800,,false,false,false,,,',
      'CB,Damaged B,pcs,,1800,,false,false,false,,,',
      'CD,Pool D,pcs,,1800,,false,false,false,,,',
      'CE,Write-off E,pcs,,1800,,false,false,false,,,',
      'CF,Flow F,pcs,,1800,,false,false,false,,,',
      'CG,Flow G,pcs,,1800,,false,false,false,,,',
      'CH,Race H,pcs,,1800,,false,false,false,,,',
      'CL,Lot L,pcs,,1800,,true,false,false,,,',
      'CS,Serial S,pcs,,1800,,false,true,false,,,',
      'CK,Bulk K,kg,,1800,,false,false,false,,,',
      'CW,Case W,pcs,,1800,,false,false,true,,,',
      'CJ,Both J,pcs,,1800,,false,false,false,,,',
      'CM,Short M,pcs,,1800,,false,false,false,,,',
      'CN,Race N,pcs,,1800,,false,false,false,,,',
      'CQ,Quarantine Q,pcs,,1800,,false,false,false,,,',
      'CP,Pend P,pcs,,1800,,false,false,false,,,',
      'CX,Kit X,pcs,,1800,,false,false,false,,,',
    ]);
    await asOwner('post', `/catalog/skus/${sku('CX')}/kit`).send({ components: [{ skuId: sku('CA'), quantity: 1 }] }).expect(201);
    await importSkus(other, ['OU,Other U,pcs,,1800,,false,false,false,,,']);
    await asOwner('patch', `/clients/${other}/addresses`).send({ return: testAddress() }).expect(200);
    await importSkus(bare, ['BU,Bare U,pcs,,1800,,false,false,false,,,']);

    vendor = (
      await asOwner('post', '/partners')
        .send({
          code: 'V-RTC',
          name: 'Vendor RTC',
          roles: ['vendor'],
          registeredAddress: { line1: '9 Vendor Road', city: 'Mumbai', stateCode: '27', pincode: '400001' },
          dispatchAddress: { line1: 'Gate 2', city: 'Thane', stateCode: '27', pincode: '400601' },
        })
        .expect(201)
    ).body.partner.id as string;
    await linkVendor(app, tenantId, ownerToken, vendor, brand);
    transporter = (await asOwner('post', '/partners').send({ code: 'T-RTC', name: 'Fast Freight', roles: ['transporter'] }).expect(201)).body.partner.id as string;

    const operator = await createMember('operator');
    const ops = await createMember('ops_manager');
    const opsSignIn = await mintSignIn(app, { email: ops.email, password: 'correct-horse-battery' });
    opsToken = opsSignIn.body.accessToken as string;
    opsUserId = opsSignIn.body.user.id as string;
    const minted = await asOwner('post', '/devices/enrollment-codes').send({}).expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'RTC dock', pin: '2468' })
      .expect(201);
    deviceId = enrolled.body.device.id as string;
    operatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: operator.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;
    operatorUserId = ((await sql`select id from users where tenant_id = ${tenantId} and email = ${operator.email}`) as unknown as { id: string }[])[0]!.id;
    portalBrand = await portalUser(brand);
    portalOther = await portalUser(other);
    await inventory.rebuildReservationCounters(tenantId, wh);
  });

  afterAll(async () => {
    clientReturnClock.now = () => Date.now();
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
    return (await asOwner('post', '/warehouses').send({ origin: testAddress(), code: `${prefix}-${ulid().slice(20)}`, name: `${prefix} warehouse` }).expect(201)).body.id as string;
  }

  async function newClient(code: string, name: string): Promise<string> {
    return (await asOwner('post', '/clients').send({ code, name }).expect(201)).body.client.id as string;
  }

  async function importSkus(clientId: string, rows: string[]): Promise<void> {
    const csv = ['sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode', ...rows].join('\n');
    const imported = await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    expect(imported.body.failedRows).toBe(0);
    const stored = (await sql`select id, code from skus where tenant_id = ${tenantId}`) as unknown as { id: string; code: string }[];
    for (const row of stored) skuIds.set(row.code, row.id);
  }

  async function createMember(role: 'ops_manager' | 'operator' | 'accountant'): Promise<{ email: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await asOwner('post', '/users').send({ email, role }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' }).expect(200);
    return { email };
  }

  async function portalUser(clientId: string): Promise<string> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await asOwner('post', '/users').send({ email, role: 'client', clientId }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' }).expect(200);
    return (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
  }

  /** A blind GRN receipt with `damaged` damaged units of one SKU into the warehouse's DAMAGED bin. */
  async function receiveDamaged(skuCode: string, damaged: number, opts: { batchCode?: string; clientId?: string; warehouseId?: string; good?: number } = {}): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: opts.warehouseId ?? wh,
        occurredAt: nowUtc(),
        poId: null,
        blindReasonCode: 'other',
        clientId: opts.clientId ?? brand,
        lines: [{ skuId: sku(skuCode), batchCode: opts.batchCode ?? null, mfgDate: null, qty: opts.good ?? 0, damagedQty: damaged, damageReasonCode: 'crushed' }],
      })
      .expect(201);
  }

  interface BlindEntry {
    skuCode: string;
    qty: number;
    condition?: string;
    serialNumber?: string | null;
    batchCode?: string | null;
    weightGrams?: number | null;
  }

  /** A blind return booked into RETURNS and (unless `accept: false`) accepted with no order — its receipt lines. */
  async function returned(entries: BlindEntry[], opts: { accept?: boolean; warehouseId?: string; clientId?: string } = {}): Promise<{ rmaId: string; rmaCode: string; lines: ReceiptLineView[] }> {
    const res = await http()
      .post(`${API}/${tenantId}/returns/blind-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: opts.warehouseId ?? wh,
        clientId: opts.clientId ?? brand,
        clientPrompted: false,
        parcelReference: null,
        occurredAt: nowUtc(),
        entries: entries.map((entry) => ({
          skuId: sku(entry.skuCode),
          qty: entry.qty,
          condition: entry.condition ?? 'resaleable',
          note: null,
          batchCode: entry.batchCode ?? null,
          serialNumber: entry.serialNumber ?? null,
          weightGrams: entry.weightGrams ?? null,
        })),
      })
      .expect(201);
    expect(res.body.refused).toEqual([]);
    const rmaId = res.body.rmaId as string;
    if (opts.accept !== false) {
      await http().post(`${API}/${tenantId}/returns/${rmaId}/accept`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ orderId: null }).expect(200);
    }
    const detail = await rmaDetail(rmaId);
    return { rmaId, rmaCode: detail.code, lines: detail.receipts.flatMap((receipt) => receipt.lines) };
  }

  async function rmaDetail(rmaId: string): Promise<{ code: string; receipts: { lines: ReceiptLineView[] }[] }> {
    return (await http().get(`${API}/${tenantId}/returns/${rmaId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body;
  }

  async function receiptLine(rmaId: string, lineId: string): Promise<ReceiptLineView> {
    return (await rmaDetail(rmaId)).receipts.flatMap((receipt) => receipt.lines).find((line) => line.id === lineId)!;
  }

  async function openQtyOf(lineId: string): Promise<number> {
    return Number(((await sql`select open_qty::bigint as n from return_receipt_lines where id = ${lineId}`) as unknown as { n: string }[])[0]!.n) / 1000;
  }

  async function systemBin(code: 'RETURNS' | 'DAMAGED', warehouseId = wh): Promise<string> {
    const rows = (await sql`select id from bins where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and code = ${code} and system_owned`) as unknown as { id: string }[];
    return rows[0]!.id;
  }

  async function onHandIn(code: 'RETURNS' | 'DAMAGED', skuCode: string, batchId: string | null = null): Promise<number> {
    const bin = await systemBin(code).catch(() => null);
    if (bin === null) return 0;
    const rows =
      batchId === null
        ? ((await sql`select coalesce(sum(quantity),0)::bigint as n from stock_on_hand where tenant_id = ${tenantId} and bin_id = ${bin} and sku_id = ${sku(skuCode)}`) as unknown as { n: string }[])
        : ((await sql`select coalesce(sum(quantity),0)::bigint as n from batch_on_hand where tenant_id = ${tenantId} and bin_id = ${bin} and sku_id = ${sku(skuCode)} and batch_id = ${batchId}`) as unknown as { n: string }[]);
    return Number(rows[0]!.n) / 1000;
  }

  async function batchIdOf(skuCode: string, code: string): Promise<string> {
    return ((await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku(skuCode)} and code = ${code}`) as unknown as { id: string }[])[0]!.id;
  }

  async function atpOf(skuCode: string): Promise<number> {
    return (await inventory.atp(tenantId, wh, sku(skuCode))).atp;
  }

  function returnsLine(lineId: string, quantity: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { source: 'returns', returnReceiptLineId: lineId, quantity, ...extra };
  }

  function damagedLine(skuCode: string, quantity: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { source: 'damaged', skuId: sku(skuCode), quantity, ...extra };
  }

  function create(body: Record<string, unknown>, key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/client-returns`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({ warehouseId: wh, ...body });
  }

  async function createOk(lines: Record<string, unknown>[], extra: Record<string, unknown> = {}): Promise<Rtc> {
    return (await create({ lines, ...extra }).expect(201)).body as Rtc;
  }

  function pick(rtc: Rtc, picked: Record<string, number> | null = null, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/client-returns/${rtc.id}/pick`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: rtc.warehouseId, occurredAt: PICKED_AT, lines: rtc.lines.map((l) => ({ lineId: l.id, pickedQty: picked?.[l.id] ?? l.quantity })) });
  }

  function istToday(offsetDays = 0): string {
    return new Date(Date.now() + 5.5 * 3600 * 1000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
  }

  function captureBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { brandDocument: { type: 'challan', number: 'CH-9', date: istToday() }, transporterId: transporter, trackingRef: 'AWB777', packageCount: 2, ...extra };
  }

  function dispatch(rtc: Rtc, body: Record<string, unknown> = captureBody(), key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/client-returns/${rtc.id}/dispatch`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function cancel(rtc: Rtc, reason = 'brand changed its mind', key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/client-returns/${rtc.id}/cancel`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({ reason });
  }

  async function writeOff(skuCode: string, quantity: number, status: number, key = ulid(), token = ownerToken): Promise<request.Response> {
    const binId = await systemBin('DAMAGED');
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: wh, binId, skuId: sku(skuCode), quantityDelta: -quantity, reasonCode: 'damaged', note: 'write-off' })
      .expect(status);
  }

  /** An unguarded raw draw out of a bin (a "something took the units" fixture). */
  async function rawDraw(skuCode: string, milli: number, binId: string, serialId: string | null = null): Promise<void> {
    await withTenantTransaction(db, tenantId, async (tx) => {
      await inventory.lockWarehouseInTx(tx, tenantId, wh);
      const at = new Date().toISOString();
      await inventory.appendLedgerEventInTx(tx, {
        tenantId,
        warehouseId: wh,
        type: 'stock.adjusted',
        skuId: sku(skuCode),
        quantityDelta: signedQuantity(-milli),
        fromBinId: binId,
        toBinId: null,
        batchRef: null,
        serialRef: serialId,
        actorUserId: opsUserId,
        occurredAt: at,
        recordedAt: at,
        referenceDoc: { kind: 'manual-adjustment', reasonCode: 'damage', note: 'fixture draw' },
      });
    });
  }

  async function rtcEvents(rtcId: string): Promise<{ type: string; quantity_delta: string; from_bin_id: string | null; to_bin_id: string | null; batch_ref: string | null; serial_ref: string | null; reference_doc: Record<string, unknown> }[]> {
    return (await sql`
      select type, quantity_delta::text as quantity_delta, from_bin_id, to_bin_id, batch_ref, serial_ref, reference_doc from ledger_events
      where tenant_id = ${tenantId} and reference_doc->>'clientReturnId' = ${rtcId} order by seq`) as never;
  }

  async function storedHash(key: string): Promise<string> {
    return ((await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[])[0]!.payload_hash;
  }

  // ── AC1: the consolidated return ───────────────────────────────────────────

  it('AC1 — RETURNS (resaleable + opened) and DAMAGED on one RTC: created (claims open_qty; brand and return address frozen), picked, dispatched with challan and AWB — RETURNS and DAMAGED drop, three rtc.dispatched draws, ATP unchanged, the RMA reads returned to client', async () => {
    const rma = await returned([
      { skuCode: 'CA', qty: 2, condition: 'resaleable' },
      { skuCode: 'CA', qty: 2, condition: 'opened' },
    ]);
    await receiveDamaged('CB', 3);
    const returnsBefore = await onHandIn('RETURNS', 'CA');
    const damagedBefore = await onHandIn('DAMAGED', 'CB');
    const atpA = await atpOf('CA');
    const atpB = await atpOf('CB');

    const createKey = ulid();
    const created = (await create({ lines: [...rma.lines.map((line) => returnsLine(line.id, line.qty)), damagedLine('CB', 3)] }, createKey).expect(201)).body as Rtc;
    expect(created).toMatchObject({ status: 'draft', clientId: brand, consigneeAddressKind: 'return', totalQuantity: 7, totalPickedQuantity: null });
    expect(created.code).toMatch(/^RTC-\d{4}$/);
    expect(created.consigneeAddress).toEqual({
      kind: 'return',
      contactName: 'Returns Desk',
      phone: '+91 98450 12345',
      line1: '7 Returns Lane',
      line2: 'Gate 3',
      city: 'Mysuru',
      state: 'Karnataka',
      stateCode: null,
      pincode: '570001',
    });
    expect(created.client).toMatchObject({ v: 1, code: 'BRD', gstin: '29ABCDE1234F1Z5', legalName: 'Brand Co Private Limited' });
    // Canonical line order: damaged before returns, the receipt lines by id.
    expect(created.lines.map((line) => line.source)).toEqual(['damaged', 'returns', 'returns']);
    expect(created.lines.filter((line) => line.source === 'returns').every((line) => line.rmaCode === rma.rmaCode && line.reasonCode === 'client-instruction')).toBe(true);
    expect(created.lines.filter((line) => line.source === 'returns').map((line) => line.condition).sort()).toEqual(['opened', 'resaleable']);
    // Decision 5 — the claim left open_qty; the split carries it (A6: present only when > 0).
    for (const line of rma.lines) {
      expect(await openQtyOf(line.id)).toBe(0);
      expect(await receiptLine(rma.rmaId, line.id)).toMatchObject({ openQty: 0, returningToClientQty: 2, returnedToClientQty: 0 });
    }
    // Nothing moved; nothing reserved.
    expect(await onHandIn('RETURNS', 'CA')).toBe(returnsBefore);
    expect(await onHandIn('DAMAGED', 'CB')).toBe(damagedBefore);
    // A5 — the draft keeps the RMA "awaiting" in the portal.
    const awaiting = await http().get(`${API}/${tenantId}/portal/returns?dispositionState=awaiting`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    const row = (awaiting.body.items as { id: string; returningToClientTotal: number; returnedToClientTotal: number }[]).find((item) => item.id === rma.rmaId);
    expect(row).toMatchObject({ returningToClientTotal: 4, returnedToClientTotal: 0 });
    // A fully claimed line leaves the awaiting queue (the RTC holds it).
    const queue = await http().get(`${API}/${tenantId}/returns/awaiting?warehouseId=${wh}&clientId=${brand}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((queue.body.items as { receiptLineId: string }[]).some((item) => rma.lines.some((line) => line.id === item.receiptLineId))).toBe(false);

    const pickKey = ulid();
    const picked = (await pick(created, null, pickKey).expect(200)).body as Rtc;
    expect(picked).toMatchObject({ status: 'picked', totalPickedQuantity: 7, picked: { by: operatorUserId, deviceId, at: PICKED_AT } });

    const dispatchKey = ulid();
    const shipped = (await dispatch(picked, captureBody(), dispatchKey).expect(200)).body as Rtc;
    expect(shipped.status).toBe('dispatched');
    expect(shipped.dispatch).toMatchObject({
      brandDocument: { type: 'challan', number: 'CH-9' },
      trackingRef: 'AWB777',
      packageCount: 2,
      consignorGstin: '29ABCDE1234F1Z5',
      consigneeGstin: '29ABCDE1234F1Z5',
      declaredValuePaise: null,
      transporter: { code: 'T-RTC', name: 'Fast Freight' },
    });
    expect(shipped.warehouse.frozen).toBe(true);

    expect(await onHandIn('RETURNS', 'CA')).toBe(returnsBefore - 4);
    expect(await onHandIn('DAMAGED', 'CB')).toBe(damagedBefore - 3);
    expect(await atpOf('CA')).toBe(atpA);
    expect(await atpOf('CB')).toBe(atpB);
    const events = await rtcEvents(created.id);
    expect(events).toHaveLength(3);
    const returnsBin = await systemBin('RETURNS');
    const damagedBin = await systemBin('DAMAGED');
    for (const event of events) {
      expect(event.type).toBe('rtc.dispatched');
      expect(event.to_bin_id).toBeNull();
      const line = shipped.lines.find((l) => l.id === event.reference_doc.clientReturnLineId)!;
      expect(event.from_bin_id).toBe(line.source === 'returns' ? returnsBin : damagedBin);
      expect(Number(event.quantity_delta)).toBe(-(line.pickedQuantity! * 1000));
      // The ledger bytes: the RETURNS keys only on a returns line — omitted, never null.
      expect(event.reference_doc).toEqual(
        line.source === 'returns'
          ? { kind: 'client-return', clientReturnId: created.id, clientReturnLineId: line.id, returnReceiptLineId: line.returnReceiptLineId, rmaId: rma.rmaId }
          : { kind: 'client-return', clientReturnId: created.id, clientReturnLineId: line.id },
      );
    }
    // The RMA reads returned to client; the portal's dispositioned set takes it.
    for (const line of rma.lines) expect(await receiptLine(rma.rmaId, line.id)).toMatchObject({ openQty: 0, returningToClientQty: 0, returnedToClientQty: 2 });
    const done = await http().get(`${API}/${tenantId}/portal/returns?dispositionState=dispositioned`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    expect((done.body.items as { id: string }[]).some((item) => item.id === rma.rmaId)).toBe(true);
    const portalRma = await http().get(`${API}/${tenantId}/portal/returns/${rma.rmaId}`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    expect(portalRma.body).toMatchObject({ returningToClientTotal: 0, returnedToClientTotal: 4, openTotal: 0 });
    // A blind RMA has one line per entry: 2 + 2.
    expect(portalRma.body.lines.map((line: { returnedToClientQty: number; returningToClientQty: number }) => [line.returningToClientQty, line.returnedToClientQty])).toEqual([
      [0, 2],
      [0, 2],
    ]);

    // ── the audit rows (one per transition) and the outbox, each still one after a replay ──
    await expectAuditRow({ tenantId, key: createKey, action: 'client_return.created', targetType: 'client_return', targetId: created.id, actorUserId: opsUserId });
    await expectAuditRow({ tenantId, key: pickKey, action: 'client_return.picked', targetType: 'client_return', targetId: created.id, actorUserId: operatorUserId });
    await expectAuditRow({ tenantId, key: dispatchKey, action: 'client_return.dispatched', targetType: 'client_return', targetId: created.id, actorUserId: opsUserId });
    expect((await create({ lines: [...rma.lines.map((line) => returnsLine(line.id, line.qty)), damagedLine('CB', 3)] }, createKey).expect(201)).body.id).toBe(created.id);
    await expectAuditRow({ tenantId, key: createKey, action: 'client_return.created', targetType: 'client_return', targetId: created.id, actorUserId: opsUserId });
    expect((await dispatch(picked, captureBody(), dispatchKey).expect(200)).body).toEqual(shipped);
    await expectAuditRow({ tenantId, key: dispatchKey, action: 'client_return.dispatched', targetType: 'client_return', targetId: created.id, actorUserId: opsUserId });
    const outbox = (await sql`select type, payload from outbox_messages where tenant_id = ${tenantId} and payload->>'clientReturnId' = ${created.id} order by created_at`) as unknown as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    expect(outbox.map((message) => message.type)).toEqual(['client_return.created', 'client_return.picked', 'client_return.dispatched']);
    expect(outbox[2]!.payload).toEqual({ clientReturnId: created.id, code: created.code, clientId: brand, warehouseId: wh, status: 'dispatched', lineCount: 3, qty: '7', trackingRef: 'AWB777' });

    // ── the list, the detail, and the ledger register's summary ──
    const list = await http().get(`${API}/${tenantId}/client-returns?clientId=${brand}&status=dispatched`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((list.body.items as { id: string; clientCode: string }[]).find((item) => item.id === created.id)).toMatchObject({ clientCode: 'BRD', lineCount: 3, totalQuantity: 7, totalPickedQuantity: 7, trackingRef: 'AWB777' });
    expect((await http().get(`${API}/${tenantId}/client-returns/${created.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body).toEqual(shipped);
    // The ledger register's reference cell names the RTC by its code.
    const register = await http()
      .get(`${API}/${tenantId}/warehouses/${wh}/reports/ledger?format=csv&from=${istToday(-1)}&to=${istToday()}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect(register.text.split('\n').filter((row) => row.includes('rtc.dispatched') && row.includes(`return to client ${created.code}`))).toHaveLength(3);
  });

  it('AC2 — the detail keeps the address frozen at create after the client edits its return address', async () => {
    await receiveDamaged('CF', 1);
    const rtc = await createOk([damagedLine('CF', 1)]);
    await asOwner('patch', `/clients/${brand}/addresses`).send({ return: testAddress({ contactName: 'New Desk', line1: '99 Elsewhere', city: 'Hubli', pincode: '580020' }) }).expect(200);
    const detail = (await http().get(`${API}/${tenantId}/client-returns/${rtc.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body as Rtc;
    expect(detail.consigneeAddress).toMatchObject({ contactName: 'Returns Desk', line1: '7 Returns Lane', city: 'Mysuru' });
    await asOwner('patch', `/clients/${brand}/addresses`).send({ return: testAddress({ contactName: 'Returns Desk', line1: '7 Returns Lane', city: 'Mysuru', pincode: '570001' }) }).expect(200);
    await cancel(rtc).expect(200);
  });

  // ── the returns source (decision 5) ────────────────────────────────────────

  it('over the open quantity → 409 exceeds-awaiting (+awaitingQty); a claimed line refuses a dispose the same way; a short pick returns the rest; a cancel returns the whole claim', async () => {
    const rma = await returned([{ skuCode: 'CF', qty: 5 }]);
    const line = rma.lines[0]!;
    const rtc = await createOk([returnsLine(line.id, 3)]);
    expect(await openQtyOf(line.id)).toBe(2);
    const over = await create({ lines: [returnsLine(line.id, 3)] }).expect(409);
    expect(over.body).toMatchObject({ code: 'exceeds-awaiting', awaitingQty: 2 });
    // 4-7a's dispose sees the claim (unchanged guard).
    const restock = await http()
      .post(`${API}/${tenantId}/returns/dispositions`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, receiptLineId: line.id, outcome: 'restock', qty: 3, toBinId: stockBin })
      .expect(409);
    expect(restock.body).toMatchObject({ code: 'exceeds-awaiting', awaitingQty: 2 });
    // Conservation across RTC + restock on one receipt line.
    await http()
      .post(`${API}/${tenantId}/returns/dispositions`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, receiptLineId: line.id, outcome: 'restock', qty: 1, toBinId: stockBin })
      .expect(201);
    expect(await openQtyOf(line.id)).toBe(1);
    // Short pick: 2 of 3 — the missing unit goes back to awaiting.
    const picked = (await pick(rtc, { [rtc.lines[0]!.id]: 2 }).expect(200)).body as Rtc;
    expect(picked.lines[0]!.pickedQuantity).toBe(2);
    expect(await openQtyOf(line.id)).toBe(2);
    expect(await receiptLine(rma.rmaId, line.id)).toMatchObject({ openQty: 2, returningToClientQty: 2, returnedToClientQty: 0 });
    const portalDetail = await http().get(`${API}/${tenantId}/portal/returns/${rma.rmaId}`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    expect(portalDetail.body.lines[0]).toMatchObject({ returningToClientQty: 2, returnedToClientQty: 0 });
    // Cancel a picked RTC: its picked claim goes back.
    const cancelKey = ulid();
    const cancelled = (await cancel(picked, 'brand withdrew', cancelKey).expect(200)).body as Rtc;
    expect(cancelled).toMatchObject({ status: 'cancelled', cancellation: { reason: 'brand withdrew' } });
    expect(await openQtyOf(line.id)).toBe(4);
    expect(await receiptLine(rma.rmaId, line.id)).not.toHaveProperty('returningToClientQty');
    await expectAuditRow({ tenantId, key: cancelKey, action: 'client_return.cancelled', targetType: 'client_return', targetId: rtc.id, actorUserId: opsUserId });
    expect((await cancel(picked, 'brand withdrew', cancelKey).expect(200)).body).toEqual(cancelled);
    await expectAuditRow({ tenantId, key: cancelKey, action: 'client_return.cancelled', targetType: 'client_return', targetId: rtc.id, actorUserId: opsUserId });
    expect((await cancel(picked).expect(409)).body).toMatchObject({ code: 'rtc-closed', rtcStatus: 'cancelled' });
    // A draft cancel returns its whole quantity.
    const draft = await createOk([returnsLine(line.id, 4)]);
    expect(await openQtyOf(line.id)).toBe(0);
    await cancel(draft).expect(200);
    expect(await openQtyOf(line.id)).toBe(4);
  });

  it('the header guards: another warehouse (document-warehouse-mismatch), a blind return pending review (review-pending), a departed client is allowed (A8), mixed clients (mixed-client)', async () => {
    const far = await returned([{ skuCode: 'CG', qty: 1 }], { warehouseId: wh2 });
    expect((await create({ lines: [returnsLine(far.lines[0]!.id, 1)] }).expect(409)).body.code).toBe('document-warehouse-mismatch');
    const pending = await returned([{ skuCode: 'CG', qty: 1 }], { accept: false });
    expect((await create({ lines: [returnsLine(pending.lines[0]!.id, 1)] }).expect(409)).body.code).toBe('review-pending');
    await receiveDamaged('OU', 1, { clientId: other });
    await receiveDamaged('CG', 1);
    expect((await create({ lines: [damagedLine('CG', 1), damagedLine('OU', 1)] }).expect(409)).body.code).toBe('mixed-client');
    // A8 — the client departed (its late return still sits in RETURNS): the RTC is allowed.
    await sql`update clients set status = 'departed' where id = ${other}`;
    try {
      const late = await createOk([damagedLine('OU', 1)]);
      expect(late.clientId).toBe(other);
      await cancel(late).expect(200);
    } finally {
      await sql`update clients set status = 'active' where id = ${other}`;
    }
  });

  it('the address (client-address-missing, 409), the SKU rules (rtc-sku-unsupported for a catch-weight SKU), the shape (400)', async () => {
    await receiveDamaged('BU', 1, { clientId: bare });
    const missing = await create({ lines: [damagedLine('BU', 1)] }).expect(409);
    expect(missing.body).toMatchObject({ code: 'client-address-missing', addressKind: 'return', clientId: bare });
    expect((await create({ lines: [damagedLine('BU', 1)], consigneeAddress: 'registered' }).expect(409)).body.addressKind).toBe('registered');
    expect((await create({ lines: [damagedLine('CW', 1)] }).expect(409)).body).toMatchObject({ code: 'rtc-sku-unsupported', skuCode: 'CW' });
    expect((await create({ lines: [damagedLine('CS', 1)] }).expect(409)).body.code).toBe('rtc-sku-unsupported');
    // The kit arm (a kit never holds stock — refused before the pool is read).
    const kit = await create({ lines: [damagedLine('CX', 1)] }).expect(409);
    expect(kit.body).toMatchObject({ code: 'rtc-sku-unsupported', skuCode: 'CX' });
    expect(kit.body.detail).toMatch(/a kit/);
    expect((await create({ lines: [] }).expect(400)).body.code).toBe('validation-failed');
    expect((await create({ lines: [{ source: 'returns', quantity: 1 }] }).expect(400)).body.detail).toMatch(/returnReceiptLineId/);
    expect((await create({ lines: [{ source: 'damaged', quantity: 1 }] }).expect(400)).body.detail).toMatch(/skuId/);
    expect((await create({ lines: [damagedLine('CG', 1), damagedLine('CG', 1)] }).expect(400)).body.detail).toMatch(/same SKU and batch/);
    expect((await create({ lines: [damagedLine('CG', 1, { reasonCode: 'other' })] }).expect(400)).body.detail).toMatch(/"other"/);
    expect((await create({ lines: [damagedLine('CL', 1)] }).expect(400)).body.detail).toMatch(/batch-tracked/);
    expect((await create({ lines: [damagedLine('CG', 0.5)] }).expect(400)).body.code).toBe('validation-failed');
    expect((await create({ lines: [damagedLine('CG', 1)], consigneeAddress: 'home' }).expect(400)).body.code).toBe('validation-failed');
  });

  // ── the damaged source: one pool with 2-8b (decision 6) ────────────────────

  it('one DAMAGED pool: an RTV draft claims 4 of 10 → an RTC of 7 is refused, 6 passes; then an RTV of 1 is refused naming both; the RTV returnable counts the RTC', async () => {
    await receiveDamaged('CD', 10);
    const rtv = (
      await http()
        .post(`${API}/${tenantId}/vendor-returns`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, vendorId: vendor, consigneeAddress: 'dispatch', lines: [{ skuId: sku('CD'), quantity: 4, reasonCode: 'damaged' }] })
        .expect(201)
    ).body as { id: string; code: string };
    const over = await create({ lines: [damagedLine('CD', 7)] }).expect(409);
    expect(over.body).toMatchObject({ code: 'rtc-exceeds-damaged', onHandQty: 10, claimedQty: 4, availableQty: 6, requestedQty: 7 });
    expect(over.body.detail).toContain(rtv.code);
    const rtc = await createOk([damagedLine('CD', 6)]);
    const rtvOver = await http()
      .post(`${API}/${tenantId}/vendor-returns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, vendorId: vendor, consigneeAddress: 'dispatch', lines: [{ skuId: sku('CD'), quantity: 1, reasonCode: 'damaged' }] })
      .expect(409);
    expect(rtvOver.body).toMatchObject({ code: 'rtv-exceeds-damaged', onHandQty: 10, claimedQty: 10, availableQty: 0 });
    expect(rtvOver.body.detail).toContain(rtc.code);
    const returnable = await http().get(`${API}/${tenantId}/warehouses/${wh}/vendor-returns/returnable?clientId=${brand}&skuId=${sku('CD')}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(returnable.body.arms[0]).toMatchObject({ onHand: 10, claimed: 10, available: 0 });
    expect(returnable.body.arms[0].claimedBy).toEqual([rtc.code, rtv.code].sort());
    // The RTC's own returnable read: the arm with both claims; the brand's
    // awaiting lines only — never another client's, never a returned case.
    const own = await returned([{ skuCode: 'CD', qty: 1 }]);
    const theirs = await returned([{ skuCode: 'OU', qty: 1 }], { clientId: other });
    const caseLine = await returned([{ skuCode: 'CW', qty: 1, weightGrams: 1200 }]);
    const mine = await http().get(`${API}/${tenantId}/warehouses/${wh}/client-returns/returnable?clientId=${brand}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const awaitingIds = (mine.body.awaiting as { receiptLineId: string }[]).map((row) => row.receiptLineId);
    expect(awaitingIds).toContain(own.lines[0]!.id);
    expect(awaitingIds).not.toContain(theirs.lines[0]!.id);
    expect(awaitingIds).not.toContain(caseLine.lines[0]!.id);
    expect(mine.body.truncated).toBe(false);
    expect((mine.body.damaged as { skuCode: string }[]).find((arm) => arm.skuCode === 'CD')).toMatchObject({ onHand: 10, claimedRtv: 4, claimedRtc: 6, available: 0 });
    expect((mine.body.damaged as { skuCode: string }[]).some((arm) => arm.skuCode === 'CW' || arm.skuCode === 'CS')).toBe(false);
    // The two seams key arms identically.
    expect(clientReturnArmKey('s', null)).toBe(damagedArmKey('s', null));
    expect(clientReturnArmKey('s', 'b')).toBe(damagedArmKey('s', 'b'));
    await cancel(rtc).expect(200);
    await http().post(`${API}/${tenantId}/vendor-returns/${rtv.id}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ reason: 'test over' }).expect(200);
  });

  it('the write-off: stage 1 (RTV only) stays byte-identical; stage 2 refuses damaged-claimed-by-rtc naming the RTC (D3)', async () => {
    await receiveDamaged('CE', 6);
    const rtc = await createOk([damagedLine('CE', 4)]);
    await pick(rtc).expect(200);
    const refused = await writeOff('CE', 3, 409);
    expect(refused.body).toMatchObject({ code: 'damaged-claimed-by-rtc', clientReturnCodes: [rtc.code], vendorReturnCodes: [], claimedQty: 4, onHandQty: 6 });
    await writeOff('CE', 2, 201);
    // rtc-damaged-short: units taken out of DAMAGED after the pick (a raw draw that skips the guard).
    await rawDraw('CE', 1000, await systemBin('DAMAGED'));
    const short = await dispatch(rtc).expect(409);
    expect(short.body).toMatchObject({ code: 'rtc-damaged-short', skuCode: 'CE', onHandQty: 3, pickedQty: 4 });
    expect(await rtcEvents(rtc.id)).toEqual([]);
    await cancel(rtc).expect(200);
    // Stage 1: an RTV claims 2 of the 3; a write-off of 2 is refused by 2-8b's own code, byte-identical.
    const rtv = (
      await http()
        .post(`${API}/${tenantId}/vendor-returns`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, vendorId: vendor, consigneeAddress: 'dispatch', lines: [{ skuId: sku('CE'), quantity: 2, reasonCode: 'damaged' }] })
        .expect(201)
    ).body as { id: string; code: string };
    const stage1 = await writeOff('CE', 2, 409);
    expect(stage1.body).toEqual(
      expect.objectContaining({
        code: 'damaged-claimed-by-rtv',
        detail: `2 each of SKU "CE" in DAMAGED are claimed by ${rtv.code} (on hand 3 each) — at most 1 each can be written off. Cancel the return to vendor, or write off fewer units.`,
        vendorReturnCodes: [rtv.code],
        claimedQty: 2,
        onHandQty: 3,
      }),
    );
    expect(stage1.body).not.toHaveProperty('clientReturnCodes');
    await http().post(`${API}/${tenantId}/vendor-returns/${rtv.id}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ reason: 'test over' }).expect(200);
  });

  it('the write-off stage 2 with BOTH claims open: DAMAGED 6, RTV 2, RTC 2, write off 3 → damaged-claimed-by-rtc naming both', async () => {
    await receiveDamaged('CJ', 6);
    const rtv = (
      await http()
        .post(`${API}/${tenantId}/vendor-returns`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, vendorId: vendor, consigneeAddress: 'dispatch', lines: [{ skuId: sku('CJ'), quantity: 2, reasonCode: 'damaged' }] })
        .expect(201)
    ).body as { id: string; code: string };
    const rtc = await createOk([damagedLine('CJ', 2)]);
    const refused = await writeOff('CJ', 3, 409);
    expect(refused.body).toMatchObject({ code: 'damaged-claimed-by-rtc', clientReturnCodes: [rtc.code], vendorReturnCodes: [rtv.code], claimedQty: 4, onHandQty: 6 });
    await cancel(rtc).expect(200);
    await http().post(`${API}/${tenantId}/vendor-returns/${rtv.id}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ reason: 'test over' }).expect(200);
  });

  it('A12 — a write-off pend raised before an RTC claimed the units is refused at its approval: 409 damaged-claimed-by-rtc naming the RTC', async () => {
    await receiveDamaged('CP', 3);
    const policy = (path: string, threshold: number) =>
      http().put(`${API}/${tenantId}${path}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ quantityThreshold: threshold }).expect(200);
    await policy('/inventory/adjustment-policies', 0);
    try {
      const pend = await writeOff('CP', 3, 202, ulid(), opsToken);
      const rtc = await createOk([damagedLine('CP', 2)]);
      const approve = await http()
        .post(`${API}/${tenantId}/inventory/adjustment-pendings/${pend.body.pendingAdjustment.id as string}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({});
      expect(approve.status).toBe(409);
      expect(approve.body).toMatchObject({ code: 'damaged-claimed-by-rtc', clientReturnCodes: [rtc.code], vendorReturnCodes: [], claimedQty: 2, onHandQty: 3 });
      await cancel(rtc).expect(200);
    } finally {
      await policy('/inventory/adjustment-policies', 1_000_000);
    }
  });

  it('a short pick on a DAMAGED line (2 of 4, on-hand 6): the returnable shows claimedRtc 2 and a write-off of 4 passes', async () => {
    await receiveDamaged('CM', 6);
    const rtc = await createOk([damagedLine('CM', 4)]);
    await pick(rtc, { [rtc.lines[0]!.id]: 2 }).expect(200);
    const read = await http().get(`${API}/${tenantId}/warehouses/${wh}/client-returns/returnable?clientId=${brand}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((read.body.damaged as { skuCode: string }[]).find((arm) => arm.skuCode === 'CM')).toMatchObject({ onHand: 6, claimedRtc: 2, available: 4, claimedBy: [rtc.code] });
    await writeOff('CM', 4, 201);
    await cancel(rtc).expect(200);
  });

  it('a reconcile quarantine on DAMAGED stops the dispatch (409 disposition-scope-quarantined); nothing is written', async () => {
    await receiveDamaged('CQ', 1);
    const rtc = await createOk([damagedLine('CQ', 1)]);
    await pick(rtc).expect(200);
    const q = uuidv7();
    await sql`insert into inventory_quarantines (id, tenant_id, warehouse_id, sku_id, bin_id, from_seq, to_seq, reason)
      values (${q}, ${tenantId}, ${wh}, ${sku('CQ')}, ${await systemBin('DAMAGED')}, 1, 1, 'client-returns probe')`;
    try {
      expect((await dispatch(rtc).expect(409)).body.code).toBe('disposition-scope-quarantined');
      expect(await rtcEvents(rtc.id)).toEqual([]);
      expect(((await sql`select status from client_returns where id = ${rtc.id}`) as unknown as { status: string }[])[0]!.status).toBe('picked');
    } finally {
      await sql`update inventory_quarantines set status = 'resolved' where id = ${q}`;
    }
    await cancel(rtc).expect(200);
  });

  // ── the pick (decision 13) ─────────────────────────────────────────────────

  it('the pick: rtc-pick-empty (422), rtc-pick-mismatch (422), another warehouse (404), dispatch before pick (rtc-not-picked); AC3 — a pick replayed after a web cancel is rtc-not-draft and its review row is Discard only, open_qty back', async () => {
    const rma = await returned([{ skuCode: 'CG', qty: 2 }]);
    const line = rma.lines[0]!;
    const rtc = await createOk([returnsLine(line.id, 2)]);
    expect((await pick(rtc, { [rtc.lines[0]!.id]: 0 }).expect(422)).body.code).toBe('rtc-pick-empty');
    expect((await pick(rtc, { [rtc.lines[0]!.id]: 3 }).expect(422)).body.code).toBe('rtc-pick-mismatch');
    const wrongLines = await http()
      .post(`${API}/${tenantId}/client-returns/${rtc.id}/pick`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, occurredAt: PICKED_AT, lines: [{ lineId: uuidv7(), pickedQty: 1 }] })
      .expect(422);
    expect(wrongLines.body.code).toBe('rtc-pick-mismatch');
    await http()
      .post(`${API}/${tenantId}/client-returns/${rtc.id}/pick`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh2, occurredAt: PICKED_AT, lines: [{ lineId: rtc.lines[0]!.id, pickedQty: 1 }] })
      .expect(404);
    expect((await dispatch(rtc).expect(409)).body).toMatchObject({ code: 'rtc-not-picked', rtcStatus: 'draft' });
    await cancel(rtc, 'not going back').expect(200);
    expect(await openQtyOf(line.id)).toBe(2);
    const opId = ulid();
    const refused = await pick(rtc, null, opId).expect(409);
    expect(refused.body).toMatchObject({ code: 'rtc-not-draft', rtcStatus: 'cancelled' });
    await http()
      .post(`${API}/${tenantId}/devices/sync-reports`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        rows: [
          {
            opId,
            opType: 'rtc.pick',
            classification: 'rejected',
            problemCode: 'rtc-not-draft',
            problemDetail: refused.body.detail,
            payload: { clientReturnId: rtc.id, warehouseId: wh, occurredAt: PICKED_AT, lines: [{ lineId: rtc.lines[0]!.id, pickedQty: 2 }] },
            attribution: { deviceLabel: 'RTC dock', operatorEmail: 'operator@example.com' },
            opEnqueuedAt: new Date().toISOString(),
            opOccurredAt: new Date().toISOString(),
          },
        ],
      })
      .expect(201);
    const rows = (await sql`select id, op_type from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`) as unknown as { id: string; op_type: string }[];
    expect(rows.map((row) => row.op_type)).toEqual(['rtc.pick']);
    expect(REJECTED_OP_DECISIONS_BY_TYPE['rtc.pick']).toEqual(['discard']);
    const apply = await asOwner('post', `/review/rejected-ops/${rows[0]!.id}/resolve`).send({ decision: 'apply' });
    expect([404, 409]).toContain(apply.status);
    if (apply.status === 409) expect(apply.body.code).toBe('decision-not-available');
  });

  // ── the dispatch capture (decision 10, A1, A2, A9, D8) ─────────────────────

  it('the dispatch capture: no brand document (400), a debit note (400 — not an RTC field), the date window (−30 accepted, −31 refused, behind the clock), the consignee GSTIN and declared value; an inter-state GSTIN pair is recorded as sent', async () => {
    await receiveDamaged('CG', 2);
    const rtc = await createOk([damagedLine('CG', 2)]);
    await pick(rtc).expect(200);
    expect((await dispatch(rtc, { ...captureBody(), brandDocument: undefined }).expect(400)).body.detail).toMatch(/brandDocument is required/);
    expect((await dispatch(rtc, captureBody({ debitNoteNumber: 'DN-1' })).expect(400)).body.code).toBe('validation-failed');
    expect((await dispatch(rtc, captureBody({ consigneeGstin: '29abc' })).expect(400)).body.detail).toMatch(/consigneeGstin/);
    expect((await dispatch(rtc, captureBody({ declaredValuePaise: -1 })).expect(400)).body.detail).toMatch(/declaredValuePaise/);
    expect((await dispatch(rtc, captureBody({ brandDocument: { type: 'challan', number: 'C', date: istToday(-31) } })).expect(400)).body.detail).toMatch(/more than 30 days/);
    const key = ulid();
    const body = captureBody({ brandDocument: { type: 'invoice', number: 'INV-1', date: istToday(-30) }, consignorGstin: '27abcde1234f1z5', consigneeGstin: '29ABCDE1234F1Z5', declaredValuePaise: 1250000 });
    const shipped = (await dispatch(rtc, body, key).expect(200)).body as Rtc;
    expect(shipped.dispatch).toMatchObject({ consignorGstin: '27ABCDE1234F1Z5', consigneeGstin: '29ABCDE1234F1Z5', declaredValuePaise: 1250000, brandDocument: { type: 'invoice' } });
    // The time rule sits behind the replay: a committed key replays after the window moved.
    const saved = clientReturnClock.now;
    clientReturnClock.now = () => Date.now() + 40 * 86_400_000;
    try {
      expect((await dispatch(rtc, body, key).expect(200)).body).toEqual(shipped);
    } finally {
      clientReturnClock.now = saved;
    }
    // A1 — the dispatch golden: every capture key but the debit note, then the two RTC keys as sent.
    expect(await storedHash(key)).toBe(
      hashCommandPayload({
        tenantId,
        arm: 'rtc-dispatch',
        clientReturnId: rtc.id,
        brandDocumentType: 'invoice',
        brandDocumentNumber: 'INV-1',
        brandDocumentDate: istToday(-30),
        consignorGstin: '27ABCDE1234F1Z5',
        ewayBillNumber: null,
        ewayBillDate: null,
        ewayValidUntil: null,
        transporterId: transporter,
        carrierName: null,
        vehicleNumber: null,
        trackingRef: 'AWB777',
        packageCount: 2,
        consigneeGstin: '29ABCDE1234F1Z5',
        declaredValuePaise: 1250000,
      }),
    );
    expect((await cancel(rtc).expect(409)).body).toMatchObject({ code: 'rtc-closed', rtcStatus: 'dispatched' });
  });

  it('story 4-6a (A22, A41) — the declared value is judged: above the threshold with no e-way bill is 409 eway-bill-required, an expired bill 409 eway-bill-expired, ₹10,000 dispatches; no value sent is unjudged', async () => {
    await receiveDamaged('CG', 4);
    const above = await createOk([damagedLine('CG', 1)]);
    await pick(above).expect(200);
    expect((await dispatch(above, captureBody({ declaredValuePaise: 20_000_000 })).expect(409)).body).toMatchObject({ code: 'eway-bill-required', thresholdPaise: 5_000_000 });
    const expiredBody = captureBody({
      declaredValuePaise: 20_000_000,
      brandDocument: { type: 'challan', number: 'CH-E', date: istToday(-3) },
      ewayBillNumber: '123456789012',
      ewayBillDate: istToday(-3),
      ewayValidUntil: istToday(-1),
    });
    expect((await dispatch(above, expiredBody).expect(409)).body.code).toBe('eway-bill-expired');
    expect((await dispatch(above, captureBody({ declaredValuePaise: 20_000_000, ewayBillNumber: '123456789012', ewayBillDate: istToday(), ewayValidUntil: istToday(1) })).expect(200)).body.dispatch).toMatchObject({ declaredValuePaise: 20_000_000, ewayUnjudged: false });
    const below = await createOk([damagedLine('CG', 1)]);
    await pick(below).expect(200);
    await dispatch(below, captureBody({ declaredValuePaise: 1_000_000 })).expect(200);
    const unvalued = await createOk([damagedLine('CG', 1)]);
    await pick(unvalued).expect(200);
    expect((await dispatch(unvalued).expect(200)).body.dispatch).toMatchObject({ declaredValuePaise: null, ewayUnjudged: true });
  });

  // ── a serial line and a fractional line, end to end ────────────────────────

  it('a serial line from RETURNS: create 1, pick it, dispatch writes one draw with its serial arm; a serial picked 0 returns to awaiting', async () => {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, skuId: sku('CS'), binId: stockBin, quantityDelta: 2, reasonCode: 'stock-count', note: 'seed', serials: ['S-1', 'S-2'] })
      .expect(201);
    const serials = (await sql`select id, serial_number from serials where tenant_id = ${tenantId} and sku_id = ${sku('CS')} order by serial_number`) as unknown as { id: string; serial_number: string }[];
    for (const serial of serials) await rawDraw('CS', 1000, stockBin, serial.id);
    const rma = await returned([
      { skuCode: 'CS', qty: 1, serialNumber: 'S-1' },
      { skuCode: 'CS', qty: 1, serialNumber: 'S-2' },
    ]);
    const [first, second] = rma.lines;
    expect((await create({ lines: [returnsLine(first!.id, 0.5)] }).expect(400)).body.code).toBe('validation-failed');
    const rtc = await createOk([returnsLine(first!.id, 1), returnsLine(second!.id, 1)]);
    expect(rtc.lines.map((line) => line.serialNumber).sort()).toEqual(['S-1', 'S-2']);
    const s1 = rtc.lines.find((line) => line.serialNumber === 'S-1')!;
    const s2 = rtc.lines.find((line) => line.serialNumber === 'S-2')!;
    // A serial line is picked 0 or 1 — and a short (0) one goes back to awaiting.
    const picked = (await pick(rtc, { [s2.id]: 0 }).expect(200)).body as Rtc;
    expect(await openQtyOf(s2.returnReceiptLineId!)).toBe(1);
    await dispatch(picked).expect(200);
    const events = await rtcEvents(rtc.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'rtc.dispatched', quantity_delta: '-1000', serial_ref: serials.find((s) => s.serial_number === 'S-1')!.id, to_bin_id: null });
    expect(getLedgerEventType('rtc.dispatched')).toMatchObject({ sinceVersion: 1, referenceKinds: ['client-return'], allowsBatchArm: true, allowsSerialArm: true });
    expect(await openQtyOf(s1.returnReceiptLineId!)).toBe(0);
  });

  it('a fractional kg line from DAMAGED and a batch line, end to end (AD-9)', async () => {
    await receiveDamaged('CK', 2.5);
    await receiveDamaged('CL', 3, { batchCode: 'LOT-RTC' });
    const lot = await batchIdOf('CL', 'LOT-RTC');
    const before = await onHandIn('DAMAGED', 'CK');
    const rtc = await createOk([damagedLine('CK', 1.25), damagedLine('CL', 2, { batchId: lot })]);
    const kg = rtc.lines.find((line) => line.skuCode === 'CK')!;
    const picked = (await pick(rtc, { [kg.id]: 1.125 }).expect(200)).body as Rtc;
    expect(picked.lines.find((line) => line.skuCode === 'CK')!.pickedQuantity).toBe(1.125);
    await dispatch(picked).expect(200);
    expect(await onHandIn('DAMAGED', 'CK')).toBeCloseTo(before - 1.125, 6);
    expect(await onHandIn('DAMAGED', 'CL', lot)).toBe(1);
    const events = await rtcEvents(rtc.id);
    expect(events.find((event) => event.batch_ref === lot)).toMatchObject({ quantity_delta: '-2000' });
  });

  // ── the portal (decision 15, A14) ──────────────────────────────────────────

  it('AC4 — the portal: the client sees its RTC (status, carrier, AWB, packages, lines) as an exact allowlist, another client 404s it', async () => {
    await receiveDamaged('CF', 2);
    const rtc = await createOk([damagedLine('CF', 2)], { note: 'internal note' });
    await pick(rtc).expect(200);
    await dispatch(rtc).expect(200);
    const list = await http().get(`${API}/${tenantId}/portal/client-returns`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    const row = (list.body.items as Record<string, unknown>[]).find((item) => item.id === rtc.id)!;
    expect(Object.keys(row).sort()).toEqual(
      ['carrierName', 'code', 'createdAt', 'dispatchedAt', 'id', 'lineCount', 'packageCount', 'shippedQuantity', 'status', 'totalQuantity', 'trackingRef', 'transporterName'].sort(),
    );
    expect(row).toMatchObject({ status: 'dispatched', trackingRef: 'AWB777', packageCount: 2, transporterName: 'Fast Freight', shippedQuantity: 2 });
    const detail = await http().get(`${API}/${tenantId}/portal/client-returns/${rtc.id}`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    const keys = (value: unknown, prefix = ''): string[] =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [prefix + k, ...keys(v, `${prefix}${k}.`)])
        : Array.isArray(value)
          ? value.flatMap((v) => keys(v, prefix))
          : [];
    const all = new Set(keys(detail.body));
    for (const forbidden of ['note', 'cancelReason', 'by', 'byName', 'deviceId', 'binId', 'pickedBy', 'createdBy', 'reasonCode']) {
      expect([...all].some((key) => key === forbidden || key.endsWith(`.${forbidden}`))).toBe(false);
    }
    expect(detail.body.lines).toEqual([
      { lineNo: 1, source: 'damaged', skuCode: 'CF', skuName: 'Flow F', uom: 'each', batchCode: null, serialNumber: null, rmaCode: null, condition: null, quantity: 2, shippedQuantity: 2 },
    ]);
    expect(detail.body.brandDocument).toMatchObject({ type: 'challan', number: 'CH-9' });
    await http().get(`${API}/${tenantId}/portal/client-returns/${rtc.id}`).set('Authorization', `Bearer ${portalOther}`).expect(404);
    await http().get(`${API}/${tenantId}/portal/client-returns/${uuidv7()}`).set('Authorization', `Bearer ${portalBrand}`).expect(404);
    const otherList = await http().get(`${API}/${tenantId}/portal/client-returns`).set('Authorization', `Bearer ${portalOther}`).expect(200);
    expect((otherList.body.items as { id: string }[]).some((item) => item.id === rtc.id)).toBe(false);
    // Operator routes are closed to the portal token.
    await http().get(`${API}/${tenantId}/client-returns/${rtc.id}`).set('Authorization', `Bearer ${portalBrand}`).expect(403);
  });

  // ── the device snapshot (A10) ──────────────────────────────────────────────

  it('the device snapshot carries the draft RTCs as openClientReturns (kind client), and their clients', async () => {
    await receiveDamaged('CG', 1);
    const rtc = await createOk([damagedLine('CG', 1)]);
    const snapshot = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    const open = (snapshot.body.openClientReturns as { id: string }[]).find((item) => item.id === rtc.id);
    expect(open).toEqual({
      id: rtc.id,
      kind: 'client',
      code: rtc.code,
      clientId: brand,
      clientName: 'Brand Co',
      createdAt: expect.any(String),
      lines: [{ id: rtc.lines[0]!.id, lineNo: 1, source: 'damaged', skuId: sku('CG'), skuCode: 'CG', skuName: 'Flow G', batchCode: null, serialNumber: null, uom: 'each', qty: 1, rmaCode: null }],
    });
    expect((snapshot.body.clients as { id: string }[]).some((client) => client.id === brand)).toBe(true);
    await cancel(rtc).expect(200);
  });

  // ── hashes, vocabularies, RLS, contract ────────────────────────────────────

  it('A1 — the create, pick and cancel goldens (the server default of consigneeAddress and the reason hashed); reordered lines replay', async () => {
    await receiveDamaged('CH', 2);
    await receiveDamaged('CK', 1);
    const key = ulid();
    const body = { lines: [damagedLine('CK', 1), damagedLine('CH', 2)] };
    const rtc = (await create(body, key).expect(201)).body as Rtc;
    const sorted = [sku('CK'), sku('CH')].sort();
    expect(await storedHash(key)).toBe(
      hashCommandPayload({
        tenantId,
        arm: 'rtc-create',
        warehouseId: wh,
        consigneeAddress: 'return',
        lines: sorted.map((skuId) => ({ source: 'damaged', returnReceiptLineId: null, skuId, batchId: null, quantity: skuId === sku('CH') ? 2 : 1, reasonCode: 'client-instruction' })),
        note: null,
      }),
    );
    expect((await create({ lines: [damagedLine('CH', 2), damagedLine('CK', 1)] }, key).expect(201)).body).toEqual(rtc);
    expect((await create({ lines: [damagedLine('CH', 2)] }, key).expect(422)).body.code).toBe('idempotency-key-reuse');
    const pickKey = ulid();
    await pick(rtc, null, pickKey).expect(200);
    expect(await storedHash(pickKey)).toBe(
      hashCommandPayload({
        tenantId,
        arm: 'rtc-pick',
        clientReturnId: rtc.id,
        lines: [...rtc.lines].sort((a, b) => (a.id < b.id ? -1 : 1)).map((line) => ({ lineId: line.id, pickedQty: line.quantity })),
        occurredAt: PICKED_AT,
      }),
    );
    const cancelKey = ulid();
    await cancel(rtc, '  done  ', cancelKey).expect(200);
    expect(await storedHash(cancelKey)).toBe(hashCommandPayload({ tenantId, arm: 'rtc-cancel', clientReturnId: rtc.id, reason: 'done' }));
  });

  it('story 4-5a (A22, A43) — package labels: a picked RTC prints count=2 to its frozen return address (RETURN TO CLIENT, PACKAGE n/N, {code}.{n}); after dispatch the count defaults to the dispatched one and the carrier ref prints; a different count 409; a draft 409; unknown 404', async () => {
    await receiveDamaged('CF', 2);
    const rtc = await createOk([damagedLine('CF', 2)]);
    const labels = (query: string, id = rtc.id) =>
      http().get(`${API}/${tenantId}/client-returns/${id}/package-labels${query}`).set('Authorization', `Bearer ${opsToken}`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const problem = (res: request.Response) => JSON.parse((res.body as Buffer).toString('utf8')) as { code: string };
    expect(problem(await labels('?count=2').expect(409)).code).toBe('rtc-not-picked');
    expect(problem(await labels('?count=2', uuidv7()).expect(404)).code).toBe('not-found');
    await pick(rtc).expect(200);
    expect(problem(await labels('').expect(400)).code).toBe('validation-failed');
    const before = parseZplLabels((await labels('?count=2').expect(200)).body.toString('ascii'));
    expect(before.map((label) => label.barcodes.map((bar) => bar.payload))).toEqual([[`${rtc.code}.1`], [`${rtc.code}.2`]]);
    const words = zplTexts(before[1]!.raw).join(' | ');
    expect(words).toContain(`RETURN TO CLIENT ${rtc.code}`);
    expect(words).toContain('2/2');
    expect(words).toContain('Returns Desk');
    expect(words).toContain('7 Returns Lane');
    await dispatch(rtc).expect(200);
    const after = await labels('?format=pdf').expect(200);
    expect(after.headers['content-disposition']).toBe(`attachment; filename="${rtc.code}-package-labels.pdf"`);
    const pages = await readPdfLabels(after.body as Buffer);
    expect(pages.map((page) => page.payloads)).toEqual([
      ['AWB777', `${rtc.code}.1`],
      ['AWB777', `${rtc.code}.2`],
    ]);
    expect(problem(await labels('?count=3').expect(409)).code).toBe('package-count-mismatch');
    // Review — labels.execute is judged before any value the handler judges: an accountant sending a
    // bad format still gets 403 role-denied, never the 400.
    const accountant = await createMember('accountant');
    const accountantToken = (await mintSignIn(app, { email: accountant.email, password: 'correct-horse-battery' })).body.accessToken as string;
    const denied = await http()
      .get(`${API}/${tenantId}/client-returns/${rtc.id}/package-labels?format=nope`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(403);
    expect(denied.body.code).toBe('role-denied');
  });

  it('the tuples mirror their DB CHECKs; an old receipt-line read keeps its bytes (A6)', async () => {
    const def = async (name: string): Promise<string> =>
      ((await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`) as unknown as { def: string }[])[0]!.def;
    const literals = (text: string): Set<string> => new Set(text.match(/'[a-z_-]+'/g));
    expect(literals(await def('client_returns_status_check'))).toEqual(new Set(CLIENT_RETURN_STATUSES.map((v) => `'${v}'`)));
    expect(literals(await def('client_returns_consignee_address_kind_check'))).toEqual(new Set(RTC_ADDRESS_KINDS.map((v) => `'${v}'`)));
    expect(literals(await def('client_returns_brand_document_type_check'))).toEqual(new Set(RTV_BRAND_DOCUMENT_TYPES.map((v) => `'${v}'`)));
    expect(literals(await def('client_return_lines_source_check'))).toEqual(new Set(RTC_LINE_SOURCES.map((v) => `'${v}'`)));
    expect(literals(await def('client_return_lines_reason_check'))).toEqual(new Set(RETURN_DISPOSITION_REASONS.map((v) => `'${v}'`)));
    // A6 — a receipt line no RTC ever named carries neither split key.
    const rma = await returned([{ skuCode: 'CG', qty: 1 }]);
    expect(Object.keys(await receiptLine(rma.rmaId, rma.lines[0]!.id))).not.toContain('returningToClientQty');
  });

  it('RLS: client_returns and its lines are tenant- and client-isolated (wms_rls_probe)', async () => {
    const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${PROBE_LOCK})`;
      await tx.unsafe(`do $$ begin if not exists (select from pg_roles where rolname = 'wms_rls_probe') then create role wms_rls_probe login password 'wms_rls_probe' nosuperuser; end if; end $$;`);
      await tx.unsafe('grant usage on schema public to wms_rls_probe');
      await tx.unsafe('grant select, insert, update, delete on all tables in schema public to wms_rls_probe');
    });
    await admin.end();
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const probe = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      const count = (tenant: string, client: string | null, table: 'client_returns' | 'client_return_lines'): Promise<number> =>
        probe.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenant}, true)`;
          if (client !== null) await tx`select set_config('app.client_id', ${client}, true)`;
          const rows = (await tx.unsafe(`select count(*)::int as n from ${table}`)) as unknown as { n: number }[];
          return Number(rows[0]!.n);
        }) as Promise<number>;
      const total = Number(((await sql`select count(*)::int as n from client_returns where tenant_id = ${tenantId}`) as unknown as { n: number }[])[0]!.n);
      const brandOwn = Number(((await sql`select count(*)::int as n from client_returns where tenant_id = ${tenantId} and client_id = ${brand}`) as unknown as { n: number }[])[0]!.n);
      expect(total).toBeGreaterThan(brandOwn);
      expect(await count(tenantId, null, 'client_returns')).toBe(total);
      expect(await count(tenantId, brand, 'client_returns')).toBe(brandOwn);
      expect(await count(uuidv7(), null, 'client_returns')).toBe(0);
      const brandLines = Number(
        ((await sql`select count(*)::int as n from client_return_lines l join client_returns r on r.id = l.client_return_id where r.tenant_id = ${tenantId} and r.client_id = ${brand}`) as unknown as { n: number }[])[0]!.n,
      );
      expect(await count(tenantId, brand, 'client_return_lines')).toBe(brandLines);
      expect(await count(tenantId, bare, 'client_return_lines')).toBe(0);
      expect(await count(uuidv7(), null, 'client_return_lines')).toBe(0);
    } finally {
      await probe.end();
    }
  });

  it('the OpenAPI document lists the seven routes', async () => {
    const doc = (await http().get('/api/v1/openapi.json').expect(200)).body as { paths: Record<string, Record<string, unknown>> };
    for (const [path, method] of [
      ['/tenants/{tenantId}/client-returns', 'post'],
      ['/tenants/{tenantId}/client-returns', 'get'],
      ['/tenants/{tenantId}/client-returns/{clientReturnId}', 'get'],
      ['/tenants/{tenantId}/client-returns/{clientReturnId}/pick', 'post'],
      ['/tenants/{tenantId}/client-returns/{clientReturnId}/dispatch', 'post'],
      ['/tenants/{tenantId}/client-returns/{clientReturnId}/cancel', 'post'],
      ['/tenants/{tenantId}/warehouses/{warehouseId}/client-returns/returnable', 'get'],
      ['/tenants/{tenantId}/portal/client-returns', 'get'],
      ['/tenants/{tenantId}/portal/client-returns/{clientReturnId}', 'get'],
    ] as const) {
      expect(doc.paths[path]?.[method]).toBeDefined();
    }
  });

  // ── same-key races (§1 — the parked waiter) ────────────────────────────────

  describe('races', () => {
    function handle(): postgres.Sql<Record<string, unknown>> {
      return postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    }

    async function waitParked(holderPid: number, min: number): Promise<void> {
      const probe = handle();
      try {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active'
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
        throw new Error(`fewer than ${min} request(s) parked behind the holder`);
      } finally {
        await probe.end();
      }
    }

    async function raceTwice(lockSql: (tx: postgres.TransactionSql) => Promise<{ pid: number }[]>, send: () => SupertestTest): Promise<[request.Response, request.Response]> {
      const holder = handle();
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = await lockSql(tx);
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

    it('create: two same-key requests parked behind the receipt line answer the same body — one RTC, one key', async () => {
      const rma = await returned([{ skuCode: 'CH', qty: 2 }]);
      const line = rma.lines[0]!;
      const key = ulid();
      const send = () => create({ lines: [returnsLine(line.id, 2)] }, key);
      const [a, b] = await raceTwice((tx) => tx`select pg_backend_pid() as pid from return_receipt_lines where id = ${line.id} for update` as unknown as Promise<{ pid: number }[]>, send);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body).toEqual(b.body);
      expect(Number(((await sql`select count(*)::int as n from client_return_lines where return_receipt_line_id = ${line.id}`) as unknown as { n: number }[])[0]!.n)).toBe(1);
      expect(await openQtyOf(line.id)).toBe(0);
      await cancel(a.body as Rtc).expect(200);
    });

    it('a DB race: an RTC create against a 4-7a dispose on one line whose sum exceeds open_qty — exactly one wins', async () => {
      const rma = await returned([{ skuCode: 'CH', qty: 3 }]);
      const line = rma.lines[0]!;
      const holder = handle();
      let rtcReq: Promise<request.Response> | undefined;
      let disposeReq: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from return_receipt_lines where id = ${line.id} for update`) as unknown as { pid: number }[];
          rtcReq = (async () => create({ lines: [returnsLine(line.id, 2)] }))();
          disposeReq = (async () =>
            http()
              .post(`${API}/${tenantId}/returns/dispositions`)
              .set('Authorization', `Bearer ${opsToken}`)
              .set(KEY_HEADER, ulid())
              .send({ warehouseId: wh, receiptLineId: line.id, outcome: 'restock', qty: 2, toBinId: stockBin }))();
          await waitParked(locked[0]!.pid, 2);
        });
        const [rtcRes, disposeRes] = await Promise.all([rtcReq!, disposeReq!]);
        expect([rtcRes.status, disposeRes.status].sort()).toEqual([201, 409]);
        expect((rtcRes.status === 409 ? rtcRes : disposeRes).body.code).toBe('exceeds-awaiting');
        expect(await openQtyOf(line.id)).toBe(1);
        if (rtcRes.status === 201) await cancel(rtcRes.body as Rtc).expect(200);
      } finally {
        await Promise.allSettled([rtcReq, disposeReq]);
        await holder.end();
      }
    });

    it('the DAMAGED pool: an RTC create and an RTV create on one arm whose sum exceeds on-hand, parked behind the pool advisory — exactly one wins', async () => {
      await receiveDamaged('CN', 5);
      const holder = handle();
      let rtcReq: Promise<request.Response> | undefined;
      let rtvReq: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid, pg_advisory_xact_lock(hashtextextended(${damagedPoolLockKey(tenantId, wh)}, 0))`) as unknown as { pid: number }[];
          rtcReq = (async () => create({ lines: [damagedLine('CN', 3)] }))();
          rtvReq = (async () =>
            http()
              .post(`${API}/${tenantId}/vendor-returns`)
              .set('Authorization', `Bearer ${opsToken}`)
              .set(KEY_HEADER, ulid())
              .send({ warehouseId: wh, vendorId: vendor, consigneeAddress: 'dispatch', lines: [{ skuId: sku('CN'), quantity: 3, reasonCode: 'damaged' }] }))();
          await waitParked(locked[0]!.pid, 2);
        });
        const [rtcRes, rtvRes] = await Promise.all([rtcReq!, rtvReq!]);
        expect([rtcRes.status, rtvRes.status].sort()).toEqual([201, 409]);
        if (rtcRes.status === 409) expect(rtcRes.body.code).toBe('rtc-exceeds-damaged');
        else expect(rtvRes.body.code).toBe('rtv-exceeds-damaged');
        if (rtcRes.status === 201) await cancel(rtcRes.body as Rtc).expect(200);
        else await http().post(`${API}/${tenantId}/vendor-returns/${rtvRes.body.id as string}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ reason: 'race over' }).expect(200);
      } finally {
        await Promise.allSettled([rtcReq, rtvReq]);
        await holder.end();
      }
    });

    it('pick: two same-key device ops parked behind the device row answer the same body', async () => {
      await receiveDamaged('CH', 1);
      const rtc = await createOk([damagedLine('CH', 1)]);
      const key = ulid();
      const [a, b] = await raceTwice((tx) => tx`select pg_backend_pid() as pid from devices where id = ${deviceId} for update` as unknown as Promise<{ pid: number }[]>, () => pick(rtc, null, key));
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body).toEqual(b.body);
      await cancel(rtc).expect(200);
    });

    it('dispatch: two same-key requests parked behind the RTC row answer the same body — one draw per line, one key', async () => {
      await receiveDamaged('CH', 1);
      const rtc = await createOk([damagedLine('CH', 1)]);
      await pick(rtc).expect(200);
      const key = ulid();
      const [a, b] = await raceTwice((tx) => tx`select pg_backend_pid() as pid from client_returns where id = ${rtc.id} for update` as unknown as Promise<{ pid: number }[]>, () => dispatch(rtc, captureBody(), key));
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body).toEqual(b.body);
      expect(await rtcEvents(rtc.id)).toHaveLength(1);
      expect(Number(((await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { n: number }[])[0]!.n)).toBe(1);
    });
  });
});
