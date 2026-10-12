import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { nowIso } from '../src/shared/primitives/time';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import type { DomainEvent } from '../src/shared/events/event-bus.seam';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ReplenishmentFacade } from '../src/modules/replenishment/replenishment.facade';
import { ChannelsPublishService } from '../src/modules/channels/channels.publish';
import { BREAKER_FAILURE_THRESHOLD } from '../src/modules/channels/channels.view';
import { CHANNEL_SYNC_DEGRADED_EVENT, CHANNEL_SYNC_RECOVERED_EVENT } from '../src/modules/channels/channels.events';
import { BATCH_ALERT_CLEARED_EVENT, BREACH_CLEARED_EVENT } from '../src/modules/replenishment/replenishment.events';
import { REJECTED_OP_RAISED_EVENT } from '../src/modules/tenancy/sync-report.command';
import { signTenantSession } from '../src/modules/tenancy/jwt-session';
import { NotificationsDeliveryHandler } from '../src/modules/notifications/notifications.delivery';
import {
  NOTIFICATION_SOURCES,
  NOTIFICATION_SOURCE_TYPES,
  visibleSourceTypes,
  type NotificationSourceType,
} from '../src/modules/notifications/notification-sources';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.CHANNEL_ENCRYPTION_KEY ??= 'e2e-only-channel-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.CHANNELS_SYNC_POLL_MS;
delete process.env.REPLENISHMENT_SCHEDULER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

jest.setTimeout(120_000);

interface Tenant {
  tenantId: string;
  ownerId: string;
  ownerToken: string;
  opsToken: string;
  operatorToken: string;
  accountantToken: string;
  warehouseId: string;
}

interface EntryRow {
  id: string;
  source_type: string;
  source_id: string;
  warehouse_id: string | null;
  summary: Record<string, unknown> | null;
  raised_at: string | null;
  surfaced_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  updated_at: string;
}

/**
 * Story 9-2 — the notification panel end to end.
 *
 * Two kinds of fixture. The PROJECTION matrix (every source's raise and
 * resolve, tombstones, re-delivery, faults) seeds outbox rows directly with
 * the emitters' payload shapes and drains them through the REAL relay and
 * bus — a resolve-before-raise is just the rows in that order. The REAL
 * flows (an over-receipt through the device GRN and its approval, a channel
 * breaker's episodes and disconnect, a sync-report row and its discard, a
 * pending adjustment, a breach whose policy is deleted) prove the emitters
 * and the subscriber agree.
 */
describe('notifications (e2e, story 9-2)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  let suiteDb: SuiteDatabase;
  let relay: OutboxRelay;
  let delivery: NotificationsDeliveryHandler;
  const createdTenantIds: string[] = [];
  let main: Tenant;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('notifications');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    delivery = app.get(NotificationsDeliveryHandler);
    main = await setupTenant('Main');
  });

  afterAll(async () => {
    try {
      if (createdTenantIds.length > 0) {
        for (const tenant of createdTenantIds) {
          const keys = await valkey.keys(`wms:{${tenant}}:*`);
          if (keys.length > 0) await valkey.del(...keys);
        }
      }
    } finally {
      await valkey.quit().catch(() => valkey.disconnect());
      const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
      await rawDb.$client?.end();
      const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
      await authDb.$client?.end();
      await sql.end();
      await app.close();
      await suiteDb.drop();
    }
  });

  // ── fixtures ───────────────────────────────────────────────────────────────

  function signIn(email: string): Promise<string> {
    return request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email, password: PASSWORD })
      .expect(200)
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

  async function setupTenant(label: string): Promise<Tenant> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Notify ${label} ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    const tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const ownerToken = await signIn(email);
    const opsToken = await signIn((await invite(tenantId, ownerToken, 'ops_manager')).email);
    const operatorToken = await signIn((await invite(tenantId, ownerToken, 'operator')).email);
    const accountantToken = await signIn((await invite(tenantId, ownerToken, 'accountant')).email);
    const warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `NT-${ulid().slice(10, 16).toUpperCase()}`, name: `Notify WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
    return {
      tenantId,
      ownerId: registered.body.owner.id as string,
      ownerToken,
      opsToken,
      operatorToken,
      accountantToken,
      warehouseId,
    };
  }

  /** One outbox row, exactly as an emitter's in-tx append writes it. */
  async function emit(tenantId: string, type: string, payload: Record<string, unknown>, occurredAt = nowIso()): Promise<void> {
    await sql`
      insert into outbox_messages (id, tenant_id, type, payload, occurred_at, status, attempts, next_attempt_at)
      values (${uuidv7()}, ${tenantId}, ${type}, ${sql.json(payload as postgres.JSONValue)}, ${occurredAt}, 'pending', 0, now())`;
  }

  /** Drives the relay (past any backoff) until it has nothing due. */
  async function drainAll(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await sql`update outbox_messages set next_attempt_at = now() where status = 'pending'`;
      const drained = await relay.drain(100);
      if (drained.length === 0) return;
    }
  }

  async function entryRow(tenantId: string, sourceType: string, sourceId: string): Promise<EntryRow | undefined> {
    const rows = await sql`
      select id, source_type, source_id, warehouse_id, summary, raised_at::text as raised_at,
             surfaced_at::text as surfaced_at, resolved_at::text as resolved_at, resolution, updated_at::text as updated_at
      from notifications where tenant_id = ${tenantId} and source_type = ${sourceType} and source_id = ${sourceId}`;
    return rows[0] as unknown as EntryRow | undefined;
  }

  function list(tenantId: string, token: string, query: Record<string, unknown> = {}): request.Test {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/notifications`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);
  }

  async function hasNew(tenantId: string, token: string): Promise<boolean> {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/notifications/status`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Object.keys(res.body)).toEqual(['hasNew']);
    return res.body.hasNew as boolean;
  }

  function opened(tenantId: string, token: string): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/notifications/opened`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function allEntries(tenantId: string, token: string): Promise<Record<string, unknown>[]> {
    const res = await list(tenantId, token, { limit: 100 }).expect(200);
    return res.body.items as Record<string, unknown>[];
  }

  // ── the per-source raise/resolve fixtures (the emitters' payload shapes) ──

  interface SourceCase {
    readonly sourceType: NotificationSourceType;
    readonly raise: (sourceId: string, warehouseId: string) => { type: string; payload: Record<string, unknown> };
    readonly summary: (warehouseId: string) => Record<string, unknown>;
    readonly warehouse: boolean;
    readonly resolve: (sourceId: string, warehouseId: string) => { type: string; payload: Record<string, unknown> };
    readonly resolution: string;
  }

  const SKU = uuidv7();
  const OTHER = uuidv7();
  const CONNECTION = uuidv7();

  const CASES: readonly SourceCase[] = [
    {
      sourceType: 'stock-adjustment',
      raise: (id, w) => ({
        type: 'stock_adjustment.pending_approval',
        payload: { pendingAdjustmentId: id, warehouseId: w, skuId: SKU, binId: OTHER, quantityDelta: -12.5, reasonCode: 'damaged', requestedBy: OTHER, requestedAt: nowIso(), thresholdQuantity: 10, notifyRole: 'owner' },
      }),
      summary: () => ({ skuId: SKU, quantityDelta: -12.5, reasonCode: 'damaged' }),
      warehouse: true,
      resolve: (id, w) => ({ type: 'stock_adjustment.rejected', payload: { pendingAdjustmentId: id, warehouseId: w, skuId: SKU, decidedBy: OTHER } }),
      resolution: 'rejected',
    },
    {
      sourceType: 'count-variance',
      raise: (id, w) => ({
        type: 'count.variance.threshold_exceeded',
        payload: { varianceId: id, taskId: OTHER, warehouseId: w, binId: OTHER, skuId: SKU, delta: 7, thresholdQuantity: 5, notifyRole: 'owner' },
      }),
      summary: () => ({ skuId: SKU, delta: 7 }),
      warehouse: true,
      resolve: (id, w) => ({ type: 'count.variance.resolved', payload: { varianceId: id, warehouseId: w, decision: 'recount', status: 'recounted', overThreshold: true } }),
      resolution: 'recounted',
    },
    {
      sourceType: 'over-receipt',
      raise: (id, w) => ({
        type: 'over_receipt.requested',
        payload: { overReceiptId: id, warehouseId: w, grnId: OTHER, grnCode: 'GRN-000042', poId: OTHER, poLineId: OTHER, skuId: SKU, excessQty: 3, requestedBy: OTHER, requestedAt: nowIso() },
      }),
      summary: () => ({ grnCode: 'GRN-000042', skuId: SKU, excessQty: 3 }),
      warehouse: true,
      resolve: (id, w) => ({ type: 'over_receipt.approved', payload: { overReceiptId: id, warehouseId: w, grnCode: 'GRN-000042', skuId: SKU, excessQty: 3 } }),
      resolution: 'approved',
    },
    {
      sourceType: 'rejected-op',
      raise: (id) => ({
        type: 'device.rejected_op.raised',
        payload: { rejectedOpId: id, opId: ulid(), opType: 'pick.record', problemCode: 'pick-bin-short', deviceId: OTHER, operatorUserId: OTHER },
      }),
      summary: () => ({ opType: 'pick.record', problemCode: 'pick-bin-short' }),
      warehouse: false,
      resolve: (id) => ({ type: 'device.rejected_op.resolved', payload: { rejectedOpId: id, decision: 'discard', status: 'discarded' } }),
      resolution: 'discarded',
    },
    {
      sourceType: 'reorder-breach',
      raise: (id, w) => ({
        type: 'replenishment.breach_detected',
        payload: { breachId: id, warehouseId: w, skuId: SKU, atpMilli: 1500, pointMilli: 4000, breachAt: nowIso(), notifyRole: 'ops_manager' },
      }),
      summary: () => ({ skuId: SKU, atpQty: 1.5, pointQty: 4 }),
      warehouse: true,
      resolve: (id, w) => ({ type: 'replenishment.breach_cleared', payload: { breachId: id, warehouseId: w, skuId: SKU, reason: 'actioned' } }),
      resolution: 'actioned',
    },
    {
      sourceType: 'batch-alert',
      raise: (id, w) => ({
        type: 'replenishment.batch_alert_raised',
        payload: { alertId: id, kind: 'aged', warehouseId: w, skuId: SKU, batchId: OTHER, batchCode: 'LOT-7', ageDays: 40, notifyRole: 'ops_manager' },
      }),
      summary: () => ({ kind: 'aged', skuId: SKU, batchCode: 'LOT-7', ageDays: 40 }),
      warehouse: true,
      resolve: (id, w) => ({ type: 'replenishment.batch_alert_cleared', payload: { alertId: id, warehouseId: w, reason: 'resolved' } }),
      resolution: 'resolved',
    },
    {
      sourceType: 'qc-hold',
      raise: (id, w) => ({
        type: 'qc_hold.placed',
        payload: { holdId: id, tenantId: OTHER, warehouseId: w, skuId: SKU, binId: OTHER, reason: 'Seal broken', heldBy: OTHER, heldAt: nowIso() },
      }),
      summary: () => ({ skuId: SKU, reason: 'Seal broken' }),
      warehouse: true,
      resolve: (id, w) => ({ type: 'qc_hold.released', payload: { holdId: id, warehouseId: w, skuId: SKU, reason: 'Seal broken' } }),
      resolution: 'released',
    },
    {
      sourceType: 'channel-sync',
      raise: (id) => ({ type: 'channel.sync.degraded', payload: { connectionId: CONNECTION, episodeId: id } }),
      summary: () => ({ connectionId: CONNECTION }),
      warehouse: false,
      resolve: (id) => ({ type: 'channel.sync.recovered', payload: { connectionId: CONNECTION, episodeId: id, reason: 'recovered' } }),
      resolution: 'recovered',
    },
  ];

  // ── the vocabulary pins ────────────────────────────────────────────────────

  describe('the vocabulary', () => {
    it('the TS source tuple equals the notifications_source_type_check IN-list, and every source has a case here', async () => {
      const rows = await sql`
        select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_source_type_check'`;
      expect(rows).toHaveLength(1);
      const def = (rows[0] as { def: string }).def;
      const inList = [...def.matchAll(/'([a-z-]+)'::text/g)].map((match) => match[1]);
      expect([...inList].sort()).toEqual([...NOTIFICATION_SOURCE_TYPES].sort());
      expect(CASES.map((c) => c.sourceType)).toEqual([...NOTIFICATION_SOURCE_TYPES]);
    });

    it('the subscriber listens for exactly the emitters’ event types (the new events pinned to their constants)', () => {
      expect(NOTIFICATION_SOURCES['channel-sync'].raise.type).toBe(CHANNEL_SYNC_DEGRADED_EVENT);
      expect(NOTIFICATION_SOURCES['channel-sync'].resolves.map((r) => r.type)).toEqual([CHANNEL_SYNC_RECOVERED_EVENT]);
      expect(NOTIFICATION_SOURCES['rejected-op'].raise.type).toBe(REJECTED_OP_RAISED_EVENT);
      expect(NOTIFICATION_SOURCES['reorder-breach'].resolves.map((r) => r.type)).toEqual([BREACH_CLEARED_EVENT]);
      expect(NOTIFICATION_SOURCES['batch-alert'].resolves.map((r) => r.type)).toEqual([BATCH_ALERT_CLEARED_EVENT]);
      for (const c of CASES) {
        expect(NOTIFICATION_SOURCES[c.sourceType].raise.type).toBe(c.raise(uuidv7(), uuidv7()).type);
        expect(NOTIFICATION_SOURCES[c.sourceType].resolves.map((r) => r.type)).toContain(c.resolve(uuidv7(), uuidv7()).type);
      }
    });

    it('routes by the capability that acts — never the payloads’ notifyRole hints', () => {
      expect(visibleSourceTypes('owner')).toEqual([...NOTIFICATION_SOURCE_TYPES]);
      expect(visibleSourceTypes('ops_manager')).toEqual(['over-receipt', 'rejected-op', 'reorder-breach', 'batch-alert', 'qc-hold', 'channel-sync']);
      expect(visibleSourceTypes('operator')).toEqual([]);
      expect(visibleSourceTypes('accountant')).toEqual([]);
      expect(visibleSourceTypes('client')).toEqual([]);
    });

    it('the CHECKs refuse what the migration probe refuses (named constraints), and RLS fails closed on both tables', async () => {
      const t = main.tenantId;
      const refused = async (statement: Promise<unknown>, constraint: string): Promise<void> => {
        await expect(statement).rejects.toMatchObject({ code: '23514', constraint_name: constraint });
      };
      await refused(
        sql`insert into notifications (id, tenant_id, source_type, source_id, summary, raised_at, surfaced_at)
            values (${uuidv7()}, ${t}, 'task-assignment', ${uuidv7()}, '{}'::jsonb, now(), now())`,
        'notifications_source_type_check',
      );
      await refused(
        sql`insert into notifications (id, tenant_id, source_type, source_id, summary) values (${uuidv7()}, ${t}, 'qc-hold', ${uuidv7()}, null)`,
        'notifications_shape_check',
      );
      await refused(
        sql`insert into notifications (id, tenant_id, source_type, source_id, summary, raised_at, surfaced_at, resolved_at)
            values (${uuidv7()}, ${t}, 'qc-hold', ${uuidv7()}, '{}'::jsonb, now(), now(), now())`,
        'notifications_shape_check',
      );

      // RLS: a seeded row of each table, invisible to the non-superuser
      // probe role unless the session is stamped with its tenant.
      const sourceId = uuidv7();
      await sql`insert into notifications (id, tenant_id, source_type, source_id, summary, raised_at, surfaced_at)
                values (${uuidv7()}, ${t}, 'qc-hold', ${sourceId}, '{}'::jsonb, now(), now())`;
      await sql`insert into notification_reads (tenant_id, user_id, last_opened_at) values (${t}, ${uuidv7()}, now())`;
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        for (const table of ['notifications', 'notification_reads']) {
          expect(await rls.unsafe(`select 1 from ${table} where tenant_id = $1`, [t])).toHaveLength(0);
          const foreign = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
            return tx.unsafe(`select 1 from ${table} where tenant_id = $1`, [t]);
          });
          expect(foreign).toHaveLength(0);
          const own = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${t}, true)`;
            return tx.unsafe(`select 1 from ${table} where tenant_id = $1`, [t]);
          });
          expect(own.length).toBeGreaterThan(0);
        }
      } finally {
        await rls.end();
      }
      await sql`delete from notifications where tenant_id = ${t} and source_id = ${sourceId}`;
      await sql`delete from notification_reads where tenant_id = ${t}`;
    });
  });

  // ── the projection ─────────────────────────────────────────────────────────

  describe('the projection (outbox rows through the real relay and bus)', () => {
    let tenant: Tenant;
    const ids = new Map<NotificationSourceType, string>();

    beforeAll(async () => {
      tenant = await setupTenant('Projection');
    });

    it('each source’s raise lands ONE open entry: raised_at = occurredAt, its warehouse, and exactly the allowlisted summary', async () => {
      const occurredAt = '2026-10-01T08:00:00.000Z';
      for (const c of CASES) {
        const id = uuidv7();
        ids.set(c.sourceType, id);
        const { type, payload } = c.raise(id, tenant.warehouseId);
        await emit(tenant.tenantId, type, payload, occurredAt);
      }
      await drainAll();
      for (const c of CASES) {
        const row = await entryRow(tenant.tenantId, c.sourceType, ids.get(c.sourceType)!);
        expect(row).toBeDefined();
        // key by key — never the raw payload (no notifyRole, tenantId, actor ids)
        expect(row!.summary).toEqual(c.summary(tenant.warehouseId));
        expect(row!.warehouse_id).toBe(c.warehouse ? tenant.warehouseId : null);
        expect(new Date(row!.raised_at!).toISOString()).toBe(occurredAt);
        expect(row!.surfaced_at).not.toBeNull();
        expect(new Date(row!.surfaced_at!).getTime()).toBeGreaterThan(Date.parse(occurredAt));
        expect(row!.resolved_at).toBeNull();
        expect(row!.resolution).toBeNull();
      }
      // The API serves them, each a union arm carrying its own summary.
      const items = await allEntries(tenant.tenantId, tenant.ownerToken);
      for (const c of CASES) {
        const item = items.find((entry) => entry.sourceId === ids.get(c.sourceType));
        expect(item).toEqual({
          id: expect.any(String),
          sourceType: c.sourceType,
          sourceId: ids.get(c.sourceType),
          warehouseId: c.warehouse ? tenant.warehouseId : null,
          summary: c.summary(tenant.warehouseId),
          raisedAt: occurredAt,
          resolvedAt: null,
          resolution: null,
        });
      }
    });

    it('each source’s resolve stamps resolved_at (its occurredAt) and the resolution; a second resolve changes nothing', async () => {
      const resolvedAt = '2026-10-02T09:30:00.000Z';
      for (const c of CASES) {
        const { type, payload } = c.resolve(ids.get(c.sourceType)!, tenant.warehouseId);
        await emit(tenant.tenantId, type, payload, resolvedAt);
      }
      await drainAll();
      for (const c of CASES) {
        const row = (await entryRow(tenant.tenantId, c.sourceType, ids.get(c.sourceType)!))!;
        expect(new Date(row.resolved_at!).toISOString()).toBe(resolvedAt);
        expect(row.resolution).toBe(c.resolution);
      }
      // A later resolve with another resolution is a no-op (resolved once).
      const qc = CASES.find((c) => c.sourceType === 'over-receipt')!;
      const before = (await entryRow(tenant.tenantId, 'over-receipt', ids.get('over-receipt')!))!;
      await emit(tenant.tenantId, 'over_receipt.rejected', { ...qc.resolve(ids.get('over-receipt')!, tenant.warehouseId).payload });
      await drainAll();
      expect(await entryRow(tenant.tenantId, 'over-receipt', ids.get('over-receipt')!)).toEqual(before);
      const items = await allEntries(tenant.tenantId, tenant.ownerToken);
      expect(items.filter((item) => item.resolvedAt === resolvedAt)).toHaveLength(CASES.length);
    });

    it('a resolve BEFORE its raise leaves a tombstone (never listed); the late raise fills it and stays resolved — no dot', async () => {
      const fresh = await setupTenant('Tombstone');
      const holdId = uuidv7();
      const qc = CASES.find((c) => c.sourceType === 'qc-hold')!;
      // The rows in the out-of-order sequence: the resolve committed first.
      await emit(fresh.tenantId, 'qc_hold.released', qc.resolve(holdId, fresh.warehouseId).payload, '2026-10-03T10:00:00.000Z');
      await drainAll();
      const tombstone = (await entryRow(fresh.tenantId, 'qc-hold', holdId))!;
      expect(tombstone).toMatchObject({ summary: null, raised_at: null, surfaced_at: null, resolution: 'released' });
      expect((await list(fresh.tenantId, fresh.ownerToken).expect(200)).body.items).toEqual([]);
      expect(await hasNew(fresh.tenantId, fresh.ownerToken)).toBe(false);

      await emit(fresh.tenantId, 'qc_hold.placed', qc.raise(holdId, fresh.warehouseId).payload, '2026-10-03T09:00:00.000Z');
      await drainAll();
      const filled = (await entryRow(fresh.tenantId, 'qc-hold', holdId))!;
      expect(filled.summary).toEqual(qc.summary(fresh.warehouseId));
      expect(new Date(filled.raised_at!).toISOString()).toBe('2026-10-03T09:00:00.000Z');
      expect(filled.surfaced_at).not.toBeNull();
      expect(new Date(filled.resolved_at!).toISOString()).toBe('2026-10-03T10:00:00.000Z');
      expect(filled.resolution).toBe('released');
      const items = (await list(fresh.tenantId, fresh.ownerToken).expect(200)).body.items as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ sourceId: holdId, resolution: 'released' });
      // Resolved before it was ever open: the dot never lights for it.
      expect(await hasNew(fresh.tenantId, fresh.ownerToken)).toBe(false);
    });

    it('re-delivery of a raise changes nothing (not even a different summary or instant)', async () => {
      const holdId = uuidv7();
      const qc = CASES.find((c) => c.sourceType === 'qc-hold')!;
      const event: DomainEvent = {
        eventId: uuidv7(),
        type: 'qc_hold.placed',
        tenantId: tenant.tenantId,
        occurredAt: '2026-10-04T08:00:00.000Z',
        payload: qc.raise(holdId, tenant.warehouseId).payload,
      };
      await delivery.deliver(event);
      const first = (await entryRow(tenant.tenantId, 'qc-hold', holdId))!;
      await delivery.deliver(event);
      await delivery.deliver({ ...event, occurredAt: '2026-10-05T08:00:00.000Z', payload: { ...event.payload, reason: 'Different' } });
      // And through the relay too (a duplicated outbox row).
      await emit(tenant.tenantId, 'qc_hold.placed', event.payload, event.occurredAt);
      await drainAll();
      expect(await entryRow(tenant.tenantId, 'qc-hold', holdId)).toEqual(first);
      const count = await sql`select count(*)::int as n from notifications where tenant_id = ${tenant.tenantId} and source_id = ${holdId}`;
      expect((count[0] as { n: number }).n).toBe(1);
    });

    it('an under-threshold variance resolve leaves NO row; an over-threshold one before its raise leaves a tombstone', async () => {
      const ordinary = uuidv7();
      await emit(tenant.tenantId, 'count.variance.resolved', { varianceId: ordinary, status: 'adjusted', overThreshold: false });
      const over = uuidv7();
      await emit(tenant.tenantId, 'count.variance.resolved', { varianceId: over, status: 'adjusted', overThreshold: true });
      await drainAll();
      expect(await entryRow(tenant.tenantId, 'count-variance', ordinary)).toBeUndefined();
      expect(await entryRow(tenant.tenantId, 'count-variance', over)).toMatchObject({ summary: null, resolution: 'adjusted' });
    });

    it('malformed payloads ACK (the row leaves the outbox) and write nothing', async () => {
      const bad = uuidv7();
      await emit(tenant.tenantId, 'qc_hold.placed', { holdId: bad, warehouseId: tenant.warehouseId, skuId: 'not-a-uuid', reason: 'x' });
      await emit(tenant.tenantId, 'qc_hold.placed', { holdId: uuidv7(), warehouseId: 'nope', skuId: SKU, reason: 'x' });
      await emit(tenant.tenantId, 'replenishment.breach_cleared', { breachId: bad, warehouseId: tenant.warehouseId, reason: 'vanished' });
      await emit(tenant.tenantId, 'replenishment.breach_detected', { breachId: bad, warehouseId: tenant.warehouseId, skuId: SKU, atpMilli: 1.5, pointMilli: 4000 });
      await emit(tenant.tenantId, 'channel.sync.degraded', { connectionId: CONNECTION });
      await drainAll();
      const left = await sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenant.tenantId}`;
      expect((left[0] as { n: number }).n).toBe(0);
      const rows = await sql`select count(*)::int as n from notifications where tenant_id = ${tenant.tenantId} and source_id = ${bad}`;
      expect((rows[0] as { n: number }).n).toBe(0);
    });

    it('SQLSTATE class 22 and 23 faults ACK; anything else RETHROWS to the relay', async () => {
      const qc = CASES.find((c) => c.sourceType === 'qc-hold')!;
      const event = (payload: Record<string, unknown>): DomainEvent => ({
        eventId: uuidv7(),
        type: 'qc_hold.placed',
        tenantId: tenant.tenantId,
        occurredAt: nowIso(),
        payload,
      });
      // A REAL class-22 fault: jsonb refuses a NUL character (22P05).
      const nul = uuidv7();
      await expect(delivery.deliver(event({ ...qc.raise(nul, tenant.warehouseId).payload, reason: 'a\u0000b' }))).resolves.toBeUndefined();
      expect(await entryRow(tenant.tenantId, 'qc-hold', nul)).toBeUndefined();

      // Class 23 (wrapped the way drizzle wraps the driver's error) acks…
      const integrity = Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('violates check'), { code: '23514' }) });
      const spy = jest.spyOn(delivery as unknown as { raise: () => Promise<void> }, 'raise');
      spy.mockRejectedValueOnce(integrity);
      await expect(delivery.deliver(event(qc.raise(uuidv7(), tenant.warehouseId).payload))).resolves.toBeUndefined();
      // …a deadlock (40P01) and an unclassified error rethrow.
      spy.mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
      await expect(delivery.deliver(event(qc.raise(uuidv7(), tenant.warehouseId).payload))).rejects.toThrow('deadlock detected');
      spy.mockRejectedValueOnce(new Error('connection reset'));
      await expect(delivery.deliver(event(qc.raise(uuidv7(), tenant.warehouseId).payload))).rejects.toThrow('connection reset');
      spy.mockRestore();
    });
  });

  // ── routing and the HTTP surface ───────────────────────────────────────────

  describe('routing and the HTTP surface', () => {
    let tenant: Tenant;
    const ids = new Map<NotificationSourceType, string>();

    beforeAll(async () => {
      tenant = await setupTenant('Routing');
      for (const c of CASES) {
        const id = uuidv7();
        ids.set(c.sourceType, id);
        const { type, payload } = c.raise(id, tenant.warehouseId);
        await emit(tenant.tenantId, type, payload);
      }
      await drainAll();
    });

    it('a member sees only the sources it can act on: owner all eight, ops manager six, operator and accountant none (and no dot)', async () => {
      const typesOf = async (token: string): Promise<string[]> =>
        (await allEntries(tenant.tenantId, token)).map((item) => item.sourceType as string).sort();
      expect(await typesOf(tenant.ownerToken)).toEqual([...NOTIFICATION_SOURCE_TYPES].sort());
      expect(await typesOf(tenant.opsToken)).toEqual(
        ['over-receipt', 'rejected-op', 'reorder-breach', 'batch-alert', 'qc-hold', 'channel-sync'].sort(),
      );
      expect(await typesOf(tenant.operatorToken)).toEqual([]);
      expect(await typesOf(tenant.accountantToken)).toEqual([]);
      expect(await hasNew(tenant.tenantId, tenant.operatorToken)).toBe(false);
      expect(await hasNew(tenant.tenantId, tenant.accountantToken)).toBe(false);
      expect((await opened(tenant.tenantId, tenant.operatorToken).expect(200)).body).toEqual({ hasNew: false });
      expect(await hasNew(tenant.tenantId, tenant.ownerToken)).toBe(true);
      expect(await hasNew(tenant.tenantId, tenant.opsToken)).toBe(true);
    });

    it('a client-portal token is fenced (403 role-denied) on all three routes; another tenant’s path is 403 permission-denied', async () => {
      const portalToken = signTenantSession(tenant.tenantId, tenant.ownerId, process.env.JWT_SECRET!, undefined, uuidv7());
      for (const call of [
        () => request(app.getHttpServer()).get(`${API}/${tenant.tenantId}/notifications`),
        () => request(app.getHttpServer()).get(`${API}/${tenant.tenantId}/notifications/status`),
        () => request(app.getHttpServer()).post(`${API}/${tenant.tenantId}/notifications/opened`),
      ]) {
        const res = await call().set('Authorization', `Bearer ${portalToken}`).expect(403);
        expect(res.body).toMatchObject({ code: 'role-denied', detail: 'This is an operator surface.' });
      }
      const foreign = await list(main.tenantId, tenant.ownerToken).expect(403);
      expect(foreign.body.code).toBe('permission-denied');
      await request(app.getHttpServer()).get(`${API}/${tenant.tenantId}/notifications`).expect(401);
    });

    it('keyset paging at limit=2 walks every entry once, newest (raised_at, id) first; a bad cursor is 400 invalid-cursor; limit outside 1–100 is 400 validation-failed; the default is 25', async () => {
      // Thirty more QC holds — some sharing one instant (the tie group).
      const tie = '2026-10-06T12:00:00.000Z';
      for (let i = 0; i < 30; i += 1) {
        const qc = CASES.find((c) => c.sourceType === 'qc-hold')!;
        await emit(tenant.tenantId, 'qc_hold.placed', qc.raise(uuidv7(), tenant.warehouseId).payload, i < 10 ? tie : nowIso());
      }
      await drainAll();
      const everything = await allEntries(tenant.tenantId, tenant.ownerToken);
      expect(everything).toHaveLength(38);
      for (let i = 1; i < everything.length; i += 1) {
        const prev = everything[i - 1]!;
        const cur = everything[i]!;
        const ordered =
          (prev.raisedAt as string) > (cur.raisedAt as string) ||
          (prev.raisedAt === cur.raisedAt && (prev.id as string) > (cur.id as string));
        expect(ordered).toBe(true);
      }
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let hops = 0; hops < 40; hops += 1) {
        const res = await list(tenant.tenantId, tenant.ownerToken, cursor === null ? { limit: 2 } : { limit: 2, cursor }).expect(200);
        expect((res.body.items as unknown[]).length).toBeLessThanOrEqual(2);
        walked.push(...(res.body.items as { id: string }[]).map((item) => item.id));
        cursor = res.body.nextCursor as string | null;
        if (cursor === null) break;
      }
      expect(walked).toEqual(everything.map((item) => item.id));

      const firstPage = await list(tenant.tenantId, tenant.ownerToken).expect(200);
      expect((firstPage.body.items as { id: string }[]).map((item) => item.id)).toEqual(everything.slice(0, 25).map((item) => item.id));
      expect(firstPage.body.nextCursor).not.toBeNull();

      expect((await list(tenant.tenantId, tenant.ownerToken, { cursor: 'not-a-cursor' }).expect(400)).body.code).toBe('invalid-cursor');
      const forged = Buffer.from(JSON.stringify({ createdAt: 'yesterday', id: uuidv7() })).toString('base64url');
      expect((await list(tenant.tenantId, tenant.ownerToken, { cursor: forged }).expect(400)).body.code).toBe('invalid-cursor');
      for (const limit of [0, 101, 'ten']) {
        expect((await list(tenant.tenantId, tenant.ownerToken, { limit }).expect(400)).body.code).toBe('validation-failed');
      }
      expect((await list(tenant.tenantId, tenant.ownerToken, { limit: 100 }).expect(200)).body.items).toHaveLength(38);
    });

    it('the routes are in the OpenAPI document, with the summary a discriminated union on sourceType', async () => {
      const doc = (await request(app.getHttpServer()).get('/api/v1/openapi.json').expect(200)).body;
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([
          '/tenants/{tenantId}/notifications',
          '/tenants/{tenantId}/notifications/status',
          '/tenants/{tenantId}/notifications/opened',
        ]),
      );
      const items = doc.components.schemas.NotificationListResponse.properties.items.items;
      expect(items.discriminator.propertyName).toBe('sourceType');
      expect(Object.keys(items.discriminator.mapping).sort()).toEqual([...NOTIFICATION_SOURCE_TYPES].sort());
      // The opened mark takes no Idempotency-Key (the documented exception).
      const openedOp = doc.paths['/tenants/{tenantId}/notifications/opened'].post;
      expect((openedOp.parameters ?? []).some((p: { name: string }) => p.name === 'Idempotency-Key')).toBe(false);
    });
  });

  // ── the dot ────────────────────────────────────────────────────────────────

  describe('the status rules', () => {
    it('open entries only; surfaced_at against last_opened_at; a first-time member; opened clears it', async () => {
      const t = await setupTenant('Status');
      const qc = CASES.find((c) => c.sourceType === 'qc-hold')!;
      // Nothing at all: no dot, even with no read row.
      expect(await hasNew(t.tenantId, t.ownerToken)).toBe(false);

      // Only RESOLVED history, never opened: still no dot.
      const resolvedHold = uuidv7();
      await emit(t.tenantId, 'qc_hold.placed', qc.raise(resolvedHold, t.warehouseId).payload);
      await emit(t.tenantId, 'qc_hold.released', qc.resolve(resolvedHold, t.warehouseId).payload);
      await drainAll();
      expect(await hasNew(t.tenantId, t.ownerToken)).toBe(false);

      // An OPEN entry for a member who never opened the panel: the dot.
      const openHold = uuidv7();
      await emit(t.tenantId, 'qc_hold.placed', qc.raise(openHold, t.warehouseId).payload);
      await drainAll();
      expect(await hasNew(t.tenantId, t.ownerToken)).toBe(true);
      expect(await hasNew(t.tenantId, t.opsToken)).toBe(true);

      // Opening clears it (for that member only) and records the instant.
      expect((await opened(t.tenantId, t.ownerToken).expect(200)).body).toEqual({ hasNew: false });
      expect(await hasNew(t.tenantId, t.ownerToken)).toBe(false);
      expect(await hasNew(t.tenantId, t.opsToken)).toBe(true);
      const reads = await sql`select user_id, last_opened_at::text as at from notification_reads where tenant_id = ${t.tenantId}`;
      expect(reads.map((r) => (r as { user_id: string }).user_id)).toEqual([t.ownerId]);
      // Opening again is harmless (no key, just a later instant).
      await opened(t.tenantId, t.ownerToken).expect(200);
      const again = await sql`select last_opened_at::text as at from notification_reads where tenant_id = ${t.tenantId} and user_id = ${t.ownerId}`;
      expect((again[0] as { at: string }).at >= (reads[0] as { at: string }).at).toBe(true);

      // LATE delivery: raised (occurredAt) BEFORE the open, projected after —
      // surfaced_at decides, so the dot shows.
      const lateHold = uuidv7();
      await emit(t.tenantId, 'qc_hold.placed', qc.raise(lateHold, t.warehouseId).payload, new Date(Date.now() - 10 * 60_000).toISOString());
      await drainAll();
      expect(await hasNew(t.tenantId, t.ownerToken)).toBe(true);

      // Resolving the only new entry before the member looks: no dot (open only).
      await emit(t.tenantId, 'qc_hold.released', qc.resolve(lateHold, t.warehouseId).payload);
      await drainAll();
      expect(await hasNew(t.tenantId, t.ownerToken)).toBe(false);

      // An owner-only source the ops manager cannot see never lights the
      // ops manager's dot, but lights the owner's.
      await opened(t.tenantId, t.opsToken).expect(200);
      const variance = CASES.find((c) => c.sourceType === 'count-variance')!;
      await emit(t.tenantId, 'count.variance.threshold_exceeded', variance.raise(uuidv7(), t.warehouseId).payload);
      await drainAll();
      expect(await hasNew(t.tenantId, t.opsToken)).toBe(false);
      expect(await hasNew(t.tenantId, t.ownerToken)).toBe(true);
    });
  });

  // ── the real flows ─────────────────────────────────────────────────────────

  describe('real flows: the emitters and the subscriber agree', () => {
    let skuId: string;
    let binId: string;
    let deviceToken: string;
    let badgeToken: string;

    beforeAll(async () => {
      const t = main;
      const zoneId = (
        await request(app.getHttpServer())
          .post(`${API}/${t.tenantId}/warehouses/${t.warehouseId}/zones`)
          .set('Authorization', `Bearer ${t.ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'A', name: 'Aisle A' })
          .expect(201)
      ).body.id as string;
      binId = (
        await request(app.getHttpServer())
          .post(`${API}/${t.tenantId}/warehouses/${t.warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${t.ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 10000, type: 'shelf', code: 'A-01-01' })
          .expect(201)
      ).body.id as string;
      const csv = [
        'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
        'NT-A,Notify item A,pcs,,1800,,false,false,,,',
        'NT-B,Notify item B,pcs,,1800,,false,false,,,',
      ].join('\n');
      await request(app.getHttpServer())
        .post(`${API}/${t.tenantId}/catalog/imports`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .field('mode', 'initial')
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
        .expect(201);
      const skus = await request(app.getHttpServer())
        .get(`${API}/${t.tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .expect(200);
      skuId = (skus.body.items as { code: string; id: string }[]).find((item) => item.code === 'NT-A')!.id;
      await app.get(InventoryFacade).rebuildReservationCounters(t.tenantId, t.warehouseId);

      const minted = await request(app.getHttpServer())
        .post(`${API}/${t.tenantId}/devices/enrollment-codes`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .expect(201);
      deviceToken = (
        await request(app.getHttpServer())
          .post(`${API}/${t.tenantId}/devices/enroll`)
          .set(KEY_HEADER, ulid())
          .send({ code: minted.body.code, label: 'Notify dock scanner', pin: '2468' })
          .expect(201)
      ).body.deviceToken as string;
      const floor = await invite(t.tenantId, t.ownerToken, 'operator');
      badgeToken = (
        await request(app.getHttpServer())
          .post(`${API}/${t.tenantId}/devices/badge-in`)
          .set('Authorization', `Bearer ${deviceToken}`)
          .send({ operatorEmail: floor.email, pin: '2468' })
          .expect(200)
      ).body.accessToken as string;
    });

    it('ACCEPTANCE: a pending over-receipt is listed newest-first, open, in its warehouse for the owner (not the operator); approval resolves it', async () => {
      const t = main;
      const vendorId = (
        await request(app.getHttpServer())
          .post(`${API}/${t.tenantId}/vendors`)
          .set('Authorization', `Bearer ${t.ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'V-NT', name: 'Notify Vendor' })
          .expect(201)
      ).body.vendor.id as string;
      const po = (
        await request(app.getHttpServer())
          .post(`${API}/${t.tenantId}/inbound/purchase-orders`)
          .set('Authorization', `Bearer ${t.ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId: t.warehouseId, vendorId, code: `PO-${ulid().slice(10, 18)}`, lines: [{ skuId, orderedQty: 5, unitCostPaise: 100 }] })
          .expect(201)
      ).body.purchaseOrder as { id: string; lines: { id: string }[] };
      const grn = await request(app.getHttpServer())
        .post(`${API}/${t.tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${badgeToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId: t.warehouseId,
          poId: po.id,
          blindReasonCode: null,
          occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          lines: [{ poLineId: po.lines[0]!.id, skuId, batchCode: null, mfgDate: null, qty: 8 }],
        })
        .expect(201);
      const grnCode = grn.body.goodsReceipt.code as string;

      // The additive payload field: the request names its warehouse.
      const requested = await sql`select payload from outbox_messages where tenant_id = ${t.tenantId} and type = 'over_receipt.requested'`;
      expect(requested).toHaveLength(1);
      const payload = (requested[0] as { payload: Record<string, unknown> }).payload;
      expect(payload).toMatchObject({ warehouseId: t.warehouseId, grnCode, skuId, excessQty: 3 });
      const overReceiptId = payload.overReceiptId as string;
      await drainAll();

      expect(await hasNew(t.tenantId, t.ownerToken)).toBe(true);
      const owner = (await list(t.tenantId, t.ownerToken).expect(200)).body.items as Record<string, unknown>[];
      expect(owner[0]).toEqual({
        id: expect.any(String),
        sourceType: 'over-receipt',
        sourceId: overReceiptId,
        warehouseId: t.warehouseId,
        summary: { grnCode, skuId, excessQty: 3 },
        raisedAt: expect.any(String),
        resolvedAt: null,
        resolution: null,
      });
      expect((await list(t.tenantId, t.opsToken).expect(200)).body.items[0]).toMatchObject({ sourceId: overReceiptId });
      expect((await list(t.tenantId, t.operatorToken).expect(200)).body.items).toEqual([]);
      expect(await hasNew(t.tenantId, t.operatorToken)).toBe(false);

      await request(app.getHttpServer())
        .post(`${API}/${t.tenantId}/receiving/over-receipts/${overReceiptId}/approve`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .expect(200);
      const approved = await sql`select payload from outbox_messages where tenant_id = ${t.tenantId} and type = 'over_receipt.approved'`;
      expect((approved[0] as { payload: Record<string, unknown> }).payload).toMatchObject({ overReceiptId, warehouseId: t.warehouseId });
      await drainAll();
      const after = (await list(t.tenantId, t.ownerToken).expect(200)).body.items as Record<string, unknown>[];
      expect(after.find((item) => item.sourceId === overReceiptId)).toMatchObject({ resolution: 'approved', resolvedAt: expect.any(String) });
    });

    it('a pending stock adjustment notifies the owner (adjustments.approve), not the ops manager; approval resolves it', async () => {
      const t = main;
      await request(app.getHttpServer())
        .put(`${API}/${t.tenantId}/inventory/adjustment-policies`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ quantityThreshold: 10 })
        .expect(200);
      const pend = await request(app.getHttpServer())
        .post(`${API}/${t.tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${t.opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: t.warehouseId, skuId, binId, quantityDelta: 50, reasonCode: 'stock-count', note: 'notify suite' })
        .expect(202);
      const pendingId = pend.body.pendingAdjustment.id as string;
      await drainAll();
      expect((await allEntries(t.tenantId, t.ownerToken)).find((item) => item.sourceId === pendingId)).toMatchObject({
        sourceType: 'stock-adjustment',
        summary: { skuId, quantityDelta: 50, reasonCode: 'stock-count' },
        resolution: null,
      });
      expect((await allEntries(t.tenantId, t.opsToken)).some((item) => item.sourceId === pendingId)).toBe(false);
      await request(app.getHttpServer())
        .post(`${API}/${t.tenantId}/inventory/adjustment-pendings/${pendingId}/approve`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .expect(200);
      await drainAll();
      expect((await entryRow(t.tenantId, 'stock-adjustment', pendingId))!.resolution).toBe('approved');
    });

    it('a sync-report row raises a rejected-op entry (ONLY when it entered the queue); its discard resolves it', async () => {
      const t = main;
      const row = {
        opId: ulid(),
        opType: 'transfer.confirm',
        classification: 'rejected',
        problemCode: 'transfer-bin-changed',
        problemDetail: 'The bin moved under the confirm',
        payload: { transferId: uuidv7(), destBinId: binId, binStateEpoch: 4 },
        attribution: { deviceLabel: 'Notify dock scanner', operatorEmail: 'floor@example.com' },
        opEnqueuedAt: new Date(Date.now() - 60_000).toISOString(),
        opOccurredAt: null,
      };
      const upload = (key = ulid()) =>
        request(app.getHttpServer())
          .post(`${API}/${t.tenantId}/devices/sync-reports`)
          .set('Authorization', `Bearer ${badgeToken}`)
          .set(KEY_HEADER, key)
          .send({ rows: [row] });
      await upload().expect(201);
      await upload().expect(201); // the dedupe: recorded=false
      const raised = await sql`select payload from outbox_messages where tenant_id = ${t.tenantId} and type = 'device.rejected_op.raised'`;
      expect(raised).toHaveLength(1);
      const rejectedOpId = (raised[0] as { payload: { rejectedOpId: string } }).payload.rejectedOpId;
      await drainAll();
      expect(await entryRow(t.tenantId, 'rejected-op', rejectedOpId)).toMatchObject({
        summary: { opType: 'transfer.confirm', problemCode: 'transfer-bin-changed' },
        warehouse_id: null,
        resolution: null,
      });
      await request(app.getHttpServer())
        .post(`${API}/${t.tenantId}/rejected-ops/${rejectedOpId}/resolve`)
        .set('Authorization', `Bearer ${t.opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'discard' })
        .expect(200);
      await drainAll();
      expect((await entryRow(t.tenantId, 'rejected-op', rejectedOpId))!.resolution).toBe('discarded');
    });

    it('a breach whose policy is deleted resolves policy-removed', async () => {
      const t = main;
      const skus = await request(app.getHttpServer())
        .get(`${API}/${t.tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .expect(200);
      const skuB = (skus.body.items as { code: string; id: string }[]).find((item) => item.code === 'NT-B')!.id;
      const policy = await request(app.getHttpServer())
        .put(`${API}/${t.tenantId}/replenishment/policies`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: t.warehouseId, skuId: skuB, reorderPoint: 4000, reorderQty: 5000 })
        .expect(200);
      const report = await app.get(ReplenishmentFacade).sweepScope(t.tenantId, t.warehouseId);
      expect(report.opened).toBeGreaterThanOrEqual(1);
      const breach = await sql`select id from reorder_breaches where tenant_id = ${t.tenantId} and sku_id = ${skuB} and status = 'open'`;
      const breachId = (breach[0] as { id: string }).id;
      await drainAll();
      expect(await entryRow(t.tenantId, 'reorder-breach', breachId)).toMatchObject({
        summary: { skuId: skuB, atpQty: 0, pointQty: 4 },
        warehouse_id: t.warehouseId,
        resolution: null,
      });
      await request(app.getHttpServer())
        .delete(`${API}/${t.tenantId}/replenishment/policies/${policy.body.policy.id as string}`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .expect(200);
      await drainAll();
      expect((await entryRow(t.tenantId, 'reorder-breach', breachId))!.resolution).toBe('policy-removed');
    });

    it('channel sync episodes: closed → open raises, half-open → open does not, a heal resolves; a second trip is a SECOND entry; a disconnect while open resolves it disconnected', async () => {
      const t = main;
      const publish = app.get(ChannelsPublishService);
      const connected = await request(app.getHttpServer())
        .post(`${API}/${t.tenantId}/channels/connections`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ provider: 'amazon-in', credentials: { sellerId: 'SELLER-NT', refreshToken: 'nt-refresh-token' } })
        .expect(201);
      const connectionId = connected.body.id as string;
      const fail = () => publish.recordDelivery(t.tenantId, connectionId, { ok: false, error: 'suite failure', latencyMs: 1 });
      const episodeEvents = async (): Promise<{ type: string; payload: Record<string, unknown> }[]> =>
        (await sql`
          select type, payload from outbox_messages
          where tenant_id = ${t.tenantId} and type like 'channel.sync.%' and payload->>'connectionId' = ${connectionId}
          order by created_at, id`) as unknown as { type: string; payload: Record<string, unknown> }[];
      const channelEntries = async (): Promise<EntryRow[]> =>
        (await sql`
          select id, source_type, source_id, summary, resolution, resolved_at::text as resolved_at
          from notifications where tenant_id = ${t.tenantId} and source_type = 'channel-sync'
            and summary->>'connectionId' = ${connectionId}
          order by raised_at, id`) as unknown as EntryRow[];

      // Four failures keep it closed — no event; the fifth opens it — ONE.
      for (let i = 1; i < BREAKER_FAILURE_THRESHOLD; i += 1) await fail();
      expect(await episodeEvents()).toEqual([]);
      await fail();
      const [degraded] = await episodeEvents();
      expect(degraded).toMatchObject({ type: 'channel.sync.degraded', payload: { connectionId } });
      const firstEpisode = degraded!.payload.episodeId as string;
      // A further failure while open (a re-drain) emits nothing.
      await fail();
      expect(await episodeEvents()).toHaveLength(1);
      await drainAll();
      expect(await channelEntries()).toMatchObject([{ source_id: firstEpisode, resolution: null }]);

      // Half-open → open: the same episode — nothing.
      await sql`update integrations set breaker_state = 'half-open', consecutive_failures = 0 where id = ${connectionId}`;
      await fail();
      expect(await episodeEvents()).toEqual([]);
      // Half-open → closed (a success): recovered, the episode cleared.
      await sql`update integrations set breaker_state = 'half-open' where id = ${connectionId}`;
      await publish.recordDelivery(t.tenantId, connectionId, { ok: true, latencyMs: 1 });
      expect(await episodeEvents()).toEqual([
        { type: 'channel.sync.recovered', payload: { connectionId, episodeId: firstEpisode, reason: 'recovered' } },
      ]);
      await drainAll();
      expect(await channelEntries()).toMatchObject([{ source_id: firstEpisode, resolution: 'recovered' }]);

      // The SAME connection trips again: a NEW episode, a second entry.
      for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i += 1) await fail();
      await drainAll();
      const entries = await channelEntries();
      expect(entries).toHaveLength(2);
      expect(entries[1]!.source_id).not.toBe(firstEpisode);
      expect(entries[1]!.resolution).toBeNull();

      // Disconnect while that episode is open: recovered · disconnected.
      await request(app.getHttpServer())
        .delete(`${API}/${t.tenantId}/channels/connections/${connectionId}`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(204);
      await drainAll();
      const final = await channelEntries();
      expect(final.map((entry) => entry.resolution)).toEqual(['recovered', 'disconnected']);
      expect(await hasNew(t.tenantId, t.operatorToken)).toBe(false);
    });
  });
});
