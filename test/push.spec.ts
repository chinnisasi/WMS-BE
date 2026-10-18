import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, type INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { nowIso } from '../src/shared/primitives/time';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import type { Database } from '../src/shared/db/db';
import { WAVE_CLOCK, type WaveClock } from '../src/modules/outbound/wave.clock';
import { OutboundFacade, WAVE_CUTOFF_AT_RISK_EVENT } from '../src/modules/outbound/outbound.facade';
import { NotificationsFacade } from '../src/modules/notifications/notifications.facade';
import { PushSender } from '../src/modules/notifications/push.sender';
import { PushEnqueueHandler, PUSH_WAVE_CUTOFF_AT_RISK_EVENT } from '../src/modules/notifications/push.enqueue';
import {
  PUSH_GATEWAY,
  type UnconfiguredPushGateway,
  type PushGateway,
  type PushMessage,
  type PushTicket,
} from '../src/modules/notifications/push-gateway';
import {
  APPROVAL_PUSH_SOURCES,
  PUSH_DELIVERY_STATUSES,
  PUSH_GATEWAY_MODES,
  PUSH_KINDS,
  PUSH_TABS,
  pushClock,
} from '../src/modules/notifications/push-rules';
import { NOTIFICATION_SOURCES } from '../src/modules/notifications/notification-sources';
import { PushSenderWorker, WaveCutoffSweepWorker } from '../src/jobs/jobs.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.CHANNELS_SYNC_POLL_MS;
delete process.env.REPLENISHMENT_SCHEDULER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.PUSH_SENDER_POLL_MS;
delete process.env.WAVE_CUTOFF_SWEEP_POLL_MS;
delete process.env.PUSH_GATEWAY;
delete process.env.EXPO_ACCESS_TOKEN;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const SRC = join(__dirname, '..', 'src');

jest.setTimeout(180_000);

interface Tenant {
  tenantId: string;
  ownerToken: string;
  whA: string;
  whB: string;
}

interface Handheld {
  deviceId: string;
  userId: string;
  deviceToken: string;
  badgeToken: string;
  pushToken: string;
}

interface DeliveryRow {
  event_id: string;
  device_id: string;
  kind: string;
  tab: string;
  warehouse_id: string | null;
  approval_source: string | null;
  status: string;
  gateway: string | null;
  error_code: string | null;
  attempts: number;
  backoff_s: number;
}

/** A scripted gateway: answers each send with `answer(messages)` and records every batch. */
class ScriptedGateway implements PushGateway {
  readonly mode = 'expo' as const;
  readonly batches: PushMessage[][] = [];
  constructor(private readonly answer: (messages: readonly PushMessage[]) => PushTicket[] | Promise<PushTicket[]>) {}
  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    this.batches.push([...messages]);
    return this.answer(messages);
  }
}

/**
 * Story 9-2b — mobile pushes end to end: the registration routes, the
 * enqueue matrix (outbox rows drained through the REAL relay and bus — the
 * 9-2 suite's projection-matrix harness), the sender against scripted
 * gateways (constructed beside the app's own, the metering suite's worker
 * precedent), the cutoff sweep on a frozen `WAVE_CLOCK`, the vocabularies
 * against the 0068 CHECKs, and RLS.
 */
describe('mobile pushes (e2e, story 9-2b)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;
  let relay: OutboxRelay;
  let recorder: UnconfiguredPushGateway;
  let realNow: () => number;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('push');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    recorder = app.get<UnconfiguredPushGateway>(PUSH_GATEWAY);
    realNow = pushClock.now;
  });

  afterEach(() => {
    pushClock.now = realNow;
  });

  afterAll(async () => {
    try {
      const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
      await rawDb.$client?.end();
      const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
      await authDb.$client?.end();
      await sql.end();
      await app.close();
    } finally {
      await suiteDb.drop();
    }
  });

  // ── fixtures ───────────────────────────────────────────────────────────────

  function signIn(email: string): Promise<string> {
    return mintSignIn(app, { email, password: PASSWORD })
      .then((res) => res.body.accessToken as string);
  }

  async function invite(tenantId: string, ownerToken: string, role: string): Promise<{ email: string; userId: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    return { email, userId: invited.body.user.id as string };
  }

  async function warehouse(tenantId: string, ownerToken: string): Promise<string> {
    return (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `PU-${ulid().slice(10, 16).toUpperCase()}`, name: `Push WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
  }

  async function setupTenant(label: string): Promise<Tenant> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Push ${label} ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    const tenantId = registered.body.tenant.id as string;
    const ownerToken = await signIn(email);
    return { tenantId, ownerToken, whA: await warehouse(tenantId, ownerToken), whB: await warehouse(tenantId, ownerToken) };
  }

  /** Enrolls a device, badges a fresh member of `role` in (or the owner's email), returns its sessions. */
  async function enrolled(t: Tenant, role: 'owner' | 'ops_manager' | 'operator' | 'accountant', ownerEmail?: string): Promise<Omit<Handheld, 'pushToken'>> {
    const minted = await request(app.getHttpServer())
      .post(`${API}/${t.tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${t.ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolledDevice = await request(app.getHttpServer())
      .post(`${API}/${t.tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: `Handheld ${ulid()}`, pin: '2468' })
      .expect(201);
    const deviceToken = enrolledDevice.body.deviceToken as string;
    const deviceId = enrolledDevice.body.device.id as string;
    let email: string;
    if (role === 'owner') {
      email = ownerEmail ?? (await sql`select email from users where tenant_id = ${t.tenantId} and role = 'owner' limit 1`)[0]!.email;
    } else {
      email = (await invite(t.tenantId, t.ownerToken, role)).email;
    }
    const badged = await request(app.getHttpServer())
      .post(`${API}/${t.tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ operatorEmail: email, pin: '2468' })
      .expect(200);
    return { deviceId, userId: badged.body.operator.id as string, deviceToken, badgeToken: badged.body.accessToken as string };
  }

  function putRegistration(t: Tenant, bearer: string, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .put(`${API}/${t.tenantId}/devices/push-registration`)
      .set('Authorization', `Bearer ${bearer}`)
      .send(body);
  }

  async function handheld(
    t: Tenant,
    role: 'owner' | 'ops_manager' | 'operator' | 'accountant',
    warehouseId: string,
    pushToken = `ExponentPushToken[${ulid()}]`,
  ): Promise<Handheld> {
    const device = await enrolled(t, role);
    await putRegistration(t, device.badgeToken, { token: pushToken, warehouseId }).expect(204);
    return { ...device, pushToken };
  }

  async function emit(tenantId: string, type: string, payload: Record<string, unknown>, occurredAt = nowIso(), id = uuidv7()): Promise<string> {
    await sql`
      insert into outbox_messages (id, tenant_id, type, payload, occurred_at, status, attempts, next_attempt_at)
      values (${id}, ${tenantId}, ${type}, ${sql.json(payload as postgres.JSONValue)}, ${occurredAt}, 'pending', 0, now())`;
    return id;
  }

  async function drainAll(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await sql`update outbox_messages set next_attempt_at = now() where status = 'pending'`;
      const drained = await relay.drain(100);
      if (drained.length === 0) return;
    }
  }

  async function deliveries(tenantId: string, eventId?: string): Promise<DeliveryRow[]> {
    const rows = await sql`
      select event_id, device_id, kind, tab, warehouse_id, approval_source, status, gateway, error_code, attempts,
             round(extract(epoch from (next_attempt_at - updated_at)))::int as backoff_s
      from push_deliveries
      where tenant_id = ${tenantId} ${eventId === undefined ? sql`` : sql`and event_id = ${eventId}`}
      order by device_id`;
    return rows as unknown as DeliveryRow[];
  }

  async function device(deviceId: string): Promise<{ push_token: string | null; push_warehouse_id: string | null; push_registered_at: string | null }> {
    return (await sql`select push_token, push_warehouse_id, push_registered_at::text from devices where id = ${deviceId}`)[0] as never;
  }

  function sender(gateway: PushGateway): PushSender {
    return new PushSender(app.get<Database>(DATABASE), app.get<Database>(AUTH_DATABASE), gateway);
  }

  const waveReleased = (warehouseId: string): Record<string, unknown> => ({ wave: { id: uuidv7(), warehouseId, status: 'released' } });
  const adjustmentPending = (warehouseId: string): Record<string, unknown> => ({
    pendingAdjustmentId: uuidv7(),
    skuId: uuidv7(),
    quantityDelta: -3,
    reasonCode: 'damaged',
    warehouseId,
  });

  // ── the vocabularies and the emitters ──────────────────────────────────────

  describe('vocabularies, emitters and RLS', () => {
    it('each TS tuple equals its 0068 CHECK list (IMPLEMENTATION-GUIDE §4)', async () => {
      const defs = (await sql`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'push_deliveries'::regclass and contype = 'c'`) as unknown as { conname: string; def: string }[];
      const listed = (name: string): string[] => {
        const def = defs.find((d) => d.conname === name)!.def;
        return [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
      };
      expect(listed('push_deliveries_kind_check')).toEqual([...PUSH_KINDS]);
      expect(listed('push_deliveries_tab_check')).toEqual([...PUSH_TABS]);
      expect(listed('push_deliveries_status_check')).toEqual([...PUSH_DELIVERY_STATUSES]);
      expect(listed('push_deliveries_gateway_check')).toEqual([...PUSH_GATEWAY_MODES]);
      expect(listed('push_deliveries_approval_source_check')).toEqual([...APPROVAL_PUSH_SOURCES]);
      expect(defs.map((d) => d.conname).sort()).toEqual([
        'push_deliveries_approval_source_check',
        'push_deliveries_gateway_check',
        'push_deliveries_kind_check',
        'push_deliveries_shape_check',
        'push_deliveries_status_check',
        'push_deliveries_tab_check',
      ]);
    });

    it('the CHECKs refuse what the probe refuses (named), and RLS fails closed on push_deliveries', async () => {
      const t = uuidv7();
      await expect(
        sql`insert into push_deliveries (tenant_id, event_id, device_id, kind, tab, status, next_attempt_at)
            values (${t}, ${uuidv7()}, ${uuidv7()}, 'new-work', 'Pick', 'pending', now())`,
      ).rejects.toMatchObject({ code: '23514', constraint_name: 'push_deliveries_shape_check' });
      await expect(
        sql`insert into push_deliveries (tenant_id, event_id, device_id, kind, tab, status, next_attempt_at)
            values (${t}, ${uuidv7()}, ${uuidv7()}, 'at-risk', 'pick', 'pending', now())`,
      ).rejects.toMatchObject({ code: '23514', constraint_name: 'push_deliveries_tab_check' });

      await sql`insert into push_deliveries (tenant_id, event_id, device_id, kind, tab, status, next_attempt_at)
                values (${t}, ${uuidv7()}, ${uuidv7()}, 'at-risk', 'All', 'pending', now())`;
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        expect(await rls`select 1 from push_deliveries where tenant_id = ${t}`).toHaveLength(0);
        const foreign = await rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
          return tx`select 1 from push_deliveries where tenant_id = ${t}`;
        });
        expect(foreign).toHaveLength(0);
        const own = await rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${t}, true)`;
          return tx`select 1 from push_deliveries where tenant_id = ${t}`;
        });
        expect(own).toHaveLength(1);
      } finally {
        await rls.end();
      }
      await sql`delete from push_deliveries where tenant_id = ${t}`;
    });

    it('the event types and payload fields the enqueue reads are the emitters’ own', () => {
      expect(PUSH_WAVE_CUTOFF_AT_RISK_EVENT).toBe(WAVE_CUTOFF_AT_RISK_EVENT);
      const wave = readFileSync(join(SRC, 'modules', 'outbound', 'wave.command.ts'), 'utf8');
      expect(wave).toMatch(/type: 'wave\.released',\s+occurredAt: nowIso\(\),\s+payload: \{ wave: snapshot\.wave \}/);
      expect(wave).toMatch(/warehouseId: wave\.warehouseId,/); // the snapshot carries it
      const count = readFileSync(join(SRC, 'modules', 'movements', 'count.command.ts'), 'utf8');
      for (const origin of ['on_demand', 'scheduled', 'recount']) {
        expect(count).toContain(`origin: '${origin}'`);
      }
      expect(count.match(/type: 'count\.created'/g)).toHaveLength(4);
      const transfer = readFileSync(join(SRC, 'modules', 'movements', 'transfer.command.ts'), 'utf8');
      expect(transfer).toMatch(/type: 'transfer\.outbound-confirmed',[\s\S]{0,200}destWarehouseId: order\.destWarehouseId/);
      // The approval raises are the 9-2 sources' own raise events (reused, never re-derived).
      expect(APPROVAL_PUSH_SOURCES.map((s) => NOTIFICATION_SOURCES[s].raise.type)).toEqual([
        'stock_adjustment.pending_approval',
        'count.variance.threshold_exceeded',
        'over_receipt.requested',
      ]);
    });
  });

  // ── registration ───────────────────────────────────────────────────────────

  describe('PUT / DELETE …/devices/push-registration', () => {
    let t: Tenant;
    beforeAll(async () => {
      t = await setupTenant('Registration');
    });

    it('registers (204), re-registers idempotently, and DELETE clears; the token moves off any other device of the tenant', async () => {
      const a = await enrolled(t, 'operator');
      const b = await enrolled(t, 'operator');
      const token = `ExponentPushToken[${ulid()}]`;
      await putRegistration(t, a.badgeToken, { token, warehouseId: t.whA }).expect(204);
      const first = await device(a.deviceId);
      expect(first.push_token).toBe(token);
      expect(first.push_warehouse_id).toBe(t.whA);
      expect(first.push_registered_at).not.toBeNull();
      // A retry writes the same values (natural upsert — no Idempotency-Key).
      await putRegistration(t, a.badgeToken, { token, warehouseId: t.whB }).expect(204);
      expect((await device(a.deviceId)).push_warehouse_id).toBe(t.whB);

      // The same token registered on another device leaves the first.
      await putRegistration(t, b.badgeToken, { token, warehouseId: t.whA }).expect(204);
      expect((await device(a.deviceId)).push_token).toBeNull();
      expect((await device(b.deviceId)).push_token).toBe(token);

      await request(app.getHttpServer())
        .delete(`${API}/${t.tenantId}/devices/push-registration`)
        .set('Authorization', `Bearer ${b.badgeToken}`)
        .expect(204);
      expect(await device(b.deviceId)).toEqual({ push_token: null, push_warehouse_id: null, push_registered_at: null });
      // Idempotent.
      await request(app.getHttpServer())
        .delete(`${API}/${t.tenantId}/devices/push-registration`)
        .set('Authorization', `Bearer ${b.badgeToken}`)
        .expect(204);
    });

    it('refuses: the enrollment-only credential 401; another tenant’s warehouse 404; a malformed token 400; another tenant’s path 403', async () => {
      const a = await enrolled(t, 'operator');
      const token = `ExponentPushToken[${ulid()}]`;
      const bare = await putRegistration(t, a.deviceToken, { token, warehouseId: t.whA }).expect(401);
      expect(bare.body.code).toBe('unauthenticated');
      const bareDelete = await request(app.getHttpServer())
        .delete(`${API}/${t.tenantId}/devices/push-registration`)
        .set('Authorization', `Bearer ${a.deviceToken}`)
        .expect(401);
      expect(bareDelete.body.code).toBe('unauthenticated');

      const other = await setupTenant('Other');
      const foreign = await putRegistration(t, a.badgeToken, { token, warehouseId: other.whA }).expect(404);
      expect(foreign.body.code).toBe('not-found');
      expect((await device(a.deviceId)).push_token).toBeNull();

      for (const bad of [
        { token: 'not-a-token', warehouseId: t.whA },
        { token: 'ExponentPushToken[]', warehouseId: t.whA },
        { token: `ExponentPushToken[${'x'.repeat(201)}]`, warehouseId: t.whA },
        { token, warehouseId: 'nope' },
        { token, warehouseId: t.whA, deviceId: a.deviceId },
      ]) {
        expect((await putRegistration(t, a.badgeToken, bad).expect(400)).body.code).toBe('validation-failed');
      }
      // `ExpoPushToken[…]` is the other accepted spelling.
      await putRegistration(t, a.badgeToken, { token: `ExpoPushToken[${ulid()}]`, warehouseId: t.whA }).expect(204);

      const wrongPath = await request(app.getHttpServer())
        .put(`${API}/${other.tenantId}/devices/push-registration`)
        .set('Authorization', `Bearer ${a.badgeToken}`)
        .send({ token, warehouseId: other.whA })
        .expect(403);
      expect(wrongPath.body.code).toBe('permission-denied');
    });

    it('a revoked device is 403 device-revoked, and revoke clears the push columns; a rebound device is 403 too', async () => {
      const a = await handheld(t, 'operator', t.whA);
      await request(app.getHttpServer())
        .post(`${API}/${t.tenantId}/devices/${a.deviceId}/revoke`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .expect(200);
      expect(await device(a.deviceId)).toEqual({ push_token: null, push_warehouse_id: null, push_registered_at: null });
      const revoked = await putRegistration(t, a.badgeToken, { token: a.pushToken, warehouseId: t.whA }).expect(403);
      expect(revoked.body.code).toBe('device-revoked');
      expect(
        (
          await request(app.getHttpServer())
            .delete(`${API}/${t.tenantId}/devices/push-registration`)
            .set('Authorization', `Bearer ${a.badgeToken}`)
            .expect(403)
        ).body.code,
      ).toBe('device-revoked');

      // Rebound: the row now names another operator than this session's.
      const b = await enrolled(t, 'operator');
      const someoneElse = await invite(t.tenantId, t.ownerToken, 'operator');
      await sql`update devices set operator_user_id = ${someoneElse.userId} where id = ${b.deviceId}`;
      const rebound = await putRegistration(t, b.badgeToken, { token: `ExponentPushToken[${ulid()}]`, warehouseId: t.whA }).expect(403);
      expect(rebound.body.code).toBe('device-revoked');
    });

    it('the routes are in the OpenAPI document with their error arms and NO Idempotency-Key', async () => {
      const doc = (await request(app.getHttpServer()).get('/api/v1/openapi.json').expect(200)).body;
      const path = doc.paths['/tenants/{tenantId}/devices/push-registration'];
      expect(Object.keys(path).sort()).toEqual(['delete', 'put']);
      expect(Object.keys(path.put.responses).sort()).toEqual(['204', '400', '401', '403', '404']);
      expect(Object.keys(path.delete.responses).sort()).toEqual(['204', '401', '403']);
      for (const op of [path.put, path.delete]) {
        expect((op.parameters ?? []).some((p: { name: string }) => p.name === 'Idempotency-Key')).toBe(false);
      }
      expect(doc.components.schemas.PushRegistrationDto.required.sort()).toEqual(['token', 'warehouseId']);
    });
  });

  // ── the enqueue matrix ─────────────────────────────────────────────────────

  describe('the enqueue (outbox rows through the real relay and bus)', () => {
    let t: Tenant;
    let opA1: Handheld;
    let opA2: Handheld;
    let opB: Handheld;
    let owner: Handheld;
    let ops: Handheld;
    let accountant: Handheld;

    beforeAll(async () => {
      t = await setupTenant('Enqueue');
      opA1 = await handheld(t, 'operator', t.whA);
      opA2 = await handheld(t, 'operator', t.whA);
      opB = await handheld(t, 'operator', t.whB);
      owner = await handheld(t, 'owner', t.whB);
      ops = await handheld(t, 'ops_manager', t.whB);
      accountant = await handheld(t, 'accountant', t.whA);
    });

    beforeEach(async () => {
      await sql`delete from push_deliveries where tenant_id = ${t.tenantId}`;
    });

    it('ACCEPTANCE: a wave released in WH-A queues one new-work · Pick row per floor handheld registered to WH-A; relayed twice it queues and sends exactly once', async () => {
      const payload = waveReleased(t.whA);
      const eventId = await emit(t.tenantId, 'wave.released', payload);
      await drainAll();
      const rows = await deliveries(t.tenantId, eventId);
      // Both operators in WH-A; the accountant in WH-A is not a floor role; WH-B devices are another warehouse.
      expect(rows.map((r) => r.device_id).sort()).toEqual([opA1.deviceId, opA2.deviceId].sort());
      for (const row of rows) {
        expect(row).toMatchObject({ kind: 'new-work', tab: 'Pick', warehouse_id: t.whA, approval_source: null, status: 'pending', attempts: 0 });
      }

      // The same outbox row delivered again (a crash between publish and ack).
      await emit(t.tenantId, 'wave.released', payload, nowIso(), eventId);
      await drainAll();
      expect(await deliveries(t.tenantId, eventId)).toHaveLength(2);

      recorder.recorded.length = 0;
      const summary = await app.get(NotificationsFacade).sendDuePushes(t.tenantId);
      expect(summary).toMatchObject({ claimed: 2, sent: 2, delivered: 2, failed: 0 });
      expect(recorder.recorded.map((m) => m.to).sort()).toEqual([opA1.pushToken, opA2.pushToken].sort());
      expect(recorder.recorded[0]).toEqual({
        to: expect.any(String),
        title: 'New work ready',
        body: 'Picks released in your warehouse',
        data: { kind: 'new-work', tab: 'Pick' },
        ttl: 3600,
        channelId: 'work',
        priority: 'high',
      });
      expect((await deliveries(t.tenantId, eventId)).map((r) => [r.status, r.gateway])).toEqual([
        ['sent', 'unconfigured'],
        ['sent', 'unconfigured'],
      ]);

      // Delivered a THIRD time after it was sent: nothing new, nothing re-sent.
      await emit(t.tenantId, 'wave.released', payload, nowIso(), eventId);
      await drainAll();
      recorder.recorded.length = 0;
      expect((await app.get(NotificationsFacade).sendDuePushes(t.tenantId)).claimed).toBe(0);
      expect(recorder.recorded).toHaveLength(0);
    });

    it('counts: on-demand and recount queue new-work · Count; a scheduled count tick (30 tasks) queues nothing', async () => {
      const onDemand = await emit(t.tenantId, 'count.created', { taskId: uuidv7(), binId: uuidv7(), warehouseId: t.whB, origin: 'on_demand' });
      const recount = await emit(t.tenantId, 'count.created', {
        taskId: uuidv7(),
        binId: uuidv7(),
        warehouseId: t.whA,
        origin: 'recount',
        supersededTaskId: uuidv7(),
      });
      const scheduled: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        scheduled.push(await emit(t.tenantId, 'count.created', { taskId: uuidv7(), binId: uuidv7(), warehouseId: t.whA, origin: 'scheduled' }));
      }
      await drainAll();
      // WH-B floor handhelds: opB, owner, ops.
      expect((await deliveries(t.tenantId, onDemand)).map((r) => [r.device_id, r.tab]).sort()).toEqual(
        [opB.deviceId, owner.deviceId, ops.deviceId].map((d) => [d, 'Count']).sort(),
      );
      expect((await deliveries(t.tenantId, recount)).map((r) => r.device_id).sort()).toEqual([opA1.deviceId, opA2.deviceId].sort());
      const all = await deliveries(t.tenantId);
      expect(all.filter((r) => scheduled.includes(r.event_id))).toEqual([]);
      expect(all).toHaveLength(5);
    });

    it('transfers: an outbound-confirmed transfer pushes the DESTINATION warehouse (new-work · Transfer)', async () => {
      const id = await emit(t.tenantId, 'transfer.outbound-confirmed', { transferId: uuidv7(), sourceWarehouseId: t.whB, destWarehouseId: t.whA });
      await drainAll();
      expect((await deliveries(t.tenantId, id)).map((r) => [r.device_id, r.tab, r.warehouse_id]).sort()).toEqual(
        [opA1.deviceId, opA2.deviceId].map((d) => [d, 'Transfer', t.whA]).sort(),
      );
    });

    it('approvals follow the 9-2 audience in any warehouse: adjustment → owner only; over-threshold variance → owner only; over-receipt → owner + ops_manager', async () => {
      const adjustment = await emit(t.tenantId, 'stock_adjustment.pending_approval', adjustmentPending(t.whA));
      const variance = await emit(t.tenantId, 'count.variance.threshold_exceeded', {
        varianceId: uuidv7(),
        skuId: uuidv7(),
        delta: 4,
        warehouseId: t.whA,
      });
      const overReceipt = await emit(t.tenantId, 'over_receipt.requested', {
        overReceiptId: uuidv7(),
        grnCode: 'GRN-0001',
        skuId: uuidv7(),
        excessQty: 2,
        warehouseId: t.whA,
      });
      // A payload the 9-2 decoder refuses is not pushed either.
      const malformed = await emit(t.tenantId, 'stock_adjustment.pending_approval', { pendingAdjustmentId: 'nope' });
      await drainAll();
      expect((await deliveries(t.tenantId, adjustment)).map((r) => [r.device_id, r.kind, r.tab, r.approval_source])).toEqual([
        [owner.deviceId, 'approval', 'All', 'stock-adjustment'],
      ]);
      expect((await deliveries(t.tenantId, variance)).map((r) => r.device_id)).toEqual([owner.deviceId]);
      expect((await deliveries(t.tenantId, overReceipt)).map((r) => r.device_id).sort()).toEqual([owner.deviceId, ops.deviceId].sort());
      expect(await deliveries(t.tenantId, malformed)).toEqual([]);

      recorder.recorded.length = 0;
      await app.get(NotificationsFacade).sendDuePushes(t.tenantId);
      expect(recorder.recorded.find((m) => m.to === owner.pushToken)).toMatchObject({
        title: 'Approval waiting',
        body: 'Decide it on the web',
        data: { kind: 'approval', tab: 'All' },
      });
    });

    it('at-risk goes to waves.manage holders only (owner, ops_manager — any warehouse); a passed cutoff is acked', async () => {
      // 17:15 IST today → cutoff 18:00 is 45 minutes away.
      const now = Date.parse('2026-10-12T11:45:00.000Z');
      pushClock.now = () => now;
      const atRisk = await emit(
        t.tenantId,
        PUSH_WAVE_CUTOFF_AT_RISK_EVENT,
        { waveId: uuidv7(), warehouseId: t.whA, cutoffLocalTime: '18:00', istDate: '2026-10-12' },
        new Date(now).toISOString(),
        uuidv7(now), // appended at the frozen instant: the staleness clock is the append time
      );
      const passed = await emit(
        t.tenantId,
        PUSH_WAVE_CUTOFF_AT_RISK_EVENT,
        { waveId: uuidv7(), warehouseId: t.whA, cutoffLocalTime: '17:15', istDate: '2026-10-12' },
        new Date(now).toISOString(),
        uuidv7(now), // appended at the frozen instant: the staleness clock is the append time
      );
      await drainAll();
      expect((await deliveries(t.tenantId, atRisk)).map((r) => [r.device_id, r.kind, r.tab]).sort()).toEqual(
        [owner.deviceId, ops.deviceId].map((d) => [d, 'at-risk', 'All']).sort(),
      );
      expect(await deliveries(t.tenantId, passed)).toEqual([]);
      expect(accountant.deviceId).toBeDefined();
    });

    it('staleness is the SERVER append time (the uuidv7 outbox id), never occurredAt: a backdated occurredAt with a fresh append is queued; an old append is acked', async () => {
      const twoHoursAgo = Date.now() - 2 * 3600_000;
      // Device time two hours back (a count or transfer queued offline), appended NOW.
      const backdated = await emit(t.tenantId, 'wave.released', waveReleased(t.whA), new Date(twoHoursAgo).toISOString());
      // Appended two hours ago (a deploy backlog, an operator replay), occurredAt fresh.
      const oldAppend = await emit(t.tenantId, 'wave.released', waveReleased(t.whA), nowIso(), uuidv7(twoHoursAgo));
      // The 30-minute boundary, either side.
      const thirtyOne = await emit(t.tenantId, 'wave.released', waveReleased(t.whA), nowIso(), uuidv7(Date.now() - 31 * 60_000));
      const twentyNine = await emit(t.tenantId, 'wave.released', waveReleased(t.whA), nowIso(), uuidv7(Date.now() - 29 * 60_000));
      // An id that is not a uuidv7 cannot be dated: no push (never a fallback to occurredAt).
      const undated = await emit(t.tenantId, 'wave.released', waveReleased(t.whA), nowIso(), '0b8f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e');
      await drainAll();
      expect(await deliveries(t.tenantId, backdated)).toHaveLength(2);
      expect(await deliveries(t.tenantId, oldAppend)).toEqual([]);
      expect(await deliveries(t.tenantId, thirtyOne)).toEqual([]);
      expect(await deliveries(t.tenantId, twentyNine)).toHaveLength(2);
      expect(await deliveries(t.tenantId, undated)).toEqual([]);
      // Acked: the relay holds nothing for them.
      expect(await sql`select 1 from outbox_messages where id in (${oldAppend}, ${thirtyOne}, ${undated})`).toHaveLength(0);
    });

    it('the 9-2 panel entry is written and the row acked even when the push enqueue fails (it subscribes first) — and with the gateway down', async () => {
      // (a) The push enqueue throws on every attempt: the panel entry still lands.
      const failing = jest.spyOn(PushEnqueueHandler.prototype as never, 'enqueue' as never).mockRejectedValue(new Error('push queue down') as never);
      const payload = adjustmentPending(t.whA);
      await emit(t.tenantId, 'stock_adjustment.pending_approval', payload);
      await sql`update outbox_messages set next_attempt_at = now() where status = 'pending'`;
      await relay.drain(100);
      expect(failing).toHaveBeenCalled();
      const entry = await sql`select resolved_at from notifications where tenant_id = ${t.tenantId} and source_id = ${payload.pendingAdjustmentId as string}`;
      expect(entry).toHaveLength(1);
      failing.mockRestore();
      await drainAll(); // the redelivery queues the push; the panel write is idempotent
      expect(await sql`select 1 from notifications where tenant_id = ${t.tenantId} and source_id = ${payload.pendingAdjustmentId as string}`).toHaveLength(1);

      // (b) The gateway answers 503: the enqueue never touched it — the
      // outbox row is gone (acked), the panel has its entry, the push waits.
      await sql`delete from push_deliveries where tenant_id = ${t.tenantId}`;
      const second = adjustmentPending(t.whA);
      const eventId = await emit(t.tenantId, 'stock_adjustment.pending_approval', second);
      await drainAll();
      expect(await sql`select 1 from outbox_messages where id = ${eventId}`).toHaveLength(0);
      expect(await sql`select 1 from notifications where tenant_id = ${t.tenantId} and source_id = ${second.pendingAdjustmentId as string}`).toHaveLength(1);
      const down = new ScriptedGateway((messages) => messages.map(() => ({ ok: false, code: 'http-503' })));
      await sender(down).sendDue(t.tenantId);
      const [row] = await deliveries(t.tenantId, eventId);
      expect(row).toMatchObject({ status: 'pending', attempts: 1, error_code: 'http-503', backoff_s: 5 });
    });
  });

  // ── the sender ─────────────────────────────────────────────────────────────

  describe('the sender (claim → one send → outcomes)', () => {
    let t: Tenant;
    let operatorId: string;

    beforeAll(async () => {
      t = await setupTenant('Sender');
      operatorId = (await invite(t.tenantId, t.ownerToken, 'operator')).userId;
    });

    beforeEach(async () => {
      await sql`delete from push_deliveries where tenant_id = ${t.tenantId}`;
      await sql`delete from devices where tenant_id = ${t.tenantId}`;
    });

    /** N active devices bound to one operator, registered to WH-A (the sender's subject is the queue, not enrollment). */
    async function devices(n: number): Promise<{ id: string; token: string }[]> {
      const made = Array.from({ length: n }, (_, i) => ({ id: uuidv7(), token: `ExponentPushToken[sender-${i}-${ulid()}]` }));
      for (const d of made) {
        await sql`insert into devices (id, tenant_id, operator_user_id, label, status, push_token, push_warehouse_id, push_registered_at)
                  values (${d.id}, ${t.tenantId}, ${operatorId}, 'bulk', 'active', ${d.token}, ${t.whA}, now())`;
      }
      return made;
    }

    async function released(): Promise<string> {
      const id = await emit(t.tenantId, 'wave.released', waveReleased(t.whA));
      await drainAll();
      return id;
    }

    it('a batch of 100: 99 ok and 1 DeviceNotRegistered → 99 sent, 1 failed, its token cleared (it was unchanged)', async () => {
      const made = await devices(100);
      const eventId = await released();
      expect(await deliveries(t.tenantId, eventId)).toHaveLength(100);
      const dead = made[37]!;
      const gateway = new ScriptedGateway((messages) =>
        messages.map((m) => (m.to === dead.token ? { ok: false, code: 'DeviceNotRegistered' } : { ok: true })),
      );
      const summary = await sender(gateway).sendDue(t.tenantId);
      expect(gateway.batches).toHaveLength(1);
      expect(gateway.batches[0]).toHaveLength(100);
      expect(summary).toMatchObject({ claimed: 100, sent: 100, delivered: 99, failed: 1 });
      const rows = await deliveries(t.tenantId, eventId);
      expect(rows.filter((r) => r.status === 'sent')).toHaveLength(99);
      expect(rows.filter((r) => r.status === 'failed').map((r) => [r.device_id, r.error_code])).toEqual([[dead.id, 'DeviceNotRegistered']]);
      expect((await device(dead.id)).push_token).toBeNull();
      expect((await device(made[0]!.id)).push_token).toBe(made[0]!.token);
    });

    it('DeviceNotRegistered does NOT clear a token the device re-registered while the batch was in flight', async () => {
      const [d] = await devices(1);
      await released();
      const fresh = `ExponentPushToken[fresh-${ulid()}]`;
      const gateway = new ScriptedGateway(async (messages) => {
        await sql`update devices set push_token = ${fresh}, push_registered_at = now() where id = ${d!.id}`;
        return messages.map(() => ({ ok: false, code: 'DeviceNotRegistered' }));
      });
      await sender(gateway).sendDue(t.tenantId);
      expect((await device(d!.id)).push_token).toBe(fresh);
    });

    it('a transient outcome backs off (5 s, 10 s, …) and fails on the fifth attempt; only pending rows are ever re-sent', async () => {
      await devices(1);
      const eventId = await released();
      const flaky = new ScriptedGateway((messages) => messages.map(() => ({ ok: false, code: 'MessageRateExceeded' })));
      const backoffs: number[] = [];
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await sql`update push_deliveries set next_attempt_at = now() where tenant_id = ${t.tenantId} and status = 'pending'`;
        await sender(flaky).sendDue(t.tenantId);
        const [row] = await deliveries(t.tenantId, eventId);
        if (attempt < 5) {
          expect(row).toMatchObject({ status: 'pending', attempts: attempt, error_code: 'MessageRateExceeded' });
          backoffs.push(row!.backoff_s);
        } else {
          expect(row).toMatchObject({ status: 'failed', attempts: 5, error_code: 'MessageRateExceeded' });
        }
      }
      expect(backoffs).toEqual([5, 10, 20, 40]);
      expect(flaky.batches).toHaveLength(5);
      await sql`update push_deliveries set next_attempt_at = now() where tenant_id = ${t.tenantId}`;
      await sender(flaky).sendDue(t.tenantId);
      expect(flaky.batches).toHaveLength(5); // a failed row is never re-sent
    });

    it('a not-yet-due pending row is not claimed', async () => {
      await devices(1);
      await released();
      await sql`update push_deliveries set next_attempt_at = now() + interval '1 minute' where tenant_id = ${t.tenantId}`;
      const gateway = new ScriptedGateway((messages) => messages.map(() => ({ ok: true })));
      expect((await sender(gateway).sendDue(t.tenantId)).claimed).toBe(0);
      expect(gateway.batches).toHaveLength(0);
    });

    it('permanent codes fail the row without touching the token (MessageTooBig, InvalidProviderToken, unknown, http-400)', async () => {
      const made = await devices(4);
      const eventId = await released();
      const codes = ['MessageTooBig', 'InvalidProviderToken', 'WhoKnows', 'http-400'];
      const byToken = new Map(made.map((d, i) => [d.token, codes[i]!]));
      await sender(new ScriptedGateway((messages) => messages.map((m) => ({ ok: false, code: byToken.get(m.to)! })))).sendDue(t.tenantId);
      const rows = await deliveries(t.tenantId, eventId);
      expect(rows.map((r) => [r.status, r.error_code, r.attempts]).sort()).toEqual(codes.map((c) => ['failed', c, 0]).sort());
      for (const d of made) expect((await device(d.id)).push_token).toBe(d.token);
    });

    it('a crash after the send and before the outcome: the row stays `sending`; after 5 minutes it fails `stale` and is never re-sent', async () => {
      await devices(1);
      const eventId = await released();
      // The claim committed, the process died: simulate by claiming then stopping.
      await sql`update push_deliveries set status = 'sending', gateway = 'expo', updated_at = now() - interval '4 minutes' where tenant_id = ${t.tenantId}`;
      const gateway = new ScriptedGateway((messages) => messages.map(() => ({ ok: true })));
      expect((await sender(gateway).sendDue(t.tenantId)).stale).toBe(0);
      expect((await deliveries(t.tenantId, eventId))[0]!.status).toBe('sending');
      await sql`update push_deliveries set updated_at = now() - interval '6 minutes' where tenant_id = ${t.tenantId}`;
      expect((await sender(gateway).sendDue(t.tenantId)).stale).toBe(1);
      expect((await deliveries(t.tenantId, eventId))[0]).toMatchObject({ status: 'failed', error_code: 'stale' });
      expect(gateway.batches).toHaveLength(0);
    });

    it('a config fault (invalid EXPO_ACCESS_TOKEN): rows retried without spending an attempt; the codes are RETURNED, and the worker logs once per tick across tenants', async () => {
      await devices(2);
      const eventId = await released();
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const badCreds = new ScriptedGateway((messages) => messages.map(() => ({ ok: false, code: 'http-401' })));
      const summary = await sender(badCreds).sendDue(t.tenantId);
      expect(summary.configCodes).toEqual(['http-401']);
      const rows = await deliveries(t.tenantId, eventId);
      expect(rows.map((r) => [r.status, r.attempts, r.error_code, r.backoff_s])).toEqual([
        ['pending', 0, 'http-401', 30],
        ['pending', 0, 'http-401', 30],
      ]);
      // The sender itself logs nothing about credentials (code review B4).
      expect(errors.mock.calls.filter(([msg]) => String(msg).includes('refused the credentials'))).toHaveLength(0);

      // A second tenant faulting in the SAME tick: still one log line.
      const other = await setupTenant('SenderOther');
      const otherOperator = (await invite(other.tenantId, other.ownerToken, 'operator')).userId;
      await sql`insert into devices (id, tenant_id, operator_user_id, label, status, push_token, push_warehouse_id, push_registered_at)
                values (${uuidv7()}, ${other.tenantId}, ${otherOperator}, 'other', 'active', ${`ExponentPushToken[other-${ulid()}]`}, ${other.whA}, now())`;
      await emit(other.tenantId, 'wave.released', waveReleased(other.whA));
      await drainAll();
      await sql`update push_deliveries set next_attempt_at = now() where tenant_id in (${t.tenantId}, ${other.tenantId})`;
      const facade = new NotificationsFacade(app.get<Database>(DATABASE), sender(badCreds));
      const worker = new PushSenderWorker(app.get(AUTH_DATABASE) as never, facade);
      const driven = await worker.tick();
      expect(driven).toEqual(expect.arrayContaining([t.tenantId, other.tenantId]));
      const credentialLogs = errors.mock.calls.filter(([msg]) => String(msg).includes('refused the credentials'));
      expect(credentialLogs).toHaveLength(1);
      expect(String(credentialLogs[0]![0])).toContain('http-401');
      expect(String(credentialLogs[0]![0])).not.toContain('ExponentPushToken');
      await sql`delete from push_deliveries where tenant_id = ${other.tenantId}`;
    });

    it('a pending row created more than 30 minutes ago is failed `expired` before any claim — a config-faulted at-risk row an hour on included', async () => {
      const made = await devices(2);
      const eventId = await released();
      await sql`update push_deliveries set created_at = now() - interval '31 minutes' where tenant_id = ${t.tenantId} and device_id = ${made[0]!.id}`;
      await sql`update push_deliveries set created_at = now() - interval '29 minutes' where tenant_id = ${t.tenantId} and device_id = ${made[1]!.id}`;
      // An at-risk row still retrying a config fault, an hour after it was queued.
      const atRiskEvent = uuidv7();
      await sql`insert into push_deliveries (tenant_id, event_id, device_id, kind, tab, status, error_code, attempts, next_attempt_at, created_at)
                values (${t.tenantId}, ${atRiskEvent}, ${made[1]!.id}, 'at-risk', 'All', 'pending', 'http-401', 0, now(), now() - interval '61 minutes')`;
      const gateway = new ScriptedGateway((messages) => messages.map(() => ({ ok: true })));
      const summary = await sender(gateway).sendDue(t.tenantId);
      expect(summary).toMatchObject({ expired: 2, claimed: 1, delivered: 1 });
      expect(gateway.batches.flat().map((m) => m.to)).toEqual([made[1]!.token]);
      const rows = new Map((await deliveries(t.tenantId, eventId)).map((r) => [r.device_id, r]));
      expect(rows.get(made[0]!.id)).toMatchObject({ status: 'failed', error_code: 'expired' });
      expect(rows.get(made[1]!.id)).toMatchObject({ status: 'sent' });
      expect((await deliveries(t.tenantId, atRiskEvent))[0]).toMatchObject({ kind: 'at-risk', status: 'failed', error_code: 'expired' });
    });

    it('re-checks eligibility at send: deactivated, moved to a client, demoted, revoked or re-registered elsewhere → failed `ineligible`, not sent', async () => {
      const users = await Promise.all([1, 2, 3].map(() => invite(t.tenantId, t.ownerToken, 'operator')));
      const made: { id: string; token: string }[] = [];
      for (const [i, u] of [operatorId, ...users.map((x) => x.userId), operatorId, operatorId].entries()) {
        const d = { id: uuidv7(), token: `ExponentPushToken[elig-${i}-${ulid()}]` };
        made.push(d);
        await sql`insert into devices (id, tenant_id, operator_user_id, label, status, push_token, push_warehouse_id, push_registered_at)
                  values (${d.id}, ${t.tenantId}, ${u}, 'elig', 'active', ${d.token}, ${t.whA}, now())`;
      }
      const eventId = await released();
      expect(await deliveries(t.tenantId, eventId)).toHaveLength(6);
      const selfClient = (await sql`select id from clients where tenant_id = ${t.tenantId} and system_owned limit 1`)[0]!.id as string;
      await sql`update users set status = 'invited' where id = ${users[0]!.userId}`; // deactivated
      await sql`update users set role = 'client', client_id = ${selfClient} where id = ${users[1]!.userId}`; // moved to a client
      await sql`update users set role = 'accountant' where id = ${users[2]!.userId}`; // not a floor role: no new work
      await sql`update devices set status = 'revoked' where id = ${made[4]!.id}`;
      await sql`update devices set push_warehouse_id = ${t.whB} where id = ${made[5]!.id}`;
      const gateway = new ScriptedGateway((messages) => messages.map(() => ({ ok: true })));
      const summary = await sender(gateway).sendDue(t.tenantId);
      expect(summary).toMatchObject({ claimed: 6, sent: 1, delivered: 1, failed: 5 });
      expect(gateway.batches[0]!.map((m) => m.to)).toEqual([made[0]!.token]);
      const rows = new Map((await deliveries(t.tenantId, eventId)).map((r) => [r.device_id, r]));
      expect(rows.get(made[0]!.id)!.status).toBe('sent');
      for (const d of made.slice(1)) expect(rows.get(d.id)).toMatchObject({ status: 'failed', error_code: 'ineligible' });
    });

    it('the same phone re-enrolled into tenant B: tenant A’s row fails `superseded` and A’s token is cleared — B keeps it', async () => {
      const shared = `ExponentPushToken[shared-${ulid()}]`;
      const inA = uuidv7();
      await sql`insert into devices (id, tenant_id, operator_user_id, label, status, push_token, push_warehouse_id, push_registered_at)
                values (${inA}, ${t.tenantId}, ${operatorId}, 'old', 'active', ${shared}, ${t.whA}, now() - interval '1 day')`;
      const b = await setupTenant('ReEnrolled');
      const inB = await handheld(b, 'operator', b.whA, shared);
      const eventId = await released();
      const gateway = new ScriptedGateway((messages) => messages.map(() => ({ ok: true })));
      const summary = await sender(gateway).sendDue(t.tenantId);
      expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
      expect(gateway.batches).toHaveLength(0);
      expect((await deliveries(t.tenantId, eventId))[0]).toMatchObject({ status: 'failed', error_code: 'superseded' });
      expect((await device(inA)).push_token).toBeNull();
      expect((await device(inB.deviceId)).push_token).toBe(shared);
    });

    it('the worker finds due tenants on AUTH_DATABASE and drives the facade; a stale `sending` row makes its tenant due too', async () => {
      await devices(1);
      await released();
      recorder.recorded.length = 0;
      const worker = new PushSenderWorker(app.get(AUTH_DATABASE) as never, app.get(NotificationsFacade));
      expect(await worker.tick()).toContain(t.tenantId);
      expect(recorder.recorded).toHaveLength(1);
      expect(await worker.tick()).not.toContain(t.tenantId);
      await sql`update push_deliveries set status = 'sending', updated_at = now() - interval '6 minutes' where tenant_id = ${t.tenantId}`;
      expect(await worker.tick()).toContain(t.tenantId);
      expect((await deliveries(t.tenantId))[0]!.error_code).toBe('stale');
    });
  });

  // ── the cutoff sweep ──────────────────────────────────────────────────────

  describe('the wave cutoff sweep', () => {
    let t: Tenant;
    let clock: WaveClock;
    let owner: Handheld;
    let ops: Handheld;

    beforeAll(async () => {
      t = await setupTenant('Sweep');
      clock = app.get<WaveClock>(WAVE_CLOCK);
      owner = await handheld(t, 'owner', t.whB);
      ops = await handheld(t, 'ops_manager', t.whB);
      await handheld(t, 'operator', t.whA);
      await handheld(t, 'accountant', t.whA);
    });

    /** Freezes BOTH clocks the at-risk path reads (the sweep's WAVE_CLOCK and the enqueue's pushClock). */
    function at(iso: string): void {
      jest.spyOn(clock, 'now').mockReturnValue(new Date(iso));
      pushClock.now = () => Date.parse(iso);
    }

    async function plannedWave(cutoff: string | null, status = 'planned'): Promise<string> {
      const policyId = uuidv7();
      await sql`insert into wave_policies (id, tenant_id, warehouse_id, name, cutoff_local_time)
                values (${policyId}, ${t.tenantId}, ${t.whA}, ${`P ${ulid()}`}, ${cutoff})`;
      const waveId = uuidv7();
      await sql`insert into waves (id, tenant_id, warehouse_id, policy_id, status, released_at, cancelled_at)
                values (${waveId}, ${t.tenantId}, ${t.whA}, ${policyId}, ${status},
                        ${status === 'released' ? sql`now()` : null}, ${status === 'cancelled' ? sql`now()` : null})`;
      return waveId;
    }

    async function atRiskEvents(waveId: string): Promise<number> {
      return (await sql`select 1 from outbox_messages where tenant_id = ${t.tenantId} and type = 'wave.cutoff_at_risk' and payload->>'waveId' = ${waveId}`).length;
    }

    beforeEach(async () => {
      await sql`delete from outbox_messages where tenant_id = ${t.tenantId}`;
      await sql`update waves set status = 'cancelled', cancelled_at = now() where tenant_id = ${t.tenantId} and status = 'planned'`;
    });

    it('cutoff 18:00 IST: at 17:00 / 17:01 / 17:59 raise (60, 59, 1 minutes); at 18:00 nothing (0)', async () => {
      for (const [instant, raises] of [
        ['2026-10-12T11:30:00.000Z', true], // 17:00 IST
        ['2026-10-12T11:31:00.000Z', true], // 17:01
        ['2026-10-12T12:29:59.000Z', true], // 17:59:59
        ['2026-10-12T12:30:00.000Z', false], // 18:00 — the release minute, warning moot
        ['2026-10-12T11:29:00.000Z', false], // 16:59 — 61 minutes, not yet
      ] as const) {
        const waveId = await plannedWave('18:00');
        at(instant);
        const result = await app.get(OutboundFacade).sweepCutoffRisk(t.tenantId);
        expect([instant, result.raised.includes(waveId)]).toEqual([instant, raises]);
        expect(await atRiskEvents(waveId)).toBe(raises ? 1 : 0);
        await sql`update waves set status = 'cancelled', cancelled_at = now() where id = ${waveId}`;
      }
    });

    it('ACCEPTANCE: a planned wave 45 minutes from cutoff, swept twice → ONE event; only waves.manage holders’ handhelds are queued', async () => {
      const waveId = await plannedWave('18:00');
      const noCutoff = await plannedWave(null);
      const releasedWave = await plannedWave('18:00', 'released');
      const cancelled = await plannedWave('18:00', 'cancelled');
      at('2026-10-12T11:45:00.000Z'); // 17:15 IST
      const outbound = app.get(OutboundFacade);
      expect((await outbound.sweepCutoffRisk(t.tenantId)).raised).toEqual([waveId]);
      expect((await outbound.sweepCutoffRisk(t.tenantId)).raised).toEqual([]);
      expect(await atRiskEvents(waveId)).toBe(1);
      for (const other of [noCutoff, releasedWave, cancelled]) expect(await atRiskEvents(other)).toBe(0);
      const [event] = await sql`select payload from outbox_messages where tenant_id = ${t.tenantId} and type = 'wave.cutoff_at_risk'`;
      expect(event!.payload).toEqual({ waveId, warehouseId: t.whA, cutoffLocalTime: '18:00', istDate: '2026-10-12' });
      expect((await sql`select cutoff_risk_alerted_on::text as d from waves where id = ${waveId}`)[0]!.d).toBe('2026-10-12');

      await drainAll();
      const rows = await sql`select device_id, kind, tab from push_deliveries where tenant_id = ${t.tenantId}`;
      expect(rows.map((r) => r.device_id).sort()).toEqual([owner.deviceId, ops.deviceId].sort());
      expect(rows.every((r) => r.kind === 'at-risk' && r.tab === 'All')).toBe(true);

      // The NEXT IST day it may raise again (once per wave per IST date).
      at('2026-10-13T11:45:00.000Z');
      expect((await outbound.sweepCutoffRisk(t.tenantId)).raised).toEqual([waveId]);
    });

    it('a released or cancelled wave raises nothing; the worker sweeps tenants with planned cut-off waves', async () => {
      const waveId = await plannedWave('18:00');
      at('2026-10-12T11:45:00.000Z');
      await sql`update waves set status = 'released', released_at = now() where id = ${waveId}`;
      expect((await app.get(OutboundFacade).sweepCutoffRisk(t.tenantId)).raised).toEqual([]);
      const live = await plannedWave('18:00');
      const worker = new WaveCutoffSweepWorker(app.get(AUTH_DATABASE) as never, app.get(OutboundFacade));
      expect(await worker.tick()).toContain(t.tenantId);
      expect(await atRiskEvents(live)).toBe(1);
    });
  });
});
