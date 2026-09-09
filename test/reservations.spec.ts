import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { inventoryQuarantines } from '../src/shared/db/schema';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ValkeyClient } from '../src/shared/valkey/valkey.client';
import { ProblemException } from '../src/shared/problem-details/problem.exception';
import type { ReservationSnapshot } from '../src/modules/inventory/reservation.service';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// A host that exports any poll interval would boot background workers and
// race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

const OWNER_TYPE = 'order-line';

/** One SKU code per scenario — the suite's deterministic fixture set. */
const SKU_CODES = [
  'RSV-HEALTHY',
  'RSV-RACE',
  'RSV-BURST-1',
  'RSV-BURST-2',
  'RSV-BURST-3',
  'RSV-BURST-4',
  'RSV-BURST-5',
  'RSV-BURST-6',
  'RSV-COMMIT',
  'RSV-RELEASE',
  'RSV-TTL',
  'RSV-Q',
  'RSV-REBUILD',
] as const;

/** The machine-readable code of a rejected ProblemException (the contract). */
function codeOf(error: unknown): string {
  return ((error as ProblemException).getResponse() as { code: string }).code;
}

/**
 * Asserts a promise rejects with the ProblemException contract: HTTP status
 * AND machine-readable code (HttpException hides `code` inside
 * `getResponse()` — `toMatchObject` cannot see it).
 */
async function expectProblem(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect((error as ProblemException | undefined)?.getStatus()).toBe(status);
  expect(codeOf(error)).toBe(code);
}

describe('real-time ATP and atomic reservations (e2e, story 2.3)', () => {
  let app: INestApplication;
  let facade: InventoryFacade;
  let db: Database;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let opsToken: string;
  let warehouseId: string;
  let binA: string;
  let binB: string;
  const skuIds = new Map<string, string>();

  beforeAll(async () => {
    // Same deployment-parity probes as the sibling suites (auth + RLS roles,
    // serialized by the advisory lock).
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742105)`;
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
    facade = app.get(InventoryFacade);
    db = app.get<unknown>(DATABASE) as Database;
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });
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
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // The ledger tables are append-only by trigger — cleanup rides the
      // replication-role bypass exactly like the sibling suites.
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      await cleaner.unsafe('DELETE FROM reservations WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM inventory_quarantines WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // The suite's namespaced decision-state keys must not outlive the rows.
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

  /** Seeds committed on-hand via the stock.adjustment command (HTTP). */
  async function seedStock(skuId: string, binId: string, quantity: number): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId,
        quantityDelta: quantity,
        reasonCode: 'cycle-count',
        note: 'reservation-suite seed',
      })
      .expect(201);
  }

  function grantCommand(
    skuId: string,
    ownerId: string,
    quantity: number,
    ttlSeconds?: number,
  ): Parameters<InventoryFacade['grantReservation']>[0] {
    // `exactOptionalPropertyTypes`: an omitted TTL stays absent (never undefined).
    return ttlSeconds === undefined
      ? { tenantId, warehouseId, skuId, ownerType: OWNER_TYPE, ownerId, quantity }
      : { tenantId, warehouseId, skuId, ownerType: OWNER_TYPE, ownerId, quantity, ttlSeconds };
  }

  function grant(skuId: string, ownerId: string, quantity: number, ttlSeconds?: number) {
    return facade.grantReservation(grantCommand(skuId, ownerId, quantity, ttlSeconds));
  }

  function ownerId(prefix: string): string {
    return `${prefix}-${ulid().toLowerCase()}`;
  }

  async function reservationRow(id: string): Promise<Record<string, unknown> | undefined> {
    const rows = await sql`
      select id, state, quantity, owner_type, owner_id, expires_at from reservations where id = ${id}
    `;
    return rows[0] as unknown as Record<string, unknown> | undefined;
  }

  beforeAll(async () => {
    // Tenant + owner + an ops_manager (holds stock.adjust).
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Reserve Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    const opsEmail = `ops-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: opsEmail, role: 'ops_manager' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'ops-password-123' })
      .expect(200);
    opsToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: opsEmail, password: 'ops-password-123' })
        .expect(200)
    ).body.accessToken as string;

    // Warehouse → zone → two bins (the quarantine-exclusion test needs two).
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `RSV-${ulid().slice(10, 16).toUpperCase()}`, name: `Reserve WH ${ulid()}` })
      .expect(201);
    warehouseId = warehouse.body.id as string;
    const zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    const zoneId = zone.body.id as string;
    const binBody = { capacity: 1000, type: 'shelf' };
    binA = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...binBody, code: 'A-01-01' })
        .expect(201)
    ).body.id as string;
    binB = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...binBody, code: 'A-01-02' })
        .expect(201)
    ).body.id as string;

    // All scenario SKUs via catalog import (the only SKU-creation path).
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

    // Cold-start bootstrap: seed the tenant's counters + ready marker from
    // the (still empty) journal — the operator path after a Valkey flush.
    await facade.rebuildReservationCounters(tenantId, warehouseId);
  });

  it('healthy grant: counter decremented, journal row held with TTL, ATP drops by the qty', async () => {
    const skuId = skuIds.get('RSV-HEALTHY')!;
    await seedStock(skuId, binA, 5);
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(5);

    const granted = await grant(skuId, ownerId('healthy-1'), 2);
    expect(granted.state).toBe('held');
    expect(granted.quantity).toBe(2);
    expect(granted.ownerType).toBe('order-line');
    // TTL'd hold: expires_at is now + the default 900s (a small clock skew guard).
    expect(Date.parse(granted.expiresAt)).toBeGreaterThan(Date.now() + 800_000);
    expect(Date.parse(granted.expiresAt)).toBeLessThanOrEqual(Date.now() + 1_000_000);

    const atp = await facade.atp(tenantId, warehouseId, skuId);
    expect(atp).toMatchObject({ onHand: 5, reserved: 2, qcHeld: 0, buffer: 0, atp: 3 });

    const row = await reservationRow(granted.id);
    expect(row).toMatchObject({ state: 'held', quantity: 2 });
  });

  it('idempotent grant: a repeat grant while held returns the existing reservation', async () => {
    const skuId = skuIds.get('RSV-HEALTHY')!;
    const owner = ownerId('idem');
    const first = await grant(skuId, owner, 1);
    const repeat = await grant(skuId, owner, 1);
    expect(repeat.id).toBe(first.id);
    // The counter moved once, not twice.
    expect((await facade.atp(tenantId, warehouseId, skuId)).reserved).toBe(3); // 2 + 1
  });

  it('last-unit race: two concurrent grants, one unit — exactly one wins, the loser gets deterministic unavailable', async () => {
    const skuId = skuIds.get('RSV-RACE')!;
    await seedStock(skuId, binA, 1);
    const outcomes = await Promise.allSettled([
      grant(skuId, ownerId('race-a'), 1),
      grant(skuId, ownerId('race-b'), 1),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled') as PromiseFulfilledResult<ReservationSnapshot>[];
    const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const problem = rejected[0]!.reason as ProblemException;
    expect(problem).toBeInstanceOf(ProblemException);
    expect(problem.getStatus()).toBe(409);
    expect(codeOf(problem)).toBe('unavailable');

    // The journal carries exactly one held row; ATP is zero and stays zero.
    const rows = await sql`
      select count(*)::int as n from reservations
      where tenant_id = ${tenantId} and sku_id = ${skuId} and state = 'held'
    `;
    expect(Number((rows[0] as unknown as { n: number }).n)).toBe(1);
    const atp = await facade.atp(tenantId, warehouseId, skuId);
    expect(atp).toMatchObject({ onHand: 1, reserved: 1, atp: 0 });

    // The winner's hold is visible; a third grant is rejected deterministically too.
    await expectProblem(grant(skuId, ownerId('race-c'), 1), 409, 'unavailable');
  });

  it(
    'bounded concurrent burst across many SKUs: zero oversell, no deadlock',
    async () => {
      const burstSkus = ['RSV-BURST-1', 'RSV-BURST-2', 'RSV-BURST-3', 'RSV-BURST-4', 'RSV-BURST-5', 'RSV-BURST-6'];
      for (const code of burstSkus) {
        await seedStock(skuIds.get(code)!, binA, 2);
      }
      // 4 concurrent grants of 1 unit per SKU with 2 on hand: exactly 2 win.
      const attempts = burstSkus.flatMap((code) =>
        [1, 2, 3, 4].map((n) => grant(skuIds.get(code)!, ownerId(`burst-${n}`), 1)),
      );
      const outcomes = await Promise.allSettled(attempts);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled') as PromiseFulfilledResult<ReservationSnapshot>[];
      const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(12);
      expect(rejected).toHaveLength(12);
      for (const rejection of rejected) {
        expect(rejection.reason).toBeInstanceOf(ProblemException);
        expect((rejection.reason as ProblemException).getStatus()).toBe(409);
        expect(codeOf(rejection.reason)).toBe('unavailable');
      }
      // Per-SKU journal truth: exactly 2 held rows of 1 unit each — no oversell.
      for (const code of burstSkus) {
        const skuId = skuIds.get(code)!;
        const rows = await sql`
          select coalesce(sum(quantity), 0)::int as reserved from reservations
          where tenant_id = ${tenantId} and sku_id = ${skuId} and state = 'held'
        `;
        expect(Number((rows[0] as unknown as { reserved: number }).reserved)).toBe(2);
        const atp = await facade.atp(tenantId, warehouseId, skuId);
        expect(atp.atp).toBe(0);
      }
    },
    30_000,
  );

  it('commit: held→committed (one winner), units stay deducted until the ledger movement; second commit is a conflict', async () => {
    const skuId = skuIds.get('RSV-COMMIT')!;
    await seedStock(skuId, binA, 3);
    const granted = await grant(skuId, ownerId('commit'), 2);

    const committed = await facade.commitReservation(tenantId, granted.id);
    expect(committed.state).toBe('committed');
    expect(await reservationRow(granted.id)).toMatchObject({ state: 'committed' });

    // Committed units stay deducted: the counter is untouched by commit.
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(1);

    // Second commit: deterministic conflict (the conditional UPDATE found no held row).
    const second = await facade.commitReservation(tenantId, granted.id).then(
      () => {
        throw new Error('expected the second commit to reject');
      },
      (error: unknown) => error as ProblemException,
    );
    expect(second.getStatus()).toBe(409);
    expect(codeOf(second)).toBe('conflict');

    // Releasing a committed (non-held) row is the same deterministic conflict.
    const release = await facade.releaseReservation(tenantId, granted.id).then(
      () => {
        throw new Error('expected the release of a committed row to reject');
      },
      (error: unknown) => error as ProblemException,
    );
    expect(release.getStatus()).toBe(409);

    // An unknown id is 404, never a silent no-op.
    const missing = await facade.commitReservation(tenantId, uuidv7()).then(
      () => {
        throw new Error('expected the unknown reservation to reject');
      },
      (error: unknown) => error as ProblemException,
    );
    expect(missing.getStatus()).toBe(404);
  });

  it('terminal-transition serialization: two concurrent releases race — exactly one wins and the counter restores once', async () => {
    const skuId = skuIds.get('RSV-RELEASE')!;
    await seedStock(skuId, binA, 2);
    const granted = await grant(skuId, ownerId('rel'), 1);
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(1);

    const outcomes = await Promise.allSettled([
      facade.releaseReservation(tenantId, granted.id),
      facade.releaseReservation(tenantId, granted.id),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled') as PromiseFulfilledResult<ReservationSnapshot>[];
    const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ProblemException);
    expect((rejected[0]!.reason as ProblemException).getStatus()).toBe(409);

    // The journal is released; the counter restored exactly once (ATP back to 2).
    expect(await reservationRow(granted.id)).toMatchObject({ state: 'released' });
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(2);
  });

  it('release: a released hold restores the counter; a repeat release is a deterministic conflict', async () => {
    const skuId = skuIds.get('RSV-TTL')!;
    await seedStock(skuId, binA, 2);
    const granted = await grant(skuId, ownerId('rel2'), 1);
    const released = await facade.releaseReservation(tenantId, granted.id);
    expect(released.state).toBe('released');
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(2);
    await expectProblem(facade.releaseReservation(tenantId, granted.id), 409, 'conflict');
  });

  it('TTL reaper: a held row past TTL transitions to expired exactly once and restores the counter', async () => {
    const skuId = skuIds.get('RSV-TTL')!;
    const granted = await grant(skuId, ownerId('ttl'), 1, 0); // already due
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(1);

    expect(await facade.expireDueReservations()).toBe(1);
    expect(await reservationRow(granted.id)).toMatchObject({ state: 'expired' });
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(2);

    // The terminal transition serialized: a second cycle finds nothing to do.
    expect(await facade.expireDueReservations()).toBe(0);
    expect(await reservationRow(granted.id)).toMatchObject({ state: 'expired' });
  });

  it('quarantined scope: an open quarantine (sku, bin) excludes that on-hand from ATP — the flag now gates grants', async () => {
    const skuId = skuIds.get('RSV-Q')!;
    await seedStock(skuId, binA, 3);
    await seedStock(skuId, binB, 2);
    expect((await facade.atp(tenantId, warehouseId, skuId)).onHand).toBe(5);

    // An open quarantine on binA, exactly the row 2.2's reconcile path
    // produces (same table, same shape) — inserted through a tenant
    // transaction like every other tenant-scoped write.
    await withTenantTransaction(db, tenantId, (tx) =>
      tx.insert(inventoryQuarantines).values({
        id: uuidv7(),
        tenantId,
        warehouseId,
        skuId,
        binId: binA,
        fromSeq: 1,
        toSeq: 1,
        reason: 'repeated-divergence',
        status: 'open',
      }),
    );

    // binA's 3 units are excluded: ATP = 2, and granting over the remainder rejects.
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(2);
    const granted = await grant(skuId, ownerId('q'), 2);
    expect(granted.state).toBe('held');
    await expectProblem(grant(skuId, ownerId('q2'), 1), 409, 'unavailable');
  });

  it('divergence + rebuild: a lost counter fails grants closed, then the journal restores it (Postgres wins)', async () => {
    const skuId = skuIds.get('RSV-REBUILD')!;
    await seedStock(skuId, binA, 2);
    await grant(skuId, ownerId('rb'), 1);
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(1);

    const counterKey = `wms:{${tenantId}}:wh:${warehouseId}:res:${skuId}`;
    const readyKey = `wms:{${tenantId}}:wh:${warehouseId}:res:__ready__`;

    // Full mirror loss (a `docker compose restart valkey`): the ready marker
    // goes down with the counters — grants and ATP reads fail closed during
    // the gap, never oversell.
    await valkey.del(counterKey, readyKey);
    const duringGap = await facade.atp(tenantId, warehouseId, skuId).then(
      () => {
        throw new Error('expected the ATP read to fail closed during the rebuild gap');
      },
      (error: unknown) => error as ProblemException,
    );
    expect(duringGap.getStatus()).toBe(503);
    // The grant also fails closed — and its not-ready arm triggers (and waits
    // on) the journal rebuild, so the gap closes with the grant's rejection.
    await expectProblem(grant(skuId, ownerId('rb2'), 1), 409, 'unavailable');

    // The not-ready grant above triggered a rebuild from the journal —
    // Postgres won: the counter came back at the journal's live sum.
    const afterHeal = await facade.atp(tenantId, warehouseId, skuId);
    expect(afterHeal).toMatchObject({ onHand: 2, reserved: 1, atp: 1 });
    // And a follow-up grant now proceeds against the restored counter.
    const second = await grant(skuId, ownerId('rb3'), 1);
    expect(second.state).toBe('held');

    // Divergent (not missing) counter: Postgres wins on an explicit rebuild.
    await valkey.set(counterKey, '99');
    expect((await facade.atp(tenantId, warehouseId, skuId)).reserved).toBe(99);
    const report = await facade.rebuildReservationCounters(tenantId, warehouseId);
    expect(report).toHaveLength(1);
    expect(report[0]!.warehouseId).toBe(warehouseId);
    const rebuiltScope = report[0]!.scopes.find((scope) => scope.skuId === skuId);
    expect(rebuiltScope).toMatchObject({ reserved: 2 }); // held(1) + committed(0)… + the second hold = 2
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(0);
  });

  it('missing counter under a ready marker: healed from the journal before the read, then the grant proceeds', async () => {
    const skuId = skuIds.get('RSV-REBUILD')!;
    // Drop ONLY the counter (the ready marker stays armed — divergence).
    const counterKey = `wms:{${tenantId}}:wh:${warehouseId}:res:${skuId}`;
    await valkey.del(counterKey);
    expect((await facade.atp(tenantId, warehouseId, skuId)).reserved).toBe(2); // journal sum, not 0
    // The grant heals-then-decides: reserved(2) + 1 > ceiling(2) → unavailable.
    await expectProblem(grant(skuId, ownerId('rb4'), 1), 409, 'unavailable');
  });

  it('fail closed on an unreachable Valkey: grants 409 unavailable, ATP reads 503', async () => {
    const skuId = skuIds.get('RSV-HEALTHY')!;
    const valkeyClient = app.get(ValkeyClient);
    const grantSpy = jest.spyOn(valkeyClient, 'grantReservation').mockRejectedValue(new Error('connection refused'));
    try {
      await expectProblem(grant(skuId, ownerId('down'), 1), 409, 'unavailable');
      grantSpy.mockRestore();
      const readSpy = jest.spyOn(valkeyClient, 'isReady').mockRejectedValue(new Error('connection refused'));
      await expectProblem(facade.atp(tenantId, warehouseId, skuId), 503, 'unavailable');
      readSpy.mockRestore();
    } finally {
      jest.restoreAllMocks();
    }
    // Healthy again: the client was only mocked, the store untouched.
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(2); // 5 on-hand − (2 + 1) reserved
  });

  it('RLS: reservations are tenant-isolated and fail closed (the 0008/0009 hand-append pattern)', async () => {
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    let probe: ReturnType<typeof postgres> | undefined;
    try {
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742105)`;
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
      const probeUrl = new URL(process.env.DATABASE_URL!);
      probeUrl.username = 'wms_rls_probe';
      probeUrl.password = 'wms_rls_probe';
      probe = postgres(probeUrl.toString(), { max: 1 });

      // Scoped: the tenant's own rows are visible.
      const own = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        return tx`select id from reservations where tenant_id = ${tenantId}`;
      });
      expect(own.length).toBeGreaterThan(0);

      // A foreign tenant scope sees zero; no scope at all fails closed.
      const foreign = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
        return tx`select id from reservations where tenant_id = ${tenantId}`;
      });
      expect(foreign).toHaveLength(0);
      const unscoped = await probe`select id from reservations where tenant_id = ${tenantId}`;
      expect(unscoped).toHaveLength(0);

      // The write side fails closed too (the WITH CHECK arm).
      const foreignInsert = probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`
          insert into reservations (id, tenant_id, warehouse_id, sku_id, owner_type, owner_id, quantity, state, expires_at)
          values (${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 'probe', 'probe', 1, 'held', now())
        `;
      });
      await expect(foreignInsert).rejects.toThrow(/row-level security/i);
    } finally {
      await probe?.end();
      await admin.end();
    }
  });

  it('validation: a zero/negative quantity and an empty owner are rejected before any write', async () => {
    const skuId = skuIds.get('RSV-HEALTHY')!;
    await expectProblem(grant(skuId, ownerId('v'), 0), 400, 'validation-failed');
    await expectProblem(grant(skuId, ownerId('v'), -2), 400, 'validation-failed');
    await expectProblem(grant(skuId, '', 1), 400, 'validation-failed');
    const rows = await sql`
      select count(*)::int as n from reservations where tenant_id = ${tenantId} and owner_type = ''
    `;
    expect(Number((rows[0] as unknown as { n: number }).n)).toBe(0);
  });

  it('journal parity: the reserved counter always equals the live-state journal sum at rest', async () => {
    // A quiet-state invariant walk over every seeded scope (the rebuild's
    // contract, checked without a rebuild).
    for (const code of ['RSV-HEALTHY', 'RSV-RACE', 'RSV-REBUILD', 'RSV-COMMIT']) {
      const skuId = skuIds.get(code)!;
      const sums = await sql`
        select coalesce(sum(quantity), 0)::int as reserved from reservations
        where tenant_id = ${tenantId} and sku_id = ${skuId} and state in ('held','committed')
      `;
      const journal = Number((sums[0] as unknown as { reserved: number }).reserved);
      const atp = await facade.atp(tenantId, warehouseId, skuId);
      expect(atp.reserved).toBe(journal);
    }
  });
});