import type { INestApplication } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { LedgerService } from '../src/modules/inventory/ledger.service';
import { getLedgerEventType, registeredLedgerEventTypes } from '../src/modules/inventory/ledger-registry';
import type { LedgerReferenceDoc } from '../src/modules/inventory/ledger-registry';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { StockTakeCommand } from '../src/modules/movements/stock-take.command';
import { CountService } from '../src/modules/movements/count.command';
import { MovementsFacade } from '../src/modules/movements/transfer.facade';
import { binCandidatesInTx } from '../src/modules/putaway/putaway.command';
import { ProblemException } from '../src/shared/problem-details/problem.exception';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 3-5b — stock take with freeze. A take freezes every storage bin of a
// warehouse or of named zones (the ledger append refuses every web or system
// movement into or out of them with 409 bin-frozen, admits a handheld op and a
// quarantine), counts every bin blind on the handheld, and is closed by one
// post that applies the variances under the approval rule and lifts the
// freeze. Every row of the spec's I/O matrix is driven here over real HTTP;
// the freeze matrix also drives EVERY registered ledger event type through
// the append itself.
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
const SRC = join(__dirname, '..', 'src');

jest.setTimeout(180_000);

/** Keys no device-reachable body may carry (the 3-5a walk). */
const LEAK_KEYS = /^(expected|expectedQuantity|counted|delta|deltaMilli|varianceCount|varianceId|varianceIds|threshold.*)$/;

function assertBlind(body: unknown, path = '$'): void {
  if (Array.isArray(body)) {
    body.forEach((item, index) => assertBlind(item, `${path}[${index}]`));
    return;
  }
  if (body === null || typeof body !== 'object') return;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    expect({ path: `${path}.${key}`, leak: LEAK_KEYS.test(key) }).toEqual({ path: `${path}.${key}`, leak: false });
    assertBlind(value, `${path}.${key}`);
  }
}

describe('stock take with freeze (e2e, story 3-5b)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorWebToken: string;
  let deviceToken: string;
  let managerDeviceToken: string; // a handheld the ops manager badged in (applies adjustments; an operator's pend)

  let warehouseId: string;
  let otherWarehouseId: string;
  const zone = new Map<string, string>();
  const bin = new Map<string, string>();
  const sku = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const auth = (req: SupertestTest, token = opsToken) => req.set('Authorization', `Bearer ${token}`);
  const b = (code: string): string => bin.get(code)!;
  const s = (code: string): string => sku.get(code)!;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('stock_take');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Stock Take Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;

    const member = async (role: 'ops_manager' | 'operator'): Promise<{ id: string; email: string; token: string }> => {
      const memberEmail = `${role}-${ulid().toLowerCase()}@example.com`;
      const invited = await auth(http().post(`${API}/${tenantId}/users`), ownerToken).set(KEY_HEADER, ulid()).send({ email: memberEmail, role }).expect(201);
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
    operatorWebToken = operator.token;

    const minted = await auth(http().post(`${API}/${tenantId}/devices/enrollment-codes`), ownerToken).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'stock-take scanner', pin: '2468' })
      .expect(201);
    deviceToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: operator.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;
    const minted2 = await auth(http().post(`${API}/${tenantId}/devices/enrollment-codes`), ownerToken).set(KEY_HEADER, ulid()).expect(201);
    const enrolled2 = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted2.body.code, label: 'stock-take manager scanner', pin: '1357' })
      .expect(201);
    managerDeviceToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled2.body.deviceToken as string}`)
        .send({ operatorEmail: ops.email, pin: '1357' })
        .expect(200)
    ).body.accessToken as string;

    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode,abc_class',
      'ST-PLAIN,Plain,pcs,,1800,,false,false,false,,,,a',
      'ST-OTHER,Other,pcs,,1800,,false,false,false,,,,',
      'ST-BATCH,Batch tracked,pcs,,1800,,true,false,false,,,,',
    ].join('\n');
    const imported = await auth(http().post(`${API}/${tenantId}/catalog/imports`), ownerToken)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' });
    expect(imported.status).toBe(201);
    for (const row of (await sql`select id, code from skus where tenant_id = ${tenantId}`) as unknown as { id: string; code: string }[]) {
      sku.set(row.code, row.id);
    }

    const mkWarehouse = async (name: string): Promise<string> =>
      (
        await auth(http().post(`${API}/${tenantId}/warehouses`), ownerToken)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code: `ST-${ulid().slice(10, 16).toUpperCase()}`, name })
          .expect(201)
      ).body.id as string;
    warehouseId = await mkWarehouse('Stock Take WH');
    otherWarehouseId = await mkWarehouse('Stock Take Other WH');
    const layout: Record<string, string[]> = { A: ['A-01', 'A-02', 'A-03', 'A-04'], B: ['B-01', 'B-02'], C: ['C-01'], D: ['D-01'], E: [] };
    for (const [zoneCode, codes] of Object.entries(layout)) {
      const zoneId = (
        await auth(http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`), ownerToken).set(KEY_HEADER, ulid()).send({ code: zoneCode, name: `Zone ${zoneCode}` }).expect(201)
      ).body.id as string;
      zone.set(zoneCode, zoneId);
      for (const code of codes) {
        const id = (
          await auth(http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`), ownerToken)
            .set(KEY_HEADER, ulid())
            .send({ capacity: 1000, type: 'shelf', code })
            .expect(201)
        ).body.id as string;
        bin.set(code, id);
      }
    }
    const otherZone = (
      await auth(http().post(`${API}/${tenantId}/warehouses/${otherWarehouseId}/zones`), ownerToken).set(KEY_HEADER, ulid()).send({ code: 'O', name: 'Zone O' }).expect(201)
    ).body.id as string;
    bin.set(
      'O-01',
      (await auth(http().post(`${API}/${tenantId}/warehouses/${otherWarehouseId}/zones/${otherZone}/bins`), ownerToken).set(KEY_HEADER, ulid()).send({ capacity: 1000, type: 'shelf', code: 'O-01' }).expect(201))
        .body.id as string,
    );

    await webAdjust('A-01', 'ST-PLAIN', 10);
    await webAdjust('A-02', 'ST-PLAIN', 5);
    await webAdjust('A-02', 'ST-OTHER', 3);
    await webAdjust('A-03', 'ST-OTHER', 4);
    await webAdjust('B-01', 'ST-PLAIN', 2);
    await webAdjust('C-01', 'ST-PLAIN', 6);
    await webAdjust('D-01', 'ST-PLAIN', 20);

    // The variance threshold: |delta| > 3 is owner-only.
    await auth(http().put(`${API}/${tenantId}/movements/variance-policies`), ownerToken).set(KEY_HEADER, ulid()).send({ quantityThreshold: 3 }).expect(200);
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

  // ── helpers ────────────────────────────────────────────────────────────

  function webAdjust(binCode: string, skuCode: string, quantityDelta: number, extra: Record<string, unknown> = {}, wh = warehouseId): Promise<request.Response> {
    return auth(http().post(`${API}/${tenantId}/inventory/adjustments`))
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, skuId: s(skuCode), binId: b(binCode), quantityDelta, reasonCode: 'stock-count', note: 'stock-take seed', ...extra })
      .then((res) => res);
  }

  function deviceAdjust(binCode: string, skuCode: string, quantityDelta: number): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${managerDeviceToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId: s(skuCode),
        binId: b(binCode),
        quantityDelta,
        reasonCode: 'found',
        note: 'found on the shelf',
        batch: null,
        serials: null,
        occurredAt: new Date(Date.now() - 1_000).toISOString(),
      });
  }

  function webMove(from: string, to: string, qty: number): SupertestTest {
    return auth(http().post(`${API}/${tenantId}/warehouses/${warehouseId}/inventory/moves`))
      .set(KEY_HEADER, ulid())
      .send({ skuId: s('ST-PLAIN'), fromBinId: b(from), toBinId: b(to), qty, reasonCode: 'consolidate' });
  }

  function start(body: Record<string, unknown>, key = ulid(), token = opsToken): SupertestTest {
    return auth(http().post(`${API}/${tenantId}/movements/warehouses/${warehouseId}/stock-takes`), token).set(KEY_HEADER, key).send(body);
  }

  function takeVerb(id: string, verb: 'recount' | 'close' | 'abandon', body: Record<string, unknown>, key = ulid(), token = opsToken): SupertestTest {
    return auth(http().post(`${API}/${tenantId}/movements/stock-takes/${id}/${verb}`), token).set(KEY_HEADER, key).send(body);
  }

  function detail(id: string, token = opsToken): SupertestTest {
    return auth(http().get(`${API}/${tenantId}/movements/stock-takes/${id}`), token);
  }

  function snapshot(): SupertestTest {
    return auth(http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`), deviceToken);
  }

  function submit(taskId: string, lines: { skuId: string; countedQuantity: number }[], key = ulid()): SupertestTest {
    return auth(http().post(`${API}/${tenantId}/movements/counts/${taskId}/submit`), deviceToken).set(KEY_HEADER, key).send({ lines });
  }

  async function pendingTaskOf(binCode: string): Promise<{ id: string; stockTakeId: string | null; origin: string }> {
    const rows = (await sql`
      select id, stock_take_id as "stockTakeId", origin from count_tasks
       where tenant_id = ${tenantId} and bin_id = ${b(binCode)} and status = 'pending'`) as unknown as { id: string; stockTakeId: string | null; origin: string }[];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function count(query: postgres.PendingQuery<postgres.Row[]>): Promise<number> {
    const rows = (await query) as unknown as { n: number }[];
    return Number(rows[0]!.n);
  }

  async function onHand(binCode: string, skuCode: string): Promise<number> {
    const rows = (await sql`select quantity from stock_on_hand where tenant_id = ${tenantId} and bin_id = ${b(binCode)} and sku_id = ${s(skuCode)}`) as unknown as { quantity: string }[];
    return rows.length === 0 ? 0 : Number(rows[0]!.quantity) / 1000;
  }

  async function ledgerCount(): Promise<number> {
    return count(sql`select count(*)::int as n from ledger_events where tenant_id = ${tenantId}`);
  }

  function handle(): postgres.Sql {
    return postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
  }

  async function waitParked(holderPid: number, min: number): Promise<void> {
    const probe = handle();
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type in ('Lock', 'Advisory') and a.state = 'active'`) as unknown as { pid: number; blockers: number[] }[];
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

  // The take every arm below shares: zones A and B.
  let takeId: string;
  let startKey: string;
  let oldVarianceId: string;

  // ── start ──────────────────────────────────────────────────────────────

  describe('start', () => {
    it('refuses a malformed scope: no zones (400), an unknown zone (404), an empty zone (422 stock-take-empty)', async () => {
      expect((await start({ zoneIds: [] }).expect(400)).body.code).toBe('validation-failed');
      expect((await start({ zoneIds: [zone.get('A'), zone.get('A')] }).expect(400)).body.code).toBe('validation-failed');
      expect((await start({ zoneIds: [uuidv7()] }).expect(404)).body.code).toBe('not-found');
      expect((await start({ zoneIds: [zone.get('E')] }).expect(422)).body.code).toBe('stock-take-empty');
      // An operator lacks counts.manage.
      expect((await start({ zoneIds: [zone.get('A')] }, ulid(), operatorWebToken).expect(403)).body.code).toBe('role-denied');
    });

    it('zones A and B: adopts the pending cycle task, creates one task per other bin (empty bins too), freezes every bin and supersedes the older open variance', async () => {
      // A pending cycle task on A-03, and an open variance on B-01.
      const cycle = await auth(http().post(`${API}/${tenantId}/movements/counts`)).set(KEY_HEADER, ulid()).send({ warehouseId, binId: b('A-03') }).expect(201);
      const b01 = await auth(http().post(`${API}/${tenantId}/movements/counts`)).set(KEY_HEADER, ulid()).send({ warehouseId, binId: b('B-01') }).expect(201);
      await submit(b01.body.countTask.id as string, [{ skuId: s('ST-PLAIN'), countedQuantity: 1 }]).expect(200);
      oldVarianceId = ((await sql`select id from count_variances where tenant_id = ${tenantId} and bin_id = ${b('B-01')} and status = 'open'`) as unknown as { id: string }[])[0]!.id;

      startKey = ulid();
      const res = await start({ zoneIds: [zone.get('B'), zone.get('A')], note: '  Year-end take  ' }, startKey).expect(201);
      takeId = res.body.stockTake.id as string;
      expect(res.body).toMatchObject({
        adoptedTaskCount: 1,
        createdTaskCount: 5,
        supersededVarianceCount: 1,
        stockTake: { status: 'counting', binCount: 6, note: 'Year-end take', zoneIds: [zone.get('A'), zone.get('B')].sort() },
      });
      // The adopted task is now the take's; every in-scope bin has exactly one pending take task.
      expect((await pendingTaskOf('A-03')).id).toBe(cycle.body.countTask.id);
      for (const code of ['A-01', 'A-02', 'A-03', 'A-04', 'B-01', 'B-02']) {
        expect((await pendingTaskOf(code)).stockTakeId).toBe(takeId);
      }
      // Empty bins have no lines.
      expect(await count(sql`select count(*)::int as n from count_task_lines where task_id = ${(await pendingTaskOf('A-04')).id}`)).toBe(0);
      // The freeze: one row per bin, the take's start as frozen_at.
      const frozen = (await sql`select bin_code, frozen_at from stock_freeze_bins where tenant_id = ${tenantId} and stock_take_id = ${takeId} order by bin_code`) as unknown as { bin_code: string; frozen_at: Date }[];
      expect(frozen.map((row) => row.bin_code)).toEqual(['A-01', 'A-02', 'A-03', 'A-04', 'B-01', 'B-02']);
      // The older variance is recounted against the take's task, basis rewritten to its line (2).
      const old = ((await sql`select status, recount_task_id, expected_quantity_milli, delta_milli from count_variances where id = ${oldVarianceId}`) as unknown as {
        status: string;
        recount_task_id: string;
        expected_quantity_milli: string;
        delta_milli: string;
      }[])[0]!;
      expect({ ...old, expected_quantity_milli: Number(old.expected_quantity_milli), delta_milli: Number(old.delta_milli) }).toEqual({
        status: 'recounted',
        recount_task_id: (await pendingTaskOf('B-01')).id,
        expected_quantity_milli: 2000,
        delta_milli: -1000,
      });
      // The created tasks are never pushed (bulk: true, stockTakeId).
      const created = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'count.created' and payload->>'stockTakeId' = ${takeId}`) as unknown as { payload: Record<string, unknown> }[];
      expect(created).toHaveLength(5);
      expect(created.every((row) => row.payload.bulk === true && row.payload.origin === 'on_demand')).toBe(true);
      await expectAuditRow({
        tenantId,
        key: startKey,
        action: 'stock_take.started',
        targetType: 'stock_take',
        targetId: takeId,
        actorUserId: opsUserId,
        alongside: [{ action: 'count.variance.resolved', targetType: 'count_variance', targetId: oldVarianceId, actorUserId: opsUserId }],
      });
      // A same-key replay re-serves the snapshot and writes nothing.
      const replay = await start({ zoneIds: [zone.get('A'), zone.get('B')], note: 'Year-end take' }, startKey).expect(201);
      expect(replay.body).toEqual(res.body);
      await expectAuditRow({
        tenantId,
        key: startKey,
        action: 'stock_take.started',
        targetType: 'stock_take',
        targetId: takeId,
        actorUserId: opsUserId,
        alongside: [{ action: 'count.variance.resolved', targetType: 'count_variance', targetId: oldVarianceId, actorUserId: opsUserId }],
      });
    });

    it('the start fingerprint is golden: {tenantId, arm, warehouseId, zoneIds sorted, note trimmed}', async () => {
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${startKey}`) as unknown as { payload_hash: string }[];
      expect(stored[0]!.payload_hash).toBe(
        hashCommandPayload({
          tenantId,
          arm: 'stock-take.start',
          warehouseId,
          zoneIds: [zone.get('A')!, zone.get('B')!].sort(),
          note: 'Year-end take',
        }),
      );
    });

    it('overlap: a second take sharing a bin is 409 stock-take-overlap naming the active take; a whole-warehouse take too', async () => {
      const zoneTake = await start({ zoneIds: [zone.get('A')] }).expect(409);
      expect(zoneTake.body).toMatchObject({ code: 'stock-take-overlap', activeStockTakeId: takeId });
      expect(zoneTake.body.detail).toContain('A-01');
      expect((await start({}).expect(409)).body.code).toBe('stock-take-overlap');
    });
  });

  // ── the freeze ─────────────────────────────────────────────────────────

  describe('the freeze', () => {
    it('a web adjustment into or out of a frozen bin is 409 bin-frozen naming the bin, the take and its start (IST); nothing is written', async () => {
      const before = await ledgerCount();
      const res = await webAdjust('A-01', 'ST-PLAIN', 1);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'bin-frozen', binCode: 'A-01', stockTakeId: takeId });
      expect(res.body.detail).toMatch(/Bin "A-01" is frozen for stock take .* \(started \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} IST\)/);
      expect((await webAdjust('A-01', 'ST-PLAIN', -1)).status).toBe(409);
      expect(await ledgerCount()).toBe(before);
      expect(await onHand('A-01', 'ST-PLAIN')).toBe(10);
    });

    it('a web adjustment backdated before the freeze is still refused (web commands are never admitted)', async () => {
      const res = await webAdjust('A-02', 'ST-PLAIN', 1, { occurredAt: new Date(Date.now() - 86_400_000).toISOString() });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('bin-frozen');
    });

    it('a web move out of or into a frozen bin is 409 bin-frozen; a move between unfrozen bins is booked', async () => {
      expect((await webMove('A-01', 'D-01', 1).expect(409)).body.code).toBe('bin-frozen');
      expect((await webMove('D-01', 'A-01', 1).expect(409)).body.code).toBe('bin-frozen');
      expect(await onHand('A-01', 'ST-PLAIN')).toBe(10);
      expect(await onHand('D-01', 'ST-PLAIN')).toBe(20);
    });

    it('a transfer outbound from a frozen bin is 409 bin-frozen, the order stays draft', async () => {
      const created = await auth(http().post(`${API}/${tenantId}/movements/transfers`))
        .set(KEY_HEADER, ulid())
        .send({ sourceWarehouseId: warehouseId, destWarehouseId: otherWarehouseId, lines: [{ skuId: s('ST-PLAIN'), quantity: 1, fromBinId: b('A-01'), toBinId: b('O-01') }] })
        .expect(201);
      const transferId = created.body.transfer.id as string;
      const res = await auth(http().post(`${API}/${tenantId}/movements/transfers/${transferId}/outbound-confirm`)).set(KEY_HEADER, ulid()).send({});
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'bin-frozen' });
      expect(((await sql`select status from transfer_orders where id = ${transferId}`) as unknown as { status: string }[])[0]!.status).toBe('draft');
    });

    it('every registered ledger event type touching a frozen bin is refused bin-frozen inside the append — except qc.held; a device movement is admitted', async () => {
      const ledger = app.get(LedgerService);
      const db = app.get<Database>(DATABASE);
      const outcomes: Record<string, string> = {};
      for (const type of registeredLedgerEventTypes()) {
        const definition = getLedgerEventType(type)!;
        for (const surface of [undefined, 'device'] as const) {
          for (const arm of ['to', 'from'] as const) {
            let outcome = 'appended';
            try {
              await withTenantTransaction(db, tenantId, async (tx) => {
                await ledger.appendMovement(tx, {
                  tenantId,
                  warehouseId,
                  type,
                  skuId: s('ST-PLAIN'),
                  quantityDelta: (arm === 'to' ? 1000 : -1000) as never,
                  fromBinId: arm === 'from' ? b('A-01') : null,
                  toBinId: arm === 'to' ? b('A-01') : null,
                  batchRef: null,
                  serialRef: null,
                  actorUserId: opsUserId,
                  occurredAt: new Date().toISOString(),
                  recordedAt: new Date().toISOString(),
                  referenceDoc: { kind: definition.referenceKinds[0] } as unknown as LedgerReferenceDoc,
                  ...(surface === undefined ? {} : { surface }),
                });
                throw new Error('rollback');
              });
            } catch (err) {
              outcome = err instanceof ProblemException ? ((err.getResponse() as { code: string }).code) : (err as Error).message === 'rollback' ? 'appended' : 'other-error';
            }
            outcomes[`${type}:${surface ?? 'web'}:${arm}`] = outcome;
          }
        }
      }
      for (const type of registeredLedgerEventTypes()) {
        for (const arm of ['to', 'from']) {
          expect({ key: `${type}:web:${arm}`, outcome: outcomes[`${type}:web:${arm}`] }).toEqual({
            key: `${type}:web:${arm}`,
            outcome: type === 'qc.held' ? 'appended' : 'bin-frozen',
          });
          expect({ key: `${type}:device:${arm}`, frozen: outcomes[`${type}:device:${arm}`] === 'bin-frozen' }).toEqual({ key: `${type}:device:${arm}`, frozen: false });
        }
      }
      // The families the spec names are all registered (the matrix covers them).
      for (const type of ['putaway.placed', 'pick.picked', 'stock.moved', 'stock.adjusted', 'transfer.outbound', 'transfer.inbound', 'qc.released', 'qc.held']) {
        expect(registeredLedgerEventTypes()).toContain(type);
      }
      // Nothing survived the rolled-back appends.
      expect(await onHand('A-01', 'ST-PLAIN')).toBe(10);
    });

    it('the bin-frozen refusal of stock movements is thrown only in the append (the other readers of the freeze only consult it)', () => {
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) walk(path);
          else if (path.endsWith('.ts') && readFileSync(path, 'utf8').includes("'bin-frozen'")) offenders.push(path.slice(SRC.length + 1));
        }
      };
      walk(SRC);
      expect(offenders).toEqual(['modules/inventory/ledger.service.ts']);
    });

    it('a handheld adjustment on a frozen bin is admitted and counted on the freeze row (device_writes)', async () => {
      await deviceAdjust('A-02', 'ST-OTHER', 1).expect(201);
      expect(await onHand('A-02', 'ST-OTHER')).toBe(4);
      const rows = (await sql`select device_writes from stock_freeze_bins where tenant_id = ${tenantId} and bin_id = ${b('A-02')}`) as unknown as { device_writes: number }[];
      expect(rows[0]!.device_writes).toBe(1);
      expect((await detail(takeId).expect(200)).body.totals.deviceWrites).toBe(1);
    });

    it('a frozen bin cannot retire (409 bin-frozen)', async () => {
      const res = await auth(http().post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${b('B-02')}/retire`), ownerToken).set(KEY_HEADER, ulid()).send({});
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'bin-frozen' });
    });

    it('a cycle create on a frozen bin is 409 bin-in-stock-take; a bulk create skips it with reason stock-take', async () => {
      const single = await auth(http().post(`${API}/${tenantId}/movements/counts`)).set(KEY_HEADER, ulid()).send({ warehouseId, binId: b('A-01') }).expect(409);
      expect(single.body).toMatchObject({ code: 'bin-in-stock-take', stockTakeId: takeId });
      const bulk = await auth(http().post(`${API}/${tenantId}/movements/counts`)).set(KEY_HEADER, ulid()).send({ warehouseId, binIds: [b('A-01'), b('D-01')] }).expect(201);
      expect(bulk.body.skipped).toEqual([{ binId: b('A-01'), binCode: 'A-01', reason: 'stock-take' }]);
      expect(bulk.body.created.map((entry: { binCode: string }) => entry.binCode)).toEqual(['D-01']);
    });
  });

  // ── the handheld ───────────────────────────────────────────────────────

  describe('the handheld', () => {
    it('the snapshot: take tasks carry stockTakeId (and nothing else new), frozen bins say so, the active take is listed — still blind', async () => {
      const res = await snapshot().expect(200);
      const cards = res.body.countTasks as { taskId: string; binCode: string; stockTakeId: string | null }[];
      const take = cards.filter((card) => card.stockTakeId === takeId);
      expect(take.map((card) => card.binCode)).toEqual(['A-01', 'A-02', 'A-03', 'A-04', 'B-01', 'B-02']);
      expect(Object.keys(take[0]!).sort()).toEqual(['binCode', 'binId', 'binStateEpoch', 'createdAt', 'lines', 'origin', 'stockTakeId', 'taskId', 'warehouseId']);
      expect(cards.find((card) => card.binCode === 'D-01')!.stockTakeId).toBeNull();
      assertBlind(res.body.countTasks);
      assertBlind(res.body.stockTakes);
      const frozen = (res.body.bins as { code: string; frozen: boolean }[]).filter((entry) => entry.frozen).map((entry) => entry.code).sort();
      expect(frozen).toEqual(['A-01', 'A-02', 'A-03', 'A-04', 'B-01', 'B-02']);
      expect(res.body.stockTakes).toEqual([
        { stockTakeId: takeId, zoneIds: [zone.get('A'), zone.get('B')].sort(), frozenAt: expect.any(String), pendingTasks: 6 },
      ]);
    });

    it('an epoch conflict inside the take: the auto-recount carries the take id and bulk, and the variances just written are recounted against it', async () => {
      const task = await pendingTaskOf('A-01');
      // A handheld op admitted after the task started moves the epoch.
      await deviceAdjust('A-01', 'ST-PLAIN', 1).expect(201);
      const key = ulid();
      const res = await submit(task.id, [{ skuId: s('ST-PLAIN'), countedQuantity: 9 }], key).expect(200);
      expect(res.body.countTask.epochConflict).toBe(true);
      const recount = await pendingTaskOf('A-01');
      expect(recount).toMatchObject({ id: res.body.recountTaskId, stockTakeId: takeId, origin: 'recount' });
      const created = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'count.created' and payload->>'taskId' = ${recount.id}`) as unknown as { payload: Record<string, unknown> }[];
      expect(created[0]!.payload).toMatchObject({ origin: 'recount', stockTakeId: takeId, bulk: true });
      const variance = ((await sql`select id, status, recount_task_id, expected_quantity_milli, delta_milli from count_variances where task_id = ${task.id}`) as unknown as {
        id: string;
        status: string;
        recount_task_id: string;
        expected_quantity_milli: string;
        delta_milli: string;
      }[])[0]!;
      expect({ status: variance.status, recount: variance.recount_task_id, expected: Number(variance.expected_quantity_milli), delta: Number(variance.delta_milli) }).toEqual({
        status: 'recounted',
        recount: recount.id,
        expected: 11_000,
        delta: -2000,
      });
      const resolved = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'count.variance.resolved' and payload->>'varianceId' = ${variance.id}`) as unknown as { payload: Record<string, unknown> }[];
      expect(resolved[0]!.payload).toMatchObject({ status: 'recounted', decision: 'recount', overThreshold: false, expectedQuantity: 11, delta: -2, recountTaskId: recount.id });
    });

    it('a found batch-tracked SKU inside a take is recorded (a cycle count would refuse it); a found kit is still refused', async () => {
      const task = await pendingTaskOf('A-04');
      await submit(task.id, [{ skuId: s('ST-BATCH'), countedQuantity: 2 }]).expect(200);
      const rows = (await sql`select status, delta_milli from count_variances where task_id = ${task.id}`) as unknown as { status: string; delta_milli: string }[];
      expect(rows.map((row) => ({ status: row.status, delta: Number(row.delta_milli) }))).toEqual([{ status: 'open', delta: 2000 }]);
    });

    it('counts the rest of the take; a single resolve of a take variance is 409 variance-in-stock-take', async () => {
      await submit((await pendingTaskOf('A-01')).id, [{ skuId: s('ST-PLAIN'), countedQuantity: 11 }]).expect(200);
      // A-02 — its handheld adjustment (above) landed after its task started,
      // so the first submit conflicts and re-plans; the recount's basis is
      // OTHER 4. Counted 8 → +4 (over the threshold 3).
      const conflicted = await submit((await pendingTaskOf('A-02')).id, [
        { skuId: s('ST-PLAIN'), countedQuantity: 5 },
        { skuId: s('ST-OTHER'), countedQuantity: 8 },
      ]).expect(200);
      expect(conflicted.body.countTask.epochConflict).toBe(true);
      await submit((await pendingTaskOf('A-02')).id, [
        { skuId: s('ST-PLAIN'), countedQuantity: 5 },
        { skuId: s('ST-OTHER'), countedQuantity: 8 },
      ]).expect(200);
      // A-03 — the adopted task (its expectation, OTHER 4, frozen before the take).
      await submit((await pendingTaskOf('A-03')).id, [{ skuId: s('ST-OTHER'), countedQuantity: 4 }]).expect(200);
      await submit((await pendingTaskOf('B-01')).id, [{ skuId: s('ST-PLAIN'), countedQuantity: 2 }]).expect(200);
      const over = ((await sql`select id from count_variances where tenant_id = ${tenantId} and bin_id = ${b('A-02')} and status = 'open'`) as unknown as { id: string }[])[0]!.id;
      const res = await auth(http().post(`${API}/${tenantId}/movements/variances/${over}/resolve`), ownerToken).set(KEY_HEADER, ulid()).send({ decision: 'recount' }).expect(409);
      expect(res.body).toMatchObject({ code: 'variance-in-stock-take', stockTakeId: takeId });
    });
  });

  // ── close ──────────────────────────────────────────────────────────────

  describe('recount and close', () => {
    it('pending tasks → 409 stock-take-incomplete', async () => {
      const digest = (await detail(takeId).expect(200)).body.openVarianceDigest as string;
      const res = await takeVerb(takeId, 'close', { openVarianceDigest: digest }, ulid(), ownerToken).expect(409);
      expect(res.body).toMatchObject({ code: 'stock-take-incomplete', pendingTasks: 1 });
      await submit((await pendingTaskOf('B-02')).id, []).expect(200);
    });

    it('the variance table is gated (operator 403) and shows the owner flag and the lot-count label', async () => {
      await auth(http().get(`${API}/${tenantId}/movements/stock-takes/${takeId}/variances`), operatorWebToken).expect(403);
      const res = await auth(http().get(`${API}/${tenantId}/movements/stock-takes/${takeId}/variances?status=open`)).expect(200);
      expect(res.body.items.map((row: Record<string, unknown>) => ({ bin: row.binCode, sku: row.skuCode, delta: row.delta, over: row.overThreshold, lot: row.needsLotCount, latest: row.latest }))).toEqual([
        { bin: 'A-02', sku: 'ST-OTHER', delta: 4, over: true, lot: false, latest: true },
        { bin: 'A-04', sku: 'ST-BATCH', delta: 2, over: false, lot: true, latest: true },
      ]);
    });

    it('over-threshold variances need the owner: a manager is 403 variance-owner-required naming them', async () => {
      const digest = (await detail(takeId).expect(200)).body.openVarianceDigest as string;
      const res = await takeVerb(takeId, 'close', { openVarianceDigest: digest }).expect(403);
      expect(res.body.code).toBe('variance-owner-required');
      expect(res.body.total).toBe(1);
    });

    it('a digest that is not the reviewed one is 409 stock-take-changed', async () => {
      const res = await takeVerb(takeId, 'close', { openVarianceDigest: '0'.repeat(64) }, ulid(), ownerToken).expect(409);
      expect(res.body.code).toBe('stock-take-changed');
      expect((await takeVerb(takeId, 'close', { openVarianceDigest: 'nope' }, ulid(), ownerToken).expect(400)).body.code).toBe('validation-failed');
    });

    it('a bin that moved after its count (a quarantine or a late handheld op) → 409 stock-take-recount-required listing it; a requested recount clears it', async () => {
      await deviceAdjust('B-01', 'ST-PLAIN', 1).expect(201);
      const digest = (await detail(takeId).expect(200)).body.openVarianceDigest as string;
      const dash = (await detail(takeId).expect(200)).body;
      expect(dash.recountRequiredBins).toEqual([{ binId: b('B-01'), binCode: 'B-01' }]);
      const res = await takeVerb(takeId, 'close', { openVarianceDigest: digest }, ulid(), ownerToken).expect(409);
      expect(res.body).toMatchObject({ code: 'stock-take-recount-required', binCodes: ['B-01'], total: 1 });

      // The requested recount (variances.resolve): a stamped recount task per bin.
      await takeVerb(takeId, 'recount', { binIds: [b('B-01')] }, ulid(), operatorWebToken).expect(403);
      expect((await takeVerb(takeId, 'recount', { binIds: [b('D-01')] }).expect(400)).body.code).toBe('validation-failed');
      const key = ulid();
      const recount = await takeVerb(takeId, 'recount', { binIds: [b('B-01')] }, key).expect(200);
      expect(recount.body).toMatchObject({ recounts: [{ binId: b('B-01'), binCode: 'B-01' }], recountedVarianceCount: 0 });
      expect((await pendingTaskOf('B-01')).stockTakeId).toBe(takeId);
      await expectAuditRow({ tenantId, key, action: 'stock_take.recount_requested', targetType: 'stock_take', targetId: takeId, actorUserId: opsUserId });
      const replay = await takeVerb(takeId, 'recount', { binIds: [b('B-01')] }, key).expect(200);
      expect(replay.body).toEqual(recount.body);
      // A pending task on the bin → 409 count-task-open.
      expect((await takeVerb(takeId, 'recount', { binIds: [b('B-01')] }).expect(409)).body.code).toBe('count-task-open');
      await submit((await pendingTaskOf('B-01')).id, [{ skuId: s('ST-PLAIN'), countedQuantity: 3 }]).expect(200);
      expect((await detail(takeId).expect(200)).body.recountRequiredBins).toEqual([]);
    });

    it('a requested recount of a bin with an open variance marks it recounted (and the digest changes)', async () => {
      const before = (await detail(takeId).expect(200)).body.openVarianceDigest as string;
      // Recount A-04 (the found batch SKU), then count it the same again.
      const res = await takeVerb(takeId, 'recount', { binIds: [b('A-04')] }).expect(200);
      expect(res.body.recountedVarianceCount).toBe(1);
      await submit((await pendingTaskOf('A-04')).id, [{ skuId: s('ST-BATCH'), countedQuantity: 2 }]).expect(200);
      expect((await detail(takeId).expect(200)).body.openVarianceDigest).not.toBe(before);
    });

    let closeKey: string;
    let closeBody: Record<string, unknown>;
    let closeDigest: string;

    it('the owner posts and closes: the over-threshold variance is adjusted in the ledger, the tracked one stays open (unposted), the freeze is gone', async () => {
      const dash = (await detail(takeId).expect(200)).body;
      expect(dash.totals).toMatchObject({ bins: 6, counted: 6, pending: 0, openVariances: 2, overThreshold: 1 });
      closeKey = ulid();
      closeDigest = dash.openVarianceDigest as string;
      const res = await takeVerb(takeId, 'close', { openVarianceDigest: closeDigest }, closeKey, ownerToken).expect(200);
      closeBody = res.body as Record<string, unknown>;
      expect(res.body).toMatchObject({
        stockTake: { status: 'closed', postedCount: 1, unpostedCount: 1, approvedBy: ownerUserId, closedBy: ownerUserId },
        postedCount: 1,
        unposted: [{ binCode: 'A-04', skuCode: 'ST-BATCH', needsLotCount: true }],
      });
      expect(await onHand('A-02', 'ST-OTHER')).toBe(8);
      const posted = ((await sql`select id, status, ledger_event_id from count_variances where tenant_id = ${tenantId} and bin_id = ${b('A-02')} and status = 'adjusted'`) as unknown as {
        id: string;
        ledger_event_id: string;
      }[])[0]!;
      const event = ((await sql`select type, reference_doc from ledger_events where id = ${posted.ledger_event_id}`) as unknown as { type: string; reference_doc: Record<string, unknown> }[])[0]!;
      expect(event).toMatchObject({ type: 'stock.adjusted', reference_doc: { reasonCode: 'stock-count', countVarianceId: posted.id } });
      expect(await count(sql`select count(*)::int as n from stock_freeze_bins where tenant_id = ${tenantId} and stock_take_id = ${takeId}`)).toBe(0);
      // The 9-2 panel's resolve carries overThreshold.
      const resolved = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'count.variance.resolved' and payload->>'varianceId' = ${posted.id}`) as unknown as { payload: Record<string, unknown> }[];
      expect(resolved[0]!.payload).toMatchObject({ status: 'adjusted', overThreshold: true });
      await expectAuditRow({
        tenantId,
        key: closeKey,
        action: 'stock_take.closed',
        targetType: 'stock_take',
        targetId: takeId,
        actorUserId: ownerUserId,
        alongside: [{ action: 'count.variance.resolved', targetType: 'count_variance', targetId: posted.id, actorUserId: ownerUserId }],
      });
      // Movement into the bins is booked again.
      expect((await webAdjust('A-01', 'ST-PLAIN', 1)).status).toBe(201);
    });

    it('a same-key replay re-serves the close; a different key is 409 stock-take-not-counting', async () => {
      const replay = await takeVerb(takeId, 'close', { openVarianceDigest: closeDigest }, closeKey, ownerToken).expect(200);
      expect(replay.body).toEqual(closeBody);
      expect((await takeVerb(takeId, 'close', { openVarianceDigest: '0'.repeat(64) }, closeKey, ownerToken).expect(422)).body.code).toBe('idempotency-key-reuse');
      expect((await takeVerb(takeId, 'close', { openVarianceDigest: closeDigest }, ulid(), ownerToken).expect(409)).body.code).toBe('stock-take-not-counting');
      expect((await takeVerb(takeId, 'abandon', {}).expect(409)).body.code).toBe('stock-take-not-counting');
      expect((await takeVerb(takeId, 'recount', { binIds: [b('A-01')] }).expect(409)).body.code).toBe('stock-take-not-counting');
    });

    it('the report: one row per (SKU, bin) of each bin\'s latest count, with the outcome as of the close; a client filter; an unknown client is 404', async () => {
      const res = await auth(http().get(`${API}/${tenantId}/movements/stock-takes/${takeId}/report?format=csv`)).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      const text = (res.body as Buffer).toString('utf8').replace(/^\uFEFF/, '');
      const lines = text.trim().split(/\r?\n/);
      expect(lines[0]).toBe('status,zone_code,bin_code (counted bins only),sku_code,sku_name,client,book_qty,counted_qty,variance_qty,outcome,counted_at_ist');
      const rows = lines.slice(1).map((line) => line.split(','));
      expect(rows.map((row) => [row[0], row[2], row[3], row[6], row[7], row[8], row[9]])).toEqual([
        ['final', 'A-01', 'ST-PLAIN', '11', '11', '0', 'matched'],
        ['final', 'A-02', 'ST-OTHER', '4', '8', '4', 'adjusted'],
        ['final', 'A-02', 'ST-PLAIN', '5', '5', '0', 'matched'],
        ['final', 'A-03', 'ST-OTHER', '4', '4', '0', 'matched'],
        ['final', 'A-04', 'ST-BATCH', '0', '2', '2', expect.stringMatching(/^unposted:/)],
        ['final', 'B-01', 'ST-PLAIN', '3', '3', '0', 'matched'],
      ]);
      const xlsx = await auth(http().get(`${API}/${tenantId}/movements/stock-takes/${takeId}/report?format=xlsx`)).expect(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      await auth(http().get(`${API}/${tenantId}/movements/stock-takes/${takeId}/report?format=csv&clientId=${uuidv7()}`)).expect(404);
      await auth(http().get(`${API}/${tenantId}/movements/stock-takes/${takeId}/report?format=csv`), operatorWebToken).expect(403);
    });
  });

  // ── abandon, cancel, races ─────────────────────────────────────────────

  describe('abandon and cancel', () => {
    let cTakeId: string;

    it('same-key starts parked on a held task row answer identically and make one take (the lock-order race)', async () => {
      const cycle = await auth(http().post(`${API}/${tenantId}/movements/counts`)).set(KEY_HEADER, ulid()).send({ warehouseId, binId: b('C-01') }).expect(201);
      const holder = handle();
      const key = ulid();
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from count_tasks where id = ${cycle.body.countTask.id as string} for update`) as unknown as { pid: number }[];
          first = (async () => start({ zoneIds: [zone.get('C')] }, key))();
          second = (async () => start({ zoneIds: [zone.get('C')] }, key))();
          await waitParked(locked[0]!.pid, 2);
        });
        const [a, c] = await Promise.all([first!, second!]);
        expect([a.status, c.status]).toEqual([201, 201]);
        expect(a.body).toEqual(c.body);
        cTakeId = a.body.stockTake.id as string;
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
      expect(await count(sql`select count(*)::int as n from stock_takes where tenant_id = ${tenantId} and zone_ids ->> 0 = ${zone.get('C')!}`)).toBe(1);
    });

    it('a take task cannot be cancelled (409 stock-take-task); a cycle task can, once (409 count-task-cancelled), and a late submit answers count-task-cancelled', async () => {
      const takeTask = await pendingTaskOf('C-01');
      const refused = await auth(http().post(`${API}/${tenantId}/movements/counts/${takeTask.id}/cancel`)).set(KEY_HEADER, ulid()).send({});
      expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 409, code: 'stock-take-task' });

      const cycle = (await pendingTaskOf('D-01')).id;
      await auth(http().post(`${API}/${tenantId}/movements/counts/${cycle}/cancel`), operatorWebToken).set(KEY_HEADER, ulid()).send({}).expect(403);
      const key = ulid();
      const res = await auth(http().post(`${API}/${tenantId}/movements/counts/${cycle}/cancel`)).set(KEY_HEADER, key).send({}).expect(200);
      expect(res.body.countTask).toMatchObject({ id: cycle, status: 'cancelled', cancelledBy: opsUserId });
      await expectAuditRow({ tenantId, key, action: 'count.cancelled', targetType: 'count_task', targetId: cycle, actorUserId: opsUserId });
      expect((await auth(http().post(`${API}/${tenantId}/movements/counts/${cycle}/cancel`)).set(KEY_HEADER, key).send({}).expect(200)).body).toEqual(res.body);
      expect((await auth(http().post(`${API}/${tenantId}/movements/counts/${cycle}/cancel`)).set(KEY_HEADER, ulid()).send({}).expect(409)).body.code).toBe('count-task-cancelled');
      expect((await submit(cycle, [{ skuId: s('ST-PLAIN'), countedQuantity: 20 }]).expect(409)).body.code).toBe('count-task-cancelled');
      expect((await auth(http().get(`${API}/${tenantId}/movements/counts?status=cancelled`)).expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([cycle]);
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
      expect(stored[0]!.payload_hash).toBe(hashCommandPayload({ tenantId, arm: 'count.cancel', taskId: cycle }));
    });

    it('abandon cancels the pending tasks and lifts the freeze; a late submit is 409 count-task-cancelled; a second abandon is 409 stock-take-not-counting', async () => {
      const task = await pendingTaskOf('C-01');
      await takeVerb(cTakeId, 'abandon', {}, ulid(), operatorWebToken).expect(403);
      const key = ulid();
      const res = await takeVerb(cTakeId, 'abandon', { note: 'wrong zone' }, key).expect(200);
      expect(res.body).toMatchObject({ stockTake: { status: 'abandoned', abandonedBy: opsUserId }, cancelledTaskCount: 1, releasedTaskCount: 0 });
      await expectAuditRow({ tenantId, key, action: 'stock_take.abandoned', targetType: 'stock_take', targetId: cTakeId, actorUserId: opsUserId });
      expect(await count(sql`select count(*)::int as n from stock_freeze_bins where tenant_id = ${tenantId} and stock_take_id = ${cTakeId}`)).toBe(0);
      expect((await submit(task.id, [{ skuId: s('ST-PLAIN'), countedQuantity: 6 }]).expect(409)).body.code).toBe('count-task-cancelled');
      expect((await takeVerb(cTakeId, 'abandon', {}).expect(409)).body.code).toBe('stock-take-not-counting');
      // Movement into the bin is booked again.
      expect((await webAdjust('C-01', 'ST-PLAIN', 1)).status).toBe(201);
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
      expect(stored[0]!.payload_hash).toBe(hashCommandPayload({ tenantId, arm: 'stock-take.abandon', stockTakeId: cTakeId, note: 'wrong zone' }));
    });

    it('the recount and close fingerprints are golden', async () => {
      const recount = (await sql`
        select k.payload_hash from idempotency_keys k
          join audit_events a on a.tenant_id = k.tenant_id and a.reference = k.key and a.action = 'stock_take.recount_requested'
         where k.tenant_id = ${tenantId} and a.target_id = ${takeId}
         order by k.created_at limit 1`) as unknown as { payload_hash: string }[];
      expect(recount[0]!.payload_hash).toBe(hashCommandPayload({ tenantId, arm: 'stock-take.recount', stockTakeId: takeId, binIds: [b('B-01')] }));
      const close = (await sql`
        select k.payload_hash, k.response_snapshot from idempotency_keys k
          join audit_events a on a.tenant_id = k.tenant_id and a.reference = k.key and a.action = 'stock_take.closed'
         where k.tenant_id = ${tenantId} and a.target_id = ${takeId}`) as unknown as { payload_hash: string }[];
      expect(close).toHaveLength(1);
      expect(close[0]!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ── reads, RLS, OpenAPI ────────────────────────────────────────────────

  describe('reads and surface', () => {
    it('the list: newest first with progress; the status filter narrows', async () => {
      const res = await auth(http().get(`${API}/${tenantId}/movements/stock-takes?warehouseId=${warehouseId}`), operatorWebToken).expect(200);
      expect(res.body.items.map((entry: { stockTake: { status: string } }) => entry.stockTake.status)).toEqual(['abandoned', 'closed']);
      expect(res.body.items[1].progress).toEqual({ bins: 6, counted: 6, pending: 0 });
      const closed = await auth(http().get(`${API}/${tenantId}/movements/stock-takes?status=closed`)).expect(200);
      expect(closed.body.items).toHaveLength(1);
      const paged = await auth(http().get(`${API}/${tenantId}/movements/stock-takes?limit=1`)).expect(200);
      const next = await auth(http().get(`${API}/${tenantId}/movements/stock-takes?limit=1&cursor=${paged.body.nextCursor as string}`)).expect(200);
      expect(next.body.items[0].stockTake.status).toBe('closed');
    });

    it('RLS: neither table shows another tenant\'s rows to wms_rls_probe', async () => {
      const foreign = uuidv7();
      await sql`insert into stock_takes (id, tenant_id, warehouse_id, status, bin_count, started_by, started_at) values (${uuidv7()}, ${foreign}, ${uuidv7()}, 'counting', 1, ${uuidv7()}, now())`;
      await sql`insert into stock_freeze_bins (id, tenant_id, warehouse_id, bin_id, bin_code, stock_take_id, frozen_at) values (${uuidv7()}, ${foreign}, ${uuidv7()}, ${uuidv7()}, 'X-01', ${uuidv7()}, now())`;
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1 });
      try {
        await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
        for (const table of ['stock_takes', 'stock_freeze_bins']) {
          const rows = await rls.unsafe(`select count(*)::int as n from ${table} where tenant_id = '${foreign}'::uuid`);
          expect({ table, n: Number((rows[0] as unknown as { n: number }).n) }).toEqual({ table, n: 0 });
        }
        await rls.unsafe(`select set_config('app.tenant_id', '${foreign}', false)`);
        for (const table of ['stock_takes', 'stock_freeze_bins']) {
          const rows = await rls.unsafe(`select count(*)::int as n from ${table}`);
          expect({ table, n: Number((rows[0] as unknown as { n: number }).n) }).toEqual({ table, n: 1 });
        }
      } finally {
        await rls.end();
      }
    });

    it('OpenAPI: the nine routes', () => {
      const doc = JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
      const methods = (path: string): string[] => Object.keys(doc.paths[path] ?? {}).sort();
      expect(methods('/tenants/{tenantId}/movements/warehouses/{warehouseId}/stock-takes')).toEqual(['post']);
      expect(methods('/tenants/{tenantId}/movements/stock-takes')).toEqual(['get']);
      expect(methods('/tenants/{tenantId}/movements/stock-takes/{stockTakeId}')).toEqual(['get']);
      expect(methods('/tenants/{tenantId}/movements/stock-takes/{stockTakeId}/variances')).toEqual(['get']);
      expect(methods('/tenants/{tenantId}/movements/stock-takes/{stockTakeId}/report')).toEqual(['get']);
      expect(methods('/tenants/{tenantId}/movements/stock-takes/{stockTakeId}/recount')).toEqual(['post']);
      expect(methods('/tenants/{tenantId}/movements/stock-takes/{stockTakeId}/close')).toEqual(['post']);
      expect(methods('/tenants/{tenantId}/movements/stock-takes/{stockTakeId}/abandon')).toEqual(['post']);
      expect(methods('/tenants/{tenantId}/movements/counts/{taskId}/cancel')).toEqual(['post']);
    });
  });

  // ── review follow-ups ──────────────────────────────────────────────────

  describe('review follow-ups', () => {
    const db = () => app.get<Database>(DATABASE);
    async function deviceWrites(binCode: string): Promise<number> {
      const rows = (await sql`select device_writes from stock_freeze_bins where tenant_id = ${tenantId} and bin_id = ${b(binCode)}`) as unknown as { device_writes: number }[];
      return rows[0]?.device_writes ?? -1;
    }
    let bTake: string;

    it('the fingerprints are golden (literal hex): close, abandon, cancel', () => {
      const T = '01900000-0000-7000-8000-0000000000aa';
      const S = '01900000-0000-7000-8000-0000000000bb';
      const commands = app.get(StockTakeCommand);
      expect(commands.closeFingerprint({ tenantId: T, actorUserId: T, stockTakeId: S, openVarianceDigest: 'a'.repeat(64) })).toBe('0ba316688d56e063a152a48819e83679955677f55c459859717729f58251bd3a');
      expect(commands.abandonFingerprint({ tenantId: T, actorUserId: T, stockTakeId: S, note: '  wrong zone ' })).toBe('e44a6f696f0d94ff6a085ed850b8d70432323d54a0bce2137b5d9a79f1bdbbf6');
      expect(app.get(CountService).cancelFingerprint({ tenantId: T, actorUserId: T, taskId: '01900000-0000-7000-8000-0000000000cc' })).toBe('34b0e434e974a3dc16718a90799c670433a765e60743015bcb4e976f6d80e6fd');
    });

    it('a take on zone B supersedes the older variance; device ops are admitted (move, transfer receive) and counted; the review-queue recount refuses a frozen bin', async () => {
      const b02 = await auth(http().post(`${API}/${tenantId}/movements/counts`)).set(KEY_HEADER, ulid()).send({ warehouseId, binId: b('B-02') }).expect(201);
      await submit(b02.body.countTask.id as string, [{ skuId: s('ST-PLAIN'), countedQuantity: 1 }]).expect(200);
      const res = await start({ zoneIds: [zone.get('B')] }).expect(201);
      bTake = res.body.stockTake.id as string;
      expect(res.body.supersededVarianceCount).toBe(1);
      // A handheld move into a frozen bin is admitted.
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/inventory/moves`)
        .set('Authorization', `Bearer ${managerDeviceToken}`)
        .set(KEY_HEADER, ulid())
        .send({ skuId: s('ST-PLAIN'), fromBinId: b('D-01'), toBinId: b('B-01'), qty: 1, reasonCode: 'consolidate', occurredAt: new Date(Date.now() - 1000).toISOString() })
        .expect(201);
      expect(await deviceWrites('B-01')).toBe(1);
      // A handheld transfer receive into a frozen bin is admitted.
      const created = await auth(http().post(`${API}/${tenantId}/movements/transfers`))
        .set(KEY_HEADER, ulid())
        .send({ sourceWarehouseId: warehouseId, destWarehouseId: warehouseId, lines: [{ skuId: s('ST-PLAIN'), quantity: 1, fromBinId: b('D-01'), toBinId: b('B-01') }] })
        .expect(201);
      const transferId = created.body.transfer.id as string;
      await auth(http().post(`${API}/${tenantId}/movements/transfers/${transferId}/outbound-confirm`)).set(KEY_HEADER, ulid()).send({}).expect(200);
      await http()
        .post(`${API}/${tenantId}/movements/transfers/${transferId}/inbound-confirm`)
        .set('Authorization', `Bearer ${managerDeviceToken}`)
        .set(KEY_HEADER, ulid())
        .send({ destBinId: b('B-01') })
        .expect(200);
      expect(await deviceWrites('B-01')).toBe(2);
      // The 5-6 review recount (the sync-report resolve's mint) refuses a frozen bin.
      let code: string | null = null;
      try {
        await withTenantTransaction(db(), tenantId, (tx) => app.get(MovementsFacade).mintRecountTaskInTx(tx, tenantId, warehouseId, b('B-02'), 'B-02', new Date().toISOString()));
      } catch (err) {
        code = err instanceof ProblemException ? (err.getResponse() as { code: string }).code : 'other';
      }
      expect(code).toBe('bin-in-stock-take');
    });

    it('the handheld arms that do not run here over HTTP still mark themselves device (pick, putaway, return restock, the transfer replay)', () => {
      const read = (path: string) => readFileSync(join(SRC, path), 'utf8');
      expect(read('modules/outbound/pick.command.ts').match(/surface: 'device'/g)).toHaveLength(2);
      expect(read('modules/putaway/putaway.command.ts').match(/surface: 'device'/g)).toHaveLength(2);
      expect(read('modules/returns/return-disposition.command.ts')).toMatch(/plan\.deviceId === null \? \{\} : \{ surface: 'device' as const \}/);
      expect(read('modules/tenancy/sync-report.command.ts')).toMatch(/case 'transfer\.confirm':[\s\S]{0,1200}surface: 'device'/);
    });

    it('the putaway ranking skips a frozen bin, and offers it again after the abandon', async () => {
      const ids = async () => (await withTenantTransaction(db(), tenantId, (tx) => binCandidatesInTx(tx, tenantId, warehouseId))).map((c) => c.binId);
      expect(await ids()).not.toContain(b('B-02'));
      expect(await ids()).toContain(b('D-01'));
      // Abandon: the superseded variance's task is RELEASED, not cancelled.
      const task = await pendingTaskOf('B-02');
      const res = await takeVerb(bTake, 'abandon', { note: 'staff short' }).expect(200);
      expect(res.body).toMatchObject({ cancelledTaskCount: 1, releasedTaskCount: 1, stockTake: { abandonNote: 'staff short', note: null, deviceWrites: 2 } });
      expect(await pendingTaskOf('B-02')).toEqual({ id: task.id, stockTakeId: null, origin: 'on_demand' });
      expect(await ids()).toContain(b('B-02'));
      // Its submit produces a fresh variance (on the queue again).
      await submit(task.id, [{ skuId: s('ST-PLAIN'), countedQuantity: 1 }]).expect(200);
      expect(await count(sql`select count(*)::int as n from count_variances where task_id = ${task.id} and status = 'open'`)).toBe(1);
      // An abandoned take's report says so.
      const file = await auth(http().get(`${API}/${tenantId}/movements/stock-takes/${bTake}/report?format=csv`)).expect(200);
      expect(file.headers['content-disposition']).toContain('-abandoned.csv');
    });

    it('a scheduler tick skips a frozen bin that was already counted; a provisional report while counting; a close resumes from posting', async () => {
      const take = await start({ zoneIds: [zone.get('A')] }).expect(201);
      const id = take.body.stockTake.id as string;
      await submit((await pendingTaskOf('A-01')).id, [{ skuId: s('ST-PLAIN'), countedQuantity: 13 }]).expect(200);
      await submit((await pendingTaskOf('A-02')).id, [{ skuId: s('ST-PLAIN'), countedQuantity: 5 }, { skuId: s('ST-OTHER'), countedQuantity: 8 }]).expect(200);
      await submit((await pendingTaskOf('A-03')).id, [{ skuId: s('ST-OTHER'), countedQuantity: 5 }]).expect(200);
      await submit((await pendingTaskOf('A-04')).id, [{ skuId: s('ST-BATCH'), countedQuantity: 2 }]).expect(200);
      // The scheduler: A-01 (class a, frozen, counted long ago) is skipped.
      await auth(http().put(`${API}/${tenantId}/movements/warehouses/${warehouseId}/count-policies`)).set(KEY_HEADER, ulid()).send({ policies: [{ abcClass: 'a', intervalDays: 1 }] }).expect(200);
      await sql`update count_tasks set completed_at = now() - interval '3 days' where tenant_id = ${tenantId} and bin_id = ${b('A-01')} and status = 'completed'`;
      const minted = await app.get(MovementsFacade).generateScheduledCountTasks(tenantId, warehouseId, 50);
      const mintedBins = minted.length === 0 ? [] : ((await sql`select bin_id from count_tasks where id in ${sql(minted as string[])}`) as unknown as { bin_id: string }[]).map((r) => r.bin_id);
      expect(mintedBins).not.toContain(b('A-01'));
      // A provisional report while counting.
      const file = await auth(http().get(`${API}/${tenantId}/movements/stock-takes/${id}/report?format=csv`)).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(file.headers['content-disposition']).toContain('-provisional.csv');
      expect((file.body as Buffer).toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[1]!.split(',')[0]).toBe('provisional');

      // Simulate an interrupted close: approved (posting), A-01 already posted
      // and released, A-04 left unposted with a stored reason and released.
      const variance = async (binCode: string) => ((await sql`select v.id from count_variances v join count_tasks t on t.id = v.task_id where t.stock_take_id = ${id} and v.bin_id = ${b(binCode)} and v.status = 'open'`) as unknown as { id: string }[])[0]!.id;
      const a01 = await variance('A-01');
      const a04 = await variance('A-04');
      await sql`update stock_takes set status = 'posting', approved_by = ${ownerUserId}, approved_at = now(),
                unposted = ${sql.json([{ varianceId: a04, binId: b('A-04'), binCode: 'A-04', skuId: s('ST-BATCH'), skuCode: 'ST-BATCH', code: 'stored-code', detail: 'stored', needsLotCount: true }])}
                where id = ${id}`;
      await sql`update count_variances set status = 'adjusted', resolved_by = ${ownerUserId}, resolved_at = now() where id = ${a01}`;
      await sql`delete from stock_freeze_bins where stock_take_id = ${id} and bin_id in (${b('A-01')}, ${b('A-04')})`;
      // Any close on a posting take resumes (approval is skipped).
      const res = await takeVerb(id, 'close', { openVarianceDigest: '0'.repeat(64) }, ulid(), opsToken).expect(200);
      expect(res.body.stockTake.status).toBe('closed');
      expect(res.body.postedCount).toBe(2); // A-01 (before) + A-03 (+1)
      expect(res.body.unposted).toEqual([expect.objectContaining({ varianceId: a04, code: 'stored-code', needsLotCount: true })]);
      expect(await onHand('A-03', 'ST-OTHER')).toBe(5);
      expect(await count(sql`select count(*)::int as n from stock_freeze_bins where stock_take_id = ${id}`)).toBe(0);
    });
  });
});
