import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid } from '../src/shared/primitives/ids';
import { fromMilli, toMilli } from '../src/shared/primitives/quantity';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import {
  READY_REPAIR_BACKOFF_MS,
  ReservationService,
  reservationRepairClock,
} from '../src/modules/inventory/reservation.service';
import { ReplenishmentFacade } from '../src/modules/replenishment/replenishment.facade';
import type { ProblemException } from '../src/shared/problem-details/problem.exception';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// spec-fix-new-warehouse-order-intake (epic-21 retro A2 / R1): a warehouse
// created after the backend starts, a stock-less one, or one whose Valkey
// state was flushed must take orders WITHOUT a restart and WITHOUT anyone
// calling `rebuildReservationCounters` — the not-ready ATP read repairs the
// warehouse from the journal itself (single-flight, backed off on failure).
//
// Real HTTP, real Postgres and Valkey. This suite deliberately NEVER calls
// `rebuildReservationCounters` to arm a warehouse.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// No background worker may arm a warehouse behind the tests' back: the
// reaper (and its parity pass) and the replenishment scheduler stay off, so
// every rebuild counted below is one a test caused.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.REPLENISHMENT_SCHEDULER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(60_000);

const SKU_CODES = ['CW-NEW', 'CW-NONE', 'CW-FLUSH', 'CW-CONC', 'CW-GRANT', 'CW-PARITY', 'CW-FAIL', 'CW-FAIL2', 'CW-REREAD', 'CW-SWEEP'] as const;

const NOT_READY_DETAIL = (warehouseId: string) =>
  `Warehouse ${warehouseId} counters are being (re)built from the journal — ATP is unavailable, not zero.`;

/** A promise the test resolves — the gate every gated rebuild waits on. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Polls until `predicate` holds (bounded) — waits for in-flight callers to arrive. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type RebuildWarehouse = (tenantId: string, warehouseId: string) => Promise<unknown>;

describe('cold warehouse order intake: ATP self-arms its reservation counters (e2e, fix A2/R1)', () => {
  let app: INestApplication;
  let facade: InventoryFacade;
  let service: ReservationService;
  let sql: postgres.Sql;
  let valkey: Redis;
  let suiteDb: SuiteDatabase;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  const skuIds = new Map<string, string>();

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('cold_warehouse_intake');
    app = await createApp(false);
    await app.init();
    facade = app.get(InventoryFacade);
    service = app.get(ReservationService);
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    // The tenant is registered AFTER app start, so the startup rebuild never
    // saw it — every warehouse below is cold until something arms it.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Cold Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [csvHeader, ...SKU_CODES.map((code) => `${code},Test SKU ${code},pcs,,1800,,,,,`)].join('\n');
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
  });

  afterEach(() => {
    reservationRepairClock.now = () => Date.now();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    reservationRepairClock.now = () => Date.now();
    for (const tenant of createdTenantIds) {
      const keys = await valkey.keys(`wms:{${tenant}}:*`);
      if (keys.length > 0) {
        await valkey.del(...keys);
      }
    }
    await valkey.quit().catch(() => valkey.disconnect());
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  /** A fresh warehouse (+ zone + bin) created over HTTP after app start. */
  async function newWarehouse(): Promise<{ warehouseId: string; binId: string }> {
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ origin: testAddress(), code: `CW-${ulid().slice(10, 16).toUpperCase()}`, name: `Cold WH ${ulid()}` })
      .expect(201);
    const warehouseId = warehouse.body.id as string;
    const zone = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' })
        .expect(201)
    ).body as { id: string };
    const binId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.id}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 1000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;
    return { warehouseId, binId };
  }

  /** Receives on-hand the suites' usual way: the stock.adjustment command (HTTP). */
  async function seedStock(warehouseId: string, binId: string, skuId: string, quantity: number): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta: quantity, reasonCode: 'stock-count', note: 'cold-warehouse seed' })
      .expect(201);
  }

  function postOrder(warehouseId: string, skuId: string, quantity: number): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines: [{ skuId, quantity }], destination: testAddress() });
  }

  function readyKey(warehouseId: string): string {
    return `wms:{${tenantId}}:wh:${warehouseId}:res:__ready__`;
  }

  function counterKey(warehouseId: string, skuId: string): string {
    return `wms:{${tenantId}}:wh:${warehouseId}:res:${skuId}`;
  }

  /** The journal's live reserved sum (milli) — the truth a counter must equal. */
  async function journalSum(warehouseId: string, skuId: string): Promise<number> {
    const rows = await sql`
      select coalesce(sum(quantity), 0)::bigint as reserved from reservations
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and sku_id = ${skuId}
        and state in ('held', 'committed')
    `;
    return Number((rows[0] as unknown as { reserved: string }).reserved);
  }

  /** The private rebuild body, spied (call count = rebuilds that actually RAN). */
  function spyRebuildWarehouse(): jest.SpyInstance {
    return jest.spyOn(service as unknown as { rebuildWarehouse: RebuildWarehouse }, 'rebuildWarehouse');
  }

  /** The un-spied rebuild body, for a gated mock to call through to. */
  const originalRebuildWarehouse = (ReservationService.prototype as unknown as { rebuildWarehouse: RebuildWarehouse })
    .rebuildWarehouse;

  /** Spies `rebuildWarehouse` so every run waits on `gate` before doing the real work. */
  function gateRebuildWarehouse(gate: Promise<void>): jest.SpyInstance {
    return spyRebuildWarehouse().mockImplementation(async (...args: unknown[]) => {
      await gate;
      return originalRebuildWarehouse.apply(service, args as Parameters<RebuildWarehouse>);
    });
  }

  async function caught(promise: Promise<unknown>): Promise<ProblemException> {
    return promise.then(
      () => {
        throw new Error('expected a rejection');
      },
      (error: unknown) => error as ProblemException,
    );
  }

  it('runs with no background worker that could arm a warehouse (the reaper/parity and scheduler gates are unset)', () => {
    expect(process.env.RESERVATION_REAPER_POLL_MS).toBeUndefined();
    expect(process.env.REPLENISHMENT_SCHEDULER_POLL_MS).toBeUndefined();
  });

  it('new warehouse: created after start, stock received, the first order is 201 and reserves — no restart', async () => {
    const skuId = skuIds.get('CW-NEW')!;
    const { warehouseId, binId } = await newWarehouse();
    await seedStock(warehouseId, binId, skuId, 5);
    // Cold: nothing armed it (this used to 503 reservation-store-unavailable).
    expect(await valkey.exists(readyKey(warehouseId))).toBe(0);

    const res = await postOrder(warehouseId, skuId, 3).expect(201);
    const line = (res.body.order.lines as Record<string, unknown>[])[0]!;
    expect(line).toMatchObject({ skuId, qty: 3, reservedQty: 3, status: 'open' });
    expect(line.reservationId).toEqual(expect.any(String));
    expect(await valkey.exists(readyKey(warehouseId))).toBe(1);
    expect(Number(await valkey.get(counterKey(warehouseId, skuId)))).toBe(toMilli(3));
    expect(await journalSum(warehouseId, skuId)).toBe(toMilli(3));
  });

  it('stock-less: the facade ATP read on a new warehouse answers ATP 0 (not 503)', async () => {
    const skuId = skuIds.get('CW-NONE')!;
    const { warehouseId } = await newWarehouse();
    expect(await valkey.exists(readyKey(warehouseId))).toBe(0);
    const snapshot = await facade.atp(tenantId, warehouseId, skuId);
    expect(snapshot).toMatchObject({ onHand: 0, reserved: 0, atp: 0 });
    expect(await valkey.exists(readyKey(warehouseId))).toBe(1);
  });

  it('flushed: the ready key deleted, the next order rebuilds and succeeds', async () => {
    const skuId = skuIds.get('CW-FLUSH')!;
    const { warehouseId, binId } = await newWarehouse();
    await seedStock(warehouseId, binId, skuId, 4);
    await postOrder(warehouseId, skuId, 1).expect(201);
    expect(await valkey.exists(readyKey(warehouseId))).toBe(1);

    await valkey.del(readyKey(warehouseId));
    const rebuildSpy = spyRebuildWarehouse();
    const res = await postOrder(warehouseId, skuId, 2).expect(201);
    expect((res.body.order.lines as Record<string, unknown>[])[0]).toMatchObject({ reservedQty: 2, status: 'open' });
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    // Postgres won: the rebuilt counter carries the first order's hold too.
    expect(Number(await valkey.get(counterKey(warehouseId, skuId)))).toBe(toMilli(3));
    expect(await journalSum(warehouseId, skuId)).toBe(toMilli(3));
  });

  it('concurrent cold: five overlapping reads share ONE rebuild and all five answer', async () => {
    const skuId = skuIds.get('CW-CONC')!;
    const { warehouseId, binId } = await newWarehouse();
    await seedStock(warehouseId, binId, skuId, 7);
    expect(await valkey.exists(readyKey(warehouseId))).toBe(0);

    const gate = deferred();
    const rebuildSpy = gateRebuildWarehouse(gate.promise);
    const countersSpy = jest.spyOn(service, 'rebuildCounters');
    const reads = Array.from({ length: 5 }, () => facade.atp(tenantId, warehouseId, skuId));
    // All five are inside `rebuildCounters` (one started the flight, four joined).
    await until(() => countersSpy.mock.calls.length === 5, 'five reads to reach the rebuild');
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    gate.release();

    const answers = await Promise.all(reads);
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    for (const answer of answers) {
      expect(answer).toMatchObject({ onHand: toMilli(7), reserved: 0, atp: toMilli(7) });
    }
  });

  it('grant + read: a not-ready grant and an overlapping read share one rebuild; the grant is store-down, the read answers', async () => {
    const skuId = skuIds.get('CW-GRANT')!;
    const { warehouseId, binId } = await newWarehouse();
    await seedStock(warehouseId, binId, skuId, 3);

    const gate = deferred();
    const rebuildSpy = gateRebuildWarehouse(gate.promise);
    const countersSpy = jest.spyOn(service, 'rebuildCounters');
    const granting = caught(
      facade.grantReservation({
        tenantId,
        warehouseId,
        skuId,
        ownerType: 'order-line',
        ownerId: `cold-${ulid().toLowerCase()}`,
        quantity: toMilli(1),
      }),
    );
    await until(() => rebuildSpy.mock.calls.length === 1, 'the grant to start the rebuild');
    const reading = facade.atp(tenantId, warehouseId, skuId);
    await until(() => countersSpy.mock.calls.length === 2, 'the read to join the rebuild');
    gate.release();

    const grantError = await granting;
    expect(grantError.getStatus()).toBe(503);
    expect((grantError.getResponse() as { code: string }).code).toBe('reservation-store-unavailable');
    expect(await reading).toMatchObject({ onHand: toMilli(3), reserved: 0, atp: toMilli(3) });
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
  });

  it('parity + read: a facade rebuild in flight and a read share ONE rebuild; the counter equals the journal sum after', async () => {
    const skuId = skuIds.get('CW-PARITY')!;
    const { warehouseId, binId } = await newWarehouse();
    await seedStock(warehouseId, binId, skuId, 6);
    await postOrder(warehouseId, skuId, 1).expect(201); // arms the warehouse (warm)

    const gate = deferred();
    const rebuildSpy = gateRebuildWarehouse(gate.promise);
    const countersSpy = jest.spyOn(service, 'rebuildCounters');
    // The operator/parity-style rebuild starts and is held before its disarm.
    const rebuilding = facade.rebuildReservationCounters(tenantId, warehouseId);
    await until(() => rebuildSpy.mock.calls.length === 1, 'the facade rebuild to start');

    // A grant commits while that rebuild is pending — before its disarm (the
    // marker is still armed), so this proves the rebuild seeds it from the
    // journal, not that an overlap mid-rebuild is survived.
    await postOrder(warehouseId, skuId, 2).expect(201);

    // Then the marker goes (a flush) and a read arrives: it must JOIN the
    // pending flight, never start a second, overlapping rebuild.
    await valkey.del(readyKey(warehouseId));
    const reading = facade.atp(tenantId, warehouseId, skuId);
    await until(() => countersSpy.mock.calls.length === 2, 'the read to join the rebuild');
    gate.release();

    const [report] = await rebuilding;
    const answer = await reading;
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(report!.scopes.find((scope) => scope.skuId === skuId)).toMatchObject({ reserved: toMilli(3) });
    expect(answer).toMatchObject({ onHand: toMilli(6), reserved: toMilli(3), atp: toMilli(3) });
    // After the one shared rebuild the counter equals the journal's live sum.
    expect(Number(await valkey.get(counterKey(warehouseId, skuId)))).toBe(await journalSum(warehouseId, skuId));
    expect(await journalSum(warehouseId, skuId)).toBe(toMilli(3));
  });

  it('repair fails: 503 with the unchanged detail, one log, no rebuild inside the backoff, one attempt after it', async () => {
    const skuId = skuIds.get('CW-FAIL')!;
    const { warehouseId, binId } = await newWarehouse();
    await seedStock(warehouseId, binId, skuId, 2);

    let fakeNow = Date.now();
    const failedAt = fakeNow;
    reservationRepairClock.now = () => fakeNow;
    const logSpy = jest.spyOn((service as unknown as { logger: { error: (message: string) => void } }).logger, 'error');
    const failingSpy = spyRebuildWarehouse().mockRejectedValue(new Error('journal read failed'));

    const first = await caught(facade.atp(tenantId, warehouseId, skuId));
    expect(first.getStatus()).toBe(503);
    expect(first.getResponse()).toMatchObject({
      code: 'reservation-store-unavailable',
      detail: NOT_READY_DETAIL(warehouseId),
    });
    expect(failingSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toContain(`warehouse=${warehouseId}`);
    expect(logSpy.mock.calls[0]![0]).toContain('trigger=atp');

    // K = 5 further reads inside the window: no rebuild, no new log, still
    // 503 with the same detail — never ATP 0.
    for (let i = 0; i < 5; i += 1) {
      fakeNow += 500;
      const again = await caught(facade.atp(tenantId, warehouseId, skuId));
      expect(again.getResponse()).toMatchObject({ code: 'reservation-store-unavailable', detail: NOT_READY_DETAIL(warehouseId) });
    }
    expect(fakeNow - failedAt).toBeLessThan(READY_REPAIR_BACKOFF_MS);
    expect(failingSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);

    // The grant path honours the same backoff: store-down 503, no rebuild, no log.
    const grantError = await caught(
      facade.grantReservation({
        tenantId,
        warehouseId,
        skuId,
        ownerType: 'order-line',
        ownerId: `cold-${ulid().toLowerCase()}`,
        quantity: toMilli(1),
      }),
    );
    expect(grantError.getStatus()).toBe(503);
    expect((grantError.getResponse() as { code: string }).code).toBe('reservation-store-unavailable');
    expect(failingSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);

    // Past the backoff: exactly one more attempt — this time the store heals.
    failingSpy.mockRestore();
    const healSpy = spyRebuildWarehouse();
    fakeNow = failedAt + READY_REPAIR_BACKOFF_MS;
    const healed = await facade.atp(tenantId, warehouseId, skuId);
    expect(healSpy).toHaveBeenCalledTimes(1);
    expect(healed).toMatchObject({ onHand: toMilli(2), reserved: 0, atp: toMilli(2) });
    expect(fromMilli(healed.atp)).toBe(2);
  });

  it('repair fails under five joined reads: all five 503, ONE rebuild, ONE log', async () => {
    const skuId = skuIds.get('CW-FAIL2')!;
    const { warehouseId, binId } = await newWarehouse();
    await seedStock(warehouseId, binId, skuId, 2);

    const gate = deferred();
    const logSpy = jest.spyOn((service as unknown as { logger: { error: (message: string) => void } }).logger, 'error');
    const failingSpy = spyRebuildWarehouse().mockImplementation(async () => {
      await gate.promise;
      throw new Error('journal read failed');
    });
    const countersSpy = jest.spyOn(service, 'rebuildCounters');
    const reads = Array.from({ length: 5 }, () => caught(facade.atp(tenantId, warehouseId, skuId)));
    await until(() => countersSpy.mock.calls.length === 5, 'five reads to join the failing rebuild');
    gate.release();

    for (const error of await Promise.all(reads)) {
      expect(error.getResponse()).toMatchObject({ code: 'reservation-store-unavailable', detail: NOT_READY_DETAIL(warehouseId) });
    }
    expect(failingSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('repair re-reads its inputs: stock received while the rebuild is held is in the answer', async () => {
    const skuId = skuIds.get('CW-REREAD')!;
    const { warehouseId, binId } = await newWarehouse();
    await seedStock(warehouseId, binId, skuId, 2);

    const gate = deferred();
    gateRebuildWarehouse(gate.promise);
    const countersSpy = jest.spyOn(service, 'rebuildCounters');
    const reading = facade.atp(tenantId, warehouseId, skuId);
    await until(() => countersSpy.mock.calls.length === 1, 'the read to start the repair');
    // The read's first input transaction has run (on-hand 2); 3 more arrive.
    await seedStock(warehouseId, binId, skuId, 3);
    gate.release();

    expect(await reading).toMatchObject({ onHand: toMilli(5), reserved: 0, atp: toMilli(5) });
  });

  it('sweep: sweepScope over a fresh warehouse with a policy evaluates the scope (no throw)', async () => {
    const skuId = skuIds.get('CW-SWEEP')!;
    const { warehouseId } = await newWarehouse();
    await request(app.getHttpServer())
      .put(`${API}/${tenantId}/replenishment/policies`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, reorderPoint: 2000, reorderQty: 5000 })
      .expect(200);
    expect(await valkey.exists(readyKey(warehouseId))).toBe(0);

    const report = await app.get(ReplenishmentFacade).sweepScope(tenantId, warehouseId);
    expect(report.evaluated).toBeGreaterThan(0);
    expect(report).toMatchObject({ tenantId, warehouseId, opened: 1 });
  });
});
