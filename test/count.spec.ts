import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { MovementsFacade, MAX_SCHEDULED_TASKS_PER_TICK, MAX_SNAPSHOT_COUNT_TASKS } from '../src/modules/movements/transfer.facade';
import { CountSchedulerWorker, parseCountSchedulerPollMs } from '../src/jobs/jobs.module';
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
      // Story 5-4's tenant-wide threshold policy row.
      await cleaner.unsafe('DELETE FROM count_variance_policies WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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

  /**
   * The live bin-state epoch; null when the bin has never been touched —
   * exactly what the server freezes for a pristine bin (`bin_state_epoch`
   * is `number | null` on the wire; the epoch's first value is 1, so null,
   * not 0, is the "never moved" sentinel the submit's equality compares).
   */
  async function binEpoch(warehouse: string, binId: string): Promise<number | null> {
    const rows = await sql`
      select epoch from bin_state_epochs
      where tenant_id = ${tenantId} and warehouse_id = ${warehouse} and bin_id = ${binId}::uuid`;
    return rows.length === 0 ? null : Number((rows[0] as { epoch: string }).epoch);
  }

  /**
   * A system-owned bin (Receiving/QC-hold/In-Transit shape) in the given
   * warehouse — minted directly (this suite never drives the commands that
   * ensure one), the frozen amendment's subject.
   */
  async function systemBinId(warehouse: string, code: string): Promise<string> {
    const existing = (await sql`
      select id from bins
      where tenant_id = ${tenantId}::uuid and warehouse_id = ${warehouse}::uuid
        and code = ${code} and system_owned`) as unknown as { id: string }[];
    if (existing.length > 0) {
      return existing[0]!.id;
    }
    const zone = (await sql`
      insert into zones (id, tenant_id, warehouse_id, code, name)
      values (${randomUUID()}::uuid, ${tenantId}::uuid, ${warehouse}::uuid, ${`${code}-ZONE`}, ${`Zone ${code}`})
      returning id`) as unknown as { id: string }[];
    const bin = (await sql`
      insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned)
      values (${randomUUID()}::uuid, ${tenantId}::uuid, ${warehouse}::uuid, ${zone[0]!.id}, ${code}, 1000000, 'staging', true)
      returning id`) as unknown as { id: string }[];
    return bin[0]!.id;
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

    it('refuses a system-owned bin with 400 validation-failed — counts target storage bins only (the frozen amendment)', async () => {
      // The Receiving/QC-hold/In-Transit bins are moved by their own
      // commands; counting one would freeze a stock projection a movement is
      // mid-way through writing (the transfer command's source-bin gate,
      // mirrored).
      const sysBin = await systemBinId(warehouseId, 'IN-TRANSIT');
      const res = await createCount({ warehouseId, binId: sysBin }).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(String(res.body.detail)).toContain('system bin');
      // The refusal stored nothing — the system bin has no task.
      const pending = await sql`
        select id from count_tasks
        where tenant_id = ${tenantId}::uuid and bin_id = ${sysBin}::uuid and status = 'pending'`;
      expect(pending).toHaveLength(0);
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
      expect(Number((line[0] as { counted_quantity_milli: string }).counted_quantity_milli)).toBe(0);
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

    it('404s a line naming an unknown (or foreign-tenant) SKU and leaves the task pending', async () => {
      const task = await createCount({ warehouseId, binId: binA }, opsToken, ulid()).expect(201);
      const taskId = task.body.countTask.id as string;
      const unknownSkuId = randomUUID();
      const res = await submitCount(taskId, {
        lines: [
          { skuId: plainSku(), countedQuantity: 20 },
          { skuId: skuIds.get(MID), countedQuantity: 4 },
          { skuId: unknownSkuId, countedQuantity: 1 },
        ],
      }).expect(404);
      expect(res.body.code).toBe('not-found');
      expect(String(res.body.detail)).toContain('SKU');
      // The failed submit stored nothing — the task is still pending and no
      // line exists for the unknown SKU.
      const rows = await sql`
        select status from count_tasks where tenant_id = ${tenantId}::uuid and id = ${taskId}::uuid`;
      expect((rows[0] as { status: string }).status).toBe('pending');
      const unknownLine = await sql`
        select id from count_task_lines where task_id = ${taskId}::uuid and sku_id = ${unknownSkuId}::uuid`;
      expect(unknownLine).toHaveLength(0);
      // Complete the task properly — the next arms need the bin free.
      await submitCount(taskId, {
        lines: [
          { skuId: plainSku(), countedQuantity: 20 },
          { skuId: skuIds.get(MID), countedQuantity: 4 },
        ],
      }).expect(200);
    });

    it('400s two lines naming one SKU (one counted entry per SKU — a client bug, not a state)', async () => {
      const task = await createCount({ warehouseId, binId: binA }, opsToken, ulid()).expect(201);
      const taskId = task.body.countTask.id as string;
      const res = await submitCount(taskId, {
        lines: [
          { skuId: plainSku(), countedQuantity: 12 },
          { skuId: plainSku(), countedQuantity: 8 },
          { skuId: skuIds.get(MID), countedQuantity: 4 },
        ],
      }).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(String(res.body.detail)).toContain('two lines');
      // The task is still pending — the refusal stored nothing.
      const rows = await sql`
        select status from count_tasks where tenant_id = ${tenantId}::uuid and id = ${taskId}::uuid`;
      expect((rows[0] as { status: string }).status).toBe('pending');
      // …and the task stays completable afterwards (the merged entry).
      const done = await submitCount(taskId, {
        lines: [
          { skuId: plainSku(), countedQuantity: 20 },
          { skuId: skuIds.get(MID), countedQuantity: 4 },
        ],
      }).expect(200);
      expect(done.body.countTask.status).toBe('completed');
    });

    it('completes a pristine-bin count: a null epoch frozen, a null live epoch, no conflict', async () => {
      // A bin no movement has ever touched: no epoch row (the freeze is
      // null, NOT 0 — the epoch starts at 1) and no arms (the task has no
      // lines).
      const zone = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'P', name: 'Zone P' })
        .expect(201);
      const pristine = (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.body.id as string}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 1000, type: 'shelf', code: 'P-01-01' })
          .expect(201)
      ).body.id as string;
      expect(await binEpoch(warehouseId, pristine)).toBeNull();

      const created = await createCount({ warehouseId, binId: pristine }).expect(201);
      expect(created.body.countTask.binStateEpoch).toBeNull(); // the null freeze
      expect(created.body.lines).toEqual([]);
      const res = await submitCount(created.body.countTask.id as string, { lines: [] }).expect(200);
      expect(res.body.countTask.status).toBe('completed');
      // null matches null — counting an untouched bin is never a conflict.
      expect(res.body.countTask.epochConflict).toBe(false);
      expect(res.body.variances).toEqual([]);
      expect(res.body.recountTaskId).toBeNull();
    });

    it('flags a pristine-bin epoch conflict: null frozen, the bin moved live, a fresh recount', async () => {
      const zone = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'Q', name: 'Zone Q' })
        .expect(201);
      const pristine = (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.body.id as string}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 1000, type: 'shelf', code: 'Q-01-01' })
          .expect(201)
      ).body.id as string;
      const frozen = await createCount({ warehouseId, binId: pristine }).expect(201);
      const frozenTaskId = frozen.body.countTask.id as string;
      expect(frozen.body.countTask.binStateEpoch).toBeNull();

      // Move stock INTO the bin after the freeze — the first epoch bump is
      // 1, so null ≠ 1: the OQ-2 conflict arm on a pristine bin.
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId: skuIds.get(PLAIN),
          binId: pristine,
          quantityDelta: 3,
          reasonCode: 'stock-count',
          note: 'count-suite pristine-bin epoch mover',
        })
        .expect(201);
      const liveEpoch = await binEpoch(warehouseId, pristine);
      expect(liveEpoch).not.toBeNull();

      const res = await submitCount(frozenTaskId, {
        lines: [{ skuId: skuIds.get(PLAIN), countedQuantity: 3 }],
      }).expect(200);
      expect(res.body.countTask.epochConflict).toBe(true);
      // The moved-in SKU is a beyond-task line (expected 0) — flagged too.
      expect(res.body.variances).toHaveLength(1);
      expect(res.body.variances[0]).toMatchObject({
        skuId: skuIds.get(PLAIN),
        expectedQuantity: 0,
        countedQuantity: 3,
        epochConflict: true,
      });
      // The recount task re-freezes the LIVE epoch — no longer null.
      const recountId = res.body.recountTaskId as string;
      expect(recountId).toBeTruthy();
      const recount = await sql`
        select bin_state_epoch from count_tasks where tenant_id = ${tenantId}::uuid and id = ${recountId}::uuid`;
      expect(Number((recount[0] as { bin_state_epoch: string }).bin_state_epoch)).toBe(liveEpoch);
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

    it('caps the card list at MAX_SNAPSHOT_COUNT_TASKS and WARNS about the truncation (computed-then-dropped is surfaced, not silent)', async () => {
      // Mint MAX+1 extra pending tasks directly (the one-open-per-bin rule is
      // command-level, not a DB constraint) — the over-read row IS the
      // truncation signal the facade must surface.
      const inserted = (await sql`
        insert into count_tasks (id, tenant_id, warehouse_id, bin_id, status, origin)
        select gen_random_uuid(), ${tenantId}::uuid, ${warehouseId}::uuid, ${binSnap}::uuid, 'pending', 'scheduled'
        from generate_series(1, ${MAX_SNAPSHOT_COUNT_TASKS + 1})
        returning id`) as unknown as { id: string }[];
      expect(inserted).toHaveLength(MAX_SNAPSHOT_COUNT_TASKS + 1);
      const insertedIds = inserted.map((row) => row.id);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const res = await snapshot().expect(200);
        // The device contract holds: exactly MAX cards.
        expect((res.body.countTasks ?? []) as unknown[]).toHaveLength(MAX_SNAPSHOT_COUNT_TASKS);
        // …and the computed-then-dropped breach is LOUD, naming the scope.
        const warned = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
        expect(warned).toContain('truncated');
        expect(warned).toContain(tenantId);
        expect(warned).toContain(warehouseId);
      } finally {
        warnSpy.mockRestore();
        await sql`delete from count_tasks where id = any(${insertedIds}::uuid[])`;
      }
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

    it('refuses a reused policy key with a different payload (422 idempotency-key-reuse)', async () => {
      const key = ulid();
      // The upsert is per-class (the set's rows persist beside it), so the
      // first write lands 'a' beside the class-'b' row the earlier arm set.
      const first = await putPolicies(warehouseId, { policies: [{ abcClass: 'a', intervalDays: 7 }] }, ownerToken, key).expect(200);
      expect(first.body.policies).toEqual(
        expect.arrayContaining([{ abcClass: 'a', intervalDays: 7 }]),
      );
      const drifted = await putPolicies(warehouseId, { policies: [{ abcClass: 'a', intervalDays: 30 }] }, ownerToken, key).expect(422);
      expect(drifted.body.code).toBe('idempotency-key-reuse');
      // The replay side stays intact — the same key with the FIRST payload
      // still re-serves its snapshot.
      const replay = await putPolicies(warehouseId, { policies: [{ abcClass: 'a', intervalDays: 7 }] }, ownerToken, key).expect(200);
      expect(replay.body).toEqual(first.body);
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

    it('counts a mixed-classes bin under the SHORTEST effective interval (a bin is counted once — the tightest policy governs)', async () => {
      // A bin holding BOTH a class-a and a class-b SKU; policies a:30, b:7 —
      // the bin's effective interval is min(30, 7) = 7.
      await putPolicies(schedulerWarehouseId, {
        policies: [
          { abcClass: 'b', intervalDays: 7 },
          { abcClass: 'a', intervalDays: 30 },
        ],
      }, ownerToken).expect(200);
      const zone = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${schedulerWarehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'M', name: 'Zone M' })
        .expect(201);
      const binMixed = (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${schedulerWarehouseId}/zones/${zone.body.id as string}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 1000, type: 'shelf', code: 'M-01-01' })
          .expect(201)
      ).body.id as string;
      for (const [sku, qty] of [[PLAIN, 3], [MID, 5]] as const) {
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/inventory/adjustments`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({
            warehouseId: schedulerWarehouseId,
            skuId: skuIds.get(sku),
            binId: binMixed,
            quantityDelta: qty,
            reasonCode: 'stock-count',
            note: 'count-suite mixed-classes seed',
          })
          .expect(201);
      }

      // Never counted → due immediately, alongside nothing else (the other
      // storage bins hold open tasks).
      const first = await movements.generateScheduledCountTasks(tenantId, schedulerWarehouseId, MAX_SCHEDULED_TASKS_PER_TICK);
      expect(first).toHaveLength(1);
      const mixedTask = (await sql`
        select bin_id from count_tasks where tenant_id = ${tenantId}::uuid and id = ${first[0]!}::uuid`) as unknown as { bin_id: string }[];
      expect(mixedTask[0]!.bin_id).toBe(binMixed);
      // The task lines carry BOTH classes' SKUs — the bin is counted once.
      const lines = (await sql`
        select sku_id, expected_quantity_milli from count_task_lines where task_id = ${first[0]!}::uuid order by sku_id`) as unknown as { sku_id: string; expected_quantity_milli: string }[];
      expect(lines).toHaveLength(2);

      const completeExact = async (taskId: string): Promise<void> => {
        await submitCount(taskId, {
          lines: [
            { skuId: skuIds.get(PLAIN), countedQuantity: 3 },
            { skuId: skuIds.get(MID), countedQuantity: 5 },
          ],
        }, operatorToken).expect(200);
      };
      await completeExact(first[0]!);

      // Age the completed count to 10 days: inside a (wrongly) LONGEST-interval
      // reading (30d) but past the SHORTEST (7d). The bin must come due —
      // min wins.
      await sql`update count_tasks set completed_at = now() - interval '10 days' where id = ${first[0]!}::uuid`;
      const second = await movements.generateScheduledCountTasks(tenantId, schedulerWarehouseId, MAX_SCHEDULED_TASKS_PER_TICK);
      expect(second).toHaveLength(1);
      const reCount = (await sql`
        select bin_id from count_tasks where tenant_id = ${tenantId}::uuid and id = ${second[0]!}::uuid`) as unknown as { bin_id: string }[];
      expect(reCount[0]!.bin_id).toBe(binMixed);
      await completeExact(second[0]!);

      // …and a count 3 days old sits INSIDE the 7-day effective interval —
      // the bin is not due again (the interval is real, not vacuous).
      await sql`update count_tasks set completed_at = now() - interval '3 days' where id = ${second[0]!}::uuid`;
      const third = await movements.generateScheduledCountTasks(tenantId, schedulerWarehouseId, MAX_SCHEDULED_TASKS_PER_TICK);
      expect(third).toHaveLength(0);
    });

    it('never schedules a system-owned bin, even one holding classed stock (the frozen amendment)', async () => {
      // A system In-Transit bin in the scheduler warehouse, holding class-b
      // stock written directly — exactly the projection state a movement
      // command is mid-way through writing when a tick fires. The candidate
      // scan (stock-driven) shortlists it; the system-owned filter must
      // drop it.
      const sysBin = await systemBinId(schedulerWarehouseId, 'IN-TRANSIT');
      await sql`
        insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
        values (${randomUUID()}::uuid, ${tenantId}::uuid, ${schedulerWarehouseId}::uuid, ${skuIds.get(MID)!}::uuid, ${sysBin}::uuid, 4000)`;
      // Every storage bin is open (binSched, binExtra) or within its interval
      // (the mixed bin above) — the system bin is this tick's only due
      // candidate, and it must mint NOTHING.
      const taskIds = await movements.generateScheduledCountTasks(tenantId, schedulerWarehouseId, MAX_SCHEDULED_TASKS_PER_TICK);
      expect(taskIds).toHaveLength(0);
      const sysTasks = await sql`
        select id from count_tasks where tenant_id = ${tenantId}::uuid and bin_id = ${sysBin}::uuid`;
      expect(sysTasks).toHaveLength(0);
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

  // ── variance resolution and threshold routing (story 5-4) ─────────────────

  describe('variance resolution and threshold routing (story 5-4)', () => {
    let vbin1: string; // PLAIN 10 — the no-policy variance (approve-adjust happy arm)
    let vbin2: string; // PLAIN 4 — the over-threshold arm
    let vbin3: string; // PLAIN 5 — the stale-seqs and basis-moved (recount) arms
    let vbin4: string; // PLAIN 2 — the open-task-per-bin bound
    let vzoneId = ''; // Zone V — the bins' parent (the retire arm's bin mint)
    let ownerUserId = '';
    // The suite's five terminal variances, minted in the arms below in order.
    let v1 = '';
    let v2 = '';
    let v3 = '';
    let vBin3bId = ''; // the basis-moved variance (resolved by recount)
    let v4 = '';

    const vseed = async (binId: string, quantityDelta: number): Promise<void> => {
      // All four bins live in W1 (the count surfaces' warehouse).
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId: skuIds.get(PLAIN),
          binId,
          quantityDelta,
          reasonCode: 'stock-count',
          note: 'count-suite 5-4 seed',
        })
        .expect(201);
    };

    function putVariancePolicy(
      body: Record<string, unknown>,
      token = ownerToken,
      key = ulid(),
    ): SupertestTest {
      return request(app.getHttpServer())
        .put(`${API}/${tenantId}/movements/variance-policies`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send(body);
    }

    function getVariancePolicy(token = ownerToken): SupertestTest {
      return request(app.getHttpServer())
        .get(`${API}/${tenantId}/movements/variance-policies`)
        .set('Authorization', `Bearer ${token}`);
    }

    function resolveVariance(
      varianceId: string,
      body: Record<string, unknown>,
      token = ownerToken,
      key = ulid(),
    ): SupertestTest {
      return request(app.getHttpServer())
        .post(`${API}/${tenantId}/movements/variances/${varianceId}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send(body);
    }

    function listVariances(query = '', token = ownerToken): SupertestTest {
      return request(app.getHttpServer())
        .get(`${API}/${tenantId}/movements/variances${query}`)
        .set('Authorization', `Bearer ${token}`);
    }

    async function varianceRow(varianceId: string): Promise<{
      status: string;
      threshold_quantity_milli: string | null;
      considered_event_seqs: number[] | null;
      recount_task_id: string | null;
      resolved_at: string | null;
    }> {
      const rows = await sql`
        select status, threshold_quantity_milli, considered_event_seqs, recount_task_id, resolved_at
        from count_variances where tenant_id = ${tenantId} and id = ${varianceId}::uuid`;
      expect(rows).toHaveLength(1);
      return rows[0] as unknown as {
        status: string;
        threshold_quantity_milli: string | null;
        considered_event_seqs: number[] | null;
        recount_task_id: string | null;
        resolved_at: string | null;
      };
    }

    /** The open variance (expected ≠ counted) a submit minted on a bin+SKU. */
    async function varianceIdOf(taskId: string, skuId: string): Promise<string> {
      const rows = await sql`
        select id from count_variances
        where tenant_id = ${tenantId}::uuid and task_id = ${taskId}::uuid and sku_id = ${skuId}::uuid`;
      expect(rows).toHaveLength(1);
      return (rows[0] as { id: string }).id;
    }

    async function outboxPayloads(type: string): Promise<Record<string, unknown>[]> {
      const rows = await sql`
        select payload from outbox_messages
        where tenant_id = ${tenantId} and type = ${type} order by created_at asc`;
      return rows.map((row) => (row as { payload: Record<string, unknown> }).payload);
    }

    /** The warehouse ledger's seqs (the resolution's consulted-statement source). */
    async function warehouseSeqs(warehouse: string): Promise<number[]> {
      const rows = await sql`
        select seq from ledger_events
        where tenant_id = ${tenantId}::uuid and warehouse_id = ${warehouse}::uuid order by seq asc`;
      return rows.map((row) => Number((row as { seq: number }).seq));
    }

    beforeAll(async () => {
      // Zone V in W1 with four storage bins, each seeded through the
      // adjustment vocabulary (counts never write stock).
      const zone = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'V', name: 'Zone V (5-4)' })
        .expect(201);
      const zoneId = zone.body.id as string;
      vzoneId = zoneId;
      const mkBin = async (code: string): Promise<string> =>
        (
          await request(app.getHttpServer())
            .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ capacity: 1000, type: 'shelf', code })
            .expect(201)
        ).body.id as string;
      vbin1 = await mkBin('V-01-01');
      vbin2 = await mkBin('V-01-02');
      vbin3 = await mkBin('V-01-03');
      vbin4 = await mkBin('V-01-04');
      await vseed(vbin1, 10);
      await vseed(vbin2, 4);
      await vseed(vbin3, 5);
      await vseed(vbin4, 2);
      // The owner's userId — the resolution's resolvedBy stamp.
      const owners = await sql`
        select id from users where tenant_id = ${tenantId}::uuid and role = 'owner'`;
      ownerUserId = (owners[0] as { id: string }).id;
    });

    it('404s the policy read before any policy write (unset = no routing)', async () => {
      const res = await getVariancePolicy().expect(404);
      expect(res.body.code).toBe('not-found');
    });

    it('routes nothing without a policy: the variance carries no threshold stamp and no owner event', async () => {
      const task = await createCount({ warehouseId, binId: vbin1 }).expect(201);
      const taskId = task.body.countTask.id as string;
      const res = await submitCount(taskId, {
        lines: [{ skuId: skuIds.get(PLAIN), countedQuantity: 13 }],
      }, deviceOperatorToken).expect(200);
      expect(res.body.variances).toHaveLength(1);
      const varianceId = await varianceIdOf(taskId, skuIds.get(PLAIN)!);
      v1 = varianceId;
      const row = await varianceRow(varianceId);
      expect(row.status).toBe('open');
      expect(row.threshold_quantity_milli).toBeNull();
      expect(row.considered_event_seqs).toBeNull();
      // Routing disabled: NOT ONE owner notification in the outbox.
      expect(await outboxPayloads('count.variance.threshold_exceeded')).toHaveLength(0);
    });

    it('upserts the threshold, replays and 422s a drifted body (the policy write)', async () => {
      const key = ulid();
      const res = await putVariancePolicy({ quantityThreshold: 5 }, ownerToken, key).expect(200);
      expect(res.body.quantityThreshold).toBe(5);
      expect(res.body.tenantId).toBe(tenantId);
      const read = await getVariancePolicy().expect(200);
      expect(read.body.quantityThreshold).toBe(5);
      const replay = await putVariancePolicy({ quantityThreshold: 5 }, ownerToken, key).expect(200);
      expect(replay.body).toEqual(res.body);
      const drifted = await putVariancePolicy({ quantityThreshold: 6 }, ownerToken, key).expect(422);
      expect(drifted.body.code).toBe('idempotency-key-reuse');
    });

    it('freezes the threshold on the submit: an over-threshold variance stamps 5 and notifies the owner', async () => {
      const task = await createCount({ warehouseId, binId: vbin2 }).expect(201);
      const taskId = task.body.countTask.id as string;
      // counted 11 against an expected 4 — a delta of +7, over the 5 ceiling.
      await submitCount(taskId, {
        lines: [{ skuId: skuIds.get(PLAIN), countedQuantity: 11 }],
      }, deviceOperatorToken).expect(200);
      v2 = await varianceIdOf(taskId, skuIds.get(PLAIN)!);
      const row = await varianceRow(v2);
      expect(row.threshold_quantity_milli).toBe(5000);
      // The owner-notification event rides the SAME transaction as the rows.
      const events = await outboxPayloads('count.variance.threshold_exceeded');
      const forV2 = events.filter((payload) => payload.varianceId === v2);
      expect(forV2).toHaveLength(1);
      expect(forV2[0]).toMatchObject({
        varianceId: v2,
        taskId,
        warehouseId,
        binId: vbin2,
        skuId: skuIds.get(PLAIN),
        delta: 7,
        thresholdQuantity: 5,
        notifyRole: 'owner',
      });
      // The variance never wrote stock.
      expect(await onHandMilli(warehouseId, skuIds.get(PLAIN), vbin2)).toBe(4000);
    });

    it('refuses an over-threshold resolution to the ops manager (403 variance-owner-required)', async () => {
      const seqs = await warehouseSeqs(warehouseId);
      const res = await resolveVariance(v2, {
        decision: 'approve_adjust',
        consideredEventSeqs: seqs.slice(0, 2),
      }, opsToken).expect(403);
      expect(res.body.code).toBe('variance-owner-required');
      // Refused BEFORE any write: still open, on-hand untouched.
      expect((await varianceRow(v2)).status).toBe('open');
      expect(await onHandMilli(warehouseId, skuIds.get(PLAIN), vbin2)).toBe(4000);
    });

    it('the owner resolves by approve_adjust: the correction lands and the resolution echoes (audit + outbox + replay)', async () => {
      const seqs = await warehouseSeqs(warehouseId);
      const consulted = seqs.slice(0, 2);
      const ledgerBefore = await ledgerCount();
      const key = ulid();
      const res = await resolveVariance(v2, {
        decision: 'approve_adjust',
        consideredEventSeqs: consulted,
      }, ownerToken, key).expect(200);
      expect(res.body.variance.status).toBe('adjusted');
      expect(res.body.variance.thresholdQuantity).toBe(5);
      expect(res.body.variance.resolvedBy).toBe(ownerUserId);
      expect(res.body.variance.resolvedAt).toBeTruthy();
      expect(res.body.variance.consideredEventSeqs).toEqual(consulted);
      expect(res.body.variance.recountTaskId).toBeNull();
      // The correction: one stock.adjusted event, on-hand 4 + 7 = 11.
      expect(res.body.stockCorrection).toMatchObject({
        eventId: expect.any(String) as unknown,
        onHand: { skuId: skuIds.get(PLAIN), binId: vbin2, quantity: 11 },
      });
      expect(typeof (res.body.stockCorrection as { seq: unknown }).seq).toBe('number');
      expect(await onHandMilli(warehouseId, skuIds.get(PLAIN), vbin2)).toBe(11000);
      expect(await ledgerCount()).toBe(ledgerBefore + 1);
      const added = (await sql`
        select type, quantity_delta, to_bin_id, actor_user_id from ledger_events
        where tenant_id = ${tenantId}::uuid and warehouse_id = ${warehouseId}::uuid
        order by seq desc limit 1`) as unknown as {
        type: string;
        quantity_delta: number;
        to_bin_id: string;
        actor_user_id: string;
      }[];
      expect(added[0]!.type).toBe('stock.adjusted');
      expect(Number(added[0]!.quantity_delta)).toBe(7000);
      expect(added[0]!.to_bin_id).toBe(vbin2);
      expect(added[0]!.actor_user_id).toBe(ownerUserId);
      // The outbox echo: the consulted seqs and the frozen threshold.
      const resolvedEvents = await outboxPayloads('count.variance.resolved');
      const forV2 = resolvedEvents.filter((payload) => payload.varianceId === v2);
      expect(forV2).toHaveLength(1);
      expect(forV2[0]).toMatchObject({
        varianceId: v2,
        decision: 'approve_adjust',
        status: 'adjusted',
        expectedQuantity: 4,
        countedQuantity: 11,
        delta: 7,
        thresholdQuantity: 5,
        consideredEventSeqs: consulted,
        resolvedBy: ownerUserId,
        recountTaskId: null,
      });
      // The audit row carries the idempotency key as its reference.
      const audits = (await sql`
        select reference from audit_events
        where tenant_id = ${tenantId}::uuid and action = 'count.variance.resolved'
          and target_id = ${v2}::uuid`) as unknown as { reference: string }[];
      expect(audits).toHaveLength(1);
      expect(audits[0]!.reference).toBe(key);
      // The replay serves the stored snapshot, byte-identical; a drifted
      // body on the same key is the 422.
      const replay = await resolveVariance(v2, {
        decision: 'approve_adjust',
        consideredEventSeqs: consulted,
      }, ownerToken, key).expect(200);
      expect(replay.body).toEqual(res.body);
      await resolveVariance(v2, { decision: 'recount' }, ownerToken, key).expect(422);
      // …and a second, different key answers 409 (the terminal state).
      const done = await resolveVariance(v2, { decision: 'recount' }, ownerToken, ulid()).expect(409);
      expect(done.body.code).toBe('variance-resolved');
    });

    it('refuses an approve_adjust with no consulted statement at all (the silent write-off guard)', async () => {
      const res = await resolveVariance(v1, { decision: 'approve_adjust' }, ownerToken, ulid()).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect((await varianceRow(v1)).status).toBe('open');
    });

    it('resolves an under-threshold variance to the owner too: the correction lands (a stampless row is never owner-locked)', async () => {
      const seqs = await warehouseSeqs(warehouseId);
      const ledgerBefore = await ledgerCount();
      const res = await resolveVariance(v1, {
        decision: 'approve_adjust',
        consideredEventSeqs: seqs.slice(0, 1),
      }, ownerToken).expect(200);
      expect(res.body.variance.status).toBe('adjusted');
      expect(res.body.variance.thresholdQuantity).toBeNull(); // unstamped
      expect(res.body.stockCorrection).toMatchObject({
        onHand: { binId: vbin1, quantity: 13 },
      });
      expect(await onHandMilli(warehouseId, skuIds.get(PLAIN), vbin1)).toBe(13000);
      expect(await ledgerCount()).toBe(ledgerBefore + 1);
      // The routing emits NOTHING for it — the only threshold event ever
      // minted in this describe is the over-threshold v2's.
      const underThresholdEvents = await outboxPayloads('count.variance.threshold_exceeded');
      expect(underThresholdEvents).toHaveLength(1); // v2's, from the freeze arm
      expect(underThresholdEvents[0]!.varianceId).toBe(v2);
    });

    it('refuses stale consulted seqs BEFORE any write (400, the variance stays open)', async () => {
      const task = await createCount({ warehouseId, binId: vbin3 }).expect(201);
      const taskId = task.body.countTask.id as string;
      await submitCount(taskId, {
        lines: [{ skuId: skuIds.get(PLAIN), countedQuantity: 7 }],
      }, deviceOperatorToken).expect(200);
      v3 = await varianceIdOf(taskId, skuIds.get(PLAIN)!);
      const res = await resolveVariance(v3, {
        decision: 'recount',
        consideredEventSeqs: [10_000],
      }, ownerToken, ulid()).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(String(res.body.detail)).toContain('10000'); // the missing seq echoed
      expect((await varianceRow(v3)).status).toBe('open');
      // Nothing minted — no recount task exists for the bin yet.
      const tasks = await sql`
        select id from count_tasks where tenant_id = ${tenantId}::uuid and bin_id = ${vbin3}::uuid and origin = 'recount'`;
      expect(tasks).toHaveLength(0);
    });

    it('the recount arm: a fresh task becomes the expected basis and the delta recomputes in the SAME write', async () => {
      const res = await resolveVariance(v3, { decision: 'recount' }, ownerToken, ulid()).expect(200);
      expect(res.body.variance.status).toBe('recounted');
      expect(res.body.variance.recountTaskId).toBeTruthy();
      expect(res.body.stockCorrection).toBeNull();
      expect(res.body.variance.consideredEventSeqs).toBeNull();
      expect(res.body.variance.expectedQuantity).toBe(5); // the recount snapshot
      expect(res.body.variance.delta).toBe(2); // counted 7 − recounted 5
      const row = await varianceRow(v3);
      expect(row.status).toBe('recounted');
      expect(row.resolved_at).toBeTruthy();
      expect(row.considered_event_seqs).toBeNull();
      // The minted task: the recount origin, the scheduler-as-author null,
      // the LIVE epoch, and the current on-hand as its frozen expectation.
      const recountId = res.body.variance.recountTaskId as string;
      const tasks = (await sql`
        select origin, created_by, bin_state_epoch, status from count_tasks
        where tenant_id = ${tenantId}::uuid and id = ${recountId}::uuid`) as unknown as {
        origin: string;
        created_by: string | null;
        bin_state_epoch: string;
        status: string;
      }[];
      expect(tasks[0]!.origin).toBe('recount');
      expect(tasks[0]!.created_by).toBeNull();
      expect(Number(tasks[0]!.bin_state_epoch)).toBe(await binEpoch(warehouseId, vbin3));
      expect(tasks[0]!.status).toBe('pending');
      const lines = (await sql`
        select sku_id, expected_quantity_milli from count_task_lines where task_id = ${recountId}::uuid`) as unknown as {
        sku_id: string;
        expected_quantity_milli: string;
      }[];
      expect(lines).toHaveLength(1);
      expect(lines[0]!.sku_id).toBe(skuIds.get(PLAIN));
      expect(Number(lines[0]!.expected_quantity_milli)).toBe(5000);
      const forV3 = (await outboxPayloads('count.variance.resolved')).filter((p) => p.varianceId === v3);
      expect(forV3).toHaveLength(1);
      expect(forV3[0]).toMatchObject({ decision: 'recount', status: 'recounted', recountTaskId: recountId });
      // Settle the recount task so later arms can use the bin.
      await submitCount(recountId, {
        lines: [{ skuId: skuIds.get(PLAIN), countedQuantity: 5 }],
      }, deviceOperatorToken).expect(200);
    });

    it('the approve arm refuses a moved basis (409 variance-basis-moved); the recount is the remedy', async () => {
      // The frozen epoch E; then submit makes a variance; then a movement
      // bumps the epoch underneath it — approve_adjust must refuse.
      const task = await createCount({ warehouseId, binId: vbin3 }).expect(201);
      const taskId = task.body.countTask.id as string;
      const frozenEpoch = task.body.countTask.binStateEpoch as number;
      await submitCount(taskId, {
        lines: [{ skuId: skuIds.get(PLAIN), countedQuantity: 12 }],
      }, deviceOperatorToken).expect(200);
      const varianceId = await varianceIdOf(taskId, skuIds.get(PLAIN)!);
      vBin3bId = varianceId;
      expect((await varianceRow(varianceId)).threshold_quantity_milli).toBe(5000); // delta 7 is over-threshold → owner-only
      // The move: +2 pcs (an epoch-bumping write AFTER the freeze).
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId: skuIds.get(PLAIN),
          binId: vbin3,
          quantityDelta: 2,
          reasonCode: 'stock-count',
          note: 'count-suite 5-4 basis mover',
        })
        .expect(201);
      expect(await binEpoch(warehouseId, vbin3)).toBeGreaterThan(frozenEpoch);
      const seqs = await warehouseSeqs(warehouseId);
      const refused = await resolveVariance(varianceId, {
        decision: 'approve_adjust',
        consideredEventSeqs: seqs.slice(0, 2),
      }, ownerToken, ulid()).expect(409);
      expect(refused.body.code).toBe('variance-basis-moved');
      expect((await varianceRow(varianceId)).status).toBe('open');
      // The refusal wrote nothing but the mover's own adjustment.
      expect(await onHandMilli(warehouseId, skuIds.get(PLAIN), vbin3)).toBe(7000);
      // The remedy: recount — the new basis is the post-move on-hand (7),
      // the delta recomputes to 12 − 7 = 5.
      const remedy = await resolveVariance(varianceId, { decision: 'recount' }, ownerToken, ulid()).expect(200);
      expect(remedy.body.variance.status).toBe('recounted');
      expect(remedy.body.variance.expectedQuantity).toBe(7);
      expect(remedy.body.variance.delta).toBe(5);
      const recountId = remedy.body.variance.recountTaskId as string;
      const lines = (await sql`
        select expected_quantity_milli from count_task_lines where task_id = ${recountId}::uuid`) as unknown as { expected_quantity_milli: string }[];
      expect(Number(lines[0]!.expected_quantity_milli)).toBe(7000);
      await submitCount(recountId, {
        lines: [{ skuId: skuIds.get(PLAIN), countedQuantity: 7 }],
      }, deviceOperatorToken).expect(200);
    });

    it('the recount arm refuses while another task on the bin is still open (one open task per bin)', async () => {
      const task = await createCount({ warehouseId, binId: vbin4 }).expect(201);
      const taskId = task.body.countTask.id as string;
      await submitCount(taskId, {
        lines: [{ skuId: skuIds.get(PLAIN), countedQuantity: 4 }],
      }, deviceOperatorToken).expect(200);
      const varianceId = await varianceIdOf(taskId, skuIds.get(PLAIN)!);
      v4 = varianceId;
      // A SECOND task on the same bin — the resolution's recount arm must
      // refuse until it settles.
      const other = await createCount({ warehouseId, binId: vbin4 }).expect(201);
      const blocked = await resolveVariance(varianceId, { decision: 'recount' }, ownerToken, ulid()).expect(409);
      expect(blocked.body.code).toBe('count-task-open');
      expect((await varianceRow(varianceId)).status).toBe('open');
      await submitCount(other.body.countTask.id as string, {
        lines: [{ skuId: skuIds.get(PLAIN), countedQuantity: 2 }],
      }, deviceOperatorToken).expect(200);
      const res = await resolveVariance(varianceId, { decision: 'recount' }, ownerToken, ulid()).expect(200);
      expect(res.body.variance.status).toBe('recounted');
      expect(res.body.variance.expectedQuantity).toBe(2);
      expect(res.body.variance.delta).toBe(2);
    });

    it('the queue read: keyset pages, status filters, and the echoed fields', async () => {
      const ours = new Set([v1, v2, v3, vBin3bId, v4]);
      // All five variances are terminal — the fresh (open) filter may still
      // carry the 5-3 arms' open variances, but none of these five.
      const open = await listVariances('?status=open').expect(200);
      const openItems = open.body.items as { id: string }[];
      expect(openItems.some((entry) => ours.has(entry.id))).toBe(false);
      expect(openItems.length).toBeGreaterThanOrEqual(4); // the 5-3 arms' open variances stay open
      const adjusted = await listVariances('?status=adjusted').expect(200);
      const adjustedItems = adjusted.body.items as {
        id: string;
        status: string;
        thresholdQuantity: number | null;
        consideredEventSeqs: number[] | null;
        resolvedAt: string | null;
        resolvedBy: string | null;
        recountTaskId: string | null;
        createdAt: string;
      }[];
      expect(adjustedItems).toHaveLength(2);
      expect(adjustedItems.map((entry) => entry.id).sort()).toEqual([v1, v2].sort());
      const v1Entry = adjustedItems.find((entry) => entry.id === v1)!;
      expect(v1Entry.thresholdQuantity).toBeNull();
      expect(v1Entry.consideredEventSeqs!.length).toBe(1); // exactly what was stated
      expect(v1Entry.resolvedAt).toBeTruthy();
      expect(v1Entry.resolvedBy).toBe(ownerUserId);
      expect(v1Entry.recountTaskId).toBeNull();
      const v2Entry = adjustedItems.find((entry) => entry.id === v2)!;
      expect(v2Entry.thresholdQuantity).toBe(5);
      expect(v2Entry.consideredEventSeqs!.length).toBe(2);
      const recounted = await listVariances('?status=recounted').expect(200);
      const recountedItems = recounted.body.items as { id: string; recountTaskId: string | null }[];
      expect(recountedItems.map((entry) => entry.id).sort()).toEqual([v3, vBin3bId, v4].sort());
      for (const entry of recountedItems) {
        expect(entry.recountTaskId).toBeTruthy();
      }
      // The keyset page: limit 2 with the cursor walks the whole set
      // newest-first with no repeats, and carries all five of ours.
      const page1 = await listVariances('?limit=2').expect(200);
      const page1Items = page1.body.items as { id: string }[];
      expect(page1Items).toHaveLength(2);
      const seenIds = [...page1Items].map((entry) => entry.id);
      let cursor: string | null = page1.body.nextCursor ?? null;
      let walks = 1;
      while (cursor !== null) {
        const next = await listVariances(`?limit=2&cursor=${encodeURIComponent(cursor)}`).expect(200);
        const more = next.body.items as { id: string }[];
        expect(more.length).toBeLessThanOrEqual(2);
        expect(more.some((entry) => seenIds.includes(entry.id))).toBe(false); // no repeats
        seenIds.push(...more.map((entry) => entry.id));
        cursor = next.body.nextCursor ?? null;
        walks += 1;
        expect(walks).toBeLessThan(20); // the walk terminates
      }
      expect(walks).toBeGreaterThanOrEqual(3); // our five alone span pages
      for (const id of ours) {
        expect(seenIds).toContain(id);
      }
    });

    it('fences the roles: the floor cannot resolve or write the policy, foreign callers stay out', async () => {
      // One more open variance for the 403 arms.
      const task = await createCount({ warehouseId, binId: vbin1 }).expect(201);
      const taskId = task.body.countTask.id as string;
      await submitCount(taskId, {
        lines: [{ skuId: skuIds.get(PLAIN), countedQuantity: 15 }],
      }, deviceOperatorToken).expect(200);
      const varianceId = await varianceIdOf(taskId, skuIds.get(PLAIN)!);
      const opDenied = await resolveVariance(varianceId, { decision: 'recount' }, operatorToken, ulid()).expect(403);
      expect(opDenied.body.code).toBe('role-denied');
      const accDenied = await resolveVariance(varianceId, { decision: 'recount' }, accountantToken, ulid()).expect(403);
      expect(accDenied.body.code).toBe('role-denied');
      const opPolicy = await putVariancePolicy({ quantityThreshold: 99 }, operatorToken, ulid()).expect(403);
      expect(opPolicy.body.code).toBe('role-denied');
      const foreign = await resolveVariance(varianceId, { decision: 'recount' }, otherTenantToken, ulid()).expect(403);
      expect(foreign.body.code).toBe('permission-denied'); // the token's tenant ≠ the path tenant
      const unknownId = await resolveVariance(randomUUID(), { decision: 'recount' }, ownerToken, ulid()).expect(404);
      expect(unknownId.body.code).toBe('not-found');
      // …and the owner's own resolution still comes first in this describe's
      // ledger (the guard is at the command, not the capability).
      const seqs = await warehouseSeqs(warehouseId);
      const res = await resolveVariance(varianceId, {
        decision: 'approve_adjust',
        consideredEventSeqs: seqs.slice(0, 1),
      }, ownerToken, ulid()).expect(200);
      expect(res.body.variance.status).toBe('adjusted');
    });

    it('PUT null disables the routing: the read serves the null policy and the next submit stamps nothing', async () => {
      const disabled = await putVariancePolicy({ quantityThreshold: null }, ownerToken, ulid()).expect(200);
      expect(disabled.body.quantityThreshold).toBeNull();
      const read = await getVariancePolicy().expect(200);
      expect(read.body.quantityThreshold).toBeNull();
      // A submit under the disabled policy: the new variance is unstamped
      // and no owner event fires (the frozen intent re-proved at the tail).
      // The beyond-task MID append gives the task a real variance.
      const task = await createCount({ warehouseId, binId: vbin2 }).expect(201);
      const res = await submitCount(task.body.countTask.id as string, {
        lines: [
          { skuId: skuIds.get(PLAIN), countedQuantity: 11 },
          { skuId: skuIds.get(MID), countedQuantity: 3 },
        ],
      }, deviceOperatorToken).expect(200);
      expect(res.body.variances).toHaveLength(1);
      const varianceId = await varianceIdOf(task.body.countTask.id as string, skuIds.get(MID)!);
      expect((await varianceRow(varianceId)).threshold_quantity_milli).toBeNull();
      const forVariance = (await outboxPayloads('count.variance.threshold_exceeded')).filter(
        (payload) => payload.varianceId === varianceId,
      );
      expect(forVariance).toHaveLength(0);
    });

    it('refuses the approve_adjust correction against a retired bin (the guard-set arm): 400, the variance stays open', async () => {
      // The I/O matrix's row-1 error cell: the correction's re-execution
      // rides assertAdjustableInTx's FULL guard set, and a bin retired
      // between the count and the decision is refused — the resolve rolls
      // back, the variance stays open, and a recount is the only way out.
      // An EMPTY bin counts a variance with an expected of 0 (the beyond-task
      // append) — no stock, which is exactly what permits the retirement.
      const bin = (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${vzoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 1000, type: 'shelf', code: 'V-01-05' })
          .expect(201)
      ).body.id as string;
      const task = await createCount({ warehouseId, binId: bin }).expect(201);
      await submitCount(task.body.countTask.id as string, {
        lines: [{ skuId: skuIds.get(PLAIN), countedQuantity: 3 }],
      }, deviceOperatorToken).expect(200);
      const varianceId = await varianceIdOf(task.body.countTask.id as string, skuIds.get(PLAIN)!);
      expect((await varianceRow(varianceId)).status).toBe('open');
      // The bin holds nothing — the retirement gate (retirement is terminal,
      // so the guard set the approval-time sequence must see it).
      const retired = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${bin}/retire`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(200);
      expect(retired.body.retiredAt).not.toBeNull();
      // Retirement writes no ledger event and no epoch bump — the frozen
      // basis still matches, so the resolve reaches the correction's guard
      // set (not 409 variance-basis-moved).
      const seqs = await warehouseSeqs(warehouseId);
      const ledgerBefore = await ledgerCount();
      const res = await resolveVariance(varianceId, {
        decision: 'approve_adjust',
        consideredEventSeqs: seqs,
      }, ownerToken).expect(400);
      expect(res.body.code).toBe('bin-retired');
      // The rollback: the variance is still open, no stockCorrection event
      // landed (the ledger is untouched), nothing moved (still empty).
      expect((await varianceRow(varianceId)).status).toBe('open');
      expect((await varianceRow(varianceId)).considered_event_seqs).toBeNull();
      expect(await ledgerCount()).toBe(ledgerBefore);
      // No on-hand row: the bin was empty going in and nothing corrected in.
      expect(await onHandMilli(warehouseId, skuIds.get(PLAIN)!, bin)).toBeNull();
      const echoes = (await outboxPayloads('count.variance.resolved')).filter(
        (payload) => payload.varianceId === varianceId,
      );
      expect(echoes).toHaveLength(0);
    });
  });
});

// ── the worker shell (unit, the reaper-plumbing pattern) ─────────────────────

describe('count scheduler plumbing (unit, story 5-3)', () => {
  const ENV_KEY = 'COUNT_SCHEDULER_POLL_MS';

  function setEnv(value: string | undefined): void {
    if (value === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = value;
    }
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error('waitFor: condition never became true');
      }
      await delay(5);
    }
  }

  afterEach(() => {
    setEnv(undefined);
  });

  describe('parseCountSchedulerPollMs', () => {
    it('unset and empty are off (0)', () => {
      expect(parseCountSchedulerPollMs(undefined)).toBe(0);
      expect(parseCountSchedulerPollMs('')).toBe(0);
    });

    it('non-negative integers pass through (0 included)', () => {
      expect(parseCountSchedulerPollMs('3600000')).toBe(3_600_000);
      expect(parseCountSchedulerPollMs('0')).toBe(0);
    });

    it('anything not a non-negative integer fails the boot loudly', () => {
      expect(() => parseCountSchedulerPollMs('hourly')).toThrow(/COUNT_SCHEDULER_POLL_MS/);
      expect(() => parseCountSchedulerPollMs('1.5')).toThrow(/COUNT_SCHEDULER_POLL_MS/);
      expect(() => parseCountSchedulerPollMs('-5')).toThrow(/COUNT_SCHEDULER_POLL_MS/);
    });
  });

  describe('CountSchedulerWorker', () => {
    const SCOPE = { tenantId: 't-1', warehouseId: 'w-1' };

    /** An AUTH-database stub answering the tick's enumeration read. */
    function stubAuthDb(scopes: { tenantId: string; warehouseId: string }[]): { execute(): Promise<unknown> } {
      return { execute: async () => scopes };
    }

    /**
     * A facade stub recording generation calls, able to hold one in flight
     * (the reaper stub's shape — the shed test's fixture).
     */
    function stubFacade(): {
      calls: { tenantId: string; warehouseId: string; maxTasks: number }[];
      hold: boolean;
      generateScheduledCountTasks(tenantId: string, warehouseId: string, maxTasks: number): Promise<string[]>;
      release(): void;
    } {
      const calls: { tenantId: string; warehouseId: string; maxTasks: number }[] = [];
      let held: (() => void) | undefined;
      return {
        calls,
        hold: false,
        async generateScheduledCountTasks(tenantId, warehouseId, maxTasks) {
          calls.push({ tenantId, warehouseId, maxTasks });
          if (this.hold && held === undefined) {
            await new Promise<void>((resolve) => {
              held = resolve;
            });
          }
          return [];
        },
        release() {
          held?.();
          held = undefined;
        },
      };
    }

    it('an invalid env fails the constructor (loud boot, not a silent worker)', () => {
      for (const bad of ['hourly', '1.5', '-5']) {
        setEnv(bad);
        expect(() => new CountSchedulerWorker(stubAuthDb([]) as never, stubFacade() as never)).toThrow(
          /COUNT_SCHEDULER_POLL_MS/,
        );
      }
    });

    it('pollMs=0 (env unset) schedules nothing', async () => {
      setEnv(undefined);
      const facade = stubFacade();
      const worker = new CountSchedulerWorker(stubAuthDb([SCOPE]) as never, facade as never);
      worker.onApplicationBootstrap();
      await delay(60);
      expect(facade.calls).toHaveLength(0);
      worker.onApplicationShutdown();
    });

    it('bootstrap with a poll interval enumerates scopes and drives generation on the timer', async () => {
      setEnv('20');
      const facade = stubFacade();
      const worker = new CountSchedulerWorker(
        stubAuthDb([SCOPE, { tenantId: 't-1', warehouseId: 'w-2' }]) as never,
        facade as never,
      );
      worker.onApplicationBootstrap();
      try {
        await waitFor(() => facade.calls.length >= 4);
        // Each tick walks EVERY enumerated scope (cross-tenant enumeration →
        // one tenant transaction per warehouse), with the tick's cap.
        expect(facade.calls.slice(0, 4)).toEqual([
          { tenantId: 't-1', warehouseId: 'w-1', maxTasks: MAX_SCHEDULED_TASKS_PER_TICK },
          { tenantId: 't-1', warehouseId: 'w-2', maxTasks: MAX_SCHEDULED_TASKS_PER_TICK },
          { tenantId: 't-1', warehouseId: 'w-1', maxTasks: MAX_SCHEDULED_TASKS_PER_TICK },
          { tenantId: 't-1', warehouseId: 'w-2', maxTasks: MAX_SCHEDULED_TASKS_PER_TICK },
        ]);
      } finally {
        worker.onApplicationShutdown();
      }
    });

    it('a poison warehouse is skipped and the NEXT scope still generates (per-warehouse all-or-nothing, never starves the tick)', async () => {
      setEnv('20');
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const calls: { warehouseId: string; maxTasks: number }[] = [];
      const poisoned = {
        async generateScheduledCountTasks(
          tenantId: string,
          warehouseId: string,
          maxTasks: number,
        ): Promise<string[]> {
          calls.push({ warehouseId, maxTasks });
          void tenantId;
          if (warehouseId === 'w-1') {
            throw new Error('boom');
          }
          return [];
        },
      };
      const worker = new CountSchedulerWorker(
        stubAuthDb([SCOPE, { tenantId: 't-1', warehouseId: 'w-2' }]) as never,
        poisoned as never,
      );
      worker.onApplicationBootstrap();
      try {
        await waitFor(() => calls.length >= 4);
        expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
          'Count scheduler could not generate tasks for warehouse w-1',
        );
        // The failure did not starve the second scope — every tick reached it.
        expect(calls.filter((call) => call.warehouseId === 'w-2').length).toBeGreaterThanOrEqual(2);
        // …and every call carries the tick's cap.
        expect(calls.every((call) => call.maxTasks === MAX_SCHEDULED_TASKS_PER_TICK)).toBe(true);
      } finally {
        worker.onApplicationShutdown();
        errorSpy.mockRestore();
      }
    });

    it('an in-flight cycle sheds the next ticks until it settles', async () => {
      setEnv('15');
      const facade = stubFacade();
      facade.hold = true;
      const worker = new CountSchedulerWorker(stubAuthDb([SCOPE]) as never, facade as never);
      worker.onApplicationBootstrap();
      try {
        await waitFor(() => facade.calls.length === 1);
        await delay(60);
        expect(facade.calls).toHaveLength(1);
        facade.release();
        await waitFor(() => facade.calls.length >= 2);
      } finally {
        facade.release();
        worker.onApplicationShutdown();
      }
    });

    it('shutdown clears the timer (no further cycles)', async () => {
      setEnv('15');
      const facade = stubFacade();
      const worker = new CountSchedulerWorker(stubAuthDb([SCOPE]) as never, facade as never);
      worker.onApplicationBootstrap();
      await waitFor(() => facade.calls.length >= 1);
      worker.onApplicationShutdown();
      const atShutdown = facade.calls.length;
      await delay(80);
      expect(facade.calls.length).toBe(atShutdown);
    });
  });
});
