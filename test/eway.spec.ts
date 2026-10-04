import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { nowIso } from '../src/shared/primitives/time';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import type { DomainEvent } from '../src/shared/events/event-bus.seam';
import { EwayDeliveryHandler } from '../src/modules/invoicing/eway.delivery';
import { INVOICE_ISSUED_EVENT } from '../src/modules/invoicing/events';
import { EwayController } from '../src/api/eway.controller';
import { EWAY_BILL_STATUSES } from '../src/modules/invoicing/eway-view';
import {
  EWAY_GATEWAY,
  EwayGatewayUnavailable,
  sandboxEwayGateway,
  type EwayGateway,
} from '../src/modules/invoicing/eway-gateway';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
// The e2e suites run the production default: no gateway. The generate tests
// override the provider's methods with the sandbox adapter per test.
delete process.env.EWAY_GATEWAY;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(90_000);

/** The real-flow warehouse's GSTIN (Karnataka). */
const G29 = '29AAAPZ1234C1ZV';
/** The second warehouse's GSTIN (Maharashtra) — the e-invoicing flag target. */
const G27 = '27AAAPZ1234C1ZV';
const G07 = '07AAAPZ1234C1ZV';
const G24 = '24AAAPZ1234C1ZV';
const G33 = '33AAAPZ1234C1ZV';
/** A registered buyer in Maharashtra (B2B). */
const BUYER27 = '27BBBPT5678M2AB';
const BUYER29 = '29BBBPT5678M2AB';

const ADDR = {
  KA: { contactName: 'Dock', phone: '9999999999', line1: '12, Peenya Industrial Area', line2: null, city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
  MH: { contactName: 'Asha Traders', phone: '8888888888', line1: '4/7 MG Road', line2: 'Gate 2', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  DL: { contactName: 'Dock', phone: '9999999999', line1: '1 Okhla', line2: null, city: 'New Delhi', state: 'Delhi', pincode: '110020' },
  GJ: { contactName: 'Dock', phone: '9999999999', line1: '1 Ring Road', line2: null, city: 'Surat', state: 'Gujarat', pincode: '395002' },
  TN: { contactName: 'Dock', phone: '9999999999', line1: '1 Anna Salai', line2: null, city: 'Chennai', state: 'Tamil Nadu', pincode: '600002' },
} as const;
type Addr = (typeof ADDR)[keyof typeof ADDR] | { [k: string]: unknown };

const STATE_OF: Record<string, Addr> = { '29': ADDR.KA, '27': ADDR.MH, '07': ADDR.DL, '24': ADDR.GJ, '33': ADDR.TN };

interface SeedLine {
  gstBps: number;
  taxable: number;
  cgst?: number;
  sgst?: number;
  igst?: number;
  hsn?: string | null;
  uom?: string;
}

interface BillRow {
  id: string;
  status: string;
  consignment_value_paise: string;
  threshold_paise: string;
  threshold_rule: string;
  source: string | null;
  ewb_no: string | null;
  gateway_claimed_at: string | null;
  last_error: string | null;
  last_exported_at: string | null;
}

/**
 * Story 8-2b — e-way bills end to end: the `invoice.issued` queue (the
 * threshold matrix), the blockers, the export → record path, the gateway
 * Generate command and its claim, the configuration, the CHECKs and RLS.
 *
 * Two kinds of fixture: ONE real dispatch (dispatch → relay → invoice issued
 * → relay → bill queued) carries the golden bill and the delivery
 * idempotency; the threshold and blocker matrix seeds RAW issued invoices
 * (dates and parties only the database can stamp) and delivers
 * `invoice.issued` to the handler directly.
 */
describe('invoicing: e-way bills (e2e, story 8-2b)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  let suiteDb: SuiteDatabase;
  let relay: OutboxRelay;
  let delivery: EwayDeliveryHandler;
  let gateway: EwayGateway;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let accountantToken: string;
  let operatorWebToken: string;
  let operatorToken: string;
  let warehouseId: string;
  let binId: string;
  const skuIds = new Map<string, string>();
  let seq = 0;
  let ewbSeq = 0;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('eway');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    delivery = app.get(EwayDeliveryHandler);
    gateway = app.get<EwayGateway>(EWAY_GATEWAY);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Eway Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = await signIn(email, 'correct-horse-battery');
    opsToken = await inviteAndSignIn('ops_manager', 'ops-password-123');
    accountantToken = await inviteAndSignIn('accountant', 'books-password-123');
    operatorWebToken = await inviteAndSignIn('operator', 'floor-password-123');

    warehouseId = await createWarehouse(G29, testAddress({ state: 'Karnataka', city: 'Bengaluru', pincode: '560001' }));
    await createWarehouse(G27, testAddress({ state: 'Maharashtra', city: 'Pune', pincode: '411014' }));
    const zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 10000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;

    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
      'EW-PEP,Black pepper 1kg,pcs,,1800,0904,false,false,,,',
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const catalogList = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of catalogList.body.items as { code: string; id: string }[]) skuIds.set(item.code, item.id);

    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Eway desk scanner', pin: '2468' })
      .expect(201);
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
    operatorToken = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

    // The configuration the threshold matrix reads (owner-only appends).
    await appendThreshold('27', 10_000_000, '2025-04-01').expect(201); // ₹1,00,000
    await appendThreshold('24', null, '2025-04-01').expect(201); // none required
    await appendThreshold('07', 10_000_000, '2026-10-10').expect(201); // not yet effective on 9 Oct
    await appendThreshold('33', 100_000_000, '2026-01-01').expect(201); // superseded…
    await appendThreshold('33', 6_000_000, '2026-01-01').expect(201); // …by this same-date correction
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
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      for (const table of [
        'eway_bills', 'eway_state_thresholds', 'eway_gstin_settings',
        'picks', 'picklist_lines', 'picklists', 'waves', 'wave_policies', 'invoice_lines', 'invoices', 'invoice_series', 'order_lines', 'orders',
      ]) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      for (const table of [
        'reservations', 'stock_on_hand', 'outbox_messages', 'idempotency_keys', 'audit_events', 'catalog_import_errors',
        'catalog_imports', 'uom_conversions', 'skus', 'devices', 'bins', 'zones', 'warehouses', 'users', 'tenants',
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

  function signIn(address: string, password: string): Promise<string> {
    return request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email: address, password })
      .expect(200)
      .then((res) => res.body.accessToken as string);
  }

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
    return signIn(address, password);
  }

  async function createWarehouse(gstin: string, origin: Record<string, unknown>): Promise<string> {
    const wh = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ gstin, origin, code: `EW-${ulid().slice(10, 16).toUpperCase()}`, name: `Eway WH ${ulid()}` })
      .expect(201);
    return wh.body.id as string;
  }

  function appendThreshold(stateCode: string, thresholdPaise: number | null, effectiveFrom: string, token = ownerToken) {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/eway/state-thresholds`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, ulid())
      .send({ stateCode, thresholdPaise, effectiveFrom });
  }

  /** The whole floor flow for one order, ending DISPATCHED (the outbox carries order.dispatched). */
  async function dispatchedOrder(quantity: number, ratePaise: number, destination: Record<string, unknown>, consigneeGstin: string | null): Promise<string> {
    const skuId = skuIds.get('EW-PEP')!;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta: quantity + 5, reasonCode: 'stock-count', note: 'eway seed' })
      .expect(201);
    const created = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines: [{ skuId, quantity, ratePaise }], destination, ...(consigneeGstin === null ? {} : { consigneeGstin }) })
      .expect(201);
    const orderId = created.body.order.id as string;
    const policy = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/wave-policies`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, name: `ew-${ulid().slice(10, 18)}`, grouping: 'single' })
      .expect(201);
    const wave = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy.body.policy.id as string, orderIds: [orderId] })
      .expect(201);
    const waveId = wave.body.wave.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    const picklist = (detail.body.wave.picklists as { lines: { id: string; picklistId: string; skuId: string; binId: string; qty: number }[] }[])[0]!;
    for (const line of picklist.lines) {
      if (line.qty <= 0) continue;
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/picks`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          picklistId: line.picklistId,
          picklistLineId: line.id,
          skuId: line.skuId,
          binId: line.binId,
          qty: line.qty,
          occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        })
        .expect(201);
    }
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned: [{ skuId, qty: quantity }] })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    return orderId;
  }

  /** Drives the relay (past any backoff) until it has nothing due. */
  async function drainAll(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
      await sql`update outbox_messages set next_attempt_at = now() where tenant_id = ${tenantId} and status <> 'published'`;
      const drained = await relay.drain(100);
      if (drained.length === 0) return;
    }
  }

  /** One raw ISSUED invoice + its lines, satisfying every stored CHECK. */
  async function seedInvoice(opts: {
    gstin?: string;
    consignee?: string | null;
    supplyType?: 'intra' | 'inter';
    pos?: string;
    issuedAt?: string;
    lines?: SeedLine[];
    origin?: Addr | null;
    consigneeAddress?: Addr | null;
    buyerName?: string | null;
    status?: 'issued' | 'awaiting-data';
  } = {}): Promise<string> {
    const id = uuidv7();
    const gstin = opts.gstin ?? G29;
    const consignee = opts.consignee === undefined ? BUYER27 : opts.consignee;
    const pos = opts.pos ?? '27';
    const supplyType = opts.supplyType ?? (pos === gstin.slice(0, 2) ? 'intra' : 'inter');
    const issuedAt = opts.issuedAt ?? new Date(Date.now() - 3_600_000).toISOString();
    const status = opts.status ?? 'issued';
    const lines = (opts.lines ?? [{ gstBps: 1800, taxable: 5_000_000, igst: 900_000 }]).map((l, i) => ({
      orderLineId: uuidv7(),
      skuCode: `SKU-${i}`,
      skuName: `Item ${i}`,
      hsn: l.hsn === undefined ? '0904' : l.hsn,
      qtyMilli: 1000,
      uom: l.uom ?? 'kg',
      ratePaise: l.taxable,
      rateSource: 'order_line',
      taxablePaise: l.taxable,
      gstBps: l.gstBps,
      cgstPaise: l.cgst ?? 0,
      sgstPaise: l.sgst ?? 0,
      igstPaise: l.igst ?? 0,
      hsnGap: l.hsn === null,
    }));
    const subtotal = lines.reduce((s, l) => s + l.taxablePaise, 0);
    const gst = lines.reduce((s, l) => s + l.cgstPaise + l.sgstPaise + l.igstPaise, 0);
    const total = subtotal + gst;
    const payable = Math.floor((total + 50) / 100) * 100;
    const invoiceNo = status === 'issued' ? `${gstin.slice(0, 2)}/2627/9${String(++seq).padStart(5, '0')}` : null;
    const origin = opts.origin === undefined ? STATE_OF[gstin.slice(0, 2)] : opts.origin;
    const consigneeAddress = opts.consigneeAddress === undefined ? STATE_OF[pos] ?? ADDR.MH : opts.consigneeAddress;
    const document = {
      header: {
        invoiceNo,
        fyLabel: invoiceNo === null ? null : 'FY-2627',
        orderRef: uuidv7(),
        issuedAt: status === 'issued' ? issuedAt : null,
        supplyType,
        placeOfSupply: pos,
        originGstin: gstin,
        consigneeGstin: consignee,
        originAddress: origin,
        consigneeAddress,
      },
      seller: { name: 'Eway Co', gstin },
      buyer: { name: opts.buyerName === undefined ? 'Asha Traders' : opts.buyerName, gstin: consignee },
      lines,
      totals: { subtotal, gst, total, roundOff: payable - total, payable },
      gaps: [],
      revision: 1,
    };
    await sql`
      insert into invoices (id, tenant_id, order_id, warehouse_id, invoice_no, fy_label, series_seq, status, origin_gstin,
        consignee_gstin, place_of_supply, supply_type, subtotal_paise, gst_paise, total_paise, payable_paise, round_off_paise,
        revision, document, issued_at)
      values (${id}, ${tenantId}, ${uuidv7()}, ${warehouseId}, ${invoiceNo}, ${invoiceNo === null ? null : 'FY-2627'},
        ${invoiceNo === null ? null : seq}, ${status}, ${gstin}, ${consignee}, ${pos}, ${supplyType},
        ${subtotal}, ${gst}, ${total}, ${payable}, ${payable - total}, 1, ${sql.json(document as never)},
        ${status === 'issued' ? issuedAt : null}::timestamptz)
    `;
    for (const l of lines) {
      await sql`
        insert into invoice_lines (id, tenant_id, invoice_id, order_line_id, sku_code, sku_name, hsn, qty_milli, rate_paise,
          rate_source, taxable_paise, gst_bps, cgst_paise, sgst_paise, igst_paise, hsn_gap, uom)
        values (${uuidv7()}, ${tenantId}, ${id}, ${l.orderLineId}, ${l.skuCode}, ${l.skuName}, ${l.hsn}, ${l.qtyMilli}, ${l.ratePaise},
          'order_line', ${l.taxablePaise}, ${l.gstBps}, ${l.cgstPaise}, ${l.sgstPaise}, ${l.igstPaise}, ${l.hsnGap}, ${l.uom})
      `;
    }
    return id;
  }

  function issuedEvent(payload: Record<string, unknown>): DomainEvent {
    return { eventId: uuidv7(), type: INVOICE_ISSUED_EVENT, tenantId, occurredAt: nowIso(), payload };
  }

  async function queue(invoiceId: string): Promise<BillRow | undefined> {
    await delivery.deliver(issuedEvent({ invoiceId, invoiceNo: 'untrusted', originGstin: 'untrusted' }));
    return billFor(invoiceId);
  }

  async function billFor(invoiceId: string): Promise<BillRow | undefined> {
    const rows = await sql`
      select id, status, consignment_value_paise::text, threshold_paise::text, threshold_rule, source, ewb_no,
        gateway_claimed_at::text, last_error, last_exported_at::text
      from eway_bills where tenant_id = ${tenantId} and invoice_id = ${invoiceId}
    `;
    return rows[0] as unknown as BillRow | undefined;
  }

  async function billById(id: string): Promise<BillRow> {
    const rows = await sql`
      select id, status, consignment_value_paise::text, threshold_paise::text, threshold_rule, source, ewb_no,
        gateway_claimed_at::text, last_error, last_exported_at::text
      from eway_bills where id = ${id}
    `;
    return rows[0] as unknown as BillRow;
  }

  /** A pending bill over a fresh raw invoice (must queue). */
  async function pendingBill(opts: Parameters<typeof seedInvoice>[0] = {}): Promise<string> {
    const bill = await queue(await seedInvoice(opts));
    expect(bill?.status).toBe('pending');
    return bill!.id;
  }

  /** A pending bill with a Road Part B entered (ready unless something else blocks). */
  async function readyBill(opts: Parameters<typeof seedInvoice>[0] = {}, transport: Record<string, unknown> = ROAD): Promise<string> {
    const id = await pendingBill(opts);
    await patchTransport(id, transport).expect(200);
    return id;
  }

  const ROAD = { transMode: 1, vehicleNo: 'ka 01 ab 1234', vehicleType: 'R', distanceKm: 840 };

  function patchTransport(billId: string, body: Record<string, unknown>, token = accountantToken, key = ulid()) {
    return request(app.getHttpServer())
      .patch(`${API}/${tenantId}/eway/bills/${billId}/transport`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function exportBills(ids: string[], token = accountantToken, key = ulid()) {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/eway/bills/export`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ ids });
  }

  const nextEwbNo = (): string => `3${String(++ewbSeq).padStart(11, '0')}`;

  function recordBill(billId: string, body: Record<string, unknown> = {}, token = accountantToken, key = ulid()) {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/eway/bills/${billId}/record`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ ewbNo: nextEwbNo(), generatedAt: new Date(Date.now() - 60_000).toISOString(), ...body });
  }

  function dismissBill(billId: string, reason = 'Customer collected in person', token = accountantToken) {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/eway/bills/${billId}/dismiss`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, ulid())
      .send({ reason });
  }

  function generateBill(billId: string, token = accountantToken, key = ulid()) {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/eway/bills/${billId}/generate`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send();
  }

  async function listed(billId: string, query: Record<string, string> = { status: 'pending' }): Promise<Record<string, unknown>> {
    for (let cursor: string | null | undefined = undefined; ; ) {
      const res = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/eway/bills`)
        .query({ ...query, ...(cursor ? { cursor } : {}) })
        .set('Authorization', `Bearer ${operatorWebToken}`)
        .expect(200);
      const found = (res.body.items as { id: string }[]).find((item) => item.id === billId);
      if (found !== undefined) return found as Record<string, unknown>;
      cursor = res.body.nextCursor as string | null;
      if (!cursor) throw new Error(`bill ${billId} not listed`);
    }
  }

  async function auditCount(action: string, targetId: string): Promise<number> {
    const rows = await sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and action = ${action} and target_id = ${targetId}`;
    return (rows[0] as unknown as { n: number }).n;
  }

  function useSandbox(): void {
    const sandbox = sandboxEwayGateway();
    jest.spyOn(gateway, 'configuredFor').mockImplementation(sandbox.configuredFor);
    jest.spyOn(gateway, 'generate').mockImplementation(sandbox.generate);
  }

  // ── the queue: a real dispatch ─────────────────────────────────────────────

  describe('the real flow', () => {
    let invoiceId: string;
    let billId: string;

    beforeAll(async () => {
      // 10 × ₹6,000 inter-state at 18%: ₹60,000 + ₹10,800 = ₹70,800 > ₹50,000.
      const orderId = await dispatchedOrder(
        10,
        600_000,
        testAddress({ contactName: 'Asha Traders', line1: '4/7 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' }),
        BUYER27,
      );
      await drainAll();
      const inv = await sql`select id, status from invoices where tenant_id = ${tenantId} and order_id = ${orderId}`;
      expect(inv[0]?.status).toBe('issued');
      invoiceId = inv[0]!.id as string;
      await drainAll();
      const bill = await billFor(invoiceId);
      expect(bill).toBeDefined();
      billId = bill!.id;
    });

    it('queues exactly one pending bill on invoice.issued, and a redelivery writes nothing', async () => {
      expect(await billFor(invoiceId)).toMatchObject({ status: 'pending', consignment_value_paise: '7080000', threshold_paise: '5000000', threshold_rule: 'national' });
      await delivery.deliver(issuedEvent({ invoiceId }));
      await delivery.deliver(issuedEvent({ invoiceId }));
      const rows = await sql`select count(*)::int as n from eway_bills where invoice_id = ${invoiceId}`;
      expect((rows[0] as unknown as { n: number }).n).toBe(1);
    });

    it('golden: the exported bill reconciles to the stored invoice in integer paise, with every key typed', async () => {
      await patchTransport(billId, ROAD).expect(200);
      const res = await exportBills([billId]).expect(200);
      const file = res.body.file as { version: string; billLists: Record<string, unknown>[] };
      expect(file.version).toBe('1.0.0621');
      expect(file.billLists).toHaveLength(1);
      const bill = file.billLists[0]!;
      const types: Record<string, string> = {
        userGstin: 'string', supplyType: 'string', subSupplyType: 'number', subSupplyDesc: 'string', docType: 'string',
        docNo: 'string', docDate: 'string', transType: 'number', fromGstin: 'string', fromTrdName: 'string',
        fromAddr1: 'string', fromAddr2: 'string', fromPlace: 'string', fromPincode: 'number', fromStateCode: 'number',
        actualFromStateCode: 'number', toGstin: 'string', toTrdName: 'string', toAddr1: 'string', toAddr2: 'string',
        toPlace: 'string', toPincode: 'number', toStateCode: 'number', actualToStateCode: 'number', totalValue: 'number',
        cgstValue: 'number', sgstValue: 'number', igstValue: 'number', cessValue: 'number', TotNonAdvolVal: 'number',
        OthValue: 'number', totInvValue: 'number', transMode: 'number', transDistance: 'number', transporterId: 'string',
        transporterName: 'string', transDocNo: 'string', transDocDate: 'string', vehicleNo: 'string', vehicleType: 'string',
        mainHsnCode: 'string', itemList: 'object',
      };
      expect(Object.keys(bill).sort()).toEqual(Object.keys(types).sort());
      for (const [key, type] of Object.entries(types)) expect([key, typeof bill[key]]).toEqual([key, type]);

      const inv = (await sql`select invoice_no, subtotal_paise::text, gst_paise::text, payable_paise::text, round_off_paise::text from invoices where id = ${invoiceId}`)[0]!;
      const lineTax = (await sql`select sum(cgst_paise)::text as c, sum(sgst_paise)::text as s, sum(igst_paise)::text as i from invoice_lines where invoice_id = ${invoiceId}`)[0]!;
      const p = (v: unknown): number => Math.round((v as number) * 100);
      expect(p(bill.totalValue)).toBe(Number(inv.subtotal_paise));
      expect([p(bill.cgstValue), p(bill.sgstValue), p(bill.igstValue)]).toEqual([Number(lineTax.c), Number(lineTax.s), Number(lineTax.i)]);
      expect(p(bill.OthValue)).toBe(Number(inv.round_off_paise));
      expect(p(bill.totalValue) + p(bill.cgstValue) + p(bill.sgstValue) + p(bill.igstValue) + p(bill.OthValue)).toBe(p(bill.totInvValue));
      expect(p(bill.totInvValue)).toBe(Number(inv.payable_paise));
      expect(bill).toMatchObject({
        userGstin: G29, fromGstin: G29, docNo: inv.invoice_no, toGstin: BUYER27, toTrdName: 'Asha Traders',
        fromStateCode: 29, actualFromStateCode: 29, toStateCode: 27, actualToStateCode: 27, toPincode: 411001,
        vehicleNo: 'KA01AB1234', vehicleType: 'R', transMode: 1, transDistance: 840, mainHsnCode: '0904',
      });
      expect((bill.itemList as Record<string, unknown>[])[0]).toMatchObject({ itemNo: 1, hsnCode: '0904', quantity: 10, qtyUnit: 'NOS', igstRate: 18 });

      const after = await billById(billId);
      expect(after.last_exported_at).not.toBeNull();
      expect(await auditCount('eway.exported', billId)).toBe(1);
      expect((await listed(billId)).lastExportedAt).not.toBeNull();
    });
  });

  // ── the threshold matrix ───────────────────────────────────────────────────

  describe('the threshold matrix', () => {
    it('over the national threshold: inter-state ₹50,000.01 → pending, rule national', async () => {
      const bill = await queue(await seedInvoice({ lines: [{ gstBps: 1800, taxable: 4_000_001, igst: 1_000_000 }] }));
      expect(bill).toMatchObject({ status: 'pending', consignment_value_paise: '5000001', threshold_rule: 'national' });
    });

    it('at the threshold: ₹50,000.00 → no row', async () => {
      expect(await queue(await seedInvoice({ lines: [{ gstBps: 1800, taxable: 4_000_000, igst: 1_000_000 }] }))).toBeUndefined();
    });

    it('exempt lines: ₹40k at 0% + ₹20k at 5% → value ₹21,000, no row', async () => {
      const id = await seedInvoice({ lines: [{ gstBps: 0, taxable: 4_000_000 }, { gstBps: 500, taxable: 2_000_000, igst: 100_000 }] });
      expect(await queue(id)).toBeUndefined();
    });

    it('state override: intra-state in 27 at ₹1,00,000, value ₹80k → no row', async () => {
      const id = await seedInvoice({ gstin: G27, consignee: null, pos: '27', lines: [{ gstBps: 1800, taxable: 7_000_000, cgst: 500_000, sgst: 500_000 }] });
      expect(await queue(id)).toBeUndefined();
    });

    it('the override is intra-only: an inter-state supply from 27 at ₹80k uses national', async () => {
      const id = await seedInvoice({ gstin: G27, consignee: BUYER29, pos: '29', lines: [{ gstBps: 1800, taxable: 7_000_000, igst: 1_000_000 }] });
      expect(await queue(id)).toMatchObject({ status: 'pending', threshold_rule: 'national' });
    });

    it('override "none required": intra-state in 24 → no row whatever the value', async () => {
      const id = await seedInvoice({ gstin: G24, consignee: null, pos: '24', lines: [{ gstBps: 1800, taxable: 90_000_000, cgst: 8_100_000, sgst: 8_100_000 }] });
      expect(await queue(id)).toBeUndefined();
    });

    it('override not yet effective: issued the IST day before effective_from → national applies; on the day → the override', async () => {
      const lines = [{ gstBps: 1800, taxable: 7_000_000, cgst: 500_000, sgst: 500_000 }];
      // 9 Oct 23:59 IST = 9 Oct 18:29Z; 10 Oct 00:00 IST = 9 Oct 18:30Z.
      const before = await seedInvoice({ gstin: G07, consignee: null, pos: '07', issuedAt: '2026-10-09T18:29:59.999Z', lines });
      const onDay = await seedInvoice({ gstin: G07, consignee: null, pos: '07', issuedAt: '2026-10-09T18:30:00.000Z', lines });
      expect(await queue(before)).toMatchObject({ status: 'pending', threshold_rule: 'national', threshold_paise: '5000000' });
      expect(await queue(onDay)).toBeUndefined();
    });

    it('same-date correction: the newer created_at wins', async () => {
      const id = await seedInvoice({ gstin: G33, consignee: null, pos: '33', lines: [{ gstBps: 1800, taxable: 7_000_000, cgst: 500_000, sgst: 500_000 }] });
      expect(await queue(id)).toMatchObject({ status: 'pending', threshold_rule: 'state:33', threshold_paise: '6000000' });
    });

    it('a data fault is acked (issued before any national threshold → no row); a transient fault rethrows', async () => {
      const ancient = await seedInvoice({ issuedAt: '2017-06-01T06:00:00.000Z' });
      await expect(delivery.deliver(issuedEvent({ invoiceId: ancient }))).resolves.toBeUndefined();
      expect(await billFor(ancient)).toBeUndefined();
      const fresh = await seedInvoice();
      const db = app.get<{ transaction: (...args: unknown[]) => Promise<unknown> }>(DATABASE);
      jest.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('connection reset'));
      await expect(delivery.deliver(issuedEvent({ invoiceId: fresh }))).rejects.toThrow('connection reset');
      expect(await billFor(fresh)).toBeUndefined();
    });

    it('a bad payload or a not-issued invoice is acked and writes nothing', async () => {
      await expect(delivery.deliver(issuedEvent({}))).resolves.toBeUndefined();
      await expect(delivery.deliver(issuedEvent({ invoiceId: 'not-a-uuid' }))).resolves.toBeUndefined();
      await expect(delivery.deliver(issuedEvent({ invoiceId: uuidv7() }))).resolves.toBeUndefined();
      const awaiting = await seedInvoice({ status: 'awaiting-data' });
      expect(await queue(awaiting)).toBeUndefined();
    });
  });

  // ── blockers ──────────────────────────────────────────────────────────────

  describe('blockers', () => {
    const codesOf = async (billId: string): Promise<{ code: string; terminal: boolean }[]> =>
      (await listed(billId)).blockers as { code: string; terminal: boolean }[];

    it('no Part B and no transporter → transport-incomplete (fixable); export refuses 409 naming it', async () => {
      const id = await pendingBill();
      expect(await codesOf(id)).toEqual([{ code: 'transport-incomplete', terminal: false }]);
      const res = await exportBills([id]).expect(409);
      expect(res.body.code).toBe('eway-not-exportable');
      expect(res.body.bills).toEqual([{ id, reasons: ['transport-incomplete'] }]);
      expect((await billById(id)).last_exported_at).toBeNull();
    });

    it('Part A only: a transporter id and no vehicle exports as transMode 1, vehicleType R, vehicleNo ""', async () => {
      const id = await readyBill({}, { transMode: 1, transporterId: '29aabct1234q1zp', transporterName: 'Swift Logistics' });
      expect(await codesOf(id)).toEqual([]);
      const res = await exportBills([id]).expect(200);
      expect(res.body.file.billLists[0]).toMatchObject({ transMode: 1, vehicleType: 'R', vehicleNo: '', transporterId: '29AABCT1234Q1ZP' });
    });

    it('Part A with NO mode: only a transporter id saves, and exports as transMode 1, vehicleType R, vehicleNo ""', async () => {
      const id = await pendingBill();
      await patchTransport(id, { transporterId: '29AABCT1234Q1ZP' }).expect(200);
      expect(await codesOf(id)).toEqual([]);
      const res = await exportBills([id]).expect(200);
      expect(res.body.file.billLists[0]).toMatchObject({ transMode: 1, vehicleType: 'R', vehicleNo: '', transporterId: '29AABCT1234Q1ZP' });
    });

    it('a bill with a live claim is refused by export with reasons [claimed]', async () => {
      const id = await readyBill();
      await sql`update eway_bills set gateway_claimed_at = now() where id = ${id}`;
      expect((await exportBills([id]).expect(409)).body.bills).toEqual([{ id, reasons: ['claimed'] }]);
      await sql`update eway_bills set gateway_claimed_at = null where id = ${id}`;
    });

    it('an invoice no longer issued → invoice-unavailable (terminal); Part B answers 409, not 404', async () => {
      const invoiceId = await seedInvoice();
      const bill = (await queue(invoiceId))!;
      await sql`update invoices set status = 'voided' where id = ${invoiceId}`;
      expect(await codesOf(bill.id)).toEqual([{ code: 'invoice-unavailable', terminal: true }]);
      const res = await patchTransport(bill.id, ROAD).expect(409);
      expect(res.body).toMatchObject({ code: 'eway-not-exportable', bills: [{ id: bill.id, reasons: ['invoice-unavailable'] }] });
      expect((await exportBills([bill.id]).expect(409)).body.bills[0].reasons).toEqual(['invoice-unavailable']);
    });

    it('export ids are case-insensitive, and a case-variant repeat is refused', async () => {
      const id = await readyBill();
      await exportBills([id.toUpperCase()]).expect(200);
      await exportBills([id, id.toUpperCase()]).expect(400);
    });

    it('B2B with e-invoicing on → needs-irn (export 409); B2C of the same GSTIN still exports', async () => {
      await request(app.getHttpServer())
        .put(`${API}/${tenantId}/eway/gstin-settings/${G27}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ eInvoiceApplies: true })
        .expect(200);
      const b2b = await readyBill({ gstin: G27, consignee: BUYER29, pos: '29' });
      const b2c = await readyBill({ gstin: G27, consignee: null, pos: '29' });
      expect(await codesOf(b2b)).toEqual([{ code: 'needs-irn', terminal: false }]);
      expect(await codesOf(b2c)).toEqual([]);
      const res = await exportBills([b2b]).expect(409);
      expect(res.body.bills).toEqual([{ id: b2b, reasons: ['needs-irn'] }]);
      await exportBills([b2c]).expect(200);
      // Turning the flag OFF (lowercase path — canonicalised) clears needs-irn.
      await request(app.getHttpServer())
        .put(`${API}/${tenantId}/eway/gstin-settings/${G27.toLowerCase()}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ eInvoiceApplies: false })
        .expect(200);
      expect(await codesOf(b2b)).toEqual([]);
      await exportBills([b2b]).expect(200);
      await request(app.getHttpServer())
        .put(`${API}/${tenantId}/eway/gstin-settings/${G27}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ eInvoiceApplies: true })
        .expect(200);
    });

    it('bill-to ≠ ship-to (pos-discrepancy) → ship-to-differs, terminal', async () => {
      const id = await readyBill({ consigneeAddress: ADDR.GJ });
      expect(await codesOf(id)).toEqual([{ code: 'ship-to-differs', terminal: true }]);
      expect((await exportBills([id]).expect(409)).body.bills[0].reasons).toEqual(['ship-to-differs']);
    });

    it('every terminal blocker is listed and enforced: hsn, age, state, supply, rate, address, lines', async () => {
      const many = await readyBill({
        issuedAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
        pos: '97',
        consigneeAddress: { ...ADDR.MH, state: 'Atlantis' },
        lines: [{ gstBps: 600, taxable: 6_000_000, igst: 360_000, hsn: null }],
      });
      expect((await codesOf(many)).map((b) => [b.code, b.terminal])).toEqual([
        ['hsn-issue', true],
        ['doc-too-old', true],
        ['state-unresolved', true],
        ['unsupported-supply', true],
        ['rate-not-standard', true],
      ]);
      const noBuyer = await readyBill({ buyerName: null });
      expect((await codesOf(noBuyer)).map((b) => b.code)).toEqual(['address-incomplete']);
      const wide = await readyBill({ lines: Array.from({ length: 251 }, () => ({ gstBps: 1800, taxable: 100_000, igst: 18_000 })) });
      expect((await codesOf(wide)).map((b) => b.code)).toEqual(['too-many-lines']);
      const res = await exportBills([many, noBuyer, wide]).expect(409);
      expect((res.body.bills as { id: string }[]).map((b) => b.id).sort()).toEqual([many, noBuyer, wide].sort());
    });

    it('mixed GSTINs in one export: the whole request is refused with mixed-gstin', async () => {
      const a = await readyBill();
      const b = await readyBill();
      const c = await readyBill({ gstin: G27, consignee: null, pos: '29' });
      const res = await exportBills([a, b, c]).expect(409);
      expect(res.body.bills).toEqual([{ id: c, reasons: ['mixed-gstin'] }]);
      expect((await billById(a)).last_exported_at).toBeNull();
    });

    it('record and dismiss ignore blockers (a terminal bill is generated on the portal by hand)', async () => {
      const terminal = await pendingBill({ consigneeAddress: ADDR.GJ });
      await recordBill(terminal).expect(200);
      const other = await pendingBill({ consigneeAddress: ADDR.GJ });
      const dismissed = await dismissBill(other).expect(200);
      expect(dismissed.body.bill).toMatchObject({ status: 'dismissed', dismissedReason: 'Customer collected in person', blockers: [] });
    });
  });

  // ── Part B ─────────────────────────────────────────────────────────────────

  describe('Part B', () => {
    it('replaces the whole Part B (normalized) and null clears it', async () => {
      const id = await pendingBill();
      const res = await patchTransport(id, ROAD).expect(200);
      expect(res.body.bill.transport).toEqual({
        transMode: 1, vehicleNo: 'KA01AB1234', vehicleType: 'R', transporterId: null, transporterName: null, transDocNo: null, transDocDate: null, distanceKm: 840,
      });
      const cleared = await patchTransport(id, { transporterId: '29AABCT1234Q1ZP', transMode: 1 }).expect(200);
      expect(cleared.body.bill.transport).toMatchObject({ vehicleNo: null, vehicleType: null, distanceKm: null, transporterId: '29AABCT1234Q1ZP' });
    });

    it('refuses each NIC rule with a 400 naming it', async () => {
      const id = await pendingBill();
      const detail = async (body: Record<string, unknown>): Promise<string> => {
        const res = await patchTransport(id, body).expect(400);
        expect(res.body.code).toBe('validation-failed');
        return res.body.detail as string;
      };
      expect(await detail({ vehicleNo: 'KA01AB1234' })).toContain('transMode is required');
      expect(await detail({ transMode: 1, vehicleNo: 'KA01AB1234' })).toContain('vehicleType');
      expect(await detail({ transMode: 2 })).toContain('transDocNo is required');
      expect(await detail({ transMode: 1, transporterId: 'NOPE' })).toContain('transporterId');
      expect(await detail({ transMode: 3, transDocNo: 'AWB1', transDocDate: '2020-01-01' })).toContain('before the invoice date');
      expect(await detail({ transMode: 1, vehicleNo: 'KA01AB1234', vehicleType: 'R', distanceKm: 5000 })).toContain('distanceKm');
    });

    it('the same key replays; a different body under it is 422', async () => {
      const id = await pendingBill();
      const key = ulid();
      const first = await patchTransport(id, ROAD, accountantToken, key).expect(200);
      const again = await patchTransport(id, ROAD, accountantToken, key).expect(200);
      expect(again.body).toEqual(first.body);
      expect((await patchTransport(id, { ...ROAD, distanceKm: 1 }, accountantToken, key).expect(422)).body.code).toBe('idempotency-key-reuse');
    });
  });

  // ── record ────────────────────────────────────────────────────────────────

  describe('record', () => {
    it('AC: three ready bills from one GSTIN — export, record three numbers → generated/manual, audited, re-export refused', async () => {
      const ids = [await readyBill({ consignee: null }), await readyBill({ consignee: null }), await readyBill({ consignee: null })];
      const exported = await exportBills(ids).expect(200);
      expect(exported.body.file.billLists).toHaveLength(3);
      for (const id of ids) {
        const res = await recordBill(id).expect(200);
        expect(res.body.bill).toMatchObject({ status: 'generated', source: 'manual', blockers: [], gatewayAvailable: false });
        expect(res.body.bill.ewbNo).toMatch(/^[0-9]{12}$/);
        expect(await auditCount('eway.recorded', id)).toBe(1);
      }
      for (const id of ids) {
        const res = await exportBills([id]).expect(409);
        expect(res.body.bills).toEqual([{ id, reasons: ['not-pending'] }]);
      }
      expect((await listed(ids[0]!, { status: 'generated' })).source).toBe('manual');
    });

    it('validates the number and the dates (400), refuses a non-pending bill and a used number (409)', async () => {
      const id = await pendingBill();
      await recordBill(id, { ewbNo: '12345' }).expect(400);
      await recordBill(id, { generatedAt: 'yesterday' }).expect(400);
      await recordBill(id, { generatedAt: '2020-01-01T00:00:00.000Z' }).expect(400);
      await recordBill(id, { generatedAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(400);
      const at = new Date(Date.now() - 60_000).toISOString();
      await recordBill(id, { generatedAt: at, validUntil: new Date(Date.now() - 120_000).toISOString() }).expect(400);
      const ewbNo = nextEwbNo();
      await recordBill(id, { ewbNo, generatedAt: at, validUntil: new Date(Date.now() + 86_400_000).toISOString() }).expect(200);
      expect((await recordBill(id).expect(409)).body.code).toBe('eway-not-pending');
      const other = await pendingBill();
      expect((await recordBill(other, { ewbNo }).expect(409)).body.code).toBe('ewb-no-taken');
    });

    it('is refused while a gateway claim is live, and allowed once it expires', async () => {
      const id = await pendingBill();
      await sql`update eway_bills set gateway_claimed_at = now() where id = ${id}`;
      expect((await recordBill(id).expect(409)).body.code).toBe('eway-claimed');
      expect((await dismissBill(id).expect(409)).body.code).toBe('eway-claimed');
      await sql`update eway_bills set gateway_claimed_at = now() - interval '3 minutes' where id = ${id}`;
      await recordBill(id).expect(200);
    });
  });

  // ── generate ──────────────────────────────────────────────────────────────

  describe('generate through the gateway', () => {
    it('unconfigured (the production default): gatewayAvailable false and 501 gateway-unconfigured', async () => {
      const id = await readyBill();
      expect((await listed(id)).gatewayAvailable).toBe(false);
      expect((await generateBill(id).expect(501)).body.code).toBe('gateway-unconfigured');
      expect((await billById(id)).gateway_claimed_at).toBeNull();
    });

    it('sandbox: a ready bill → generated, source gateway, validity set, audited; a replay re-serves it', async () => {
      useSandbox();
      const id = await readyBill();
      expect((await listed(id)).gatewayAvailable).toBe(true);
      const key = ulid();
      const res = await generateBill(id, accountantToken, key).expect(200);
      expect(res.body.bill).toMatchObject({ status: 'generated', source: 'gateway', gatewayClaimedAt: null });
      expect(res.body.bill.ewbNo).toMatch(/^[0-9]{12}$/);
      // 840 km → 5 days.
      expect(Date.parse(res.body.bill.ewbValidUntil) - Date.parse(res.body.bill.ewbGeneratedAt)).toBe(5 * 86_400_000);
      expect(await auditCount('eway.generated', id)).toBe(1);
      expect((await generateBill(id, accountantToken, key).expect(200)).body).toEqual(res.body);
      expect((await generateBill(id).expect(409)).body.code).toBe('eway-not-pending');
    });

    it('a blocked bill is refused 409 eway-not-exportable before the gateway is called', async () => {
      useSandbox();
      const id = await pendingBill();
      const res = await generateBill(id).expect(409);
      expect(res.body).toMatchObject({ code: 'eway-not-exportable', bills: [{ id, reasons: ['transport-incomplete'] }] });
      expect(gateway.generate).not.toHaveBeenCalled();
    });

    it('a refusal: 422 eway-gateway-refused, last_error stored, the claim cleared', async () => {
      useSandbox();
      const id = await readyBill({}, { ...ROAD, transporterName: 'SANDBOX-REFUSE' });
      expect((await generateBill(id).expect(422)).body.code).toBe('eway-gateway-refused');
      const row = await billById(id);
      expect(row).toMatchObject({ status: 'pending', gateway_claimed_at: null });
      expect(row.last_error).toContain('SANDBOX-REFUSE');
      expect((await listed(id)).lastError).toContain('SANDBOX-REFUSE');
    });

    it('unavailable: 503 and the claim is KEPT — a retry inside two minutes is 409, after it succeeds', async () => {
      useSandbox();
      const id = await readyBill();
      (gateway.generate as jest.Mock).mockImplementationOnce(async () => {
        throw new EwayGatewayUnavailable('NIC timed out.');
      });
      expect((await generateBill(id).expect(503)).body.code).toBe('eway-gateway-unavailable');
      expect((await billById(id)).gateway_claimed_at).not.toBeNull();
      expect((await generateBill(id).expect(409)).body.code).toBe('eway-claimed');
      await sql`update eway_bills set gateway_claimed_at = now() - interval '3 minutes' where id = ${id}`;
      expect((await generateBill(id).expect(200)).body.bill.status).toBe('generated');
    });

    it('a gateway number the bill cannot take is kept in last_error, never dropped', async () => {
      useSandbox();
      const recorded = await pendingBill();
      const ewbNo = nextEwbNo();
      await recordBill(recorded, { ewbNo }).expect(200);
      const id = await readyBill();
      (gateway.generate as jest.Mock).mockResolvedValueOnce({ ewbNo, generatedAt: new Date().toISOString(), validUntil: null });
      expect((await generateBill(id).expect(409)).body.code).toBe('ewb-no-taken');
      const row = await billById(id);
      expect(row).toMatchObject({ status: 'pending', gateway_claimed_at: null });
      expect(row.last_error).toContain(`gateway generated EWB ${ewbNo}`);
    });

    it('an unexpected gateway failure keeps the claim (503); a malformed validUntil is refused 422', async () => {
      useSandbox();
      const id = await readyBill();
      (gateway.generate as jest.Mock).mockRejectedValueOnce(new TypeError('socket hang up'));
      expect((await generateBill(id).expect(503)).body.code).toBe('eway-gateway-unavailable');
      expect((await billById(id)).gateway_claimed_at).not.toBeNull();
      await sql`update eway_bills set gateway_claimed_at = null where id = ${id}`;
      const at = new Date().toISOString();
      (gateway.generate as jest.Mock).mockResolvedValueOnce({ ewbNo: nextEwbNo(), generatedAt: at, validUntil: new Date(Date.parse(at) - 1000).toISOString() });
      expect((await generateBill(id).expect(422)).body.code).toBe('eway-gateway-refused');
      expect((await billById(id)).gateway_claimed_at).toBeNull();
    });

    it('the claim race: a record (or dismiss, or second generate) during the call is 409; the call then settles', async () => {
      useSandbox();
      const sandbox = sandboxEwayGateway();
      const id = await readyBill();
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      let entered!: () => void;
      const inFlight = new Promise<void>((done) => {
        entered = done;
      });
      (gateway.generate as jest.Mock).mockImplementationOnce(async (...args: Parameters<EwayGateway['generate']>) => {
        entered();
        await gate;
        return sandbox.generate(...args);
      });
      const pendingGenerate = generateBill(id).then((res) => res);
      await inFlight;
      let racing: number[];
      try {
        racing = [(await recordBill(id)).status, (await dismissBill(id)).status, (await generateBill(id)).status];
      } finally {
        // Always release the in-flight call, or a failure here hangs the suite.
        release();
      }
      expect(racing).toEqual([409, 409, 409]);
      const settled = await pendingGenerate;
      expect(settled.status).toBe(200);
      expect(settled.body.bill).toMatchObject({ status: 'generated', source: 'gateway' });
    });
  });

  // ── authority and configuration ───────────────────────────────────────────

  describe('authority and configuration', () => {
    it('eway.manage: owner, ops manager and accountant act; the operator is refused 403', async () => {
      const id = await pendingBill();
      expect((await patchTransport(id, ROAD, operatorWebToken).expect(403)).body.code).toBe('role-denied');
      expect((await recordBill(id, {}, operatorWebToken).expect(403)).body.code).toBe('role-denied');
      expect((await exportBills([id], operatorWebToken).expect(403)).body.code).toBe('role-denied');
      await patchTransport(id, ROAD, ownerToken).expect(200);
      await patchTransport(id, ROAD, opsToken).expect(200);
      await dismissBill(id, 'Below the limit after a return', opsToken).expect(200);
    });

    it('eway.configure is owner-only', async () => {
      expect((await appendThreshold('27', 1, '2026-01-01', accountantToken).expect(403)).body.code).toBe('role-denied');
      expect((await appendThreshold('27', 1, '2026-01-01', opsToken).expect(403)).body.code).toBe('role-denied');
      const put = await request(app.getHttpServer())
        .put(`${API}/${tenantId}/eway/gstin-settings/${G29}`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .set(KEY_HEADER, ulid())
        .send({ eInvoiceApplies: true })
        .expect(403);
      expect(put.body.code).toBe('role-denied');
    });

    it('state overrides: the CBIC list minus 97/99, a real date, a non-negative amount; the history lists every row', async () => {
      await appendThreshold('97', 1, '2026-01-01').expect(400);
      await appendThreshold('99', 1, '2026-01-01').expect(400);
      await appendThreshold('28', 1, '2026-01-01').expect(400); // not on the CBIC list
      await appendThreshold('7', 1, '2026-01-01').expect(400);
      await appendThreshold('27', 1, '2026-02-30').expect(400);
      await appendThreshold('27', -1, '2026-01-01').expect(400);
      const res = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/eway/state-thresholds`)
        .set('Authorization', `Bearer ${operatorWebToken}`)
        .expect(200);
      const tn = (res.body.items as { stateCode: string; thresholdPaise: number | null }[]).filter((row) => row.stateCode === '33');
      expect(tn.map((row) => row.thresholdPaise)).toEqual([6_000_000, 100_000_000]);
    });

    it('state overrides are append-only in the database', async () => {
      await expect(sql`update eway_state_thresholds set threshold_paise = 1 where tenant_id = ${tenantId}`).rejects.toThrow(/append-only/);
    });

    it('GSTIN settings: only the tenant\'s GSTINs (404 otherwise, 400 malformed); the list shows every held GSTIN', async () => {
      const put = (gstin: string) =>
        request(app.getHttpServer())
          .put(`${API}/${tenantId}/eway/gstin-settings/${gstin}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ eInvoiceApplies: false });
      expect((await put('19AAAPZ1234C1ZV').expect(404)).body.code).toBe('not-found');
      await put('nope').expect(400);
      const res = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/eway/gstin-settings`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200);
      const items = res.body.items as { gstin: string; eInvoiceApplies: boolean }[];
      expect(items.map((item) => item.gstin)).toEqual([G27, G29]);
      expect(items.find((item) => item.gstin === G27)?.eInvoiceApplies).toBe(true);
      expect(items.find((item) => item.gstin === G29)?.eInvoiceApplies).toBe(false);
    });
  });

  // ── storage ───────────────────────────────────────────────────────────────

  describe('storage', () => {
    const insertBill = (fields: Record<string, unknown>) => {
      const row = {
        id: uuidv7(),
        tenant_id: tenantId,
        invoice_id: uuidv7(),
        origin_gstin: G29,
        status: 'pending',
        consignment_value_paise: 6_000_000,
        threshold_paise: 5_000_000,
        threshold_rule: 'national',
        ...fields,
      };
      return sql`insert into eway_bills ${sql(row as never)}`;
    };

    it('the CHECKs hold the two-way status rules, the value rule and the vocabularies', async () => {
      await expect(insertBill({ status: 'generated' })).rejects.toThrow(/eway_bills_generated_result_check/);
      await expect(insertBill({ ewb_no: '123456789012' })).rejects.toThrow(/eway_bills_generated_result_check/);
      await expect(insertBill({ status: 'dismissed' })).rejects.toThrow(/eway_bills_dismissed_reason_check/);
      await expect(insertBill({ dismissed_reason: 'x' })).rejects.toThrow(/eway_bills_dismissed_reason_check/);
      await expect(insertBill({ consignment_value_paise: 5_000_000 })).rejects.toThrow(/eway_bills_value_over_threshold_check/);
      await expect(insertBill({ threshold_rule: 'state:7' })).rejects.toThrow(/eway_bills_threshold_rule_check/);
      await expect(insertBill({ trans_mode: 5 })).rejects.toThrow(/eway_bills_trans_mode_check/);
      await expect(insertBill({ distance_km: 4001 })).rejects.toThrow(/eway_bills_distance_check/);
      await expect(insertBill({ status: 'generated', ewb_no: '1234', ewb_generated_at: nowIso(), source: 'manual' })).rejects.toThrow(/eway_bills_ewb_no_shape_check/);
      await expect(insertBill({ status: 'void' })).rejects.toThrow(/eway_bills_status_check/);
      await insertBill({ status: 'generated', ewb_no: '999999999999', ewb_generated_at: nowIso(), source: 'manual' });
      await expect(insertBill({ status: 'generated', ewb_no: '999999999999', ewb_generated_at: nowIso(), source: 'manual' })).rejects.toThrow(
        /eway_bills_tenant_ewb_no_unique/,
      );
      const invoiceId = uuidv7();
      await insertBill({ invoice_id: invoiceId });
      await expect(insertBill({ invoice_id: invoiceId })).rejects.toThrow(/eway_bills_invoice_unique/);
    });

    it('pins the TS status vocabulary against the DB CHECK', async () => {
      const rows = await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'eway_bills_status_check'`;
      const def = rows[0]!.def as string;
      const inDb = [...def.matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1]);
      expect(inDb).toEqual([...EWAY_BILL_STATUSES]);
    });

    it('RLS fails closed on the three tenant tables', async () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        for (const table of ['eway_bills', 'eway_state_thresholds', 'eway_gstin_settings']) {
          const seeded = await sql.unsafe(`select count(*)::int as n from ${table} where tenant_id = $1`, [tenantId]);
          expect((seeded[0] as unknown as { n: number }).n).toBeGreaterThan(0);
          expect(await rls.unsafe(`select 1 from ${table} where tenant_id = $1`, [tenantId])).toHaveLength(0);
          const foreign = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
            return tx.unsafe(`select 1 from ${table} where tenant_id = $1`, [tenantId]);
          });
          expect(foreign).toHaveLength(0);
          const own = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            return tx.unsafe(`select 1 from ${table} where tenant_id = $1`, [tenantId]);
          });
          expect(own.length).toBeGreaterThan(0);
        }
      } finally {
        await rls.end();
      }
    });
  });

  describe('the HTTP surface', () => {
    it('declares the literal export route before the :billId routes, and the list pages with a cursor', async () => {
      const proto = Object.getOwnPropertyNames(EwayController.prototype);
      for (const name of ['updateTransport', 'record', 'dismiss', 'generate']) {
        expect(proto.indexOf('exportBills')).toBeLessThan(proto.indexOf(name));
      }
      const first = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/eway/bills`)
        .query({ limit: 2 })
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200);
      expect(first.body.items).toHaveLength(2);
      const second = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/eway/bills`)
        .query({ limit: 2, cursor: first.body.nextCursor })
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200);
      const firstIds = (first.body.items as { id: string }[]).map((i) => i.id);
      const secondIds = (second.body.items as { id: string }[]).map((i) => i.id);
      expect(secondIds.length).toBeGreaterThan(0);
      expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
      const pending = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/eway/bills`)
        .query({ status: 'pending' })
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200);
      expect(pending.body.items.length).toBeGreaterThan(0);
      expect((pending.body.items as { status: string }[]).filter((i) => i.status !== 'pending')).toEqual([]);
      const g27 = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/eway/bills`)
        .query({ gstin: G27.toLowerCase() })
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200);
      expect(g27.body.items.length).toBeGreaterThan(0);
      expect((g27.body.items as { originGstin: string }[]).filter((i) => i.originGstin !== G27)).toEqual([]);
      await request(app.getHttpServer()).get(`${API}/${tenantId}/eway/bills`).query({ limit: 51 }).set('Authorization', `Bearer ${accountantToken}`).expect(400);
    });

    it('the committed OpenAPI document lists every e-way route', () => {
      const committed = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8') as string) as { paths: Record<string, unknown> };
      expect(Object.keys(committed.paths)).toEqual(
        expect.arrayContaining([
          '/tenants/{tenantId}/eway/bills',
          '/tenants/{tenantId}/eway/bills/export',
          '/tenants/{tenantId}/eway/bills/{billId}/transport',
          '/tenants/{tenantId}/eway/bills/{billId}/record',
          '/tenants/{tenantId}/eway/bills/{billId}/dismiss',
          '/tenants/{tenantId}/eway/bills/{billId}/generate',
          '/tenants/{tenantId}/eway/state-thresholds',
          '/tenants/{tenantId}/eway/gstin-settings',
          '/tenants/{tenantId}/eway/gstin-settings/{gstin}',
        ]),
      );
    });
  });
});
