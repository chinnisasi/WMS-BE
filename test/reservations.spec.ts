import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
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
import { ReservationService } from '../src/modules/inventory/reservation.service';
import type { ReservationSnapshot } from '../src/modules/inventory/reservation.service';
import { ReservationReaper, parseReservationReaperPollMs } from '../src/jobs/jobs.module';

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
  'RSV-ADJ',
  'RSV-IDEM',
  'RSV-OWNER',
  'RSV-CORRECT',
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

  it('quantity-mismatch replay: a repeat grant with a different quantity is a deterministic 409 conflict', async () => {
    // Review loop 1 decision: a quantity-differing replay must never be a
    // success-shaped reply (a caller asking for 5 while holding 2 would
    // silently under-hold) — it is a 409 conflict against the held row.
    const skuId = skuIds.get('RSV-IDEM')!;
    await seedStock(skuId, binA, 3);
    const owner = ownerId('qty');
    expect((await grant(skuId, owner, 2)).state).toBe('held');
    await expectProblem(grant(skuId, owner, 1), 409, 'conflict');
    await expectProblem(grant(skuId, owner, 5), 409, 'conflict');
    // The held row and the counter are untouched by the rejected replays.
    const rows = await sql`
      select count(*)::int as n from reservations
      where tenant_id = ${tenantId} and owner_type = ${OWNER_TYPE} and owner_id = ${owner} and state = 'held'
    `;
    expect(Number((rows[0] as unknown as { n: number }).n)).toBe(1);
    expect((await facade.atp(tenantId, warehouseId, skuId)).reserved).toBe(2);
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
    // F11 (story 4.1): ttlSeconds 0 is no longer a valid hold (400) — age a
    // normally-granted hold past its TTL directly instead.
    const granted = await grant(skuId, ownerId('ttl'), 1);
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(1);
    await sql`update reservations set expires_at = now() - interval '1 second' where id = ${granted.id}`;

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
    // A8 (story 4.1): the store-down arm carries its own 503 machine code,
    // distinct from the deterministic 409 `unavailable` a losing grant gets.
    await expectProblem(grant(skuId, ownerId('rb2'), 1), 503, 'reservation-store-unavailable');

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

  it('fail closed on an unreachable Valkey: grants and ATP reads 503 reservation-store-unavailable (A8)', async () => {
    const skuId = skuIds.get('RSV-HEALTHY')!;
    const valkeyClient = app.get(ValkeyClient);
    const grantSpy = jest.spyOn(valkeyClient, 'grantReservation').mockRejectedValue(new Error('connection refused'));
    try {
      // A8 (story 4.1): a store-DOWN grant is 503 `reservation-store-
      // unavailable` (nothing written, retryable) — never the deterministic
      // 409 `unavailable` a losing grant receives.
      await expectProblem(grant(skuId, ownerId('down'), 1), 503, 'reservation-store-unavailable');
      grantSpy.mockRestore();
      const readSpy = jest.spyOn(valkeyClient, 'isReady').mockRejectedValue(new Error('connection refused'));
      await expectProblem(facade.atp(tenantId, warehouseId, skuId), 503, 'reservation-store-unavailable');
      readSpy.mockRestore();
    } finally {
      jest.restoreAllMocks();
    }
    // Healthy again: the client was only mocked, the store untouched.
    expect((await facade.atp(tenantId, warehouseId, skuId)).atp).toBe(2); // 5 on-hand − (2 + 1) reserved
  });

  it('boot rebuild: onModuleInit reseeds every counter from the journal with no explicit rebuild', async () => {
    // The startup contract, observed with non-empty state: the tenant's whole
    // Valkey keyspace goes down (a `docker compose restart valkey`), the
    // module's init hook re-runs, and ATP reads the journal-reseeded counters.
    const skuId = skuIds.get('RSV-HEALTHY')!;
    expect((await facade.atp(tenantId, warehouseId, skuId)).reserved).toBe(3);
    const keys = await valkey.keys(`wms:{${tenantId}}:*`);
    expect(keys.length).toBeGreaterThan(0);
    await valkey.del(...keys);
    expect(await facade.atp(tenantId, warehouseId, skuId).then(() => true, () => false)).toBe(false);

    await app.get(ReservationService).onModuleInit();

    const after = await facade.atp(tenantId, warehouseId, skuId);
    expect(after).toMatchObject({ onHand: 5, reserved: 3, atp: 2 });
  });

  it('a real closed socket rejects within a bounded window (the fail-closed contract, not a stub)', async () => {
    // A fresh client against a port nothing listens on: the command must
    // REJECT in bounded time (→ the caller's fail-closed arms), never hang,
    // never silently return a zero.
    const client = new ValkeyClient();
    const previous = process.env.VALKEY_URL;
    process.env.VALKEY_URL = 'redis://localhost:56999/0';
    try {
      const started = Date.now();
      await expect(client.grantReservation('wms:{t}:wh:{w}:res:s', 'wms:{t}:wh:{w}:res:__ready__', 1, 5, 60)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(15_000);
      await expect(client.isReady('wms:{t}:wh:{w}:res:__ready__')).rejects.toThrow();
    } finally {
      process.env.VALKEY_URL = previous;
      await client.onApplicationShutdown();
    }
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

  it('validation: zero/negative quantity, empty owner/scope ids and an absurd TTL are rejected before any write', async () => {
    const skuId = skuIds.get('RSV-HEALTHY')!;
    await expectProblem(grant(skuId, ownerId('v'), 0), 400, 'validation-failed');
    await expectProblem(grant(skuId, ownerId('v'), -2), 400, 'validation-failed');
    await expectProblem(grant(skuId, '', 1), 400, 'validation-failed');
    // Empty scope ids never reach `eq(uuid, '')` (a raw 22P02) — 400 up front.
    await expectProblem(
      facade.grantReservation({
        tenantId: '',
        warehouseId,
        skuId,
        ownerType: OWNER_TYPE,
        ownerId: ownerId('v'),
        quantity: 1,
      }),
      400,
      'validation-failed',
    );
    await expectProblem(
      facade.grantReservation({
        tenantId,
        warehouseId: '',
        skuId,
        ownerType: OWNER_TYPE,
        ownerId: ownerId('v'),
        quantity: 1,
      }),
      400,
      'validation-failed',
    );
    // ttlSeconds above the ten-year ceiling would poison the journal's
    // `expires_at` (an invalid date → raw 500 after compensating) — rejected.
    await expectProblem(grant(skuId, ownerId('v'), 1, 9e12), 400, 'validation-failed');
    // F11 (story 4.1): a zero-TTL hold expires the instant it is journalled —
    // it is an input error, 400, never a granted-then-doomed row.
    await expectProblem(grant(skuId, ownerId('v'), 1, 0), 400, 'validation-failed');
    const rows = await sql`
      select count(*)::int as n from reservations where tenant_id = ${tenantId} and owner_type = ''
    `;
    expect(Number((rows[0] as unknown as { n: number }).n)).toBe(0);
  });

  it('terminal transitions guard the id format: a non-uuid reservationId is the contract 404, not a driver error', async () => {
    await expectProblem(facade.commitReservation(tenantId, 'not-a-uuid'), 404, 'not-found');
    await expectProblem(facade.releaseReservation(tenantId, 'not-a-uuid'), 404, 'not-found');
    await expectProblem(facade.releaseReservation(tenantId, ''), 404, 'not-found');
  });

  it('concurrent same-owner grants: the unique-violation loser re-probes and collapses into the winner', async () => {
    // Several concurrent grants for ONE owner scope: at most two scripts can
    // win (ceiling 2), so the second journal INSERT races the first — the
    // unique-violation loser compensates its decrement and re-probes. Every
    // interleave converges to: fulfilled grants share one id, rejects are the
    // deterministic `unavailable`, and exactly one held row mirrors one unit.
    const skuId = skuIds.get('RSV-OWNER')!;
    await seedStock(skuId, binA, 2);
    const owner = ownerId('concurrent');
    const outcomes = await Promise.allSettled([
      grant(skuId, owner, 1),
      grant(skuId, owner, 1),
      grant(skuId, owner, 1),
      grant(skuId, owner, 1),
    ]);
    const fulfilled = outcomes.filter(
      (o): o is PromiseFulfilledResult<ReservationSnapshot> => o.status === 'fulfilled',
    );
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const winner of fulfilled) {
      expect(winner.value.id).toBe(fulfilled[0]!.value.id);
    }
    for (const loser of rejected) {
      expect((loser.reason as ProblemException).getStatus()).toBe(409);
      expect(codeOf(loser.reason)).toBe('unavailable');
    }
    const rows = await sql`
      select count(*)::int as n, coalesce(sum(quantity), 0)::int as q from reservations
      where tenant_id = ${tenantId} and owner_type = ${OWNER_TYPE} and owner_id = ${owner} and state = 'held'
    `;
    const row = rows[0] as unknown as { n: number; q: number };
    expect(Number(row.n)).toBe(1);
    expect(Number(row.q)).toBe(1);
    // The compensated decrement never lingers: counter mirrors the journal.
    const atp = await facade.atp(tenantId, warehouseId, skuId);
    expect(atp).toMatchObject({ onHand: 2, reserved: 1, atp: 1 });
  });

  it('rebuild correction pass: a hold whose journal lands after the rebuild’s first read is not lost', async () => {
    // The residual race, forced deterministically: the grant's script wins,
    // then the rebuild's first journal read happens WITHOUT the row, and the
    // row only commits during the first-pass counter write — the correction
    // read must re-grow the counter to the journal (Postgres wins).
    const skuId = skuIds.get('RSV-CORRECT')!;
    await seedStock(skuId, binA, 2);
    // Arm the scope's counter at its seeded 0 first (an explicit rebuild), so
    // the grant below decides on the script directly instead of taking the
    // missing-counter heal arm — the spies are installed only after that.
    await facade.rebuildReservationCounters(tenantId, warehouseId);
    const client = app.get(ValkeyClient);
    const owner = ownerId('corr');

    let releaseGrant: (() => void) | undefined;
    let scriptWon = false;
    const grantGate = new Promise<void>((resolve) => {
      releaseGrant = resolve;
    });
    const grantSpy = jest
      .spyOn(client, 'grantReservation')
      .mockImplementation(async (...args: Parameters<ValkeyClient['grantReservation']>) => {
        const reply = await ValkeyClient.prototype.grantReservation.apply(client, args);
        if (reply[0] === 1) {
          scriptWon = true;
          await grantGate; // hold the winner between script win and journal insert
        }
        return reply;
      });
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const heldCount = async (): Promise<number> => {
      const rows = await sql`
        select count(*)::int as n from reservations
        where tenant_id = ${tenantId} and sku_id = ${skuId} and owner_id = ${owner} and state = 'held'
      `;
      return Number((rows[0] as unknown as { n: number }).n);
    };
    const setCounterSpy = jest
      .spyOn(client, 'setCounter')
      .mockImplementation(async (...args: Parameters<ValkeyClient['setCounter']>) => {
        await ValkeyClient.prototype.setCounter.apply(client, args);
        if (releaseGrant === undefined) {
          return; // only the FIRST pass write gates the in-flight grant
        }
        releaseGrant();
        releaseGrant = undefined;
        // Wait until the released grant's journal row has committed, so the
        // rebuild's correction read is guaranteed to see it.
        const gateDeadline = Date.now() + 5_000;
        while ((await heldCount()) < 1) {
          if (Date.now() > gateDeadline) {
            throw new Error('the granted hold never landed in the journal');
          }
          await delay(10);
        }
      });

    const grantPromise = grant(skuId, owner, 1);
    const deadline = Date.now() + 2_000;
    while (!scriptWon && Date.now() < deadline) {
      await delay(5);
    }
    expect(scriptWon).toBe(true); // the script won BEFORE the rebuild disarms

    await facade.rebuildReservationCounters(tenantId, warehouseId);
    const granted = await grantPromise;
    expect(granted.state).toBe('held');
    grantSpy.mockRestore();
    setCounterSpy.mockRestore();

    // The correction pass restored the hold: the counter equals the journal.
    const after = await facade.atp(tenantId, warehouseId, skuId);
    expect(after).toMatchObject({ onHand: 2, reserved: 1, atp: 1 });
  });

  it('adjustment committing mid-grant: the grant reads a committed projection and ATP never exceeds on-hand − reserved', async () => {
    // The I/O matrix's interleave row: a `stock.adjusted` commit racing a
    // grant. The grant's ceiling is a committed read, so whichever order
    // commits, the post-state invariant holds — ATP is exactly
    // max(0, on-hand − reserved − hooks), never negative, never oversold.
    const skuId = skuIds.get('RSV-ADJ')!;
    await seedStock(skuId, binA, 5);
    const [grantOutcome, adjustOutcome] = await Promise.allSettled([
      grant(skuId, ownerId('adj'), 2),
      seedStock(skuId, binA, -4), // 5 on-hand → 1, racing the grant's decision
    ]);
    // The adjustment itself must settle successfully in either interleave —
    // the speculative-tuple clamp keeps the non-negative CHECK off the UPDATE
    // arm — so its own failure is named, never swallowed.
    if (adjustOutcome!.status === 'rejected') {
      throw (adjustOutcome as PromiseRejectedResult).reason;
    }
    // Either interleave is a valid outcome; the invariant below pins both.
    // Wait (bounded) for the adjustment's commit to land before asserting —
    // the grant's own decision is already settled by then.
    let atp = await facade.atp(tenantId, warehouseId, skuId);
    const deadline = Date.now() + 5_000;
    while (atp.onHand !== 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      atp = await facade.atp(tenantId, warehouseId, skuId);
    }
    expect(atp.onHand).toBe(1);
    expect(atp.qcHeld).toBe(0);
    expect(atp.buffer).toBe(0);
    // The invariant, for either interleave:
    // - adjustment first: ceiling 1 → the grant lost; reserved 0, ATP 1.
    // - grant first: reserved 2 over the reduced on-hand; ATP clamps at 0
    //   (fail-safe: sellable zero, never oversell).
    if (grantOutcome!.status === 'fulfilled') {
      expect(atp).toMatchObject({ onHand: 1, reserved: 2, atp: 0 });
    } else {
      expect(atp).toMatchObject({ onHand: 1, reserved: 0, atp: 1 });
    }
    // Journal parity across the interleave: the counter mirrors the journal.
    const sums = await sql`
      select coalesce(sum(quantity), 0)::int as reserved from reservations
      where tenant_id = ${tenantId} and sku_id = ${skuId} and state in ('held','committed')
    `;
    expect(atp.reserved).toBe(Number((sums[0] as unknown as { reserved: number }).reserved));
  });

  it('journal parity: the reserved counter always equals the live-state journal sum at rest', async () => {
    // A quiet-state invariant walk over every seeded scope (the rebuild's
    // contract, checked without a rebuild).
    for (const code of ['RSV-HEALTHY', 'RSV-RACE', 'RSV-REBUILD', 'RSV-COMMIT', 'RSV-IDEM', 'RSV-OWNER', 'RSV-CORRECT']) {
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

  it('parity pass: the reaper cycle detects a present-but-wrong counter and rebuilds it from the journal', async () => {
    // The scheduled repair trigger (review loop 1 decision): a divergent
    // counter that is PRESENT — invisible to the missing-counter heal — is
    // repaired toward Postgres by the next reaper cycle.
    const skuId = skuIds.get('RSV-REBUILD')!;
    const counterKey = `wms:{${tenantId}}:wh:${warehouseId}:res:${skuId}`;
    expect((await facade.atp(tenantId, warehouseId, skuId)).reserved).toBe(2); // quiet before
    await valkey.set(counterKey, '99');

    expect(await facade.expireDueReservations()).toBe(0); // nothing due — the parity pass ran

    const after = await facade.atp(tenantId, warehouseId, skuId);
    expect(after).toMatchObject({ onHand: 2, reserved: 2, atp: 0 }); // journal sum, not 99
  });

  it('0009 CHECK constraints: a bogus state and a zero quantity are rejected by the database (23514)', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const stateProbe = sql`
      insert into reservations (id, tenant_id, warehouse_id, sku_id, owner_type, owner_id, quantity, state, expires_at)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuIds.get('RSV-HEALTHY')!}, 'probe', 'probe-state', 1, 'bogus', ${expiresAt})
    `;
    await expect(stateProbe).rejects.toMatchObject({ code: '23514' });
    const qtyProbe = sql`
      insert into reservations (id, tenant_id, warehouse_id, sku_id, owner_type, owner_id, quantity, state, expires_at)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuIds.get('RSV-HEALTHY')!}, 'probe', 'probe-qty', 0, 'held', ${expiresAt})
    `;
    await expect(qtyProbe).rejects.toMatchObject({ code: '23514' });
  });

  it('journal wins when the mirror fails: a release/ expiry restore rejection is swallowed', async () => {
    const skuId = skuIds.get('RSV-RELEASE')!;
    await seedStock(skuId, binA, 2);
    const client = app.get(ValkeyClient);
    const spy = jest.spyOn(client, 'releaseReservation').mockRejectedValue(new Error('connection refused'));
    try {
      // Release: the conditional UPDATE commits (journal is truth) and the
      // failed counter restore is swallowed — the caller still gets the
      // journal-committed snapshot, never a raw error.
      const released = await grant(skuId, ownerId('rf'), 1);
      await expect(facade.releaseReservation(tenantId, released.id)).resolves.toMatchObject({
        state: 'released',
      });
      // Expiry: the same resilience on the reaper's restore arm (F11 —
      // ttlSeconds 0 is no longer grantable, so age the hold directly).
      const dueGrant = await grant(skuId, ownerId('rf2'), 1);
      await sql`update reservations set expires_at = now() - interval '1 second' where id = ${dueGrant.id}`;
      await expect(facade.expireDueReservations()).resolves.toBe(1);
      expect(await reservationRow(dueGrant.id)).toMatchObject({ state: 'expired' });
    } finally {
      spy.mockRestore();
    }
    // With the mirror healthy again: the failed restores left the counter
    // OVER-counted (the fail-safe direction — ATP understated, never
    // oversold). RSV-RELEASE has no live rows left, so the parity pass (which
    // walks the journal's live scopes) does not re-seed it here — a rebuild
    // does; the journal-committed results above are what the caller saw.
    const sums = await sql`
      select coalesce(sum(quantity), 0)::int as reserved from reservations
      where tenant_id = ${tenantId} and sku_id = ${skuId} and state in ('held','committed')
    `;
    expect(Number((sums[0] as unknown as { reserved: number }).reserved)).toBe(0); // journal truth
    const atp = await facade.atp(tenantId, warehouseId, skuId);
    expect(atp.atp).toBeLessThanOrEqual(atp.onHand - atp.qcHeld - atp.buffer); // never oversells
    expect(atp.reserved).toBeGreaterThanOrEqual(0);
  });
});

describe('reservation reaper plumbing (unit, story 2.3)', () => {
  const ENV_KEY = 'RESERVATION_REAPER_POLL_MS';

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

  describe('parseReservationReaperPollMs', () => {
    it('unset and empty are off (0)', () => {
      expect(parseReservationReaperPollMs(undefined)).toBe(0);
      expect(parseReservationReaperPollMs('')).toBe(0);
    });

    it('non-negative integers pass through (0 included)', () => {
      expect(parseReservationReaperPollMs('2000')).toBe(2000);
      expect(parseReservationReaperPollMs('0')).toBe(0);
    });

    it('anything not a non-negative integer fails the boot loudly', () => {
      expect(() => parseReservationReaperPollMs('soon')).toThrow(/RESERVATION_REAPER_POLL_MS/);
      expect(() => parseReservationReaperPollMs('1.5')).toThrow(/RESERVATION_REAPER_POLL_MS/);
      expect(() => parseReservationReaperPollMs('-5')).toThrow(/RESERVATION_REAPER_POLL_MS/);
    });
  });

  describe('ReservationReaper', () => {
    it('an invalid env fails the constructor (loud boot, not a silent worker)', () => {
      for (const bad of ['soon', '1.5', '-5']) {
        setEnv(bad);
        expect(() => new ReservationReaper(stubFacade() as never)).toThrow(
          /RESERVATION_REAPER_POLL_MS/,
        );
      }
    });

    it('pollMs=0 (env unset) schedules nothing', async () => {
      setEnv(undefined);
      const facade = stubFacade();
      const reaper = new ReservationReaper(facade as never);
      reaper.onApplicationBootstrap();
      await delay(60);
      expect(facade.calls).toHaveLength(0);
      reaper.onApplicationShutdown();
    });

    it('bootstrap with a poll interval drives expireDueReservations on the timer', async () => {
      setEnv('20');
      const facade = stubFacade();
      const reaper = new ReservationReaper(facade as never);
      reaper.onApplicationBootstrap();
      try {
        await waitFor(() => facade.calls.length >= 2);
      } finally {
        reaper.onApplicationShutdown();
      }
    });

    it('an in-flight cycle sheds the next ticks until it settles', async () => {
      setEnv('15');
      const facade = stubFacade();
      facade.hold = true;
      const reaper = new ReservationReaper(facade as never);
      reaper.onApplicationBootstrap();
      try {
        await waitFor(() => facade.calls.length === 1);
        await delay(60);
        expect(facade.calls).toHaveLength(1);
        facade.release();
        await waitFor(() => facade.calls.length >= 2);
      } finally {
        facade.release();
        reaper.onApplicationShutdown();
      }
    });

    it('a failing cycle is logged and the next tick still drives expireDueReservations', async () => {
      setEnv('15');
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const calls: number[] = [];
      const failing = {
        async expireDueReservations(): Promise<number> {
          calls.push(calls.length);
          throw new Error('boom');
        },
      };
      const reaper = new ReservationReaper(failing as never);
      reaper.onApplicationBootstrap();
      try {
        await waitFor(() => calls.length >= 1);
        // The failure surfaces loudly.
        expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
          'Reservation reaper cycle failed: boom',
        );
        // The failure does not wedge the loop — the next tick drives again.
        await waitFor(() => calls.length >= 2);
      } finally {
        reaper.onApplicationShutdown();
        errorSpy.mockRestore();
      }
    });

    it('shutdown clears the timer (no further cycles)', async () => {
      setEnv('15');
      const facade = stubFacade();
      const reaper = new ReservationReaper(facade as never);
      reaper.onApplicationBootstrap();
      await waitFor(() => facade.calls.length >= 1);
      reaper.onApplicationShutdown();
      const atShutdown = facade.calls.length;
      await delay(80);
      expect(facade.calls.length).toBe(atShutdown);
    });

    /** A facade stub recording reaper cycles, able to hold one in flight. */
    function stubFacade(): {
      calls: number[];
      hold: boolean;
      expireDueReservations(): Promise<number>;
      release(): void;
    } {
      const calls: number[] = [];
      let held: (() => void) | undefined;
      return {
        calls,
        hold: false,
        async expireDueReservations() {
          calls.push(calls.length);
          if (this.hold && held === undefined) {
            await new Promise<void>((resolve) => {
              held = resolve;
            });
          }
          return 0;
        },
        release() {
          held?.();
          held = undefined;
        },
      };
    }
  });
});
