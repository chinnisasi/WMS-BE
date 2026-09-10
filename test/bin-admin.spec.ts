import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';

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

  beforeAll(async () => {
    // Same deployment-parity probes as the sibling suites (auth + RLS roles,
    // serialized across parallel jest workers by the advisory lock).
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742106)`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_auth_probe') then
              create role wms_auth_probe login password 'wms_auth_probe' nosuperuser bypassrls;
            end if;
            if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
              create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_auth_probe, wms_rls_probe');
        await tx.unsafe(
          'grant select, insert, update, delete on all tables in schema public to wms_auth_probe, wms_rls_probe',
        );
      });
      const authUrl = new URL(process.env.DATABASE_URL!);
      authUrl.username = 'wms_auth_probe';
      authUrl.password = 'wms_auth_probe';
      process.env.DATABASE_AUTH_URL = authUrl.toString();
    } finally {
      await admin.end();
    }
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
        .send({ code: `BA-${ulid().slice(10, 16).toUpperCase()}`, name: `Bin Admin Depot ${ulid()}` })
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
      return rows as unknown as MergeLedgerRow[];
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
        select coalesce(sum(quantity), 0)::int as n from stock_on_hand
        where tenant_id = ${tenantId} and bin_id = ${binId} and sku_id = ${skuId}`;
      return Number((rows[0] as unknown as { n: number }).n);
    } finally {
      await sql.end();
    }
  }

  async function batchOnHand(binId: string, skuId: string, batchId: string): Promise<number> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select coalesce(sum(quantity), 0)::int as n from batch_on_hand
        where tenant_id = ${tenantId} and bin_id = ${binId} and sku_id = ${skuId} and batch_id = ${batchId}`;
      return Number((rows[0] as unknown as { n: number }).n);
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
    expect(blocked.body).toMatchObject({ id: binA04, blocked: true });

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
        .send({ code: `BA2-${ulid().slice(10, 16).toUpperCase()}`, name: `Second Depot ${ulid()}` })
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
        update stock_on_hand set quantity = quantity + 1
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

  // ── the schema contract: RLS + the 0016 round-trip ──────────────────────────

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
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${zoneId}, ${`CHK-${ulid().slice(0, 6)}`}, 10, 'shelf', now())`;
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
});