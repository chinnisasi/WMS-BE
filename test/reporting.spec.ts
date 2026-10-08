import { Logger, type INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { sql as dsql } from 'drizzle-orm';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { OutboundFacade } from '../src/modules/outbound/outbound.facade';
import { ReportingFacade } from '../src/modules/reporting/reporting.facade';
import type { Drill, Figure, Overview } from '../src/modules/reporting/reporting.facade';
import type { TileDefinition } from '../src/modules/reporting/kpis';
import { INGEST_CALL_OUTCOMES } from '../src/modules/reporting/kpis';
import { INTEGRATION_CALL_STATUSES } from '../src/shared/db/schema';
import { reportingWindow, istMidnightBefore } from '../src/modules/reporting/window';
import { PACK_FAILURE_ENTRIES } from '../src/shared/db/schema';
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

jest.setTimeout(120_000);

interface PickLine {
  id: string;
  picklistId: string;
  orderId: string;
  orderLineId: string;
  skuId: string;
  binId: string | null;
  qty: number;
  status: string;
}

interface Wave {
  id: string;
  picklists: { id: string; lines: PickLine[] }[];
}

/**
 * Story 9-1 — the operational dashboard (FR-27) and the two facts it adds.
 *
 * One warehouse is seeded through the real HTTP surface with every kind of
 * activity a tile counts (receipts — one blind, one over-received —
 * putaways, picks incl. a zero-unit short and a serial line, a failed pack on
 * all three entry paths, a channel order refused under the reject policy and
 * one accepted backordered, dispatches). Three source tables the HTTP surface
 * cannot reach without the outbox relay or a live channel (batch alerts,
 * channel connections and their call meter, invoices and e-way bills) are
 * seeded by raw insert — the read model is what is under test there.
 *
 * The central promise: every `reconciles: true` figure equals its drill
 * route PAGED TO EXHAUSTION (limit 2 — so the cursor really walks), with the
 * drill's own query.
 */
describe('reporting: the operational dashboard (e2e, story 9-1)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  let suiteDb: SuiteDatabase;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerId: string;
  let ownerToken: string;
  let opsToken: string;
  let accountantToken: string;
  let operatorToken: string; // the badge-in DEVICE session
  let warehouseId: string;
  let emptyWarehouseId: string;
  let zoneId: string;
  let binA: string;
  let vendorId: string;
  const skuIds = new Map<string, string>();

  const SKU_CODES = [
    'RPT-PLAIN', 'RPT-SERIAL', 'RPT-ZERO', 'RPT-MISS', 'RPT-DEV', 'RPT-SYNC', 'RPT-CHAN', 'RPT-RECV',
    'RPT-T1', 'RPT-T2', 'RPT-T3', 'RPT-PART',
  ] as const;

  /** Order ids the scenario dispatched / left packed / left accepted. */
  const dispatchedOrders: string[] = [];

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('reporting');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Report Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerId = registered.body.owner.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = await signIn(email, 'correct-horse-battery');
    opsToken = await inviteAndSignIn('ops_manager', 'ops-password-123');
    accountantToken = await inviteAndSignIn('accountant', 'books-password-123');

    warehouseId = await createWarehouse('RPT');
    emptyWarehouseId = await createWarehouse('RPE');
    zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binA = await createBin('A-01-01');

    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
      ...SKU_CODES.map((code) => `${code},Report SKU ${code},pcs,,1800,,false,${code === 'RPT-SERIAL' ? 'true' : 'false'},,,`),
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const catalog = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of catalog.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }

    vendorId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/vendors`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'VEND-RPT', name: 'Report Vendor' })
        .expect(201)
    ).body.vendor.id as string;

    // The floor device + its badge-in operator.
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Report scanner', pin: '2468' })
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
    await seedScenario();
  });

  afterAll(async () => {
    await valkey.quit().catch(() => valkey.disconnect());
    for (const token of [DATABASE, AUTH_DATABASE]) {
      const raw = app.get<unknown>(token) as { $client?: { end(): Promise<void> } };
      await raw.$client?.end();
    }
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

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

  async function createWarehouse(prefix: string): Promise<string> {
    return (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${prefix}-${ulid().slice(10, 16).toUpperCase()}`, name: `${prefix} WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
  }

  async function createBin(code: string): Promise<string> {
    return (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code })
        .expect(201)
    ).body.id as string;
  }

  function sku(code: (typeof SKU_CODES)[number]): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  function now(): string {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  }

  async function seedStock(skuId: string, quantity: number, extra: Record<string, unknown> = {}): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId: binA, quantityDelta: quantity, reasonCode: 'stock-count', note: 'reporting seed', ...extra })
      .expect(201);
  }

  async function createOrder(lines: { skuId: string; quantity: number }[]): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines, destination: testAddress() })
      .expect(201);
    return res.body.order.id as string;
  }

  async function releasedWave(orderId: string): Promise<PickLine[]> {
    const policy = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/wave-policies`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, name: `rpt-${ulid().slice(10, 20)}`, grouping: 'single' })
        .expect(201)
    ).body.policy.id as string;
    const waveId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/waves`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, policyId: policy, orderIds: [orderId] })
        .expect(201)
    ).body.wave.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const wave = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200)
    ).body.wave as Wave;
    return wave.picklists.flatMap((picklist) => picklist.lines);
  }

  function pick(line: PickLine, overrides: Record<string, unknown> = {}): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/picks`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        picklistId: line.picklistId,
        picklistLineId: line.id,
        skuId: line.skuId,
        binId: line.binId!,
        qty: line.qty,
        occurredAt: now(),
        ...overrides,
      });
  }

  function packTenant(orderId: string, scanned: { skuId: string; qty: number }[]): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned });
  }

  function packDevice(orderId: string, scanned: { skuId: string; qty: number }[]): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/packs`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ orderId, scanned });
  }

  function dispatch(orderId: string): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({});
  }

  /** A picked order of one line of `code` × qty (stock seeded first). */
  async function pickedOrder(code: (typeof SKU_CODES)[number], qty: number): Promise<{ orderId: string; skuId: string }> {
    const skuId = sku(code);
    await seedStock(skuId, qty);
    const orderId = await createOrder([{ skuId, quantity: qty }]);
    const [line] = await releasedWave(orderId);
    await pick(line!).expect(201);
    return { orderId, skuId };
  }

  function ingest(
    lines: { skuId: string; quantity: number }[],
    integrationId: string,
    externalEventId: string,
    backorderPolicy: 'accept' | 'reject',
  ): Promise<unknown> {
    // The channel ingest's own create path (the webhook's HMAC/mapping layer
    // is 7-2's coverage): THE order command with the channel arms + policy.
    return app.get(OutboundFacade).createOrder(
      {
        tenantId,
        actorUserId: ownerId,
        warehouseId,
        source: 'ingested',
        lines,
        destination: testAddress() as never,
        integrationId,
        externalEventId,
        backorderPolicy,
      },
      ulid(),
    );
  }

  const integrationId = uuidv7();
  let packMismatchOrder: string;
  let devicePackOrder: string;
  let syncPackOrder: string;

  async function seedScenario(): Promise<void> {
    // ── receipts: one PO-backed with an over-receipt, one blind ──────────
    const po = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inbound/purchase-orders`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          vendorId,
          code: `PO-${ulid().slice(10, 18)}`,
          lines: [{ skuId: sku('RPT-RECV'), orderedQty: 10, unitCostPaise: 1000 }],
        })
        .expect(201)
    ).body.purchaseOrder as { id: string; lines: { id: string }[] };
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        poId: po.id,
        blindReasonCode: null,
        occurredAt: now(),
        lines: [{ poLineId: po.lines[0]!.id, skuId: sku('RPT-RECV'), batchCode: null, mfgDate: null, qty: 12 }],
      })
      .expect(201);
    const blind = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          poId: null,
          blindReasonCode: 'unannounced-delivery',
          occurredAt: now(),
          lines: [
            { poLineId: null, skuId: sku('RPT-PLAIN'), batchCode: null, mfgDate: null, qty: 5 },
            { poLineId: null, skuId: sku('RPT-CHAN'), batchCode: null, mfgDate: null, qty: 1 },
          ],
        })
        .expect(201)
    ).body.goodsReceipt as { id: string; lines: { id: string; skuId: string; qty: number }[] };
    // One putaway: the first blind line placed whole; the second stays in
    // Receiving (awaiting putaway), and so does the PO receipt's line.
    const first = blind.lines.find((line) => line.skuId === sku('RPT-PLAIN'))!;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/putaway/placements`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        grnId: blind.id,
        grnLineId: first.id,
        skuId: first.skuId,
        batchId: null,
        qty: first.qty,
        toBinId: binA,
        reasonCode: null,
        occurredAt: now(),
      })
      .expect(201);
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

    // ── a plain order: picked whole, packed, dispatched ──────────────────
    const plain = await pickedOrder('RPT-PLAIN', 2);
    await packTenant(plain.orderId, [{ skuId: plain.skuId, qty: 2 }]).expect(201);
    await dispatch(plain.orderId).expect(201);
    dispatchedOrders.push(plain.orderId);

    // ── a serial order: ONE line of 3 serials → 3 ledger draws, 1 picks row ─
    const serialSku = sku('RPT-SERIAL');
    const tag = ulid().slice(12, 18);
    await seedStock(serialSku, 3, { serials: [`RS-${tag}-1`, `RS-${tag}-2`, `RS-${tag}-3`] });
    const serialOrder = await createOrder([{ skuId: serialSku, quantity: 3 }]);
    const [serialLine] = await releasedWave(serialOrder);
    await pick(serialLine!, { serials: [`RS-${tag}-1`, `RS-${tag}-2`, `RS-${tag}-3`] }).expect(201);
    await packTenant(serialOrder, [{ skuId: serialSku, qty: 3 }]).expect(201);
    await dispatch(serialOrder).expect(201);
    dispatchedOrders.push(serialOrder);

    // ── a zero-unit short pick (empty bin): no picks row, no ledger event ──
    const zeroSku = sku('RPT-ZERO');
    await seedStock(zeroSku, 1);
    const zeroOrder = await createOrder([{ skuId: zeroSku, quantity: 1 }]);
    const [zeroLine] = await releasedWave(zeroOrder);
    await pick(zeroLine!, { qty: 0, reasonCode: 'bin-empty' }).expect(201);

    // ── failed pack verifications, one per entry path ────────────────────
    packMismatchOrder = (await pickedOrder('RPT-MISS', 2)).orderId;
    devicePackOrder = (await pickedOrder('RPT-DEV', 2)).orderId;
    syncPackOrder = (await pickedOrder('RPT-SYNC', 2)).orderId;
    await packTenant(packMismatchOrder, [{ skuId: sku('RPT-MISS'), qty: 1 }]).expect(422);

    // ── channel orders: one refused under reject, one accepted backordered ─
    await expect(ingest([{ skuId: sku('RPT-CHAN'), quantity: 50 }], integrationId, 'EVT-REJECT-1', 'reject')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'order-backorder-rejected' }),
    });
    await ingest([{ skuId: sku('RPT-CHAN'), quantity: 50 }], integrationId, 'EVT-ACCEPT-1', 'accept');

    // ── raw-seeded sources (the read model is what is under test) ─────────
    await sql`
      insert into batch_alerts (id, tenant_id, warehouse_id, sku_id, batch_id, kind, status)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${sku('RPT-PLAIN')}, ${uuidv7()}, 'expiry_upcoming', 'open'),
             (${uuidv7()}, ${tenantId}, ${warehouseId}, ${sku('RPT-PLAIN')}, ${uuidv7()}, 'aged', 'resolved')
    `;
    await sql`
      insert into integrations (id, tenant_id, provider, status, credential_sealed, backorder_policy,
        ingest_warehouse_id, connected_by, last_synced_at)
      values (${integrationId}, ${tenantId}, 'shopify', 'connected', 'v1:aa:bb:cc', 'reject',
        ${warehouseId}, ${ownerId}, now() - interval '90 seconds')
    `;
    await sql`
      insert into integrations (id, tenant_id, provider, status, credential_sealed, backorder_policy,
        ingest_warehouse_id, connected_by)
      values (${uuidv7()}, ${tenantId}, 'flipkart', 'connected', 'v1:aa:bb:cc', 'accept', null, ${ownerId})
    `;
    // A DISCONNECTED connection still ingesting here — always `error`.
    await sql`
      insert into integrations (id, tenant_id, provider, status, credential_sealed, backorder_policy,
        ingest_warehouse_id, connected_by)
      values (${uuidv7()}, ${tenantId}, 'amazon-in', 'disconnected', 'v1:aa:bb:cc', 'accept', ${warehouseId}, ${ownerId})
    `;
    await sql`
      insert into integration_calls (id, tenant_id, integration_id, kind, status, at)
      values (${uuidv7()}, ${tenantId}, ${integrationId}, 'order-ingest', 'accepted', now()),
             (${uuidv7()}, ${tenantId}, ${integrationId}, 'order-ingest', 'unmapped', now()),
             -- Not failures: a policy refusal (an oversell PREVENTED) and two
             -- settled cancellation outcomes.
             (${uuidv7()}, ${tenantId}, ${integrationId}, 'order-ingest', 'rejected', now()),
             (${uuidv7()}, ${tenantId}, ${integrationId}, 'order-ingest', 'released', now()),
             (${uuidv7()}, ${tenantId}, ${integrationId}, 'order-ingest', 'ignored', now()),
             (${uuidv7()}, ${tenantId}, ${integrationId}, 'order-ingest', 'rejected', now() - interval '2 days')
    `;
    // Three issued invoices of this warehouse (one with a manually priced
    // line), each with an e-way bill numbered BY HAND (manual), one pending,
    // one dismissed — no gateway: SM-8 must read 0%.
    const invoiceIds = [uuidv7(), uuidv7(), uuidv7()];
    for (const [index, invoiceId] of invoiceIds.entries()) {
      await sql`
        insert into invoices (id, tenant_id, order_id, warehouse_id, invoice_no, fy_label, series_seq, status,
          origin_gstin, subtotal_paise, gst_paise, total_paise, payable_paise, round_off_paise, document, issued_at)
        values (${invoiceId}, ${tenantId}, ${uuidv7()}, ${warehouseId}, ${`RPT-${index}`}, 'FY-2627', ${index + 1}, 'issued',
          '27AAAPZ1234C1ZV', 10000000, 0, 10000000, 10000000, 0, ${sql.json({ header: { originAddress: null, consigneeAddress: null }, seller: { name: 'Seller' }, buyer: { name: 'Buyer' }, lines: [], gaps: [] } as never)}, now())
      `;
      await sql`
        insert into invoice_lines (id, tenant_id, invoice_id, order_line_id, sku_code, sku_name, qty_milli,
          rate_paise, rate_source, taxable_paise, gst_bps, uom)
        values (${uuidv7()}, ${tenantId}, ${invoiceId}, ${uuidv7()}, 'RPT', 'Report', 1000, 10000000,
          ${index === 0 ? 'manual' : 'order_line'}, 10000000, 0, 'pcs')
      `;
    }
    await sql`
      insert into eway_bills (id, tenant_id, invoice_id, origin_gstin, status, consignment_value_paise,
        threshold_paise, threshold_rule, ewb_no, ewb_generated_at, source, dismissed_reason)
      values
        (${uuidv7()}, ${tenantId}, ${invoiceIds[0]!}, '27AAAPZ1234C1ZV', 'generated', 10000000, 5000000, 'national', '123456789012', now(), 'manual', null),
        (${uuidv7()}, ${tenantId}, ${invoiceIds[1]!}, '27AAAPZ1234C1ZV', 'pending', 10000000, 5000000, 'national', null, null, null, null),
        (${uuidv7()}, ${tenantId}, ${invoiceIds[2]!}, '27AAAPZ1234C1ZV', 'dismissed', 10000000, 5000000, 'national', null, null, null, 'below threshold after all')
    `;
  }

  // ── reading helpers ────────────────────────────────────────────────────────

  async function readOverview(warehouse = warehouseId, token = accountantToken): Promise<Overview> {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouse}/reporting/overview`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as Overview;
  }

  /** Pages a drill to exhaustion (limit 2 where the route pages) and counts rows. */
  async function pageDrill(drill: Drill): Promise<number> {
    const paged = !drill.apiPath.endsWith('/putaway/tasks');
    let cursor: string | null = null;
    let total = 0;
    for (let hops = 0; hops < 500; hops += 1) {
      const query: Record<string, string> = { ...drill.query, ...(paged ? { limit: '2' } : {}) };
      if (cursor !== null) query.cursor = cursor;
      const res = await request(app.getHttpServer())
        .get(`/api/v1${drill.apiPath}`)
        .query(query)
        .set('Authorization', `Bearer ${accountantToken}`);
      if (res.status !== 200) {
        throw new Error(`drill ${drill.apiPath}?${JSON.stringify(query)} answered ${res.status}: ${JSON.stringify(res.body)}`);
      }
      total += (res.body.items as unknown[]).length;
      cursor = (res.body.nextCursor as string | null | undefined) ?? null;
      if (!paged || cursor === null) return total;
    }
    throw new Error(`drill ${drill.apiPath} did not exhaust`);
  }

  /** Every figure in the response, named by its path. */
  function figures(overview: Overview): { path: string; figure: Figure }[] {
    const out: { path: string; figure: Figure }[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if ('value' in record && 'drill' in record) {
        out.push({ path, figure: record as unknown as Figure });
        return;
      }
      for (const [key, child] of Object.entries(record)) walk(child, path === '' ? key : `${path}.${key}`);
    };
    walk(overview.tiles, '');
    return out;
  }

  async function countRows(query: postgres.PendingQuery<postgres.Row[]>): Promise<number> {
    const rows = await query;
    return Number((rows[0] as { n: string }).n);
  }

  // ── the overview ───────────────────────────────────────────────────────────

  it('an active warehouse: every tile ok, asOf and the IST windows stamped, stale false — readable by any member (no capability)', async () => {
    const overview = await readOverview();
    expect(overview.stale).toBe(false);
    for (const [name, tile] of Object.entries(overview.tiles)) {
      expect({ name, state: (tile as { state: string }).state }).toEqual({ name, state: 'ok' });
    }
    expect(overview.window.to).toBe(overview.asOf);
    const window = reportingWindow(new Date(overview.asOf));
    expect(overview.window).toEqual({
      todayFrom: window.todayFrom,
      d7From: window.d7From,
      to: window.asOf,
      lastHourFrom: window.lastHourFrom,
      last24hFrom: window.last24hFrom,
    });
    // The operator role reads it too — reads are never capability-gated.
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/reporting/overview`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
  });

  it('every reconciles:true figure equals its drill paged to exhaustion (limit 2), and every drill names a route that answers', async () => {
    const overview = await readOverview();
    const all = figures(overview);
    const reconciling = all.filter(({ figure }) => figure.drill.reconciles);
    // Meaningful: the scenario gives most of them a non-zero value.
    expect(reconciling.length).toBeGreaterThanOrEqual(20);
    expect(reconciling.filter(({ figure }) => (figure.value ?? 0) > 0).length).toBeGreaterThanOrEqual(12);
    const mismatches: string[] = [];
    for (const { path, figure } of reconciling) {
      const paged = await pageDrill(figure.drill);
      if (paged !== figure.value) mismatches.push(`${path}: tile ${figure.value} vs drill ${paged}`);
    }
    expect(mismatches).toEqual([]);
    // Non-reconciling drills still name a list that answers 200.
    for (const { figure } of all.filter(({ figure }) => !figure.drill.reconciles)) {
      await pageDrill(figure.drill);
    }
    await pageDrill(overview.tiles.syncHealth.drill);
  });

  it('SM-3 / SM-4 / SM-8 match the PRD formulas computed independently from the tables', async () => {
    const overview = await readOverview();
    const { d7From, to } = overview.window;
    const shortLines = await countRows(sql`
      select count(*) as n from picklist_lines pl join picklists p on p.id = pl.picklist_id
      where pl.tenant_id = ${tenantId} and p.warehouse_id = ${warehouseId} and pl.status = 'short'
        and pl.updated_at >= ${d7From} and pl.updated_at < ${to}`);
    const packFailures = await countRows(sql`
      select count(*) as n from pack_verification_failures
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and created_at >= ${d7From} and created_at < ${to}`);
    const dispatchedLines = await countRows(sql`
      select count(distinct ol.id) as n from order_lines ol join orders o on o.id = ol.order_id
      where o.tenant_id = ${tenantId} and o.warehouse_id = ${warehouseId} and o.status = 'dispatched'`);
    expect(shortLines).toBe(1);
    expect(packFailures).toBeGreaterThanOrEqual(1);
    expect(dispatchedLines).toBe(2);
    const sm3 = overview.tiles.orderAccuracy;
    expect(sm3.shortLines.d7.value).toBe(shortLines);
    expect(sm3.packFailures.d7.value).toBe(packFailures);
    expect(sm3.dispatchedLines.d7.value).toBe(dispatchedLines);
    expect(sm3.defectsPer1000.d7.value).toBe(Math.round(((shortLines + packFailures) * 1000 * 10) / dispatchedLines) / 10);
    expect(sm3.defectsPer1000.d7.drill.reconciles).toBe(false);
    expect(sm3.countingSince).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    // SM-4: ingested, accepted, ≥ 1 backordered line — per order.
    const backordered = await countRows(sql`
      select count(*) as n from orders o
      where o.tenant_id = ${tenantId} and o.warehouse_id = ${warehouseId} and o.source = 'ingested'
        and exists (select 1 from order_lines ol where ol.order_id = o.id and ol.status = 'backordered')`);
    expect(backordered).toBe(1);
    expect(overview.tiles.oversell.backorderedOrders.d7.value).toBe(backordered);
    expect(overview.tiles.oversell.prevented.d7.value).toBe(1);

    // SM-8: two eligible bills (the dismissed one excluded), none by gateway → 0.
    expect(overview.tiles.sm8.eligible.d7.value).toBe(2);
    expect(overview.tiles.sm8.gatewayGenerated.d7.value).toBe(0);
    expect(overview.tiles.sm8.gatewayShare.d7.value).toBe(0);
    // The secondary: 3 issued, one with a manual line → 2/3.
    expect(overview.tiles.sm8.invoicesIssued.d7.value).toBe(3);
    expect(overview.tiles.sm8.noManualPricingShare.d7.value).toBe(Math.round((2 / 3) * 10000) / 10000);
  });

  it('the tile definitions: serial line = one pick line, zero-unit short counted, blind GRN + over-receipt, putaway awaiting, expiry, sync health, pipeline', async () => {
    const overview = await readOverview();
    const t = overview.tiles;
    // Picks: plain 2 + serial (ONE line, three ledger draws) + MISS + DEV + SYNC = 5 lines.
    expect(t.pickRate.pickLines.d7.value).toBe(5);
    const serialDraws = await countRows(sql`
      select count(*) as n from ledger_events where tenant_id = ${tenantId} and type = 'pick.picked' and sku_id = ${sku('RPT-SERIAL')}`);
    expect(serialDraws).toBe(3);
    expect(t.pickRate.pickLines.d7.drill.reconciles).toBe(false);
    // The zero-unit short wrote no picks row and no event — but it counts.
    expect(t.shortPicks.shortLines.d7.value).toBe(1);
    expect(
      await countRows(sql`select count(*) as n from ledger_events where tenant_id = ${tenantId} and sku_id = ${sku('RPT-ZERO')} and type = 'pick.picked'`),
    ).toBe(0);
    expect(t.grnVariances.blindGrns.d7.value).toBe(1);
    expect(t.grnVariances.overReceipts.d7.value).toBe(1);
    expect(t.grnVariances.pendingOverReceipts.value).toBe(1);
    // Awaiting putaway: the PO line (10 applied) and the blind second line.
    expect(t.dockToStock.awaitingPutaway.value).toBe(2);
    expect(t.dockToStock.medianMinutes.d7.value).not.toBeNull();
    expect(t.dockToStock.medianMinutes.d7.value!).toBeGreaterThanOrEqual(0);
    expect(t.expiryAlerts.openExpiryUpcoming.value).toBe(1);
    expect(t.expiryAlerts.openAged.value).toBe(0);
    expect(t.expiryAlerts.raised.d7.value).toBe(2);
    // Sync health: shopify synced 90 s ago — over /channels' 60 s SLO, so
    // `connectionHealth` says degraded/sync-lag (the dashboard never
    // re-derives it); flipkart has no ingest warehouse; amazon-in is
    // disconnected. Only the `unmapped` call is a failure — the recent
    // `rejected`/`released`/`ignored` are not, the 2-day-old one is outside.
    const connections = t.syncHealth.connections!;
    expect(connections).toHaveLength(3);
    const shopify = connections.find((c) => c.provider === 'shopify')!;
    expect(shopify).toMatchObject({ status: 'connected', health: 'degraded', reason: 'sync-lag', ingestFailures24h: 1 });
    expect(shopify.lagSeconds!).toBeGreaterThanOrEqual(90);
    expect(connections.find((c) => c.provider === 'flipkart')).toMatchObject({
      health: 'error',
      reason: 'ingest-warehouse-unset',
      lagSeconds: null,
    });
    expect(connections.find((c) => c.provider === 'amazon-in')).toMatchObject({
      status: 'disconnected',
      health: 'error',
      reason: 'disconnected',
    });
    // Freshly synced, the shopify connection's only problem is its ingest failure.
    await sql`update integrations set last_synced_at = now() where id = ${integrationId}`;
    const fresh = (await readOverview()).tiles.syncHealth.connections!.find((c) => c.provider === 'shopify')!;
    expect(fresh).toMatchObject({ health: 'degraded', reason: 'ingest-failures', ingestFailures24h: 1 });
    await sql`update integrations set last_synced_at = now() - interval '90 seconds' where id = ${integrationId}`;
    // Pipeline: accepted = ZERO's order (short, unpacked) + 3 picked-unpacked
    // + the backordered channel order; dispatched = 2 orders.
    expect(t.dispatchPipeline.accepted.value).toBe(5);
    expect(t.dispatchPipeline.readyToDispatch.value).toBe(0);
    expect(t.dispatchPipeline.labelledNotManifested.value).toBe(0);
    expect(t.dispatchPipeline.ordersDispatched.d7.value).toBe(2);
    // today ≤ d7 everywhere.
    for (const { path, figure } of figures(overview)) {
      if (path.endsWith('.today')) {
        const d7 = figures(overview).find((f) => f.path === path.replace(/\.today$/, '.d7'))!.figure;
        if (figure.value !== null && d7.value !== null && !/median|Share|Per1000/.test(path)) {
          expect(figure.value).toBeLessThanOrEqual(d7.value);
        }
      }
    }
  });

  it('an empty warehouse: counts are 0; medians, rates and ratios are null ("no data"), never a fake 0', async () => {
    const overview = await readOverview(emptyWarehouseId);
    expect(overview.stale).toBe(false);
    const t = overview.tiles;
    expect(t.pickRate.pickLines.d7.value).toBe(0);
    expect(t.shortPicks.shortLines.today.value).toBe(0);
    expect(t.dockToStock.awaitingPutaway.value).toBe(0);
    expect(t.dockToStock.medianMinutes.d7.value).toBeNull();
    expect(t.orderAccuracy.defectsPer1000.d7.value).toBeNull();
    expect(t.sm8.gatewayShare.d7.value).toBeNull();
    expect(t.sm8.noManualPricingShare.d7.value).toBeNull();
    expect(t.syncHealth.connections!.map((c) => c.provider)).toEqual(['flipkart']); // unset ingest warehouse shows everywhere
  });

  it('a foreign or unknown warehouse is 404 BEFORE any tile runs; a malformed one 400; another tenant 403', async () => {
    const facade = app.get(ReportingFacade);
    const runTiles = jest.spyOn(facade as unknown as { runTiles: () => unknown }, 'runTiles');
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${uuidv7()}/reporting/overview`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(404);
    expect(res.body.code).toBe('not-found');
    expect(runTiles).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/not-a-uuid/reporting/overview`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`${API}/${uuidv7()}/warehouses/${warehouseId}/reporting/overview`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(403);
  });

  // ── best-effort tiles (AD-17) ──────────────────────────────────────────────

  it('a slow tile (a held lock → statement timeout 57014): that tile unavailable, the rest ok, stale true, response under 2 s — silently', async () => {
    const errors = jest.spyOn(Logger.prototype, 'error');
    const locker = postgres(process.env.DATABASE_URL!, { max: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => (release = resolveHeld));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolveLocked) => (locked = resolveLocked));
    const holder = locker.begin(async (tx) => {
      await tx`lock table picks in access exclusive mode`;
      locked();
      await held;
    });
    try {
      await isLocked;
      const started = Date.now();
      const overview = await readOverview();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(2000);
      expect(overview.stale).toBe(true);
      expect(overview.tiles.pickRate.state).toBe('unavailable');
      expect(overview.tiles.pickRate.pickLines.d7.value).toBeNull();
      // The drill is still present on an unavailable tile.
      expect(overview.tiles.pickRate.pickLines.d7.drill.apiPath).toContain('/inventory/events');
      for (const [name, tile] of Object.entries(overview.tiles)) {
        if (name !== 'pickRate') expect({ name, state: (tile as { state: string }).state }).toEqual({ name, state: 'ok' });
      }
      expect(errors.mock.calls.filter((call) => String(call[0]).includes('Reporting tile'))).toEqual([]);
    } finally {
      release();
      await holder;
      await locker.end();
      errors.mockRestore();
    }
  });

  it('the 1.8 s deadline: tiles still running or never started are unavailable; a non-timeout error is LOGGED with the tile name and is unavailable too', async () => {
    const facade = app.get(ReportingFacade);
    const original = facade.tiles;
    const errors = jest.spyOn(Logger.prototype, 'error');
    const sleepy = (tile: TileDefinition): TileDefinition => ({
      ...tile,
      run: async (tx, ctx) => {
        await tx.execute(dsql`select pg_sleep(1.0)`);
        return tile.run(tx, ctx);
      },
    });
    const broken = (tile: TileDefinition): TileDefinition => ({
      ...tile,
      run: async () => {
        throw new Error('synthetic tile fault');
      },
    });
    // Three sleepers take the three slots for 1 s; the next three start at
    // ~1 s and cannot finish by 1.8 s; the rest never start. The broken tile
    // runs first in its own slot... it is the LAST so it never starts either —
    // so put it first instead and give the sleepers the other two slots.
    facade.tiles = [broken(original[0]!), ...original.slice(1).map(sleepy)];
    try {
      const started = Date.now();
      const overview = await readOverview();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(2000);
      expect(elapsed).toBeGreaterThanOrEqual(1700);
      expect(overview.stale).toBe(true);
      const states = Object.fromEntries(Object.entries(overview.tiles).map(([name, tile]) => [name, (tile as { state: string }).state]));
      expect(states.dockToStock).toBe('unavailable'); // the broken one
      // Slots: broken(fast) → sleepers pickRate, shortPicks, grnVariances
      // finish at ~1 s; orderAccuracy/oversell/expiryAlerts start ~1 s and
      // finish ~2 s (past the deadline) — the rest never start.
      expect(states.pickRate).toBe('ok');
      expect(states.shortPicks).toBe('ok');
      expect(states.sm8).toBe('unavailable');
      expect(states.dispatchPipeline).toBe('unavailable');
      const logged = errors.mock.calls.map((call) => String(call[0])).filter((m) => m.includes('Reporting tile'));
      expect(logged).toEqual([expect.stringContaining('"dockToStock"')]);
      expect(logged[0]).toContain('synthetic tile fault');
    } finally {
      facade.tiles = original;
      errors.mockRestore();
      // Let the stragglers' connections drain before the next test.
      await new Promise((r) => setTimeout(r, 1500));
    }
  });

  it('the IST boundary: a pick stamped 1 ms before IST midnight is yesterday, one AT midnight is today; the 7-day window holds both', async () => {
    const at = new Date();
    const window = reportingWindow(at);
    const facade = app.get(ReportingFacade);
    const before = await facade.overview(tenantId, warehouseId, at);
    const rows = (await sql`
      select id from picks where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
        and created_at >= ${window.todayFrom} and created_at < ${window.asOf}
      order by id limit 2`) as unknown as { id: string }[];
    expect(rows).toHaveLength(2);
    const justBefore = new Date(Date.parse(window.todayFrom) - 1).toISOString();
    await sql`update picks set created_at = ${justBefore} where id = ${rows[0]!.id}`;
    await sql`update picks set created_at = ${window.todayFrom} where id = ${rows[1]!.id}`;
    const after = await facade.overview(tenantId, warehouseId, at);
    expect(after.tiles.pickRate.pickLines.today.value).toBe(before.tiles.pickRate.pickLines.today.value! - 1);
    expect(after.tiles.pickRate.pickLines.d7.value).toBe(before.tiles.pickRate.pickLines.d7.value);
    // The pure window, at the literal instants of the matrix row.
    expect(reportingWindow(new Date('2026-10-06T19:00:00Z')).todayFrom).toBe('2026-10-06T18:30:00.000Z');
    expect(istMidnightBefore(Date.parse('2026-10-06T18:29:59Z'))).toBe(Date.parse('2026-10-05T18:30:00Z'));
    expect(istMidnightBefore(Date.parse('2026-10-06T18:30:00Z'))).toBe(Date.parse('2026-10-06T18:30:00Z'));
    expect(reportingWindow(new Date('2026-10-06T19:00:00Z')).d7From).toBe('2026-09-30T18:30:00.000Z');
    // Restore so later assertions see the scenario as seeded.
    await sql`update picks set created_at = now() where id in (${rows[0]!.id}, ${rows[1]!.id})`;
  });

  // ── the facts ──────────────────────────────────────────────────────────────

  it('pack mismatch on the tenant, device and sync-report paths: the 422 is unchanged, and each records exactly one failure row naming its path', async () => {
    const tenantFailures = await countRows(sql`select count(*) as n from pack_verification_failures where order_id = ${packMismatchOrder}`);
    expect(tenantFailures).toBe(1); // the scenario's tenant-route refusal

    // The device bench route.
    const deviceRes = await packDevice(devicePackOrder, [{ skuId: sku('RPT-DEV'), qty: 5 }]).expect(422);
    expect(deviceRes.body).toMatchObject({ code: 'pack-mismatch', status: 422 });
    expect(deviceRes.body.detail).toContain('Nothing was written');

    // The sync-report apply (a rejected op re-executed through the command).
    const row = {
      opId: ulid(),
      opType: 'pack.execute',
      classification: 'rejected',
      problemCode: 'epoch-conflict',
      problemDetail: 'replayed later',
      payload: { orderId: syncPackOrder, scanned: [{ skuId: sku('RPT-SYNC'), qty: 1 }] },
      attribution: { deviceLabel: 'Report scanner', operatorEmail: 'floor@example.com' },
      opEnqueuedAt: new Date(Date.now() - 60_000).toISOString(),
      opOccurredAt: null,
    };
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/sync-reports`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ rows: [row] })
      .expect(201);
    const listing = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/rejected-ops`)
      .query({ status: 'open' })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const op = (listing.body.items as { id: string; opId: string }[]).find((item) => item.opId === row.opId)!;
    const applied = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/rejected-ops/${op.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'apply' });
    expect(applied.body.code).toBe('pack-mismatch');

    const rows = (await sql`
      select order_id, entry, actor_user_id, warehouse_id, mismatch from pack_verification_failures
      where tenant_id = ${tenantId} order by created_at`) as unknown as {
      order_id: string;
      entry: string;
      warehouse_id: string;
      mismatch: { skuId: string; pickedMilli: number; scannedMilli: number }[];
    }[];
    const byOrder = new Map(rows.map((r) => [r.order_id, r]));
    expect(byOrder.get(packMismatchOrder)!.entry).toBe('tenant');
    expect(byOrder.get(devicePackOrder)!.entry).toBe('device');
    expect(byOrder.get(syncPackOrder)!.entry).toBe('sync');
    expect(rows.filter((r) => r.order_id === devicePackOrder)).toHaveLength(1);
    expect(byOrder.get(devicePackOrder)!.mismatch).toEqual([
      { skuId: sku('RPT-DEV'), skuCode: 'RPT-DEV', pickedMilli: 2000, scannedMilli: 5000 },
    ]);
    expect(byOrder.get(devicePackOrder)!.warehouse_id).toBe(warehouseId);
    expect([...PACK_FAILURE_ENTRIES].sort()).toEqual(['device', 'sync', 'tenant']);

    // The list route shows them in base units.
    const listed = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/pack-failures`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    const device = (listed.body.items as { orderId: string; mismatch: unknown[] }[]).find((i) => i.orderId === devicePackOrder)!;
    expect(device.mismatch).toEqual([{ skuId: sku('RPT-DEV'), skuCode: 'RPT-DEV', pickedQty: 2, scannedQty: 5 }]);
  });

  it('a failing fact write never changes the response: the 422 / 409 stand, nothing is written, and the failure is logged', async () => {
    const errors = jest.spyOn(Logger.prototype, 'error');
    const before = await countRows(sql`select count(*) as n from pack_verification_failures where tenant_id = ${tenantId}`);
    await sql`alter table pack_verification_failures rename to pack_verification_failures_away`;
    await sql`alter table ingest_backorder_refusals rename to ingest_backorder_refusals_away`;
    try {
      const res = await packTenant(packMismatchOrder, [{ skuId: sku('RPT-MISS'), qty: 7 }]).expect(422);
      expect(res.body.code).toBe('pack-mismatch');
      await expect(
        ingest([{ skuId: sku('RPT-CHAN'), quantity: 50 }], integrationId, 'EVT-REJECT-FAILWRITE', 'reject'),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'order-backorder-rejected' }) });
    } finally {
      await sql`alter table pack_verification_failures_away rename to pack_verification_failures`;
      await sql`alter table ingest_backorder_refusals_away rename to ingest_backorder_refusals`;
    }
    const messages = errors.mock.calls.map((call) => String(call[0]));
    errors.mockRestore();
    expect(messages.some((m) => m.includes('fact row could not be written'))).toBe(true);
    expect(messages.some((m) => m.includes('refusal fact could not be written'))).toBe(true);
    expect(await countRows(sql`select count(*) as n from pack_verification_failures where tenant_id = ${tenantId}`)).toBe(before);
    expect(
      await countRows(sql`select count(*) as n from ingest_backorder_refusals where external_event_id = 'EVT-REJECT-FAILWRITE'`),
    ).toBe(0);
  });

  it('a redelivered rejected webhook (same integration + external event, a fresh key) adds no second refusal row', async () => {
    await expect(ingest([{ skuId: sku('RPT-CHAN'), quantity: 50 }], integrationId, 'EVT-REJECT-1', 'reject')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'order-backorder-rejected' }),
    });
    const rows = (await sql`
      select lines from ingest_backorder_refusals where tenant_id = ${tenantId} and external_event_id = 'EVT-REJECT-1'`) as unknown as {
      lines: { skuId: string; requestedMilli: number; availableMilli: number }[];
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lines).toEqual([{ skuId: sku('RPT-CHAN'), requestedMilli: 50_000, availableMilli: expect.any(Number) }]);
    expect(rows[0]!.lines[0]!.availableMilli).toBeLessThan(50_000);
    // No order row exists for the refused event — the refusal wrote nothing else.
    expect(await countRows(sql`select count(*) as n from orders where external_event_id = 'EVT-REJECT-1'`)).toBe(0);
  });

  // ── the list filters ───────────────────────────────────────────────────────

  it('the timeline filters: type (repeatable, registry-validated), from/to on recorded_at, orderId, shortPick', async () => {
    const base = `${API}/${tenantId}/warehouses/${warehouseId}/inventory/events`;
    const get = (query: Record<string, string | string[]>) =>
      request(app.getHttpServer()).get(base).query(query).set('Authorization', `Bearer ${accountantToken}`);
    const picks = (await get({ type: 'pick.picked', limit: '200' }).expect(200)).body.items as { type: string }[];
    expect(picks.length).toBeGreaterThan(0);
    expect(new Set(picks.map((e) => e.type))).toEqual(new Set(['pick.picked']));
    const both = (await get({ type: ['pick.picked', 'dispatch.dispatched'], limit: '200' }).expect(200)).body.items as { type: string }[];
    expect(new Set(both.map((e) => e.type))).toEqual(new Set(['pick.picked', 'dispatch.dispatched']));
    const byOrder = (await get({ orderId: dispatchedOrders[0]!, limit: '200' }).expect(200)).body.items as { referenceDoc: { orderId: string } }[];
    expect(byOrder.length).toBeGreaterThanOrEqual(3); // pick + pack + dispatch
    expect(byOrder.every((e) => e.referenceDoc.orderId === dispatchedOrders[0])).toBe(true);
    expect((await get({ shortPick: 'true' }).expect(200)).body.items).toEqual([]); // the only short drew nothing
    expect(((await get({ shortPick: 'false', limit: '200' }).expect(200)).body.items as unknown[]).length).toBeGreaterThan(0);
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await get({ from: future }).expect(200)).body.items).toEqual([]);

    // The 400 arms, each named.
    const unknown = await get({ type: 'pick.teleported' }).expect(400);
    expect(unknown.body.code).toBe('validation-failed');
    expect(unknown.body.detail).toContain('pick.teleported');
    expect(unknown.body.detail).toContain('pick.picked');
    expect((await get({ from: '2026-10-06' }).expect(400)).body.detail).toContain('from');
    expect((await get({ from: '2026-10-06T10:00:00' }).expect(400)).body.code).toBe('validation-failed');
    const inverted = await get({ from: '2026-10-06T10:00:00Z', to: '2026-10-06T10:00:00Z' }).expect(400);
    expect(inverted.body.code).toBe('validation-failed');
    expect(inverted.body.detail).toContain('from must be strictly before to');
    expect((await get({ shortPick: 'yes' }).expect(400)).body.detail).toContain('shortPick');
    expect((await get({ shortPick: '1' }).expect(400)).body.code).toBe('validation-failed');
  });

  it('the other list filters: orders, over-receipts, goods-receipts, batch-alerts, e-way bills, invoices, picklist lines — and their 400 arms', async () => {
    const list = (path: string, query: Record<string, string>) =>
      request(app.getHttpServer()).get(`${API}/${tenantId}/${path}`).query(query).set('Authorization', `Bearer ${accountantToken}`);
    const orders = (await list(`warehouses/${warehouseId}/outbound/orders`, { status: 'dispatched' }).expect(200)).body.items as { id: string }[];
    expect(orders.map((o) => o.id).sort()).toEqual([...dispatchedOrders].sort());
    expect(((await list(`warehouses/${warehouseId}/outbound/orders`, { source: 'ingested', backordered: 'true' }).expect(200)).body.items as unknown[]).length).toBe(1);
    expect(((await list(`warehouses/${warehouseId}/outbound/orders`, { source: 'ingested', backordered: 'false' }).expect(200)).body.items as unknown[]).length).toBe(0);
    await list(`warehouses/${warehouseId}/outbound/orders`, { backordered: 'maybe' }).expect(400);
    await list(`warehouses/${warehouseId}/outbound/orders`, { status: 'teleported' }).expect(400);
    // Story 21-6: `poless` is the alias of `blind` — it means the blind REASON, not the absent PO.
    expect(((await list('receiving/goods-receipts', { warehouseId, poless: 'true' }).expect(200)).body.items as { blindReasonCode: string | null }[]).every((g) => g.blindReasonCode !== null)).toBe(true);
    expect(((await list('receiving/goods-receipts', { warehouseId, poless: 'false' }).expect(200)).body.items as { blindReasonCode: string | null }[]).every((g) => g.blindReasonCode === null)).toBe(true);
    await list('receiving/over-receipts', { warehouseId: uuidv7() }).expect(404);
    expect(((await list('receiving/over-receipts', { warehouseId: emptyWarehouseId }).expect(200)).body.items as unknown[]).length).toBe(0);
    await list('eway/bills', { warehouseId: uuidv7() }).expect(404);
    expect(((await list('eway/bills', { warehouseId, source: 'manual' }).expect(200)).body.items as unknown[]).length).toBe(1);
    await list('eway/bills', { source: 'robot' }).expect(400);
    expect(((await list('invoices', { warehouseId: emptyWarehouseId }).expect(200)).body.items as unknown[]).length).toBe(0);
    expect(((await list('invoices', { warehouseId }).expect(200)).body.items as unknown[]).length).toBe(3);
    await list('replenishment/batch-alerts', { from: 'yesterday' }).expect(400);
    const shorts = (await list(`warehouses/${warehouseId}/outbound/picklist-lines`, { status: 'short' }).expect(200)).body.items as {
      skuId: string;
      shortfallQty: number;
      reasonCode: string;
    }[];
    expect(shorts).toEqual([expect.objectContaining({ skuId: sku('RPT-ZERO'), reasonCode: 'bin-empty' })]);
    await list(`warehouses/${warehouseId}/outbound/picklist-lines`, { status: 'lost' }).expect(400);
    await list(`warehouses/${uuidv7()}/outbound/pack-failures`, {}).expect(404);
    await list(`warehouses/${warehouseId}/outbound/backorder-refusals`, { from: '2026-10-07T00:00:00Z', to: '2026-10-06T00:00:00Z' }).expect(400);
  });

  // ── the database ───────────────────────────────────────────────────────────

  it('both fact tables fail closed under RLS (the wms_rls_probe role), and the entry CHECK pins the TS tuple', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      for (const table of ['pack_verification_failures', 'ingest_backorder_refusals']) {
        expect(await countRows(sql.unsafe(`select count(*) as n from ${table} where tenant_id = $1`, [tenantId]) as never)).toBeGreaterThan(0);
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
    const check = (await sql`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'pack_verification_failures_entry_check'`) as unknown as { def: string }[];
    const inDb = [...check[0]!.def.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(inDb.sort()).toEqual([...PACK_FAILURE_ENTRIES].sort());
  });

  it('the OpenAPI document carries the overview and the three new lists', () => {
    const doc = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8')) as { paths: Record<string, unknown> };
    for (const path of [
      '/tenants/{tenantId}/warehouses/{warehouseId}/reporting/overview',
      '/tenants/{tenantId}/warehouses/{warehouseId}/outbound/picklist-lines',
      '/tenants/{tenantId}/warehouses/{warehouseId}/outbound/pack-failures',
      '/tenants/{tenantId}/warehouses/{warehouseId}/outbound/backorder-refusals',
    ]) {
      expect(Object.keys(doc.paths)).toContain(path);
    }
  });

  // ── review round 1 ─────────────────────────────────────────────────────────

  it('every INTEGRATION_CALL_STATUSES member is classified for the sync tile (a new status fails the build — and this test)', () => {
    expect(Object.keys(INGEST_CALL_OUTCOMES).sort()).toEqual([...INTEGRATION_CALL_STATUSES].sort());
    for (const status of ['ok', 'accepted', 'backordered', 'replayed', 'rejected', 'released', 'ignored'] as const) {
      expect({ status, outcome: INGEST_CALL_OUTCOMES[status] }).toEqual({ status, outcome: 'not-failure' });
    }
    for (const status of ['failed', 'unmapped', 'validation-failed', 'cancellation-unresolved'] as const) {
      expect({ status, outcome: INGEST_CALL_OUTCOMES[status] }).toEqual({ status, outcome: 'failure' });
    }
  });

  it('two concurrent overview reads never hold more than 3 reporting tile transactions at once (the process-wide semaphore)', async () => {
    const facade = app.get(ReportingFacade);
    const original = facade.tiles;
    let active = 0;
    let peak = 0;
    facade.tiles = original.map((tile) => ({
      ...tile,
      run: async (tx, ctx) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await tx.execute(dsql`select pg_sleep(0.05)`);
          return await tile.run(tx, ctx);
        } finally {
          active -= 1;
        }
      },
    })) as TileDefinition[];
    try {
      const [a, b] = await Promise.all([readOverview(), readOverview()]);
      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThanOrEqual(2); // the counter really saw overlap
      expect(a.stale).toBe(false);
      expect(b.stale).toBe(false);
    } finally {
      facade.tiles = original;
    }
  });

  it('a retried failed pack (same Idempotency-Key) records ONE failure row', async () => {
    const key = ulid();
    const send = () =>
      request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/orders/${packMismatchOrder}/pack`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, key)
        .send({ scanned: [{ skuId: sku('RPT-MISS'), qty: 9 }] });
    await send().expect(422);
    await send().expect(422);
    expect(await countRows(sql`select count(*) as n from pack_verification_failures where idempotency_key = ${key}`)).toBe(1);
  });

  it('a refused channel event later redelivered and ACCEPTED is no longer "prevented" — tile and drill list alike', async () => {
    const before = (await readOverview()).tiles.oversell.prevented.d7.value!;
    await expect(ingest([{ skuId: sku('RPT-CHAN'), quantity: 50 }], integrationId, 'EVT-LATE-1', 'reject')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'order-backorder-rejected' }),
    });
    const refused = await readOverview();
    expect(refused.tiles.oversell.prevented.d7.value).toBe(before + 1);
    await ingest([{ skuId: sku('RPT-CHAN'), quantity: 50 }], integrationId, 'EVT-LATE-1', 'accept');
    const accepted = await readOverview();
    expect(accepted.tiles.oversell.prevented.d7.value).toBe(before);
    expect(await pageDrill(accepted.tiles.oversell.prevented.d7.drill)).toBe(before);
    // The refusal row itself stands — the exclusion is read-side.
    expect(await countRows(sql`select count(*) as n from ingest_backorder_refusals where external_event_id = 'EVT-LATE-1'`)).toBe(1);
  });

  it('the timeline: an UPPERCASE orderId matches; a partial short pick is exactly what shortPick=true returns; a non-boolean stored shortPick never 500s', async () => {
    const base = `${API}/${tenantId}/warehouses/${warehouseId}/inventory/events`;
    const get = (query: Record<string, string>, warehouse = warehouseId) =>
      request(app.getHttpServer())
        .get(base.replace(warehouseId, warehouse))
        .query(query)
        .set('Authorization', `Bearer ${accountantToken}`);
    const lower = (await get({ orderId: dispatchedOrders[0]!, limit: '200' }).expect(200)).body.items as unknown[];
    const upper = (await get({ orderId: dispatchedOrders[0]!.toUpperCase(), limit: '200' }).expect(200)).body.items as unknown[];
    expect(lower.length).toBeGreaterThan(0);
    expect(upper).toHaveLength(lower.length);

    // A partial short pick: 3 planned, 2 drawn.
    const partSku = sku('RPT-PART');
    await seedStock(partSku, 3);
    const partOrder = await createOrder([{ skuId: partSku, quantity: 3 }]);
    const [partLine] = await releasedWave(partOrder);
    await pick(partLine!, { qty: 2, reasonCode: 'fewer-units-than-planned' }).expect(201);
    const shorts = (await get({ shortPick: 'true', limit: '200' }).expect(200)).body.items as {
      referenceDoc: { orderId: string; shortPick?: boolean };
    }[];
    expect(shorts).toHaveLength(1);
    expect(shorts[0]!.referenceDoc).toMatchObject({ orderId: partOrder, shortPick: true });

    // A stored non-boolean shortPick (a raw row in the EMPTY warehouse, its
    // own chain) reads as "not a short pick" — never a 500.
    await sql`
      insert into ledger_events (id, tenant_id, client_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta,
        actor_user_id, occurred_at, recorded_at, reference_doc, prev_hash, event_hash)
      select ${uuidv7()}, ${tenantId}, c.id, ${emptyWarehouseId}, 1, 'stock.adjusted', 1, ${partSku}, 0,
        ${ownerId}, now(), now(), ${sql.json({ kind: 'manual-adjustment', reasonCode: 'x', note: 'x', shortPick: 'yes' } as never)},
        ${'0'.repeat(64)}, ${'f'.repeat(64)}
      from clients c where c.tenant_id = ${tenantId} limit 1`;
    expect((await get({ shortPick: 'true' }, emptyWarehouseId).expect(200)).body.items).toEqual([]);
    expect((await get({ shortPick: 'false' }, emptyWarehouseId).expect(200)).body.items).toHaveLength(1);
    await sql.begin(async (tx) => {
      await tx.unsafe('set local session_replication_role = replica');
      await tx`delete from ledger_events where warehouse_id = ${emptyWarehouseId}`;
    });
  });

  it('tie groups page whole at limit 2: three over-receipts from ONE GRN, three picklist lines from ONE wave', async () => {
    const codes = ['RPT-T1', 'RPT-T2', 'RPT-T3'] as const;
    const po = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inbound/purchase-orders`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, vendorId, code: `PO-${ulid().slice(10, 18)}`, lines: codes.map((c) => ({ skuId: sku(c), orderedQty: 1, unitCostPaise: 100 })) })
        .expect(201)
    ).body.purchaseOrder as { id: string; lines: { id: string; skuId: string }[] };
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        poId: po.id,
        blindReasonCode: null,
        occurredAt: now(),
        lines: po.lines.map((line) => ({ poLineId: line.id, skuId: line.skuId, batchCode: null, mfgDate: null, qty: 3 })),
      })
      .expect(201);
    const tied = await countRows(sql`
      select count(*) as n from over_receipts where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
        and created_at = (select max(created_at) from over_receipts where tenant_id = ${tenantId})`);
    expect(tied).toBe(3);
    const overTotal = await countRows(sql`select count(*) as n from over_receipts where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}`);
    expect(await pageDrill({ apiPath: `/tenants/${tenantId}/receiving/over-receipts`, query: { warehouseId }, reconciles: true })).toBe(overTotal);

    for (const code of codes) await seedStock(sku(code), 1);
    const order = await createOrder(codes.map((code) => ({ skuId: sku(code), quantity: 1 })));
    const lines = await releasedWave(order);
    expect(lines).toHaveLength(3);
    const planned = await countRows(sql`
      select count(*) as n from picklist_lines pl join picklists p on p.id = pl.picklist_id
      where pl.tenant_id = ${tenantId} and p.warehouse_id = ${warehouseId} and pl.status = 'planned'`);
    expect(planned).toBeGreaterThanOrEqual(3);
    expect(
      await pageDrill({ apiPath: `/tenants/${tenantId}/warehouses/${warehouseId}/outbound/picklist-lines`, query: { status: 'planned' }, reconciles: true }),
    ).toBe(planned);
  });

  it('the list 404/0 arms: e-way bills of the empty warehouse are 0; invoices of an unknown warehouse are 404', async () => {
    const list = (path: string, query: Record<string, string>) =>
      request(app.getHttpServer()).get(`${API}/${tenantId}/${path}`).query(query).set('Authorization', `Bearer ${accountantToken}`);
    expect((await list('eway/bills', { warehouseId: emptyWarehouseId }).expect(200)).body.items).toEqual([]);
    expect((await list('invoices', { warehouseId: uuidv7() }).expect(404)).body.code).toBe('not-found');
  });

  it('an inverted window is 400 validation-failed on every route that takes one', async () => {
    const routes = [
      `warehouses/${warehouseId}/inventory/events`,
      `warehouses/${warehouseId}/outbound/orders`,
      `warehouses/${warehouseId}/outbound/picklist-lines`,
      `warehouses/${warehouseId}/outbound/pack-failures`,
      `warehouses/${warehouseId}/outbound/backorder-refusals`,
      'receiving/goods-receipts',
      'receiving/over-receipts',
      'replenishment/batch-alerts',
      'eway/bills',
      'invoices',
    ];
    for (const route of routes) {
      const res = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/${route}`)
        .query({ from: '2026-10-06T10:00:00Z', to: '2026-10-05T10:00:00Z' })
        .set('Authorization', `Bearer ${accountantToken}`);
      expect({ route, status: res.status, code: res.body.code }).toEqual({ route, status: 400, code: 'validation-failed' });
      expect(res.body.detail).toContain('from must be strictly before to');
    }
  });

  it('rows outside today: each windowed source gets one row backdated into the 7-day window and one before it — today < d7, and every drill still reconciles on both windows', async () => {
    const window = reportingWindow(new Date());
    const mid = new Date(Date.parse(window.todayFrom) - 3600_000).toISOString();
    const old = new Date(Date.parse(window.d7From) - 86_400_000).toISOString();
    const sources: { table: string; column: string; where: postgres.PendingQuery<postgres.Row[]> | null }[] = [
      { table: 'picks', column: 'created_at', where: null },
      { table: 'picklist_lines', column: 'updated_at', where: sql`status = 'short'` },
      { table: 'over_receipts', column: 'requested_at', where: null },
      { table: 'goods_receipt_notes', column: 'created_at', where: sql`po_id is null` },
      { table: 'pack_verification_failures', column: 'created_at', where: null },
      { table: 'ingest_backorder_refusals', column: 'created_at', where: null },
      { table: 'orders', column: 'created_at', where: sql`source = 'ingested'` },
      { table: 'batch_alerts', column: 'created_at', where: null },
      { table: 'eway_bills', column: 'created_at', where: sql`status <> 'dismissed'` },
      { table: 'invoices', column: 'issued_at', where: null },
      { table: 'ledger_events', column: 'recorded_at', where: sql`type = 'dispatch.dispatched'` },
    ];
    await sql.begin(async (tx) => {
      // The ledger is append-only by trigger; this is a test about windows.
      await tx.unsafe('set local session_replication_role = replica');
      for (const source of sources) {
        const ids = (await tx`
          select id from ${tx(source.table)} where tenant_id = ${tenantId}
          ${source.where === null ? tx`` : tx`and ${source.where}`}
          order by id limit 2`) as unknown as { id: string }[];
        expect({ table: source.table, rows: ids.length >= 1 }).toEqual({ table: source.table, rows: true });
        await tx`update ${tx(source.table)} set ${tx(source.column)} = ${mid} where id = ${ids[0]!.id}`;
        if (ids[1] !== undefined) {
          await tx`update ${tx(source.table)} set ${tx(source.column)} = ${old} where id = ${ids[1].id}`;
        }
      }
    });
    const overview = await readOverview();
    const t = overview.tiles;
    for (const [path, figure] of [
      ['pickLines', t.pickRate.pickLines],
      ['shortLines', t.shortPicks.shortLines],
      ['overReceipts', t.grnVariances.overReceipts],
      ['blindGrns', t.grnVariances.blindGrns],
      ['packFailures', t.orderAccuracy.packFailures],
      ['dispatchedLines', t.orderAccuracy.dispatchedLines],
      ['backorderedOrders', t.oversell.backorderedOrders],
      ['raised', t.expiryAlerts.raised],
      ['eligible', t.sm8.eligible],
      ['invoicesIssued', t.sm8.invoicesIssued],
    ] as const) {
      expect({ path, todayBelowD7: figure.today.value! < figure.d7.value! }).toEqual({ path, todayBelowD7: true });
    }
    const mismatches: string[] = [];
    for (const { path, figure } of figures(overview).filter(({ figure }) => figure.drill.reconciles)) {
      const paged = await pageDrill(figure.drill);
      if (paged !== figure.value) mismatches.push(`${path}: tile ${figure.value} vs drill ${paged}`);
    }
    expect(mismatches).toEqual([]);
  });
});
