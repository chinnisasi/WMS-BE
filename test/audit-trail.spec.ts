import type { INestApplication } from '@nestjs/common';
import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { SYSTEM_ACTOR_ID } from '../src/shared/primitives/audit';
import { REPLENISHMENT_SCHEDULER_ACTOR_ID } from '../src/modules/replenishment/replenishment.command';
import { ReportingFacade } from '../src/modules/reporting/reporting.facade';
import { escapeLikePrefix, readAuditPageInTx } from '../src/modules/reporting/audit';
import { signTenantSession, tenantSessionSecret } from '../src/modules/tenancy/jwt-session';
import { CAPABILITIES, ROLE_CAPABILITIES } from '../src/modules/tenancy/permissions';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { unauditedKeys } from './support/audit-guard';
import { testAddress } from './support/shipment-address';

// Story 9-3a — the audit trail read (FR-28): `GET /tenants/{t}/reporting/audit`,
// owner-only, cursor-paged on the server stamp. The paging and window rows
// are seeded by raw insert with chosen `created_at` stamps — the read model is
// what is under test. The audit WRITES (one per keyed command) are pinned in
// each command's own suite through `expectAuditRow`.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.STORAGE_SNAPSHOT_POLL_MS;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

interface AuditRow {
  id: string;
  recordedAt: string;
  occurredAt: string;
  actorUserId: string;
  actorKind: 'user' | 'system';
  action: string;
  targetType: string;
  targetId: string;
}

describe('the audit trail read (e2e, story 9-3a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let reporting: ReportingFacade;

  let tenantId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let opsUserId: string;
  let opsToken: string;

  const http = () => request(app.getHttpServer());

  async function signIn(email: string): Promise<string> {
    return (await http().post(`${API}/sign-in`).send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  }

  function audit(query: Record<string, string | number> = {}, token = ownerToken) {
    return http().get(`${API}/${tenantId}/reporting/audit`).query(query).set('Authorization', `Bearer ${token}`);
  }

  /** Raw audit rows with chosen stamps (the read model under test). */
  async function seed(rows: { action: string; targetType?: string; targetId?: string; actor?: string; createdAt: string; occurredAt?: string }[]): Promise<void> {
    for (const row of rows) {
      await sql`insert into audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, reference, occurred_at, created_at, updated_at)
        values (${uuidv7()}, ${tenantId}, ${row.actor ?? ownerUserId}, ${row.action}, ${row.targetType ?? 'order'}, ${row.targetId ?? uuidv7()},
                null, ${row.occurredAt ?? row.createdAt}, ${row.createdAt}, ${row.createdAt})`;
    }
  }

  /** Walks every page of a query and returns the rows in served order. */
  async function walk(query: Record<string, string | number>): Promise<{ rows: AuditRow[]; pages: number }> {
    const rows: AuditRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await audit({ ...query, ...(cursor === null ? {} : { cursor }) }).expect(200);
      rows.push(...(res.body.items as AuditRow[]));
      cursor = res.body.nextCursor as string | null;
      pages += 1;
    } while (cursor !== null && pages < 50);
    return { rows, pages };
  }

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('audit_trail');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    reporting = app.get(ReportingFacade);

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Audit Co ${ulid()}`, ownerEmail, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = await signIn(ownerEmail);

    const opsEmail = `ops-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: opsEmail, role: 'ops_manager' })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    opsUserId = invited.body.user.id as string;
    opsToken = await signIn(opsEmail);
  });

  afterAll(async () => {
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  it('audit.view is owner-only: in CAPABILITIES, held by the owner and by no other role', () => {
    expect(CAPABILITIES).toContain('audit.view');
    expect(ROLE_CAPABILITIES.owner.has('audit.view')).toBe(true);
    for (const role of ['ops_manager', 'operator', 'accountant', 'client'] as const) {
      expect(ROLE_CAPABILITIES[role].has('audit.view')).toBe(false);
    }
  });

  it('the system actor moved to shared/ with its value unchanged (the old name re-exported)', () => {
    expect(SYSTEM_ACTOR_ID).toBe('01900000-0000-7000-8000-000000000000');
    expect(REPLENISHMENT_SCHEDULER_ACTOR_ID).toBe(SYSTEM_ACTOR_ID);
  });

  it('an owner who creates a warehouse finds it in the trail by prefix: their id, the action, the target (acceptance)', async () => {
    const key = ulid();
    const created = await http()
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send({ origin: testAddress(), code: `AUD-${ulid().slice(10, 16).toUpperCase()}`, name: 'Audited WH' })
      .expect(201);
    const res = await audit({ actionPrefix: 'warehouse.' }).expect(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        actorUserId: ownerUserId,
        actorKind: 'user',
        action: 'warehouse.created',
        targetType: 'warehouse',
        targetId: created.body.id,
      }),
    ]);
    // The reference (the idempotency key) is never returned.
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      ['action', 'actorKind', 'actorUserId', 'id', 'occurredAt', 'recordedAt', 'targetId', 'targetType'].sort(),
    );
    expect(JSON.stringify(res.body)).not.toContain(key);
  });

  it('120 rows, many sharing one created_at: newest 50 first, and paging to the end yields every row once — no dupes, no gaps', async () => {
    const stamp = '2026-01-15T06:00:00.123456Z';
    const rows = Array.from({ length: 120 }, (_, i) => ({ action: 'paging.case', createdAt: i < 80 ? stamp : `2026-01-15T05:${String(i - 80).padStart(2, '0')}:00Z` }));
    await seed(rows);
    const first = await audit({ actionPrefix: 'paging.' }).expect(200);
    expect(first.body.items).toHaveLength(50);
    expect(first.body.nextCursor).not.toBeNull();
    const { rows: all, pages } = await walk({ actionPrefix: 'paging.' });
    expect(pages).toBe(3);
    expect(all).toHaveLength(120);
    expect(new Set(all.map((row) => row.id)).size).toBe(120);
    // Newest recorded first, ties broken by id descending.
    for (let i = 1; i < all.length; i += 1) {
      const prev = all[i - 1]!;
      const cur = all[i]!;
      const ordered = prev.recordedAt > cur.recordedAt || (prev.recordedAt === cur.recordedAt && prev.id > cur.id);
      expect(ordered).toBe(true);
    }
    // A small limit walks the 80-row tie group at full precision too.
    const small = await walk({ actionPrefix: 'paging.', limit: 7 });
    expect(new Set(small.rows.map((row) => row.id)).size).toBe(120);
  });

  it('filters combine with AND: actor, target type, target id; actorKind is `system` for the reserved actor', async () => {
    const target = uuidv7();
    await seed([
      { action: 'filter.case', targetType: 'transfer_order', targetId: target, actor: opsUserId, createdAt: '2026-02-01T00:00:00Z' },
      { action: 'filter.case', targetType: 'transfer_order', actor: ownerUserId, createdAt: '2026-02-01T00:00:01Z' },
      { action: 'filter.case', targetType: 'reorder_breach', actor: SYSTEM_ACTOR_ID, createdAt: '2026-02-01T00:00:02Z' },
    ]);
    const byActor = await audit({ actionPrefix: 'filter.', actorUserId: opsUserId }).expect(200);
    expect(byActor.body.items.map((row: AuditRow) => row.targetId)).toEqual([target]);
    const byTarget = await audit({ actionPrefix: 'filter.', targetType: 'transfer_order', targetId: target }).expect(200);
    expect(byTarget.body.items).toHaveLength(1);
    const system = await audit({ actionPrefix: 'filter.', targetType: 'reorder_breach' }).expect(200);
    expect(system.body.items).toEqual([expect.objectContaining({ actorUserId: SYSTEM_ACTOR_ID, actorKind: 'system' })]);
    // The response publishes the system actor's id, so a client filters on it
    // without hard-coding it.
    expect(system.body.systemActorId).toBe(SYSTEM_ACTOR_ID);
    const bySystem = await audit({ actionPrefix: 'filter.', actorUserId: system.body.systemActorId as string }).expect(200);
    expect(bySystem.body.items.map((row: AuditRow) => row.actorKind)).toEqual(['system']);
  });

  it('actionPrefix is literal: `stock_adjustment.` does not match `stockXadjustment.y` (`_` escaped)', async () => {
    await seed([
      { action: 'stock_adjustment.approved', createdAt: '2026-03-01T00:00:00Z' },
      { action: 'stockXadjustment.y', createdAt: '2026-03-01T00:00:01Z' },
    ]);
    const res = await audit({ actionPrefix: 'stock_adjustment.' }).expect(200);
    expect(res.body.items.map((row: AuditRow) => row.action)).toEqual(['stock_adjustment.approved']);
    // The escaper itself: `\`, `_` and `%` all escaped.
    expect(escapeLikePrefix('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('400s: an actionPrefix carrying `%`, from ≥ to, an unknown targetType, a malformed actor id, a bad cursor', async () => {
    const percent = await audit({ actionPrefix: 'a%' }).expect(400);
    expect(percent.body.code).toBe('validation-failed');
    const inverted = await audit({ from: '2026-03-02T00:00:00Z', to: '2026-03-01T00:00:00Z' }).expect(400);
    expect(inverted.body.code).toBe('validation-failed');
    const equal = await audit({ from: '2026-03-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }).expect(400);
    expect(equal.body.code).toBe('validation-failed');
    expect((await audit({ targetType: 'spaceship' }).expect(400)).body.code).toBe('validation-failed');
    expect((await audit({ actorUserId: 'nope' }).expect(400)).body.code).toBe('validation-failed');
    expect((await audit({ cursor: 'garbage' }).expect(400)).body.code).toBe('invalid-cursor');
    expect((await audit({ limit: 201 }).expect(400)).body.code).toBe('validation-failed');
  });

  it('the IST day 2026-10-12 is [12th 00:00+05:30, 13th 00:00+05:30): a row at 23:59 IST is in, one at 00:00 IST the next day is out', async () => {
    await seed([
      { action: 'ist.case', createdAt: '2026-10-12T18:29:00Z' }, // 23:59 IST on the 12th
      { action: 'ist.case', createdAt: '2026-10-12T18:30:00Z' }, // 00:00 IST on the 13th
      { action: 'ist.case', createdAt: '2026-10-11T18:29:59Z' }, // 23:59:59 IST on the 11th
    ]);
    const res = await audit({ actionPrefix: 'ist.', from: '2026-10-12T00:00:00+05:30', to: '2026-10-13T00:00:00+05:30' }).expect(200);
    expect(res.body.items.map((row: AuditRow) => row.recordedAt)).toEqual(['2026-10-12T18:29:00.000Z']);
  });

  it('ordered on the server stamp, never device time: a putaway whose occurred_at is 2 h old sorts by recordedAt and carries both instants', async () => {
    await seed([
      { action: 'device.case', createdAt: '2026-04-01T10:00:00Z', occurredAt: '2026-04-01T08:00:00Z' },
      { action: 'device.case', createdAt: '2026-04-01T09:00:00Z' },
    ]);
    const res = await audit({ actionPrefix: 'device.case' }).expect(200);
    expect(res.body.items.map((row: AuditRow) => [row.recordedAt, row.occurredAt])).toEqual([
      ['2026-04-01T10:00:00.000Z', '2026-04-01T08:00:00.000Z'],
      ['2026-04-01T09:00:00.000Z', '2026-04-01T09:00:00.000Z'],
    ]);
  });

  it('owner-only: an ops manager is 403 role-denied before anything is read', async () => {
    const res = await audit({}, opsToken).expect(403);
    expect(res.body.code).toBe('role-denied');
    expect(res.body.detail).toContain('audit.view');
  });

  it('a client-portal session is refused by the operator fence; another tenant is 403 permission-denied', async () => {
    const portalToken = signTenantSession(tenantId, ownerUserId, tenantSessionSecret(), undefined, uuidv7());
    const portal = await audit({}, portalToken).expect(403);
    expect(portal.body).toMatchObject({ code: 'role-denied', detail: 'This is an operator surface.' });
    const foreign = signTenantSession(uuidv7(), ownerUserId, tenantSessionSecret());
    expect((await audit({}, foreign).expect(403)).body.code).toBe('permission-denied');
  });

  it('a read past its 5 s budget is 503 report-unavailable ("narrow the filters"), never a partial page', async () => {
    try {
      reporting.auditRead = async (tx) => {
        await tx.execute(dsql`select set_config('statement_timeout', '50', true)`);
        await tx.execute(dsql`select pg_sleep(2)`);
        throw new Error('unreachable');
      };
      const res = await audit({}).expect(503);
      expect(res.body.code).toBe('report-unavailable');
      expect(res.body.items).toBeUndefined();
    } finally {
      reporting.auditRead = readAuditPageInTx;
    }
  });

  it('the dynamic audit guard names a key that committed without its audit row', async () => {
    const key = ulid();
    await sql`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
      values (${uuidv7()}, ${tenantId}, ${key}, 'probe', ${sql.json({ probe: true })})`;
    try {
      const missing = await unauditedKeys(process.env.DATABASE_URL!);
      expect(missing).toEqual([{ tenantId, key, snapshotKeys: 'probe' }]);
      // A composite reference carrying the key satisfies it (the pre-9-3a
      // note / before-after / channel references).
      await sql`insert into audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, reference, occurred_at)
        values (${uuidv7()}, ${tenantId}, ${ownerUserId}, 'probe.case', 'order', ${uuidv7()}, ${`note: x (key ${key})`}, now())`;
      expect(await unauditedKeys(process.env.DATABASE_URL!)).toEqual([]);
    } finally {
      await sql`delete from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
    }
  });

  it('the route is in the OpenAPI document, with the targetType enum published', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const path = (doc.body.paths as Record<string, { get?: { parameters?: { name: string; schema?: { enum?: string[] } }[] } }>)[
      '/tenants/{tenantId}/reporting/audit'
    ];
    expect(path?.get).toBeDefined();
    const targetType = path!.get!.parameters!.find((parameter) => parameter.name === 'targetType');
    expect(targetType?.schema?.enum).toEqual(expect.arrayContaining(['transfer_order', 'purchase_order', 'goods_receipt', 'device']));
  });
});
