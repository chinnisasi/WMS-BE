import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import type { Database } from '../src/shared/db/db';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { batchLedgerFiguresInTx } from '../src/modules/inventory/recall-trace';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { REJECTED_OP_DECISIONS_BY_TYPE, REJECTED_OP_TYPES } from '../src/modules/tenancy/sync-report.command';
import { SKU_NAMING_OP_TYPES } from '../src/modules/tenancy/client-wind-down';
import { ReturnsFacade } from '../src/modules/returns/returns.facade';
import { createPayloadHash, normalizeCreate } from '../src/modules/returns/return-authorization.command';
import { normalizeReceive, receivePayloadHash } from '../src/modules/returns/return-receipt.command';
import { disposePayloadHash, normalizeDispose, normalizeRestock, restockPayloadHash } from '../src/modules/returns/return-disposition.command';
import {
  BLIND_ENTRY_REFUSALS,
  blindAcceptPayloadHash,
  blindReceivePayloadHash,
  blindRejectPayloadHash,
  classifyBlindEntry,
  normalizeBlindReceive,
  normalizeBlindReject,
  planBlindLinks,
  type BlindClassifyContext,
  type NormalizedBlindEntry,
} from '../src/modules/returns/blind-return.command';
import type { SkuFacts } from '../src/modules/catalog/catalog.facade';
import { ReturnsController } from '../src/api/returns.controller';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { expectAuditRow } from './support/audit-guard';
import { dispatchedOrderFixtures } from './support/dispatched-order';
import { mintSignIn } from './support/sign-in';

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

interface ReceiptLineView {
  id: string;
  rmaLineId: string;
  skuId: string;
  qty: number;
  openQty: number;
  pendingReviewQty?: number;
  reversedQty?: number;
}

interface RmaBody {
  id: string;
  code: string;
  status: string;
  origin?: string;
  reviewStatus?: string | null;
  orderId: string | null;
  orderDispatchedAt: string | null;
  parcelReference?: string | null;
  suggestedOrderId?: string | null;
  matchKind?: string | null;
  clientPrompted?: boolean | null;
  lines: { id: string; orderLineId: string | null; skuId: string; authorizedQty: number; receivedQty: number; reasonCode: string; serials: { serialNumber: string }[] }[];
  receipts?: { id: string; code: string; lines: ReceiptLineView[] }[];
  openRmasForSuggestedOrder?: { id: string; code: string; status: string }[];
  sameParcelRmas?: { id: string; code: string; reviewStatus: string }[];
  unlinkedLines?: string[];
}

interface ReturnableBody {
  lines: { orderLineId: string; skuId: string; returnableQty: number }[];
}

/** Second-precision device time, Z-suffixed. */
function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * Story 4-7b — blind returns: an unannounced parcel received on the handheld
 * with no RMA, its web review (accept and link, or reject and reverse), and
 * 4-7a's disposition gated on the review. Every row of the spec's matrices
 * that the backend owns, driven through real HTTP against really dispatched
 * orders: the classification, both match arms, linking, the returnable after
 * accept, the disposition guards, the reversal and re-receipt, reconcile and
 * the recall fold, the portal hiding rule, the goldens and the races.
 */
describe('blind returns (e2e, story 4-7b)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let inventory: InventoryFacade;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorToken: string;
  let operatorUserId: string;
  let deviceId: string;
  let warehouseId: string;
  let otherWarehouseId: string;
  let stockBin: string;
  let brandId: string;
  let otherClientId: string;
  let portalBrand: string;
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('blind_returns');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 3, onnotice: () => undefined });
    inventory = app.get(InventoryFacade);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Blind Returns Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
    const ops = await createMember('ops_manager');
    opsToken = ops.token;
    opsUserId = ops.userId;
    const floor = await createMember('operator');
    operatorUserId = floor.userId;

    warehouseId = await createWarehouse('BR');
    otherWarehouseId = await createWarehouse('BX');
    const zoneId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    stockBin = await createBin(zoneId, 'A-00');

    for (const [code, name] of [
      ['BRAND', 'Brand Co'],
      ['OTHER', 'Other Co'],
    ] as const) {
      const res = await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name }).expect(201);
      if (code === 'BRAND') brandId = res.body.client.id as string;
      else otherClientId = res.body.client.id as string;
    }
    await importSkus(brandId, [
      'BA-1,Brand plain,pcs,,1800,,false,false,false,,,',
      'BA-2,Brand second,pcs,,1800,,false,false,false,,,',
      'BA-SER,Brand serial,pcs,,1800,,false,true,false,,,',
      'BA-BAT,Brand batch,pcs,,1800,,true,false,false,,,',
    ]);
    await importSkus(otherClientId, ['BB-1,Other plain,pcs,,1800,,false,false,false,,,']);
    await seedStock(sku('BA-1'), 1000);
    await seedStock(sku('BA-2'), 1000);
    await seedStock(sku('BB-1'), 100);
    await seedStock(sku('BA-SER'), 4, ['BS-1', 'BS-2', 'BS-3', 'BS-4']);
    await fixtures.seedBatchStock(sku('BA-BAT'), stockBin, 10, 'LOT-B1');

    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Blind returns scanner', pin: '2468' })
      .expect(201);
    deviceId = enrolled.body.device.id as string;
    operatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: floor.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;
    portalBrand = await portalUser(brandId);
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

  async function importSkus(clientId: string, rows: string[]): Promise<void> {
    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode',
      ...rows,
    ].join('\n');
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

  async function createWarehouse(prefix: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${prefix}-${ulid().slice(20)}`, name: `${prefix} WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
  }

  async function createBin(zoneId: string, code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code })
        .expect(201)
    ).body.id as string;
  }

  async function createMember(role: string): Promise<{ userId: string; token: string; email: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role }).expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const token = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
    return { userId: invited.body.user.id as string, token, email };
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
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    return (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
  }

  async function seedStock(skuId: string, quantity: number, serials?: string[]): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId: stockBin,
        quantityDelta: quantity,
        reasonCode: 'stock-count',
        note: 'blind-returns seed',
        ...(serials === undefined ? {} : { serials }),
      })
      .expect(201);
  }

  async function count(query: PromiseLike<unknown>): Promise<number> {
    const rows = (await query) as { n: number | string }[];
    return Number(rows[0]!.n);
  }

  async function returnsBin(wh = warehouseId): Promise<string> {
    const rows = (await sql`select id from bins where tenant_id = ${tenantId} and warehouse_id = ${wh} and code = 'RETURNS' and system_owned`) as unknown as { id: string }[];
    return rows[0]!.id;
  }

  async function onHandIn(bin: string, skuId: string): Promise<number> {
    return count(sql`select coalesce(sum(quantity), 0)::bigint as n from stock_on_hand where tenant_id = ${tenantId} and bin_id = ${bin} and sku_id = ${skuId}`);
  }

  /** A dispatched order of `lines` (serials picked from `serials` on the first line), its returnable read. */
  async function dispatchedOrder(
    lines: { skuId: string; quantity: number }[],
    options: { serials?: string[]; clientOrderRef?: string } = {},
  ): Promise<{ orderId: string; returnable: ReturnableBody }> {
    const { orderId, picklist } = await fixtures.releasedWave(lines, options.clientOrderRef === undefined ? {} : { clientOrderRef: options.clientOrderRef });
    await fixtures.pickAllLines(picklist, undefined, options.serials === undefined ? undefined : new Map([[picklist.lines[0]!.id, options.serials]]));
    const bySku = new Map<string, number>();
    for (const line of picklist.lines) bySku.set(line.skuId, (bySku.get(line.skuId) ?? 0) + line.qty);
    await fixtures.packAndDispatch(
      orderId,
      [...bySku].map(([skuId, qty]) => ({ skuId, qty })),
    );
    return { orderId, returnable: await returnable(orderId) };
  }

  async function returnable(orderId: string): Promise<ReturnableBody> {
    return (await http().get(`${API}/${tenantId}/returns/returnable?orderId=${orderId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body as ReturnableBody;
  }

  async function addShipment(orderId: string, trackingNumber: string, status: 'labelled' | 'manifested' | 'voided' = 'labelled'): Promise<void> {
    // The pairing CHECKs: a manifested label names its manifest, a voided one when and by whom.
    const manifestId = status === 'manifested' ? uuidv7() : null;
    const voidedAt = status === 'voided' ? new Date().toISOString() : null;
    const voidedBy = status === 'voided' ? opsUserId : null;
    await sql`insert into shipments (id, tenant_id, warehouse_id, order_id, status, carrier_connection_id, carrier_code, carrier_name, tracking_number, label_document_ref, labelled_by, labelled_at, manifest_id, voided_at, voided_by)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${orderId}, ${status}, ${uuidv7()}, 'sandbox', 'Sandbox', ${trackingNumber}, 'doc', ${opsUserId}, now(), ${manifestId}, ${voidedAt}, ${voidedBy})`;
  }

  interface Entry {
    skuId: string;
    qty: number;
    condition?: string;
    serialNumber?: string | null;
    batchCode?: string | null;
  }

  function receiveBlind(
    body: { entries: Entry[]; parcelReference?: string | null; clientId?: string; clientPrompted?: boolean; warehouseId?: string; occurredAt?: string },
    key = ulid(),
  ): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/returns/blind-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send({
        warehouseId: body.warehouseId ?? warehouseId,
        clientId: body.clientId ?? brandId,
        clientPrompted: body.clientPrompted ?? false,
        parcelReference: body.parcelReference ?? null,
        occurredAt: body.occurredAt ?? nowUtc(),
        entries: body.entries.map((entry) => ({
          skuId: entry.skuId,
          qty: entry.qty,
          condition: entry.condition ?? 'resaleable',
          note: null,
          batchCode: entry.batchCode ?? null,
          serialNumber: entry.serialNumber ?? null,
          weightGrams: null,
        })),
      });
  }

  function accept(rmaId: string, orderId: string | null, key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/returns/${rmaId}/accept`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({ orderId });
  }

  function reject(rmaId: string, body: { reasonCode: string; note?: string | null }, key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/returns/${rmaId}/reject`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  async function rmaDetail(rmaId: string): Promise<RmaBody> {
    return (await http().get(`${API}/${tenantId}/returns/${rmaId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body as RmaBody;
  }

  function receiptLines(detail: RmaBody): ReceiptLineView[] {
    return detail.receipts!.flatMap((receipt) => receipt.lines);
  }

  // ── the receipt ────────────────────────────────────────────────────────────

  it('happy path: an unannounced parcel books into RETURNS under a blind RMA (received, review pending, open 0), suggests the order by its reference, and stays out of ATP; the audit row targets the receipt', async () => {
    const { orderId } = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 5 }], { clientOrderRef: 'ORD-777' });
    const bin = await returnsBin().catch(() => null);
    const before = bin === null ? 0 : await onHandIn(bin, sku('BA-1'));
    const atpBefore = (await inventory.atp(tenantId, warehouseId, sku('BA-1'))).atp;
    const key = ulid();
    const at = nowUtc();
    const res = await receiveBlind({ parcelReference: '  ORD-777 ', occurredAt: at, entries: [{ skuId: sku('BA-1'), qty: 3 }] }, key).expect(201);
    expect(res.body).toMatchObject({ suggestedOrderId: orderId, matchKind: 'order-reference', applied: [{ entryIndex: 0, qty: 3 }], refused: [], reviewOpId: null });
    expect(res.body.rmaCode).toMatch(/^RMA-\d{4}$/);
    expect(res.body.code).toMatch(/^RRN-\d{4}$/);
    const detail = await rmaDetail(res.body.rmaId as string);
    expect(detail).toMatchObject({
      status: 'received',
      origin: 'blind',
      reviewStatus: 'pending',
      orderId: null,
      orderDispatchedAt: null,
      parcelReference: 'ORD-777',
      suggestedOrderId: orderId,
      matchKind: 'order-reference',
      clientPrompted: false,
      openRmasForSuggestedOrder: [],
      sameParcelRmas: [],
    });
    expect(detail.lines).toEqual([expect.objectContaining({ orderLineId: null, skuId: sku('BA-1'), authorizedQty: 3, receivedQty: 3, reasonCode: 'unannounced' })]);
    expect(receiptLines(detail)).toEqual([expect.objectContaining({ qty: 3, openQty: 0, pendingReviewQty: 3, reversedQty: 0 })]);
    expect(await onHandIn(await returnsBin(), sku('BA-1'))).toBe(before + 3000);
    expect((await inventory.atp(tenantId, warehouseId, sku('BA-1'))).atp).toBe(atpBefore);
    const events = (await sql`select type, to_bin_id from ledger_events where tenant_id = ${tenantId} and reference_doc->>'rmaId' = ${res.body.rmaId as string}`) as unknown as {
      type: string;
      to_bin_id: string;
    }[];
    expect(events).toEqual([{ type: 'return.received', to_bin_id: await returnsBin() }]);
    await expectAuditRow({ tenantId, key, action: 'return_receipt.blind_recorded', targetType: 'return_receipt', targetId: res.body.returnReceiptId as string, actorUserId: operatorUserId });
    // Replay: the stored snapshot, nothing twice.
    // The parcel reference is hashed normalized (trimmed): a re-send with the bare value replays.
    const again = await receiveBlind({ parcelReference: 'ORD-777', occurredAt: at, entries: [{ skuId: sku('BA-1'), qty: 3 }] }, key).expect(201);
    expect(again.body).toEqual(res.body);
    expect(await count(sql`select count(*)::int as n from return_receipts where tenant_id = ${tenantId} and idempotency_key = ${key}`)).toBe(1);
    await expectAuditRow({ tenantId, key, action: 'return_receipt.blind_recorded', targetType: 'return_receipt', targetId: res.body.returnReceiptId as string, actorUserId: operatorUserId });
    // The Unannounced list: the pending filter finds it.
    const pending = await http().get(`${API}/${tenantId}/returns?reviewStatus=pending&limit=100`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((pending.body.items as RmaBody[]).some((item) => item.id === res.body.rmaId && item.origin === 'blind')).toBe(true);
  });

  it('the classification: per entry, the first failing rule names the refusal; the refused entries land in ONE Discard-only review row; the applied ones book', async () => {
    await dispatchedOrder([{ skuId: sku('BA-SER'), quantity: 1 }], { serials: ['BS-1'] });
    const key = ulid();
    const res = await receiveBlind(
      {
        entries: [
          { skuId: sku('BA-SER'), qty: 1, serialNumber: 'BS-1' }, // 0 applies
          { skuId: uuidv7(), qty: 1 }, // 1 not-in-catalog
          { skuId: sku('BB-1'), qty: 1 }, // 2 sku-not-of-client
          { skuId: sku('BA-1'), qty: 1.5 }, // 3 qty-precision
          { skuId: sku('BA-SER'), qty: 1 }, // 4 missing-capture
          { skuId: sku('BA-1'), qty: 1, serialNumber: 'X' }, // 5 unexpected-capture
          { skuId: sku('BA-SER'), qty: 1, serialNumber: 'NOPE' }, // 6 serial-unknown
          { skuId: sku('BA-SER'), qty: 1, serialNumber: 'BS-2' }, // 7 serial-in-stock
          { skuId: sku('BA-SER'), qty: 1, serialNumber: 'BS-1' }, // 8 serial-duplicate
          { skuId: sku('BA-BAT'), qty: 1, batchCode: 'NO-SUCH-LOT' }, // 9 batch-unknown
          { skuId: sku('BA-BAT'), qty: 1, batchCode: 'LOT-B1' }, // 10 applies (an existing batch)
        ],
      },
      key,
    ).expect(201);
    expect(res.body.applied.map((item: { entryIndex: number }) => item.entryIndex)).toEqual([0, 10]);
    expect(res.body.refused).toEqual([
      { entryIndex: 1, reason: 'not-in-catalog' },
      { entryIndex: 2, reason: 'sku-not-of-client' },
      { entryIndex: 3, reason: 'qty-precision' },
      { entryIndex: 4, reason: 'missing-capture' },
      { entryIndex: 5, reason: 'unexpected-capture' },
      { entryIndex: 6, reason: 'serial-unknown' },
      { entryIndex: 7, reason: 'serial-in-stock' },
      { entryIndex: 8, reason: 'serial-duplicate' },
      { entryIndex: 9, reason: 'batch-unknown' },
    ]);
    const rows = (await sql`select op_type, problem_code, payload from rejected_ops where tenant_id = ${tenantId} and op_id = ${res.body.reviewOpId as string}`) as unknown as {
      op_type: string;
      problem_code: string;
      payload: { refusals: unknown[]; entries: unknown[]; clientId: string };
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op_type: 'return.receive_blind', problem_code: 'blind-entries-refused' });
    expect(rows[0]!.payload.refusals).toHaveLength(9);
    expect(rows[0]!.payload.entries).toHaveLength(9);
    expect(rows[0]!.payload.clientId).toBe(brandId);
    // One RMA line per applied entry (A11), in request order.
    const detail = await rmaDetail(res.body.rmaId as string);
    expect(detail.lines.map((line) => [line.skuId, line.authorizedQty])).toEqual([
      [sku('BA-SER'), 1],
      [sku('BA-BAT'), 1],
    ]);
    expect(detail.lines[0]!.serials.map((serial) => serial.serialNumber)).toEqual(['BS-1']);
    // The review row is Discard only; apply is 409 decision-not-available.
    const reviewRow = (await sql`select id from rejected_ops where tenant_id = ${tenantId} and op_id = ${res.body.reviewOpId as string}`) as unknown as { id: string }[];
    const refused = await http()
      .post(`${API}/${tenantId}/rejected-ops/${reviewRow[0]!.id}/resolve`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'apply' })
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'decision-not-available', decisions: ['discard'] });
    expect(refused.body.detail).toContain('receive them again as an unannounced parcel');
    // Clean up the open serial for later tests: reject reverses it.
    await reject(res.body.rmaId as string, { reasonCode: 'mis-scanned' }).expect(200);
  });

  it('all refused: no RMA, no receipt, one review row; the audit row targets the device', async () => {
    const rmasBefore = await count(sql`select count(*)::int as n from return_authorizations where tenant_id = ${tenantId}`);
    const key = ulid();
    const res = await receiveBlind({ entries: [{ skuId: sku('BB-1'), qty: 1 }] }, key).expect(201);
    expect(res.body).toMatchObject({ rmaId: null, rmaCode: null, returnReceiptId: null, code: null, applied: [], refused: [{ entryIndex: 0, reason: 'sku-not-of-client' }] });
    expect(res.body.reviewOpId).not.toBeNull();
    expect(await count(sql`select count(*)::int as n from return_authorizations where tenant_id = ${tenantId}`)).toBe(rmasBefore);
    await expectAuditRow({ tenantId, key, action: 'return_receipt.blind_recorded', targetType: 'device', targetId: deviceId, actorUserId: operatorUserId });
  });

  it('the AWB arm: a carrier-labelled shipment suggests its order (awb); a voided label never does; two orders on one AWB give no suggestion', async () => {
    const { orderId } = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 2 }]);
    await addShipment(orderId, 'AWB-ONE');
    const one = await receiveBlind({ parcelReference: 'AWB-ONE', entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
    expect(one.body).toMatchObject({ suggestedOrderId: orderId, matchKind: 'awb' });

    const voided = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 1 }]);
    await addShipment(voided.orderId, 'AWB-VOID', 'voided');
    const none = await receiveBlind({ parcelReference: 'AWB-VOID', entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
    expect(none.body).toMatchObject({ suggestedOrderId: null, matchKind: null });

    const a = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 1 }]);
    const b = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 1 }]);
    await addShipment(a.orderId, 'AWB-TWICE');
    await addShipment(b.orderId, 'AWB-TWICE', 'manifested');
    const ambiguous = await receiveBlind({ parcelReference: 'AWB-TWICE', entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
    expect(ambiguous.body).toMatchObject({ suggestedOrderId: null, matchKind: null });

    // Another client's order never matches (the client predicate).
    const other = await dispatchedOrder([{ skuId: sku('BB-1'), quantity: 1 }], { clientOrderRef: 'OTHER-REF' });
    expect(other.orderId).toBeDefined();
    const foreign = await receiveBlind({ parcelReference: 'OTHER-REF', entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
    expect(foreign.body.suggestedOrderId).toBeNull();
  });

  it('the order-reference arm after 4-2c (D6): the exact pass names a follow-on by its printed label and a root by its bare number; the chain alone would give no suggestion', async () => {
    const root = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 1 }], { clientOrderRef: 'FO-77' });
    const follow = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 1 }], { clientOrderRef: 'FO-77-TMP' });
    // Make the second order the root's backorder follow-on (4-2c's shape: it carries the root's number).
    await sql`update orders set client_order_ref = 'FO-77', follow_on_of_order_id = ${root.orderId}, follow_on_root_order_id = ${root.orderId}, follow_on_seq = 1 where tenant_id = ${tenantId} and id = ${follow.orderId}`;
    const printed = await receiveBlind({ parcelReference: 'FO-77-BO1', entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
    expect(printed.body).toMatchObject({ suggestedOrderId: follow.orderId, matchKind: 'order-reference' });
    const bare = await receiveBlind({ parcelReference: 'FO-77', entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
    expect(bare.body).toMatchObject({ suggestedOrderId: root.orderId, matchKind: 'order-reference' });
  });

  it('portal stock counts a pending parcel in on-hand (A17) while the portal returns list omits it', async () => {
    const stockOf = async (): Promise<number> => {
      const res = await http().get(`${API}/${tenantId}/portal/stock?limit=100`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
      return (res.body.items as { skuId: string; onHand: number }[])
        .filter((row) => row.skuId === sku('BA-1'))
        .reduce((acc, row) => acc + row.onHand, 0);
    };
    const before = await stockOf();
    const res = await receiveBlind({ entries: [{ skuId: sku('BA-1'), qty: 2 }] }).expect(201);
    expect(await stockOf()).toBe(before + 2);
    const list = await http().get(`${API}/${tenantId}/portal/returns?limit=100`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    expect((list.body.items as { id: string }[]).some((item) => item.id === res.body.rmaId)).toBe(false);
  });

  // ── accept ─────────────────────────────────────────────────────────────────

  it('accept with the order: the line links, its units open to disposition (4-7a refused while pending — review-pending / exceeds-awaiting — and allowed after), the order\'s returnable falls, a second RMA refuses exceeds-returnable; the portal lists it only once accepted', async () => {
    const { orderId, returnable: before } = await dispatchedOrder([{ skuId: sku('BA-2'), quantity: 5 }], { clientOrderRef: 'ACC-1' });
    const orderLine = before.lines.find((line) => line.skuId === sku('BA-2'))!;
    const res = await receiveBlind({ parcelReference: 'ACC-1', entries: [{ skuId: sku('BA-2'), qty: 3 }] }).expect(201);
    const rmaId = res.body.rmaId as string;
    const line = receiptLines(await rmaDetail(rmaId))[0]!;

    // Pending: the web dispose answers review-pending; the device restock finds nothing awaiting.
    const pendingDispose = await http()
      .post(`${API}/${tenantId}/returns/dispositions`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, receiptLineId: line.id, outcome: 'scrap', qty: 1, reasonCode: 'damaged' })
      .expect(409);
    expect(pendingDispose.body).toMatchObject({ code: 'review-pending', reviewStatus: 'pending' });
    const pendingRestock = await http()
      .post(`${API}/${tenantId}/returns/restocks`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: sku('BA-2'), qty: 1, batchCode: null, serialNumbers: null, toBinId: stockBin, occurredAt: nowUtc() })
      .expect(409);
    expect(pendingRestock.body.code).toBe('exceeds-awaiting');
    // Not on the awaiting queue; hidden from the portal (404 = unknown).
    const queue = await http().get(`${API}/${tenantId}/returns/awaiting?warehouseId=${warehouseId}&limit=100`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((queue.body.items as { receiptLineId: string }[]).some((item) => item.receiptLineId === line.id)).toBe(false);
    await http().get(`${API}/${tenantId}/portal/returns/${rmaId}`).set('Authorization', `Bearer ${portalBrand}`).expect(404);
    const portalPending = await http().get(`${API}/${tenantId}/portal/returns?limit=100`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    expect((portalPending.body.items as { id: string }[]).some((item) => item.id === rmaId)).toBe(false);

    const key = ulid();
    const accepted = await accept(rmaId, orderId, key).expect(200);
    expect(accepted.body).toMatchObject({ reviewStatus: 'accepted', orderId, unlinkedLines: [] });
    expect(accepted.body.orderDispatchedAt).not.toBeNull();
    expect(accepted.body.lines[0]).toMatchObject({ orderLineId: orderLine.orderLineId });
    await expectAuditRow({ tenantId, key, action: 'return_authorization.blind_accepted', targetType: 'return_authorization', targetId: rmaId, actorUserId: opsUserId });
    const replayed = await accept(rmaId, orderId, key).expect(200);
    expect(replayed.body).toEqual(accepted.body);
    await expectAuditRow({ tenantId, key, action: 'return_authorization.blind_accepted', targetType: 'return_authorization', targetId: rmaId, actorUserId: opsUserId });

    const after = receiptLines(await rmaDetail(rmaId))[0]!;
    expect(after).toMatchObject({ openQty: 3, pendingReviewQty: 0, reversedQty: 0 });
    expect((await returnable(orderId)).lines.find((l) => l.orderLineId === orderLine.orderLineId)!.returnableQty).toBe(2);
    const second = await http()
      .post(`${API}/${tenantId}/returns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ orderId, lines: [{ orderLineId: orderLine.orderLineId, qty: 3, reasonCode: 'damaged' }] })
      .expect(409);
    expect(second.body).toMatchObject({ code: 'exceeds-returnable', returnableQty: 2 });
    // Now 4-7a disposes it.
    await http()
      .post(`${API}/${tenantId}/returns/dispositions`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, receiptLineId: line.id, outcome: 'scrap', qty: 1, reasonCode: 'damaged' })
      .expect(201);
    // The portal lists it, with its origin and parcel reference.
    const portal = await http().get(`${API}/${tenantId}/portal/returns?limit=100`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    const row = (portal.body.items as Record<string, unknown>[]).find((item) => item.id === rmaId)!;
    expect(row).toMatchObject({ origin: 'blind', parcelReference: 'ACC-1', orderId, receivedTotal: 3, scrappedTotal: 1, openTotal: 2 });
    const detail = await http().get(`${API}/${tenantId}/portal/returns/${rmaId}`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    const forbidden = ['suggestedOrderId', 'matchKind', 'clientPrompted', 'reviewStatus', 'reviewedAt', 'reviewedBy', 'reviewReasonCode', 'reviewNote', 'sameParcelRmas', 'openRmasForSuggestedOrder'];
    const keysDeep = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap(keysDeep)
        : value !== null && typeof value === 'object'
          ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [k, ...keysDeep(v)])
          : [];
    for (const name of forbidden) expect(keysDeep(detail.body)).not.toContain(name);
    expect(detail.body.lines[0]).toMatchObject({ returnReasonCode: 'unannounced' });
  });

  it('accept with no capacity leaves the line unlinked and names it; "No order" accepts with every line unlinked and no order', async () => {
    const { orderId } = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 1 }], { clientOrderRef: 'CAP-1' });
    const res = await receiveBlind({ entries: [{ skuId: sku('BA-1'), qty: 3 }] }).expect(201);
    const accepted = await accept(res.body.rmaId as string, orderId).expect(200);
    expect(accepted.body).toMatchObject({ reviewStatus: 'accepted', orderId });
    expect(accepted.body.unlinkedLines).toEqual([accepted.body.lines[0].id]);
    expect(accepted.body.lines[0].orderLineId).toBeNull();
    // The order's returnable is untouched by an unlinked line.
    expect((await returnable(orderId)).lines[0]!.returnableQty).toBe(1);

    const noOrder = await receiveBlind({ entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
    const plain = await accept(noOrder.body.rmaId as string, null).expect(200);
    expect(plain.body).toMatchObject({ reviewStatus: 'accepted', orderId: null, orderDispatchedAt: null });
    expect(plain.body.unlinkedLines).toEqual([plain.body.lines[0].id]);
    expect(receiptLines(await rmaDetail(noOrder.body.rmaId as string))[0]!.openQty).toBe(1);
  });

  it('accept merges two entries whose only fitting order line is the same (A11); the receipt lines point at the kept line', async () => {
    const { orderId, returnable: before } = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 2 }]);
    const res = await receiveBlind({ entries: [{ skuId: sku('BA-1'), qty: 1 }, { skuId: sku('BA-1'), qty: 1 }] }).expect(201);
    const accepted = await accept(res.body.rmaId as string, orderId).expect(200);
    expect(accepted.body.unlinkedLines).toEqual([]);
    expect(accepted.body.lines).toHaveLength(1);
    expect(accepted.body.lines[0]).toMatchObject({ orderLineId: before.lines[0]!.orderLineId, authorizedQty: 2, receivedQty: 2 });
    const detail = await rmaDetail(res.body.rmaId as string);
    expect(receiptLines(detail).map((line) => line.rmaLineId)).toEqual([accepted.body.lines[0].id, accepted.body.lines[0].id]);
    expect((await returnable(orderId)).lines[0]!.returnableQty).toBe(0);
    // The ledger is not rewritten: a reference may name the merged-away line; the RMA resolves through rmaId.
    const refs = (await sql`select reference_doc->>'rmaId' as rma from ledger_events where tenant_id = ${tenantId} and type = 'return.received' and reference_doc->>'rmaId' = ${res.body.rmaId as string}`) as unknown as { rma: string }[];
    expect(refs).toHaveLength(2);
  });

  it('accept refuses a wrong order: another client (order-client-mismatch), another warehouse (document-warehouse-mismatch), not dispatched (order-not-dispatched, member orderStatus), unknown (404)', async () => {
    const res = await receiveBlind({ entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
    const rmaId = res.body.rmaId as string;
    const foreign = await dispatchedOrder([{ skuId: sku('BB-1'), quantity: 1 }]);
    expect((await accept(rmaId, foreign.orderId).expect(409)).body.code).toBe('order-client-mismatch');
    const undispatched = await fixtures.createOrder([{ skuId: sku('BA-1'), quantity: 1 }]);
    expect((await accept(rmaId, undispatched).expect(409)).body).toMatchObject({ code: 'order-not-dispatched', orderStatus: expect.any(String) });
    await accept(rmaId, uuidv7()).expect(404);
    // Received in the other warehouse, the brand's order here is another warehouse's.
    const elsewhere = await receiveBlind({ warehouseId: otherWarehouseId, entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
    const ours = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 1 }]);
    expect((await accept(elsewhere.body.rmaId as string, ours.orderId).expect(409)).body.code).toBe('document-warehouse-mismatch');
    // Nothing was decided by the refusals.
    expect((await rmaDetail(rmaId)).reviewStatus).toBe('pending');
  });

  it('review twice is 409 review-not-pending (member reviewStatus); an authorized RMA is 409 rma-not-blind (member origin); review needs returns.manage', async () => {
    const res = await receiveBlind({ entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
    const rmaId = res.body.rmaId as string;
    const floorOps = await createMember('operator');
    expect((await accept(rmaId, null, ulid(), floorOps.token).expect(403)).body.code).toBe('role-denied');
    await accept(rmaId, null).expect(200);
    expect((await accept(rmaId, null).expect(409)).body).toMatchObject({ code: 'review-not-pending', reviewStatus: 'accepted' });
    expect((await reject(rmaId, { reasonCode: 'duplicate' }).expect(409)).body).toMatchObject({ code: 'review-not-pending', reviewStatus: 'accepted' });

    const { orderId, returnable: r } = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 1 }]);
    const rma = await http()
      .post(`${API}/${tenantId}/returns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ orderId, lines: [{ orderLineId: r.lines[0]!.orderLineId, qty: 1, reasonCode: 'damaged' }] })
      .expect(201);
    expect((await accept(rma.body.id as string, null).expect(409)).body).toMatchObject({ code: 'rma-not-blind', origin: 'authorized' });
    // The create refuses the blind reason (decision 9, A5).
    const refused = await http()
      .post(`${API}/${tenantId}/returns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ orderId, lines: [{ orderLineId: r.lines[0]!.orderLineId, qty: 1, reasonCode: 'unannounced' }] })
      .expect(400);
    expect(refused.body.code).toBe('validation-failed');
  });

  // ── reject ─────────────────────────────────────────────────────────────────

  it('reject reverses the booking (return.reversed per line, RETURNS falls by the receipt, the serial leaves stock), reconcile stays clean, the portal never shows it, and the same serial can be blind-received again', async () => {
    await dispatchedOrder([{ skuId: sku('BA-SER'), quantity: 1 }], { serials: ['BS-3'] });
    const res = await receiveBlind({ entries: [{ skuId: sku('BA-SER'), qty: 1, serialNumber: 'BS-3' }, { skuId: sku('BA-1'), qty: 2 }] }).expect(201);
    const rmaId = res.body.rmaId as string;
    const bin = await returnsBin();
    const serBefore = await onHandIn(bin, sku('BA-SER'));
    const plainBefore = await onHandIn(bin, sku('BA-1'));
    const key = ulid();
    // `other` needs a note (400, above the transaction).
    expect((await reject(rmaId, { reasonCode: 'other' }).expect(400)).body.code).toBe('validation-failed');
    // A pending serial is not awaiting a disposition: the device restock answers serial-not-awaiting.
    const pendingSerial = await http()
      .post(`${API}/${tenantId}/returns/restocks`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: sku('BA-SER'), qty: 1, batchCode: null, serialNumbers: ['BS-3'], toBinId: stockBin, occurredAt: nowUtc() })
      .expect(409);
    expect(pendingSerial.body.code).toBe('serial-not-awaiting');
    const rejected = await reject(rmaId, { reasonCode: 'other', note: '  scanned at the wrong dock  ' }, key).expect(200);
    // Replay: the same key and body answer the stored snapshot; nothing is reversed twice.
    const replayedReject = await reject(rmaId, { reasonCode: 'other', note: '  scanned at the wrong dock  ' }, key).expect(200);
    expect(replayedReject.body).toEqual(rejected.body);
    expect(rejected.body).toMatchObject({ reviewStatus: 'rejected', reviewReasonCode: 'other', reviewNote: 'scanned at the wrong dock' });
    await expectAuditRow({ tenantId, key, action: 'return_authorization.blind_rejected', targetType: 'return_authorization', targetId: rmaId, actorUserId: opsUserId });
    expect(await onHandIn(bin, sku('BA-SER'))).toBe(serBefore - 1000);
    expect(await onHandIn(bin, sku('BA-1'))).toBe(plainBefore - 2000);
    const reversals = (await sql`select type, from_bin_id, to_bin_id, quantity_delta::bigint as q from ledger_events where tenant_id = ${tenantId} and type = 'return.reversed' and reference_doc->>'rmaId' = ${rmaId} order by id`) as unknown as {
      type: string;
      from_bin_id: string;
      to_bin_id: string | null;
      q: string;
    }[];
    expect(reversals.map((row) => [row.from_bin_id, row.to_bin_id, Number(row.q)]).sort()).toEqual([
      [bin, null, -2000],
      [bin, null, -1000],
    ].sort());
    const detail = await rmaDetail(rmaId);
    for (const line of receiptLines(detail)) expect(line).toMatchObject({ openQty: 0, pendingReviewQty: 0, reversedQty: line.qty });
    expect((await inventory.reconcile(tenantId, warehouseId)).divergences).toEqual([]);
    await http().get(`${API}/${tenantId}/portal/returns/${rmaId}`).set('Authorization', `Bearer ${portalBrand}`).expect(404);
    // Disposition of a rejected line answers review-rejected.
    const dispose = await http()
      .post(`${API}/${tenantId}/returns/dispositions`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, receiptLineId: receiptLines(detail)[1]!.id, outcome: 'scrap', qty: 1, reasonCode: 'damaged' })
      .expect(409);
    expect(dispose.body.code).toBe('review-rejected');
    // The same serial re-received (it is out of stock again).
    const again = await receiveBlind({ entries: [{ skuId: sku('BA-SER'), qty: 1, serialNumber: 'BS-3' }] }).expect(201);
    expect(again.body.refused).toEqual([]);
    await reject(again.body.rmaId as string, { reasonCode: 'duplicate' }).expect(200);
  });

  it('reject above the write-off threshold is 409 reject-above-threshold (members threshold, totalQty)', async () => {
    await http().put(`${API}/${tenantId}/inventory/adjustment-policies`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ quantityThreshold: 10 }).expect(200);
    try {
      const res = await receiveBlind({ entries: [{ skuId: sku('BA-1'), qty: 12 }] }).expect(201);
      const refused = await reject(res.body.rmaId as string, { reasonCode: 'not-our-goods' }).expect(409);
      expect(refused.body).toMatchObject({ code: 'reject-above-threshold', threshold: 10, totalQty: 12 });
      expect((await rmaDetail(res.body.rmaId as string)).reviewStatus).toBe('pending');
      await accept(res.body.rmaId as string, null).expect(200);
    } finally {
      await http().put(`${API}/${tenantId}/inventory/adjustment-policies`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ quantityThreshold: 1_000_000 }).expect(200);
    }
  });

  it('a reconcile quarantine on RETURNS refuses the reject (disposition-scope-quarantined)', async () => {
    const res = await receiveBlind({ entries: [{ skuId: sku('BA-2'), qty: 1 }] }).expect(201);
    const bin = await returnsBin();
    const q = uuidv7();
    await sql`insert into inventory_quarantines (id, tenant_id, warehouse_id, sku_id, bin_id, from_seq, to_seq, reason)
      values (${q}, ${tenantId}, ${warehouseId}, ${sku('BA-2')}, ${bin}, 1, 1, 'blind-returns probe')`;
    try {
      expect((await reject(res.body.rmaId as string, { reasonCode: 'mis-scanned' }).expect(409)).body.code).toBe('disposition-scope-quarantined');
    } finally {
      await sql`update inventory_quarantines set status = 'resolved' where id = ${q}`;
    }
    await reject(res.body.rmaId as string, { reasonCode: 'mis-scanned' }).expect(200);
  });

  it('the recall fold nets a reversal: a blind receipt of a lot then rejected leaves `returned` where it was', async () => {
    const lot = (await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku('BA-BAT')} and code = 'LOT-B1'`) as unknown as { id: string }[];
    const db = app.get<Database>(DATABASE);
    const figures = async () => (await withTenantTransaction(db, tenantId, (tx) => batchLedgerFiguresInTx(tx, tenantId, [lot[0]!.id]))).get(lot[0]!.id)!;
    const before = await figures();
    const res = await receiveBlind({ entries: [{ skuId: sku('BA-BAT'), qty: 2, batchCode: 'LOT-B1' }] }).expect(201);
    expect((await figures()).returned).toBe(before.returned + 2);
    await reject(res.body.rmaId as string, { reasonCode: 'mis-scanned' }).expect(200);
    expect((await figures()).returned).toBe(before.returned);
  });

  // ── duplicates, the snapshot, the vocabularies ─────────────────────────────

  it('the same AWB twice books both; each card names the other (A20); the suggested order\'s open RMA is flagged; the device snapshot carries the order\'s tracking numbers (A19)', async () => {
    const { orderId, returnable: r } = await dispatchedOrder([{ skuId: sku('BA-2'), quantity: 2 }]);
    await addShipment(orderId, 'AWB-RTO');
    const rma = await http()
      .post(`${API}/${tenantId}/returns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ orderId, lines: [{ orderLineId: r.lines[0]!.orderLineId, qty: 1, reasonCode: 'damaged' }] })
      .expect(201);
    const first = await receiveBlind({ parcelReference: 'AWB-RTO', entries: [{ skuId: sku('BA-2'), qty: 1 }] }).expect(201);
    const second = await receiveBlind({ parcelReference: 'AWB-RTO', entries: [{ skuId: sku('BA-2'), qty: 1 }] }).expect(201);
    const a = await rmaDetail(first.body.rmaId as string);
    const b = await rmaDetail(second.body.rmaId as string);
    expect(a.sameParcelRmas).toEqual([{ id: second.body.rmaId, code: second.body.rmaCode, reviewStatus: 'pending' }]);
    expect(b.sameParcelRmas).toEqual([{ id: first.body.rmaId, code: first.body.rmaCode, reviewStatus: 'pending' }]);
    expect(a.openRmasForSuggestedOrder).toEqual([{ id: rma.body.id, code: rma.body.code, status: 'open' }]);
    // The list item never carries the detail-only facts.
    const list = await http().get(`${API}/${tenantId}/returns?origin=blind&limit=100`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const item = (list.body.items as Record<string, unknown>[]).find((row) => row.id === first.body.rmaId)!;
    expect(item).not.toHaveProperty('sameParcelRmas');
    expect(item).not.toHaveProperty('openRmasForSuggestedOrder');
    expect(item).toMatchObject({ origin: 'blind', reviewStatus: 'pending' });
    const open = await app.get(ReturnsFacade).getOpenReturns(tenantId, warehouseId);
    expect(open.find((entry) => entry.id === rma.body.id)).toMatchObject({ trackingNumbers: ['AWB-RTO'] });
    await reject(first.body.rmaId as string, { reasonCode: 'duplicate' }).expect(200);
    await reject(second.body.rmaId as string, { reasonCode: 'duplicate' }).expect(200);
  });

  it('the review vocabularies: the op type is Discard-only and SKU-naming; BLIND_ENTRY_REFUSALS has 12 codes', () => {
    expect(REJECTED_OP_TYPES).toContain('return.receive_blind');
    expect(REJECTED_OP_DECISIONS_BY_TYPE['return.receive_blind']).toEqual(['discard']);
    expect(SKU_NAMING_OP_TYPES).toContain('return.receive_blind');
    expect(BLIND_ENTRY_REFUSALS).toHaveLength(12);
  });

  it('the OpenAPI document lists the three new routes; the literal `blind-receipts` is declared before every `:rmaId` route', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const paths = Object.keys(doc.body.paths as Record<string, unknown>);
    for (const path of ['/tenants/{tenantId}/returns/blind-receipts', '/tenants/{tenantId}/returns/{rmaId}/accept', '/tenants/{tenantId}/returns/{rmaId}/reject']) {
      expect(paths).toContain(path);
    }
    const names = Object.getOwnPropertyNames(ReturnsController.prototype);
    for (const later of ['get', 'cancel', 'acceptBlind', 'rejectBlind']) expect(names.indexOf('receiveBlind')).toBeLessThan(names.indexOf(later));
  });

  // ── goldens ────────────────────────────────────────────────────────────────

  it('goldens: the three new hashes are their literal JSON; the five existing hashes are byte-identical', () => {
    const t = '01900000-0000-7000-8000-0000000000aa';
    const d = '01900000-0000-7000-8000-0000000000bb';
    const u = '01900000-0000-7000-8000-0000000000cc';
    const w = '01900000-0000-7000-8000-0000000000dd';
    const c = '01900000-0000-7000-8000-0000000000ee';
    const x = '01900000-0000-7000-8000-0000000000ff';
    const blind = normalizeBlindReceive({
      warehouseId: w,
      clientId: c,
      clientPrompted: false,
      parcelReference: ' AWB123 ',
      occurredAt: '2026-10-30T10:00:00Z',
      entries: [{ skuId: x, qty: 3, condition: 'resaleable' }],
    });
    expect(blindReceivePayloadHash(t, d, u, blind)).toBe(
      hashCommandPayload({
        arm: 'return-receive-blind',
        tenantId: t,
        deviceId: d,
        operatorUserId: u,
        warehouseId: w,
        clientId: c,
        clientPrompted: false,
        parcelReference: 'AWB123',
        occurredAt: '2026-10-30T10:00:00Z',
        entries: [{ skuId: x, qty: 3, condition: 'resaleable', note: null, batchCode: null, serialNumber: null, weightGrams: null }],
      }),
    );
    expect(blindAcceptPayloadHash(t, x, null)).toBe(hashCommandPayload({ arm: 'blind-accept', tenantId: t, rmaId: x, orderId: null }));
    expect(blindRejectPayloadHash(t, x, normalizeBlindReject({ reasonCode: 'other', note: ' why ' }))).toBe(
      hashCommandPayload({ arm: 'blind-reject', tenantId: t, rmaId: x, reasonCode: 'other', note: 'why' }),
    );
    // The existing five, unchanged by 4-7b.
    expect(createPayloadHash(t, x, normalizeCreate({ externalReference: null, lines: [{ orderLineId: w, qty: 2, reasonCode: 'damaged' }] }))).toBe(
      hashCommandPayload({ arm: 'rma-create', tenantId: t, orderId: x, externalReference: null, lines: [{ orderLineId: w, qty: 2, reasonCode: 'damaged', reasonNote: null, serialNumbers: null }] }),
    );
    expect(hashCommandPayload({ arm: 'rma-cancel', tenantId: t, rmaId: x, reason: 'r' })).toBe(hashCommandPayload({ arm: 'rma-cancel', tenantId: t, rmaId: x, reason: 'r' }));
    expect(
      receivePayloadHash(t, d, u, normalizeReceive({ warehouseId: w, rmaId: x, occurredAt: '2026-10-30T10:00:00Z', entries: [{ rmaLineId: c, skuId: x, qty: 1, condition: 'opened' }] })),
    ).toBe(
      hashCommandPayload({
        arm: 'return-receive',
        tenantId: t,
        deviceId: d,
        operatorUserId: u,
        warehouseId: w,
        rmaId: x,
        occurredAt: '2026-10-30T10:00:00Z',
        entries: [{ rmaLineId: c, skuId: x, qty: 1, condition: 'opened', note: null, batchCode: null, serialNumber: null, weightGrams: null }],
      }),
    );
    expect(disposePayloadHash(t, normalizeDispose({ warehouseId: w, receiptLineId: x, outcome: 'scrap', qty: 1, toBinId: null, reasonCode: 'damaged', note: null }))).toBe(
      hashCommandPayload({ arm: 'return-dispose', tenantId: t, warehouseId: w, receiptLineId: x, outcome: 'scrap', qty: 1, toBinId: null, reasonCode: 'damaged', note: null }),
    );
    expect(
      restockPayloadHash(t, d, u, normalizeRestock({ warehouseId: w, skuId: x, qty: 1, batchCode: null, serialNumbers: null, toBinId: c, occurredAt: '2026-10-30T10:00:00Z' })),
    ).toBe(
      hashCommandPayload({
        arm: 'return-restock',
        tenantId: t,
        deviceId: d,
        operatorUserId: u,
        warehouseId: w,
        skuId: x,
        qty: 1,
        batchCode: null,
        serialNumbers: null,
        toBinId: c,
        occurredAt: '2026-10-30T10:00:00Z',
      }),
    );
    // A stored create snapshot never carries the 4-7b keys.
  });

  it('a stored create snapshot keeps its pre-4-7b keys (no origin / review keys) and a non-null orderId', async () => {
    const { orderId, returnable: r } = await dispatchedOrder([{ skuId: sku('BA-1'), quantity: 1 }]);
    const key = ulid();
    await http()
      .post(`${API}/${tenantId}/returns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ orderId, lines: [{ orderLineId: r.lines[0]!.orderLineId, qty: 1, reasonCode: 'damaged' }] })
      .expect(201);
    const stored = (await sql`select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { response_snapshot: Record<string, unknown> }[];
    expect(Object.keys(stored[0]!.response_snapshot).sort()).toEqual(
      ['cancelReason', 'cancelledAt', 'cancelledBy', 'clientId', 'code', 'createdAt', 'createdBy', 'externalReference', 'id', 'lines', 'orderDispatchedAt', 'orderId', 'orderReference', 'status', 'warehouseId'].sort(),
    );
    expect(stored[0]!.response_snapshot.orderId).toBe(orderId);
  });

  // ── races ──────────────────────────────────────────────────────────────────

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

    async function raceTwo(lockSql: (tx: postgres.TransactionSql) => Promise<{ pid: number }[]>, a: () => SupertestTest, b: () => SupertestTest): Promise<[request.Response, request.Response]> {
      const holder = handle();
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = await lockSql(tx);
          first = (async () => a())();
          second = (async () => b())();
          await waitParked(locked[0]!.pid, 2);
        });
        return await Promise.all([first!, second!]);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
    }

    it('receive: two same-key device ops parked behind the device row answer the same body — one RMA, one key (A3)', async () => {
      const key = ulid();
      const at = nowUtc();
      const send = () => receiveBlind({ occurredAt: at, entries: [{ skuId: sku('BA-1'), qty: 1 }] }, key);
      const [a, b] = await raceTwo(
        (tx) => tx`select pg_backend_pid() as pid from devices where id = ${deviceId} for update` as unknown as Promise<{ pid: number }[]>,
        send,
        send,
      );
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body).toEqual(b.body);
      expect(await count(sql`select count(*)::int as n from return_receipts where tenant_id = ${tenantId} and idempotency_key = ${key}`)).toBe(1);
      expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(1);
      await accept(a.body.rmaId as string, null).expect(200);
    });

    it('accept vs reject parked on the RMA row: exactly one decides; the other answers 409 review-not-pending', async () => {
      const res = await receiveBlind({ entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
      const rmaId = res.body.rmaId as string;
      const [a, b] = await raceTwo(
        (tx) => tx`select pg_backend_pid() as pid from return_authorizations where id = ${rmaId} for update` as unknown as Promise<{ pid: number }[]>,
        () => accept(rmaId, null),
        () => reject(rmaId, { reasonCode: 'mis-scanned' }),
      );
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a, b].find((r) => r.status === 409)!.body.code).toBe('review-not-pending');
      const reversed = await count(sql`select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and type = 'return.reversed' and reference_doc->>'rmaId' = ${rmaId}`);
      expect(reversed).toBe((await rmaDetail(rmaId)).reviewStatus === 'rejected' ? 1 : 0);
    });

    it('accept: two same-key requests parked on the RMA row answer the same body — one decision, one key', async () => {
      const res = await receiveBlind({ entries: [{ skuId: sku('BA-1'), qty: 1 }] }).expect(201);
      const rmaId = res.body.rmaId as string;
      const key = ulid();
      const send = () => accept(rmaId, null, key);
      const [a, b] = await raceTwo(
        (tx) => tx`select pg_backend_pid() as pid from return_authorizations where id = ${rmaId} for update` as unknown as Promise<{ pid: number }[]>,
        send,
        send,
      );
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body).toEqual(b.body);
    });
  });
});

// ── pure: the classification and the linking plan ────────────────────────────

describe('blind returns — pure rules (story 4-7b)', () => {
  const client = 'client-a';
  const facts = (over: Partial<SkuFacts> = {}): SkuFacts => ({
    code: 'SKU',
    name: 'Fixture',
    batchTracked: false,
    serialTracked: false,
    catchWeightTracked: false,
    uom: 'pcs',
    uomPrecision: 0,
    clientId: client,
    isKit: false,
    ...over,
  });
  const entry = (over: Partial<NormalizedBlindEntry> = {}): NormalizedBlindEntry => ({
    skuId: 'sku',
    qty: 1,
    condition: 'resaleable',
    note: null,
    batchCode: null,
    serialNumber: null,
    weightGrams: null,
    ...over,
  });
  const ctx = (over: Partial<BlindClassifyContext> = {}, sku: SkuFacts = facts()): BlindClassifyContext => ({
    clientId: client,
    skuFacts: new Map([['sku', sku]]),
    serialByNumber: new Map(),
    inStock: new Map(),
    latestBatchBySerial: new Map(),
    batchIdByCode: new Map(),
    appliedSerials: new Set(),
    ...over,
  });
  const reason = (verdict: ReturnType<typeof classifyBlindEntry>): string | null => ('reason' in verdict ? verdict.reason : null);

  it('the order of the rules: kit, precision (and whole cases), captures, weight, blocked serial, batch of the serial (A7)', () => {
    expect(reason(classifyBlindEntry(0, entry(), ctx({}, facts({ isKit: true }))))).toBe('kit-cannot-hold-stock');
    expect(reason(classifyBlindEntry(0, entry({ qty: 1.5 }), ctx({}, facts({ catchWeightTracked: true, uom: 'kg', uomPrecision: 3 }))))).toBe('qty-precision');
    expect(reason(classifyBlindEntry(0, entry(), ctx({}, facts({ catchWeightTracked: true }))))).toBe('missing-capture');
    expect(reason(classifyBlindEntry(0, entry({ weightGrams: 999_999_999 }), ctx({}, facts({ catchWeightTracked: true }))))).toBe('weight-out-of-range');
    expect(reason(classifyBlindEntry(0, entry({ batchCode: 'L1' }), ctx()))).toBe('unexpected-capture');
    const serialSku = facts({ serialTracked: true, batchTracked: true });
    const serialCtx = (status: string, latest: string | null) =>
      ctx(
        {
          serialByNumber: new Map([['sku:S1', { id: 's1', status }]]),
          latestBatchBySerial: new Map([['s1', latest]]),
          batchIdByCode: new Map([['sku:L1', 'b1']]),
        },
        serialSku,
      );
    expect(reason(classifyBlindEntry(0, entry({ serialNumber: 'S1', batchCode: 'L1' }), serialCtx('blocked', 'b1')))).toBe('serial-blocked');
    expect(reason(classifyBlindEntry(0, entry({ serialNumber: 'S1', batchCode: 'L1' }), serialCtx('active', 'b2')))).toBe('batch-unknown');
    expect(reason(classifyBlindEntry(0, entry({ serialNumber: 'S1', batchCode: 'L1' }), serialCtx('active', 'b1')))).toBeNull();
  });

  it('linking (A11): two order lines take two entries; a full one merges; a kit parent and an exhausted line never link; a serial links only to the line that dispatched it', () => {
    const ol = (orderLineId: string, returnableMilli: number, over: Partial<{ kitParent: boolean; serials: string[]; skuId: string }> = {}) => ({
      orderLineId,
      skuId: over.skuId ?? 'x',
      kitParent: over.kitParent ?? false,
      returnableMilli,
      returnableSerialIds: new Set(over.serials ?? []),
    });
    const line = (id: string, lineNo: number, milli: number, serialIds: string[] = []) => ({ id, lineNo, skuId: 'x', milli, serialIds });
    // X 2 + X 2 against entries X 2 + X 1: both link, to different order lines.
    let plan = planBlindLinks([line('a', 1, 2000), line('b', 2, 1000)], [ol('o1', 2000), ol('o2', 2000)]);
    expect([...plan.links]).toEqual([
      ['a', 'o1'],
      ['b', 'o2'],
    ]);
    // X 1 + X 1 against one order line X 2: the second merges into the first.
    plan = planBlindLinks([line('a', 1, 1000), line('b', 2, 1000)], [ol('o1', 2000)]);
    expect([...plan.links]).toEqual([['a', 'o1']]);
    expect([...plan.merges]).toEqual([['b', 'a']]);
    // A kit parent never; capacity short → unlinked.
    plan = planBlindLinks([line('a', 1, 1000), line('b', 2, 3000)], [ol('kit', 5000, { kitParent: true }), ol('o1', 1000)]);
    expect([...plan.links]).toEqual([['a', 'o1']]);
    expect(plan.unlinked).toEqual(['b']);
    // A serial line links to the order line that dispatched the serial.
    plan = planBlindLinks([line('s', 1, 1000, ['S9'])], [ol('o1', 1000, { serials: ['S1'] }), ol('o2', 1000, { serials: ['S9'] })]);
    expect([...plan.links]).toEqual([['s', 'o2']]);
  });
});
