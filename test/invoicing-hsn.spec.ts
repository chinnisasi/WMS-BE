import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { InvoicingCommand } from '../src/modules/invoicing/command';
import { InvoicingController } from '../src/api/invoicing.controller';
import { UOMS } from '../src/modules/catalog/uom';
import { UOM_TO_UQC, UQCS, uqcFor } from '../src/modules/invoicing/uqc';
import { isValidHsn, parsePeriod } from '../src/modules/invoicing/hsn-summary';
import type { HsnSummaryRow, HsnSummaryView } from '../src/modules/invoicing/hsn-summary';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

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

/** The supplier GSTIN whose summary the matrix reads (Karnataka). */
const G29 = '29AAAPZ1234C1ZV';
/** Another of the tenant's registrations — never in the 29 summary. */
const G27 = '27AAAPZ1234C1ZV';
/** The real-flow warehouse's GSTIN (Gujarat) — its invoices issue on today's clock. */
const G24 = '24AAAPZ1234C1ZV';
/** A recipient's registration (B2B). */
const BUYER = '27BBBPT5678M2AB';

interface SeedLine {
  sku: string;
  hsn: string | null;
  uom: string;
  gstBps: number;
  qtyMilli: number;
  taxable: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
}

/**
 * Story 8-2a — the HSN summary (GSTR-1 Table 12) over issued invoices.
 *
 * Two kinds of fixture, each where it can prove something:
 *  - REAL generation (dispatch → `InvoicingCommand.generate`) for the write
 *    side: `issued_at` and `uom` on both issuance paths (insert; and the
 *    awaiting→issued update), against the document the same call froze.
 *  - RAW rows for the READ side: the matrix needs issue instants at chosen
 *    milliseconds (the IST month boundary, a Q4 across the calendar year),
 *    which only the database can stamp — this half of the test is about
 *    the read model over stored rows, so it seeds the stored rows.
 */
describe('invoicing: the HSN summary (e2e, story 8-2a)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  let suiteDb: SuiteDatabase;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let opsToken: string;
  let accountantToken: string;
  let operatorWebToken: string;
  let operatorToken: string;
  let warehouseId: string;
  let binId: string;
  const skuIds = new Map<string, string>();
  let command: InvoicingCommand;
  let seriesNo = 0;

  // ── the matrix's raw invoices (GSTIN 29 unless stated) ───────────────────
  const ids = {
    sepB2b: uuidv7(),
    sepB2c: uuidv7(),
    sepEmpty: uuidv7(),
    lastMsSep: uuidv7(),
    firstMsOct: uuidv7(),
    awaiting: uuidv7(),
    voided: uuidv7(),
    otherGstin: uuidv7(),
    july: uuidv7(),
    lastMsJune: uuidv7(),
    jan: uuidv7(),
    lastMsMar: uuidv7(),
    firstMsApr: uuidv7(),
  };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('invoicing_hsn');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });
    command = app.get(InvoicingCommand);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `HSN Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = await signIn(email, 'correct-horse-battery');
    opsToken = await inviteAndSignIn('ops_manager', 'ops-password-123');
    accountantToken = await inviteAndSignIn('accountant', 'books-password-123');
    operatorWebToken = await inviteAndSignIn('operator', 'floor-password-123');

    const wh = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        gstin: G24,
        origin: testAddress({ state: 'Gujarat', city: 'Surat', line1: '1, Ring Road', pincode: '395002' }),
        code: `HSN-${ulid().slice(10, 16).toUpperCase()}`,
        name: `HSN WH ${ulid()}`,
      })
      .expect(201);
    warehouseId = wh.body.id as string;
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

    // HS-INS issues on INSERT (priced at acceptance); HS-UPD parks unpriced,
    // then issues on the UPDATE path. HS-BLANK / HS-BAD carry the catalog
    // HSN the issue-line hint must read back (the frozen lines say otherwise).
    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
      'HS-INS,HSN insert-path SKU,pcs,,1800,0910,false,false,,,',
      'HS-UPD,HSN update-path SKU,kg,,500,1006,false,false,,,',
      'HS-BLANK,Blank-HSN SKU,pcs,,1800,21069099,false,false,,,',
      'HS-BAD,Malformed-HSN SKU,pcs,,1800,,false,false,,,',
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
    for (const item of catalogList.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }

    // The floor device + its badge-in operator (picks feed the real flow).
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'HSN desk scanner', pin: '2468' })
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

    await seedMatrix();
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
      for (const table of ['picks', 'picklist_lines', 'picklists', 'waves', 'wave_policies', 'invoice_lines', 'invoices', 'invoice_series', 'order_lines', 'orders']) {
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

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  /** The full floor flow for one single-line order, ending DISPATCHED (no invoice generated yet). */
  async function dispatchedOrder(skuCode: string, quantity: number, ratePaise?: number): Promise<{ orderId: string; orderLineId: string }> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: sku(skuCode), binId, quantityDelta: quantity + 5, reasonCode: 'stock-count', note: 'hsn-suite seed' })
      .expect(201);
    const created = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        lines: [ratePaise === undefined ? { skuId: sku(skuCode), quantity } : { skuId: sku(skuCode), quantity, ratePaise }],
        destination: testAddress({ state: 'Gujarat', city: 'Surat', line1: '2, Ring Road', pincode: '395003' }),
      })
      .expect(201);
    const orderId = created.body.order.id as string;
    const orderLineId = (created.body.order.lines as { id: string }[])[0]!.id;
    const policy = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/wave-policies`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, name: `hsn-${ulid().slice(10, 18)}`, grouping: 'single' })
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
      .send({ scanned: [{ skuId: sku(skuCode), qty: quantity }] })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${operatorWebToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    return { orderId, orderLineId };
  }

  /** One raw invoice + its lines, satisfying every stored CHECK. */
  async function seedInvoice(
    id: string,
    opts: { gstin?: string; consignee?: string | null; status?: 'issued' | 'awaiting-data' | 'voided'; issuedAt: string | null; lines: SeedLine[] },
  ): Promise<void> {
    const status = opts.status ?? 'issued';
    const gstin = opts.gstin ?? G29;
    const subtotal = opts.lines.reduce((s, l) => s + l.taxable, 0);
    const gst = opts.lines.reduce((s, l) => s + (l.igst ?? 0) + (l.cgst ?? 0) + (l.sgst ?? 0), 0);
    const total = subtotal + gst;
    const payable = Math.floor((total + 50) / 100) * 100;
    const invoiceNo = status === 'issued' ? `${gstin.slice(0, 2)}/2627/${String(++seriesNo).padStart(6, '0')}` : null;
    const lineIds = opts.lines.map(() => uuidv7());
    const document = {
      header: { invoiceNo, fyLabel: invoiceNo === null ? null : 'FY-2627', orderRef: uuidv7(), issuedAt: opts.issuedAt, originGstin: gstin, consigneeGstin: opts.consignee ?? null },
      lines: opts.lines.map((l, i) => ({ orderLineId: lineIds[i], skuCode: l.sku, hsn: l.hsn, uom: l.uom })),
      totals: { subtotal, gst, total, roundOff: payable - total, payable },
      gaps: [],
      revision: 1,
    };
    await sql`
      insert into invoices (id, tenant_id, order_id, warehouse_id, invoice_no, fy_label, series_seq, status, origin_gstin,
        consignee_gstin, place_of_supply, supply_type, subtotal_paise, gst_paise, total_paise, payable_paise, round_off_paise,
        revision, document, issued_at)
      values (${id}, ${tenantId}, ${uuidv7()}, ${warehouseId}, ${invoiceNo}, ${invoiceNo === null ? null : 'FY-2627'},
        ${invoiceNo === null ? null : seriesNo}, ${status}, ${gstin}, ${opts.consignee ?? null}, '29', 'intra',
        ${subtotal}, ${gst}, ${total}, ${payable}, ${payable - total}, 1, ${sql.json(document as never)},
        ${status === 'awaiting-data' ? null : opts.issuedAt}::timestamptz)
    `;
    for (const [i, l] of opts.lines.entries()) {
      await sql`
        insert into invoice_lines (id, tenant_id, invoice_id, order_line_id, sku_code, sku_name, hsn, qty_milli, rate_paise,
          rate_source, taxable_paise, gst_bps, cgst_paise, sgst_paise, igst_paise, hsn_gap, uom)
        values (${uuidv7()}, ${tenantId}, ${id}, ${lineIds[i]!}, ${l.sku}, ${l.sku}, ${l.hsn}, ${l.qtyMilli}, 0, 'manual',
          ${l.taxable}, ${l.gstBps}, ${l.cgst ?? 0}, ${l.sgst ?? 0}, ${l.igst ?? 0}, ${l.hsn === null}, ${l.uom})
      `;
    }
  }

  /** A filler line (one per period-boundary invoice): HSN 0910, kg, 5%. */
  const filler = (taxable: number): SeedLine => ({ sku: 'FILL', hsn: '0910', uom: 'kg', gstBps: 500, qtyMilli: 1000, taxable, igst: taxable / 20 });

  async function seedMatrix(): Promise<void> {
    // September 2026 (IST), B2B: one HSN at two rates.
    await seedInvoice(ids.sepB2b, {
      consignee: BUYER,
      issuedAt: '2026-09-10T05:00:00.000Z',
      lines: [
        { sku: 'PEPPER', hsn: '0910', uom: 'kg', gstBps: 500, qtyMilli: 2_500, taxable: 100_000, cgst: 2_500, sgst: 2_500 },
        { sku: 'PEPPER-P', hsn: '0910', uom: 'kg', gstBps: 1200, qtyMilli: 1_000, taxable: 50_000, cgst: 3_000, sgst: 3_000 },
      ],
    });
    // September, B2C: one HSN in two units; jar + keg merging under OTH; a
    // padded valid 6-digit HSN; a blank and a malformed HSN (the issues).
    await seedInvoice(ids.sepB2c, {
      issuedAt: '2026-09-15T12:00:00.000Z',
      lines: [
        { sku: 'RICE-KG', hsn: '1006', uom: 'kg', gstBps: 500, qtyMilli: 1_500, taxable: 30_000, igst: 1_500 },
        { sku: 'RICE-BAG', hsn: '1006', uom: 'bag', gstBps: 500, qtyMilli: 3_000, taxable: 45_000, igst: 2_250 },
        { sku: 'WATER-JAR', hsn: '2201', uom: 'jar', gstBps: 1800, qtyMilli: 2_000, taxable: 20_000, igst: 3_600 },
        { sku: 'WATER-KEG', hsn: '2201', uom: 'keg', gstBps: 1800, qtyMilli: 1_000, taxable: 15_000, igst: 2_700 },
        { sku: 'PEPPER-WHOLE', hsn: ' 091011 ', uom: 'kg', gstBps: 500, qtyMilli: 333, taxable: 7_001, igst: 350 },
        { sku: 'HS-BLANK', hsn: null, uom: 'each', gstBps: 1800, qtyMilli: 1_000, taxable: 10_000, igst: 1_800 },
        { sku: 'HS-BAD', hsn: 'HSN 0910', uom: 'each', gstBps: 1800, qtyMilli: 1_000, taxable: 5_001, igst: 900 },
      ],
    });
    // An issued invoice with zero lines still counts.
    await seedInvoice(ids.sepEmpty, { issuedAt: '2026-09-20T00:00:00.000Z', lines: [] });
    // The IST boundary: 23:59:59.999 IST on 30 Sep is September; 00:00 IST on 1 Oct is not.
    await seedInvoice(ids.lastMsSep, { issuedAt: '2026-09-30T18:29:59.999Z', lines: [filler(1_000)] });
    await seedInvoice(ids.firstMsOct, { issuedAt: '2026-09-30T18:30:00.000Z', lines: [filler(2_000)] });
    // Never counted: awaiting, voided, another GSTIN — each inside September.
    await seedInvoice(ids.awaiting, { status: 'awaiting-data', issuedAt: null, lines: [filler(40_000)] });
    await seedInvoice(ids.voided, { status: 'voided', issuedAt: '2026-09-12T00:00:00.000Z', lines: [filler(80_000)] });
    await seedInvoice(ids.otherGstin, { gstin: G27, issuedAt: '2026-09-12T00:00:00.000Z', lines: [filler(160_000)] });
    // FY-2627-Q2 (Jul–Sep) and its lower edge.
    await seedInvoice(ids.july, { issuedAt: '2026-06-30T18:30:00.000Z', lines: [filler(4_000)] });
    await seedInvoice(ids.lastMsJune, { issuedAt: '2026-06-30T18:29:59.999Z', lines: [filler(8_000)] });
    // FY-2627-Q4 (Jan–Mar 2027) across the calendar year, and its upper edge.
    await seedInvoice(ids.jan, { issuedAt: '2026-12-31T18:30:00.000Z', lines: [filler(16_000)] });
    await seedInvoice(ids.lastMsMar, { issuedAt: '2027-03-31T18:29:59.999Z', lines: [filler(32_000)] });
    await seedInvoice(ids.firstMsApr, { issuedAt: '2027-03-31T18:30:00.000Z', lines: [filler(64_000)] });
  }

  function summary(gstin: string, period: string, token = accountantToken) {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices/hsn-summary`)
      .query({ gstin, period })
      .set('Authorization', `Bearer ${token}`);
  }

  async function okSummary(gstin: string, period: string): Promise<HsnSummaryView> {
    const res = await summary(gstin, period).expect(200);
    return res.body.summary as HsnSummaryView;
  }

  /** The row key a reader would scan for. */
  const key = (row: HsnSummaryRow): string => `${row.hsn ?? '∅'}|${row.uqc}|${row.gstBps}`;

  // ── the unit table ─────────────────────────────────────────────────────────

  it('maps EVERY catalog unit to a UQC (completeness over the runtime UOMS tuple) and never invents a code', () => {
    expect(UOMS).toHaveLength(35);
    for (const uom of UOMS) {
      expect(UQCS).toContain(UOM_TO_UQC[uom]);
      expect(uqcFor(uom).uqc).toBe(UOM_TO_UQC[uom]);
    }
    expect(Object.keys(UOM_TO_UQC).sort()).toEqual([...UOMS].sort());
    // Spot-pin the table (no scaling: mm is OTH, never CMS).
    expect([uqcFor('each'), uqcFor('kg'), uqcFor('ml'), uqcFor('mm'), uqcFor('case')]).toEqual([
      { uqc: 'NOS', exact: true },
      { uqc: 'KGS', exact: true },
      { uqc: 'MLT', exact: true },
      { uqc: 'OTH', exact: false },
      { uqc: 'OTH', exact: false },
    ]);
    // A unit outside today's vocabulary (a frozen snapshot can outlive it) — and prototype names.
    expect(uqcFor('furlong')).toEqual({ uqc: 'OTH', exact: false });
    expect(uqcFor('constructor')).toEqual({ uqc: 'OTH', exact: false });
    expect(uqcFor('__proto__')).toEqual({ uqc: 'OTH', exact: false });
  });

  it('classifies HSN validity on the SQL-normalized value: 4, 6 or 8 digits only, no second trim in JS', () => {
    expect(['0910', '091011', '21069099'].map(isValidHsn)).toEqual([true, true, true]);
    // Trimming is SQL's job (`nullif(btrim(hsn), '')`); an untrimmed value
    // reaching here is invalid — the padded ' 091011 ' line in the September
    // fixture proves the SQL side trims it into a valid row.
    expect([null, '', ' 0910 ', '091', '09101', '0910101', '210690991', 'HSN 0910', '09१०'].map(isValidHsn)).toEqual(
      Array(9).fill(false),
    );
  });

  // ── periods ────────────────────────────────────────────────────────────────

  it('parses months and FY quarters into [from, to) at IST midnights — Q4 crosses the calendar year', () => {
    expect(parsePeriod('2026-09')).toEqual({ label: '2026-09', kind: 'month', from: '2026-08-31T18:30:00.000Z', to: '2026-09-30T18:30:00.000Z' });
    expect(parsePeriod('2026-12')).toMatchObject({ from: '2026-11-30T18:30:00.000Z', to: '2026-12-31T18:30:00.000Z' });
    expect(parsePeriod('FY-2627-Q1')).toMatchObject({ kind: 'quarter', from: '2026-03-31T18:30:00.000Z', to: '2026-06-30T18:30:00.000Z' });
    expect(parsePeriod('FY-2627-Q2')).toMatchObject({ from: '2026-06-30T18:30:00.000Z', to: '2026-09-30T18:30:00.000Z' });
    expect(parsePeriod('FY-2627-Q3')).toMatchObject({ from: '2026-09-30T18:30:00.000Z', to: '2026-12-31T18:30:00.000Z' });
    expect(parsePeriod('FY-2627-Q4')).toMatchObject({ from: '2026-12-31T18:30:00.000Z', to: '2027-03-31T18:30:00.000Z' });
    expect(parsePeriod('FY-9900-Q4')).toMatchObject({ from: '2099-12-31T18:30:00.000Z', to: '2100-03-31T18:30:00.000Z' });
  });

  it('refuses a bad period or a missing / malformed gstin with 400 validation-failed', async () => {
    for (const period of ['2026-13', '2026-00', 'FY-2627-Q5', 'FY-2627-Q0', 'FY-2628-Q1', 'FY2627-Q2', '2026-9', 'sep-2026']) {
      const res = await summary(G29, period).expect(400);
      expect(res.body.code).toBe('validation-failed');
    }
    for (const gstin of ['ABC', '2AAAPZ1234C1ZV', '29AAAPZ1234C1Z-']) {
      expect((await summary(gstin, '2026-09').expect(400)).body.code).toBe('validation-failed');
    }
    const noGstin = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices/hsn-summary`)
      .query({ period: '2026-09' })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(400);
    expect(noGstin.body.code).toBe('validation-failed');
    const noPeriod = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices/hsn-summary`)
      .query({ gstin: G29 })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(400);
    expect(noPeriod.body.code).toBe('validation-failed');
  });

  // ── the matrix: one GSTIN, one month ───────────────────────────────────────

  it('one GSTIN, one month: rows per (HSN, UQC, rate), B2B and B2C sections, deterministic order, exact sums', async () => {
    const s = await okSummary(G29, '2026-09');
    expect(s.gstin).toBe(G29);
    expect(s.period).toEqual({ label: '2026-09', kind: 'month', from: '2026-08-31T18:30:00.000Z', to: '2026-09-30T18:30:00.000Z', toExclusive: true });

    // B2B — 0910 at 5% and at 12%: two rows.
    expect(s.b2b.rows).toEqual([
      { hsn: '0910', hsnIssue: false, uqc: 'KGS', sourceUoms: ['kg'], mixedUnits: false, gstBps: 500, qtyMilli: 2_500, lineCount: 1, taxablePaise: 100_000, igstPaise: 0, cgstPaise: 2_500, sgstPaise: 2_500, totalValuePaise: 105_000 },
      { hsn: '0910', hsnIssue: false, uqc: 'KGS', sourceUoms: ['kg'], mixedUnits: false, gstBps: 1200, qtyMilli: 1_000, lineCount: 1, taxablePaise: 50_000, igstPaise: 0, cgstPaise: 3_000, sgstPaise: 3_000, totalValuePaise: 56_000 },
    ]);
    expect(s.b2b.totals).toEqual({ invoiceCount: 1, taxablePaise: 150_000, igstPaise: 0, cgstPaise: 5_500, sgstPaise: 5_500, gstPaise: 11_000, totalValuePaise: 161_000 });

    // B2C — HSN ascending, issue rows LAST; 1006 in kg and bag → KGS / BAG;
    // jar + keg → one OTH row flagged mixed; the boundary-ms filler (0910 kg).
    expect(s.b2c.rows.map(key)).toEqual(['0910|KGS|500', '091011|KGS|500', '1006|BAG|500', '1006|KGS|500', '2201|OTH|1800', '∅|NOS|1800', 'HSN 0910|NOS|1800']);
    const byKey = new Map(s.b2c.rows.map((row) => [key(row), row]));
    expect(byKey.get('2201|OTH|1800')).toMatchObject({ sourceUoms: ['jar', 'keg'], mixedUnits: true, qtyMilli: 3_000, lineCount: 2, taxablePaise: 35_000, igstPaise: 6_300 });
    expect(byKey.get('1006|BAG|500')).toMatchObject({ sourceUoms: ['bag'], mixedUnits: false, qtyMilli: 3_000 });
    expect(byKey.get('091011|KGS|500')).toMatchObject({ hsn: '091011', hsnIssue: false, qtyMilli: 333, taxablePaise: 7_001 });
    expect(byKey.get('0910|KGS|500')).toMatchObject({ taxablePaise: 1_000, igstPaise: 50, lineCount: 1 }); // only the last-ms September invoice
    expect(byKey.get('∅|NOS|1800')).toMatchObject({ hsn: null, hsnIssue: true, taxablePaise: 10_000, igstPaise: 1_800 });
    expect(byKey.get('HSN 0910|NOS|1800')).toMatchObject({ hsnIssue: true, taxablePaise: 5_001, igstPaise: 900, totalValuePaise: 5_901 });
    // sepB2c + sepEmpty + lastMsSep.
    expect(s.b2c.totals.invoiceCount).toBe(3);
    // The issue lines agree with the hsnIssue rows, per section: same value, same line count.
    for (const section of ['b2b', 'b2c'] as const) {
      const issueRows = s[section].rows.filter((r) => r.hsnIssue);
      const lines = s.issueLines.filter((l) => l.section === section);
      expect(lines.reduce((sum, l) => sum + l.valuePaise, 0)).toBe(issueRows.reduce((sum, r) => sum + r.totalValuePaise, 0));
      expect(lines.length).toBe(issueRows.reduce((sum, r) => sum + r.lineCount, 0));
    }
    expect(s.issueLines).toHaveLength(2);
    expect(s.totals.invoiceCount).toBe(4);
  });

  it('reconciles to the paisa: B2B + B2C (issue rows included) equal Σ subtotal_paise and Σ gst_paise of the included invoices', async () => {
    const s = await okSummary(G29, '2026-09');
    // An independent read of the invoice COLUMNS — its own bounds (the +05:30
    // literal), not the code's.
    const [cols] = (await sql`
      select sum(subtotal_paise)::bigint::text as subtotal, sum(gst_paise)::bigint::text as gst, count(*)::int as n
      from invoices
      where tenant_id = ${tenantId} and status = 'issued' and origin_gstin = ${G29}
        and issued_at >= '2026-09-01T00:00:00+05:30' and issued_at < '2026-10-01T00:00:00+05:30'
    `) as unknown as { subtotal: string; gst: string; n: number }[];
    expect(s.issueLines.length).toBeGreaterThan(0);
    expect(s.totals.taxablePaise).toBe(Number(cols!.subtotal));
    expect(s.totals.gstPaise).toBe(Number(cols!.gst));
    expect(s.totals.invoiceCount).toBe(cols!.n);
    expect(s.b2b.totals.taxablePaise + s.b2c.totals.taxablePaise).toBe(s.totals.taxablePaise);
    expect(s.b2b.totals.gstPaise + s.b2c.totals.gstPaise).toBe(s.totals.gstPaise);
    const rowSum = [...s.b2b.rows, ...s.b2c.rows].reduce((acc, r) => acc + r.totalValuePaise, 0);
    expect(rowSum).toBe(Number(cols!.subtotal) + Number(cols!.gst));
    // And the hand-computed figure (so a reconciliation of two wrong reads cannot pass).
    expect(s.totals.taxablePaise).toBe(150_000 + 30_000 + 45_000 + 20_000 + 15_000 + 7_001 + 10_000 + 5_001 + 1_000);
  });

  it('lists the issue lines with the invoice number, SKU, value and the SKU’s CURRENT catalog HSN', async () => {
    const s = await okSummary(G29, '2026-09');
    const [sepB2cNo] = (await sql`select invoice_no from invoices where id = ${ids.sepB2c}`) as unknown as { invoice_no: string }[];
    expect(s.issueLines).toEqual([
      { section: 'b2c', invoiceId: ids.sepB2c, invoiceNo: sepB2cNo!.invoice_no, skuCode: 'HS-BAD', hsn: 'HSN 0910', taxablePaise: 5_001, gstPaise: 900, valuePaise: 5_901, catalogHsn: null },
      { section: 'b2c', invoiceId: ids.sepB2c, invoiceNo: sepB2cNo!.invoice_no, skuCode: 'HS-BLANK', hsn: null, taxablePaise: 10_000, gstPaise: 1_800, valuePaise: 11_800, catalogHsn: '21069099' },
    ]);
  });

  it('the IST boundary: …18:29:59.999Z is September, …18:30:00.000Z is October (upper bound exclusive)', async () => {
    const oct = await okSummary(G29, '2026-10');
    expect(oct.totals).toMatchObject({ invoiceCount: 1, taxablePaise: 2_000 });
    expect(oct.period.from).toBe('2026-09-30T18:30:00.000Z');
  });

  it('a quarter: FY-2627-Q2 covers 1 Jul – 30 Sep IST; FY-2627-Q4 covers 1 Jan – 31 Mar 2027 IST', async () => {
    const q2 = await okSummary(G29, 'FY-2627-Q2');
    // July (4,000) + September's included invoices; June's last ms (8,000) is out.
    const sep = await okSummary(G29, '2026-09');
    expect(q2.totals.taxablePaise).toBe(sep.totals.taxablePaise + 4_000);
    expect(q2.totals.invoiceCount).toBe(sep.totals.invoiceCount + 1);
    const q4 = await okSummary(G29, 'FY-2627-Q4');
    expect(q4.totals).toMatchObject({ invoiceCount: 2, taxablePaise: 16_000 + 32_000 });
    const q1Next = await okSummary(G29, 'FY-2728-Q1');
    expect(q1Next.totals).toMatchObject({ invoiceCount: 1, taxablePaise: 64_000 });
  });

  it('never counts awaiting, voided, or another GSTIN’s invoices', async () => {
    const s = await okSummary(G29, '2026-09');
    // Their fillers (40,000 / 80,000 / 160,000; all B2C) would land in B2C's 0910|KGS|500.
    expect(s.b2c.rows.find((r) => key(r) === '0910|KGS|500')!.taxablePaise).toBe(1_000);
    const other = await okSummary(G27, '2026-09');
    expect(other.totals).toMatchObject({ invoiceCount: 1, taxablePaise: 160_000 });
  });

  it('a well-formed GSTIN with no issued invoices is an empty summary, not a 404', async () => {
    const s = await okSummary('33AAAPZ1234C1ZV', '2026-09');
    expect(s.b2b.rows).toEqual([]);
    expect(s.b2c.rows).toEqual([]);
    expect(s.issueLines).toEqual([]);
    expect(s.totals).toEqual({ invoiceCount: 0, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, gstPaise: 0, totalValuePaise: 0 });
  });

  it('lists every issued GSTIN with its first/last issue instant (the pickers’ period source)', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices/hsn-summary/gstins`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    const items = res.body.items as { gstin: string; firstIssuedAt: string; lastIssuedAt: string; invoiceCount: number }[];
    expect(items.find((i) => i.gstin === G29)).toEqual({
      gstin: G29,
      firstIssuedAt: '2026-06-30T18:29:59.999Z',
      lastIssuedAt: '2027-03-31T18:30:00.000Z',
      invoiceCount: 10,
    });
    expect(items.find((i) => i.gstin === G27)).toMatchObject({ invoiceCount: 1 });
    expect(items.map((i) => i.gstin)).toEqual([...items.map((i) => i.gstin)].sort());
  });

  // ── the write side: both issuance paths ────────────────────────────────────

  it('INSERT path: an invoice issued on first generation stamps issued_at = document.header.issuedAt, and uom on its lines', async () => {
    const { orderId } = await dispatchedOrder('HS-INS', 2, 10_000);
    const snapshot = await command.generate({ tenantId, actorUserId: ownerUserId, orderId }, ulid());
    expect(snapshot.invoice.status).toBe('issued');
    const [row] = (await sql`
      select to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as issued_at, document->'header'->>'issuedAt' as doc_issued_at
      from invoices where tenant_id = ${tenantId} and order_id = ${orderId}
    `) as unknown as { issued_at: string; doc_issued_at: string }[];
    expect(row!.issued_at).toBe(row!.doc_issued_at);
    expect(row!.issued_at).toBe((snapshot.invoice.document.header as { issuedAt: string }).issuedAt);
    const lines = (await sql`select uom from invoice_lines where invoice_id = ${snapshot.invoice.id}`) as unknown as { uom: string }[];
    expect(lines).toEqual([{ uom: 'each' }]);
    // The read model never leaks onto the view, the DTO or the snapshot.
    expect(snapshot.invoice).not.toHaveProperty('issuedAt');
    expect(snapshot.invoice.lines[0]).not.toHaveProperty('uom');
  });

  it('UPDATE path: awaiting → issued keeps issued_at NULL while parked, then stamps it from the document on the flip', async () => {
    const { orderId, orderLineId } = await dispatchedOrder('HS-UPD', 3);
    const parked = await command.generate({ tenantId, actorUserId: ownerUserId, orderId }, ulid());
    expect(parked.invoice.status).toBe('awaiting-data');
    const [before] = (await sql`select issued_at from invoices where tenant_id = ${tenantId} and order_id = ${orderId}`) as unknown as { issued_at: string | null }[];
    expect(before!.issued_at).toBeNull();

    const issued = await command.generate({ tenantId, actorUserId: ownerUserId, orderId, rates: [{ orderLineId, ratePaise: 4_000 }] }, ulid());
    expect(issued.invoice.status).toBe('issued');
    const [after] = (await sql`
      select to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as issued_at, document->'header'->>'issuedAt' as doc_issued_at
      from invoices where tenant_id = ${tenantId} and order_id = ${orderId}
    `) as unknown as { issued_at: string; doc_issued_at: string }[];
    expect(after!.issued_at).toBe(after!.doc_issued_at);
    expect(after!.issued_at).toBe((issued.invoice.document.header as { issuedAt: string }).issuedAt);
    const lines = (await sql`select uom from invoice_lines where invoice_id = ${issued.invoice.id}`) as unknown as { uom: string }[];
    expect(lines).toEqual([{ uom: 'kg' }]);

    // The real invoice surfaces in its own GSTIN's summary for its IST month, B2C.
    const istMonth = new Date(Date.parse(after!.issued_at) + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
    const s = await okSummary(G24, istMonth);
    expect(s.b2c.rows.map(key)).toEqual(expect.arrayContaining(['1006|KGS|500']));
  });

  // ── the route ──────────────────────────────────────────────────────────────

  it('route order: /invoices/hsn-summary is its own route, never captured by /invoices/:invoiceId', async () => {
    // `:invoiceId` would answer 400 "invoiceId must be a uuid" for "hsn-summary".
    const res = await summary(G29, '2026-09').expect(200);
    expect(res.body).toHaveProperty('summary.b2b');
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices/hsn-summary/gstins`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    // …and the detail route still answers for a uuid.
    const missing = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/invoices/${uuidv7()}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(404);
    expect(missing.body.code).toBe('not-found');
    // The declaration order itself (Nest registers routes in method order).
    const proto = Object.getOwnPropertyNames(InvoicingController.prototype);
    expect(proto.indexOf('hsnSummary')).toBeGreaterThan(-1);
    expect(proto.indexOf('hsnSummary')).toBeLessThan(proto.indexOf('getInvoice'));
    expect(proto.indexOf('hsnSummaryGstins')).toBeLessThan(proto.indexOf('getInvoice'));
  });

  it('is open to any member, refuses another tenant’s token and an anonymous call', async () => {
    await summary(G29, '2026-09', ownerToken).expect(200);
    await summary(G29, '2026-09', opsToken).expect(200);
    await summary(G29, '2026-09', operatorWebToken).expect(200);
    await request(app.getHttpServer()).get(`${API}/${tenantId}/invoices/hsn-summary`).query({ gstin: G29, period: '2026-09' }).expect(401);
    const res = await request(app.getHttpServer())
      .get(`${API}/${uuidv7()}/invoices/hsn-summary`)
      .query({ gstin: G29, period: '2026-09' })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(403);
    expect(res.body.code).toBe('permission-denied');
  });

  it('the committed OpenAPI document lists both routes', () => {
    const committed = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8') as string) as { paths: Record<string, unknown> };
    expect(Object.keys(committed.paths)).toEqual(
      expect.arrayContaining(['/tenants/{tenantId}/invoices/hsn-summary', '/tenants/{tenantId}/invoices/hsn-summary/gstins']),
    );
  });
});
