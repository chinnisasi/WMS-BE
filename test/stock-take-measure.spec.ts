import type { INestApplication } from '@nestjs/common';
import { gzipSync } from 'node:zlib';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { MovementsFacade } from '../src/modules/movements/transfer.facade';
import { StockTakeCommand } from '../src/modules/movements/stock-take.command';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 3-5b (A8, A2) — the two measurements the spec asks for, recorded in
// the spec's Implementation Notes: the device snapshot of a warehouse holding
// 3,000 pending take tasks (about three lines each), and the close of a
// 3,000-bin take with 600 variances (the batch count and the longest batch).
// Heavy, so it runs only with STOCK_TAKE_MEASURE=1; it asserts the shape of
// what it measured, not a time.
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
const BINS = 3000;
const VARIANCE_EVERY = 5; // 600 variances

jest.setTimeout(1_800_000);

const run = process.env.STOCK_TAKE_MEASURE === '1' ? describe : describe.skip;

run('stock take measurements (story 3-5b, A8/A2)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('stock_take_measure');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
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

  it('a 3,000-bin take: the snapshot payload, then the close of 600 variances', async () => {
    const http = () => request(app.getHttpServer());
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Measure Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' }).expect(201);
    const tenantId = registered.body.tenant.id as string;
    const ownerId = registered.body.owner.id as string;
    const token = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
    const csv = ['sku_code,name,uom,gst_rate', 'M-1,Measure one,pcs,1800', 'M-2,Measure two,pcs,1800', 'M-3,Measure three,pcs,1800'].join('\n');
    await auth(http().post(`${API}/${tenantId}/catalog/imports`)).set(KEY_HEADER, ulid()).field('mode', 'initial').attach('file', Buffer.from(csv), { filename: 'c.csv', contentType: 'text/csv' }).expect(201);
    const skuIds = ((await sql`select id from skus where tenant_id = ${tenantId} order by code`) as unknown as { id: string }[]).map((row) => row.id);
    const warehouseId = (await auth(http().post(`${API}/${tenantId}/warehouses`)).set(KEY_HEADER, ulid()).send({ origin: testAddress(), code: 'MEAS', name: 'Measure WH' }).expect(201)).body.id as string;
    const zoneId = (await auth(http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)).set(KEY_HEADER, ulid()).send({ code: 'M', name: 'Zone M' }).expect(201)).body.id as string;

    // 3,000 bins with three SKUs each, seeded straight into the tables (a
    // measurement — the take reads the projection, not the history).
    const bins: { id: string; code: string }[] = [];
    for (let i = 0; i < BINS; i += 1) bins.push({ id: uuidv7(), code: `M-${String(i).padStart(4, '0')}` });
    for (let at = 0; at < bins.length; at += 500) {
      const slice = bins.slice(at, at + 500);
      await sql`insert into bins ${sql(slice.map((bin) => ({ id: bin.id, tenant_id: tenantId, warehouse_id: warehouseId, zone_id: zoneId, code: bin.code, capacity: 1_000_000, type: 'shelf' })))}`;
      await sql`insert into stock_on_hand ${sql(slice.flatMap((bin) => skuIds.map((skuId) => ({ id: uuidv7(), tenant_id: tenantId, warehouse_id: warehouseId, sku_id: skuId, bin_id: bin.id, quantity: 10_000 }))))}`;
    }

    const movements = app.get(MovementsFacade);
    const started = Date.now();
    const take = await movements.startStockTake({ tenantId, actorUserId: ownerId, warehouseId, zoneIds: null, note: null }, ulid());
    const startMs = Date.now() - started;
    expect(take.createdTaskCount).toBe(BINS);

    const cards = await movements.getCountTasks(tenantId, warehouseId);
    const json = JSON.stringify(cards);
    const snapshotBytes = Buffer.byteLength(json);
    const gzipBytes = gzipSync(json).length;
    expect(cards).toHaveLength(BINS);

    const tasks = (await sql`select id, bin_id from count_tasks where tenant_id = ${tenantId} and stock_take_id = ${take.stockTake.id} order by bin_id`) as unknown as { id: string; bin_id: string }[];
    let i = 0;
    for (const task of tasks) {
      const counted = i % VARIANCE_EVERY === 0 ? 11 : 10;
      await movements.submitCount(
        { tenantId, actorUserId: ownerId, taskId: task.id, lines: skuIds.map((skuId, index) => ({ skuId, countedQuantity: index === 0 ? counted : 10 })) },
        ulid(),
      );
      i += 1;
    }
    const detail = await movements.getStockTake(tenantId, take.stockTake.id);
    expect(detail.totals.openVariances).toBe(BINS / VARIANCE_EVERY);
    const closeStarted = Date.now();
    const run = await app.get(StockTakeCommand).closeStockTake({ tenantId, actorUserId: ownerId, stockTakeId: take.stockTake.id, openVarianceDigest: detail.openVarianceDigest }, ulid());
    const closeMs = Date.now() - closeStarted;
    expect(run.snapshot.postedCount).toBe(BINS / VARIANCE_EVERY);
    const metrics = run.metrics!;

    process.stdout.write(
      `\nSTOCK-TAKE MEASURE: start ${startMs} ms; snapshot countTasks ${cards.length} cards, ${snapshotBytes} B JSON, ${gzipBytes} B gzip; ` +
        `close ${closeMs} ms in ${metrics.batches} batch(es), longest batch ${metrics.longestBatchMs} ms\n`,
    );
  });
});
