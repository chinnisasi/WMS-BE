import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { MovementsFacade } from '../src/modules/movements/transfer.facade';
import { MAX_BULK_COUNT_BINS } from '../src/modules/movements/count.command';
import { signTenantSession } from '../src/modules/tenancy/jwt-session';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 3-5a — blind counts and count admin. The handheld counts without
// seeing an expected quantity (snapshot, submit response — fresh and
// replayed — and push carry none), may add a SKU it finds in the bin, and
// supervisors create (one bin, many bins or a zone), list, inspect and
// unschedule counts on the web. Every row of the spec's I/O matrix is driven
// here over real HTTP.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(120_000);

/** Keys no device-reachable body may carry (story 3-5a, Always). */
const LEAK_KEYS = /^(expected|expectedQuantity|counted|delta|deltaMilli|varianceCount|varianceId|varianceIds|threshold.*)$/;

/**
 * Walk every key of a JSON body: no leak key anywhere, every `variances` is
 * an empty array, and no string value names one of the differing SKU ids.
 */
function assertBlind(body: unknown, differingSkuIds: readonly string[], path = '$'): void {
  if (Array.isArray(body)) {
    body.forEach((item, index) => assertBlind(item, differingSkuIds, `${path}[${index}]`));
    return;
  }
  if (typeof body === 'string') {
    expect({ path, leaks: differingSkuIds.includes(body) }).toEqual({ path, leaks: false });
    return;
  }
  if (body === null || typeof body !== 'object') return;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    expect({ path: `${path}.${key}`, leak: LEAK_KEYS.test(key) }).toEqual({ path: `${path}.${key}`, leak: false });
    if (key === 'variances') {
      expect({ path: `${path}.${key}`, value }).toEqual({ path: `${path}.${key}`, value: [] });
    }
    assertBlind(value, differingSkuIds, `${path}.${key}`);
  }
}

describe('blind counts and count admin (e2e, story 3-5a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql;
  let movements: MovementsFacade;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorUserId: string;
  let operatorWebToken: string;
  let deviceToken: string; // the operator's badge-in session
  let portalToken: string;
  let glowClient: string;

  let warehouseId: string; // W — every arm but the scheduler's
  let schedWarehouseId: string; // WS — the policy-remove scheduler arm
  let bulkZone: string; // zone B: 12 bins (B-01..B-12)
  const bulkBins: { id: string; code: string }[] = [];
  let foundBin: string; // F-01 — PLAIN 5 (the found-SKU arms)
  let schedBin: string; // WS S-01 — MIDB 4 (class b)
  const sku = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const auth = (req: SupertestTest, token = opsToken) => req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('counts_admin');
    app = await createApp(false);
    await app.init();
    movements = app.get(MovementsFacade);
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Count Admin Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;

    const member = async (role: 'ops_manager' | 'operator'): Promise<{ id: string; email: string; token: string }> => {
      const memberEmail = `${role}-${ulid().toLowerCase()}@example.com`;
      const invited = await auth(http().post(`${API}/${tenantId}/users`), ownerToken)
        .set(KEY_HEADER, ulid())
        .send({ email: memberEmail, role })
        .expect(201);
      await http()
        .post(`${API}/${tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
        .expect(200);
      const token = (await mintSignIn(app, { email: memberEmail, password: 'correct-horse-battery' })).body.accessToken as string;
      return { id: invited.body.user.id as string, email: memberEmail, token };
    };
    const ops = await member('ops_manager');
    opsToken = ops.token;
    opsUserId = ops.id;
    const operator = await member('operator');
    operatorUserId = operator.id;
    operatorWebToken = operator.token;

    const minted = await auth(http().post(`${API}/${tenantId}/devices/enrollment-codes`), ownerToken).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'count-admin scanner', pin: '2468' })
      .expect(201);
    deviceToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: operator.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    // SKUs: the tenant's own (plain, class-b, batch, serial, catch-weight,
    // to-be-inactive), a kit of PLAIN, and GlowCo's own.
    const importCsv = async (csv: string, clientId?: string): Promise<void> => {
      const req = auth(http().post(`${API}/${tenantId}/catalog/imports`), ownerToken).set(KEY_HEADER, ulid()).field('mode', 'initial');
      if (clientId !== undefined) req.field('clientId', clientId);
      const res = await req.attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' });
      expect({ status: res.status, body: res.status === 201 ? null : res.body }).toEqual({ status: 201, body: null });
    };
    await importCsv(
      [
        'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode,abc_class',
        'CA-PLAIN,Plain,pcs,,1800,,false,false,false,,,,a',
        'CA-MIDB,Mid b,pcs,,1800,,false,false,false,,,,b',
        'CA-BATCH,Batch tracked,pcs,,1800,,true,false,false,,,,',
        'CA-SERIAL,Serial tracked,pcs,,1800,,false,true,false,,,,',
        'CA-CW,Catch weight,case,,1800,,false,false,true,,,,',
        'CA-INACT,Gone inactive,pcs,,1800,,false,false,false,,,,',
      ].join('\n'),
    );
    await importCsv(['sku_code,name,uom,gst_rate,kit_components', 'CA-KIT,A kit,pcs,1800,CA-PLAIN:2'].join('\n'));
    // Another client — created AFTER the own imports (a second client makes
    // an import name its client) — (the other-client found-SKU arm) and a portal token.
    glowClient = (
      await auth(http().post(`${API}/${tenantId}/clients`), ownerToken).set(KEY_HEADER, ulid()).send({ code: 'GLOW', name: 'GlowCo' }).expect(201)
    ).body.client.id as string;
    portalToken = signTenantSession(
      { tenantId, userId: ownerUserId, sessionId: uuidv7(), kind: 'portal', clientId: glowClient },
      process.env.JWT_SECRET!,
    );

    await importCsv(['sku_code,name,uom,gst_rate', 'GL-1,Glow item,pcs,1800'].join('\n'), glowClient);
    const rows = (await sql`select id, code from skus where tenant_id = ${tenantId}`) as unknown as { id: string; code: string }[];
    for (const row of rows) sku.set(row.code, row.id);
    expect([...sku.keys()].sort()).toEqual(['CA-BATCH', 'CA-CW', 'CA-INACT', 'CA-KIT', 'CA-MIDB', 'CA-PLAIN', 'CA-SERIAL', 'GL-1']);
    await auth(http().patch(`${API}/${tenantId}/catalog/skus/${sku.get('CA-INACT')!}/status`), ownerToken)
      .set(KEY_HEADER, ulid())
      .send({ status: 'inactive' })
      .expect(200);

    const mkWarehouse = async (name: string): Promise<string> =>
      (
        await auth(http().post(`${API}/${tenantId}/warehouses`), ownerToken)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code: `CA-${ulid().slice(10, 16).toUpperCase()}`, name })
          .expect(201)
      ).body.id as string;
    const mkZone = async (wh: string, code: string): Promise<string> =>
      (await auth(http().post(`${API}/${tenantId}/warehouses/${wh}/zones`), ownerToken).set(KEY_HEADER, ulid()).send({ code, name: `Zone ${code}` }).expect(201))
        .body.id as string;
    const mkBin = async (wh: string, zone: string, code: string): Promise<string> =>
      (
        await auth(http().post(`${API}/${tenantId}/warehouses/${wh}/zones/${zone}/bins`), ownerToken)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 1000, type: 'shelf', code })
          .expect(201)
      ).body.id as string;
    warehouseId = await mkWarehouse('Count Admin WH');
    schedWarehouseId = await mkWarehouse('Count Admin Sched WH');
    bulkZone = await mkZone(warehouseId, 'B');
    for (let i = 1; i <= 12; i += 1) {
      const code = `B-${String(i).padStart(2, '0')}`;
      bulkBins.push({ id: await mkBin(warehouseId, bulkZone, code), code });
    }
    foundBin = await mkBin(warehouseId, await mkZone(warehouseId, 'F'), 'F-01');
    schedBin = await mkBin(schedWarehouseId, await mkZone(schedWarehouseId, 'S'), 'S-01');

    const adjust = async (wh: string, binId: string, code: string, quantityDelta: number): Promise<void> => {
      await auth(http().post(`${API}/${tenantId}/inventory/adjustments`))
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, skuId: sku.get(code), binId, quantityDelta, reasonCode: 'stock-count', note: 'count-admin seed' })
        .expect(201);
    };
    await adjust(warehouseId, foundBin, 'CA-PLAIN', 5);
    await adjust(warehouseId, bulkBins[2]!.id, 'CA-PLAIN', 3); // B-03 — a stocked bin among the bulk set
    await adjust(schedWarehouseId, schedBin, 'CA-MIDB', 4);
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

  // ── helpers ────────────────────────────────────────────────────────────────

  function createCount(body: Record<string, unknown>, key = ulid(), token = opsToken): SupertestTest {
    return auth(http().post(`${API}/${tenantId}/movements/counts`), token).set(KEY_HEADER, key).send(body);
  }

  function submitCount(taskId: string, lines: { skuId: string; countedQuantity: number }[], key = ulid(), token = deviceToken): SupertestTest {
    return auth(http().post(`${API}/${tenantId}/movements/counts/${taskId}/submit`), token).set(KEY_HEADER, key).send({ lines });
  }

  function detail(taskId: string, token = opsToken): SupertestTest {
    return auth(http().get(`${API}/${tenantId}/movements/counts/${taskId}`), token);
  }

  function snapshot(): SupertestTest {
    return auth(http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`), deviceToken);
  }

  async function taskStatus(taskId: string): Promise<string> {
    const rows = (await sql`select status from count_tasks where id = ${taskId}::uuid`) as unknown as { status: string }[];
    return rows[0]!.status;
  }

  async function auditCount(key: string, action: string): Promise<number> {
    const rows = (await sql`
      select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${key} and action = ${action}`) as unknown as { n: number }[];
    return Number(rows[0]!.n);
  }

  function handle(): postgres.Sql {
    return postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
  }

  /** Polls until `min` backends wait on a lock whose chain leads back to the holder. */
  async function waitParked(holderPid: number, min: number): Promise<void> {
    const probe = handle();
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active'`) as unknown as { pid: number; blockers: number[] }[];
        const chain = new Set<number>([holderPid]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const row of waiting) {
            if (!chain.has(row.pid) && row.blockers.some((pid) => chain.has(pid))) {
              chain.add(row.pid);
              grew = true;
            }
          }
        }
        if (chain.size - 1 >= min) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`fewer than ${min} request(s) parked behind the holder`);
    } finally {
      await probe.end();
    }
  }

  /** A pending single-bin task on the found bin (each arm consumes its own). */
  async function foundTask(): Promise<string> {
    const res = await createCount({ warehouseId, binId: foundBin }).expect(201);
    return res.body.countTask.id as string;
  }

  // ── blind snapshot and response ────────────────────────────────────────────

  describe('blind by construction', () => {
    it('the snapshot lists a pending task as {skuId, skuCode, skuName} lines only — no expected quantity anywhere in countTasks', async () => {
      const taskId = await foundTask();
      const res = await snapshot().expect(200);
      const cards = res.body.countTasks as { taskId: string; lines: Record<string, unknown>[] }[];
      const card = cards.find((c) => c.taskId === taskId)!;
      expect(card.lines).toEqual([{ skuId: sku.get('CA-PLAIN'), skuCode: 'CA-PLAIN', skuName: 'Plain' }]);
      assertBlind(res.body.countTasks, []);
      // Finish it so the next arm can open the bin again.
      await submitCount(taskId, [{ skuId: sku.get('CA-PLAIN')!, countedQuantity: 5 }]).expect(200);
    });

    it('a submit with one differing SKU answers {countTask, variances: [], recountTaskId} — the key walk finds nothing, fresh and replayed', async () => {
      const taskId = await foundTask();
      const key = ulid();
      const lines = [{ skuId: sku.get('CA-PLAIN')!, countedQuantity: 7 }];
      const res = await submitCount(taskId, lines, key).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['countTask', 'recountTaskId', 'variances']);
      expect(Object.keys(res.body.countTask).sort()).toEqual(['binId', 'completedAt', 'epochConflict', 'id', 'status', 'warehouseId']);
      expect(res.body.variances).toEqual([]);
      expect(res.body.recountTaskId).toBeNull();
      assertBlind(res.body, [sku.get('CA-PLAIN')!]);
      const replay = await submitCount(taskId, lines, key).expect(200);
      expect(replay.body).toEqual(res.body);
      assertBlind(replay.body, [sku.get('CA-PLAIN')!]);
      // The variance exists — the web reads it through the detail.
      const read = await detail(taskId).expect(200);
      expect(read.body.variances).toMatchObject([{ skuId: sku.get('CA-PLAIN'), expectedQuantity: 5, countedQuantity: 7, delta: 2, status: 'open' }]);
      // The stored snapshot itself is blind.
      const stored = (await sql`select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as {
        response_snapshot: unknown;
      }[];
      assertBlind(stored[0]!.response_snapshot, [sku.get('CA-PLAIN')!]);
    });

    it('a key stored before 3-5a (variances with quantities) is re-projected blind on replay', async () => {
      const taskId = await foundTask();
      const key = ulid();
      const lines = [{ skuId: sku.get('CA-PLAIN')!, countedQuantity: 4 }];
      const fresh = await submitCount(taskId, lines, key).expect(200);
      // Rewrite the stored answer into the pre-3-5a shape.
      const legacy = {
        countTask: fresh.body.countTask,
        variances: [{ skuId: sku.get('CA-PLAIN'), expectedQuantity: 5, countedQuantity: 4, delta: -1, epochConflict: false }],
        recountTaskId: null,
      };
      await sql`update idempotency_keys set response_snapshot = ${sql.json(legacy)} where tenant_id = ${tenantId} and key = ${key}`;
      const replay = await submitCount(taskId, lines, key).expect(200);
      expect(replay.body).toEqual({ countTask: fresh.body.countTask, variances: [], recountTaskId: null });
      assertBlind(replay.body, [sku.get('CA-PLAIN')!]);
      // …and through the facade (the review apply's path) as well.
      const viaFacade = await movements.submitCount({ tenantId, actorUserId: operatorUserId, taskId, lines }, key);
      expect(viaFacade).toEqual({ countTask: fresh.body.countTask, variances: [], recountTaskId: null });
    });
  });

  // ── found SKUs ─────────────────────────────────────────────────────────────

  describe('found SKUs', () => {
    it('a SKU the task does not list is recorded: the variance is expected 0, counted 3', async () => {
      const taskId = await foundTask();
      await submitCount(taskId, [
        { skuId: sku.get('CA-PLAIN')!, countedQuantity: 5 },
        { skuId: sku.get('CA-MIDB')!, countedQuantity: 3 },
      ]).expect(200);
      const read = await detail(taskId).expect(200);
      expect(read.body.lines).toEqual([
        { skuId: sku.get('CA-MIDB'), skuCode: 'CA-MIDB', skuName: 'Mid b', expectedQuantity: 0, countedQuantity: 3 },
        { skuId: sku.get('CA-PLAIN'), skuCode: 'CA-PLAIN', skuName: 'Plain', expectedQuantity: 5, countedQuantity: 5 },
      ]);
      expect(read.body.variances).toHaveLength(1);
      expect(read.body.variances[0]).toMatchObject({ skuId: sku.get('CA-MIDB'), expectedQuantity: 0, countedQuantity: 3, delta: 3, status: 'open' });
    });

    it.each([
      ['CA-KIT', 'a kit'],
      ['CA-BATCH', 'batch-tracked'],
      ['CA-SERIAL', 'serial-tracked'],
      ['CA-CW', 'catch-weight'],
    ])('a found %s is refused 400 count-found-sku-not-countable; the task stays pending', async (code, why) => {
      const taskId = await foundTask();
      const res = await submitCount(taskId, [
        { skuId: sku.get('CA-PLAIN')!, countedQuantity: 5 },
        { skuId: sku.get(code)!, countedQuantity: 1 },
      ]).expect(400);
      expect(res.body.code).toBe('count-found-sku-not-countable');
      expect(res.body.detail).toContain(`${code} (${why})`);
      expect(await taskStatus(taskId)).toBe('pending');
      await submitCount(taskId, [{ skuId: sku.get('CA-PLAIN')!, countedQuantity: 5 }]).expect(200);
    });

    it('the refusal sits behind the replay: a submit committed under a key replays even if its found SKU became tracked afterwards', async () => {
      const taskId = await foundTask();
      const key = ulid();
      const lines = [
        { skuId: sku.get('CA-PLAIN')!, countedQuantity: 5 },
        { skuId: sku.get('CA-MIDB')!, countedQuantity: 1 },
      ];
      const first = await submitCount(taskId, lines, key).expect(200);
      await sql`update skus set batch_tracked = true where id = ${sku.get('CA-MIDB')!}::uuid`;
      try {
        const replay = await submitCount(taskId, lines, key).expect(200);
        expect(replay.body).toEqual(first.body);
      } finally {
        await sql`update skus set batch_tracked = false where id = ${sku.get('CA-MIDB')!}::uuid`;
      }
    });

    it('a LISTED tracked SKU is counted normally — the found-line refusal never touches a line the task lists', async () => {
      const zone = (await auth(http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`), ownerToken).set(KEY_HEADER, ulid()).send({ code: 'L', name: 'Zone L' }).expect(201))
        .body.id as string;
      const binId = (
        await auth(http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone}/bins`), ownerToken)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 1000, type: 'shelf', code: 'L-01' })
          .expect(201)
      ).body.id as string;
      await auth(http().post(`${API}/${tenantId}/inventory/adjustments`))
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: sku.get('CA-BATCH'), binId, quantityDelta: 4, reasonCode: 'stock-count', note: 'listed tracked seed', batch: { code: 'LOT-1' } })
        .expect(201);
      const task = await createCount({ warehouseId, binId }).expect(201);
      expect(task.body.lines).toEqual([{ skuId: sku.get('CA-BATCH'), expectedQuantity: 4 }]);
      const res = await submitCount(task.body.countTask.id as string, [{ skuId: sku.get('CA-BATCH')!, countedQuantity: 3 }]).expect(200);
      expect(res.body.countTask.status).toBe('completed');
    });

    it('another client\'s SKU and an inactive SKU are recorded — a count is an observation', async () => {
      const taskId = await foundTask();
      await submitCount(taskId, [
        { skuId: sku.get('CA-PLAIN')!, countedQuantity: 5 },
        { skuId: sku.get('GL-1')!, countedQuantity: 2 },
        { skuId: sku.get('CA-INACT')!, countedQuantity: 1 },
      ]).expect(200);
      const read = await detail(taskId).expect(200);
      const bySku = new Map((read.body.variances as { skuId: string; countedQuantity: number }[]).map((v) => [v.skuId, v.countedQuantity]));
      expect(bySku.get(sku.get('GL-1')!)).toBe(2);
      expect(bySku.get(sku.get('CA-INACT')!)).toBe(1);
    });
  });

  // ── create: single (unchanged) and bulk ────────────────────────────────────

  describe('create', () => {
    it('single create is unchanged: the fingerprint golden and the exact response keys', async () => {
      const key = ulid();
      const res = await createCount({ warehouseId, binId: bulkBins[11]!.id }, key).expect(201);
      // The golden: the pre-3-5a fingerprint, written out key by key.
      const expected = createHash('sha256')
        .update(`{"tenantId":"${tenantId}","warehouseId":"${warehouseId}","binId":"${bulkBins[11]!.id}"}`, 'utf8')
        .digest('hex');
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as {
        payload_hash: string;
      }[];
      expect(stored[0]!.payload_hash).toBe(expected);
      expect(Object.keys(res.body).sort()).toEqual(['countTask', 'lines']);
      expect(Object.keys(res.body.countTask).sort()).toEqual(['binCode', 'binId', 'binStateEpoch', 'createdAt', 'id', 'origin', 'status', 'warehouseId']);
      // The single arm's refusal is unchanged too: a second task on the bin is 409.
      const again = await createCount({ warehouseId, binId: bulkBins[11]!.id }).expect(409);
      expect(again.body.code).toBe('count-task-open');
      // Close it again, so the bulk arm below sees B-12 free.
      await submitCount(res.body.countTask.id as string, []).expect(200);
    });

    it('400s a body naming none, or more than one, of binId / binIds / zoneId, and a repeated bin', async () => {
      for (const body of [
        { warehouseId },
        { warehouseId, binId: bulkBins[0]!.id, zoneId: bulkZone },
        { warehouseId, binIds: [bulkBins[0]!.id], zoneId: bulkZone },
        { warehouseId, binIds: [bulkBins[0]!.id, bulkBins[0]!.id] },
        { warehouseId, binIds: [] },
        // An explicit null is absent: never a TypeError 500, never a lookup.
        { warehouseId, binIds: null },
        { warehouseId, zoneId: null },
        { warehouseId, binId: null },
        { warehouseId, binId: null, binIds: null, zoneId: null },
      ]) {
        const res = await createCount(body).expect(400);
        expect(res.body.code).toBe('validation-failed');
      }
    });

    it('a zone of 12, 2 with open tasks: 10 created (bulk-flagged, never pushed), 2 skipped count-task-open; audited per task; replays', async () => {
      const open1 = await createCount({ warehouseId, binId: bulkBins[0]!.id }).expect(201);
      const open2 = await createCount({ warehouseId, binId: bulkBins[1]!.id }).expect(201);
      const key = ulid();
      const res = await createCount({ warehouseId, zoneId: bulkZone }, key).expect(201);
      expect(res.body.created).toHaveLength(10);
      expect(res.body.skipped).toEqual([
        { binId: bulkBins[0]!.id, binCode: 'B-01', reason: 'count-task-open' },
        { binId: bulkBins[1]!.id, binCode: 'B-02', reason: 'count-task-open' },
      ]);
      expect((res.body.created as { binCode: string }[]).map((c) => c.binCode)).toEqual(bulkBins.slice(2).map((b) => b.code));
      // The stocked B-03 froze its one line; the others froze none.
      const b03 = (res.body.created as { binCode: string; lineCount: number; taskId: string }[]).find((c) => c.binCode === 'B-03')!;
      expect(b03.lineCount).toBe(1);
      const createdIds = (res.body.created as { taskId: string }[]).map((c) => c.taskId);
      const tasks = (await sql`
        select origin, status, created_by from count_tasks where id = any(${createdIds}::uuid[])`) as unknown as {
        origin: string;
        status: string;
        created_by: string;
      }[];
      expect(tasks).toHaveLength(10);
      for (const task of tasks) expect(task).toEqual({ origin: 'on_demand', status: 'pending', created_by: opsUserId });
      // Never pushed: every created task's count.created carries bulk: true.
      const events = (await sql`
        select payload from outbox_messages where tenant_id = ${tenantId} and type = 'count.created'
          and payload->>'taskId' = any(${createdIds}::text[])`) as unknown as { payload: Record<string, unknown> }[];
      expect(events).toHaveLength(10);
      for (const event of events) expect(event.payload).toMatchObject({ origin: 'on_demand', bulk: true, warehouseId });
      // …while the single create's event carries no flag (it is pushed).
      const single = (await sql`
        select payload from outbox_messages where tenant_id = ${tenantId} and type = 'count.created'
          and payload->>'taskId' = ${open1.body.countTask.id as string}`) as unknown as { payload: Record<string, unknown> }[];
      expect(single[0]!.payload).not.toHaveProperty('bulk');
      // One count.created audit row per created task, all under the key.
      expect(await auditCount(key, 'count.created')).toBe(10);
      const replay = await createCount({ warehouseId, zoneId: bulkZone }, key).expect(201);
      expect(replay.body).toEqual(res.body);
      expect(await auditCount(key, 'count.created')).toBe(10);
      const drifted = await createCount({ warehouseId, binIds: [bulkBins[0]!.id] }, key).expect(422);
      expect(drifted.body.code).toBe('idempotency-key-reuse');
      // The open tasks the arm made are closed for the arms below.
      for (const id of [open1.body.countTask.id as string, open2.body.countTask.id as string, ...createdIds]) {
        await sql`update count_tasks set status = 'completed', completed_at = now() where id = ${id}::uuid`;
      }
    });

    it('binIds: a listed system bin and a retired bin are skipped and named; a reordered retry replays (the fingerprint sorts the set)', async () => {
      const sys = (await sql`
        insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned)
        values (${uuidv7()}::uuid, ${tenantId}::uuid, ${warehouseId}::uuid, ${bulkZone}::uuid, 'B-SYS', 1000000, 'staging', true)
        returning id`) as unknown as { id: string }[];
      const retired = bulkBins[10]!; // B-11
      await sql`update bins set retired_at = now(), retired_by = ${opsUserId}::uuid where id = ${retired.id}::uuid`;
      const ids = [bulkBins[3]!.id, sys[0]!.id, retired.id];
      const key = ulid();
      const res = await createCount({ warehouseId, binIds: ids }, key).expect(201);
      expect(res.body.created.map((c: { binCode: string }) => c.binCode)).toEqual(['B-04']);
      expect(res.body.skipped).toEqual([
        { binId: retired.id, binCode: 'B-11', reason: 'bin-retired' },
        { binId: sys[0]!.id, binCode: 'B-SYS', reason: 'system-bin' },
      ]);
      const reordered = await createCount({ warehouseId, binIds: [...ids].reverse() }, key).expect(201);
      expect(reordered.body).toEqual(res.body);
      // A zone request selects countable bins only: neither is "skipped".
      const zoneKey = ulid();
      const zoneRes = await createCount({ warehouseId, zoneId: bulkZone }, zoneKey).expect(201);
      const zoneCodes = [...zoneRes.body.created, ...zoneRes.body.skipped].map((c: { binCode: string }) => c.binCode);
      expect(zoneCodes).not.toContain('B-11');
      expect(zoneCodes).not.toContain('B-SYS');
      await sql`update count_tasks set status = 'completed', completed_at = now() where tenant_id = ${tenantId} and status = 'pending' and warehouse_id = ${warehouseId}::uuid and bin_id <> ${foundBin}::uuid`;
    });

    it('an all-skipped request creates nothing and audits nothing (a declared no-op arm); an unknown bin is 404', async () => {
      const open = await createCount({ warehouseId, binId: bulkBins[4]!.id }).expect(201);
      const key = noOpIdempotencyKey(tenantId, ulid(), 'counts.createBulk:all-skipped');
      const res = await createCount({ warehouseId, binIds: [bulkBins[4]!.id] }, key).expect(201);
      expect(res.body).toEqual({ created: [], skipped: [{ binId: bulkBins[4]!.id, binCode: 'B-05', reason: 'count-task-open' }] });
      expect(await auditCount(key, 'count.created')).toBe(0);
      await submitCount(open.body.countTask.id as string, []).expect(200);
      const unknown = await createCount({ warehouseId, binIds: [bulkBins[5]!.id, uuidv7()] }).expect(404);
      expect(unknown.body.code).toBe('not-found');
      const zone404 = await createCount({ warehouseId, zoneId: uuidv7() }).expect(404);
      expect(zone404.body.code).toBe('not-found');
    });

    it('more than 500 bins is 422 too-many-bins — named, or in a zone', async () => {
      // Named: refused at the wire (@ArrayMaxSize) — 400; a zone is 422 below.
      const named = await createCount({ warehouseId, binIds: Array.from({ length: MAX_BULK_COUNT_BINS + 1 }, () => uuidv7()) }).expect(400);
      expect(named.body.code).toBe('validation-failed');
      const bigZone = (await auth(http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`), ownerToken).set(KEY_HEADER, ulid()).send({ code: 'BIG', name: 'Big' }).expect(201))
        .body.id as string;
      await sql`
        insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type)
        select gen_random_uuid(), ${tenantId}::uuid, ${warehouseId}::uuid, ${bigZone}::uuid, 'BIG-' || g, 100000, 'shelf'
        from generate_series(1, ${MAX_BULK_COUNT_BINS + 1}) g`;
      const zoned = await createCount({ warehouseId, zoneId: bigZone }).expect(422);
      expect(zoned.body.code).toBe('too-many-bins');
      // Exactly the ceiling is accepted (the boundary).
      await sql`update bins set retired_at = now(), retired_by = ${opsUserId}::uuid where zone_id = ${bigZone}::uuid and code = 'BIG-1'`;
      const atCeiling = await createCount({ warehouseId, zoneId: bigZone }).expect(201);
      expect(atCeiling.body.created).toHaveLength(MAX_BULK_COUNT_BINS);
      await sql`update count_tasks set status = 'completed', completed_at = now() where tenant_id = ${tenantId} and status = 'pending' and warehouse_id = ${warehouseId}::uuid and bin_id <> ${foundBin}::uuid`;
    });

    it('the counts.manage fence: the operator (web) is 403 role-denied; a device token never reaches the create (401)', async () => {
      const denied = await createCount({ warehouseId, zoneId: bulkZone }, ulid(), operatorWebToken).expect(403);
      expect(denied.body.code).toBe('role-denied');
      const device = await createCount({ warehouseId, zoneId: bulkZone }, ulid(), deviceToken).expect(401);
      expect(device.body.code).toBe('unauthenticated');
    });
  });

  // ── bulk locks ─────────────────────────────────────────────────────────────

  describe('bulk create locks', () => {
    it('takes the bin rows BEFORE the warehouse advisory: parked on the advisory, it already holds every bin row', async () => {
      const ids = [bulkBins[6]!.id, bulkBins[7]!.id];
      const holder = handle();
      const prober = handle();
      let pending: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`
            select pg_backend_pid() as pid, pg_advisory_xact_lock(hashtextextended(${tenantId} || ':' || ${warehouseId}, 0))`) as unknown as {
            pid: number;
          }[];
          pending = (async () => createCount({ warehouseId, binIds: ids }))();
          await waitParked(locked[0]!.pid, 1);
          // The bulk create waits on the advisory — and already holds the bins.
          await expect(
            prober.begin(async (ptx) => ptx`select id from bins where id = any(${ids}::uuid[]) for update nowait`),
          ).rejects.toMatchObject({ code: '55P03' });
        });
        const res = await pending!;
        expect(res.status).toBe(201);
        expect(res.body.created).toHaveLength(2);
      } finally {
        await Promise.allSettled([pending]);
        await holder.end();
        await prober.end();
      }
      await sql`update count_tasks set status = 'completed', completed_at = now() where tenant_id = ${tenantId} and status = 'pending' and bin_id = any(${ids}::uuid[])`;
    });

    it('a same-key duplicate parked on the bins replays the winner under the lock — same body, one set of tasks, one key', async () => {
      const ids = [bulkBins[8]!.id, bulkBins[9]!.id];
      const key = ulid();
      const send = () => createCount({ warehouseId, binIds: ids }, key);
      const holder = handle();
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`
            select pg_backend_pid() as pid from bins where id = ${ids[0]!}::uuid for update`) as unknown as { pid: number }[];
          first = (async () => send())();
          second = (async () => send())();
          await waitParked(locked[0]!.pid, 2);
        });
        const [a, b] = await Promise.all([first!, second!]);
        expect([a.status, b.status]).toEqual([201, 201]);
        expect(a.body).toEqual(b.body);
        expect(a.body.created).toHaveLength(2);
        expect(a.body.skipped).toEqual([]);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
      const keys = (await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { n: number }[];
      expect(Number(keys[0]!.n)).toBe(1);
      const pending = (await sql`
        select count(*)::int as n from count_tasks where tenant_id = ${tenantId} and status = 'pending' and bin_id = any(${ids}::uuid[])`) as unknown as {
        n: number;
      }[];
      expect(Number(pending[0]!.n)).toBe(2);
      expect(await auditCount(key, 'count.created')).toBe(2);
      await sql`update count_tasks set status = 'completed', completed_at = now() where tenant_id = ${tenantId} and status = 'pending' and bin_id = any(${ids}::uuid[])`;
    });
  });

  // ── the web reads ──────────────────────────────────────────────────────────

  describe('list and detail', () => {
    it('the detail: expected beside counted, the variances, and the recount task a resolved variance names', async () => {
      const taskId = await foundTask();
      await submitCount(taskId, [{ skuId: sku.get('CA-PLAIN')!, countedQuantity: 8 }]).expect(200);
      const before = await detail(taskId).expect(200);
      expect(before.body.task).toMatchObject({ id: taskId, binId: foundBin, binCode: 'F-01', status: 'completed', origin: 'on_demand', createdBy: opsUserId });
      expect(before.body.lines).toEqual([{ skuId: sku.get('CA-PLAIN'), skuCode: 'CA-PLAIN', skuName: 'Plain', expectedQuantity: 5, countedQuantity: 8 }]);
      expect(before.body.recountTaskId).toBeNull();
      const varianceId = before.body.variances[0].id as string;
      const resolved = await auth(http().post(`${API}/${tenantId}/movements/variances/${varianceId}/resolve`), ownerToken)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'recount' })
        .expect(200);
      const recountTaskId = resolved.body.variance.recountTaskId as string;
      const after = await detail(taskId).expect(200);
      expect(after.body.recountTaskId).toBe(recountTaskId);
      // A recount a RESOLUTION minted is not an epoch-conflict recount.
      expect(after.body.task.epochConflict).toBe(false);
      expect(after.body.conflictRecountTaskId).toBeNull();
      expect(after.body.variances[0]).toMatchObject({ id: varianceId, status: 'recounted', recountTaskId });
      // The recount task itself is pending: its detail shows the frozen lines, nothing counted.
      const recount = await detail(recountTaskId).expect(200);
      expect(recount.body.task).toMatchObject({ status: 'pending', origin: 'recount', createdBy: null, completedAt: null });
      expect(recount.body.lines).toEqual([{ skuId: sku.get('CA-PLAIN'), skuCode: 'CA-PLAIN', skuName: 'Plain', expectedQuantity: 5, countedQuantity: null }]);
      await submitCount(recountTaskId, [{ skuId: sku.get('CA-PLAIN')!, countedQuantity: 5 }]).expect(200);
    });

    it('the detail is a web staff read only: a device token is 401, a portal token 403, an unknown task 404, a malformed id 400', async () => {
      const taskId = (await sql`select id from count_tasks where tenant_id = ${tenantId} limit 1`)[0]!.id as string;
      // A gated read: the operator (counts.execute only — the counter, who
      // counts blind) is 403; counts.manage or variances.resolve reads it.
      const operator = await detail(taskId, operatorWebToken).expect(403);
      expect(operator.body.code).toBe('role-denied');
      await detail(taskId, ownerToken).expect(200);
      const device = await detail(taskId, deviceToken).expect(401);
      expect(device.body.code).toBe('unauthenticated');
      const portal = await detail(taskId, portalToken).expect(403);
      expect(portal.body).toMatchObject({ code: 'role-denied', detail: 'This is an operator surface.' });
      expect((await detail(uuidv7()).expect(404)).body.code).toBe('not-found');
      expect((await detail('not-a-uuid').expect(400)).body.code).toBe('validation-failed');
      // The list is fenced the same way.
      await auth(http().get(`${API}/${tenantId}/movements/counts`), deviceToken).expect(401);
      await auth(http().get(`${API}/${tenantId}/movements/counts`), portalToken).expect(403);
    });

    it('an epoch-conflict recount is visible in the detail — even when no SKU differed', async () => {
      const taskId = await foundTask();
      await auth(http().post(`${API}/${tenantId}/inventory/adjustments`))
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: sku.get('CA-PLAIN'), binId: foundBin, quantityDelta: 1, reasonCode: 'stock-count', note: 'epoch mover' })
        .expect(201);
      // Counted 5 against the frozen 5: no variance, but the bin moved.
      const res = await submitCount(taskId, [{ skuId: sku.get('CA-PLAIN')!, countedQuantity: 5 }]).expect(200);
      expect(res.body.countTask.epochConflict).toBe(true);
      const recountId = res.body.recountTaskId as string;
      expect(recountId).toBeTruthy();
      const read = await detail(taskId).expect(200);
      expect(read.body.variances).toEqual([]);
      expect(read.body.task.epochConflict).toBe(true);
      expect(read.body.conflictRecountTaskId).toBe(recountId);
      expect(read.body.recountTaskId).toBeNull();
      // The recount's own detail is not itself a conflict.
      await submitCount(recountId, [{ skuId: sku.get('CA-PLAIN')!, countedQuantity: 6 }]).expect(200);
      const recount = await detail(recountId).expect(200);
      expect(recount.body.task.epochConflict).toBe(false);
      expect(recount.body.conflictRecountTaskId).toBeNull();
    });

    it('the list: newest first, keyset paging walks every row once, filters narrow, no quantities', async () => {
      const all: { id: string; createdAt: string }[] = [];
      let cursor: string | null = null;
      do {
        const page: request.Response = await auth(
          http().get(`${API}/${tenantId}/movements/counts?warehouseId=${warehouseId}&limit=37${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`),
        ).expect(200);
        all.push(...(page.body.items as { id: string; createdAt: string }[]));
        cursor = page.body.nextCursor as string | null;
      } while (cursor !== null);
      const db = (await sql`
        select id from count_tasks where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}::uuid
        order by created_at desc, id desc`) as unknown as { id: string }[];
      expect(all.map((row) => row.id)).toEqual(db.map((row) => row.id));
      const first = await auth(http().get(`${API}/${tenantId}/movements/counts?warehouseId=${warehouseId}&limit=1`)).expect(200);
      // No quantity on the list (the web reads the detail for those).
      expect(Object.keys(first.body.items[0]).sort()).toEqual([
        'binCode', 'binId', 'completedAt', 'completedBy', 'createdAt', 'createdBy', 'id', 'lineCount', 'openVarianceCount', 'origin', 'status', 'varianceCount', 'warehouseId',
      ]);
      const recounts = await auth(http().get(`${API}/${tenantId}/movements/counts?origin=recount`)).expect(200);
      expect((recounts.body.items as { origin: string }[]).length).toBeGreaterThan(0);
      for (const item of recounts.body.items as { origin: string }[]) expect(item.origin).toBe('recount');
      const byBin = await auth(http().get(`${API}/${tenantId}/movements/counts?binId=${foundBin}&status=completed`)).expect(200);
      for (const item of byBin.body.items as { binId: string; status: string }[]) expect(item).toMatchObject({ binId: foundBin, status: 'completed' });
      expect((byBin.body.items as unknown[]).length).toBeGreaterThan(3);
      const withVariance = (byBin.body.items as { varianceCount: number }[]).filter((item) => item.varianceCount > 0);
      expect(withVariance.length).toBeGreaterThan(0);
      expect((await auth(http().get(`${API}/${tenantId}/movements/counts?status=nope`)).expect(400)).body.code).toBe('validation-failed');
      expect((await auth(http().get(`${API}/${tenantId}/movements/counts?cursor=garbage`)).expect(400)).body.code).toBe('invalid-cursor');
      // Any staff role reads it (the operator's web session too).
      await auth(http().get(`${API}/${tenantId}/movements/counts?limit=1`), operatorWebToken).expect(200);
    });
  });

  // ── the schedule ───────────────────────────────────────────────────────────

  describe('count policies: read, set, remove', () => {
    const policies = (wh: string, token = opsToken) => auth(http().get(`${API}/${tenantId}/movements/warehouses/${wh}/count-policies`), token);
    const put = (wh: string, body: Record<string, unknown>, key = ulid()) =>
      auth(http().put(`${API}/${tenantId}/movements/warehouses/${wh}/count-policies`)).set(KEY_HEADER, key).send(body);
    const remove = (wh: string, abcClass: string, key = ulid(), token = opsToken) =>
      auth(http().delete(`${API}/${tenantId}/movements/warehouses/${wh}/count-policies/${abcClass}`), token).set(KEY_HEADER, key);

    it('removes a class: the row goes, the answer is the remaining set, audited count_policy.removed; replays; an absent class is 404', async () => {
      expect((await policies(schedWarehouseId).expect(200)).body).toEqual({ policies: [] });
      await put(schedWarehouseId, { policies: [{ abcClass: 'a', intervalDays: 30 }, { abcClass: 'b', intervalDays: 7 }] }).expect(200);
      expect((await policies(schedWarehouseId).expect(200)).body.policies).toEqual([
        { abcClass: 'a', intervalDays: 30 },
        { abcClass: 'b', intervalDays: 7 },
      ]);
      const key = ulid();
      const res = await remove(schedWarehouseId, 'b', key).expect(200);
      expect(res.body).toEqual({ policies: [{ abcClass: 'a', intervalDays: 30 }] });
      await expectAuditRow({ tenantId, key, action: 'count_policy.removed', targetType: 'warehouse', targetId: schedWarehouseId, actorUserId: opsUserId });
      const replay = await remove(schedWarehouseId, 'b', key).expect(200);
      expect(replay.body).toEqual(res.body);
      await expectAuditRow({ tenantId, key, action: 'count_policy.removed', targetType: 'warehouse', targetId: schedWarehouseId, actorUserId: opsUserId });
      const absent = await remove(schedWarehouseId, 'b').expect(404);
      expect(absent.body.code).toBe('not-found');
      const reuse = await remove(schedWarehouseId, 'a', key).expect(422);
      expect(reuse.body.code).toBe('idempotency-key-reuse');
      const event = (await sql`
        select payload from outbox_messages where tenant_id = ${tenantId} and type = 'count.policy_updated'
          and payload->>'removedAbcClass' = 'b'`) as unknown as { payload: Record<string, unknown> }[];
      expect(event).toHaveLength(1);
      expect(event[0]!.payload).toMatchObject({ warehouseId: schedWarehouseId, policyCount: 1, removedAbcClass: 'b' });
    });

    it('a same-key DELETE parked on the warehouse advisory replays the winner under the lock — both 200 identical, one key, one audit row', async () => {
      await put(schedWarehouseId, { policies: [{ abcClass: 'c', intervalDays: 90 }] }).expect(200);
      const key = ulid();
      const holder = handle();
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`
            select pg_backend_pid() as pid, pg_advisory_xact_lock(hashtextextended(${tenantId} || ':' || ${schedWarehouseId}, 0))`) as unknown as {
            pid: number;
          }[];
          first = (async () => remove(schedWarehouseId, 'c', key))();
          second = (async () => remove(schedWarehouseId, 'c', key))();
          await waitParked(locked[0]!.pid, 2);
        });
        const [a, b] = await Promise.all([first!, second!]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(a.body).toEqual(b.body);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
      const keys = (await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { n: number }[];
      expect(Number(keys[0]!.n)).toBe(1);
      expect(await auditCount(key, 'count_policy.removed')).toBe(1);
    });

    it('the scheduler stops minting a removed class — and mints it again once the class is set back (the control)', async () => {
      // WS holds only class-b stock (S-01, MIDB 4); class b is removed above.
      expect(await movements.generateScheduledCountTasks(tenantId, schedWarehouseId, 10)).toEqual([]);
      await put(schedWarehouseId, { policies: [{ abcClass: 'b', intervalDays: 7 }] }).expect(200);
      expect(await movements.generateScheduledCountTasks(tenantId, schedWarehouseId, 10)).toHaveLength(1);
    });

    it('refusals: an unknown class 400, an unknown warehouse 404, the operator 403, a missing key 400', async () => {
      expect((await remove(schedWarehouseId, 'z').expect(400)).body.code).toBe('validation-failed');
      expect((await remove(uuidv7(), 'a').expect(404)).body.code).toBe('not-found');
      expect((await policies(uuidv7()).expect(404)).body.code).toBe('not-found');
      const operatorWeb = operatorWebToken;
      expect((await remove(schedWarehouseId, 'a', ulid(), operatorWeb).expect(403)).body.code).toBe('role-denied');
      // Any staff role reads the schedule.
      expect((await policies(schedWarehouseId, operatorWeb).expect(200)).body.policies).toHaveLength(2);
      await auth(http().delete(`${API}/${tenantId}/movements/warehouses/${schedWarehouseId}/count-policies/a`)).expect(400);
    });
  });

  // ── the contract ───────────────────────────────────────────────────────────

  it('OpenAPI: the new routes are published, the list takes no clientId (exempt), the submit variances are always empty', () => {
    const doc = JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
      components: { schemas: Record<string, { properties?: Record<string, { maxItems?: number }> }> };
    };
    expect(Object.keys(doc.paths['/tenants/{tenantId}/movements/counts']!).sort()).toEqual(['get', 'post']);
    expect(Object.keys(doc.paths['/tenants/{tenantId}/movements/counts/{taskId}']!)).toEqual(['get']);
    expect(Object.keys(doc.paths['/tenants/{tenantId}/movements/warehouses/{warehouseId}/count-policies']!).sort()).toEqual(['get', 'put']);
    expect(Object.keys(doc.paths['/tenants/{tenantId}/movements/warehouses/{warehouseId}/count-policies/{abcClass}']!)).toEqual(['delete']);
    const listParams = doc.paths['/tenants/{tenantId}/movements/counts']!.get!.parameters!.map((p) => p.name);
    expect(listParams).not.toContain('clientId');
    expect(doc.components.schemas.SubmitCountResponse!.properties!.variances!.maxItems).toBe(0);
    expect(Object.keys(doc.components.schemas.CatalogCountTaskLineDto!.properties!).sort()).toEqual(['skuCode', 'skuId', 'skuName']);
  });
});
