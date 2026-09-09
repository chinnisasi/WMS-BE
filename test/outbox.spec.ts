import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_OPERATOR_REPLAY_SQL,
  PostgresOutboxRelay,
} from '../src/shared/events/outbox';
import type { DomainEvent, EventBus } from '../src/shared/events/event-bus.seam';

// The e2e suite talks to the real Postgres (docker-compose dev DB by default;
// CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';

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
    const nextAt = new Date(failed.nextAttemptAt).getTime();
    expect(nextAt).toBeGreaterThan(Date.now() + 4_000); // ~5s backoff
    expect(nextAt).toBeLessThan(Date.now() + 15_000);

    // Force the row due again: the next failure doubles the backoff (10s).
    await makeRowDue(failing);
    const bus2 = new RecordingEventBus();
    bus2.failOn = new Set(['boom.event']);
    expect(
      (await newRelay(bus2).drain(1_000)).filter((m) => m.tenantId === tenantId),
    ).toHaveLength(0);
    const afterSecond = (await outboxRowsFor(tenantId)).find((row) => row.id === failing)!;
    expect(afterSecond.attempts).toBe(2);
    const nextAt2 = new Date(afterSecond.nextAttemptAt).getTime();
    expect(nextAt2).toBeGreaterThan(Date.now() + 9_000); // ~10s backoff
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