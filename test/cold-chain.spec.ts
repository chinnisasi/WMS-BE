import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions — the same bootstrap the sibling suites run.
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

interface Picklist {
  id: string;
  waveId: string;
  orderId: string | null;
  status: string;
  lines: PickLine[];
}

interface Wave {
  id: string;
  status: string;
  picklists: Picklist[];
}

interface ChainEvent {
  seq: number;
  type: string;
  skuId: string;
  quantityDelta: number;
  fromBinId: string | null;
  fromBinStorageClass: string | null;
  toBinId: string | null;
  toBinStorageClass: string | null;
  batchRef: string | null;
  serialRef: string | null;
  occurredAt: string;
  referenceDoc: Record<string, unknown>;
}

interface TraceLine {
  orderLineId: string;
  skuId: string;
  dispatchedQty: number;
  scopes: { batchRef: string | null; serialRef: string | null; chain: ChainEvent[] }[];
  excursions: { excursionId: string; binId: string; readingC: number; occurredAt: string }[];
}

interface Trace {
  order: {
    id: string;
    status: string;
    carrierName: string | null;
    trackingNumber: string | null;
    dispatchedAt: string;
  };
  bins: { id: string; code: string; storageClass: string }[];
  lines: TraceLine[];
}

/**
 * Story 12-6 (FR-45) — the cold-chain read: one dispatched order's storage
 * trace, reconstructed from `ledger_events` alone. The suite drives the real
 * HTTP flow end to end — blind GRN → partial putaways → excursion + QC
 * round-trip → order → wave → picks → pack → dispatch — then reads the trace
 * and walks every matrix row: the annotated chain, the dwell-window
 * excursion correlation (in-window attaches once, out-of-window does not),
 * the clean multi-scope line, and the 409/404 arms.
 *
 * Business times are chosen so the LEDGER's commit order and the DWELL
 * windows agree: receive(-60m) → putaway CH(-50m)/FR(-49m) → excursion(-40m,
 * its qc.held rides the server clock at commit) → release (server clock) →
 * picks(-30m) → pack/dispatch (server clock) → the out-of-dwell excursion
 * (server clock at ITS commit, strictly after every departure). The
 * CH-01 dwell window is [putaway, qc.held@commit]; the excursion inside it is
 * the -40m reading, the later commit-time excursion falls after departure.
 */
describe('cold-chain trace: the FR-45 reconstruction read (e2e, story 12-6)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let warehouseId: string;
  let zoneId: string;
  let binCh: string; // CH-01, chilled
  let binFr: string; // FR-01, frozen
  let binAmbA: string; // AMB-01, ambient
  let binAmbB: string; // AMB-02, ambient
  const skuIds = new Map<string, string>();

  let deviceToken: string;
  let operatorToken: string; // the badge-in DEVICE session (floor ops)

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('cold_chain');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `ColdChain Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const signIn = (address: string, password: string) =>
      request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: address, password })
        .expect(200)
        .then((res) => res.body.accessToken as string);
    ownerToken = await signIn(email, 'correct-horse-battery');
    opsToken = await inviteAndSignIn('ops_manager', 'ops-password-123');

    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `CC-${ulid().slice(10, 16).toUpperCase()}`, name: `ColdChain WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
    zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binCh = await createBin('CH-01', 'chilled');
    binFr = await createBin('FR-01', 'frozen');
    binAmbA = await createBin('AMB-01', 'ambient');
    binAmbB = await createBin('AMB-02', 'ambient');

    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode,storage_class';
    const csv = [
      csvHeader,
      `CC-BATCH,Cold-chain batch SKU,pcs,,1800,,true,false,,,,chilled`,
      `CC-MULTI,Multi-scope ambient SKU,pcs,,1800,,true,false,,,,ambient`,
      `CC-ACCEPT,Undispatched-order SKU,pcs,,1800,,false,false,,,,ambient`,
      `CC-SERIAL,Serial-tracked SKU,pcs,,1800,,false,true,,,,ambient`,
      `CC-LINEA,Excursion line A SKU,pcs,,1800,,true,false,,,,ambient`,
      `CC-LINEB,Excursion line B SKU,pcs,,1800,,true,false,,,,ambient`,
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
    expect(skuIds.size).toBeGreaterThanOrEqual(3);

    // The floor device + its badge-in operator (receiving, putaway, picking).
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Cold-chain scanner', pin: '2468' })
      .expect(201);
    deviceToken = enrolled.body.deviceToken as string;
    const operatorEmail = `floor-${ulid().toLowerCase()}@example.com`;
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
    const badged = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ operatorEmail, pin: '2468' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;

    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
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
      for (const table of ['picks', 'picklist_lines', 'picklists', 'waves', 'wave_policies', 'order_lines', 'orders']) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      for (const table of [
        'reservations',
        'qc_holds',
        'temperature_excursions',
        'serials',
        'batch_on_hand',
        'stock_on_hand',
        'outbox_messages',
        'idempotency_keys',
        'audit_events',
        'catalog_import_errors',
        'catalog_imports',
        'uom_conversions',
        'putaway_placements',
        'batches',
        'skus',
        'devices',
        'bins',
        'zones',
        'warehouses',
        'users',
        'tenants',
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
    return request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email: address, password })
      .expect(200)
      .then((res) => res.body.accessToken as string);
  }

  async function createBin(code: string, storageClass?: string): Promise<string> {
    return (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 10000, type: 'shelf', code, ...(storageClass === undefined ? {} : { storageClass }) })
        .expect(201)
    ).body.id as string;
  }

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  /** Business time relative to the suite's start — Z-suffixed, second precision. */
  function at(minutesFromNow: number): string {
    return new Date(Date.now() + minutesFromNow * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  }

  async function seedStockBatch(
    skuId: string,
    binId: string,
    quantity: number,
    batchCode: string,
    occurredAt?: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId,
        quantityDelta: quantity,
        reasonCode: 'cycle-count',
        note: 'cold-chain-suite seed',
        batch: { code: batchCode },
        ...(occurredAt === undefined ? {} : { occurredAt }),
      })
      .expect(201);
  }

  async function seedStock(skuId: string, binId: string, quantity: number, occurredAt?: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId,
        quantityDelta: quantity,
        reasonCode: 'cycle-count',
        note: 'cold-chain-suite seed',
        ...(occurredAt === undefined ? {} : { occurredAt }),
      })
      .expect(201);
  }

  async function batchIdByCode(code: string): Promise<string> {
    const rows = await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku('CC-MULTI')} and code = ${code}`;
    const row = rows[0] as unknown as { id: string } | undefined;
    if (row === undefined) throw new Error(`fixture batch ${code} not found`);
    return row.id;
  }

  async function createOrder(lines: { skuId: string; quantity: number }[], wh = warehouseId): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, lines, destination: testAddress() })
      .expect(201);
    return res.body.order.id as string;
  }

  async function releasedWave(lines: { skuId: string; quantity: number }[]): Promise<{ waveId: string; orderId: string; picklist: Picklist }> {
    const orderId = await createOrder(lines);
    const policyId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/wave-policies`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, name: `cc-${ulid().slice(10, 18)}`, grouping: 'single' })
        .expect(201)
    ).body.policy.id as string;
    const waveId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/waves`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, policyId, orderIds: [orderId] })
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
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body.wave as Wave;
    const picklist = wave.picklists[0];
    if (picklist === undefined) throw new Error('fixture produced no picklist');
    return { waveId, orderId, picklist };
  }

  async function pickAllLines(
    picklist: Picklist,
    occurredAt?: string,
    serialsByLine?: Map<string, string[]>,
  ): Promise<void> {
    for (const line of picklist.lines) {
      await request(app.getHttpServer())
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
          occurredAt: occurredAt ?? at(0),
          ...(serialsByLine === undefined ? {} : { serials: serialsByLine.get(line.id) }),
        })
        .expect(201);
    }
  }

  async function packAndDispatch(
    orderId: string,
    scanned: { skuId: string; qty: number }[],
    dispatchBody: Record<string, unknown> = {},
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send(dispatchBody)
      .expect(201);
  }

  async function submitGrn(
    skuId: string,
    batchCode: string,
    qty: number,
    occurredAt?: string,
  ): Promise<{ grnId: string; grnLineId: string; batchId: string }> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        poId: null,
        blindReasonCode: 'unannounced-delivery',
        occurredAt: occurredAt ?? at(0),
        lines: [{ poLineId: null, skuId, batchCode, mfgDate: null, qty }],
      })
      .expect(201);
    const grn = res.body.goodsReceipt as {
      id: string;
      lines: { id: string; skuId: string; batchId: string; qty: number }[];
    };
    const line = grn.lines.find((l) => l.skuId === skuId)!;
    return { grnId: grn.id, grnLineId: line.id, batchId: line.batchId };
  }

  async function place(
    grn: { grnId: string; grnLineId: string; batchId: string },
    skuId: string,
    qty: number,
    toBinId: string,
    occurredAt?: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/putaway/placements`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        grnId: grn.grnId,
        grnLineId: grn.grnLineId,
        skuId,
        batchId: grn.batchId,
        qty,
        toBinId,
        reasonCode: null,
        occurredAt: occurredAt ?? at(0),
      })
      .expect(201);
  }

  function recordExcursion(
    body: { warehouseId: string; binId: string; readingC: number; note?: string; occurredAt?: string },
    key = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/excursions`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function releaseHold(holdId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/qc-holds/${holdId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
  }

  function trace(orderId: string, wh = warehouseId): request.Test {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${wh}/cold-chain/orders/${orderId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  // ── the happy path + every matrix row ──────────────────────────────────────

  let excursionOneId: string;
  let batchB77: string;
  let orderId: string;

  it('happy path: a dispatched batch-tracked order whose picked batch dwelt in two bins and survived an excursion at one of them reconstructs the full annotated chain', async () => {
    // Receive 4 units of the batch SKU (blind, batch CC-B-77), then split the
    // putaway across the two cold bins — the batch dwells in both.
    const grn = await submitGrn(sku('CC-BATCH'), 'CC-B-77', 4, at(-60));
    batchB77 = grn.batchId;
    await place(grn, sku('CC-BATCH'), 2, binCh, at(-50));
    await place(grn, sku('CC-BATCH'), 2, binFr, at(-49));

    // An excursion at CH-01 quarantines the 2 units sitting there; the
    // release moves them back so the later pick can draw them. The excursion's
    // ledger event (reading 8.5, business -40m) is what the trace correlates.
    const excursionOneAt = at(-40); // captured once — the suite's clock moves
    const excursion = await recordExcursion({
      warehouseId,
      binId: binCh,
      readingC: 8.5,
      note: 'door left open',
      occurredAt: excursionOneAt,
    }).expect(201);
    excursionOneId = excursion.body.excursion.id as string;
    const holdId = (excursion.body.excursion.holdIds as string[])[0]!;
    await releaseHold(holdId);

    const wave = await releasedWave([{ skuId: sku('CC-BATCH'), quantity: 4 }]);
    orderId = wave.orderId;
    expect(wave.picklist.lines.length).toBe(2); // 2 from CH-01 + 2 from FR-01
    await pickAllLines(wave.picklist, at(-30));
    await packAndDispatch(orderId, [{ skuId: sku('CC-BATCH'), qty: 4 }], {
      carrierName: 'blue_dart',
      trackingNumber: 'CC-TRK-1',
    });

    const res = await trace(orderId).expect(200);
    const body = res.body as Trace;
    expect(body.order).toMatchObject({
      id: orderId,
      status: 'dispatched',
      carrierName: 'blue_dart',
      trackingNumber: 'CC-TRK-1',
    });
    expect(Date.parse(body.order.dispatchedAt)).toBeGreaterThan(Date.parse(at(-5)));

    expect(body.lines).toHaveLength(1);
    const line = body.lines[0]!;
    expect(line.dispatchedQty).toBe(4);
    expect(line.skuId).toBe(sku('CC-BATCH'));
    expect(line.orderLineId).toBeTruthy();

    // ONE scope — both picks drew the same batch; its chain is the batch's
    // COMPLETE ARMED history: grn → 2 putaways → qc round-trip → 2 picks.
    // (The excursion.recorded event carries no batch/serial arm — one event
    // per (sku, bin) scope — so it surfaces through `excursions`, not the
    // chain; the zero-arm pack/dispatch events stay out for the same reason.)
    expect(line.scopes).toHaveLength(1);
    const scope = line.scopes[0]!;
    expect(scope.batchRef).toBe(batchB77);
    expect(scope.serialRef).toBeNull();
    expect(scope.chain.map((e) => e.type)).toEqual([
      'grn.received',
      'putaway.placed',
      'putaway.placed',
      'qc.held',
      'qc.released',
      'pick.picked',
      'pick.picked',
    ]);
    expect(scope.chain.map((e) => e.seq)).toEqual(
      [...scope.chain.map((e) => e.seq)].sort((a, b) => a - b),
    );

    const [grnEvent, putCh, putFr, qcHeld, qcReleased, pickCh, pickFr] = scope.chain;
    expect(grnEvent!.quantityDelta).toBe(4);
    expect(putCh!.quantityDelta).toBe(2);
    expect(putCh!.fromBinStorageClass).toBe('ambient'); // the RECEIVING staging bin
    expect(putCh!.toBinId).toBe(binCh);
    expect(putCh!.toBinStorageClass).toBe('chilled');
    expect(putFr!.toBinId).toBe(binFr);
    expect(putFr!.toBinStorageClass).toBe('frozen');
    expect(qcHeld!.fromBinId).toBe(binCh);
    expect(qcHeld!.toBinStorageClass).toBe('ambient'); // the QC-HOLD system bin
    expect(qcReleased!.toBinId).toBe(binCh);
    expect(pickCh!.quantityDelta).toBe(-2);
    expect(pickCh!.fromBinId).toBe(binCh);
    expect(pickCh!.fromBinStorageClass).toBe('chilled');
    expect(pickCh!.toBinId).toBeNull();
    expect(pickCh!.toBinStorageClass).toBeNull();
    expect(pickFr!.fromBinStorageClass).toBe('frozen');
    for (const pickEvent of [pickCh!, pickFr!]) {
      const ref = pickEvent.referenceDoc as { kind: string; orderId?: string };
      expect(ref.kind).toBe('pick');
      expect(ref.orderId).toBe(orderId);
    }

    // The bins dictionary covers every chain bin, with the CURRENT classes.
    const binByCode = new Map(body.bins.map((b) => [b.code, b]));
    expect(binByCode.get('CH-01')).toMatchObject({ id: binCh, storageClass: 'chilled' });
    expect(binByCode.get('FR-01')).toMatchObject({ id: binFr, storageClass: 'frozen' });
    expect(binByCode.has('RECEIVING')).toBe(true);
    expect(binByCode.has('QC-HOLD')).toBe(true);
    for (const event of scope.chain) {
      for (const binId of [event.fromBinId, event.toBinId]) {
        if (binId !== null) {
          expect(body.bins.some((b) => b.id === binId)).toBe(true);
        }
      }
    }

    // The excursion appears EXACTLY ONCE, correlated to the CH-01 dwell window
    // (arrival at the -50m putaway, departure at the pick — whose ledger
    // business time is -30m even though the qc round-trip rode the server
    // clock in between).
    expect(line.excursions).toHaveLength(1);
    expect(line.excursions[0]).toMatchObject({
      excursionId: excursionOneId,
      binId: binCh,
      readingC: 8.5,
    });
    // Postgres's text shape carries the millisecond field; compare instants.
    expect(Date.parse(line.excursions[0]!.occurredAt)).toBe(Date.parse(excursionOneAt));
  });

  it('outside the dwell: an excursion at a chain bin recorded after the batch departed does not appear', async () => {
    // Seed a LATER batch of the same SKU into CH-01 (after the order's pick
    // already departed), then record a fresh excursion there at its commit
    // time — strictly after the scope's last departure from CH-01.
    await seedStockBatch(sku('CC-BATCH'), binCh, 3, 'CC-B-88', at(-15));
    const later = await recordExcursion({
      warehouseId,
      binId: binCh,
      readingC: 2.0,
      note: 'after departure',
    }).expect(201);
    expect(later.body.excursion.id as string).not.toBe(excursionOneId);

    const body = (await trace(orderId).expect(200)).body as Trace;
    const line = body.lines[0]!;
    expect(line.excursions).toHaveLength(1);
    expect(line.excursions[0]!.excursionId).toBe(excursionOneId);
    // The new batch's chain is untouched by the order trace: no scope names it.
    const foreign = line.scopes.find((s) => s.batchRef !== batchB77);
    expect(foreign).toBeUndefined();
  });

  it('multi-scope line: one line picked from two batches gives one chain per batch scope, clean line carries excursions: []', async () => {
    await seedStockBatch(sku('CC-MULTI'), binAmbA, 2, 'CC-MA', at(-20));
    await seedStockBatch(sku('CC-MULTI'), binAmbB, 2, 'CC-MB', at(-20));
    const batchA = await batchIdByCode('CC-MA');
    const batchB = await batchIdByCode('CC-MB');

    const wave = await releasedWave([{ skuId: sku('CC-MULTI'), quantity: 4 }]);
    expect(wave.picklist.lines.length).toBe(2);
    await pickAllLines(wave.picklist, at(-5));
    await packAndDispatch(wave.orderId, [{ skuId: sku('CC-MULTI'), qty: 4 }]);

    const body = (await trace(wave.orderId).expect(200)).body as Trace;
    // No carrier facts on the dispatch → nulls, and the clean line → [].
    expect(body.order.carrierName).toBeNull();
    expect(body.order.trackingNumber).toBeNull();
    expect(body.lines).toHaveLength(1);
    const line = body.lines[0]!;
    expect(line.dispatchedQty).toBe(4);
    expect(line.excursions).toEqual([]);
    expect(line.scopes).toHaveLength(2);
    const refs = line.scopes.map((s) => s.batchRef).sort();
    expect(refs).toEqual([batchA, batchB].sort());
    for (const scope of line.scopes) {
      expect(scope.serialRef).toBeNull();
      expect(scope.chain.map((e) => e.type)).toEqual(['stock.adjusted', 'pick.picked']);
      const adjusted = scope.chain[0]!;
      expect(adjusted.quantityDelta).toBe(2);
      expect(adjusted.toBinStorageClass).toBe('ambient');
      const picked = scope.chain[1]!;
      expect(picked.quantityDelta).toBe(-2);
      expect(picked.fromBinStorageClass).toBe('ambient');
      const ref = picked.referenceDoc as { kind: string; orderId?: string };
      expect(ref.kind).toBe('pick');
      expect(ref.orderId).toBe(wave.orderId);
    }
  });

  it('undispatched order: 409 order-not-dispatched', async () => {
    await seedStock(sku('CC-ACCEPT'), binAmbA, 2);
    const undispatched = await createOrder([{ skuId: sku('CC-ACCEPT'), quantity: 1 }]);
    const res = await trace(undispatched).expect(409);
    expect(res.body.code ?? (res.body as Record<string, unknown>).code).toBe('order-not-dispatched');
  });

  it('missing order: 404 not-found; foreign warehouse: 404 not-found; malformed ids: 400', async () => {
    const missing = crypto.randomUUID();
    await trace(missing).expect(404);
    // The REAL order traced against a warehouse it does not belong to is as
    // invisible as a missing one.
    const foreign = crypto.randomUUID();
    const res = await trace(orderId, foreign).expect(404);
    expect((res.body as Record<string, unknown>).code).toBe('not-found');
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/cold-chain/orders/not-a-uuid`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
  });

  it('cross-tenant session: 403 permission-denied (the path names the first tenant, the token does not)', async () => {
    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Other Co ${ulid()}`, ownerEmail: emailB, password: 'correct-horse-battery' })
      .expect(201);
    createdTenantIds.push(registered.body.tenant.id as string);
    const tokenB = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email: emailB, password: 'correct-horse-battery' })
      .expect(200)
      .then((res) => res.body.accessToken as string);

    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/cold-chain/orders/${orderId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
    expect(res.body).toMatchObject({ code: 'permission-denied' });
  });

  it('serial-tracked order: one scope per serial, batchRef null, each serial carrying its own ledger chain', async () => {
    const binSer = await createBin('SER-01', 'ambient');
    const serialA = `CC-SN-${ulid().slice(10, 14)}`;
    const serialB = `CC-SN-${ulid().slice(10, 14)}`;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId: sku('CC-SERIAL'),
        binId: binSer,
        quantityDelta: 2,
        reasonCode: 'cycle-count',
        note: 'cold-chain-suite serial seed',
        serials: [serialA, serialB],
        occurredAt: at(-3),
      })
      .expect(201);

    const wave = await releasedWave([{ skuId: sku('CC-SERIAL'), quantity: 2 }]);
    expect(wave.picklist.lines).toHaveLength(1);
    await pickAllLines(wave.picklist, at(-2), new Map([[wave.picklist.lines[0]!.id, [serialA, serialB]]]));
    await packAndDispatch(wave.orderId, [{ skuId: sku('CC-SERIAL'), qty: 2 }]);

    // The ledger's serial arms carry the RESOLVED serial identities (the
    // catalog `serials.id`), not the raw numbers the client scanned.
    const serialIds = (
      await sql`select id from serials where tenant_id = ${tenantId} and sku_id = ${sku('CC-SERIAL')} and serial_number in (${serialA}, ${serialB})`
    ).map((row) => (row as unknown as { id: string }).id);
    expect(serialIds).toHaveLength(2);

    const body = (await trace(wave.orderId).expect(200)).body as Trace;
    expect(body.lines).toHaveLength(1);
    const line = body.lines[0]!;
    expect(line.dispatchedQty).toBe(2);
    expect(line.excursions).toEqual([]);
    // One serial pick = one event per serial unit → one scope per serial.
    expect(line.scopes).toHaveLength(2);
    for (const scope of line.scopes) {
      expect(scope.serialRef).not.toBeNull();
      expect(scope.batchRef).toBeNull();
      expect(serialIds).toContain(scope.serialRef);
      // The serial's own chain: its intake and its pick, both serial-armed.
      expect(scope.chain.map((e) => e.type)).toEqual(['stock.adjusted', 'pick.picked']);
      for (const event of scope.chain) {
        expect(event.serialRef).toBe(scope.serialRef);
        expect(event.batchRef).toBeNull();
      }
      const picked = scope.chain[1]!;
      expect(picked.quantityDelta).toBe(-1); // one serial is one whole unit
      expect(picked.fromBinId).toBe(binSer);
      expect(picked.fromBinStorageClass).toBe('ambient');
    }
  });

  it('multi-line order: an excursion at a bin holding only line A\'s batch lands on line A and never on line B', async () => {
    const binLineA = await createBin('AMB-03', 'ambient');
    const binLineB = await createBin('AMB-04', 'ambient');
    await seedStockBatch(sku('CC-LINEA'), binLineA, 2, 'CC-LA', at(-8));
    await seedStockBatch(sku('CC-LINEB'), binLineB, 2, 'CC-LB', at(-8));

    // The excursion is committed while line A's batch sits in AMB-03 (its
    // business time, -7m, is inside that scope's dwell window); the release
    // returns the quarantined units so the pick can draw them.
    const excursion = await recordExcursion({
      warehouseId,
      binId: binLineA,
      readingC: 5.5,
      note: 'line A only',
      occurredAt: at(-7),
    }).expect(201);
    const excursionId = excursion.body.excursion.id as string;
    await releaseHold((excursion.body.excursion.holdIds as string[])[0]!);

    const wave = await releasedWave([
      { skuId: sku('CC-LINEA'), quantity: 2 },
      { skuId: sku('CC-LINEB'), quantity: 2 },
    ]);
    await pickAllLines(wave.picklist, at(-6));
    await packAndDispatch(wave.orderId, [
      { skuId: sku('CC-LINEA'), qty: 2 },
      { skuId: sku('CC-LINEB'), qty: 2 },
    ]);

    const body = (await trace(wave.orderId).expect(200)).body as Trace;
    expect(body.lines).toHaveLength(2);
    const lineA = body.lines.find((l) => l.skuId === sku('CC-LINEA'))!;
    const lineB = body.lines.find((l) => l.skuId === sku('CC-LINEB'))!;
    expect(lineA.excursions).toHaveLength(1);
    expect(lineA.excursions[0]).toMatchObject({ excursionId, binId: binLineA, readingC: 5.5 });
    // Line B's scopes dwell in AMB-04 only, and the excursion's skuId is
    // line A's — the excursion must not leak onto line B.
    expect(lineB.excursions).toEqual([]);
    expect(lineB.scopes.length).toBeGreaterThanOrEqual(1);
  });

  it('open-ended dwell: an excursion at a chain bin the batch never left correlates after the dispatch (departure null)', async () => {
    // One batch seeded into TWO bins (same batch code → one batch id); the
    // order draws a single unit from one bin, so the OTHER bin keeps its
    // stock: an arrival with NO departure — the open-ended window.
    const binLeft = await createBin('AMB-05', 'ambient');
    const binRight = await createBin('AMB-06', 'ambient');
    await seedStockBatch(sku('CC-LINEA'), binLeft, 1, 'CC-OP', at(-4));
    await seedStockBatch(sku('CC-LINEA'), binRight, 1, 'CC-OP', at(-4));

    const wave = await releasedWave([{ skuId: sku('CC-LINEA'), quantity: 1 }]);
    expect(wave.picklist.lines).toHaveLength(1);
    await pickAllLines(wave.picklist, at(-3));
    await packAndDispatch(wave.orderId, [{ skuId: sku('CC-LINEA'), qty: 1 }]);

    const body = (await trace(wave.orderId).expect(200)).body as Trace;
    const line = body.lines[0]!;
    expect(line.scopes).toHaveLength(1);
    const chain = line.scopes[0]!.chain;
    expect(chain.map((e) => e.type)).toEqual(['stock.adjusted', 'stock.adjusted', 'pick.picked']);
    // The open-ended bin: an arrival (toBinId) with no departure (fromBinId)
    // anywhere in the chain.
    const departedBins = new Set(chain.map((e) => e.fromBinId).filter((b): b is string => b !== null));
    const openBin = chain
      .map((e) => e.toBinId)
      .find((b) => b !== null && !departedBins.has(b));
    expect(openBin).toBeDefined();
    expect(chain.every((e) => e.fromBinId !== openBin)).toBe(true);

    // Recorded AFTER the dispatch, at the bin the batch still occupies —
    // the open-ended (departure null) window must correlate it.
    const later = await recordExcursion({
      warehouseId,
      binId: openBin!,
      readingC: 1.5,
      note: 'after dispatch, still in the bin',
    }).expect(201);
    const laterId = later.body.excursion.id as string;

    const after = (await trace(wave.orderId).expect(200)).body as Trace;
    expect(after.lines[0]!.excursions).toHaveLength(1);
    expect(after.lines[0]!.excursions[0]).toMatchObject({
      excursionId: laterId,
      binId: openBin,
      readingC: 1.5,
    });
  });

  it('openapi: the cold-chain route is published', async () => {
    const doc = await request(app.getHttpServer())
      .get('/api/v1/openapi.json')
      .expect(200);
    const paths = Object.keys(doc.body.paths as Record<string, unknown>);
    expect(paths).toContain('/tenants/{tenantId}/warehouses/{warehouseId}/cold-chain/orders/{orderId}');
  });
});