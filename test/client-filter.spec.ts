import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PostgresJsSession } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { createLinkedVendor } from './support/linked-vendor';
import { dispatchedOrderFixtures } from './support/dispatched-order';

// Story 1-5a — the staff client filter: an optional `clientId` on every staff
// list and on the stock and ledger reads, filtered in SQL inside the tenant
// transaction and BEFORE the page limit.
//
// One canonical route table drives the tests: for every filtered route, a
// row of client GLOW and a row of the tenant's own (self) client exist, and
// the filtered page must hold EXACTLY GLOW's rows (an ignored parameter fails:
// the self row would show). Derived fact rows (a breach, an alert, a variance,
// a refusal, a pack failure, a QC hold, an over-receipt, a manifest, a
// transfer, an invoice, an e-way bill, an RMA) are raw-inserted — the subject
// is the READ predicate, not the writer.
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
const GSTIN = '29AAAPZ1234C1ZV';

type Item = Record<string, unknown>;

/** One filtered route of the canonical table. */
interface RouteCase {
  /** The path after `/tenants/{t}`. */
  readonly path: string;
  /** Extra query (the route's required filters; never `clientId`). */
  readonly query?: Record<string, string | number>;
  /** False for an unpaginated read (no `limit` accepted). */
  readonly paged?: boolean;
  /** The id key of an item. */
  readonly idKey?: string;
  /** Does an UNFILTERED item belong to the given client? (decided client-side, independent of the server predicate) */
  readonly belongs: (item: Item, client: 'glow' | 'self') => boolean;
  /** A GLOW row that must be listed under GLOW. */
  readonly glowRow: () => string;
  /** A self row that must NOT be listed under GLOW. */
  readonly selfRow: () => string;
}

describe('story 1-5a: the staff client filter (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let operatorToken: string;
  let wh: string;
  let binId: string;
  let selfClient: string;
  let glow: string;
  let dept: string;
  let foreignClient: string;
  let portalToken: string;
  const skuIds = new Map<string, string>();
  const glowSkus = new Set<string>();
  const selfSkus = new Set<string>();

  // The seeded documents.
  let productGlow: string;
  let productSelf: string;
  let poGlowOpen: string;
  let poGlowClosed: string;
  let poSelf: string;
  let grnGlow: { id: string; lineId: string };
  let grnSelf: { id: string; lineId: string };
  let grnLegacy: string;
  let grnSelfLate: string;
  let gA: string;
  let gB: string;
  let s1: string;
  let s2: string;
  let s3: string;
  let waveMixed: string;
  let waveSelf: string;
  let manifestMixed: string;
  let manifestSelf: string;
  let transferMixed: string;
  let transferSelf: string;
  let invoiceGlow: string;
  let invoiceSelf: string;
  const raw = new Map<string, { glow: string; self: string }>();

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({
    app,
    tenantId,
    warehouseId: wh,
    opsToken: ownerToken,
    ownerToken,
    operatorToken,
  }));
  const sku = (code: string): string => {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  };
  const rawRow = (kind: string): { glow: string; self: string } => {
    const row = raw.get(kind);
    if (row === undefined) throw new Error(`unknown raw row ${kind}`);
    return row;
  };
  const now = (): string => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('client_filter');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Filter Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;

    // A second tenant — its client id is "another tenant's" (an empty page, never a 404).
    const foreignEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const foreign = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Foreign Co ${ulid()}`, ownerEmail: foreignEmail, password: 'correct-horse-battery' })
      .expect(201);
    foreignClient = (
      (await sql`select id from clients where tenant_id = ${foreign.body.tenant.id as string}`) as unknown as { id: string }[]
    )[0]!.id;

    wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `CF-${ulid().slice(20)}`, name: 'Filter WH' })
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
    binId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code: 'A-01' })
        .expect(201)
    ).body.id as string;

    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    glow = await createClient('GLOW', 'GlowCo');
    dept = await createClient('DEPT', 'Departed Co');
    const vendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: 'V-CF', name: 'Filter Vendor' });

    await importCsv(['S-1,Self one,pcs,1800,,,', 'S-COMP,Self comp,pcs,1800,,,', 'S-KIT,Self kit,pcs,1800,,,S-COMP:1'], selfClient);
    await importCsv(['G-1,Glow one,pcs,1800,,,', 'G-COMP,Glow comp,pcs,1800,,,', 'G-KIT,Glow kit,pcs,1800,,,G-COMP:1'], glow);
    await importCsv(['D-1,Departed one,pcs,1800,,,'], dept);
    const rows = (await sql`select id, code, client_id from skus where tenant_id = ${tenantId}`) as unknown as {
      id: string;
      code: string;
      client_id: string;
    }[];
    for (const row of rows) {
      skuIds.set(row.code, row.id);
      if (row.client_id === glow) glowSkus.add(row.id);
      if (row.client_id === selfClient) selfSkus.add(row.id);
    }

    productGlow = await createProduct('Glow Tee', glow);
    productSelf = await createProduct('Self Tee', selfClient);

    // Stock (ledger events + on-hand rows of both clients in ONE bin).
    await adjust(sku('G-1'), 100);
    await adjust(sku('S-1'), 100);

    // The floor device (receipts and placements are device work).
    const operatorEmail = await createMember('operator');
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'CF dock', pin: '2468' })
      .expect(201);
    operatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    // POs: GLOW open + GLOW closed + self open.
    poGlowOpen = await createPo(vendorId, sku('G-1'));
    poGlowClosed = await createPo(vendorId, sku('G-1'));
    poSelf = await createPo(vendorId, sku('S-1'));
    await sql`update purchase_orders set status = 'closed' where id = ${poGlowClosed}`;

    // Receipts. The legacy mixed GRN: a self receipt that also holds a GLOW
    // line and lost its client (the pre-1-1 shape the backfill could leave).
    grnGlow = await blindReceipt(sku('G-1'), 5);
    grnSelf = await blindReceipt(sku('S-1'), 5);
    grnLegacy = (await blindReceipt(sku('S-1'), 1)).id;
    const donor = await blindReceipt(sku('G-1'), 1);
    await sql`update goods_receipt_lines set grn_id = ${grnLegacy} where grn_id = ${donor.id}`;
    await sql`update goods_receipt_notes set client_id = null where id = ${grnLegacy}`;
    await sql`delete from goods_receipt_notes where id = ${donor.id}`;
    // A self receipt NEWER than the legacy one (the legacy arm's beyond-page-1 row).
    grnSelfLate = (await blindReceipt(sku('S-1'), 1)).id;
    // One unit of each client's receipt placed (the placements list); the rest stays putaway work.
    await place(grnGlow, sku('G-1'));
    await place(grnSelf, sku('S-1'));

    // Orders — GLOW's two are OLDER than a full first page of self orders.
    gA = await fixtures.createOrder([{ skuId: sku('G-1'), quantity: 1 }]);
    gB = await fixtures.createOrder([{ skuId: sku('G-1'), quantity: 1 }]);
    s1 = await fixtures.createOrder([{ skuId: sku('S-1'), quantity: 1 }]);
    s2 = await fixtures.createOrder([{ skuId: sku('S-1'), quantity: 1 }]);
    s3 = await fixtures.createOrder([{ skuId: sku('S-1'), quantity: 1 }]);

    // Waves: one mixed (a GLOW and a self order), one self-only.
    const policyId = (
      await http()
        .post(`${API}/${tenantId}/outbound/wave-policies`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, name: 'cf-single', grouping: 'single' })
        .expect(201)
    ).body.policy.id as string;
    waveMixed = await generateWave(policyId, [gA, s1]);
    waveSelf = await generateWave(policyId, [s2]);

    // ── raw-inserted derived rows (the read predicate is the subject) ──────
    // Manifests: one mixed (GLOW + self shipments), one self-only.
    const connection = uuidv7();
    manifestMixed = await insert('manifests', manifestRow(connection, 2));
    manifestSelf = await insert('manifests', manifestRow(connection, 1));
    await insert('shipments', shipmentRow(gA, connection, manifestMixed));
    await insert('shipments', shipmentRow(s1, connection, manifestMixed));
    await insert('shipments', shipmentRow(s2, connection, manifestSelf));
    // Transfers: one mixed (a GLOW and a self line), one self-only.
    transferMixed = await insert('transfer_orders', { tenant_id: tenantId, source_warehouse_id: wh, dest_warehouse_id: wh, created_by: ownerUserId });
    transferSelf = await insert('transfer_orders', { tenant_id: tenantId, source_warehouse_id: wh, dest_warehouse_id: wh, created_by: ownerUserId });
    await insert('transfer_order_lines', transferLine(transferMixed, sku('G-1')));
    await insert('transfer_order_lines', transferLine(transferMixed, sku('S-1')));
    await insert('transfer_order_lines', transferLine(transferSelf, sku('S-1')));
    // Invoices (one order each) and their e-way bills.
    invoiceGlow = await insert('invoices', invoiceRow(gA));
    invoiceSelf = await insert('invoices', invoiceRow(s1));
    raw.set('eway', { glow: await insert('eway_bills', ewayRow(invoiceGlow)), self: await insert('eway_bills', ewayRow(invoiceSelf)) });
    raw.set('rma', {
      glow: await insert('return_authorizations', rmaRow(gA, glow, 'RMA-G')),
      self: await insert('return_authorizations', rmaRow(s1, selfClient, 'RMA-S')),
    });
    raw.set('pack-failure', {
      glow: await insert('pack_verification_failures', packFailureRow(gA)),
      self: await insert('pack_verification_failures', packFailureRow(s1)),
    });
    raw.set('refusal', {
      glow: await insert('ingest_backorder_refusals', refusalRow(sku('G-1'))),
      self: await insert('ingest_backorder_refusals', refusalRow(sku('S-1'))),
    });
    // Manual QC holds — no GRN line, matched through the held SKU.
    raw.set('qc-hold', {
      glow: await insert('qc_holds', qcHoldRow(sku('G-1'))),
      self: await insert('qc_holds', qcHoldRow(sku('S-1'))),
    });
    raw.set('over-receipt', {
      glow: await insert('over_receipts', overReceiptRow(grnGlow, sku('G-1'), poGlowOpen)),
      self: await insert('over_receipts', overReceiptRow(grnSelf, sku('S-1'), poSelf)),
    });
    raw.set('adjustment-pending', {
      glow: await insert('stock_adjustment_pendings', pendingRow(sku('G-1'))),
      self: await insert('stock_adjustment_pendings', pendingRow(sku('S-1'))),
    });
    raw.set('variance', {
      glow: await insert('count_variances', varianceRow(sku('G-1'))),
      self: await insert('count_variances', varianceRow(sku('S-1'))),
    });
    raw.set('policy', {
      glow: await insert('reorder_policies', { tenant_id: tenantId, warehouse_id: wh, sku_id: sku('G-1'), reorder_point_milli: 1000, reorder_qty_milli: 1000 }),
      self: await insert('reorder_policies', { tenant_id: tenantId, warehouse_id: wh, sku_id: sku('S-1'), reorder_point_milli: 1000, reorder_qty_milli: 1000 }),
    });
    const breachGlow = await insert('reorder_breaches', { tenant_id: tenantId, warehouse_id: wh, sku_id: sku('G-1'), point_milli: 1000, atp_milli: 0 });
    const breachSelf = await insert('reorder_breaches', { tenant_id: tenantId, warehouse_id: wh, sku_id: sku('S-1'), point_milli: 1000, atp_milli: 0 });
    raw.set('breach', { glow: breachGlow, self: breachSelf });
    raw.set('suggested-po', {
      glow: await insert('suggested_pos', { tenant_id: tenantId, warehouse_id: wh, sku_id: sku('G-1'), breach_id: breachGlow, quantity_milli: 1000 }),
      self: await insert('suggested_pos', { tenant_id: tenantId, warehouse_id: wh, sku_id: sku('S-1'), breach_id: breachSelf, quantity_milli: 1000 }),
    });
    raw.set('batch-alert', {
      glow: await insert('batch_alerts', { tenant_id: tenantId, warehouse_id: wh, sku_id: sku('G-1'), batch_id: uuidv7(), kind: 'aged' }),
      self: await insert('batch_alerts', { tenant_id: tenantId, warehouse_id: wh, sku_id: sku('S-1'), batch_id: uuidv7(), kind: 'aged' }),
    });

    // A GLOW client-portal user (the operator fence answers it first).
    const portalEmail = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: portalEmail, role: 'client', clientId: glow })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    portalToken = (await mintSignIn(app, { email: portalEmail, password: 'correct-horse-battery' })).body.accessToken as string;

    // The departed client: some history (in and out again), then departure.
    await adjust(sku('D-1'), 2);
    await adjust(sku('D-1'), -2);
    await http()
      .patch(`${API}/${tenantId}/clients/${dept}/status`)
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

  // ── fixtures ───────────────────────────────────────────────────────────────

  async function createClient(code: string, name: string): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/clients`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code, name })
      .expect(201);
    return res.body.client.id as string;
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,hsn,barcode,kit_components', ...rows].join('\n');
    const res = await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    expect(res.body).toMatchObject({ committedRows: rows.length, failedRows: 0 });
  }

  async function createProduct(name: string, clientId: string): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/catalog/products`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ name, axes: ['size'], clientId })
      .expect(201);
    return res.body.id as string;
  }

  async function createMember(role: string): Promise<string> {
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
    return email;
  }

  async function adjust(skuId: string, quantityDelta: number): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, skuId, binId, quantityDelta, reasonCode: 'stock-count', note: 'client-filter seed' })
      .expect(201);
  }

  async function createPo(vendorId: string, skuId: string): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, vendorId, code: `PO-${ulid().slice(14)}`, lines: [{ skuId, orderedQty: 10, unitCostPaise: 100 }] })
      .expect(201);
    return res.body.purchaseOrder.id as string;
  }

  async function blindReceipt(skuId: string, qty: number): Promise<{ id: string; lineId: string }> {
    const res = await http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: wh,
        poId: null,
        blindReasonCode: 'unannounced-delivery',
        occurredAt: now(),
        lines: [{ poLineId: null, skuId, batchCode: null, mfgDate: null, qty }],
      })
      .expect(201);
    const grn = res.body.goodsReceipt as { id: string; lines: { id: string }[] };
    return { id: grn.id, lineId: grn.lines[0]!.id };
  }

  async function place(grn: { id: string; lineId: string }, skuId: string): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/putaway/placements`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, grnId: grn.id, grnLineId: grn.lineId, skuId, batchId: null, qty: 1, toBinId: binId, reasonCode: null, occurredAt: now() })
      .expect(201);
  }

  async function generateWave(policyId: string, orderIds: string[]): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, policyId, orderIds })
      .expect(201);
    return res.body.wave.id as string;
  }

  /** A raw insert of only the given columns (the rest take their defaults); answers the id. */
  async function insert(table: string, row: Record<string, unknown>): Promise<string> {
    const withId = { id: uuidv7(), ...row };
    await sql`insert into ${sql(table)} ${sql(withId as Record<string, postgres.SerializableParameter>)}`;
    return withId.id;
  }

  function manifestRow(connection: string, count: number): Record<string, unknown> {
    return { tenant_id: tenantId, warehouse_id: wh, carrier_connection_id: connection, carrier_code: 'TEST', shipment_count: count, created_by: ownerUserId };
  }

  function shipmentRow(orderId: string, connection: string, manifestId: string): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      warehouse_id: wh,
      order_id: orderId,
      carrier_connection_id: connection,
      carrier_code: 'TEST',
      carrier_name: 'Test Carrier',
      tracking_number: `TRK-${ulid()}`,
      label_document_ref: `label-${ulid()}`,
      labelled_by: ownerUserId,
      labelled_at: new Date().toISOString(),
      status: 'manifested',
      manifest_id: manifestId,
    };
  }

  function transferLine(transferId: string, skuId: string): Record<string, unknown> {
    return { tenant_id: tenantId, transfer_id: transferId, sku_id: skuId, quantity_milli: 1000, from_bin_id: binId, to_bin_id: binId };
  }

  function invoiceRow(orderId: string): Record<string, unknown> {
    return { tenant_id: tenantId, order_id: orderId, warehouse_id: wh, document: sql.json({ gaps: [] }), payable_paise: 0, round_off_paise: 0, status: 'awaiting-data' };
  }

  function ewayRow(invoiceId: string): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      invoice_id: invoiceId,
      origin_gstin: GSTIN,
      consignment_value_paise: 6_000_000,
      threshold_paise: 5_000_000,
      threshold_rule: 'national',
      status: 'dismissed',
      dismissed_reason: 'client-filter fixture',
    };
  }

  function rmaRow(orderId: string, clientId: string, code: string): Record<string, unknown> {
    return { tenant_id: tenantId, client_id: clientId, warehouse_id: wh, order_id: orderId, code, order_dispatched_at: new Date().toISOString(), created_by: ownerUserId };
  }

  function packFailureRow(orderId: string): Record<string, unknown> {
    return { tenant_id: tenantId, warehouse_id: wh, order_id: orderId, entry: 'tenant', actor_user_id: ownerUserId, mismatch: sql.json([]) };
  }

  function refusalRow(skuId: string): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      warehouse_id: wh,
      integration_id: uuidv7(),
      external_event_id: `ev-${ulid()}`,
      lines: sql.json([{ skuId, requestedMilli: 1000, availableMilli: 0 }]),
    };
  }

  function qcHoldRow(skuId: string): Record<string, unknown> {
    return { tenant_id: tenantId, warehouse_id: wh, sku_id: skuId, bin_id: binId, reason: 'client-filter fixture', held_by: ownerUserId, held_at: new Date().toISOString(), kind: 'manual' };
  }

  function overReceiptRow(grn: { id: string; lineId: string }, skuId: string, poId: string): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      warehouse_id: wh,
      grn_id: grn.id,
      grn_line_id: grn.lineId,
      po_id: poId,
      sku_id: skuId,
      excess_qty: 1000,
      requested_by: ownerUserId,
      requested_at: new Date().toISOString(),
    };
  }

  function pendingRow(skuId: string): Record<string, unknown> {
    const at = new Date().toISOString();
    return {
      tenant_id: tenantId,
      warehouse_id: wh,
      bin_id: binId,
      sku_id: skuId,
      quantity_milli: 1000,
      reason_code: 'damaged',
      note: 'client-filter fixture',
      occurred_at: at,
      requested_by: ownerUserId,
      requested_at: at,
      threshold_quantity_at_request: 0,
    };
  }

  function varianceRow(skuId: string): Record<string, unknown> {
    return { tenant_id: tenantId, task_id: uuidv7(), warehouse_id: wh, bin_id: binId, sku_id: skuId, expected_quantity_milli: 1000, counted_quantity_milli: 0, delta_milli: -1000 };
  }

  function list(path: string, query: Record<string, string | number> = {}, token = ownerToken): request.Test {
    return http().get(`${API}/${tenantId}${path}`).query(query).set('Authorization', `Bearer ${token}`);
  }

  // ── the canonical route table ─────────────────────────────────────────────

  const whPath = (rest: string) => () => `/warehouses/${wh}${rest}`;
  const ofSku = (item: Item, client: 'glow' | 'self') => (client === 'glow' ? glowSkus : selfSkus).has(item.skuId as string);
  const ofClient = (item: Item, client: 'glow' | 'self') => item.clientId === (client === 'glow' ? glow : selfClient);
  const ofOrder = (item: Item, client: 'glow' | 'self') => (client === 'glow' ? [gA, gB] : [s1, s2, s3]).includes(item.orderId as string);
  const fixed = (glowIds: () => string[], selfIds: () => string[]) => (item: Item, client: 'glow' | 'self') =>
    (client === 'glow' ? glowIds() : selfIds()).includes(item.id as string);

  const ROUTES: Record<string, Omit<RouteCase, 'path'> & { path: () => string }> = {
    'purchase orders': { path: whPath('/inbound/purchase-orders'), belongs: ofClient, glowRow: () => poGlowOpen, selfRow: () => poSelf },
    'goods receipts (legacy mixed GRN under both)': {
      path: () => '/receiving/goods-receipts',
      // A receipt with no client of its own belongs to every client of its lines.
      belongs: (item, client) => item.id === grnLegacy || ofClient(item, client),
      glowRow: () => grnGlow.id,
      selfRow: () => grnSelf.id,
    },
    'over-receipts': { path: () => '/receiving/over-receipts', belongs: ofSku, glowRow: () => rawRow('over-receipt').glow, selfRow: () => rawRow('over-receipt').self },
    'QC holds (manual, no GRN)': { path: () => '/receiving/qc-holds', belongs: ofSku, glowRow: () => rawRow('qc-hold').glow, selfRow: () => rawRow('qc-hold').self },
    'putaway tasks': {
      path: () => '/putaway/tasks',
      query: { warehouseId: '' },
      paged: false,
      idKey: 'grnLineId',
      belongs: ofSku,
      glowRow: () => grnGlow.lineId,
      selfRow: () => grnSelf.lineId,
    },
    'putaway placements': { path: () => '/putaway/placements', belongs: ofSku, glowRow: () => '', selfRow: () => '' },
    orders: { path: whPath('/outbound/orders'), belongs: ofClient, glowRow: () => gA, selfRow: () => s3 },
    'picklist lines': { path: whPath('/outbound/picklist-lines'), belongs: ofOrder, glowRow: () => '', selfRow: () => '' },
    'pack failures': { path: whPath('/outbound/pack-failures'), belongs: ofOrder, glowRow: () => rawRow('pack-failure').glow, selfRow: () => rawRow('pack-failure').self },
    'backorder refusals': {
      path: whPath('/outbound/backorder-refusals'),
      belongs: (item, client) => (item.lines as { skuId: string }[]).some((line) => ofSku(line, client)),
      glowRow: () => rawRow('refusal').glow,
      selfRow: () => rawRow('refusal').self,
    },
    'manifests (mixed under both)': {
      path: whPath('/outbound/manifests'),
      belongs: fixed(() => [manifestMixed], () => [manifestMixed, manifestSelf]),
      glowRow: () => manifestMixed,
      selfRow: () => manifestSelf,
    },
    'waves (mixed under both)': {
      path: whPath('/outbound/waves'),
      belongs: fixed(() => [waveMixed], () => [waveMixed, waveSelf]),
      glowRow: () => waveMixed,
      selfRow: () => waveSelf,
    },
    returns: { path: () => '/returns', belongs: ofClient, glowRow: () => rawRow('rma').glow, selfRow: () => rawRow('rma').self },
    stock: { path: whPath('/inventory/stock'), belongs: ofSku, glowRow: () => '', selfRow: () => '' },
    'stock (by location)': { path: whPath('/inventory/stock'), query: { order: 'location' }, belongs: ofSku, glowRow: () => '', selfRow: () => '' },
    'ledger events': { path: whPath('/inventory/events'), belongs: ofSku, glowRow: () => '', selfRow: () => '' },
    'adjustment pendings': {
      path: () => '/inventory/adjustment-pendings',
      belongs: ofSku,
      glowRow: () => rawRow('adjustment-pending').glow,
      selfRow: () => rawRow('adjustment-pending').self,
    },
    'count variances': { path: () => '/movements/variances', belongs: ofSku, glowRow: () => rawRow('variance').glow, selfRow: () => rawRow('variance').self },
    'transfers (mixed under both)': {
      path: () => '/movements/transfers',
      belongs: fixed(() => [transferMixed], () => [transferMixed, transferSelf]),
      glowRow: () => transferMixed,
      selfRow: () => transferSelf,
    },
    'reorder policies': { path: () => '/replenishment/policies', belongs: ofSku, glowRow: () => rawRow('policy').glow, selfRow: () => rawRow('policy').self },
    breaches: { path: () => '/replenishment/breaches', belongs: ofSku, glowRow: () => rawRow('breach').glow, selfRow: () => rawRow('breach').self },
    'suggested POs': { path: () => '/replenishment/suggested-pos', belongs: ofSku, glowRow: () => rawRow('suggested-po').glow, selfRow: () => rawRow('suggested-po').self },
    'batch alerts': { path: () => '/replenishment/batch-alerts', belongs: ofSku, glowRow: () => rawRow('batch-alert').glow, selfRow: () => rawRow('batch-alert').self },
    invoices: { path: () => '/invoices', belongs: ofOrder, glowRow: () => invoiceGlow, selfRow: () => invoiceSelf },
    'e-way bills': {
      path: () => '/eway/bills',
      belongs: fixed(() => [rawRow('eway').glow], () => [rawRow('eway').self]),
      glowRow: () => rawRow('eway').glow,
      selfRow: () => rawRow('eway').self,
    },
    SKUs: { path: () => '/catalog/skus', belongs: ofClient, glowRow: () => sku('G-1'), selfRow: () => sku('S-1') },
    products: { path: () => '/catalog/products', belongs: ofClient, glowRow: () => productGlow, selfRow: () => productSelf },
    kits: {
      path: () => '/catalog/kits',
      idKey: 'skuId',
      belongs: (item, client) => ofSku(item, client),
      glowRow: () => sku('G-KIT'),
      selfRow: () => sku('S-KIT'),
    },
  };
  const ROUTE_NAMES = Object.keys(ROUTES);

  function routeQuery(name: string): Record<string, string | number> {
    const route = ROUTES[name]!;
    const query: Record<string, string | number> = { ...(route.query ?? {}) };
    if (name === 'putaway tasks') query.warehouseId = wh;
    if (route.paged !== false) query.limit = 50;
    return query;
  }

  async function idsOf(name: string, extra: Record<string, string | number> = {}): Promise<{ ids: string[]; items: Item[] }> {
    const route = ROUTES[name]!;
    const res = await list(route.path(), { ...routeQuery(name), ...extra }).expect(200);
    const items = res.body.items as Item[];
    // The fixture is small enough that one page holds every row. These exact
    // sets therefore prove WHICH rows match, not that the filter runs before
    // the limit — the limit-bounded "beyond page 1" tests below prove that,
    // one per predicate shape.
    expect(res.body.nextCursor ?? null).toBeNull();
    return { ids: items.map((item) => item[route.idKey ?? 'id'] as string), items };
  }

  const sorted = (ids: readonly string[]) => [...ids].sort();

  describe('the route table: each filtered page holds exactly the client’s rows', () => {
    it.each(ROUTE_NAMES)('%s', async (name) => {
      const route = ROUTES[name]!;
      const all = await idsOf(name);
      const idKey = route.idKey ?? 'id';
      const expectGlow = all.items.filter((item) => route.belongs(item, 'glow')).map((item) => item[idKey] as string);
      const expectSelf = all.items.filter((item) => route.belongs(item, 'self')).map((item) => item[idKey] as string);
      // Both clients have rows, and some unfiltered row is NOT GLOW's (so an ignored parameter fails).
      expect(expectGlow.length).toBeGreaterThan(0);
      expect(expectSelf.length).toBeGreaterThan(0);
      expect(all.ids.some((id) => !expectGlow.includes(id))).toBe(true);
      if (route.glowRow() !== '') {
        expect(expectGlow).toContain(route.glowRow());
        expect(expectGlow).not.toContain(route.selfRow());
        expect(all.ids).toContain(route.selfRow());
      }

      const filteredGlow = await idsOf(name, { clientId: glow });
      expect(sorted(filteredGlow.ids)).toEqual(sorted(expectGlow));
      // The filter keeps the list's own order (newest first, or the location walk).
      expect(filteredGlow.ids).toEqual(all.ids.filter((id) => expectGlow.includes(id)));
      const filteredSelf = await idsOf(name, { clientId: selfClient });
      expect(sorted(filteredSelf.ids)).toEqual(sorted(expectSelf));
    });
  });

  describe('every filtered route: unknown, another tenant’s and malformed client ids', () => {
    it.each(ROUTE_NAMES)('%s', async (name) => {
      const route = ROUTES[name]!;
      for (const clientId of [uuidv7(), foreignClient]) {
        const res = await list(route.path(), { ...routeQuery(name), clientId }).expect(200);
        expect(res.body.items).toEqual([]);
        expect(res.body.nextCursor ?? null).toBeNull();
      }
      const bad = await list(route.path(), { ...routeQuery(name), clientId: 'abc' }).expect(400);
      expect(bad.body.code).toBe('validation-failed');
      expect(JSON.stringify(bad.body)).toContain('clientId');
    });
  });

  // ── the backend matrix rows ───────────────────────────────────────────────

  it('beyond page 1: with limit=2 the first filtered page holds the two OLDER GLOW orders', async () => {
    const unfiltered = await list(`/warehouses/${wh}/outbound/orders`, { limit: 2 }).expect(200);
    expect((unfiltered.body.items as Item[]).map((item) => item.id)).toEqual([s3, s2]);
    const filtered = await list(`/warehouses/${wh}/outbound/orders`, { limit: 2, clientId: glow }).expect(200);
    expect((filtered.body.items as Item[]).map((item) => item.id)).toEqual([gB, gA]);
    expect(filtered.body.nextCursor).toBeNull();
    // A filtered page walks its own keyset: limit 1 pages gB, then gA, then ends.
    const first = await list(`/warehouses/${wh}/outbound/orders`, { limit: 1, clientId: glow }).expect(200);
    expect((first.body.items as Item[]).map((item) => item.id)).toEqual([gB]);
    const second = await list(`/warehouses/${wh}/outbound/orders`, { limit: 1, clientId: glow, cursor: first.body.nextCursor as string }).expect(200);
    expect((second.body.items as Item[]).map((item) => item.id)).toEqual([gA]);
    expect(second.body.nextCursor).toBeNull();
  });

  describe('filter before the limit: the target client’s rows are OLDER than a full first page of the other’s', () => {
    /** The first page unfiltered is the other client's; the filtered pages walk exactly `expected`, then end. */
    async function walk(path: string, expected: string[], unfilteredFirst: string, extra: Record<string, string> = {}): Promise<void> {
      const unfiltered = await list(path, { ...extra, limit: 1 }).expect(200);
      expect((unfiltered.body.items as Item[]).map((item) => item.id)).toEqual([unfilteredFirst]);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await list(path, { ...extra, limit: 1, clientId: glow, ...(cursor === null ? {} : { cursor }) }).expect(200);
        const page = (res.body.items as Item[]).map((item) => item.id as string);
        expect(page).toHaveLength(1);
        seen.push(...page);
        cursor = res.body.nextCursor as string | null;
      } while (cursor !== null && seen.length <= expected.length);
      expect(seen).toEqual(expected);
      expect(cursor).toBeNull();
    }

    it('through the SKU (count variances)', async () => {
      await walk('/movements/variances', [rawRow('variance').glow], rawRow('variance').self);
    });

    it('any order of the client (waves)', async () => {
      await walk(`/warehouses/${wh}/outbound/waves`, [waveMixed], waveSelf);
    });

    it('the one order of the client (invoices)', async () => {
      await walk('/invoices', [invoiceGlow], invoiceSelf);
    });

    it('the refusal’s stored lines (backorder refusals, jsonb)', async () => {
      await walk(`/warehouses/${wh}/outbound/backorder-refusals`, [rawRow('refusal').glow], rawRow('refusal').self);
    });

    it('the legacy null-client GRN arm, tenant-wide and warehouse-scoped (then the own-client arm on page 2)', async () => {
      await walk('/receiving/goods-receipts', [grnLegacy, grnGlow.id], grnSelfLate);
      await walk('/receiving/goods-receipts', [grnLegacy, grnGlow.id], grnSelfLate, { warehouseId: wh });
    });
  });

  it('stock through the SKU: both clients’ stock in ONE bin, both orders — only GLOW’s SKUs’ rows', async () => {
    for (const order of [{}, { order: 'location' }]) {
      const res = await list(`/warehouses/${wh}/inventory/stock`, { ...order, limit: 50, clientId: glow }).expect(200);
      const rows = res.body.items as { skuId: string; binId: string }[];
      expect(rows.some((row) => row.binId === binId)).toBe(true);
      expect(rows.every((row) => glowSkus.has(row.skuId))).toBe(true);
      const all = await list(`/warehouses/${wh}/inventory/stock`, { ...order, limit: 50 }).expect(200);
      expect((all.body.items as { skuId: string; binId: string }[]).some((row) => row.binId === binId && selfSkus.has(row.skuId))).toBe(true);
    }
  });

  it('ledger: only GLOW’s events (the event’s own client)', async () => {
    const res = await list(`/warehouses/${wh}/inventory/events`, { limit: 200, clientId: glow }).expect(200);
    const events = res.body.items as { skuId: string; type: string }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => glowSkus.has(event.skuId))).toBe(true);
    const stored = (await sql`select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and warehouse_id = ${wh} and client_id = ${glow}`) as unknown as { n: number }[];
    expect(events).toHaveLength(stored[0]!.n);
  });

  it('a mixed wave, manifest and transfer appear under both clients; the legacy mixed GRN under both', async () => {
    for (const client of [glow, selfClient]) {
      expect((await idsOf('waves (mixed under both)', { clientId: client })).ids).toContain(waveMixed);
      expect((await idsOf('manifests (mixed under both)', { clientId: client })).ids).toContain(manifestMixed);
      expect((await idsOf('transfers (mixed under both)', { clientId: client })).ids).toContain(transferMixed);
      expect((await idsOf('goods receipts (legacy mixed GRN under both)', { clientId: client })).ids).toContain(grnLegacy);
    }
    // The self-only rows stay out of GLOW's lists.
    expect((await idsOf('waves (mixed under both)', { clientId: glow })).ids).not.toContain(waveSelf);
    expect((await idsOf('manifests (mixed under both)', { clientId: glow })).ids).not.toContain(manifestSelf);
    expect((await idsOf('transfers (mixed under both)', { clientId: glow })).ids).not.toContain(transferSelf);
    // The legacy GRN really has no client of its own (it matches through its lines).
    const legacy = (await sql`select client_id from goods_receipt_notes where id = ${grnLegacy}`) as unknown as { client_id: string | null }[];
    expect(legacy[0]!.client_id).toBeNull();
    // ... and a warehouse-filtered GRN list composes with it.
    const scoped = await list('/receiving/goods-receipts', { warehouseId: wh, clientId: glow, limit: 50 }).expect(200);
    expect(sorted((scoped.body.items as Item[]).map((item) => item.id as string))).toEqual(sorted([grnGlow.id, grnLegacy]));
  });

  it('a manual QC hold (no GRN) appears under its SKU’s client', async () => {
    const res = await list('/receiving/qc-holds', { clientId: glow, limit: 50 }).expect(200);
    const holds = res.body.items as { id: string; kind?: string; grnId?: string | null }[];
    expect(holds.map((hold) => hold.id)).toEqual([rawRow('qc-hold').glow]);
  });

  it('a backorder refusal (no order) appears under the client of its lines’ SKUs', async () => {
    const res = await list(`/warehouses/${wh}/outbound/backorder-refusals`, { clientId: glow, limit: 50 }).expect(200);
    expect((res.body.items as Item[]).map((item) => item.id)).toEqual([rawRow('refusal').glow]);
  });

  it('composes with the list’s own filters: ?status=open&clientId=GLOW lists open GLOW POs only', async () => {
    const res = await list(`/warehouses/${wh}/inbound/purchase-orders`, { status: 'open', clientId: glow, limit: 50 }).expect(200);
    expect((res.body.items as Item[]).map((item) => item.id)).toEqual([poGlowOpen]);
    const closed = await list(`/warehouses/${wh}/inbound/purchase-orders`, { status: 'closed', clientId: glow, limit: 50 }).expect(200);
    expect((closed.body.items as Item[]).map((item) => item.id)).toEqual([poGlowClosed]);
    const selfClosed = await list(`/warehouses/${wh}/inbound/purchase-orders`, { status: 'closed', clientId: selfClient, limit: 50 }).expect(200);
    expect(selfClosed.body.items).toEqual([]);
    // And a picklist-line status filter composes the same way.
    const lines = await list(`/warehouses/${wh}/outbound/picklist-lines`, { status: 'planned', clientId: glow, limit: 50 }).expect(200);
    const glowLines = lines.body.items as { orderId: string }[];
    expect(glowLines.length).toBeGreaterThan(0);
    expect(glowLines.every((line) => line.orderId === gA)).toBe(true);
  });

  it('wave policies refuse clientId (400) — a policy belongs to no client — and still list without it', async () => {
    const refused = await list(`/warehouses/${wh}/outbound/wave-policies`, { clientId: glow }).expect(400);
    expect(refused.body.code).toBe('validation-failed');
    const listed = await list(`/warehouses/${wh}/outbound/wave-policies`).expect(200);
    expect((listed.body.items as { name: string }[]).map((policy) => policy.name)).toEqual(['cf-single']);
  });

  it('a client-portal session is refused by the operator fence FIRST (403, even with a malformed clientId)', async () => {
    for (const clientId of [glow, 'abc']) {
      const res = await list(`/warehouses/${wh}/outbound/orders`, { clientId }, portalToken).expect(403);
      expect(res.body.code).toBe('role-denied');
      expect(res.body.detail).toBe('This is an operator surface.');
    }
  });

  it('a departed client stays filterable: its history and its SKUs read back', async () => {
    const status = (await sql`select status from clients where id = ${dept}`) as unknown as { status: string }[];
    expect(status[0]!.status).toBe('departed');
    const events = await list(`/warehouses/${wh}/inventory/events`, { clientId: dept, limit: 50 }).expect(200);
    const deptEvents = events.body.items as { skuId: string; quantityDelta: number }[];
    expect(deptEvents.map((event) => event.quantityDelta).sort()).toEqual([-2, 2]);
    expect(deptEvents.every((event) => event.skuId === sku('D-1'))).toBe(true);
    const skus = await list('/catalog/skus', { clientId: dept, limit: 50 }).expect(200);
    expect((skus.body.items as Item[]).map((item) => item.id)).toEqual([sku('D-1')]);
  });

  it('ASNs, client invoices and partners keep their existing filter; batches take none (400)', async () => {
    await list(`/warehouses/${wh}/inbound/asns`, { clientId: glow }).expect(200);
    await list('/client-invoices', { clientId: glow }).expect(200);
    await list('/partners', { clientId: glow }).expect(200);
    const batches = await list(`/warehouses/${wh}/inventory/batches`, { skuId: sku('G-1'), clientId: glow }).expect(400);
    expect(batches.body.code).toBe('validation-failed');
  });

  // ── the indexes (0081) ────────────────────────────────────────────────────

  describe('0081: the filtered reads use the new client indexes', () => {
    /** The REAL statement the app sends (captured at drizzle's session), EXPLAINed. */
    async function planOf(path: string, marker: RegExp, extra: Record<string, string> = {}): Promise<string> {
      const captured: { sql: string; params: unknown[] }[] = [];
      const original = PostgresJsSession.prototype.prepareQuery;
      jest.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (
        this: PostgresJsSession<never, never, never>,
        ...args: Parameters<typeof original>
      ) {
        captured.push({ sql: args[0].sql, params: args[0].params });
        return original.apply(this, args);
      });
      await list(path, { ...extra, clientId: glow, limit: 50 }).expect(200);
      jest.restoreAllMocks();
      const statement = captured.find((query) => marker.test(query.sql));
      if (statement === undefined) throw new Error(`no captured statement matched ${marker}`);
      const plan = await sql.begin(async (q) => {
        await q`set local enable_seqscan = off`;
        return (await q.unsafe(`explain ${statement.sql}`, statement.params as never[])) as unknown as Record<string, string>[];
      });
      return plan.map((row) => Object.values(row)[0]).join('\n');
    }

    it('orders: orders_tenant_client_warehouse_created_at_id_idx', async () => {
      const plan = await planOf(`/warehouses/${wh}/outbound/orders`, /from "orders".*"orders"\."client_id" = /s);
      expect(plan).toContain('orders_tenant_client_warehouse_created_at_id_idx');
    });

    it('ledger events: ledger_events_tenant_client_warehouse_created_at_id_idx', async () => {
      const plan = await planOf(`/warehouses/${wh}/inventory/events`, /from "ledger_events".*"ledger_events"\."client_id" = /s);
      expect(plan).toContain('ledger_events_tenant_client_warehouse_created_at_id_idx');
    });

    it('purchase orders: purchase_orders_tenant_client_warehouse_created_at_id_idx', async () => {
      const plan = await planOf(`/warehouses/${wh}/inbound/purchase-orders`, /from "purchase_orders".*"purchase_orders"\."client_id" = /s);
      expect(plan).toContain('purchase_orders_tenant_client_warehouse_created_at_id_idx');
    });

    it('goods receipts, warehouse-scoped: the own-client arm walks a 0081 client-led GRN index; the page probes the union once', async () => {
      const plan = await planOf('/receiving/goods-receipts', /from "goods_receipt_notes".*union all/s, { warehouseId: wh });
      // On the suite's handful of rows the planner may pick either 0081 GRN
      // index for this arm (with or without warehouse_id) — both are client-led.
      expect(plan).toMatch(/goods_receipt_notes_tenant_client_(warehouse_)?created_at_id_idx/);
      // The union is an InitPlan evaluated once; the page probes its ids as an index condition.
      expect(plan).toContain('id = ANY ((InitPlan');
    });

    it('goods receipts, tenant-wide: the own-client arm walks goods_receipt_notes_tenant_client_created_at_id_idx', async () => {
      const plan = await planOf('/receiving/goods-receipts', /from "goods_receipt_notes".*union all/s);
      expect(plan).toContain('goods_receipt_notes_tenant_client_created_at_id_idx');
    });

    it('returns, tenant-wide: return_authorizations_tenant_client_created_at_id_idx', async () => {
      const plan = await planOf('/returns', /from "return_authorizations".*"return_authorizations"\."client_id" = /s);
      expect(plan).toContain('return_authorizations_tenant_client_created_at_id_idx');
    });

    it('every 0081 index exists with exactly its declared columns', async () => {
      const rows = (await sql`
        select indexname, indexdef from pg_indexes
        where schemaname = 'public' and indexname in (
          'purchase_orders_tenant_client_warehouse_created_at_id_idx',
          'orders_tenant_client_warehouse_created_at_id_idx',
          'goods_receipt_notes_tenant_client_warehouse_created_at_id_idx',
          'goods_receipt_notes_tenant_client_created_at_id_idx',
          'return_authorizations_tenant_client_warehouse_created_at_id_idx',
          'ledger_events_tenant_client_warehouse_created_at_id_idx',
          'return_authorizations_tenant_client_created_at_id_idx',
          'skus_tenant_client_created_at_id_idx',
          'products_tenant_client_created_at_id_idx'
        )`) as unknown as { indexname: string; indexdef: string }[];
      const columns = new Map(rows.map((row) => [row.indexname, row.indexdef.replace(/^.*\((.*)\)$/, '$1')]));
      expect(columns).toEqual(
        new Map([
          ['purchase_orders_tenant_client_warehouse_created_at_id_idx', 'tenant_id, client_id, warehouse_id, created_at, id'],
          ['orders_tenant_client_warehouse_created_at_id_idx', 'tenant_id, client_id, warehouse_id, created_at, id'],
          ['goods_receipt_notes_tenant_client_warehouse_created_at_id_idx', 'tenant_id, client_id, warehouse_id, created_at, id'],
          ['goods_receipt_notes_tenant_client_created_at_id_idx', 'tenant_id, client_id, created_at, id'],
          ['return_authorizations_tenant_client_warehouse_created_at_id_idx', 'tenant_id, client_id, warehouse_id, created_at, id'],
          ['ledger_events_tenant_client_warehouse_created_at_id_idx', 'tenant_id, client_id, warehouse_id, created_at, id'],
          ['return_authorizations_tenant_client_created_at_id_idx', 'tenant_id, client_id, created_at, id'],
          ['skus_tenant_client_created_at_id_idx', 'tenant_id, client_id, created_at, id'],
          ['products_tenant_client_created_at_id_idx', 'tenant_id, client_id, created_at, id'],
        ]),
      );
    });
  });

  // ── the contract ───────────────────────────────────────────────────────────

  it('OpenAPI: every filtered route takes an optional uuid clientId; wave-policies and batches do not', () => {
    const doc = JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8')) as {
      paths: Record<string, { get?: { parameters?: { name: string; in: string; required?: boolean; schema?: { format?: string } }[] } }>;
    };
    const clientParam = (path: string) => doc.paths[path]?.get?.parameters?.find((p) => p.name === 'clientId' && p.in === 'query');
    const filtered = [
      '/tenants/{tenantId}/warehouses/{warehouseId}/inbound/purchase-orders',
      '/tenants/{tenantId}/receiving/goods-receipts',
      '/tenants/{tenantId}/receiving/over-receipts',
      '/tenants/{tenantId}/receiving/qc-holds',
      '/tenants/{tenantId}/putaway/tasks',
      '/tenants/{tenantId}/putaway/placements',
      '/tenants/{tenantId}/warehouses/{warehouseId}/outbound/orders',
      '/tenants/{tenantId}/warehouses/{warehouseId}/outbound/picklist-lines',
      '/tenants/{tenantId}/warehouses/{warehouseId}/outbound/pack-failures',
      '/tenants/{tenantId}/warehouses/{warehouseId}/outbound/backorder-refusals',
      '/tenants/{tenantId}/warehouses/{warehouseId}/outbound/manifests',
      '/tenants/{tenantId}/warehouses/{warehouseId}/outbound/waves',
      '/tenants/{tenantId}/returns',
      '/tenants/{tenantId}/warehouses/{warehouseId}/inventory/stock',
      '/tenants/{tenantId}/warehouses/{warehouseId}/inventory/events',
      '/tenants/{tenantId}/inventory/adjustment-pendings',
      '/tenants/{tenantId}/movements/variances',
      '/tenants/{tenantId}/movements/transfers',
      '/tenants/{tenantId}/replenishment/policies',
      '/tenants/{tenantId}/replenishment/breaches',
      '/tenants/{tenantId}/replenishment/suggested-pos',
      '/tenants/{tenantId}/replenishment/batch-alerts',
      '/tenants/{tenantId}/invoices',
      '/tenants/{tenantId}/eway/bills',
      '/tenants/{tenantId}/catalog/skus',
      '/tenants/{tenantId}/catalog/products',
      '/tenants/{tenantId}/catalog/kits',
    ];
    expect(filtered).toHaveLength(ROUTE_NAMES.length - 1); // the table runs the stock read twice (both orders)
    for (const path of filtered) {
      const param = clientParam(path);
      expect({ path, required: param?.required ?? false, format: param?.schema?.format }).toEqual({ path, required: false, format: 'uuid' });
    }
    expect(clientParam('/tenants/{tenantId}/warehouses/{warehouseId}/outbound/wave-policies')).toBeUndefined();
    expect(clientParam('/tenants/{tenantId}/warehouses/{warehouseId}/inventory/batches')).toBeUndefined();
  });
});
