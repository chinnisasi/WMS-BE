import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid } from '../../src/shared/primitives/ids';
import { createApp } from '../../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../../src/shared/shared.module';
import { InventoryFacade } from '../../src/modules/inventory/inventory.facade';
import { getLedgerEventType } from '../../src/modules/inventory/ledger-registry';
import { useSuiteDatabase, type SuiteDatabase } from '../support/suite-db';
import { testAddress } from '../support/shipment-address';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// Device intake is exercised through the snapshot read only, but the dev env
// the sibling suites set keeps app boot identical.
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
// A host that exports any poll interval would boot background workers and
// race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/** The advisory key every suite uses to serialize wms_rls_probe role setup. */
const PROBE_LOCK = 742105;

const PLAIN = 'TR-PLAIN';
const BATCH = 'TR-BATCH';
const SERIAL = 'TR-SERIAL';
const CATCH_WEIGHT = 'TR-CW';
const COMPONENT = 'TR-COMP';
const KIT = 'TR-KIT';
const SKU_CODES = [PLAIN, BATCH, SERIAL, CATCH_WEIGHT, COMPONENT, KIT] as const;

describe('Transfer Orders: two-leg state machine, ledger legs, in-transit parking (e2e, story 5-1)', () => {
  let app: INestApplication;
  let reservations: InventoryFacade;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string;
  let operatorEmail = '';
  let deviceOperatorToken: string; // the operator's badge-in (device) session
  let accountantToken: string;
  let sourceWarehouseId: string; // W1 — the stock lives here
  let destWarehouseId: string; // W2 — the cross-warehouse landing
  let binSrc: string; // A-01-01 — the seeded source bin
  let binSameWh: string; // A-01-02 — the same-warehouse landing bin
  let binSpare: string; // A-01-03 — the serial-elsewhere arm's bin
  let binCrossWh: string; // B-01-01 — the cross-warehouse landing bin
  let binBlocked: string; // B-01-02 — the placement-gate refusal arm
  let binSpare2: string; // B-01-03 — spare
  const skuIds = new Map<string, string>();
  let batchId: string; // the LOT-TB-1 batch row
  let inTransitBinSource: string; // W1's system IN-TRANSIT bin (lazily ensured)
  let otherTenantId = '';
  let otherTenantToken = '';

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('transfers');
    app = await createApp(false);
    await app.init();
    reservations = app.get(InventoryFacade);
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    // Tenant + owner.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Transfer Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // Two warehouses: the source (W1) and the cross-warehouse destination (W2).
    const mkWarehouse = async (code: string, name: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code, name })
          .expect(201)
      ).body.id as string;
    sourceWarehouseId = await mkWarehouse(`TRS-${ulid().slice(10, 16).toUpperCase()}`, 'Transfer Source WH');
    destWarehouseId = await mkWarehouse(`TRD-${ulid().slice(10, 16).toUpperCase()}`, 'Transfer Dest WH');

    const zoneIds = new Map<string, string>();
    const mkBin = async (warehouseId: string, code: string): Promise<string> => {
      const zoneCode = code.slice(0, 1);
      let zoneId = zoneIds.get(`${warehouseId}|${zoneCode}`);
      if (zoneId === undefined) {
        zoneId = (
          await request(app.getHttpServer())
            .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ code: zoneCode, name: `Zone ${zoneCode}` })
            .expect(201)
        ).body.id as string;
        zoneIds.set(`${warehouseId}|${zoneCode}`, zoneId);
      }
      return (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 1000, type: 'shelf', code })
          .expect(201)
      ).body.id as string;
    };
    binSrc = await mkBin(sourceWarehouseId, 'A-01-01');
    binSameWh = await mkBin(sourceWarehouseId, 'A-01-02');
    binSpare = await mkBin(sourceWarehouseId, 'A-01-03');
    binCrossWh = await mkBin(destWarehouseId, 'B-01-01');
    binBlocked = await mkBin(destWarehouseId, 'B-01-02');
    binSpare2 = await mkBin(destWarehouseId, 'B-01-03');

    // SKUs: plain, batch-tracked, serial-tracked, catch-weight (refusal),
    // the kit's component and the kit itself.
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      `${PLAIN},Transfer Plain,pcs,,1800,,false,false,false,,,`,
      `${BATCH},Transfer Batch,pcs,,1800,,true,false,false,,,`,
      `${SERIAL},Transfer Serial,pcs,,1800,,false,true,false,,,`,
      `${CATCH_WEIGHT},Transfer CatchWeight,kg,,1800,,false,false,true,,,`,
      `${COMPONENT},Transfer Component,pcs,,1800,,false,false,false,,,`,
      `${KIT},Transfer Kit,pcs,,1800,,false,false,false,,,`,
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const skus = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) {
      if ((SKU_CODES as readonly string[]).includes(item.code)) {
        skuIds.set(item.code, item.id);
      }
    }
    expect(skuIds.size).toBe(SKU_CODES.length);
    // TR-KIT becomes a kit: a transfer line naming it must refuse (a kit can
    // never hold stock).
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/skus/${skuIds.get(KIT)}/kit`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: skuIds.get(COMPONENT), quantity: 1 }] })
      .expect(201);

    // Members: the ops manager (transfers.manage — plans and confirms the
    // outbound leg, seeds stock), the operator (transfers.execute — the
    // inbound leg) and the accountant (the 403 arm).
    const mkMember = async (
      role: 'ops_manager' | 'operator' | 'accountant',
    ): Promise<{ userId: string; email: string; token: string }> => {
      const memberEmail = `${role}-${ulid().toLowerCase()}@example.com`;
      const invited = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/users`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email: memberEmail, role })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
        .expect(200);
      const token = (
        await request(app.getHttpServer())
          .post(`${API}/sign-in`)
          .send({ email: memberEmail, password: 'correct-horse-battery' })
          .expect(200)
      ).body.accessToken as string;
      return { userId: invited.body.user.id as string, email: memberEmail, token };
    };
    opsToken = (await mkMember('ops_manager')).token;
    const operator = await mkMember('operator');
    operatorToken = operator.token;
    operatorEmail = operator.email;
    accountantToken = (await mkMember('accountant')).token;

    // A floor device + the operator badged onto it — the catalog snapshot
    // (and its transferTasks arm) speaks device sessions only.
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'transfer-suite device', pin: '1357' })
      .expect(201);
    deviceOperatorToken = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail, pin: '1357' })
        .expect(200)
    ).body.accessToken as string;

    // Seed stock via the stock.adjustment command (HTTP).
    const seed = async (body: Record<string, unknown>, token = opsToken): Promise<void> => {
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, ulid())
        .send(body)
        .expect(201);
    };
    await seed({
      warehouseId: sourceWarehouseId,
      skuId: skuIds.get(PLAIN),
      binId: binSrc,
      quantityDelta: 20,
      reasonCode: 'cycle-count',
      note: 'transfer-suite seed',
    });
    await seed({
      warehouseId: sourceWarehouseId,
      skuId: skuIds.get(PLAIN),
      binId: binSpare,
      quantityDelta: 3,
      reasonCode: 'cycle-count',
      note: 'transfer-suite serial-elsewhere arm',
    });
    await seed({
      warehouseId: sourceWarehouseId,
      skuId: skuIds.get(BATCH),
      binId: binSrc,
      quantityDelta: 5,
      reasonCode: 'cycle-count',
      note: 'transfer-suite batch seed',
      batch: { code: 'LOT-TB-1' },
    });
    await seed({
      warehouseId: sourceWarehouseId,
      skuId: skuIds.get(SERIAL),
      binId: binSrc,
      quantityDelta: 3,
      reasonCode: 'cycle-count',
      note: 'transfer-suite serial seed',
      serials: ['TR-SN-1', 'TR-SN-2', 'TR-SN-3'],
    });
    await seed({
      warehouseId: sourceWarehouseId,
      skuId: skuIds.get(SERIAL),
      binId: binSpare,
      quantityDelta: 1,
      reasonCode: 'cycle-count',
      note: 'transfer-suite serial-elsewhere seed',
      serials: ['TR-SN-9'],
    });
    // Touch B-01-03 with one movement so its epoch row exists — the task
    // card must then carry the bin's LIVE epoch (the same-tx capture).
    await seed({
      warehouseId: destWarehouseId,
      skuId: skuIds.get(PLAIN),
      binId: binSpare2,
      quantityDelta: 1,
      reasonCode: 'cycle-count',
      note: 'transfer-suite epoch-touch',
    });
    // Cold-start bootstrap: the ATP reads below need the warehouses' counters
    // set ready — same as the sibling suites.
    await reservations.rebuildReservationCounters(tenantId, sourceWarehouseId);
    await reservations.rebuildReservationCounters(tenantId, destWarehouseId);

    // The batch row the batch line names (the wire field is batchId — the
    // catalog batches.id).
    const batchRows = await sql`
      select id from batches where tenant_id = ${tenantId} and code = 'LOT-TB-1' limit 1`;
    batchId = batchRows[0]!.id as string;

    // The blocked placement-gate arm.
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${destWarehouseId}/bins/${binBlocked}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ blocked: true })
      .expect(200);

    // A second tenant for the cross-tenant arms.
    const otherEmail = `other-${ulid().toLowerCase()}@example.com`;
    const other = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Other Co ${ulid()}`, ownerEmail: otherEmail, password: 'correct-horse-battery' })
      .expect(201);
    otherTenantId = other.body.tenant.id as string;
    createdTenantIds.push(otherTenantId);
    otherTenantToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: otherEmail, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
  });

  afterAll(async () => {
    await cleanupRows();
    await valkey.quit().catch(() => valkey.disconnect());
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // Children before parents: transfer lines → transfer orders → ledger →
      // projections → spine (kit compositions before skus — kit-ness is
      // relational).
      await cleaner.unsafe('DELETE FROM devices WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM temperature_excursions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM qc_holds WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM transfer_order_lines WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM transfer_orders WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      await cleaner.unsafe('DELETE FROM reservations WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM batch_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM bin_state_epochs WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM batches WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM kit_compositions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // The suite's namespaced counter keys must not outlive the rows.
      for (const tenant of createdTenantIds) {
        const keys = await valkey.keys(`wms:{${tenant}}:*`);
        if (keys.length > 0) {
          await valkey.del(...keys);
        }
      }
    } finally {
      await cleaner.end();
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * The warehouse's system IN-TRANSIT bin. Migration 0043 seeds it for
   * pre-existing warehouses, but a NEW warehouse's pair is ensured lazily by
   * its first transfer (the QC-hold ensure's precedent) — so the id is
   * resolved on demand, never assumed upfront.
   */
  async function inTransitBinId(warehouseId: string): Promise<string> {
    const rows = await sql`
      select id from bins
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}::uuid
        and code = 'IN-TRANSIT' and system_owned = true`;
    expect(rows.length).toBe(1);
    return (rows[0] as { id: string }).id;
  }

  function createTransfer(
    body: Record<string, unknown>,
    token: string = opsToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/movements/transfers`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function outboundConfirm(
    transferId: string,
    body: Record<string, unknown> = {},
    token: string = opsToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/movements/transfers/${transferId}/outbound-confirm`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function inboundConfirm(
    transferId: string,
    body: Record<string, unknown> = {},
    token: string = operatorToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/movements/transfers/${transferId}/inbound-confirm`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function cancelTransfer(
    transferId: string,
    body: Record<string, unknown> = {},
    token: string = opsToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/movements/transfers/${transferId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  /** The on-hand milli of one (warehouse, sku, bin) scope; null when no row. */
  async function onHandMilli(warehouseId: string, skuId: string | undefined, binId: string): Promise<number | null> {
    const rows = await sql`
      select quantity from stock_on_hand
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
        and sku_id = ${skuId!}::uuid and bin_id = ${binId}::uuid`;
    return rows.length === 0 ? null : Number((rows[0] as { quantity: string }).quantity);
  }

  /** The live bin-state epoch; 0 when the bin has never been touched. */
  async function binEpoch(warehouseId: string, binId: string): Promise<number> {
    const rows = await sql`
      select epoch from bin_state_epochs
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and bin_id = ${binId}::uuid`;
    return rows.length === 0 ? 0 : Number((rows[0] as { epoch: string }).epoch);
  }

  /** The transfer legs' ledger rows, ordered per warehouse by seq. */
  async function transferEvents(transferId: string): Promise<
    { warehouse_id: string; type: string; quantity_delta: string; from_bin_id: string | null; to_bin_id: string | null; serial_ref: string | null }[]
  > {
    return (await sql`
      select warehouse_id, type, quantity_delta, from_bin_id, to_bin_id, serial_ref
      from ledger_events
      where tenant_id = ${tenantId} and reference_doc->>'transferId' = ${transferId}
      order by warehouse_id, seq`) as never;
  }

  // ── the ledger vocabulary ─────────────────────────────────────────────────
  describe('ledger vocabulary', () => {
    it('registers the two transfer event types with the transfer reference kind', () => {
      const outbound = getLedgerEventType('transfer.outbound');
      const inbound = getLedgerEventType('transfer.inbound');
      expect(outbound).toBeDefined();
      expect(inbound).toBeDefined();
      expect(outbound!.referenceKinds).toContain('transfer');
      expect(inbound!.referenceKinds).toContain('transfer');
    });
  });

  // ── the bin→bin happy path ────────────────────────────────────────────────
  describe('bin→bin (same warehouse) happy path', () => {
    it('draft → in_transit → completed; both legs land as relocation events; epochs bump; ATP excludes the parked units', async () => {
      const skuId = skuIds.get(PLAIN)!;

      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId: sourceWarehouseId,
        note: 'bin-to-bin',
        lines: [{ skuId, quantity: 4, fromBinId: binSrc, toBinId: binSameWh }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      expect(created.body.transfer).toMatchObject({
        status: 'draft',
        sourceWarehouseId,
        destWarehouseId: sourceWarehouseId,
        note: 'bin-to-bin',
      });
      expect(created.body.lines).toHaveLength(1);
      const lineId = created.body.lines[0].id as string;

      // Outbound (ops manager — the planner verb). This is also the
      // warehouse's first transfer: the lazily-ensured IN-TRANSIT bin is born
      // here, so the id resolves from now on.
      const out = await outboundConfirm(transferId, {}, opsToken).expect(200);
      inTransitBinSource = await inTransitBinId(sourceWarehouseId);
      expect(out.body.transfer).toMatchObject({ id: transferId, status: 'in_transit' });
      expect(out.body.events).toHaveLength(1);
      expect(out.body.events[0]).toMatchObject({
        warehouseId: sourceWarehouseId,
        type: 'transfer.outbound',
        skuId,
        quantity: 4,
        fromBinId: binSrc,
        toBinId: inTransitBinSource,
      });

      // The projections: the source bin drained, the IN-TRANSIT bin holds the
      // parked units.
      expect(await onHandMilli(sourceWarehouseId, skuId, binSrc)).toBe(16000);
      expect(await onHandMilli(sourceWarehouseId, skuId, inTransitBinSource)).toBe(4000);
      // ATP (milli at the edge): committed on-hand includes the parked units,
      // and the in-transit hook names them — the atp figure excludes them.
      const atpMid = await reservations.atp(tenantId, sourceWarehouseId, skuId);
      expect(atpMid.onHand).toBe(23000); // 16 (binSrc) + 3 (binSpare) + 4 parked
      expect(atpMid.inTransit).toBe(4000);
      expect(atpMid.atp).toBe(19000);
      // Both touched bins bumped their epochs in the fold.
      expect(await binEpoch(sourceWarehouseId, binSrc)).toBeGreaterThanOrEqual(1);
      expect(await binEpoch(sourceWarehouseId, binSameWh)).toBe(0); // untouched yet

      // Inbound: the operator confirms the leg (transfers.execute).
      const inbound = await inboundConfirm(transferId, { destBinId: binSameWh }).expect(200);
      expect(inbound.body.transfer).toMatchObject({ id: transferId, status: 'completed' });
      expect(inbound.body.events).toHaveLength(1);
      expect(inbound.body.events[0]).toMatchObject({
        warehouseId: sourceWarehouseId,
        type: 'transfer.inbound',
        quantity: 4,
        fromBinId: inTransitBinSource,
        toBinId: binSameWh,
      });

      // The landed units; the parked row drained to zero.
      expect(await onHandMilli(sourceWarehouseId, skuId, binSameWh)).toBe(4000);
      const parked = await onHandMilli(sourceWarehouseId, skuId, inTransitBinSource);
      expect(parked === null || parked === 0).toBe(true);
      const atpAfter = await reservations.atp(tenantId, sourceWarehouseId, skuId);
      expect(atpAfter.onHand).toBe(23000);
      expect(atpAfter.inTransit).toBe(0);
      expect(atpAfter.atp).toBe(23000);
      expect(await binEpoch(sourceWarehouseId, binSameWh)).toBeGreaterThanOrEqual(1);

      // The detail read answers which movements served the transfer: BOTH legs.
      const detail = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/movements/transfers/${transferId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(detail.body.transfer).toMatchObject({ status: 'completed' });
      expect(detail.body.lines[0]).toMatchObject({ id: lineId, skuCode: PLAIN, quantity: 4 });
      expect(detail.body.events.map((event: { type: string }) => event.type)).toEqual([
        'transfer.outbound',
        'transfer.inbound',
      ]);
    });

    it('a draft line omitting destBinId at inbound lands in the PLANNED bin', async () => {
      const skuId = skuIds.get(PLAIN)!;
      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId: sourceWarehouseId,
        lines: [{ skuId, quantity: 2, fromBinId: binSrc, toBinId: binSameWh }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      await outboundConfirm(transferId).expect(200);
      // No destBinId on the body — the line's planned to_bin_id decides.
      await inboundConfirm(transferId, {}).expect(200);
      // The planned bin received exactly the line's 2 units (4 prior + 2).
      const rows = await sql`
        select quantity from stock_on_hand
        where tenant_id = ${tenantId} and warehouse_id = ${sourceWarehouseId}
          and sku_id = ${skuId}::uuid and bin_id = ${binSameWh}::uuid`;
      expect(Number((rows[0] as { quantity: string }).quantity)).toBe(6000); // 4 (prior) + 2
    });
  });

  // ── the cross-warehouse happy path ────────────────────────────────────────
  describe('cross-warehouse happy path', () => {
    it('drain on the source chain + intake on the dest chain, one atomic transaction', async () => {
      const skuId = skuIds.get(PLAIN)!;
      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId, quantity: 5, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      await outboundConfirm(transferId).expect(200);

      // Mid-transfer: the units are parked in W1's IN-TRANSIT bin — excluded
      // from W1's ATP, invisible to W2's.
      expect(await onHandMilli(sourceWarehouseId, skuId, inTransitBinSource)).toBe(5000);
      const atpSource = await reservations.atp(tenantId, sourceWarehouseId, skuId);
      expect(atpSource.inTransit).toBe(5000);
      const atpDestBefore = await reservations.atp(tenantId, destWarehouseId, skuId);
      expect(atpDestBefore.onHand).toBe(1000); // the B-01-03 epoch-touch seed

      const inbound = await inboundConfirm(transferId, {}).expect(200);
      expect(inbound.body.events).toHaveLength(2);
      // The drain: on the SOURCE chain, toBin null.
      expect(inbound.body.events[0]).toMatchObject({
        warehouseId: sourceWarehouseId,
        type: 'transfer.inbound',
        quantity: 5,
        fromBinId: inTransitBinSource,
        toBinId: null,
      });
      // The intake: on the DEST chain, fromBin null.
      expect(inbound.body.events[1]).toMatchObject({
        warehouseId: destWarehouseId,
        type: 'transfer.inbound',
        quantity: 5,
        fromBinId: null,
        toBinId: binCrossWh,
      });

      expect(await onHandMilli(destWarehouseId, skuId, binCrossWh)).toBe(5000);
      const parkedSource = await onHandMilli(sourceWarehouseId, skuId, inTransitBinSource);
      expect(parkedSource === null || parkedSource === 0).toBe(true);
      const atpSourceAfter = await reservations.atp(tenantId, sourceWarehouseId, skuId);
      expect(atpSourceAfter.inTransit).toBe(0);
      const atpDestAfter = await reservations.atp(tenantId, destWarehouseId, skuId);
      expect(atpDestAfter.onHand).toBe(6000); // the seed + the landed 5
    });

    it('a refusal mid-confirm leaves BOTH chains untouched (no partial drain)', async () => {
      const skuId = skuIds.get(PLAIN)!;
      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId, quantity: 1, fromBinId: binSrc, toBinId: binBlocked }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      await outboundConfirm(transferId).expect(200);
      const parkedBefore = await onHandMilli(sourceWarehouseId, skuId, inTransitBinSource);

      // The blocked dest bin answers the placement gate: 409, the order stays
      // in_transit, and neither chain moved.
      const refused = await inboundConfirm(transferId, {}).expect(409);
      expect(refused.body.code).toBe('bin-blocked');
      expect((await onHandMilli(sourceWarehouseId, skuId, inTransitBinSource))!).toBe(parkedBefore!);
      expect(await onHandMilli(destWarehouseId, skuId, binBlocked)).toBeNull();
      expect(await transferEvents(transferId)).toHaveLength(1); // only the outbound leg

      const detail = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/movements/transfers/${transferId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(detail.body.transfer.status).toBe('in_transit');
    });
  });

  // ── the refusal arms ──────────────────────────────────────────────────────
  describe('refusal arms', () => {
    it('source-short: 409 transfer-source-short naming bin/sku/available; the order stays draft; nothing moved', async () => {
      const skuId = skuIds.get(PLAIN)!;
      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId, quantity: 50, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      const refused = await outboundConfirm(transferId).expect(409);
      expect(refused.body.code).toBe('transfer-source-short');
      // The problem-details message names the bin, the available figure and
      // the draw — the planner re-plans against what is on hand.
      expect(String(refused.body.detail)).toContain('A-01-01');
      expect(String(refused.body.detail)).toContain('holds 8');
      expect(String(refused.body.detail)).toContain('draws 50');

      const detail = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/movements/transfers/${transferId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(detail.body.transfer.status).toBe('draft');
      expect(await onHandMilli(sourceWarehouseId, skuId, binSrc)).toBe(8000); // untouched by the draft
    });

    it('wrong-state: inbound on a draft and cancel in_transit both 409 transfer-wrong-state', async () => {
      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId: skuIds.get(PLAIN), quantity: 1, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      await inboundConfirm(transferId, {}).expect(409).expect((res) => {
        expect(res.body.code).toBe('transfer-wrong-state');
      });
      await outboundConfirm(transferId).expect(200);
      await cancelTransfer(transferId).expect(409).expect((res) => {
        expect(res.body.code).toBe('transfer-wrong-state');
      });
      // The order continues normally: the inbound leg completes it (so it is
      // not left in_transit for the snapshot test below).
      await inboundConfirm(transferId, {}).expect(200);
    });

    it('epoch mismatch: 409 transfer-bin-changed; the live epoch confirms fine', async () => {
      const skuId = skuIds.get(PLAIN)!;
      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId, quantity: 2, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      await outboundConfirm(transferId).expect(200);

      // The stale device quotes an epoch one ahead of the bin's live value.
      const live = await binEpoch(destWarehouseId, binCrossWh);
      const stale = await inboundConfirm(transferId, { binStateEpoch: live + 1 }).expect(409);
      expect(stale.body.code).toBe('transfer-bin-changed');
      const detail = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/movements/transfers/${transferId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(detail.body.transfer.status).toBe('in_transit');

      // The same op with the LIVE epoch completes.
      await inboundConfirm(transferId, { binStateEpoch: live }).expect(200);
      // 5000 (the cross-warehouse happy path) + 1000 (the wrong-state arm) + 2.
      expect(await onHandMilli(destWarehouseId, skuId, binCrossWh)).toBe(8000);
    });

    it('catch-weight SKU: 400 at create (fail-closed)', async () => {
      await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId: skuIds.get(CATCH_WEIGHT), quantity: 1, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(400);
    });

    it('kit line: 409 kit-cannot-hold-stock naming the kit', async () => {
      const refused = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId: skuIds.get(KIT), quantity: 1, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(409);
      expect(refused.body.code).toBe('kit-cannot-hold-stock');
      expect(JSON.stringify(refused.body.detail)).toContain(KIT);
    });

    it('sub-precision quantity: 400', async () => {
      await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId: skuIds.get(PLAIN), quantity: 1.5, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(400);
    });

    it('403 for a member without the capability (accountant)', async () => {
      await createTransfer(
        {
          sourceWarehouseId,
          destWarehouseId,
          lines: [{ skuId: skuIds.get(PLAIN), quantity: 1, fromBinId: binSrc, toBinId: binCrossWh }],
        },
        accountantToken,
      ).expect(403);
    });
  });

  // ── cancel (draft-only) ───────────────────────────────────────────────────
  describe('draft-only cancel', () => {
    it('cancels a draft with no stock effect; a cancelled order refuses outbound', async () => {
      const skuId = skuIds.get(PLAIN)!;
      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId, quantity: 1, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      const onHandBefore = await onHandMilli(sourceWarehouseId, skuId, binSrc);

      const cancelled = await cancelTransfer(transferId, { note: 'no longer needed' }).expect(200);
      expect(cancelled.body.transfer).toMatchObject({ id: transferId, status: 'cancelled' });
      expect(await onHandMilli(sourceWarehouseId, skuId, binSrc)).toBe(onHandBefore);
      expect(await transferEvents(transferId)).toHaveLength(0);

      await outboundConfirm(transferId).expect(409).expect((res) => {
        expect(res.body.code).toBe('transfer-wrong-state');
      });
    });
  });

  // ── idempotent replay ─────────────────────────────────────────────────────
  describe('idempotent replay', () => {
    it('same key + same payload → the same snapshot; same key + different payload → 422', async () => {
      const body = {
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId: skuIds.get(PLAIN), quantity: 1, fromBinId: binSrc, toBinId: binSpare2 }],
      };
      const key = ulid();
      const first = await createTransfer(body, opsToken, key).expect(201);
      const second = await createTransfer(body, opsToken, key).expect(201);
      expect(second.body).toEqual(first.body);

      const drifted = await createTransfer({ ...body, note: 'drifted' }, opsToken, key).expect(422);
      expect(drifted.body.code).toBe('idempotency-key-reuse');

      // The outbound confirm replays too (a device retry with the same key).
      const confirmKey = ulid();
      const out1 = await outboundConfirm(first.body.transfer.id, {}, opsToken, confirmKey).expect(200);
      const out2 = await outboundConfirm(first.body.transfer.id, {}, opsToken, confirmKey).expect(200);
      expect(out2.body).toEqual(out1.body);
      // One leg, not two: the replay appended nothing.
      expect(await transferEvents(first.body.transfer.id)).toHaveLength(1);
    });
  });

  // ── the serial arms ───────────────────────────────────────────────────────
  describe('serial-tracked lines', () => {
    it('both legs carry the serials; the inbound leg derives them from the outbound events', async () => {
      const skuId = skuIds.get(SERIAL)!;
      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId, quantity: 3, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      const lineId = created.body.lines[0].id as string;

      await outboundConfirm(transferId, { lines: [{ lineId, serials: ['TR-SN-1', 'TR-SN-2', 'TR-SN-3'] }] }).expect(200);
      await inboundConfirm(transferId, {}).expect(200);

      // The ledger carries the catalog serial identity — resolve the scanned
      // raw codes to their ids for the comparisons below.
      const serialIdByCode = new Map<string, string>(
        (
          await sql`
            select serial_number, id from serials
            where tenant_id = ${tenantId} and sku_id = ${skuId}::uuid`
        ).map((row) => [(row as { serial_number: string; id: string }).serial_number, (row as { id: string }).id]),
      );
      const expectedIds = ['TR-SN-1', 'TR-SN-2', 'TR-SN-3'].map((code) => serialIdByCode.get(code)!).sort();

      // Per-serial events: 3 outbound relocations, then per-serial drain +
      // intake (6 inbound events) — the serial chains stay per-serial.
      const events = await transferEvents(transferId);
      expect(events).toHaveLength(9);
      const outbound = events.filter((event) => event.type === 'transfer.outbound');
      const inbound = events.filter((event) => event.type === 'transfer.inbound');
      expect(outbound).toHaveLength(3);
      expect(outbound.map((event) => event.serial_ref).sort()).toEqual(expectedIds);
      for (const event of outbound) {
        expect(event).toMatchObject({ quantity_delta: '1000', from_bin_id: binSrc });
      }
      const drains = inbound.filter((event) => event.to_bin_id === null);
      const intakes = inbound.filter((event) => event.from_bin_id === null);
      expect(drains).toHaveLength(3);
      expect(intakes).toHaveLength(3);
      expect(drains.map((event) => event.serial_ref).sort()).toEqual(expectedIds);
      expect(intakes.map((event) => event.serial_ref).sort()).toEqual(expectedIds);
      for (const event of drains) {
        expect(event).toMatchObject({ quantity_delta: '-1000', from_bin_id: inTransitBinSource });
      }
      for (const event of intakes) {
        expect(event).toMatchObject({ quantity_delta: '1000', to_bin_id: binCrossWh });
      }
      // Every serial now lives in the dest bin.
      const rows = await sql`
        select to_bin_id, count(*)::int as n from ledger_events
        where tenant_id = ${tenantId} and sku_id = ${skuId}::uuid and serial_ref is not null
        group by to_bin_id`;
      expect(rows.find((row) => row.to_bin_id === binCrossWh)).toMatchObject({ n: 3 });
    });

    it('serial-elsewhere: 409 naming the last-known bin; the order stays draft', async () => {
      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId: skuIds.get(SERIAL), quantity: 1, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      const lineId = created.body.lines[0].id as string;
      // TR-SN-9 lives in A-01-03, not in the line's from bin.
      const refused = await outboundConfirm(transferId, {
        lines: [{ lineId, serials: ['TR-SN-9'] }],
      }).expect(409);
      expect(refused.body.code).toBe('serial-elsewhere');
      const detail = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/movements/transfers/${transferId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(detail.body.transfer.status).toBe('draft');
    });

    it('unknown serial: 404 serial-unknown; duplicate scan and count mismatch: 400', async () => {
      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId: skuIds.get(SERIAL), quantity: 1, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      const lineId = created.body.lines[0].id as string;
      const unknown = await outboundConfirm(transferId, {
        lines: [{ lineId, serials: ['TR-SN-NOPE'] }],
      }).expect(404);
      expect(unknown.body.code).toBe('serial-unknown');
      const dup = await outboundConfirm(transferId, {
        lines: [{ lineId, serials: ['TR-SN-1', 'TR-SN-1'] }],
      }).expect(400);
      expect(dup.body.code).toBe('validation-failed');
      // 2 units on the line, 3 scans: a count mismatch refuses.
      const multi = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId: skuIds.get(SERIAL), quantity: 2, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(201);
      const multiLineId = multi.body.lines[0].id as string;
      await outboundConfirm(multi.body.transfer.id, {
        lines: [{ lineId: multiLineId, serials: ['TR-SN-1', 'TR-SN-2', 'TR-SN-3'] }],
      }).expect(400);
    });
  });

  // ── the batch arm ─────────────────────────────────────────────────────────
  describe('batch-tracked lines', () => {
    it('the batch moves with both legs naming the batch', async () => {
      const skuId = skuIds.get(BATCH)!;
      const created = await createTransfer({
        sourceWarehouseId,
        destWarehouseId: sourceWarehouseId,
        lines: [{ skuId, quantity: 2, fromBinId: binSrc, toBinId: binSameWh, batchId }],
      }).expect(201);
      const transferId = created.body.transfer.id as string;
      await outboundConfirm(transferId).expect(200);
      await inboundConfirm(transferId, {}).expect(200);
      const events = await transferEvents(transferId);
      for (const event of events) {
        expect(event.type === 'transfer.outbound' || event.type === 'transfer.inbound').toBe(true);
      }
      expect(await onHandMilli(sourceWarehouseId, skuId, binSameWh)).toBe(2000);
      const batchRows = await sql`
        select quantity from batch_on_hand
        where tenant_id = ${tenantId} and warehouse_id = ${sourceWarehouseId}
          and sku_id = ${skuId}::uuid and bin_id = ${binSameWh}::uuid and batch_id = ${batchId}::uuid`;
      expect(Number((batchRows[0] as { quantity: string }).quantity)).toBe(2000);
    });
  });

  // ── reads + the device snapshot ───────────────────────────────────────────
  describe('reads and the device snapshot arm', () => {
    it('the list reads with status filter and keyset cursor', async () => {
      const draftPage = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/movements/transfers?status=draft&limit=1`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(draftPage.body.items.length).toBeLessThanOrEqual(1);
      expect(draftPage.body.items[0]).toMatchObject({ status: 'draft', sourceWarehouseCode: expect.any(String) });
      // The next page (one draft left per the earlier arms) is reachable.
      if (draftPage.body.nextCursor !== null) {
        const next = await request(app.getHttpServer())
          .get(`${API}/${tenantId}/movements/transfers?status=draft&cursor=${encodeURIComponent(draftPage.body.nextCursor)}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200);
        expect(Array.isArray(next.body.items)).toBe(true);
      }
    });

    it('the catalog snapshot carries the in-transit transfer tasks with epochs; none when all completed', async () => {
      // The blocked-bin transfer is still in_transit → one task for W2.
      const snapshot = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${destWarehouseId}`)
        .set('Authorization', `Bearer ${deviceOperatorToken}`)
        .expect(200);
      const tasks = snapshot.body.transferTasks as {
        transferId: string;
        sourceWarehouseId: string;
        destWarehouseId: string;
        lines: { lineId: string; skuCode: string; qty: number; destBinId: string; destBinCode: string; binStateEpoch: number | null }[];
      }[];
      expect(tasks).toHaveLength(2); // the blocked-bin + the replay order (both still in_transit)
      const task = tasks.find((entry) => entry.lines[0]?.destBinId === binBlocked)!;
      expect(task).toBeDefined();
      expect(task).toMatchObject({ sourceWarehouseId, destWarehouseId });
      expect(task.lines[0]).toMatchObject({
        skuCode: PLAIN,
        qty: 1,
        destBinId: binBlocked,
        destBinCode: 'B-01-02',
      });
      // A touched bin carries its LIVE epoch (the same-tx capture the pick
      // task established); a bin never touched by a movement carries null
      // (no epoch row = match — the AD-14 rule).
      expect(task.lines[0]!.binStateEpoch).toBeNull();
      const spareTask = tasks.find((entry) => entry.lines[0]?.destBinId === binSpare2)!;
      expect(spareTask.lines[0]!.binStateEpoch).not.toBeNull();

      // The SOURCE warehouse has no inbound tasks (its dest feed is empty).
      const sourceTasks = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${sourceWarehouseId}`)
        .set('Authorization', `Bearer ${deviceOperatorToken}`)
        .expect(200);
      expect(sourceTasks.body.transferTasks).toHaveLength(0);
    });
  });

  // ── tenancy ───────────────────────────────────────────────────────────────
  describe('tenancy arms', () => {
    it('cross-tenant references answer 404, never foreign data', async () => {
      // Tenant B's token naming tenant A's warehouse.
      await request(app.getHttpServer())
        .post(`${API}/${otherTenantId}/movements/transfers`)
        .set('Authorization', `Bearer ${otherTenantToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          sourceWarehouseId,
          destWarehouseId,
          lines: [{ skuId: skuIds.get(PLAIN), quantity: 1, fromBinId: binSrc, toBinId: binCrossWh }],
        })
        .expect(404);
      // Tenant B reading tenant A's transfer detail.
      const mine = await createTransfer({
        sourceWarehouseId,
        destWarehouseId,
        lines: [{ skuId: skuIds.get(PLAIN), quantity: 1, fromBinId: binSrc, toBinId: binCrossWh }],
      }).expect(201);
      const transferId = mine.body.transfer.id as string;
      await request(app.getHttpServer())
        .get(`${API}/${otherTenantId}/movements/transfers/${transferId}`)
        .set('Authorization', `Bearer ${otherTenantToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .post(`${API}/${otherTenantId}/movements/transfers/${transferId}/inbound-confirm`)
        .set('Authorization', `Bearer ${otherTenantToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(404);
    });

    it('RLS: a non-superuser role sees only the rows its app.tenant_id names', async () => {
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${PROBE_LOCK})`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
              create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_rls_probe');
        await tx.unsafe(
          'grant select, insert, update, delete on all tables in schema public to wms_rls_probe',
        );
      });
      const probe = postgres(process.env.DATABASE_URL!.replace('://wms:wms@', '://wms_rls_probe:wms_rls_probe@'), {
        max: 1,
      });
      try {
        // Tenant A's setting: exactly tenant A's rows are visible.
        await probe.unsafe(`set app.tenant_id = '${tenantId}'`);
        const mine = await probe.unsafe('select count(*)::int as n from transfer_orders');
        const allMine = await sql`select count(*)::int as n from transfer_orders where tenant_id = ${tenantId}`;
        expect(Number((mine[0] as unknown as { n: number }).n)).toBe(
          Number((allMine[0] as unknown as { n: number }).n),
        );
        // Flip to tenant B: tenant A's rows vanish, and a write naming tenant
        // A is refused by the WITH CHECK arm.
        await probe.unsafe(`set app.tenant_id = '${otherTenantId}'`);
        const foreign = await probe.unsafe(
          'select count(*)::int as n from transfer_orders where tenant_id = ' + `'${tenantId}'`,
        );
        expect(Number((foreign[0] as unknown as { n: number }).n)).toBe(0);
        let writeRefused = false;
        try {
          await probe.unsafe(
            `insert into transfer_orders (tenant_id, source_warehouse_id, dest_warehouse_id, status, created_by)
             values ('${tenantId}', '${sourceWarehouseId}', '${destWarehouseId}', 'draft', '00000000-0000-0000-0000-000000000000')`,
          );
        } catch {
          writeRefused = true;
        }
        expect(writeRefused).toBe(true);
      } finally {
        await probe.end();
      }
    });
  });
});