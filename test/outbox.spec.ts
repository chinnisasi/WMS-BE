import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import {
  outboxBackoffMs,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_OPERATOR_REPLAY_SQL,
  PostgresOutboxRelay,
} from '../src/shared/events/outbox';
import type { DomainEvent, EventBus } from '../src/shared/events/event-bus.seam';

// The e2e suite talks to the real Postgres (docker-compose dev DB by default;
// CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
// A host that exports a poll interval would boot the relay worker and race
// these tests for the same rows — the suite drives `drain()` itself.
delete process.env.OUTBOX_RELAY_POLL_MS;

const IDENTITY_URL = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/**
 * The outbox substrate and relay (story outbox-relay) — the repo's first
 * event-observation test: a recording fake EVENT_BUS proves delivery, while
 * the rows themselves prove the in-transaction append, replay suppression,
 * the retry/quarantine state machine, and the RLS isolation.
 */
class RecordingEventBus implements EventBus {
  readonly events: DomainEvent[] = [];
  /** Event types the fake bus throws for (the "bus down" arm). */
  failOn = new Set<string>();

  async publish(event: DomainEvent): Promise<void> {
    if (this.failOn.has(event.type)) {
      throw new Error(`bus down for ${event.type}`);
    }
    this.events.push(event);
  }

  subscribe(): void {
    // Recording fake: no subscribers.
  }
}

interface OutboxRow {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  status: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
}

describe('transactional outbox substrate and relay (e2e, story outbox-relay)', () => {
  let app: INestApplication;
  let db: Database;
  let authDb: Database;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    // Same deployment-parity probes as the sibling suites (auth + RLS roles,
    // serialized across parallel jest workers by the advisory lock).
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
    db = app.get<unknown>(DATABASE) as Database;
    authDb = app.get<unknown>(AUTH_DATABASE) as Database;
  });

  afterAll(async () => {
    await cleanupRows();
    await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
    await (authDb as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
    await app.close();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // The outbox first: the relay worker is env-gated OFF in tests, so the
      // suites' own outbox rows are still here and must not linger.
      await sql.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await sql.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await sql.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await sql.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await sql.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
    } finally {
      await sql.end();
    }
  }

  /** The admin (superuser) connection sees every tenant — RLS never binds. */
  async function outboxRowsFor(tenantId: string): Promise<OutboxRow[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      return (await sql`
        select id, tenant_id as "tenantId", type, payload,
               occurred_at::text as "occurredAt",
               status, attempts,
               next_attempt_at::text as "nextAttemptAt",
               last_error as "lastError"
        from outbox_messages
        where tenant_id = ${tenantId}
        order by created_at asc, id asc
      `) as unknown as OutboxRow[];
    } finally {
      await sql.end();
    }
  }

  /**
   * Seed one row directly (the drain mechanics do not need a real command
   * behind every row): `createdAgoMs` spaces the rows so the (created_at, id)
   * drain order is unambiguous; the row is due on arrival unless overridden.
   */
  async function seedOutboxRow(
    tenantId: string,
    type: string,
    createdAgoMs = 0,
    overrides: { attempts?: number; dueInPastMs?: number } = {},
  ): Promise<string> {
    const id = uuidv7();
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`
        insert into outbox_messages
          (id, tenant_id, type, payload, occurred_at, status, attempts, next_attempt_at)
        values (
          ${id}, ${tenantId}, ${type},
          ${sql.json({ kind: 'seeded', marker: ulid() })},
          now(),
          'pending',
          ${overrides.attempts ?? 0},
          now() - ${`${overrides.dueInPastMs ?? 1_000} milliseconds`}::interval
        )
      `;
      if (createdAgoMs !== 0) {
        await sql`
          update outbox_messages
          set created_at = now() - ${`${createdAgoMs} milliseconds`}::interval
          where id = ${id}
        `;
      }
      return id;
    } finally {
      await sql.end();
    }
  }

  async function makeRowDue(rowId: string): Promise<void> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`update outbox_messages set next_attempt_at = now() - ${'1 second'}::interval where id = ${rowId}`;
    } finally {
      await sql.end();
    }
  }

  function newRelay(bus: EventBus): PostgresOutboxRelay {
    return new PostgresOutboxRelay(db, authDb, bus);
  }

  /**
   * The row's `next_attempt_at` was stamped `outboxBackoffMs(attempts)` after
   * markFailed's clock reading; assert the delta against the computed budget
   * with generous read-back slack (a loaded runner can lag the write) — a
   * wrong exponent still fails one of the two bounds.
   */
  function expectBackoff(nextAttemptAt: string, attempts: number): void {
    const backoff = outboxBackoffMs(attempts);
    const nextAt = new Date(nextAttemptAt).getTime();
    expect(nextAt).toBeLessThanOrEqual(Date.now() + backoff);
    expect(nextAt).toBeGreaterThan(Date.now() + backoff - 5_000);
  }

  it('a committing command leaves exactly one pending row in the same commit (registration)', async () => {
    const key = ulid();
    const email = `owner-outbox-${ulid().toLowerCase()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(IDENTITY_URL)
      .set(KEY_HEADER, key)
      .send({ name: 'Outbox Spices', ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    const tenantId = res.body.tenant.id as string;
    createdTenantIds.push(tenantId);

    const rows = await outboxRowsFor(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'tenant.registered',
      status: 'pending',
      attempts: 0,
    });
    expect(rows[0]!.payload).toEqual({ name: 'Outbox Spices', ownerEmail: email });
    expect(Number.isNaN(Date.parse(rows[0]!.occurredAt))).toBe(false);
  });

  it('an idempotent replay — registration and the users command — writes no second outbox row', async () => {
    // Registration replay (same key, same payload): snapshot re-served.
    const key = ulid();
    const email = `owner-replay-${ulid().toLowerCase()}@example.com`;
    const body = { name: 'Replay Spices', ownerEmail: email, password: 'correct-horse-battery' };
    const first = await request(app.getHttpServer())
      .post(IDENTITY_URL)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);
    const tenantId = first.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const replay = await request(app.getHttpServer())
      .post(IDENTITY_URL)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);
    expect(replay.body).toEqual(first.body);

    // The users command (retro item 3): the same-key invite replay returns
    // the snapshot and writes NO second outbox row.
    const signIn = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/sign-in`)
      .send({ email, password: 'correct-horse-battery' })
      .expect(200);
    const token = signIn.body.accessToken as string;

    const inviteKey = ulid();
    const inviteBody = { email: `teammate-${ulid().toLowerCase()}@example.com`, role: 'operator' };
    const invite1 = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/users`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, inviteKey)
      .send(inviteBody)
      .expect(201);
    const invite2 = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/users`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, inviteKey)
      .send(inviteBody)
      .expect(201);
    expect(invite2.body).toEqual(invite1.body);

    const rows = await outboxRowsFor(tenantId);
    expect(rows.map((row) => row.type)).toEqual(['tenant.registered', 'user.invited']);
    expect(rows.filter((row) => row.type === 'user.invited')).toHaveLength(1);
  });

  it('the relay drains oldest-first and deletes on ack; a re-drain publishes nothing', async () => {
    const tenantId = uuidv7();
    createdTenantIds.push(tenantId);
    const first = await seedOutboxRow(tenantId, 'e.one', 3_000);
    const second = await seedOutboxRow(tenantId, 'e.two', 2_000);
    const third = await seedOutboxRow(tenantId, 'e.three', 1_000);

    const bus = new RecordingEventBus();
    const published = (await newRelay(bus).drain(1_000)).filter(
      (message) => message.tenantId === tenantId,
    );
    expect(published.map((message) => message.messageId)).toEqual([first, second, third]);
    // The relayed event id IS the outbox row id (correlation), payload rides.
    expect(bus.events.find((event) => event.eventId === first)).toMatchObject({
      type: 'e.one',
      tenantId,
    });

    // Delete-on-ack: the drained rows are gone.
    expect(await outboxRowsFor(tenantId)).toHaveLength(0);

    // At-least-once (no delivery cursors): a re-drain is a no-op.
    const again = await newRelay(new RecordingEventBus()).drain(1_000);
    expect(again.filter((message) => message.tenantId === tenantId)).toHaveLength(0);
  });

  it('drain(limit) is bounded', async () => {
    const tenantId = uuidv7();
    createdTenantIds.push(tenantId);
    const ids = [
      await seedOutboxRow(tenantId, 'e.bounded', 3_000),
      await seedOutboxRow(tenantId, 'e.bounded', 2_000),
      await seedOutboxRow(tenantId, 'e.bounded', 1_000),
    ];
    // Other suites' pending rows may share this drain's budget (discovery is
    // cross-tenant by design) — the bound itself is what must hold: this
    // tenant contributes at most 2 rows, in (created_at, id) order.
    const published = (await newRelay(new RecordingEventBus()).drain(2)).filter(
      (message) => message.tenantId === tenantId,
    );
    expect(published.length).toBeLessThanOrEqual(2);
    expect(published.map((message) => message.messageId)).toEqual(ids.slice(0, published.length));
    const remaining = (await outboxRowsFor(tenantId)).map((row) => row.id);
    expect(remaining).toEqual(ids.slice(published.length));
  });

  it('a throwing bus re-drains after backoff with attempts and last_error recorded; later rows still drain', async () => {
    const tenantId = uuidv7();
    createdTenantIds.push(tenantId);
    const failing = await seedOutboxRow(tenantId, 'boom.event', 2_000);
    const healthy = await seedOutboxRow(tenantId, 'fine.event', 1_000);

    const bus = new RecordingEventBus();
    bus.failOn = new Set(['boom.event']);
    const published = (await newRelay(bus).drain(1_000)).filter((m) => m.tenantId === tenantId);
    expect(published.map((message) => message.messageId)).toEqual([healthy]);

    const failed = (await outboxRowsFor(tenantId)).find((row) => row.id === failing)!;
    expect(failed.status).toBe('pending');
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toContain('bus down for boom.event');
    expectBackoff(failed.nextAttemptAt, 1); // ~5s backoff

    // Force the row due again: the next failure doubles the backoff (10s).
    await makeRowDue(failing);
    const bus2 = new RecordingEventBus();
    bus2.failOn = new Set(['boom.event']);
    expect(
      (await newRelay(bus2).drain(1_000)).filter((m) => m.tenantId === tenantId),
    ).toHaveLength(0);
    const afterSecond = (await outboxRowsFor(tenantId)).find((row) => row.id === failing)!;
    expect(afterSecond.attempts).toBe(2);
    expectBackoff(afterSecond.nextAttemptAt, 2); // ~10s backoff
    expect(await outboxRowsFor(tenantId)).toHaveLength(1); // only the failed row remains
  });

  it('rows past the retry budget quarantine, and only operator replay re-drains them', async () => {
    const tenantId = uuidv7();
    createdTenantIds.push(tenantId);
    const id = await seedOutboxRow(tenantId, 'boom.quarantine', 1_000, {
      attempts: OUTBOX_MAX_ATTEMPTS - 1,
    });

    const bus = new RecordingEventBus();
    bus.failOn = new Set(['boom.quarantine']);
    expect(
      (await newRelay(bus).drain(1_000)).filter((m) => m.tenantId === tenantId),
    ).toHaveLength(0);

    const quarantined = (await outboxRowsFor(tenantId)).find((row) => row.id === id)!;
    expect(quarantined.status).toBe('quarantined');
    expect(quarantined.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(quarantined.lastError).toContain('bus down for boom.quarantine');

    // The quarantine exits the drain directly (the status = 'pending' filter,
    // not the clock): force the row due and prove no cycle picks it up.
    await makeRowDue(id);
    expect(
      (await newRelay(new RecordingEventBus()).drain(1_000)).filter(
        (m) => m.tenantId === tenantId,
      ),
    ).toHaveLength(0);
    expect((await outboxRowsFor(tenantId)).find((row) => row.id === id)!.status).toBe('quarantined');

    // A quarantined row re-drains only by operator action (the documented SQL).
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const replayed = await sql.unsafe(OUTBOX_OPERATOR_REPLAY_SQL, [id]);
      expect(replayed.count).toBe(1);
    } finally {
      await sql.end();
    }
    const reset = (await outboxRowsFor(tenantId)).find((row) => row.id === id)!;
    expect(reset.status).toBe('pending');
    expect(reset.attempts).toBe(0);

    // The next cycle delivers it like any pending row.
    const published = (await newRelay(new RecordingEventBus()).drain(1_000)).filter(
      (m) => m.tenantId === tenantId,
    );
    expect(published.map((message) => message.messageId)).toEqual([id]);
    expect(await outboxRowsFor(tenantId)).toHaveLength(0);
  });

  it('two concurrent drain cycles serialize on the advisory lock and never publish an event twice', async () => {
    const tenantId = uuidv7();
    createdTenantIds.push(tenantId);
    const ids = [
      await seedOutboxRow(tenantId, 'e.concurrent', 2_000),
      await seedOutboxRow(tenantId, 'e.concurrent', 1_000),
    ];

    const bus = new RecordingEventBus();
    const relay = newRelay(bus);
    const [a, b] = await Promise.all([relay.drain(1_000), relay.drain(1_000)]);
    const mine = [...a, ...b].filter((message) => message.tenantId === tenantId);
    // Each row publishes exactly once across both cycles (one cycle sheds).
    expect(mine.map((message) => message.messageId).sort()).toEqual([...ids].sort());
    const eventIds = bus.events
      .filter((event) => event.tenantId === tenantId)
      .map((event) => event.eventId);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(await outboxRowsFor(tenantId)).toHaveLength(0);
  });

  it('every command appends its event in the same commit (the other nine types)', async () => {
    const Bearer = (t: string) => ['Authorization', `Bearer ${t}`] as const;
    // --- tenancy structure ---
    const registered = await request(app.getHttpServer())
      .post(IDENTITY_URL)
      .set(KEY_HEADER, ulid())
      .send({ name: 'Nine Events Spices', ownerEmail: `owner-nine-${ulid().toLowerCase()}@example.com`, password: 'correct-horse-battery' })
      .expect(201);
    const tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const signedIn = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/sign-in`)
      .send({ email: registered.body.owner.email as string, password: 'correct-horse-battery' })
      .expect(200);
    const [scheme, token] = Bearer(signedIn.body.accessToken as string);

    // warehouse.created
    const warehouse = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set(scheme, token)
      .set(KEY_HEADER, ulid())
      .send({ code: 'WH-9', name: 'Nine Warehouse' })
      .expect(201);
    const warehouseId = warehouse.body.id as string;
    expect(warehouse.body.code).toBe('WH-9');

    // zone.created
    const zone = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set(scheme, token)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    const zoneId = zone.body.id as string;

    // bins.generated
    const grid = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins/grid`)
      .set(scheme, token)
      .set(KEY_HEADER, ulid())
      .send({ aisleFrom: 'A', aisleTo: 'A', baysPerAisle: 1, levelsPerBay: 1, capacity: 100, type: 'pallet' })
      .expect(201);
    expect(grid.body.generatedCount).toBe(1);
    const binId = (
      await request(app.getHttpServer())
        .get(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set(scheme, token)
        .expect(200)
    ).body.items[0].id as string;

    // bin.blocked
    await request(app.getHttpServer())
      .patch(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/bins/${binId}`)
      .set(scheme, token)
      .set(KEY_HEADER, ulid())
      .send({ blocked: true })
      .expect(200);

    // --- catalog: catalog.imported, catalog.sku_edited ---
    const csv = Buffer.from(
      ['sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode']
        .concat(['SKU-9,Outbox Turmeric,pcs,,500,,false,false,5,10,'])
        .join('\n'),
      'utf8',
    );
    const imported = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/catalog/imports`)
      .set(scheme, token)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', csv, { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const skuId = (
      await request(app.getHttpServer())
        .get(`${IDENTITY_URL}/${tenantId}/catalog/skus`)
        .set(scheme, token)
        .expect(200)
    ).body.items[0].id as string;
    await request(app.getHttpServer())
      .patch(`${IDENTITY_URL}/${tenantId}/catalog/skus/${skuId}`)
      .set(scheme, token)
      .set(KEY_HEADER, ulid())
      .send({ barcode: 'OUTBOX-BARCODE-9' })
      .expect(200);

    // --- inventory: stock.adjusted (business time rides on the event) ---
    const adjusted = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/inventory/adjustments`)
      .set(scheme, token)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId,
        quantityDelta: 5,
        reasonCode: 'cycle-count',
        note: 'outbox row assertion',
      })
      .expect(201);
    const adjustedEvent = adjusted.body.event as { id: string; seq: number; occurredAt: string };

    // --- users: user.invited, user.accepted, user.role_changed ---
    const inviteeEmail = `invitee-nine-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/users`)
      .set(scheme, token)
      .set(KEY_HEADER, ulid())
      .send({ email: inviteeEmail, role: 'operator' })
      .expect(201);
    const inviteeId = invited.body.user.id as string;
    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken, password: 'invitee-password-1' })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`${IDENTITY_URL}/${tenantId}/users/${inviteeId}`)
      .set(scheme, token)
      .set(KEY_HEADER, ulid())
      .send({ role: 'ops_manager' })
      .expect(200);

    const rows = await outboxRowsFor(tenantId);
    expect(rows.map((row) => row.type)).toEqual([
      'tenant.registered',
      'warehouse.created',
      'zone.created',
      'bins.generated',
      'bin.blocked',
      'catalog.imported',
      'catalog.sku_edited',
      'stock.adjusted',
      'user.invited',
      'user.accepted',
      'user.role_changed',
    ]);
    const byType = new Map(rows.map((row) => [row.type, row]));
    expect(byType.get('warehouse.created')).toMatchObject({ tenantId, attempts: 0 });
    expect(byType.get('warehouse.created')!.payload).toMatchObject({
      warehouseId,
      code: 'WH-9',
      name: 'Nine Warehouse',
    });
    expect(byType.get('zone.created')!.payload).toMatchObject({
      zoneId,
      warehouseId,
      code: 'A',
    });
    expect(byType.get('bins.generated')!.payload).toMatchObject({
      warehouseId,
      zoneId,
      count: 1,
      firstCode: 'A-01-01',
      lastCode: 'A-01-01',
    });
    expect(byType.get('bin.blocked')!.payload).toMatchObject({
      binId,
      warehouseId,
      blocked: true,
    });
    expect(byType.get('catalog.imported')!.payload).toMatchObject({
      importId: imported.body.importId,
      mode: 'initial',
      committedRows: 1,
      failedRows: 0,
    });
    expect(byType.get('catalog.sku_edited')!.payload).toMatchObject({
      skuId,
      code: 'SKU-9',
    });
    const adjustedRow = byType.get('stock.adjusted')!;
    expect(adjustedRow.payload).toMatchObject({
      warehouseId,
      skuId,
      binId,
      quantityDelta: 5,
      seq: adjustedEvent.seq,
      eventId: adjustedEvent.id,
    });
    // Business time: the event's occurredAt is the adjustment's ledger time,
    // not the relay's publish clock.
    expect(Date.parse(adjustedRow.occurredAt)).toBe(Date.parse(adjustedEvent.occurredAt));
    expect(byType.get('user.invited')!.payload).toMatchObject({
      userId: inviteeId,
      email: inviteeEmail,
      role: 'operator',
    });
    expect(byType.get('user.accepted')!.payload).toMatchObject({
      userId: inviteeId,
      email: inviteeEmail,
    });
    expect(byType.get('user.role_changed')!.payload).toMatchObject({
      userId: inviteeId,
      role: 'ops_manager',
    });
    // Every row carries its tenant — the append is inside the tenant tx.
    for (const row of rows) {
      expect(row.tenantId).toBe(tenantId);
      expect(row.status).toBe('pending');
    }
  });

  it('row-level security: outbox_messages is tenant-isolated and fails closed', async () => {
    const tenantId = uuidv7();
    createdTenantIds.push(tenantId);
    const rowId = await seedOutboxRow(tenantId, 'e.rls');
    const otherTenant = uuidv7();

    let probe: ReturnType<typeof postgres> | undefined;
    try {
      const probeUrl = new URL(process.env.DATABASE_URL!);
      probeUrl.username = 'wms_rls_probe';
      probeUrl.password = 'wms_rls_probe';
      probe = postgres(probeUrl.toString(), { max: 1 });

      const own = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        return tx`select id from outbox_messages where tenant_id = ${tenantId}`;
      });
      expect(own.map((row) => row.id)).toEqual([rowId]);

      const foreign = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${otherTenant}, true)`;
        return tx`select id from outbox_messages where tenant_id = ${tenantId}`;
      });
      expect(foreign).toHaveLength(0);

      // No app.tenant_id at all → fail closed.
      const unscoped = await probe`select id from outbox_messages`;
      expect(unscoped).toHaveLength(0);

      // The write side fails closed too (the WITH CHECK arm of the policy).
      const foreignInsert = probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`
          insert into outbox_messages (id, tenant_id, type, payload, occurred_at)
          values (${uuidv7()}, ${otherTenant}, 'e.rls', '{}', now())
        `;
      });
      await expect(foreignInsert).rejects.toThrow(/row-level security/i);
    } finally {
      await probe?.end();
    }
  });
});