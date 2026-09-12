import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres (docker-compose dev DB by
// default; CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

// The concurrent-drain arm parks a request on the per-(tenant, warehouse)
// advisory lock while a manual drain commits — the default 5s test timeout
// is tighter than the honest window.
jest.setTimeout(20_000);

describe('putaway: directed placement (e2e, story 3.5)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let warehouseId: string;
  let batchSkuId: string; // batch-tracked (the placement's batch arm)
  let plainSkuId: string; // untracked (plain placements + occupancy prefill)
  let serialSkuId: string; // serial-tracked (the serial arm)
  let deviceToken: string;
  let operatorToken: string; // the badge-in operator's session token
  let operatorUserId: string;
  const operatorEmails: string[] = [];
  const operatorUserIds: string[] = [];

  // Bins (all in zone A of the one warehouse).
  let binA01: string;
  let binA02: string;
  let binA03: string;
  let binA04: string;
  let binA05: string; // the blocked arm
  let binA06: string; // the full-bin arm (capacity 5)

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('putaway');
    app = await createApp(false);
    await app.init();

    // Tenant + owner.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Putaway Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // Warehouse.
    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: `PUT-${ulid().slice(10, 16).toUpperCase()}`, name: `Putaway Depot ${ulid()}` })
        .expect(201)
    ).body.id as string;

    // SKUs: one batch-tracked, one untracked, one serial-tracked.
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      'PUT-A,Putaway Item A,pcs,,1800,,true,false,,,',
      'PUT-B,Putaway Item B,pcs,,1800,,false,false,,,',
      'PUT-S,Putaway Item S,pcs,,1800,,false,true,,,',
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
    batchSkuId = byCode.get('PUT-A')!;
    plainSkuId = byCode.get('PUT-B')!;
    serialSkuId = byCode.get('PUT-S')!;

    // Storage bins. Occupancy starts at zero everywhere: the suggestion's
    // lowest-occupancy-then-code ranking is deterministic in this suite.
    const zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
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
    binA05 = await createBin('A-05', 100);
    binA06 = await createBin('A-06', 5);

    // The floor device + its badge-in operator.
    const device = await enrollDevice('Putaway scanner 1');
    deviceToken = device.deviceToken;
    const badged = await badgeInOperator(device.deviceToken);
    operatorToken = badged.accessToken;
    operatorUserId = badged.operator.id;
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
      await sql.unsafe('DELETE FROM putaway_placements WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM qc_holds WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM over_receipts WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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

  interface GrnLine {
    poLineId: string | null;
    skuId: string;
    batchCode: string | null;
    mfgDate: string | null;
    qty: number;
  }

  /**
   * One blind receipt: the putaway work arrives (the receiving bin ensured on
   * the tenant's first receipt). PO receipt plumbing is receiving.spec's
   * coverage; this suite needs the applied-stock-in-Receiving state only.
   */
  async function blindGrn(lines: GrnLine[]): Promise<{ grnId: string; lines: { grnId: string; id: string; skuId: string; batchId: string | null; qty: number; appliedQty: number }[] }> {
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
    const grn = res.body.goodsReceipt as { id: string; lines: { id: string; skuId: string; batchId: string | null; qty: number; appliedQty: number }[] };
    return { grnId: grn.id, lines: grn.lines.map((line) => ({ ...line, grnId: grn.id })) };
  }

  interface PlaceBody {
    warehouseId: string;
    grnId: string;
    grnLineId: string;
    skuId: string;
    batchId?: string | null;
    qty: number;
    toBinId: string;
    reasonCode?: string | null;
    occurredAt: string;
    serials?: string[] | null;
  }

  function place(body: PlaceBody, token = operatorToken, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/putaway/placements`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function placeForLine(
    line: { grnId: string; id: string; skuId: string; batchId: string | null; qty: number },
    toBinId: string,
    overrides: Partial<PlaceBody> = {},
    key = ulid(),
  ): SupertestTest {
    return place(
      {
        warehouseId,
        grnId: line.grnId,
        grnLineId: line.id,
        skuId: line.skuId,
        batchId: line.batchId,
        qty: line.qty,
        toBinId,
        reasonCode: null,
        occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        ...overrides,
      },
      operatorToken,
      key,
    );
  }

  function adjust(body: Record<string, unknown>, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function enrollDevice(label: string): Promise<{ deviceId: string; deviceToken: string }> {
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label, pin: '1357' })
      .expect(201);
    return {
      deviceId: enrolled.body.device.id as string,
      deviceToken: enrolled.body.deviceToken as string,
    };
  }

  /** Badge one operator onto a device: invite + accept + device badge-in. */
  async function badgeInOperator(
    deviceToken: string,
    email = `operator-${ulid().toLowerCase()}@example.com`,
  ): Promise<{ accessToken: string; operator: { id: string; role: string } }> {
    operatorEmails.push(email);
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role: 'operator' })
      .expect(201);
    operatorUserIds.push(invited.body.user.id as string);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ operatorEmail: email, pin: '1357' })
      .expect(200);
    return {
      accessToken: res.body.accessToken as string,
      operator: res.body.operator as { id: string; role: string },
    };
  }

  async function getTasks(): Promise<
    { grnId: string; grnCode: string; grnLineId: string; skuId: string; skuCode: string; batchId: string | null; batchCode: string | null; qty: number; suggestedBin: { binId: string; binCode: string } | null; rationale: string }[]
  > {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/putaway/tasks?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return res.body.items as never;
  }

  async function outboxRows(type: string, grnId: string | null = null): Promise<{ payload: Record<string, unknown> }[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = grnId === null
        ? await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = ${type}`
        : await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = ${type}
            and payload->>'grnId' = ${grnId}`;
      return rows as unknown as { payload: Record<string, unknown> }[];
    } finally {
      await sql.end();
    }
  }

  async function ledgerRows(grnId: string): Promise<
    { type: string; quantity_delta: number; from_bin_id: string | null; to_bin_id: string | null; serial_ref: string | null; reference_doc: Record<string, unknown> }[]
  > {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      return await sql`
        select type, quantity_delta, from_bin_id, to_bin_id, serial_ref, reference_doc
        from ledger_events
        where tenant_id = ${tenantId} and reference_doc->>'grnId' = ${grnId}
        order by seq`;
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

  async function receivingBinId(): Promise<string> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select b.id from bins b join zones z on z.id = b.zone_id
        where b.tenant_id = ${tenantId} and b.warehouse_id = ${warehouseId}
        and z.code = 'RECEIVING' and b.code = 'RECEIVING' and b.system_owned = true
        limit 1`;
      return (rows[0] as unknown as { id: string }).id;
    } finally {
      await sql.end();
    }
  }

  async function placementRowCount(grnId?: string): Promise<number> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = grnId === undefined
        ? await sql`select count(*)::int as n from putaway_placements where tenant_id = ${tenantId}`
        : await sql`select count(*)::int as n from putaway_placements where tenant_id = ${tenantId} and grn_id = ${grnId}`;
      return Number((rows[0] as unknown as { n: number }).n);
    } finally {
      await sql.end();
    }
  }

  /**
   * Whether any request is parked on the per-(tenant, warehouse) advisory
   * lock: an append blocked on an advisory lock shows up in
   * `pg_stat_activity` as active-with-lock-wait on the append's lock query.
   * (Keyed via `pg_locks.objid` would need the bigint key split into its
   * classid/objid halves — the query text is the simpler witness.)
   */
  async function advisoryWaiterCount(): Promise<number> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database()
        and state = 'active' and wait_event_type = 'Lock'
        and query ilike '%pg_advisory_xact_lock%'`;
      return Number((rows[0] as unknown as { n: number }).n);
    } finally {
      await sql.end();
    }
  }

  // ── Tasks read + suggestion (matrix rows 1–2) ───────────────────────────────

  it('tasks read: one derived task per unplaced GRN line with remaining = min(applied, receiving-bin on-hand) and the capacity-only suggestion; the device snapshot carries bins + putawayTasks', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: batchSkuId, batchCode: 'LOT-PW-1', mfgDate: null, qty: 40 }]);
    const line = first.lines[0]!;

    // Every storage bin is empty: the lowest-occupancy-then-code winner is A-01.
    const tasks = await getTasks();
    const task = tasks.find((entry) => entry.grnLineId === line.id)!;
    expect(task).toBeTruthy();
    expect(task).toMatchObject({
      grnId: first.grnId,
      skuId: batchSkuId,
      batchId: line.batchId,
      batchCode: 'LOT-PW-1',
      qty: 40,
    });
    expect(task.grnCode).toMatch(/^GRN-\d+$/);
    expect(task.suggestedBin).toEqual({ binId: binA01, binCode: 'A-01' });
    expect(task.rationale).toBe('Lowest occupancy (0/100) — room for 100');

    // The device snapshot (additive fields): every bin incl. blocked/system
    // ones, and the derived tasks with the nested suggestion.
    const snapshot = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    const bins = snapshot.body.bins as { id: string; code: string; blocked: boolean; systemOwned: boolean }[];
    const putawayTasks = snapshot.body.putawayTasks as typeof tasks;
    expect(bins.find((bin) => bin.id === binA01)).toMatchObject({ code: 'A-01', blocked: false, systemOwned: false });
    expect(bins.find((bin) => bin.code === 'RECEIVING')).toMatchObject({ systemOwned: true, blocked: false });
    expect(putawayTasks.find((task) => task.grnLineId === line.id)).toMatchObject({
      qty: 40,
      suggestedBin: { binId: binA01, binCode: 'A-01' },
    });
  });

  it('suggestion skips a filled bin (occupancy ranking), a blocked bin and a system bin; null when nothing fits', async () => {
    // A-01 is empty right now (the happy path fills it in the next test, so
    // probe the ranking arms that do not depend on it first): block A-05 and
    // fill A-06 to capacity, then a line of 11 has room only in A-01..A-04 —
    // and once A-02 is filled the winner moves on.
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binA05}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ blocked: true })
      .expect(200);
    await adjust({ warehouseId, skuId: plainSkuId, binId: binA06, quantityDelta: 5, reasonCode: 'cycle-count', note: 'fill A-06' }).expect(201);

    const second = await blindGrn([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 12 }]);
    const tasks = await getTasks();
    const task = tasks.find((entry) => entry.grnLineId === second.lines[0]!.id)!;
    expect(task.suggestedBin).toEqual({ binId: binA01, binCode: 'A-01' });

    // No bin fits: a line bigger than any single bin's remaining capacity
    // yields a task with no suggestion (the "no room" rationale).
    const oversized = await blindGrn([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 120 }]);
    const oversizedTasks = await getTasks();
    const oversizedTask = oversizedTasks.find((task) => task.grnLineId === oversized.lines[0]!.id)!;
    expect(oversizedTask.qty).toBe(120);
    expect(oversizedTask.suggestedBin).toBeNull();
    expect(oversizedTask.rationale).toBe('No storage bin has room for these units');
  });

  // ── Place happy path + replay (matrix rows 3–5) ────────────────────────────

  it('place happy path: one putaway.placed movement Receiving→target, the placement row, the outbox event, the audit row, the device heartbeat; the task leaves the list', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: batchSkuId, batchCode: 'LOT-PW-2', mfgDate: null, qty: 40 }]);
    const line = first.lines[0]!;
    const bin = await receivingBinId();

    const key = ulid();
    // Baselines BEFORE the placement — this suite's earlier unplaced GRNs
    // still hold stock in the Receiving bin (derived tasks, not per-line
    // truth), so every on-hand assertion here is a delta.
    const baselineRecvBatch = await batchOnHand(bin, batchSkuId, line.batchId!);
    const baselineTargetBatch = await batchOnHand(binA01, batchSkuId, line.batchId!);
    const baselineRecvPlain = await plainOnHand(bin, batchSkuId);
    const baselineTargetPlain = await plainOnHand(binA01, batchSkuId);
    const res = await placeForLine(line, binA01, {}, key).expect(201);
    const placement = res.body.placement as {
      id: string;
      grnId: string;
      grnCode: string;
      grnLineId: string;
      skuId: string;
      skuCode: string;
      batchCode: string | null;
      qty: number;
      fromBinId: string;
      toBinId: string;
      toBinCode: string;
      suggestedBinId: string | null;
      suggestedBinCode: string | null;
      reasonCode: string | null;
      placedBy: string;
      placedAt: string;
      deviceId: string;
    };
    expect(placement).toMatchObject({
      grnId: first.grnId,
      grnLineId: line.id,
      skuId: batchSkuId,
      skuCode: 'PUT-A',
      batchCode: 'LOT-PW-2',
      qty: 40,
      fromBinId: bin,
      toBinId: binA01,
      toBinCode: 'A-01',
      suggestedBinId: binA01,
      suggestedBinCode: 'A-01',
      reasonCode: null,
      placedBy: operatorUserId,
    });
    expect(placement.deviceId).toBeTruthy();

    // The ledger: ONE two-arm putaway.placed movement, batch arm carried.
    const events = await ledgerRows(first.grnId);
    expect(events).toHaveLength(2); // grn.received intake + the placement
    const placed = events[1]!;
    expect(placed).toMatchObject({
      type: 'putaway.placed',
      quantity_delta: 40,
      from_bin_id: bin,
      to_bin_id: binA01,
      serial_ref: null,
    });
    expect(placed.reference_doc).toEqual({
      kind: 'putaway',
      grnId: first.grnId,
      grnLineId: line.id,
      suggestedBinId: binA01,
    });

    // Both projections moved (the fold is per sku/batch/bin) — deltas
    // against the pre-placement baselines.
    expect(await batchOnHand(bin, batchSkuId, line.batchId!)).toBe(baselineRecvBatch - 40);
    expect(await batchOnHand(binA01, batchSkuId, line.batchId!)).toBe(baselineTargetBatch + 40);
    expect(await plainOnHand(bin, batchSkuId)).toBe(baselineRecvPlain - 40);
    expect(await plainOnHand(binA01, batchSkuId)).toBe(baselineTargetPlain + 40);

    // The outbox: one putaway.recorded carrying the decision record.
    const recorded = await outboxRows('putaway.recorded', first.grnId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({
      placementId: placement.id,
      grnCode: placement.grnCode,
      grnLineId: line.id,
      qty: 40,
      fromBinId: bin,
      toBinId: binA01,
      reasonCode: null,
    });

    // The audit row: action + target + the idempotency key as reference.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const audits = await sql`
        select action, target_id, reference from audit_events
        where tenant_id = ${tenantId} and target_id = ${placement.id}`;
      const auditRows = audits as unknown as { action: string; target_id: string; reference: string }[];
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.action).toBe('putaway.placed');
      expect(auditRows[0]!.reference).toBe(key);
    } finally {
      await sql.end();
    }

    // The task list: the placed line is gone (remaining 0).
    const tasks = await getTasks();
    expect(tasks.find((task) => task.grnLineId === line.id)).toBeUndefined();

    // The placements list carries the entry with its joined codes.
    const list = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/putaway/placements?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const entry = (list.body.items as { id: string; grnCode: string; skuCode: string; toBinCode: string; suggestedBinCode: string | null; reasonCode: string | null; deviceId: string }[]).find(
      (item) => item.id === placement.id,
    )!;
    expect(entry).toBeTruthy();
    expect(entry).toMatchObject({
      grnCode: placement.grnCode,
      skuCode: 'PUT-A',
      toBinCode: 'A-01',
      suggestedBinCode: 'A-01',
      reasonCode: null,
    });
    expect(entry.deviceId).toBe(placement.deviceId);
  });

  it('replay: same key + payload re-serves the snapshot with nothing re-moved; a different payload is 422; a missing key is 400', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 6 }]);
    const line = first.lines[0]!;
    const body = {
      warehouseId,
      grnId: first.grnId,
      grnLineId: line.id,
      skuId: plainSkuId,
      batchId: null,
      qty: 6,
      toBinId: binA02,
      reasonCode: 'consolidation-with-existing-stock',
      occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    };
    const key = ulid();
    const placed = await place(body, operatorToken, key).expect(201);
    const replayed = await place(body, operatorToken, key).expect(201);
    expect(replayed.body).toEqual(placed.body);

    // Exactly one movement + one placement row despite the replay.
    expect((await ledgerRows(first.grnId)).filter((event) => event.type === 'putaway.placed')).toHaveLength(1);
    expect(await placementRowCount(first.grnId)).toBe(1);
    expect(await plainOnHand(binA02, plainSkuId)).toBe(6);

    // Same key, different payload → 422.
    await place({ ...body, qty: 5 }, operatorToken, key)
      .expect(422)
      .then((res) => expect(res.body).toMatchObject({ code: 'idempotency-key-reuse' }));

    // Missing Idempotency-Key header → 400.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/putaway/placements`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send(body)
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'idempotency-key-required' }));
  });

  // ── Mismatch record (matrix row 12) ────────────────────────────────────────

  it('mismatch: a reason from the fixed enum is required when the target differs from the suggestion, and rides the placement row + ledger reference', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 12 }]);
    const line = first.lines[0]!;

    // A-01 (40), A-02 (6) and A-06 (5, out of room) are occupied; A-03 and
    // A-04 are empty → the suggestion is A-03. Placing into A-04 without a
    // reason is a 400 before any write.
    await placeForLine(line, binA04, {}, ulid())
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));

    const placed = await placeForLine(line, binA04, {
      reasonCode: 'consolidation-with-existing-stock',
    }).expect(201);
    const placement = placed.body.placement as { suggestedBinCode: string | null; toBinCode: string; reasonCode: string | null; id: string };
    expect(placement.toBinCode).toBe('A-04');
    expect(placement.suggestedBinCode).toBe('A-03');
    expect(placement.reasonCode).toBe('consolidation-with-existing-stock');

    // The reason rides the ledger reference doc too.
    const events = (await ledgerRows(first.grnId)).filter((event) => event.type === 'putaway.placed');
    expect(events).toHaveLength(1);
    expect(events[0]!.reference_doc).toMatchObject({
      kind: 'putaway',
      grnId: first.grnId,
      grnLineId: line.id,
      reasonCode: 'consolidation-with-existing-stock',
    });

    // A reason outside the fixed enum is a 400.
    const second = await blindGrn([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 2 }]);
    await placeForLine(second.lines[0]!, binA04, { reasonCode: 'wrong-pallet' })
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
  });

  // ── FR-10 gate arms (matrix rows 6–8) ──────────────────────────────────────

  it('full bin: 400 bin-full naming the bin code, its capacity and its occupancy; nothing written', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: batchSkuId, batchCode: 'LOT-PW-FULL', mfgDate: null, qty: 3 }]);
    const line = first.lines[0]!;
    // A-06 holds 5 of its capacity-5 (prefilled with PUT-B) — any placement overflows.
    const rejected = await placeForLine(line, binA06).expect(400);
    expect(rejected.body).toMatchObject({ status: 400, code: 'bin-full' });
    expect(rejected.body.detail).toContain('A-06');
    expect(rejected.body.detail).toContain('5');
    expect(rejected.body.detail).toContain('holds 5');
    expect(await ledgerRows(first.grnId)).toHaveLength(1); // grn.received only
    expect(await placementRowCount(first.grnId)).toBe(0);
  });

  it('blocked bin: 400 bin-blocked naming the bin; the snapshot carries blocked=true for the device pre-check', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: batchSkuId, batchCode: 'LOT-PW-BLK', mfgDate: null, qty: 2 }]);
    const line = first.lines[0]!;
    // A-05 was blocked in the suggestion test above.
    const snapshot = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    expect((snapshot.body.bins as { id: string; blocked: boolean }[]).find((bin) => bin.id === binA05)).toMatchObject({ blocked: true });

    const rejected = await placeForLine(line, binA05).expect(400);
    expect(rejected.body).toMatchObject({ status: 400, code: 'bin-blocked' });
    expect(rejected.body.detail).toContain('A-05');
    expect(await ledgerRows(first.grnId)).toHaveLength(1);
  });

  it('system bin as target: 400 validation-failed naming the bin; an unknown bin is 404', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: batchSkuId, batchCode: 'LOT-PW-SYS', mfgDate: null, qty: 2 }]);
    const line = first.lines[0]!;
    const bin = await receivingBinId();
    const rejected = await placeForLine(line, bin).expect(400);
    expect(rejected.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(rejected.body.detail).toContain('RECEIVING');
    expect(rejected.body.detail).toContain('system bin');

    await placeForLine(line, uuidv7())
      .expect(404)
      .then((res) => expect(res.body).toMatchObject({ code: 'not-found' }));
  });

  // ── Over-place + partial placements (matrix row 9) ─────────────────────────

  it('over-place: qty above the remaining is a 400 naming the remaining quantity; partial placements drain the remaining', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: batchSkuId, batchCode: 'LOT-PW-OVR', mfgDate: null, qty: 6 }]);
    const line = first.lines[0]!;

    // More than the line applied → 400 naming the remaining 6.
    const rejected = await placeForLine(line, binA02, { qty: 7 }).expect(400);
    expect(rejected.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(rejected.body.detail).toContain('6');

    // Partial placement of 4: the task's remaining drops to 2.
    await placeForLine(line, binA03, { qty: 4 }).expect(201);
    const tasks = await getTasks();
    expect(tasks.find((task) => task.grnLineId === line.id)).toMatchObject({ qty: 2 });

    // 3 more cannot place — only 2 remain.
    const rejectedAgain = await placeForLine(line, binA03, { qty: 3 }).expect(400);
    expect(rejectedAgain.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(rejectedAgain.body.detail).toContain('2');

    // The last 2 land and the task is gone.
    await placeForLine(line, binA03, { qty: 2 }).expect(201);
    const after = await getTasks();
    expect(after.find((task) => task.grnLineId === line.id)).toBeUndefined();
  });

  // ── Concurrent drain: the ledger fold guard quarantines (matrix row 10) ────

  it('concurrent drain: a placement parked behind the warehouse advisory lock while the Receiving bin drains is 422 insufficient-on-hand with nothing persisted', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 8 }]);
    const line = first.lines[0]!;
    const bin = await receivingBinId();
    const key = ulid();

    // Park the placement: hold the per-(tenant, warehouse) advisory lock in a
    // manual session. The command's validation runs unblocked; the
    // appendMovement lock then parks it AFTER validation — the honest
    // replay-after-drain window.
    const manual = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await manual`begin`;
      await manual`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':' || ${warehouseId}, 0))`;
      // A supertest Test only sends when a .then is registered — register it
      // BEFORE the poll so the command is genuinely in flight (the async IIFE
      // awaits it immediately, dispatching the HTTP request).
      const parkedPromise = (async () =>
        placeForLine(line, binA04, { reasonCode: 'consolidation-with-existing-stock' }, key))();
      let parked = false;
      for (let waited = 0; waited < 15_000; waited += 50) {
        if ((await advisoryWaiterCount()) > 0) {
          parked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!parked) {
        throw new Error('the placement never parked on the warehouse advisory lock');
      }

      // The drain: the Receiving bin's stock moves elsewhere (a concurrent
      // relocation) while the queued op is in flight. Committing both
      // releases the lock and lands the drain atomically.
      await manual`update stock_on_hand set quantity = 0
        where tenant_id = ${tenantId} and bin_id = ${bin} and sku_id = ${plainSkuId}`;
      await manual`commit`;

      const quarantined = await parkedPromise;
      expect(quarantined.body).toMatchObject({ status: 422, code: 'insufficient-on-hand' });
      expect(quarantined.body.detail).toContain('currently holds');
    } finally {
      await manual.end();
    }

    // The quarantined op wrote NOTHING: no placement row, no outbox event, no
    // audit entry — and the idempotency key was never consumed (a retry is a
    // fresh command, not a replay).
    expect(await placementRowCount()).toBeLessThan(10); // prior rows only
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const audits = await sql`
        select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${key}`;
      expect(Number((audits[0] as unknown as { n: number }).n)).toBe(0);
    } finally {
      await sql.end();
    }
    expect(await outboxRows('putaway.recorded', first.grnId)).toHaveLength(0);
  });

  // ── Wrong authority (matrix row 11) ────────────────────────────────────────

  it('wrong authority: a bare device credential is 401, a web session is 401, a demoted operator is 403 role-denied, a revoked device is 403 device-revoked, a foreign tenant path is 403', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 4 }]);
    const line = first.lines[0]!;
    const body: PlaceBody = {
      warehouseId,
      grnId: first.grnId,
      grnLineId: line.id,
      skuId: plainSkuId,
      batchId: null,
      qty: 4,
      toBinId: binA03,
      reasonCode: 'other',
      occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    };

    // A bare (pre-badge-in) device credential cannot place — badge-in first.
    await place(body, deviceToken)
      .expect(401)
      .then((res) => expect(res.body).toMatchObject({ code: 'unauthenticated' }));

    // A web session (ownerToken) is not a device session — 401.
    await place(body, ownerToken)
      .expect(401)
      .then((res) => expect(res.body).toMatchObject({ code: 'unauthenticated' }));

    // A demoted-to-accountant operator is denied per command (fail-closed
    // DB role re-read); restoring the role re-opens the surface.
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/users/${operatorUserId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ role: 'accountant' })
      .expect(200);
    await place(body)
      .expect(403)
      .then((res) => expect(res.body).toMatchObject({ code: 'role-denied' }));
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/users/${operatorUserId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ role: 'operator' })
      .expect(200);
    // The restored operator places fine (consumes the line so later tests
    // start from a settled state for this line).
    await place(body).expect(201);

    // A revoked device is 403 device-revoked on its next command.
    const fresh = await enrollDevice('Putaway scanner 2');
    const session = await badgeExistingOperator(fresh.deviceToken, operatorEmails[0]!);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/${fresh.deviceId}/revoke`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(200);
    await place(body, session.accessToken)
      .expect(403)
      .then((res) => expect(res.body).toMatchObject({ code: 'device-revoked' }));

    // A foreign tenant path: 403 permission-denied (both mutation and reads).
    const foreignTenant = uuidv7();
    await request(app.getHttpServer())
      .post(`${API}/${foreignTenant}/putaway/placements`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send(body)
      .expect(403)
      .then((res) => expect(res.body).toMatchObject({ status: 403, code: 'permission-denied' }));
    await request(app.getHttpServer())
      .get(`${API}/${foreignTenant}/putaway/tasks?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`${API}/${foreignTenant}/putaway/placements`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(403);
  });

  async function badgeExistingOperator(
    deviceToken: string,
    email: string,
  ): Promise<{ accessToken: string }> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ operatorEmail: email, pin: '1357' })
      .expect(200);
    return { accessToken: res.body.accessToken as string };
  }

  // ── The serial arm (matrix row 13) ─────────────────────────────────────────

  it('serial-tracked placements: missing/wrong-count/duplicate serials are 400, an unknown serial never creates identity, the happy path writes one event per unit, a located serial is 409', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: serialSkuId, batchCode: null, mfgDate: null, qty: 3 }]);
    const line = first.lines[0]!;
    const bin = await receivingBinId();

    // Serial identity: intake two units into the Receiving bin via an
    // adjustment (a placement moves intaken stock — it creates none).
    await adjust({
      warehouseId, skuId: serialSkuId, binId: bin, quantityDelta: 2,
      reasonCode: 'cycle-count', note: 'serial intake for putaway', serials: ['PW-SN-1', 'PW-SN-2'],
    }).expect(201);

    // No serials on a serial-tracked SKU → 400.
    await placeForLine(line, binA04, {})
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));

    // Count mismatch → 400.
    await placeForLine(line, binA04, { qty: 2, serials: ['PW-SN-1'] })
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));

    // Duplicates → 400.
    await placeForLine(line, binA04, { qty: 2, serials: ['PW-SN-1', 'PW-SN-1'] })
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));

    // An unknown serial is a 400 — a placement never creates serial identity.
    await placeForLine(line, binA04, { qty: 1, serials: ['PW-SN-UNKNOWN'] })
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));

    // The happy path: one event per serial unit (qty +1 into the target).
    const placed = await placeForLine(line, binA04, {
      qty: 2,
      serials: ['PW-SN-1', 'PW-SN-2'],
      reasonCode: 'consolidation-with-existing-stock',
    }).expect(201);
    expect((placed.body.placement as { qty: number }).qty).toBe(2);
    const events = (await ledgerRows(first.grnId)).filter((event) => event.type === 'putaway.placed');
    expect(events).toHaveLength(2);
    expect(events.map((event) => Number(event.quantity_delta))).toEqual([1, 1]);
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    const serialIds: string[] = [];
    try {
      const rows = await sql`
        select id, serial_number from serials
        where tenant_id = ${tenantId} and serial_number in ('PW-SN-1','PW-SN-2')`;
      for (const row of rows as unknown as { id: string; serial_number: string }[]) {
        serialIds.push(row.id);
      }
    } finally {
      await sql.end();
    }
    expect(new Set(events.map((event) => event.serial_ref))).toEqual(new Set(serialIds));
    expect(await plainOnHand(bin, serialSkuId)).toBe(3); // 1 GRN + 2 intake − 2 placed
    expect(await plainOnHand(binA04, serialSkuId)).toBe(2);

    // A serial that already lives somewhere else is 409 serial-elsewhere
    // (PW-SN-3 intakes straight into A-01, never the Receiving bin).
    await adjust({
      warehouseId, skuId: serialSkuId, binId: binA01, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'serial intaken elsewhere', serials: ['PW-SN-3'],
    }).expect(201);
    await placeForLine(line, binA03, { qty: 1, serials: ['PW-SN-3'], reasonCode: 'operator-preference' })
      .expect(409)
      .then((res) => expect(res.body).toMatchObject({ code: 'serial-elsewhere' }));

    // A serial that already lives in the TARGET bin is still a 409 — a
    // placement draws from the Receiving bin, and PW-SN-1 is not there (it
    // lives in A-04), so the relocation guard names it serial-elsewhere with
    // its actual bin.
    const rescan = await placeForLine(line, binA04, { qty: 1, serials: ['PW-SN-1'], reasonCode: 'operator-preference' })
      .expect(409);
    expect(rescan.body).toMatchObject({ code: 'serial-elsewhere' });
    expect(rescan.body.detail as string).toContain(binA04);
  });

  // ── Review arms (controller normalization + batch pairing + guard arms) ────

  it('review arms: an explicit "serials": null body places (the mobile payload), a foreign-line batch is 400, a drawn-out serial is 409 serial-elsewhere, a never-moved serial is 404 serial-unknown', async () => {
    // (a) The mobile op payload always carries `serials: null` — a null that
    // passes `@IsOptional()` must normalize at the controller, or the
    // command's payload hash spreads null and every mobile placement 500s.
    const plainGrn = await blindGrn([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 2 }]);
    const plainLine = plainGrn.lines[0]!;
    const placed = await placeForLine(plainLine, binA04, { serials: null, reasonCode: "operator-preference" }).expect(201);
    expect((placed.body.placement as { qty: number }).qty).toBe(2);

    // (b) A batch from another GRN line of the same SKU is 400 — the batch
    // identity must be the line's, or the placement records against the
    // wrong line's batch.
    const batchGrn = await blindGrn([
      { poLineId: null, skuId: batchSkuId, batchCode: 'LOT-PW-R1', mfgDate: null, qty: 3 },
      { poLineId: null, skuId: batchSkuId, batchCode: 'LOT-PW-R2', mfgDate: null, qty: 3 },
    ]);
    const [lineOne, lineTwo] = batchGrn.lines;
    await placeForLine(lineOne!, binA03, { batchId: lineTwo!.batchId, reasonCode: 'operator-preference' })
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));

    // (c) A serial drawn OUT of the Receiving bin by a −1 adjustment: the
    // placement's relocation guard takes the "already drawn out" arm — 409
    // serial-elsewhere naming the bin the draw left.
    const serialGrn = await blindGrn([{ poLineId: null, skuId: serialSkuId, batchCode: null, mfgDate: null, qty: 2 }]);
    const serialLine = serialGrn.lines[0]!;
    const receiving = await receivingBinId();
    await adjust({
      warehouseId, skuId: serialSkuId, binId: receiving, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'intake for the drawn-out arm', serials: ['PW-SN-D1'],
    }).expect(201);
    await adjust({
      warehouseId, skuId: serialSkuId, binId: receiving, quantityDelta: -1,
      reasonCode: 'cycle-count', note: 'drawn out for the arm', serials: ['PW-SN-D1'],
    }).expect(201);
    const drawnOut = await placeForLine(serialLine, binA04, { qty: 1, serials: ['PW-SN-D1'], reasonCode: 'operator-preference' })
      .expect(409);
    expect(drawnOut.body).toMatchObject({ code: 'serial-elsewhere' });
    expect(drawnOut.body.detail as string).toContain(receiving);

    // (d) A serial that EXISTS but has never moved: resolution succeeds, and
    // the ledger guard answers 404 serial-unknown — nothing to draw it from.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`begin`;
      await sql`set local session_replication_role = replica`;
      // `serials.id`'s uuidv7 default is a Drizzle $defaultFn, not a column
      // default — the raw insert must mint its own id.
      await sql`
        insert into serials (id, tenant_id, sku_id, serial_number)
        values (gen_random_uuid(), ${tenantId}, ${serialSkuId}, 'PW-SN-NEVER')`;
      await sql`commit`;
    } finally {
      await sql.end();
    }
    await placeForLine(serialLine, binA04, { qty: 1, serials: ['PW-SN-NEVER'], reasonCode: 'operator-preference' })
      .expect(404)
      .then((res) => expect(res.body).toMatchObject({ code: 'serial-unknown' }));
  });

  it('the OpenAPI document exposes the putaway contract (drift guard companion)', () => {
    const committed = JSON.parse(
      readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8') as string,
    ) as { paths: Record<string, Record<string, { responses?: Record<string, unknown> }> | undefined> };
    expect(Object.keys(committed.paths)).toEqual(
      expect.arrayContaining([
        '/tenants/{tenantId}/putaway/placements',
        '/tenants/{tenantId}/putaway/tasks',
      ]),
    );
    // The three putaway operations.
    const placements = committed.paths['/tenants/{tenantId}/putaway/placements'];
    expect(placements?.post).toBeDefined();
    expect(placements?.get).toBeDefined();
    expect(committed.paths['/tenants/{tenantId}/putaway/tasks']?.get).toBeDefined();
    // The POST documents 201 (the @HttpCode it actually returns).
    const responses = placements?.post?.responses ?? {};
    expect(responses).toHaveProperty('201');
    expect(responses).not.toHaveProperty('200');
  });

  // ── Validation arms (line pairing) ─────────────────────────────────────────

  it('validation: an unknown GRN line is 404; a wrong GRN/warehouse/SKU pairing or batch arm is 400', async () => {
    const first = await blindGrn([{ poLineId: null, skuId: batchSkuId, batchCode: 'LOT-PW-VAL', mfgDate: null, qty: 3 }]);
    const line = first.lines[0]!;
    const base: PlaceBody = {
      warehouseId,
      grnId: first.grnId,
      grnLineId: line.id,
      skuId: batchSkuId,
      batchId: line.batchId,
      qty: 1,
      toBinId: binA03,
      reasonCode: null,
      occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    };

    // Unknown GRN line → 404.
    await place({ ...base, grnLineId: uuidv7() })
      .expect(404)
      .then((res) => expect(res.body).toMatchObject({ code: 'not-found' }));
    // The line belongs to another GRN → 400.
    const other = await blindGrn([{ poLineId: null, skuId: batchSkuId, batchCode: 'LOT-PW-VAL-2', mfgDate: null, qty: 3 }]);
    await place({ ...base, grnId: other.grnId })
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    // A foreign warehouse → 400 (the GRN was recorded in warehouseId).
    await place({ ...base, warehouseId: uuidv7() })
      .expect(404)
      .then((res) => expect(res.body).toMatchObject({ code: 'not-found' }));
    // The wrong SKU → 400.
    await place({ ...base, skuId: plainSkuId })
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    // Batch-tracked SKU without its batch → 400; a batch on the untracked
    // SKU → 400; a batch of another SKU → 404.
    await place({ ...base, batchId: null })
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    const untracked = await blindGrn([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 2 }]);
    await place({
      ...base,
      grnId: untracked.grnId,
      grnLineId: untracked.lines[0]!.id,
      skuId: plainSkuId,
      batchId: line.batchId,
      qty: 1,
    })
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    await place({ ...base, batchId: uuidv7() })
      .expect(404)
      .then((res) => expect(res.body).toMatchObject({ code: 'not-found' }));
    // Zero qty → 400.
    await place({ ...base, qty: 0 })
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    // The GRN line pairing: a line of another GRN paired with this GRN's id.
    await place({ ...base, grnLineId: other.lines[0]!.id })
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
  });

  // ── The placements-list read ────────────────────────────────────────────────

  it('placements list: newest first, keyset walk, warehouse filter; a crafted cursor and a malformed filter are 400', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/putaway/placements?warehouseId=${warehouseId}&limit=1`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const items = res.body.items as { id: string; placedAt: string; createdAt: string; qty: number }[];
    expect(items).toHaveLength(1);
    expect(res.body.nextCursor).toBeTruthy();

    const pageTwo = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/putaway/placements?warehouseId=${warehouseId}&limit=1&cursor=${encodeURIComponent(res.body.nextCursor as string)}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const pageTwoItems = pageTwo.body.items as { id: string; createdAt: string }[];
    expect(pageTwoItems).toHaveLength(1);
    expect(pageTwoItems[0]!.id).not.toBe(items[0]!.id);
    // Strictly older by the (createdAt, id) keyset — the keyset field is the
    // server commit time; placedAt is the device time (AD-1) and may sit in
    // an earlier second than page two's commit.
    expect(pageTwoItems[0]!.createdAt <= items[0]!.createdAt).toBe(true);

    const bogus = Buffer.from(JSON.stringify({ id: 'not-a-uuid', createdAt: 'nope' })).toString('base64');
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/putaway/placements?cursor=${encodeURIComponent(bogus)}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ status: 400, code: 'invalid-cursor' }));
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/putaway/placements?warehouseId=not-a-uuid`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/putaway/tasks?warehouseId=not-a-uuid`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/putaway/tasks?warehouseId=${uuidv7()}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404)
      .then((res) => expect(res.body).toMatchObject({ code: 'not-found' }));
  });

  // ── RLS + CHECK (deployment parity) ────────────────────────────────────────

  it('RLS: a non-superuser session scoped to one tenant sees no putaway rows of another tenant and cannot write foreign rows', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    const foreignTenantId = uuidv7();
    try {
      await sql`
        insert into putaway_placements (id, tenant_id, warehouse_id, grn_id, grn_line_id, sku_id, qty, from_bin_id, to_bin_id, placed_by, placed_at, device_id)
        values (${uuidv7()}, ${foreignTenantId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 1, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, now(), ${uuidv7()})`;

      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1 });
      try {
        await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
        const foreign = await rls.unsafe(
          `select count(*)::int as n from putaway_placements where tenant_id = '${foreignTenantId}'::uuid`,
        );
        expect(Number((foreign[0] as unknown as { n: number }).n)).toBe(0);
        // Control: scoped to the foreign tenant the row IS visible.
        await rls.unsafe(`select set_config('app.tenant_id', '${foreignTenantId}', false)`);
        const own = await rls.unsafe('select count(*)::int as n from putaway_placements');
        expect(Number((own[0] as unknown as { n: number }).n)).toBe(1);
        // The write side is fail-closed: a foreign-tenant INSERT is rejected.
        await expect(
          rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            await tx`insert into putaway_placements (id, tenant_id, warehouse_id, grn_id, grn_line_id, sku_id, qty, from_bin_id, to_bin_id, placed_by, placed_at, device_id)
              values (${uuidv7()}, ${foreignTenantId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 1, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, now(), ${uuidv7()})`;
          }),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await rls.end();
      }
    } finally {
      await sql.unsafe('set session_replication_role = replica');
      await sql.unsafe(`delete from putaway_placements where tenant_id = '${foreignTenantId}'::uuid`);
      await sql.unsafe('set session_replication_role = DEFAULT');
      await sql.end();
    }
  });

  it('the 0015 CHECK: a non-positive placement qty is DB-rejected', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await expect(sql`
        insert into putaway_placements (id, tenant_id, warehouse_id, grn_id, grn_line_id, sku_id, qty, from_bin_id, to_bin_id, placed_by, placed_at, device_id)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${uuidv7()}, ${uuidv7()}, ${batchSkuId}, 0, ${uuidv7()}, ${uuidv7()}, ${operatorUserId}, now(), ${uuidv7()})
      `).rejects.toThrow(/putaway_placements_qty_check/);
    } finally {
      await sql.end();
    }
  });
});