import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { MovementsFacade, MAX_SCHEDULED_TASKS_PER_TICK } from '../src/modules/movements/transfer.facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// Device intake is exercised through the snapshot read only, but the dev env
// the sibling suites set keeps app boot identical.
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
// No background worker may race these tests — the scheduler's due-bin
// generation is driven by calling the facade directly (the sibling suites'
// convention).
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

// The suite's arms are many and each HTTP hop is real I/O — the sibling
// suites' long-running convention.
jest.setTimeout(120_000);

const PLAIN = 'CC-PLAIN'; // abc_class a
const MID = 'CC-MID'; // abc_class b
const UNCLASSED = 'CC-UNCLASSED'; // blank abc_class → NULL (OQ-1)
const SKU_CODES = [PLAIN, MID, UNCLASSED] as const;

describe('Cycle Counts: stored tasks, frozen epochs, variances without stock writes (e2e, story 5-3)', () => {
  let app: INestApplication;
  let movements: MovementsFacade;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string;
  let operatorEmail = '';
  let deviceOperatorToken: string; // the operator's badge-in (device) session
  let bareDeviceToken: string; // the SAME device's pre-badge-in enrollment credential
  let accountantToken: string;
  let warehouseId: string; // W1 — the count surfaces under test
  let policyWarehouseId: string; // W2 — the policy arms (no stock)
  let schedulerWarehouseId: string; // W3 — the scheduled-generation arms
  let binA: string; // A-01-01 — PLAIN 20 + MID 4
  let binB: string; // A-01-02 — PLAIN 5 (the epoch-conflict arm)
  let binReplay: string; // A-01-03 — PLAIN 2 (the idempotent-replay arm)
  let binSnap: string; // A-01-05 — the snapshot arm's pending task
  let binSched: string; // W3's class-b bin
  let binUnclassed: string; // W3's NULL-abc_class bin (OQ-1 exclusion)
  const skuIds = new Map<string, string>();

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('counts');
    app = await createApp(false);
    await app.init();
    movements = app.get(MovementsFacade);
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    // Tenant + owner.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Count Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // Three warehouses: the count surfaces (W1), the policy arms (W2, no
    // stock), and the scheduler's generation scope (W3).
    const mkWarehouse = async (name: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({
            origin: testAddress(),
            code: `CC-${ulid().slice(10, 16).toUpperCase()}`,
            name,
          })
          .expect(201)
      ).body.id as string;
    warehouseId = await mkWarehouse('Count WH');
    policyWarehouseId = await mkWarehouse('Policy WH');
    schedulerWarehouseId = await mkWarehouse('Scheduler WH');

    const zoneIds = new Map<string, string>();
    const mkBin = async (warehouse: string, code: string): Promise<string> => {
      const zoneCode = code.slice(0, 1);
      let zoneId = zoneIds.get(`${warehouse}|${zoneCode}`);
      if (zoneId === undefined) {
        zoneId = (
          await request(app.getHttpServer())
            .post(`${API}/${tenantId}/warehouses/${warehouse}/zones`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ code: zoneCode, name: `Zone ${zoneCode}` })
            .expect(201)
        ).body.id as string;
        zoneIds.set(`${warehouse}|${zoneCode}`, zoneId);
      }
      return (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouse}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 1000, type: 'shelf', code })
          .expect(201)
      ).body.id as string;
    };
    binA = await mkBin(warehouseId, 'A-01-01');
    binB = await mkBin(warehouseId, 'A-01-02');
    binReplay = await mkBin(warehouseId, 'A-01-03');
    binSnap = await mkBin(warehouseId, 'A-01-05');
    binSched = await mkBin(schedulerWarehouseId, 'A-01-01');
    binUnclassed = await mkBin(schedulerWarehouseId, 'A-01-03');

    // SKUs: plain 'a', plain 'b', and one with a BLANK abc_class (NULL — the
    // OQ-1 exclusion arm; the optional CSV column's blank-cell verb).
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode,abc_class';
    const csv = [
      csvHeader,
      `${PLAIN},Count Plain,pcs,,1800,,false,false,false,,,,a`,
      `${MID},Count Mid,pcs,,1800,,false,false,false,,,,b`,
      `${UNCLASSED},Count Unclassed,pcs,,1800,,false,false,false,,,,`,
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
    for (const item of skus.body.items as { code: string; id: string; abcClass: string | null }[]) {
      if ((SKU_CODES as readonly string[]).includes(item.code)) {
        skuIds.set(item.code, item.id);
        if (item.code === PLAIN) expect(item.abcClass).toBe('a');
        if (item.code === MID) expect(item.abcClass).toBe('b');
        if (item.code === UNCLASSED) expect(item.abcClass).toBeNull();
      }
    }
    expect(skuIds.size).toBe(SKU_CODES.length);
    // The abc vocabulary is pinned at the DB too (the 0045 CHECK) — an
    // out-of-vocabulary class refuses at the row, not just at the DTO.
    await expect(
      sql`update skus set abc_class = 'z' where tenant_id = ${tenantId} and id = ${skuIds.get(PLAIN)!}::uuid`,
    ).rejects.toThrow(/abc_class_check/);

    // Members: the ops manager (counts.manage — plans counts and policies,
    // seeds stock), the operator (counts.execute — the floor verb) and the
    // accountant (neither — the 403 arm).
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
    // (and its countTasks arm) speaks device sessions only.
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'count-suite device', pin: '2468' })
      .expect(201);
    bareDeviceToken = enrolled.body.deviceToken as string;
    deviceOperatorToken = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${bareDeviceToken}`)
        .send({ operatorEmail, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    // Seed stock via the stock.adjustment command (HTTP) — counts never
    // write stock, so the suite seeds through the adjustment vocabulary.
    const seed = async (
      warehouse: string,
      body: Record<string, unknown>,
      token = opsToken,
    ): Promise<void> => {
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: warehouse, ...body })
        .expect(201);
    };
    await seed(warehouseId, {
      skuId: skuIds.get(PLAIN),
      binId: binA,
      quantityDelta: 20,
      reasonCode: 'stock-count',
      note: 'count-suite seed plain',
    });
    await seed(warehouseId, {
      skuId: skuIds.get(MID),
      binId: binA,
      quantityDelta: 4,
      reasonCode: 'stock-count',
      note: 'count-suite seed mid',
    });
    await seed(warehouseId, {
      skuId: skuIds.get(PLAIN),
      binId: binB,
      quantityDelta: 5,
      reasonCode: 'stock-count',
      note: 'count-suite seed plain (conflict arm)',
    });
    await seed(warehouseId, {
      skuId: skuIds.get(PLAIN),
      binId: binReplay,
      quantityDelta: 2,
      reasonCode: 'stock-count',
      note: 'count-suite seed plain (replay arm)',
    });
    await seed(warehouseId, {
      skuId: skuIds.get(UNCLASSED),
      binId: binSnap,
      quantityDelta: 1,
      reasonCode: 'stock-count',
      note: 'count-suite snapshot arm',
    });
    // The scheduler's scope: a class-b bin (due) and a NULL-abc_class bin
    // (never scheduled — OQ-1).
    await seed(schedulerWarehouseId, {
      skuId: skuIds.get(MID),
      binId: binSched,
      quantityDelta: 8,
      reasonCode: 'stock-count',
      note: 'count-suite scheduler seed',
    });
    await seed(schedulerWarehouseId, {
      skuId: skuIds.get(UNCLASSED),
      binId: binUnclassed,
      quantityDelta: 6,
      reasonCode: 'stock-count',
      note: 'count-suite unclassed seed (OQ-1)',
    });

    // A second tenant for the cross-tenant arms.
    const otherEmail = `other-${ulid().toLowerCase()}@example.com`;
    const other = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Other Count Co ${ulid()}`, ownerEmail: otherEmail, password: 'correct-horse-battery' })
      .expect(201);
    createdTenantIds.push(other.body.tenant.id as string);
    otherTenantToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: otherEmail, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
  });

  let otherTenantToken = '';

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
      // Children before parents: count variances → lines → tasks → policies
      // → ledger → projections → spine.
      await cleaner.unsafe('DELETE FROM devices WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM temperature_excursions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM qc_holds WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM transfer_order_lines WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM transfer_orders WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM count_variances WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM count_task_lines WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM count_tasks WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM count_policies WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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

  function createCount(
    body: Record<string, unknown>,
    token = opsToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/movements/counts`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function submitCount(
    taskId: string,
    body: Record<string, unknown>,
    token = deviceOperatorToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/movements/counts/${taskId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function putPolicies(
    warehouse: string,
    body: Record<string, unknown>,
    token = ownerToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .put(`${API}/${tenantId}/movements/warehouses/${warehouse}/count-policies`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  /** The device snapshot read (badge-in session required). */
  function snapshot(): SupertestTest {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`);
  }

  /** The live bin-state epoch; 0 when the bin has never been touched. */
  async function binEpoch(warehouse: string, binId: string): Promise<number> {
    const rows = await sql`
      select epoch from bin_state_epochs
      where tenant_id = ${tenantId} and warehouse_id = ${warehouse} and bin_id = ${binId}::uuid`;
    return rows.length === 0 ? 0 : Number((rows[0] as { epoch: string }).epoch);
  }

  /** The on-hand milli of one (warehouse, sku, bin) scope; null when no row. */
  async function onHandMilli(warehouse: string, skuId: string | undefined, binId: string): Promise<number | null> {
    const rows = await sql`
      select quantity from stock_on_hand
      where tenant_id = ${tenantId} and warehouse_id = ${warehouse}
        and sku_id = ${skuId!}::uuid and bin_id = ${binId}::uuid`;
    return rows.length === 0 ? null : Number((rows[0] as { quantity: string }).quantity);
  }

  /** The tenant's ledger row count (counts must never append to it). */
  async function ledgerCount(): Promise<number> {
    const rows = await sql`
      select count(*)::int as n from ledger_events where tenant_id = ${tenantId}`;
    return (rows[0] as { n: number }).n;
  }

  /** The count.created outbox events of one tenant (payloads only). */
  async function countCreatedPayloads(): Promise<Record<string, unknown>[]> {
    const rows = (await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'count.created'
      order by created_at asc`) as unknown as { payload: Record<string, unknown> }[];
    return rows.map((row) => row.payload);
  }

  // ── the on-demand create (counts.manage) ──────────────────────────────────

  describe('on-demand create', () => {
    it('stores a pending task with frozen per-SKU expectations and the live epoch', async () => {
      const frozenEpoch = await binEpoch(warehouseId, binA);
      const res = await createCount({ warehouseId, binId: binA }).expect(201);
      const task = res.body.countTask as Record<string, unknown>;
      expect(task.status).toBe('pending');
      expect(task.origin).toBe('on_demand');
      expect(task.warehouseId).toBe(warehouseId);
      expect(task.binId).toBe(binA);
      // The epoch is FROZEN at task start — the bin's live row at create time.
      expect(task.binStateEpoch).toBe(frozenEpoch);
      const lines = res.body.lines as { skuId: string; expectedQuantity: number }[];
      expect(lines).toHaveLength(2); // PLAIN 20 + MID 4 hold the bin
      const bySku = new Map(lines.map((line) => [line.skuId, line.expectedQuantity]));
      expect(bySku.get(skuIds.get(PLAIN)!)).toBe(20);
      expect(bySku.get(skuIds.get(MID)!)).toBe(4);
      // One outbox event per created task (the relay's contract).
      const events = await countCreatedPayloads();
      const mine = events.filter((payload) => payload.taskId === task.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ binId: binA, warehouseId, origin: 'on_demand' });
    });

    it('refuses a second open task on the same bin (409 count-task-open)', async () => {
      const res = await createCount({ warehouseId, binId: binA }).expect(409);
      expect(res.body.code).toBe('count-task-open');
    });

    it('404s an unknown bin and an unknown warehouse', async () => {
      const unknownBin = await createCount({ warehouseId, binId: randomUUID() }).expect(404);
      expect(unknownBin.body.code).toBe('not-found');
      const unknownWh = await createCount({ warehouseId: randomUUID(), binId: binA }).expect(404);
      expect(unknownWh.body.code).toBe('not-found');
    });

    it('403s the floor role (no counts.manage) and the cross-tenant session', async () => {
      const floor = await createCount({ warehouseId, binId: binB }, operatorToken).expect(403);
      expect(floor.body.code).toBe('role-denied');
      // The 403 stored nothing — binB stays free for the epoch-conflict arm.
      const pending = await sql`
        select id from count_tasks
        where tenant_id = ${tenantId} and bin_id = ${binB}::uuid and status = 'pending'`;
      expect(pending).toHaveLength(0);
      const foreign = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/movements/counts`)
        .set('Authorization', `Bearer ${otherTenantToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, binId: binB })
        .expect(403);
      expect(foreign.body.code).toBe('permission-denied');
    });

    it('replays byte-identically and refuses a reused key with a different payload', async () => {
      const key = ulid();
      const body = { warehouseId, binId: binReplay };
      const first = await createCount(body, opsToken, key).expect(201);
      const replay = await createCount(body, opsToken, key).expect(201);
      expect(replay.body.countTask.id).toBe(first.body.countTask.id);
      expect(replay.body.lines).toEqual(first.body.lines);
      const drifted = await createCount({ warehouseId, binId: binSnap }, opsToken, key).expect(422);
      expect(drifted.body.code).toBe('idempotency-key-reuse');
    });
  });

  // ── the submit (counts.execute) ───────────────────────────────────────────

  describe('submit', () => {
    let binATaskId = '';
    const plainSku = (): string | undefined => skuIds.get(PLAIN);

    beforeAll(async () => {
      // The on-demand describe's binA task is the first pending on-demand task
      // on that bin — the submit arms below consume it in order.
      const rows = await sql`
        select id from count_tasks
        where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}::uuid
          and bin_id = ${binA}::uuid and status = 'pending' and origin = 'on_demand'
        order by created_at asc limit 1`;
      binATaskId = (rows[0] as { id: string }).id;
    });

    it('400s a line the body never counted (count-incomplete)', async () => {
      const res = await submitCount(binATaskId, {
        lines: [{ skuId: plainSku(), countedQuantity: 20 }],
      }).expect(400);
      expect(res.body.code).toBe('count-incomplete');
      // The task is still pending — a failed submit stored nothing.
      const task = await sql`
        select status from count_tasks where tenant_id = ${tenantId} and id = ${binATaskId}::uuid`;
      expect((task[0] as { status: string }).status).toBe('pending');
    });

    it('completes an all-equal count from the device session with no variances and no stock/ledger writes', async () => {
      const stockBefore = await onHandMilli(warehouseId, plainSku(), binA);
      const midBefore = await onHandMilli(warehouseId, skuIds.get(MID), binA);
      const ledgerBefore = await ledgerCount();
      const key = ulid();
      const body = {
        lines: [
          { skuId: plainSku(), countedQuantity: 20 },
          { skuId: skuIds.get(MID), countedQuantity: 4 },
        ],
      };
      const res = await submitCount(binATaskId, body, deviceOperatorToken, key).expect(200);
      expect(res.body.countTask.status).toBe('completed');
      expect(res.body.countTask.epochConflict).toBe(false);
      expect(res.body.variances).toEqual([]);
      expect(res.body.recountTaskId).toBeNull();
      // Counts NEVER write stock or the ledger — the observation is the
      // product (the frozen intent).
      expect(await onHandMilli(warehouseId, plainSku(), binA)).toBe(stockBefore);
      expect(await onHandMilli(warehouseId, skuIds.get(MID), binA)).toBe(midBefore);
      expect(await ledgerCount()).toBe(ledgerBefore);
      // The replay serves the stored snapshot, byte-identical.
      const replay = await submitCount(binATaskId, body, deviceOperatorToken, key).expect(200);
      expect(replay.body).toEqual(res.body);
      // …and a different payload on the same key is a reuse (422).
      const drifted = await submitCount(
        binATaskId,
        { lines: [{ skuId: plainSku(), countedQuantity: 21 }] },
        deviceOperatorToken,
        key,
      ).expect(422);
      expect(drifted.body.code).toBe('idempotency-key-reuse');
    });

    it('409s a submit on a completed task and 401s a bare (pre-badge-in) device', async () => {
      const wrongState = await submitCount(binATaskId, {
        lines: [{ skuId: plainSku(), countedQuantity: 20 }],
      }).expect(409);
      expect(wrongState.body.code).toBe('count-task-completed');
      const bare = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/movements/counts/${binATaskId}/submit`)
        .set('Authorization', `Bearer ${bareDeviceToken}`)
        .set(KEY_HEADER, ulid())
        .send({ lines: [{ skuId: plainSku(), countedQuantity: 20 }] })
        .expect(401);
      expect(bare.body.code).toBe('unauthenticated');
    });

    it('flags an epoch conflict AND auto-creates a fresh recount task in the same transaction', async () => {
      // Freeze a task on binB (PLAIN 5), then move the bin underneath it —
      // the adjustment is the epoch-bumping movement (OQ-2).
      const frozen = await createCount({ warehouseId, binId: binB }).expect(201);
      const frozenTaskId = frozen.body.countTask.id as string;
      const frozenEpoch = frozen.body.countTask.binStateEpoch as number;
      expect(frozenEpoch).toBe(await binEpoch(warehouseId, binB));
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId: skuIds.get(PLAIN),
          binId: binB,
          quantityDelta: 5,
          reasonCode: 'stock-count',
          note: 'count-suite epoch mover',
        })
        .expect(201);
      const liveEpoch = await binEpoch(warehouseId, binB);
      expect(liveEpoch).not.toBe(frozenEpoch);
      expect(await onHandMilli(warehouseId, plainSku(), binB)).toBe(10_000); // 5 + 5 moved in

      const res = await submitCount(frozenTaskId, {
        lines: [
          { skuId: plainSku(), countedQuantity: 7 },
          { skuId: skuIds.get(MID), countedQuantity: 8 },
        ],
      }, deviceOperatorToken).expect(200);
      // Two variances: PLAIN drifted (5 → 7) against its FROZEN expectation,
      // and MID is a beyond-task line (binB never held it — expected 0).
      // BOTH carry the epoch-conflict flag: the whole bin moved.
      const variances = res.body.variances as {
        skuId: string;
        expectedQuantity: number;
        countedQuantity: number;
        delta: number;
        epochConflict: boolean;
      }[];
      const bySku = new Map(variances.map((v) => [v.skuId, v]));
      expect(bySku.get(plainSku()!)).toEqual({
        skuId: plainSku(),
        expectedQuantity: 5,
        countedQuantity: 7,
        delta: 2,
        epochConflict: true,
      });
      expect(bySku.get(skuIds.get(MID)!)).toEqual({
        skuId: skuIds.get(MID),
        expectedQuantity: 0,
        countedQuantity: 8,
        delta: 8,
        epochConflict: true,
      });
      expect(res.body.countTask.status).toBe('completed');
      expect(res.body.countTask.epochConflict).toBe(true);
      // The recount task: fresh expectations (the CURRENT on-hand), the LIVE
      // epoch, the recount origin, and the scheduler as its author (no human
      // created it — null IS the scheduler).
      const recountId = res.body.recountTaskId as string;
      expect(recountId).toBeTruthy();
      const recountRows = await sql`
        select origin, created_by, bin_state_epoch from count_tasks
        where tenant_id = ${tenantId} and id = ${recountId}::uuid`;
      expect((recountRows[0] as { origin: string }).origin).toBe('recount');
      expect((recountRows[0] as { created_by: string | null }).created_by).toBeNull();
      expect(Number((recountRows[0] as { bin_state_epoch: string }).bin_state_epoch)).toBe(liveEpoch);
      // binB holds ONLY the moved PLAIN stock now — the recount expects that,
      // not the frozen snapshot's lines.
      const recountLines = await sql`
        select l.sku_id, l.expected_quantity_milli from count_task_lines l
        where l.task_id = ${recountId}::uuid order by l.sku_id`;
      expect(recountLines).toHaveLength(1);
      const recountLine = recountLines[0] as { sku_id: string; expected_quantity_milli: string };
      expect(recountLine.sku_id).toBe(plainSku());
      expect(Number(recountLine.expected_quantity_milli)).toBe(10_000);
      // The variance rows persist as OPEN — a human reviews them; nothing
      // reconciled itself.
      const stored = (await sql`
        select status, epoch_conflict from count_variances
        where tenant_id = ${tenantId} and task_id = ${frozenTaskId}::uuid`) as unknown as {
        status: string;
        epoch_conflict: boolean;
      }[];
      expect(stored.length).toBe(2);
      for (const row of stored) {
        expect(row.status).toBe('open');
        expect(row.epoch_conflict).toBe(true);
      }
      // Still no stock writes: the mover's adjustment is the only delta.
      expect(await onHandMilli(warehouseId, plainSku(), binB)).toBe(10_000);
    });

    it('appends a beyond-task SKU: counted > 0 variances, counted = 0 only records', async () => {
      // Fresh task on binA (its previous task completed above).
      const task = await createCount({ warehouseId, binId: binA }, opsToken, ulid()).expect(201);
      const taskId = task.body.countTask.id as string;
      const res = await submitCount(taskId, {
        lines: [
          { skuId: plainSku(), countedQuantity: 20 },
          { skuId: skuIds.get(MID), countedQuantity: 4 },
          { skuId: skuIds.get(UNCLASSED), countedQuantity: 2 },
        ],
      }, deviceOperatorToken).expect(200);
      const variances = res.body.variances as {
        skuId: string;
        expectedQuantity: number;
        countedQuantity: number;
        delta: number;
        epochConflict: boolean;
      }[];
      expect(variances).toHaveLength(1);
      expect(variances[0]).toEqual({
        skuId: skuIds.get(UNCLASSED),
        expectedQuantity: 0,
        countedQuantity: 2,
        delta: 2,
        epochConflict: false,
      });

      // The zero-count arm: the appended line exists (0 is a real count) but
      // a counted 0 against an expected 0 is not a variance.
      const task2 = await createCount({ warehouseId, binId: binA }, opsToken, ulid()).expect(201);
      const res2 = await submitCount(task2.body.countTask.id as string, {
        lines: [
          { skuId: plainSku(), countedQuantity: 20 },
          { skuId: skuIds.get(MID), countedQuantity: 4 },
          { skuId: skuIds.get(UNCLASSED), countedQuantity: 0 },
        ],
      }, deviceOperatorToken).expect(200);
      expect(res2.body.variances).toEqual([]);
      const line = await sql`
        select expected_quantity_milli, counted_quantity_milli from count_task_lines
        where tenant_id = ${tenantId} and task_id = ${task2.body.countTask.id as string}::uuid
          and sku_id = ${skuIds.get(UNCLASSED)!}::uuid`;
      expect(line.length).toBe(1);
      expect(Number((line[0] as { counted_quantity: string }).counted_quantity_milli)).toBe(0);
    });

    it('403s the accountant (no counts.execute) but lets the operator submit', async () => {
      const task = await createCount({ warehouseId, binId: binA }, opsToken, ulid()).expect(201);
      const taskId = task.body.countTask.id as string;
      const denied = await submitCount(taskId, {
        lines: [
          { skuId: plainSku(), countedQuantity: 20 },
          { skuId: skuIds.get(MID), countedQuantity: 4 },
        ],
      }, accountantToken).expect(403);
      expect(denied.body.code).toBe('role-denied');
      await submitCount(taskId, {
        lines: [
          { skuId: plainSku(), countedQuantity: 20 },
          { skuId: skuIds.get(MID), countedQuantity: 4 },
        ],
      }, operatorToken).expect(200);
    });
  });

  // ── the snapshot's countTasks arm ─────────────────────────────────────────

  describe('catalog snapshot arm', () => {
    it('lists the pending task with its FROZEN expectations to the device', async () => {
      // binSnap holds UNCLASSED 1 — a task created here stays pending.
      const created = await createCount({ warehouseId, binId: binSnap }, opsToken, ulid()).expect(201);
      const res = await snapshot().expect(200);
      const cards = (res.body.countTasks ?? []) as {
        taskId: string;
        binId: string;
        binCode: string;
        origin: string;
        binStateEpoch: number | null;
        lines: { skuId: string; skuCode: string; expectedQuantity: number }[];
      }[];
      const card = cards.find((c) => c.taskId === (created.body.countTask.id as string));
      expect(card).toBeDefined();
      expect(card!.origin).toBe('on_demand');
      expect(card!.binId).toBe(binSnap);
      expect(card!.binStateEpoch).toBe(created.body.countTask.binStateEpoch);
      expect(card!.lines).toHaveLength(1);
      expect(card!.lines[0]!.skuCode).toBe(UNCLASSED);
      expect(card!.lines[0]!.expectedQuantity).toBe(1);
    });
  });

  // ── the policies (counts.manage) ──────────────────────────────────────────

  describe('count policies', () => {
    it('upserts the warehouse policy set, sorted by class, and replays', async () => {
      const key = ulid();
      const body = {
        policies: [
          { abcClass: 'b', intervalDays: 14 },
          { abcClass: 'a', intervalDays: 7 },
        ],
      };
      const res = await putPolicies(warehouseId, body, ownerToken, key).expect(200);
      expect(res.body.policies).toEqual([
        { abcClass: 'a', intervalDays: 7 },
        { abcClass: 'b', intervalDays: 14 },
      ]);
      const replay = await putPolicies(warehouseId, body, ownerToken, key).expect(200);
      expect(replay.body).toEqual(res.body);
    });

    it('400s an unknown abc_class and a non-positive interval', async () => {
      const badClass = await putPolicies(warehouseId, {
        policies: [{ abcClass: 'z', intervalDays: 7 }],
      }, ownerToken).expect(400);
      expect(badClass.body.code).toBe('validation-failed');
      const badInterval = await putPolicies(warehouseId, {
        policies: [{ abcClass: 'a', intervalDays: 0 }],
      }, ownerToken).expect(400);
      expect(badInterval.body.code).toBe('validation-failed');
    });

    it('404s an unknown warehouse and 403s the floor role', async () => {
      const unknownWh = await putPolicies(randomUUID(), { policies: [{ abcClass: 'a', intervalDays: 7 }] }, ownerToken).expect(404);
      expect(unknownWh.body.code).toBe('not-found');
      const floor = await putPolicies(warehouseId, { policies: [{ abcClass: 'a', intervalDays: 7 }] }, operatorToken).expect(403);
      expect(floor.body.code).toBe('role-denied');
    });

    it('pins the vocabulary at the database too (the 0045 CHECK)', async () => {
      await expect(
        sql`insert into count_policies (id, tenant_id, warehouse_id, abc_class, interval_days)
            values (${randomUUID()}::uuid, ${tenantId}::uuid, ${warehouseId}::uuid, 'z', 7)`,
      ).rejects.toThrow(/count_policies_abc_class_check/);
    });
  });

  // ── the scheduler (CountSchedulerWorker's driven entry) ───────────────────

  describe('scheduled generation', () => {
    beforeAll(async () => {
      // The scheduler warehouse's policies: class 'b' every 7 days. A class
      // with no policy row there is never scheduled by THIS set.
      await putPolicies(schedulerWarehouseId, { policies: [{ abcClass: 'b', intervalDays: 7 }] }, ownerToken).expect(200);
    });

    it('generates due tasks for stocked class-b bins, skipping NULL-abc_class stock (OQ-1)', async () => {
      const ledgerBefore = await ledgerCount();
      const taskIds = await movements.generateScheduledCountTasks(
        tenantId,
        schedulerWarehouseId,
        MAX_SCHEDULED_TASKS_PER_TICK,
      );
      // binSched holds MID (class b) → due. binUnclassed holds UNCLASSED
      // (NULL abc_class) → EXCLUDED — an unclassified SKU is never scheduled.
      expect(taskIds).toHaveLength(1);
      const rows = await sql`
        select origin, created_by, bin_state_epoch, bin_id, status from count_tasks
        where tenant_id = ${tenantId} and id = ${taskIds[0]!}::uuid`;
      const task = rows[0] as {
        origin: string;
        created_by: string | null;
        bin_state_epoch: string | null;
        bin_id: string;
        status: string;
      };
      expect(task.origin).toBe('scheduled');
      // No human authored a scheduled task — null IS the scheduler.
      expect(task.created_by).toBeNull();
      expect(task.bin_id).toBe(binSched);
      expect(task.status).toBe('pending');
      // The epoch is frozen at generation time (the same capture as on-demand).
      expect(Number(task.bin_state_epoch)).toBe(await binEpoch(schedulerWarehouseId, binSched));
      const lines = await sql`
        select l.sku_id, l.expected_quantity_milli from count_task_lines l
        where l.task_id = ${taskIds[0]!}::uuid`;
      expect(lines).toHaveLength(1);
      expect((lines[0] as { sku_id: string; expected_quantity_milli: string }).expected_quantity_milli).toBe('8000'); // 8 pcs in milli
      // The generation wrote its outbox event — but NEVER stock/ledger.
      const events = await countCreatedPayloads();
      expect(events.filter((payload) => payload.taskId === taskIds[0])).toHaveLength(1);
      expect(await ledgerCount()).toBe(ledgerBefore);
      expect(await onHandMilli(schedulerWarehouseId, skuIds.get(MID), binSched)).toBe(8000);
    });

    it('generates nothing on a re-run while the due bin\'s task is still open', async () => {
      const taskIds = await movements.generateScheduledCountTasks(
        tenantId,
        schedulerWarehouseId,
        MAX_SCHEDULED_TASKS_PER_TICK,
      );
      expect(taskIds).toHaveLength(0); // binSched's task is still pending
    });

    it('caps generation at maxTasks', async () => {
      // Seed a second class-b bin, then cap at 1 — the open binSched task
      // skips it, so the new bin is the only candidate and it generates.
      const zone = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${schedulerWarehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'B', name: 'Zone B' })
        .expect(201);
      const binExtra = (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${schedulerWarehouseId}/zones/${zone.body.id as string}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 1000, type: 'shelf', code: 'B-01-01' })
          .expect(201)
      ).body.id as string;
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId: schedulerWarehouseId,
          skuId: skuIds.get(MID),
          binId: binExtra,
          quantityDelta: 2,
          reasonCode: 'stock-count',
          note: 'count-suite scheduler cap arm',
        })
        .expect(201);
      const taskIds = await movements.generateScheduledCountTasks(tenantId, schedulerWarehouseId, 1);
      expect(taskIds).toHaveLength(1);
      // A maxTasks cap of 0 generates nothing — the remaining candidate waits
      // for a future tick (the shed verb).
      const again = await movements.generateScheduledCountTasks(tenantId, schedulerWarehouseId, 0);
      expect(again).toHaveLength(0);
    });

    it('ignores a warehouse with no policies at all', async () => {
      const taskIds = await movements.generateScheduledCountTasks(
        tenantId,
        policyWarehouseId,
        MAX_SCHEDULED_TASKS_PER_TICK,
      );
      expect(taskIds).toHaveLength(0);
    });
  });
});