import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { fromMilli, toMilli } from '../src/shared/primitives/quantity';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { MAX_BIN_DIMENSION_MM } from '../src/modules/tenancy/bin-capacity';
import { BinCommand } from '../src/modules/tenancy/bin.command';
// Story 12-4: the vocabulary tuple — the round-trip walks it directly.
import { LOCATION_TYPES } from '../src/shared/primitives/location-type';
import { ProblemException } from '../src/shared/problem-details/problem.exception';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { importSecureSku } from './support/secure-sku';
import { testAddress } from './support/shipment-address';

// The e2e suite talks to the real Postgres (docker-compose dev DB by
// default; CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

// The merge's per-arm appends park on the per-(tenant, warehouse) advisory
// lock behind the placement suite's writes in CI parallelism — the default
// 5s jest timeout is tighter than the honest window.
jest.setTimeout(20_000);

describe('bin administration: block / merge / retire (e2e, story 3.6)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let warehouseId: string;
  let zoneId: string;
  let batchSkuId: string; // batch-tracked (the merge's batch arm)
  let plainSkuId: string; // untracked (plain arms + occupancy)
  let serialSkuId: string; // serial-tracked (the merge's serial arm)
  let operatorToken: string; // the badge-in operator (GRNs + device snapshot)
  let accountantToken: string; // capability-empty role → 403 on merge/retire
  let opsManagerToken: string; // bin.retire holder → merge/retire allowed

  // Bins (zone A of the one warehouse).
  let binA01: string; // the suggestion arm → retired (empty, valid)
  let binA02: string; // happy-path merge SOURCE (batch + plain + serial fill)
  let binA03: string; // happy-path merge TARGET
  let binA04: string; // the blocked arm
  let binA05: string; // the full-bin arm (capacity 5, filled)
  let binA06: string; // the QC-hold arm (filled, hold placed)
  let binA07: string; // the bin-not-empty arm (batch fill)
  let binA08: string; // the ops-manager retire arm (empty)
  // The boot GRN (its unplaced line = the live putaway task).
  let bootGrn: { grnId: string; lines: { grnLineId: string; skuId: string; batchId: string | null; qty: number }[] };

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('bin_admin');
    app = await createApp(false);
    await app.init();

    // Tenant + owner.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Bin Admin Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // Warehouse + one zone.
    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `BA-${ulid().slice(10, 16).toUpperCase()}`, name: `Bin Admin Depot ${ulid()}` })
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

    // SKUs: one batch-tracked, one untracked, one serial-tracked.
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      'BA-A,Bin Admin Item A,pcs,,1800,,true,false,,,',
      'BA-B,Bin Admin Item B,pcs,,1800,,false,false,,,',
      'BA-S,Bin Admin Item S,pcs,,1800,,false,true,,,',
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
    const byCode = new Map(
      (skus.body.items as { code: string; id: string }[]).map((item) => [item.code, item.id]),
    );
    batchSkuId = byCode.get('BA-A')!;
    plainSkuId = byCode.get('BA-B')!;
    serialSkuId = byCode.get('BA-S')!;

    // Storage bins. Occupancy starts at zero everywhere: the suggestion's
    // lowest-occupancy-then-code ranking is deterministic in this suite.
    const createBin = async (code: string, capacity: number): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, capacity, type: 'shelf' })
          .expect(201)
      ).body.id as string;
    binA01 = await createBin('A-01', 100);
    binA02 = await createBin('A-02', 100);
    binA03 = await createBin('A-03', 100);
    binA04 = await createBin('A-04', 100);
    binA05 = await createBin('A-05', 5);
    binA06 = await createBin('A-06', 100);
    binA07 = await createBin('A-07', 100);
    binA08 = await createBin('A-08', 100);

    // The floor device + its badge-in operator (GRNs + the device snapshot).
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Bin Admin scanner 1', pin: '1357' })
      .expect(201);
    const deviceToken = enrolled.body.deviceToken as string;
    const operatorEmail = `operator-${ulid().toLowerCase()}@example.com`;
    const invitedOperator = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: operatorEmail, role: 'operator' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invitedOperator.body.inviteToken, password: 'correct-horse-battery' })
      .expect(200);
    operatorToken = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${deviceToken}`)
        .send({ operatorEmail, pin: '1357' })
        .expect(200)
    ).body.accessToken as string;

    // The capability-empty accountant (403 on merge/retire) and the Ops
    // Manager (the second bin.retire holder).
    accountantToken = await inviteAndSignIn('accountant');
    opsManagerToken = await inviteAndSignIn('ops_manager');

    // The system Receiving bin (ensured on the tenant's first receipt): the
    // system-bin guard arms and the suggestion tests need it + a task. The
    // boot GRN's unplaced line IS the live putaway task the retired-target
    // placement arm later aims at binA01.
    bootGrn = await blindGrn([{ poLineId: null, skuId: batchSkuId, batchCode: 'LOT-BA-RCV', mfgDate: null, qty: 4 }]);
  });

  afterAll(async () => {
    await cleanupRows();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql.unsafe('DELETE FROM qc_holds WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM goods_receipt_lines WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM goods_receipt_notes WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // The ledger tables are append-only by trigger — the trigger is not
      // RLS and fires even for the table owner (the ledger.spec convention).
      await sql.unsafe('set session_replication_role = replica');
      await sql.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('set session_replication_role = DEFAULT');
      await sql.unsafe('DELETE FROM serials WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM batch_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM batches WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM devices WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
    } finally {
      await sql.end();
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** One blind receipt — ensures the system Receiving bin and puts applied stock in it. */
  async function blindGrn(lines: { poLineId: string | null; skuId: string; batchCode: string | null; mfgDate: string | null; qty: number }[]): Promise<{ grnId: string; lines: { grnLineId: string; skuId: string; batchId: string | null; qty: number }[] }> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        poId: null,
        blindReasonCode: 'unannounced-delivery',
        occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        lines,
      })
      .expect(201);
    const grn = res.body.goodsReceipt as { id: string; lines: { id: string; skuId: string; batchId: string | null; qty: number }[] };
    return {
      grnId: grn.id,
      lines: grn.lines.map((line) => ({ grnLineId: line.id, skuId: line.skuId, batchId: line.batchId, qty: line.qty })),
    };
  }

  /** Fills a bin through the web adjustment surface (the owner holds stock.adjust). */
  async function fill(
    binId: string,
    skuId: string,
    qty: number,
    opts: { batchCode?: string; serials?: string[] } = {},
  ): Promise<void> {
    await adjust({
      warehouseId,
      skuId,
      binId,
      quantityDelta: qty,
      reasonCode: 'cycle-count',
      note: 'bin-admin fill',
      ...(opts.batchCode === undefined ? {} : { batch: { code: opts.batchCode, mfgDate: '2026-01-01T00:00:00.000Z' } }),
      ...(opts.serials === undefined ? {} : { serials: opts.serials }),
    }).expect(201);
  }

  function adjust(body: Record<string, unknown>, token = ownerToken, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function blockBin(binId: string, blocked: boolean, token = ownerToken, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binId}`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ blocked });
  }

  function merge(sourceBinId: string, targetBinId: string, token = ownerToken, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${sourceBinId}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ targetBinId });
  }

  function retire(binId: string, token = ownerToken, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binId}/retire`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({});
  }

  async function zoneBins(zoneOfBin: string): Promise<
    { id: string; code: string; blocked: boolean; retiredAt: string | null; retiredBy: string | null; systemOwned: boolean }[]
  > {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneOfBin}/bins`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return res.body.items as never;
  }

  async function deviceSnapshotBins(): Promise<{ id: string; code: string; blocked: boolean; systemOwned: boolean }[]> {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    return res.body.bins as never;
  }

  async function getTasks(): Promise<
    { grnLineId: string; qty: number; suggestedBin: { binId: string; binCode: string } | null }[]
  > {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/putaway/tasks?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return res.body.items as never;
  }

  async function outboxRows(type: string): Promise<{ payload: Record<string, unknown> }[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = ${type}`;
      return rows as unknown as { payload: Record<string, unknown> }[];
    } finally {
      await sql.end();
    }
  }

  interface MergeLedgerRow {
    quantity_delta: number;
    from_bin_id: string | null;
    to_bin_id: string | null;
    batch_ref: string | null;
    serial_ref: string | null;
    reference_doc: Record<string, unknown>;
  }

  async function mergeLedgerRows(): Promise<MergeLedgerRow[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select quantity_delta, from_bin_id, to_bin_id, batch_ref, serial_ref, reference_doc
        from ledger_events
        where tenant_id = ${tenantId} and type = 'bin.merged'
        order by seq`;
      // `quantity_delta` is milli-units (story 10.1); this helper is the
      // suite's edge, so the arm assertions keep reading in base units.
      return (rows as unknown as MergeLedgerRow[]).map((row) => ({
        ...row,
        quantity_delta: fromMilli(Number(row.quantity_delta)),
      }));
    } finally {
      await sql.end();
    }
  }

  async function auditRows(action: string): Promise<{ target_id: string; reference: string | null }[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`select target_id, reference from audit_events where tenant_id = ${tenantId} and action = ${action}`;
      return rows as unknown as { target_id: string; reference: string | null }[];
    } finally {
      await sql.end();
    }
  }

  async function plainOnHand(binId: string, skuId: string): Promise<number> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select coalesce(sum(quantity), 0)::bigint as n from stock_on_hand
        where tenant_id = ${tenantId} and bin_id = ${binId} and sku_id = ${skuId}`;
      // The column holds milli-units (story 10.1); the suite asserts base units.
      return fromMilli(Number((rows[0] as unknown as { n: number }).n));
    } finally {
      await sql.end();
    }
  }

  async function batchOnHand(binId: string, skuId: string, batchId: string): Promise<number> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select coalesce(sum(quantity), 0)::bigint as n from batch_on_hand
        where tenant_id = ${tenantId} and bin_id = ${binId} and sku_id = ${skuId} and batch_id = ${batchId}`;
      // The column holds milli-units (story 10.1); the suite asserts base units.
      return fromMilli(Number((rows[0] as unknown as { n: number }).n));
    } finally {
      await sql.end();
    }
  }

  async function batchIdByCode(code: string): Promise<string> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`select id from batches where tenant_id = ${tenantId} and code = ${code}`;
      return (rows[0] as unknown as { id: string }).id;
    } finally {
      await sql.end();
    }
  }

  async function receivingBinId(): Promise<string> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select b.id from bins b
        where b.tenant_id = ${tenantId} and b.warehouse_id = ${warehouseId}
        and b.code = 'RECEIVING' and b.system_owned = true limit 1`;
      return (rows[0] as unknown as { id: string }).id;
    } finally {
      await sql.end();
    }
  }

  /** Invite a member with the role and return a signed password session. */
  async function inviteAndSignIn(role: string): Promise<string> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken, password: 'correct-horse-battery' })
      .expect(200);
    return (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
  }

  // ── the block/unblock re-home (matrix rows: the PATCH URL is unchanged) ─────

  it('block toggle: 200 with the flag + audit row; replay re-serves; reuse 422; unknown bin 404; system bin 400 validation-failed', async () => {
    const key = ulid();
    const blocked = await blockBin(binA04, true, ownerToken, key).expect(200);
    // `capacity` rides the block response: story 10.1 converts it out of
    // milli-units here too, and nothing else in this suite observes it.
    expect(blocked.body).toMatchObject({ id: binA04, capacity: 100, blocked: true });

    const replay = await blockBin(binA04, true, ownerToken, key).expect(200);
    expect(replay.body).toEqual(blocked.body);

    const reuse = await blockBin(binA04, false, ownerToken, key).expect(422);
    expect(reuse.body).toMatchObject({ code: 'idempotency-key-reuse' });

    await blockBin(uuidv7(), true).expect(404);

    // The system-bin guard (Story 3.6): the Receiving bin is never blockable.
    const receivingBin = await receivingBinId();
    const systemAttempt = await blockBin(receivingBin, true).expect(400);
    expect(systemAttempt.body).toMatchObject({ code: 'validation-failed' });
    expect(String(systemAttempt.body.detail)).toContain('RECEIVING');

    // The audit row (the 3.4/3.5 convention) — one per mutation, not per replay.
    const audits = await auditRows('bin.blocked');
    expect(audits.filter((row) => row.target_id === binA04)).toHaveLength(1);
  });

  // ── the suggestion / snapshot read surfaces, pre- and post-retire ───────────

  it('before any retirement the suggestion picks A-01 (lowest occupancy, first code); the device snapshot lists it', async () => {
    const tasks = await getTasks();
    expect(tasks[0]!.suggestedBin).toEqual({ binId: binA01, binCode: 'A-01' });

    const bins = await deviceSnapshotBins();
    expect(bins.find((bin) => bin.id === binA01)).toBeTruthy();
  });

  // ── retire: the happy path + the read-surface exclusions ─────────────────────

  it('retire (empty): 200 with the retiredAt/retiredBy pair; zone list still lists it (flagged); snapshot + suggestions exclude it', async () => {
    const key = ulid();
    const retired = await retire(binA01, ownerToken, key).expect(200);
    expect(retired.body.retiredAt).not.toBeNull();
    expect(retired.body.retiredBy).not.toBeNull();
    expect(retired.body.retiredAt).toEqual(expect.any(String));

    // Idempotent replay: same key re-serves the snapshot.
    const replay = await retire(binA01, ownerToken, key).expect(200);
    expect(replay.body).toEqual(retired.body);

    // The zone bin list KEEPS listing retired bins, flagged.
    const listed = await zoneBins(zoneId);
    const row = listed.find((bin) => bin.id === binA01)!;
    expect(row.retiredAt).toEqual(retired.body.retiredAt);
    expect(row.systemOwned).toBe(false);

    // The device snapshot EXCLUDES retired bins (blocked/system stay).
    const bins = await deviceSnapshotBins();
    expect(bins.find((bin) => bin.id === binA01)).toBeUndefined();

    // Suggestions skip the retired bin — the next winner takes over.
    const tasks = await getTasks();
    expect(tasks[0]!.suggestedBin).toEqual({ binId: binA02, binCode: 'A-02' });

    // One outbox event, one audit row.
    const events = await outboxRows('bin.retired');
    expect(events.filter((row) => row.payload.binId === binA01)).toHaveLength(1);
    expect(events.find((row) => row.payload.binId === binA01)!.payload.retiredBy).toEqual(retired.body.retiredBy);
    const audits = await auditRows('bin.retired');
    expect(audits.filter((row) => row.target_id === binA01)).toHaveLength(1);
  });

  it('retire guards: re-retire 409 bin-retired; retired bin cannot be blocked (409); system bin 400 validation-failed; non-empty 400 bin-not-empty naming (sku, batch, qty); accountant 403', async () => {
    // A re-retire under a different key is 409 — retirement is terminal.
    const reRetire = await retire(binA01).expect(409);
    expect(reRetire.body).toMatchObject({ code: 'bin-retired' });

    // Blocking (either direction) a retired bin is the same terminal rejection.
    const block = await blockBin(binA01, true).expect(409);
    expect(block.body).toMatchObject({ code: 'bin-retired' });
    const unblock = await blockBin(binA01, false).expect(409);
    expect(unblock.body).toMatchObject({ code: 'bin-retired' });

    // A system bin never retires (400 validation-failed naming the bin).
    const receivingBin = await receivingBinId();
    const systemAttempt = await retire(receivingBin).expect(400);
    expect(systemAttempt.body).toMatchObject({ code: 'validation-failed' });
    expect(String(systemAttempt.body.detail)).toContain('RECEIVING');

    // The empty gate names every offending (sku, batch, qty) row.
    await fill(binA05, plainSkuId, 5);
    const plainAttempt = await retire(binA05).expect(400);
    expect(plainAttempt.body).toMatchObject({ code: 'bin-not-empty' });
    expect(String(plainAttempt.body.detail)).toContain('BA-B ×5');

    await fill(binA07, batchSkuId, 3, { batchCode: 'LOT-BA-1' });
    const batchAttempt = await retire(binA07).expect(400);
    expect(batchAttempt.body).toMatchObject({ code: 'bin-not-empty' });
    expect(String(batchAttempt.body.detail)).toContain('BA-A (batch LOT-BA-1) ×3');

    // The capability gate: the accountant (no capabilities) is role-denied.
    const denied = await retire(binA08, accountantToken).expect(403);
    expect(denied.body).toMatchObject({ code: 'role-denied' });

    // Nothing was retired by any rejected attempt (the zone-A list; the
    // Receiving bin lives in the system zone — its 400 already proved it
    // untouched).
    const listed = await zoneBins(zoneId);
    for (const binId of [binA05, binA07, binA08]) {
      expect(listed.find((bin) => bin.id === binId)!.retiredAt).toBeNull();
    }
  });

  it('the Ops Manager holds bin.retire: an empty bin retires 200; the owner-only gap is closed', async () => {
    const retired = await retire(binA08, opsManagerToken).expect(200);
    expect(retired.body.retiredAt).not.toBeNull();
    expect(retired.body.retiredBy).not.toBeNull();
  });

  it('retired-bin reuse: adjustments into it 400 bin-retired; merge into it 400 bin-retired (the row stays — the code is reserved)', async () => {
    const adjustInto = await adjust({
      warehouseId,
      skuId: plainSkuId,
      binId: binA01,
      quantityDelta: 1,
      reasonCode: 'cycle-count',
      note: 'into retired',
    }).expect(400);
    expect(adjustInto.body).toMatchObject({ code: 'bin-retired' });

    const mergeInto = await merge(binA07, binA01).expect(400);
    expect(mergeInto.body).toMatchObject({ code: 'bin-retired' });

    // The code stays reserved: creating a new bin with a retired code is 409.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A-01', capacity: 10, type: 'shelf' })
      .expect(409);

    // A putaway placement cannot target it either: the live boot-GRN task
    // aimed at A-01 is refused with bin-retired naming the bin.
    const bootLine = bootGrn.lines[0]!;
    const placeInto = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/putaway/placements`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        grnId: bootGrn.grnId,
        grnLineId: bootLine.grnLineId,
        skuId: bootLine.skuId,
        batchId: bootLine.batchId,
        qty: bootLine.qty,
        toBinId: binA01,
        reasonCode: null,
        occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      })
      .expect(400);
    expect(placeInto.body).toMatchObject({ code: 'bin-retired' });
    expect(String(placeInto.body.detail)).toContain('A-01');

    // Retiring an unknown bin is 404, not a silent success.
    const unknownRetire = await retire(uuidv7()).expect(404);
    expect(unknownRetire.body).toMatchObject({ code: 'not-found' });
  });

  // ── merge: the happy path (per-arm movements, one commit) ────────────────────

  it('merge: batch + plain + serial arms move through real bin.merged ledger events; the source retires in the same commit; replay re-serves', async () => {
    await fill(binA02, batchSkuId, 10, { batchCode: 'LOT-BA-M' });
    await fill(binA02, plainSkuId, 5);
    await fill(binA02, serialSkuId, 3, { serials: ['SN-BA-1', 'SN-BA-2', 'SN-BA-3'] });
    const mergeBatchId = await batchIdByCode('LOT-BA-M');

    const key = ulid();
    const res = await merge(binA02, binA03, ownerToken, key).expect(200);
    expect(res.body.moved).toEqual({ skus: 3, units: 18 });
    expect(res.body.source.retiredAt).not.toBeNull();
    expect(res.body.source.retiredBy).not.toBeNull();
    expect(res.body.target.retiredAt).toBeNull();

    // One `bin.merged` ledger event per arm — the serial arm as per-unit
    // two-arm events, the batch arm carrying its identity.
    const rows = await mergeLedgerRows();
    const mine = rows.filter((row) => row.to_bin_id === binA03 && row.from_bin_id === binA02);
    expect(mine).toHaveLength(5);
    const batchRow = mine.find((row) => row.batch_ref === mergeBatchId)!;
    expect(batchRow.quantity_delta).toBe(10);
    expect(batchRow.serial_ref).toBeNull();
    const plainRow = mine.find((row) => row.batch_ref === null && row.serial_ref === null)!;
    expect(plainRow.quantity_delta).toBe(5);
    const serialRows = mine.filter((row) => row.serial_ref !== null);
    expect(serialRows).toHaveLength(3);
    for (const serialRow of serialRows) {
      expect(serialRow.quantity_delta).toBe(1);
      expect(String(serialRow.reference_doc.mergeId)).toBeTruthy();
    }
    expect(new Set(mine.map((row) => String(row.reference_doc.mergeId))).size).toBe(1);

    // The projections moved with the appends (the fold is inside the append).
    expect(await plainOnHand(binA03, plainSkuId)).toBe(5);
    expect(await plainOnHand(binA03, serialSkuId)).toBe(3);
    expect(await batchOnHand(binA03, batchSkuId, mergeBatchId)).toBe(10);
    expect(await plainOnHand(binA02, plainSkuId)).toBe(0);
    expect(await batchOnHand(binA02, batchSkuId, mergeBatchId)).toBe(0);
    expect(await plainOnHand(binA02, serialSkuId)).toBe(0);

    // One outbox event per operation; one audit row naming the source bin.
    const events = await outboxRows('bin.merged');
    const event = events.find((row) => row.payload.sourceBinId === binA02)!;
    expect(event).toMatchObject({ payload: { targetBinId: binA03, moved: { skus: 3, units: 18 } } });
    const audits = await auditRows('bin.merged');
    expect(audits.filter((row) => row.target_id === binA02)).toHaveLength(1);

    // Idempotent replay: same key re-serves, nothing re-moves.
    const replay = await merge(binA02, binA03, ownerToken, key).expect(200);
    expect(replay.body).toEqual(res.body);
    const rowsAfter = (await mergeLedgerRows()).filter((row) => row.to_bin_id === binA03 && row.from_bin_id === binA02);
    expect(rowsAfter).toHaveLength(5);

    // The zone list flags the merged-away source as retired.
    const listed = await zoneBins(zoneId);
    expect(listed.find((bin) => bin.id === binA02)!.retiredAt).toEqual(res.body.source.retiredAt);
  });

  it('merge guards: source=target and system bins 400 validation-failed; target blocked 400 bin-blocked; overflow 400 bin-full naming capacity/occupancy and writing NOTHING; unknown/foreign-warehouse bins 404; reuse 422', async () => {
    const receivingBin = await receivingBinId();
    await blockBin(binA04, true);

    const selfMerge = await merge(binA04, binA04).expect(400);
    expect(selfMerge.body).toMatchObject({ code: 'validation-failed' });
    expect(String(selfMerge.body.detail)).toContain('itself');

    const systemSource = await merge(receivingBin, binA04).expect(400);
    expect(systemSource.body).toMatchObject({ code: 'validation-failed' });
    expect(String(systemSource.body.detail)).toContain('RECEIVING');

    const systemTarget = await merge(binA04, receivingBin).expect(400);
    expect(systemTarget.body).toMatchObject({ code: 'validation-failed' });

    const blockedTarget = await merge(binA07, binA04).expect(400);
    expect(blockedTarget.body).toMatchObject({ code: 'bin-blocked' });
    expect(String(blockedTarget.body.detail)).toContain('A-04');

    // Overflow is all-or-nothing: A-05 already holds 5 of capacity 5.
    const overflow = await merge(binA07, binA05).expect(400);
    expect(overflow.body).toMatchObject({ code: 'bin-full' });
    expect(String(overflow.body.detail)).toContain('5 of 5');

    const unknownTarget = await merge(binA07, uuidv7()).expect(404);
    expect(unknownTarget.body).toMatchObject({ code: 'not-found' });
    await merge(uuidv7(), binA03).expect(404);

    // A bin from another warehouse never resolves — 404 (never a leak).
    const otherWarehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `BA2-${ulid().slice(10, 16).toUpperCase()}`, name: `Second Depot ${ulid()}` })
        .expect(201)
    ).body.id as string;
    const otherZoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${otherWarehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A 2' })
        .expect(201)
    ).body.id as string;
    const foreignBinId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${otherWarehouseId}/zones/${otherZoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'B-01', capacity: 100, type: 'shelf' })
        .expect(201)
    ).body.id as string;
    const foreignTarget = await merge(binA07, foreignBinId).expect(404);
    expect(foreignTarget.body).toMatchObject({ code: 'not-found' });

    // Same key, different target → 422 idempotency-key-reuse. The key's first
    // use must SUCCEED (only a stored key replays): the empty blocked A-04
    // merges into A-03 legally (no arms move; the source retires), then the
    // same key with a different target is a reuse.
    const key = ulid();
    await merge(binA04, binA03, ownerToken, key).expect(200);
    const reuse = await merge(binA07, binA03, ownerToken, key).expect(422);
    expect(reuse.body).toMatchObject({ code: 'idempotency-key-reuse' });

    // Nothing was written by any rejected attempt: A-07 keeps its stock and
    // stays live; the occupancy of the full bin is unchanged.
    expect(await plainOnHand(binA07, batchSkuId)).toBe(3);
    const listed = await zoneBins(zoneId);
    expect(listed.find((bin) => bin.id === binA07)!.retiredAt).toBeNull();
    expect(await plainOnHand(binA05, plainSkuId)).toBe(5);
  });

  it('QC-hold guard: a source or target bin with an open hold is 409 bin-merge-hold-open naming the bin and the hold', async () => {
    await fill(binA06, plainSkuId, 3);
    const holdOnSource = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/qc-holds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: plainSkuId, binId: binA06, reason: 'damaged carton' })
        .expect(201)
    ).body.qcHold as { id: string };

    const sourceHeld = await merge(binA06, binA03).expect(409);
    expect(sourceHeld.body).toMatchObject({ code: 'bin-merge-hold-open' });
    expect(String(sourceHeld.body.detail)).toContain('A-06');
    expect(String(sourceHeld.body.detail)).toContain(holdOnSource.id);

    // A held TARGET is refused the same way (before the capacity gate) — the
    // source here (A-07) carries no hold of its own, so the rejection names
    // the held target.
    const holdOnTarget = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/qc-holds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: plainSkuId, binId: binA05, reason: 'customer return' })
        .expect(201)
    ).body.qcHold as { id: string };
    const targetHeld = await merge(binA07, binA05).expect(409);
    expect(targetHeld.body).toMatchObject({ code: 'bin-merge-hold-open' });
    expect(String(targetHeld.body.detail)).toContain('A-05');
    expect(String(targetHeld.body.detail)).toContain(holdOnTarget.id);

    // Retire is refused the same way — the hold already moved A-06's stock to
    // the QC bin, so the bin is EMPTY: without this gate the retire would
    // succeed and the release could never return the held stock (the hold
    // would strand with no resolution path). The hold stays open.
    const heldRetire = await retire(binA06).expect(409);
    expect(heldRetire.body).toMatchObject({ code: 'bin-merge-hold-open' });
    expect(String(heldRetire.body.detail)).toContain('A-06');
    expect(String(heldRetire.body.detail)).toContain(holdOnSource.id);
    const openHolds = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/receiving/qc-holds?status=open`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(
      (openHolds.body.items as { id: string }[]).some((hold) => hold.id === holdOnSource.id),
    ).toBe(true);
  });

  it('merge serial disagreement: a ledger/projection divergence in the source is 400 validation-failed naming it; nothing moved', async () => {
    const binA09 = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A-09', capacity: 100, type: 'shelf' })
        .expect(201)
    ).body.id as string;
    await fill(binA09, serialSkuId, 2, { serials: ['SN-BA-D1', 'SN-BA-D2'] });

    // Diverge the aggregate from the ledger out-of-band: the projection now
    // says 3 units, the ledger's serial locations still say 2.
    const bump = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await bump`
        update stock_on_hand set quantity = quantity + ${toMilli(1)}
        where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
        and bin_id = ${binA09} and sku_id = ${serialSkuId}`;
    } finally {
      await bump.end();
    }
    expect(await plainOnHand(binA09, serialSkuId)).toBe(3);

    const before = (await mergeLedgerRows()).length;
    const disagreement = await merge(binA09, binA03).expect(400);
    expect(disagreement.body).toMatchObject({ code: 'validation-failed' });
    expect(String(disagreement.body.detail)).toContain('BA-S');
    expect(String(disagreement.body.detail)).toContain('2 serials vs 3 units');

    // All-or-nothing: no bin.merged event moved a single arm.
    expect((await mergeLedgerRows()).filter((row) => row.from_bin_id === binA09)).toHaveLength(0);
    expect((await mergeLedgerRows()).length).toBe(before);
  });

  it('legacy idempotency snapshot: a pre-3.6 response_snapshot without the new bin fields replays 200 with the normalizeBin fallbacks', async () => {
    // A stored key whose snapshot predates the 3.6 columns — the replay must
    // serve it with systemOwned/retiredAt/retiredBy filled in, not crash.
    const key = ulid();
    const payloadHash = hashCommandPayload({
      tenantId,
      warehouseId,
      binId: binA03,
      blocked: false,
    });
    const legacySnapshot = {
      bin: {
        id: binA03,
        tenantId,
        warehouseId,
        zoneId,
        code: 'A-03',
        capacity: 100,
        type: 'shelf',
        blocked: true,
        createdAt: new Date().toISOString(),
      },
    };
    const seed = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await seed`
        insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (${uuidv7()}, ${tenantId}, ${key}, ${payloadHash}, ${seed.json(legacySnapshot)})`;
    } finally {
      await seed.end();
    }

    const replay = await blockBin(binA03, false, ownerToken, key).expect(200);
    expect(replay.body).toMatchObject({
      id: binA03,
      blocked: true,
      systemOwned: false,
      retiredAt: null,
      retiredBy: null,
    });
  });

  it('authority: merge needs bin.retire (accountant 403, foreign session 403, bare 401); bin.retire stays out of the operator hand', async () => {
    const deniedMerge = await merge(binA07, binA03, accountantToken).expect(403);
    expect(deniedMerge.body).toMatchObject({ code: 'role-denied' });

    // Foreign session → permission-denied at the guard.
    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const registeredB = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Other Co ${ulid()}`, ownerEmail: emailB, password: 'correct-horse-battery' })
      .expect(201);
    createdTenantIds.push(registeredB.body.tenant.id);
    const tokenB = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: emailB, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    const foreign = await merge(binA07, binA03, tokenB).expect(403);
    expect(foreign.body).toMatchObject({ code: 'permission-denied' });

    // No session at all → 401.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binA07}/retire`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(401);
  });

  // ── Story 11-5 — the bin's capacity attributes (FR-39) ──────────────────────

  it('capacity attributes: create/grid accept the physical limits and echo them raw; fractional, zero, negative and over-cap values are 400 validation-failed', async () => {
    const create = (body: Record<string, unknown>): SupertestTest =>
      request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send(body);

    // A bin with limits creates cleanly and echoes the raw integers (no
    // fromMilli anywhere on attributes — the 11.2 SKU-attribute precedent).
    const limited = await create({ code: 'A-30', capacity: 100, type: 'shelf', lengthMm: 1200, maxWeightGrams: 20000 }).expect(201);
    expect(limited.body).toMatchObject({ code: 'A-30', capacity: 100, lengthMm: 1200, widthMm: null, heightMm: null, maxWeightGrams: 20000 });

    // A grid run stamps the same attributes on every generated bin.
    const grid = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins/grid`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ aisleFrom: 'C', aisleTo: 'C', baysPerAisle: 1, levelsPerBay: 2, capacity: 50, type: 'shelf', widthMm: 800, heightMm: 900 })
      .expect(201);
    expect(grid.body).toMatchObject({ generatedCount: 2, firstCode: 'C-01-01' });
    const listed = await zoneBins(zoneId);
    const generated = listed.find((bin) => bin.code === 'C-01-01')!;
    expect(generated).toMatchObject({ widthMm: 800, heightMm: 900, lengthMm: null, maxWeightGrams: null });

    // The value rules: fractional, zero, negative and over-cap — all 400
    // `validation-failed` (the DTO mirror here, the command validator behind
    // the replay for non-HTTP callers).
    for (const bad of [
      { lengthMm: 0.5 },
      { lengthMm: 0 },
      { lengthMm: -1 },
      { lengthMm: 100001 },
      { widthMm: 0.5 },
      { heightMm: 0 },
      { maxWeightGrams: 0.5 },
      { maxWeightGrams: -100 },
      { maxWeightGrams: 100000001 },
    ]) {
      const res = await create({ code: `BAD-${ulid().slice(0, 6)}`, capacity: 100, type: 'shelf', ...bad }).expect(400);
      expect(res.body).toMatchObject({ status: 400, code: 'validation-failed' });
    }
    const badGrid = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins/grid`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ aisleFrom: 'C', aisleTo: 'C', baysPerAisle: 1, levelsPerBay: 1, capacity: 50, type: 'shelf', maxWeightGrams: 100000001 })
      .expect(400);
    expect(badGrid.body).toMatchObject({ code: 'validation-failed' });
  });

  it('PATCH capacity attributes: absent=unchanged, null=clears, replay re-serves, reuse 422, unknown 404, retired 409, accountant 403, system bin editable, mixing with blocked 400, empty body 400; outbox + audit per mutation', async () => {
    const listed = await zoneBins(zoneId);
    const binA30 = listed.find((bin) => bin.code === 'A-30')!.id;
    const patch = (binId: string, body: Record<string, unknown>, token = ownerToken, key = ulid()): SupertestTest =>
      request(app.getHttpServer())
        .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binId}`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send(body);

    // Absent = unchanged, present = set (the 11.2 SKU-attribute semantics).
    const edit = await patch(binA30, { widthMm: 800 }, ownerToken, ulid()).expect(200);
    expect(edit.body).toMatchObject({ lengthMm: 1200, widthMm: 800, heightMm: null, maxWeightGrams: 20000 });

    const replayKey = ulid();
    const editHeight = await patch(binA30, { heightMm: 900 }, ownerToken, replayKey).expect(200);
    const replay = await patch(binA30, { heightMm: 900 }, ownerToken, replayKey).expect(200);
    expect(replay.body).toEqual(editHeight.body);
    await patch(binA30, { heightMm: 950 }, ownerToken, replayKey).expect(422)
      .then((res) => expect(res.body).toMatchObject({ code: 'idempotency-key-reuse' }));

    // null clears the limit; the other attributes survive untouched.
    await patch(binA30, { lengthMm: null }).expect(200)
      .then((res) => expect(res.body).toMatchObject({ lengthMm: null, widthMm: 800, maxWeightGrams: 20000 }));

    await patch(uuidv7(), { maxWeightGrams: 100 }).expect(404);

    // A retired bin's structure is settled (binA01 retired earlier).
    await patch(binA01, { maxWeightGrams: 100 }).expect(409)
      .then((res) => expect(res.body).toMatchObject({ code: 'bin-retired' }));

    // The accountant holds no capabilities — `bin.create` is the gate.
    await patch(binA30, { maxWeightGrams: 100 }, accountantToken).expect(403)
      .then((res) => expect(res.body).toMatchObject({ code: 'role-denied' }));

    // The system bins are editable (their limits are real).
    const receivingBin = await receivingBinId();
    await patch(receivingBin, { maxWeightGrams: 1000 }).expect(200)
      .then((res) => expect(res.body).toMatchObject({ maxWeightGrams: 1000, systemOwned: true }));

    // One route, two arms: the state command's `blocked` and the attribute
    // edit never mix in one request, and an empty body changes nothing.
    await patch(binA30, { blocked: true, lengthMm: 100 }).expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    await patch(binA30, {}).expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));

    // `blocked: null` is 400 — the DTO's `@IsOptional` skips null, so without
    // the controller's guard the state command would write null into a NOT
    // NULL column and answer 500 (the 11-5 review's high finding). The bin's
    // state is untouched by the refusal.
    const blockedBefore = (await zoneBins(zoneId)).find((bin) => bin.id === binA30)!.blocked;
    const nullBlocked = await patch(binA30, { blocked: null }).expect(400);
    expect(nullBlocked.body).toMatchObject({ code: 'validation-failed' });
    expect(String(nullBlocked.body.detail)).toContain('blocked');
    expect((await zoneBins(zoneId)).find((bin) => bin.id === binA30)!.blocked).toBe(blockedBefore);

    // The bad values the triage names — the DTO mirror (@IsInt @Min @Max)
    // refuses each before the command. The command validator behind these
    // same bounds is exercised DIRECTLY in the next test.
    for (const bad of [
      { lengthMm: 0.5 },
      { lengthMm: 0 },
      { lengthMm: -5 },
      { lengthMm: 100001 },
      { maxWeightGrams: 0 },
    ]) {
      await patch(binA30, bad).expect(400)
        .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    }

    // One outbox event + one audit row per mutation (three above), none per replay.
    const events = await outboxRows('bin.capacity_changed');
    expect(events.filter((row) => row.payload.binId === binA30)).toHaveLength(3);
    const audits = await auditRows('bin.capacity_changed');
    expect(audits.filter((row) => row.target_id === binA30)).toHaveLength(3);
  });

  it('the command validator bites on its own: direct createBin / editBinCapacity calls refuse values the DTO mirror would hide', async () => {
    // Triage #2: the HTTP arms above pass through the DTO mirror
    // (`@IsInt @Min @Max`), so they would keep passing even with
    // `assertBinCapacityAttributes` deleted — every non-HTTP write edge (the
    // grid generator, any future caller) leans on the command validator
    // ALONE. These direct service calls prove it is load-bearing: same bad
    // values, the named 400 problem, nothing written.
    type BinAttrKey = 'lengthMm' | 'widthMm' | 'heightMm' | 'maxWeightGrams';
    const attrField = (key: BinAttrKey, value: number): Partial<Record<BinAttrKey, number>> =>
      ({ [key]: value } as Partial<Record<BinAttrKey, number>>);
    const badValues: { key: BinAttrKey; value: number }[] = [
      { key: 'lengthMm', value: 0.5 },
      { key: 'lengthMm', value: 0 },
      { key: 'lengthMm', value: -5 },
      { key: 'lengthMm', value: 100001 },
      { key: 'widthMm', value: 0.5 },
      { key: 'heightMm', value: 0 },
      { key: 'maxWeightGrams', value: 0 },
      { key: 'maxWeightGrams', value: 100000001 },
    ];
    const expectCapacityRefusal = (attempt: unknown, key: BinAttrKey, value: number): void => {
      expect(attempt).toBeInstanceOf(ProblemException);
      expect((attempt as ProblemException).getResponse()).toMatchObject({
        status: 400,
        code: 'validation-failed',
        title: `${key} is not a recordable bin capacity`,
      });
      expect(((attempt as ProblemException).getResponse() as { detail: string }).detail).toContain(String(value));
    };

    const binCommands = app.get(BinCommand);
    const owners = postgres(process.env.DATABASE_URL!, { max: 1 });
    let ownerUserId: string;
    try {
      const rows = await owners`select id from users where tenant_id = ${tenantId} and role = 'owner' limit 1`;
      ownerUserId = (rows[0] as unknown as { id: string }).id;
    } finally {
      await owners.end();
    }

    for (const { key, value } of badValues) {
      const attempt = await binCommands
        .createBin(
          {
            tenantId,
            actorUserId: ownerUserId,
            warehouseId,
            zoneId,
            code: `CMD-${ulid().slice(0, 6)}`,
            capacity: 10,
            type: 'shelf',
            ...attrField(key, value),
          },
          ulid(),
        )
        .catch((err: unknown) => err);
      expectCapacityRefusal(attempt, key, value);
    }

    // The same validator behind the PATCH arm — editBinCapacity.
    const listed = await zoneBins(zoneId);
    const binA30Id = listed.find((bin) => bin.code === 'A-30')!.id;
    for (const { key, value } of [
      { key: 'lengthMm', value: 0.5 } as { key: BinAttrKey; value: number },
      { key: 'lengthMm', value: 100001 } as { key: BinAttrKey; value: number },
      { key: 'maxWeightGrams', value: 0 } as { key: BinAttrKey; value: number },
    ]) {
      const attempt = await binCommands
        .editBinCapacity({ tenantId, actorUserId: ownerUserId, warehouseId, binId: binA30Id, ...attrField(key, value) }, ulid())
        .catch((err: unknown) => err);
      expectCapacityRefusal(attempt, key, value);
    }

    // Every refusal rolled back: no CMD- bin exists and A-30's attributes
    // are exactly what the PATCH test above left them.
    const after = await zoneBins(zoneId);
    expect(after.some((bin) => bin.code.startsWith('CMD-'))).toBe(false);
    expect(after.find((bin) => bin.id === binA30Id)).toMatchObject({
      lengthMm: null,
      widthMm: 800,
      heightMm: 900,
      maxWeightGrams: 20000,
    });
  });

  it('volume gate exactness is pinned: MAX_BIN_DIMENSION_MM**3 stays a safe double (triage #7)', () => {
    // The gates compute a bin's L×W×H in JS doubles before BigInt takes over
    // — exact only while the product stays under Number.MAX_SAFE_INTEGER.
    // Widening the cap past ~208,000 mm would silently lose gate precision;
    // a widening that forgets to move the product inside BigInt fails HERE.
    expect(MAX_BIN_DIMENSION_MM ** 3).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('merge dimensional gates: bin-overweight / bin-volume-exceeded / bin-item-oversize name the target bin and both numbers and write NOTHING; a fitting merge with limits moves cleanly', async () => {
    // A dimensioned SKU through the real surfaces: import, then the edit's
    // attribute fields (5 kg, 500×400×300 mm).
    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
      'BA-D,Bin Admin Item D,pcs,,1800,,false,false,,,',
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
    const dimSkuId = (skus.body.items as { code: string; id: string }[]).find((item) => item.code === 'BA-D')!.id;
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/catalog/skus/${dimSkuId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ weightGrams: 5000, lengthMm: 500, widthMm: 400, heightMm: 300 })
      .expect(200);

    const createBin = async (code: string, attrs: Record<string, unknown>): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, capacity: 100, type: 'shelf', ...attrs })
          .expect(201)
      ).body.id as string;
    // Targets pre-loaded to the exact limit (the load read is cumulative over
    // the target's stock), one-unit sources:
    const srcW = await createBin('A-20', {});
    const tgtW = await createBin('A-21', { maxWeightGrams: 5000 }); // 1 unit = exactly 5,000 g
    const srcV = await createBin('A-23', {});
    const tgtV = await createBin('A-22', { lengthMm: 1000, widthMm: 1000, heightMm: 1000 }); // 16 units = 960M of 1,000M mm³
    const srcD = await createBin('A-25', {});
    const tgtD = await createBin('A-24', { lengthMm: 400, widthMm: 1000, heightMm: 1000 });
    const tgtOK = await createBin('A-26', { maxWeightGrams: 100000, lengthMm: 2000, widthMm: 2000, heightMm: 2000 });
    // The other two dim-fit dimensions (triage #11): a target too NARROW
    // (width 300 < the SKU's 400) and one too SHALLOW (height 200 < 300) —
    // each with a one-unit source.
    const srcDW = await createBin('A-27', {});
    const tgtDW = await createBin('A-28', { lengthMm: 1000, widthMm: 300, heightMm: 1000 });
    const srcDH = await createBin('A-29', {});
    const tgtDH = await createBin('A-31', { lengthMm: 1000, widthMm: 1000, heightMm: 200 });
    await fill(tgtW, dimSkuId, 1);
    await fill(tgtV, dimSkuId, 16);
    await fill(srcW, dimSkuId, 1);
    await fill(srcV, dimSkuId, 1);
    await fill(srcD, dimSkuId, 1);
    await fill(srcDW, dimSkuId, 1);
    await fill(srcDH, dimSkuId, 1);

    // Weight: 5,000 g in the target + 5,000 g moved > the 5,000 g limit.
    const overweight = await merge(srcW, tgtW).expect(400);
    expect(overweight.body).toMatchObject({ code: 'bin-overweight' });
    expect(String(overweight.body.detail)).toContain('A-21');
    expect(String(overweight.body.detail)).toContain('10000');
    expect(String(overweight.body.detail)).toContain('5000');

    // Volume: 960M mm³ in the target + 60M moved > 1,000M mm³.
    const volumeExceeded = await merge(srcV, tgtV).expect(400);
    expect(volumeExceeded.body).toMatchObject({ code: 'bin-volume-exceeded' });
    expect(String(volumeExceeded.body.detail)).toContain('A-22');
    expect(String(volumeExceeded.body.detail)).toContain('1020000000');
    expect(String(volumeExceeded.body.detail)).toContain('1000000000');

    // Dim fit: the moved SKU's 500 mm length does not fit the 400 mm target.
    const oversize = await merge(srcD, tgtD).expect(400);
    expect(oversize.body).toMatchObject({ code: 'bin-item-oversize' });
    expect(String(oversize.body.detail)).toContain('A-24');
    expect(String(oversize.body.detail)).toContain('length');
    expect(String(oversize.body.detail)).toContain('400');
    expect(String(oversize.body.detail)).toContain('500');

    // Width and height bind the same way, each naming ITS dimension and both
    // numbers (triage #11): 400 mm of width > the 300 mm target, 300 mm of
    // height > the 200 mm target.
    const oversizeWidth = await merge(srcDW, tgtDW).expect(400);
    expect(oversizeWidth.body).toMatchObject({ code: 'bin-item-oversize' });
    expect(String(oversizeWidth.body.detail)).toContain('A-28');
    expect(String(oversizeWidth.body.detail)).toContain('width');
    expect(String(oversizeWidth.body.detail)).toContain('300');
    expect(String(oversizeWidth.body.detail)).toContain('400');

    const oversizeHeight = await merge(srcDH, tgtDH).expect(400);
    expect(oversizeHeight.body).toMatchObject({ code: 'bin-item-oversize' });
    expect(String(oversizeHeight.body.detail)).toContain('A-31');
    expect(String(oversizeHeight.body.detail)).toContain('height');
    expect(String(oversizeHeight.body.detail)).toContain('200');
    expect(String(oversizeHeight.body.detail)).toContain('300');

    // All-or-nothing: not one bin.merged event moved an arm.
    for (const sourceId of [srcW, srcV, srcD, srcDW, srcDH]) {
      expect((await mergeLedgerRows()).filter((row) => row.from_bin_id === sourceId)).toHaveLength(0);
    }
    expect(await plainOnHand(srcW, dimSkuId)).toBe(1);
    expect(await plainOnHand(tgtW, dimSkuId)).toBe(1);

    // A fitting merge with limits set moves cleanly — the gates are inert
    // until a limit trips (a merge cannot overflow what a placement cannot,
    // and conversely a fit is a fit).
    const fit = await merge(srcW, tgtOK).expect(200);
    expect(fit.body.target).toMatchObject({ code: 'A-26', maxWeightGrams: 100000, lengthMm: 2000 });
    expect(fit.body.source.retiredAt).not.toBeNull();
  });

  it('0034 round-trip: the four capacity columns exist on bins; the bounded CHECKs hold; RLS still gates the table', async () => {
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const columns = await admin`
        select column_name from information_schema.columns
        where table_name = 'bins'
        and column_name in ('length_mm', 'width_mm', 'height_mm', 'max_weight_grams')`;
      expect(columns.map((row) => row.column_name as string).sort()).toEqual([
        'height_mm',
        'length_mm',
        'max_weight_grams',
        'width_mm',
      ]);

      const checks = await admin`
        select conname from pg_constraint
        where conrelid = 'bins'::regclass and contype = 'c'
        and conname in ('bins_length_mm_bounded', 'bins_width_mm_bounded', 'bins_height_mm_bounded', 'bins_max_weight_grams_bounded')`;
      expect(checks).toHaveLength(4);

      // The bounds backstop: a zero dimension and an over-cap weight are
      // DB-rejected by any path; null (unconstrained) stays storable.
      const badDim = admin`
        insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, length_mm)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${zoneId}, ${`CHK-${ulid().slice(0, 6)}`}, ${toMilli(10)}, 'shelf', 0)`;
      await expect(badDim).rejects.toThrow(/bins_length_mm_bounded/i);
      const badWeight = admin`
        insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, max_weight_grams)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${zoneId}, ${`CHK-${ulid().slice(0, 6)}`}, ${toMilli(10)}, 'shelf', 100000001)`;
      await expect(badWeight).rejects.toThrow(/bins_max_weight_grams_bounded/i);

      // Story 12-1: the storage-class vocabulary's DB backstop — the third
      // layer (TS tuple / CHECK / @IsIn). The HTTP refusals happen in TS, so
      // only a direct out-of-vocabulary write proves the CHECK exists.
      const badClass = admin`
        insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, storage_class)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${zoneId}, ${`CHK-${ulid().slice(0, 6)}`}, ${toMilli(10)}, 'shelf', 'tropical')`;
      await expect(badClass).rejects.toThrow(/bins_storage_class_check/i);

      // RLS still gates the table (the Story 1.3 probes, against the new
      // columns): a probe role scoped to a foreign tenant reads nothing of
      // ours, an unscoped read fails closed.
      const foreignTenantId = uuidv7();
      const probeUrl = new URL(process.env.DATABASE_URL!);
      probeUrl.username = 'wms_rls_probe';
      probeUrl.password = 'wms_rls_probe';
      const scoped = postgres(probeUrl.toString(), { max: 1 });
      try {
        const foreignSelect = await scoped.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${foreignTenantId}, true)`;
          return tx`select id, length_mm, max_weight_grams from bins where tenant_id = ${tenantId}`;
        });
        expect(foreignSelect).toHaveLength(0);

        const unscoped = await scoped`select id from bins where tenant_id = ${tenantId}`;
        expect(unscoped).toHaveLength(0);
      } finally {
        await scoped.end();
      }
    } finally {
      await admin.end();
    }
  });

  it('0016 round-trip: retired_at/retired_by exist on bins; the pairing CHECK holds; RLS still gates the table', async () => {
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const columns = await admin`
        select column_name from information_schema.columns
        where table_name = 'bins' and column_name in ('retired_at', 'retired_by')`;
      expect(columns.map((row) => row.column_name as string).sort()).toEqual(['retired_at', 'retired_by']);

      const checks = await admin`
        select conname from pg_constraint
        where conrelid = 'bins'::regclass and contype = 'c' and conname = 'bins_retired_pairing'`;
      expect(checks).toHaveLength(1);

      // The pairing CHECK: a retired_at without retired_by violates.
      const violation = admin`
        insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, retired_at)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${zoneId}, ${`CHK-${ulid().slice(0, 6)}`}, ${toMilli(10)}, 'shelf', now())`;
      await expect(violation).rejects.toThrow(/bins_retired_pairing/i);
    } finally {
      await admin.end();
    }

    // RLS still gates the table (the Story 1.3 probes, against the new columns):
    // a probe role scoped to a foreign tenant reads nothing of ours, an
    // unscoped read fails closed.
    let scoped: postgres.Sql<Record<string, unknown>> | undefined;
    try {
      const foreignTenantId = uuidv7();
      const probeUrl = new URL(process.env.DATABASE_URL!);
      probeUrl.username = 'wms_rls_probe';
      probeUrl.password = 'wms_rls_probe';
      scoped = postgres(probeUrl.toString(), { max: 1 });

      const foreignSelect = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${foreignTenantId}, true)`;
        return tx`select id, retired_at, retired_by from bins where tenant_id = ${tenantId}`;
      });
      expect(foreignSelect).toHaveLength(0);

      const unscoped = await scoped`select id from bins where tenant_id = ${tenantId}`;
      expect(unscoped).toHaveLength(0);
    } finally {
      await scoped?.end();
    }
  });

  // ── Story 12-1 — storage classes + the class-edit guards (FR-40/AD-18) ─────

  it('storage classes: create/grid carry the class (default ambient), a merge into a non-conforming target is refused naming the offending SKUs, and a class edit is guarded by stock, open holds and system bins', async () => {
    // A frozen-class SKU, imported and PATCHed while it still carries no
    // stock (the SKU-side guard would refuse a change that would strand
    // live stock).
    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
      'BA-SC,Bin Admin Item SC,pcs,,1800,,false,false,,,',
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
    const frozenSkuId = (skus.body.items as { code: string; id: string }[]).find((item) => item.code === 'BA-SC')!.id;
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/catalog/skus/${frozenSkuId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ storageClass: 'frozen' })
      .expect(200);

    const postBin = async (code: string, storageClass?: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, capacity: 100, type: 'shelf', ...(storageClass === undefined ? {} : { storageClass }) })
          .expect(201)
      ).body.id as string;
    const binChill = await postBin('A-90-01', 'chilled');
    const binEmpty = await postBin('A-90-02'); // the default
    const binFrozenSku = await postBin('A-90-03', 'ambient');
    const binHeld = await postBin('A-90-04', 'ambient');

    // The zone list echoes the classes; the omitted one defaulted to ambient.
    const listed = await zoneBins(zoneId);
    const listedByCode = new Map(listed.map((bin) => [bin.code, bin]));
    expect(listedByCode.get('A-90-01')).toMatchObject({ storageClass: 'chilled' });
    expect(listedByCode.get('A-90-02')).toMatchObject({ storageClass: 'ambient' });

    // A grid run stamps the class on EVERY bin it generates.
    const grid = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins/grid`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ aisleFrom: 'D', aisleTo: 'D', baysPerAisle: 1, levelsPerBay: 2, capacity: 50, type: 'shelf', storageClass: 'hazardous' })
      .expect(201);
    expect(grid.body).toMatchObject({ generatedCount: 2 });
    const gridListed = await zoneBins(zoneId);
    expect(gridListed.find((bin) => bin.code === 'D-01-01')).toMatchObject({ storageClass: 'hazardous' });
    expect(gridListed.find((bin) => bin.code === 'D-01-02')).toMatchObject({ storageClass: 'hazardous' });

    // The vocabulary is closed at the boundary: a misspelled class is a 400
    // naming the field (the DTO `@IsIn` here; the command validator behind
    // the replay for non-HTTP callers).
    const bad = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A-90-05', capacity: 100, type: 'shelf', storageClass: 'tropical' })
      .expect(400);
    expect(bad.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(String(bad.body.detail)).toContain('storageClass');

    // THE MERGE CLASS GATE: the source (ambient bin) holds frozen-class stock
    // parked there by the named adjustment bypass; merging it into the
    // chilled target would strand that stock in a warmer bin — 400
    // `bin-storage-mismatch` naming the offending SKU and its requirement,
    // and NOTHING moves (the source is not retired, its stock is untouched).
    await fill(binFrozenSku, frozenSkuId, 2);
    const refusedMerge = await merge(binFrozenSku, binChill).expect(400);
    expect(refusedMerge.body).toMatchObject({ status: 400, code: 'bin-storage-mismatch' });
    expect(String(refusedMerge.body.detail)).toContain('A-90-01');
    expect(String(refusedMerge.body.detail)).toContain('BA-SC');
    expect(String(refusedMerge.body.detail)).toContain('frozen');
    expect(await plainOnHand(binFrozenSku, frozenSkuId)).toBe(2);
    const afterRefusedMerge = await zoneBins(zoneId);
    expect(afterRefusedMerge.find((bin) => bin.code === 'A-90-03')!.retiredAt).toBeNull();

    // THE CLASS-EDIT GUARD, stock arm: an edit that would strand live stock
    // is 409 `storage-class-conflict` naming the SKU. A conforming edit over
    // the SAME kind of stock commits (frozen satisfies the ambient stock
    // below), so the guard is the predicate, not any blanket refusal.
    const emptyEdit = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binEmpty}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ storageClass: 'frozen' })
      .expect(200);
    expect(emptyEdit.body).toMatchObject({ code: 'A-90-02', storageClass: 'frozen' });

    await fill(binHeld, plainSkuId, 1); // ambient stock in the ambient bin
    const conformingEdit = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binHeld}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ storageClass: 'frozen' })
      .expect(200);
    expect(conformingEdit.body).toMatchObject({ storageClass: 'frozen' });

    const binStranded = await postBin('A-90-06', 'ambient');
    await fill(binStranded, frozenSkuId, 1); // the named adjustment bypass
    const stranded = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binStranded}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ storageClass: 'chilled' })
      .expect(409);
    expect(stranded.body).toMatchObject({ status: 409, code: 'storage-class-conflict' });
    expect(String(stranded.body.detail)).toContain('BA-SC');
    // The refusal left the class — and the stock — exactly as it found them.
    const stillListed = await zoneBins(zoneId);
    expect(stillListed.find((bin) => bin.code === 'A-90-06')).toMatchObject({ storageClass: 'ambient' });
    expect(await plainOnHand(binStranded, frozenSkuId)).toBe(1);

    // THE CLASS-EDIT GUARD, hold arm: an OPEN hold pins its quantity to the
    // origin bin even after qc.place moved the stock to the QC bin — the
    // origin bin is empty, but the release must be able to return the stock,
    // so a class the held SKU does not satisfy is 409 naming the hold and
    // the SKU. A hold whose SKU the new class DOES satisfy does not block.
    const holdBin = await postBin('A-90-07', 'ambient');
    await fill(holdBin, plainSkuId, 1);
    const conformingHold = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/qc-holds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: plainSkuId, binId: holdBin, reason: 'damaged carton' })
        .expect(201)
    ).body.qcHold as { id: string };
    await fill(holdBin, frozenSkuId, 1);
    const offendingHold = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/qc-holds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: frozenSkuId, binId: holdBin, reason: 'temperature excursion' })
        .expect(201)
    ).body.qcHold as { id: string };
    const heldEdit = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${holdBin}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ storageClass: 'chilled' })
      .expect(409);
    expect(heldEdit.body).toMatchObject({ status: 409, code: 'storage-class-conflict' });
    expect(String(heldEdit.body.detail)).toContain(offendingHold.id);
    expect(String(heldEdit.body.detail)).toContain('BA-SC');
    expect(String(heldEdit.body.detail)).not.toContain(conformingHold.id);

    // System bins skip the guard by design (their stock is flow, not
    // storage): the Receiving bin's class may change freely.
    const receiving = await receivingBinId();
    const systemEdit = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${receiving}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ storageClass: 'chilled' })
      .expect(200);
    expect(systemEdit.body).toMatchObject({ storageClass: 'chilled' });
  });

  it('storage-class dispatch: a class-only body routes to the structure arm, blocked and storageClass refuse to mix, an explicit null is a 400, and a pre-12.1 create snapshot replays with the ambient fallback', async () => {
    const postBin = async (code: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, capacity: 100, type: 'shelf' })
          .expect(201)
      ).body.id as string;
    const binDispatch = await postBin('A-92-01');
    const binMixed = await postBin('A-92-02');
    const binNulled = await postBin('A-92-03');

    // A class-only body routes to the STRUCTURE arm (tenancy owns the class):
    // it answers through editBinCapacity and the class changes.
    const classOnly = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binDispatch}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ storageClass: 'chilled' })
      .expect(200);
    expect(classOnly.body).toMatchObject({ id: binDispatch, storageClass: 'chilled' });

    // One operation per key: a blocked change and a class change in one body
    // is a 400 (the dispatch refusal), not a silent mix.
    const mixed = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binMixed}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ blocked: true, storageClass: 'chilled' })
      .expect(400);
    expect(mixed.body).toMatchObject({ status: 400, code: 'validation-failed' });

    // The 11-5 `blocked` precedent: `storageClass: null` is a 400 (the DTO's
    // `@IsOptional` skips null, and the command treats only `undefined` as
    // absent — without this guard a null reaches the NOT NULL column as a
    // 500).
    const nulled = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binNulled}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ storageClass: null })
      .expect(400);
    expect(nulled.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(String(nulled.body.detail)).toContain('storageClass');

    // Legacy replay: a key whose snapshot predates the 12-1 column (no
    // `storageClass` in the stored bin) replays 200 through `normalizeBin`
    // with the ambient fallback — and the hand-computed digest pins that a
    // legacy-shaped body still fingerprints byte-identically (a hash-shape
    // change would answer 422 idempotency-key-reuse here, not 200).
    const key = ulid();
    const payloadHash = hashCommandPayload({
      tenantId,
      warehouseId,
      zoneId,
      code: 'A-92-04',
      capacity: 100,
      type: 'shelf',
      // NOTE the absence: a pre-12.1 build had no such key to emit.
      // `JSON.stringify` drops it on today's build too (absent = unchanged),
      // which is exactly what makes the two builds hash the same bytes.
    });
    const legacySnapshot = {
      bin: {
        id: uuidv7(),
        tenantId,
        warehouseId,
        zoneId,
        code: 'A-92-04',
        capacity: 100,
        type: 'shelf',
        blocked: false,
        createdAt: new Date().toISOString(),
      },
    };
    const seed = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await seed`
        insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (${uuidv7()}, ${tenantId}, ${key}, ${payloadHash}, ${seed.json(legacySnapshot)})`;
    } finally {
      await seed.end();
    }
    const replay = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send({ code: 'A-92-04', capacity: 100, type: 'shelf' })
      .expect(201);
    expect(replay.body).toMatchObject({ code: 'A-92-04', storageClass: 'ambient' });
  });

  // ── Story 12-2 — the merge hazard gate (FR-41) ─────────────────────────────

  it('merge hazard gate: a merge whose moved rows are segregated from a target occupant is refused whole naming both parties — both directions and every decided pair; same-SKU consolidation merges, a null-class row merges, and moved-vs-moved pairs are not re-checked', async () => {
    // Six classed SKUs (import + PATCH while stockless); BA-B stays
    // class-less — null carries no rule in either direction.
    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
      'HA-OX,Hazard Item OX,pcs,,1800,,false,false,,,',
      'HA-FL,Hazard Item FL,pcs,,1800,,false,false,,,',
      'HA-AC,Hazard Item AC,pcs,,1800,,false,false,,,',
      'HA-BS,Hazard Item BS,pcs,,1800,,false,false,,,',
      'HA-TO,Hazard Item TO,pcs,,1800,,false,false,,,',
      'HA-GA,Hazard Item GA,pcs,,1800,,false,false,,,',
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
    const byCode = new Map(
      (skus.body.items as { code: string; id: string }[]).map((item) => [item.code, item.id]),
    );
    const oxId = byCode.get('HA-OX')!;
    const flId = byCode.get('HA-FL')!;
    const acId = byCode.get('HA-AC')!;
    const bsId = byCode.get('HA-BS')!;
    const toId = byCode.get('HA-TO')!;
    const gaId = byCode.get('HA-GA')!;
    for (const [skuId, hazardClass] of [
      [oxId, 'oxidizer'],
      [flId, 'flammable'],
      [acId, 'corrosive-acid'],
      [bsId, 'corrosive-base'],
      [toId, 'toxic'],
      [gaId, 'gas'],
    ] as const) {
      await request(app.getHttpServer())
        .patch(`${API}/${tenantId}/catalog/skus/${skuId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ hazardClass })
        .expect(200);
    }

    const hazardBin = async (code: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, capacity: 100, type: 'shelf' })
          .expect(201)
      ).body.id as string;

    // THE GATE, four decided pairs × both directions where it matters, via
    // the real merge surface. Each refusal names the target bin, BOTH SKU
    // codes and BOTH classes — and NOTHING moves (the source keeps its rows
    // and stays un-retired). Fills park stock through the named adjustment
    // bypass; the merge is the gate under test.
    const refusals: { source: string; target: string; occupantId: string; occupantSku: string; occupantClass: string; movedId: string; movedSku: string; movedClass: string; binCode: string }[] = [];
    const layout = async (
      occupantId: string,
      occupantSku: string,
      occupantClass: string,
      movedId: string,
      movedSku: string,
      movedClass: string,
    ) => {
      const target = await hazardBin(`A-93-${String(refusals.length * 2 + 1).padStart(2, '0')}`);
      const source = await hazardBin(`A-93-${String(refusals.length * 2 + 2).padStart(2, '0')}`);
      await fill(target, occupantId, 1);
      await fill(source, movedId, 1);
      refusals.push({ source, target, occupantId, occupantSku, occupantClass, movedId, movedSku, movedClass, binCode: `A-93-${String(refusals.length * 2 + 1).padStart(2, '0')}` });
    };
    await layout(oxId, 'HA-OX', 'oxidizer', flId, 'HA-FL', 'flammable'); // FR-41's oxidiser/fuel example
    await layout(flId, 'HA-FL', 'flammable', oxId, 'HA-OX', 'oxidizer'); // the REVERSE direction
    await layout(acId, 'HA-AC', 'corrosive-acid', bsId, 'HA-BS', 'corrosive-base');
    await layout(toId, 'HA-TO', 'toxic', acId, 'HA-AC', 'corrosive-acid');
    await layout(oxId, 'HA-OX', 'oxidizer', gaId, 'HA-GA', 'gas');
    for (const [i, refusal] of refusals.entries()) {
      const binCode = `A-93-${String(i * 2 + 1).padStart(2, '0')}`;
      const res = await merge(refusal.source, refusal.target).expect(400);
      expect(res.body).toMatchObject({ status: 400, code: 'bin-segregation-conflict' });
      expect(String(res.body.detail)).toContain(binCode);
      expect(String(res.body.detail)).toContain(refusal.occupantSku);
      expect(String(res.body.detail)).toContain(refusal.occupantClass);
      expect(String(res.body.detail)).toContain(refusal.movedSku);
      expect(String(res.body.detail)).toContain(refusal.movedClass);
      expect(await plainOnHand(refusal.source, refusal.movedId)).toBe(1);
      const listed = await zoneBins(zoneId);
      expect(listed.find((bin) => bin.id === refusal.source)!.retiredAt).toBeNull();
    }

    // SAME-SKU CONSOLIDATION: the moved row's OWN pairs are skipped — two
    // oxidizer SKUs are one SKU; the merge proceeds and the stock consolidates.
    const oxTarget = await hazardBin('A-94-01');
    const oxSource = await hazardBin('A-94-02');
    await fill(oxTarget, oxId, 2);
    await fill(oxSource, oxId, 1);
    await merge(oxSource, oxTarget).expect(200);
    expect(await plainOnHand(oxTarget, oxId)).toBe(3);

    // A NULL-CLASS moved row beside a hazardous occupant merges (null is not
    // a class — the decided narrowing, on the merge surface).
    const nullTarget = await hazardBin('A-94-03');
    const nullSource = await hazardBin('A-94-04');
    await fill(nullTarget, oxId, 1);
    await fill(nullSource, plainSkuId, 1);
    await merge(nullSource, nullTarget).expect(200);
    expect(await plainOnHand(nullTarget, plainSkuId)).toBe(1);

    // MOVED-VS-MOVED is not re-checked: the two incompatible classes already
    // co-locate in the source (the adjustment bypass put them there); the
    // gate reads the TARGET's occupants, and this target is empty.
    const togetherTarget = await hazardBin('A-94-05');
    const togetherSource = await hazardBin('A-94-06');
    await fill(togetherSource, oxId, 1);
    await fill(togetherSource, flId, 1);
    await merge(togetherSource, togetherTarget).expect(200);
    expect(await plainOnHand(togetherTarget, oxId)).toBe(1);
    expect(await plainOnHand(togetherTarget, flId)).toBe(1);
  });

  // ── Story 12-3 — the secure-bin authority gate on merge (FR-42) ────────────

  it('secure merge: a holder merges cage-to-cage with byte-identical behavior (the gate fires and passes; the operator-less 403 shape is unit-pinned in users.spec)', async () => {
    // A secure-class SKU (the shared fixture — import, then patch before any
    // stock exists) and two secure bins. The source's stock arrives through
    // the named stock.adjust bypass — the same state the merge guard reads on
    // the floor.
    const secSkuId = await importSecureSku(app, tenantId, ownerToken, 'BA-SEC');

    const secureBin = async (code: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, capacity: 100, type: 'shelf', storageClass: 'secure' })
          .expect(201)
      ).body.id as string;
    const ownerSource = await secureBin('A-95-01');
    const ownerTarget = await secureBin('A-95-02');
    await fill(ownerSource, secSkuId, 2);

    // THE OWNER ARM: both bins are secure, so the 12-3 gate is ON this call —
    // and it passes for a holder. The merge behaves exactly as it did before
    // the gate existed: stock moved, source retired.
    const res = await merge(ownerSource, ownerTarget).expect(200);
    expect(res.body.moved).toEqual({ skus: 1, units: 2 });
    expect(res.body.source.retiredAt).not.toBeNull();
    expect(await plainOnHand(ownerTarget, secSkuId)).toBe(2);
    expect(await plainOnHand(ownerSource, secSkuId)).toBe(0);

    // THE OPS-MANAGER ARM: the second holder passes the same firing gate.
    const opsSource = await secureBin('A-95-03');
    const opsTarget = await secureBin('A-95-04');
    await fill(opsSource, secSkuId, 1);
    await merge(opsSource, opsTarget, opsManagerToken).expect(200);
    expect(await plainOnHand(opsTarget, secSkuId)).toBe(1);
    expect(await plainOnHand(opsSource, secSkuId)).toBe(0);
  });

  // ── Story 12-4 — non-bin location types + the bulk-asset rules ─────────────

  it('0037 round-trip: the bins_type_check CHECK exists, every location type in the vocabulary conforms, and an out-of-vocabulary write is DB-rejected', async () => {
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const checks = await admin`
        select conname from pg_constraint
        where conrelid = 'bins'::regclass and contype = 'c' and conname = 'bins_type_check'`;
      expect(checks).toHaveLength(1);

      // The vocabulary's DB backstop (the third layer — TS tuple / CHECK /
      // @IsIn): every value the TS tuple names is storable by ANY writer,
      // and the four pre-existing types among them prove zero data mutation.
      for (const type of LOCATION_TYPES) {
        const ok = admin`
          insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type)
          values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${zoneId}, ${`CHK-${ulid()}`}, ${toMilli(10)}, ${type})`;
        await expect(ok).resolves.toBeDefined();
      }

      // And anything outside the tuple is rejected by the CHECK itself —
      // the migration-level I/O row.
      const badType = admin`
        insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${zoneId}, ${`CHK-${ulid()}`}, ${toMilli(10)}, 'walk-in-cooler')`;
      await expect(badType).rejects.toThrow(/bins_type_check/i);
    } finally {
      await admin.end();
    }
  });

  it('bulk assets: tank/silo require maxWeightGrams at create, grids refuse them, PATCH cannot clear the weight; yard/floor-stack carry no extra rule — and a merge into a tank holding another SKU is 400 bin-occupancy-conflict naming the holding SKU, while same-SKU and single-SKU merges land', async () => {
    const createTyped = (body: Record<string, unknown>): SupertestTest =>
      request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send(body);
    const gridReq = (body: Record<string, unknown>): SupertestTest =>
      request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins/grid`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send(body);

    // ── master data: the weight rule ──────────────────────────────────────
    // A tank/silo WITHOUT maxWeightGrams is 400 validation-failed — both the
    // absent and the explicit-null shape (creation has no "leave unchanged").
    const tankNoWeight = await createTyped({ code: 'A-96-T0', capacity: 100, type: 'tank' }).expect(400);
    expect(tankNoWeight.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(String(tankNoWeight.body.detail)).toContain('maxWeightGrams');
    const tankNullWeight = await createTyped({ code: 'A-96-T0', capacity: 100, type: 'tank', maxWeightGrams: null }).expect(400);
    expect(tankNullWeight.body).toMatchObject({ code: 'validation-failed' });

    // WITH the weight, both bulk types create cleanly; yard and floor-stack
    // carry NO extra rule (Design Note 4 — absent stays legal = unconstrained).
    const tankT1 = (
      await createTyped({ code: 'A-96-T1', capacity: 100, type: 'tank', maxWeightGrams: 1_000_000 }).expect(201)
    ).body.id as string;
    const tankT2 = (
      await createTyped({ code: 'A-96-T2', capacity: 100, type: 'silo', maxWeightGrams: 500_000 }).expect(201)
    ).body.id as string;
    const yard = (
      await createTyped({ code: 'A-96-Y1', capacity: 1000, type: 'yard' }).expect(201)
    ).body.id as string;
    const floorStack = (
      await createTyped({ code: 'A-96-F1', capacity: 1000, type: 'floor-stack' }).expect(201)
    ).body.id as string;
    expect(yard).toBeDefined();
    expect(floorStack).toBeDefined();
    // (T2 is typed 'silo' — the variable name tracks the asset, not the type.)

    // ── master data: the grid rule ────────────────────────────────────────
    // The DTO's enum narrowed to the six grid-able types (review 2): the
    // ValidationPipe refuses a bulk type in front of the command, naming the
    // grid-able set — the runtime `refuseBulkAssetGrid` stays as the backstop
    // for a caller that bypasses the pipe.
    for (const bulkType of ['tank', 'silo']) {
      const res = await gridReq({ aisleFrom: 'D', aisleTo: 'D', baysPerAisle: 1, levelsPerBay: 1, capacity: 10, type: bulkType }).expect(400);
      expect(res.body).toMatchObject({ status: 400, code: 'validation-failed' });
      expect(String(res.body.detail)).toContain('one of the following values');
      expect(String(res.body.detail)).not.toContain(bulkType);
    }
    // An ordinary type grids exactly as before (no collateral narrowing).
    await gridReq({ aisleFrom: 'E', aisleTo: 'E', baysPerAisle: 1, levelsPerBay: 1, capacity: 10, type: 'floor' }).expect(201);

    // ── master data: the PATCH rule — null clears on an ordinary bin, never
    // on a bulk asset; a re-value stays legal ─────────────────────────────
    const clear = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${tankT1}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ maxWeightGrams: null })
      .expect(400);
    expect(clear.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(String(clear.body.detail)).toContain('tank');
    const reweight = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${tankT1}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ maxWeightGrams: 2_000_000 })
      .expect(200);
    expect(reweight.body.maxWeightGrams).toBe(2_000_000);
    // (review 2) Null CLEARS on an ordinary bin — the never-clear rule is
    // bulk-only: set, then clear, both 200, ending unconstrained.
    const setOrdinary = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${floorStack}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ maxWeightGrams: 250_000 })
      .expect(200);
    expect(setOrdinary.body.maxWeightGrams).toBe(250_000);
    const clearOrdinary = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${floorStack}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ maxWeightGrams: null })
      .expect(200);
    expect(clearOrdinary.body.maxWeightGrams).toBeNull();

    // ── the merge occupancy gate (single-SKU rule, the merge arm) ─────────
    // DIFFERENT SKU into a holding tank → 400 `bin-occupancy-conflict`
    // naming the holding SKU; NOTHING moves and the source stays un-retired
    // (the gate is before every arm — the class gate here passes, both
    // ambient).
    await fill(tankT1, plainSkuId, 1);
    const wrongSrc = (
      await createTyped({ code: 'A-96-S1', capacity: 100, type: 'shelf' }).expect(201)
    ).body.id as string;
    await fill(wrongSrc, batchSkuId, 1, { batchCode: "LOT-BA-96-A" });
    const wrongMerge = await merge(wrongSrc, tankT1).expect(400);
    expect(wrongMerge.body).toMatchObject({ status: 400, code: 'bin-occupancy-conflict' });
    expect(String(wrongMerge.body.detail)).toContain('BA-B');
    expect(await plainOnHand(wrongSrc, batchSkuId)).toBe(1);
    const stillLive = await zoneBins(zoneId);
    expect(stillLive.find((bin) => bin.id === wrongSrc)!.retiredAt).toBeNull();

    // SAME-SKU top-up merges (the predicate's union stays at one SKU).
    const topUpSrc = (
      await createTyped({ code: 'A-96-S2', capacity: 100, type: 'shelf' }).expect(201)
    ).body.id as string;
    await fill(topUpSrc, plainSkuId, 1);
    await merge(topUpSrc, tankT1).expect(200);
    expect(await plainOnHand(tankT1, plainSkuId)).toBe(2);

    // TWO moved SKUs into an EMPTY bulk asset refuse (moved-vs-moved — the
    // single-SKU rule covers what the hazard gate deliberately skips).
    const multiSrc = (
      await createTyped({ code: 'A-96-S3', capacity: 100, type: 'shelf' }).expect(201)
    ).body.id as string;
    await fill(multiSrc, batchSkuId, 1, { batchCode: "LOT-BA-96-A" });
    await fill(multiSrc, plainSkuId, 1);
    const multiMerge = await merge(multiSrc, tankT2).expect(400);
    expect(multiMerge.body).toMatchObject({ code: 'bin-occupancy-conflict' });
    expect(String(multiMerge.body.detail)).toContain('BA-A');
    expect(String(multiMerge.body.detail)).toContain('BA-B');
    expect(await plainOnHand(multiSrc, batchSkuId)).toBe(1);

    // ONE moved SKU into the still-empty asset merges cleanly.
    const singleSrc = (
      await createTyped({ code: 'A-96-S4', capacity: 100, type: 'shelf' }).expect(201)
    ).body.id as string;
    await fill(singleSrc, batchSkuId, 1, { batchCode: "LOT-BA-96-A" });
    const singleMerge = await merge(singleSrc, tankT2).expect(200);
    expect(singleMerge.body.moved).toEqual({ skus: 1, units: 1 });
    expect(await plainOnHand(tankT2, batchSkuId)).toBe(1);
  });
});
