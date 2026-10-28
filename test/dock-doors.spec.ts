import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { DOCK_SLOT_MINUTES } from '../src/modules/inbound/dock.read';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

jest.setTimeout(240_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

interface Door {
  id: string;
  warehouseId: string;
  code: string;
  name: string | null;
  active: boolean;
}

/**
 * Story 2-3b — the dock-door master and the dock schedule: the door code
 * rules and its uniqueness, the 100-door limit and its race (A11), the
 * full-replacement update and its no-op arm, the schedule's shape rules
 * (each a 400 naming the field), the unconfigured-write rule (A11) and the
 * no-op arm, capabilities, the portal fence, RLS and the CHECK vocabularies.
 * The "deactivate a busy door" row needs an appointment and lives in
 * test/dock-appointments.spec.ts.
 */
describe('story 2-3b: dock doors and the dock schedule', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let opsToken: string;
  let operatorToken: string;
  let accountantToken: string;
  let portalToken: string;
  let wh1: string;
  let wh2: string;
  let wh3: string;

  const http = () => request(app.getHttpServer());

  function expectProblem(res: request.Response, status: number, code: string): void {
    expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
  }

  async function member(role: 'ops_manager' | 'operator' | 'accountant' | 'client', clientId?: string): Promise<string> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role, ...(clientId === undefined ? {} : { clientId }) })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
  }

  async function site(code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code, name: `${code} site` })
        .expect(201)
    ).body.id as string;
  }

  function createDoor(warehouseId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken): SupertestTest {
    return http().post(`${API}/${tenantId}/warehouses/${warehouseId}/dock-doors`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function updateDoor(warehouseId: string, doorId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken): SupertestTest {
    return http()
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/dock-doors/${doorId}`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function putSchedule(warehouseId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken): SupertestTest {
    return http().put(`${API}/${tenantId}/warehouses/${warehouseId}/dock-schedule`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  async function doors(warehouseId: string, token = ownerToken): Promise<Door[]> {
    return (await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/dock-doors`).set('Authorization', `Bearer ${token}`).expect(200)).body
      .items as Door[];
  }

  async function schedule(warehouseId: string, token = ownerToken): Promise<Record<string, unknown>> {
    return (await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/dock-schedule`).set('Authorization', `Bearer ${token}`).expect(200)).body
      .schedule as Record<string, unknown>;
  }

  const validSchedule = { slotMinutes: 60, opensAt: '06:00', closesAt: '22:00', openDays: [1, 2, 3, 4, 5, 6, 7], graceMinutes: 10 };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('dock_doors');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Dock Co ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
    opsToken = await member('ops_manager');
    operatorToken = await member('operator');
    accountantToken = await member('accountant');
    const glowCo = (
      await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'GLOW', name: 'GlowCo' })
        .expect(201)
    ).body.client.id as string;
    portalToken = await member('client', glowCo);
    wh1 = await site('BLR-1');
    wh2 = await site('PNQ-1');
    wh3 = await site('HYD-1');
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

  describe('the contract', () => {
    it('the committed OpenAPI publishes every dock route', () => {
      const doc = JSON.parse(readFileSync(resolvePath(process.cwd(), 'openapi/openapi.json'), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
      const base = '/tenants/{tenantId}';
      expect(Object.keys(doc.paths[`${base}/warehouses/{warehouseId}/dock-doors`]!).sort()).toEqual(['get', 'post']);
      expect(Object.keys(doc.paths[`${base}/warehouses/{warehouseId}/dock-doors/{doorId}`]!)).toEqual(['patch']);
      expect(Object.keys(doc.paths[`${base}/warehouses/{warehouseId}/dock-schedule`]!).sort()).toEqual(['get', 'put']);
      expect(Object.keys(doc.paths[`${base}/receiving/dock-schedule`]!)).toEqual(['get']);
      expect(Object.keys(doc.paths[`${base}/receiving/dock-appointments`]!)).toEqual(['post']);
      expect(Object.keys(doc.paths[`${base}/receiving/dock-appointments/{appointmentId}`]!).sort()).toEqual(['get', 'patch']);
      expect(Object.keys(doc.paths[`${base}/receiving/dock-appointments/{appointmentId}/cancel`]!)).toEqual(['post']);
    });

    it('the TS vocabulary equals the 0110 slot CHECK', async () => {
      const rows = (await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'dock_schedules_slot_check'`) as unknown as {
        def: string;
      }[];
      expect([...rows[0]!.def.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1])).sort((a, b) => a - b)).toEqual([...DOCK_SLOT_MINUTES]);
    });

    it('dock_doors and dock_schedules are tenant-isolated under RLS (wms_rls_probe)', async () => {
      const doorId = uuidv7();
      const scheduleId = uuidv7();
      await sql`insert into dock_doors (id, tenant_id, warehouse_id, code, created_by) values (${doorId}, ${tenantId}, ${wh3}, 'RLS-PROBE', ${ownerUserId})`;
      await sql`insert into dock_schedules (id, tenant_id, warehouse_id, slot_minutes, opens_minute, closes_minute, open_days, grace_minutes, updated_by)
                values (${scheduleId}, ${tenantId}, ${uuidv7()}, 30, 540, 1080, 63, 15, ${ownerUserId})`;
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        for (const [table, id] of [['dock_doors', doorId], ['dock_schedules', scheduleId]] as const) {
          expect(await rls.unsafe(`select 1 from ${table} where id = '${id}'::uuid`)).toHaveLength(0);
          const foreign = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
            return tx.unsafe(`select 1 from ${table} where id = '${id}'::uuid`);
          });
          expect(foreign).toHaveLength(0);
          const own = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            return tx.unsafe(`select 1 from ${table} where id = '${id}'::uuid`);
          });
          expect(own).toHaveLength(1);
        }
      } finally {
        await rls.end();
        await sql`delete from dock_doors where id = ${doorId}`;
        await sql`delete from dock_schedules where id = ${scheduleId}`;
      }
    });

    it('a client-portal session is refused on every door and schedule route (the operator fence)', async () => {
      const doorId = uuidv7();
      for (const res of [
        await http().get(`${API}/${tenantId}/warehouses/${wh1}/dock-doors`).set('Authorization', `Bearer ${portalToken}`),
        await createDoor(wh1, { code: 'P1' }, ulid(), portalToken),
        await updateDoor(wh1, doorId, { code: 'P1', active: true }, ulid(), portalToken),
        await http().get(`${API}/${tenantId}/warehouses/${wh1}/dock-schedule`).set('Authorization', `Bearer ${portalToken}`),
        await putSchedule(wh1, validSchedule, ulid(), portalToken),
      ]) {
        expectProblem(res, 403, 'role-denied');
        expect((res.body as { detail?: string }).detail).toBe('This is an operator surface.');
      }
    });
  });

  describe('doors', () => {
    it('Door code: "d-3 " is stored D-3; a second D-3 is 409 dock-door-code-taken; audited and replayed', async () => {
      const key = ulid();
      const created = (await createDoor(wh1, { code: 'd-3 ', name: '  North dock  ' }, key).expect(201)).body.dockDoor as Door;
      expect(created).toMatchObject({ code: 'D-3', name: 'North dock', active: true, warehouseId: wh1 });
      await expectAuditRow({ tenantId, key, action: 'dock_door.created', targetType: 'dock_door', targetId: created.id, actorUserId: ownerUserId });
      const replayed = (await createDoor(wh1, { code: 'd-3 ', name: '  North dock  ' }, key).expect(201)).body.dockDoor as Door;
      expect(replayed).toEqual(created);
      await expectAuditRow({ tenantId, key, action: 'dock_door.created', targetType: 'dock_door', targetId: created.id, actorUserId: ownerUserId });
      expectProblem(await createDoor(wh1, { code: 'D-3' }), 409, 'dock-door-code-taken');
      // Another warehouse may reuse the code.
      await createDoor(wh2, { code: 'D-3' }).expect(201);
      expectProblem(await createDoor(wh1, { code: 'd-3 ', name: 'other' }, key), 422, 'idempotency-key-reuse');
      const events = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'dock_door.created'`) as unknown as {
        payload: { dockDoor: Door };
      }[];
      expect(events.map((event) => event.payload.dockDoor.code).sort()).toEqual(['D-3', 'D-3']);
    });

    it('the code and name shapes are 400s naming the field', async () => {
      for (const body of [{ code: 'D 3' }, { code: 'D_3' }, { code: '' }, { code: 'X'.repeat(21) }, { code: 'D9', name: 'n'.repeat(61) }]) {
        const res = await createDoor(wh1, body);
        expectProblem(res, 400, 'validation-failed');
      }
      expect((await createDoor(wh1, { code: 'D9', name: 'n'.repeat(61) })).body.detail).toMatch(/name/);
    });

    it('capabilities: dock.manage only (an operator and an accountant are refused before any validation); every staff session reads', async () => {
      for (const token of [operatorToken, accountantToken]) {
        expectProblem(await createDoor(wh1, { code: 'bad code!' }, ulid(), token), 403, 'role-denied');
        expectProblem(await putSchedule(wh1, { ...validSchedule, slotMinutes: 45 }, ulid(), token), 403, 'role-denied');
      }
      const created = (await createDoor(wh1, { code: 'OPS-1' }, ulid(), opsToken).expect(201)).body.dockDoor as Door;
      for (const token of [operatorToken, accountantToken, opsToken]) {
        expect((await doors(wh1, token)).map((door) => door.id)).toContain(created.id);
      }
    });

    it('update: a full replacement; unchanged is the no-op arm; deactivate/reactivate; active first then by code; another warehouse’s door is 404', async () => {
      const a = (await createDoor(wh2, { code: 'A1', name: 'Alpha' }).expect(201)).body.dockDoor as Door;
      const b = (await createDoor(wh2, { code: 'B1' }).expect(201)).body.dockDoor as Door;
      const key = ulid();
      const renamed = (await updateDoor(wh2, a.id, { code: 'z9', active: false }, key).expect(200)).body.dockDoor as Door;
      expect(renamed).toMatchObject({ id: a.id, code: 'Z9', name: null, active: false });
      await expectAuditRow({ tenantId, key, action: 'dock_door.updated', targetType: 'dock_door', targetId: a.id, actorUserId: ownerUserId });
      const changes = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as {
        changes: Record<string, unknown>;
      }[];
      expect(changes[0]!.changes).toEqual({
        code: { before: 'A1', after: 'Z9' },
        name: { before: 'Alpha', after: null },
        active: { before: true, after: false },
      });
      const listed = await doors(wh2);
      expect(listed.map((door) => [door.code, door.active])).toEqual([
        ['B1', true],
        ['D-3', true],
        ['Z9', false],
      ]);
      // The no-op arm: the stored body resent under a new key.
      const noOp = noOpIdempotencyKey(tenantId, ulid(), 'dockDoors.update:unchanged');
      const same = (await updateDoor(wh2, a.id, { code: 'Z9', name: '  ', active: false }, noOp).expect(200)).body.dockDoor as Door;
      expect(same).toEqual(renamed);
      expect((await sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${noOp}`)[0]!.n).toBe(0);
      expect((await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${noOp}`)[0]!.n).toBe(1);
      expectProblem(await updateDoor(wh2, a.id, { code: 'B1', active: true }), 409, 'dock-door-code-taken');
      await updateDoor(wh2, a.id, { code: 'Z9', active: true }).expect(200);
      expectProblem(await updateDoor(wh1, b.id, { code: 'B1', active: true }), 404, 'not-found');
      expectProblem(await updateDoor(wh2, uuidv7(), { code: 'B1', active: true }), 404, 'not-found');
      expectProblem(await updateDoor(wh2, b.id, { code: 'B1' }), 400, 'validation-failed');
    });

    it('Door limit race (A11): at 99 doors two concurrent creates — one 201, one 409 dock-door-limit', async () => {
      const warehouse = await site('LIM-1');
      const values = Array.from({ length: 99 }, (_, i) => sql`(${uuidv7()}, ${tenantId}, ${warehouse}, ${`L-${i + 1}`}, ${ownerUserId})`);
      for (const value of values) {
        await sql`insert into dock_doors (id, tenant_id, warehouse_id, code, created_by) values ${value}`;
      }
      const [first, second] = await Promise.all([createDoor(warehouse, { code: 'RACE-A' }), createDoor(warehouse, { code: 'RACE-B' })]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect([first, second].find((res) => res.status === 409)!.body.code).toBe('dock-door-limit');
      expect((await doors(warehouse)).length).toBe(100);
      expectProblem(await createDoor(warehouse, { code: 'ONE-MORE' }), 409, 'dock-door-limit');
    });
  });

  describe('the schedule', () => {
    it('an unconfigured warehouse reads the defaults; a PUT equal to the defaults still writes (configured, audited)', async () => {
      expect(await schedule(wh3)).toEqual({
        warehouseId: wh3,
        slotMinutes: 30,
        opensAt: '09:00',
        closesAt: '18:00',
        openDays: [1, 2, 3, 4, 5, 6],
        graceMinutes: 15,
        configured: false,
        updatedAt: null,
      });
      const key = ulid();
      const body = { slotMinutes: 30, opensAt: '09:00', closesAt: '18:00', openDays: [6, 5, 4, 3, 2, 1], graceMinutes: 15 };
      const saved = (await putSchedule(wh3, body, key).expect(200)).body.schedule as Record<string, unknown>;
      expect(saved).toMatchObject({ configured: true, openDays: [1, 2, 3, 4, 5, 6] });
      await expectAuditRow({ tenantId, key, action: 'dock_schedule.updated', targetType: 'warehouse', targetId: wh3, actorUserId: ownerUserId });
      expect((await putSchedule(wh3, body, key).expect(200)).body.schedule).toEqual(saved);
      await expectAuditRow({ tenantId, key, action: 'dock_schedule.updated', targetType: 'warehouse', targetId: wh3, actorUserId: ownerUserId });
      // Configured now: the same body under a new key is the no-op arm.
      const noOp = noOpIdempotencyKey(tenantId, ulid(), 'dockSchedule.put:unchanged');
      expect((await putSchedule(wh3, body, noOp).expect(200)).body.schedule).toEqual(saved);
      expect((await sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${noOp}`)[0]!.n).toBe(0);
    });

    it('AC3 set-up: 60-minute slots 06:00–22:00 Mon–Sun by an ops manager; 24:00 is a valid close', async () => {
      const saved = (await putSchedule(wh1, validSchedule, ulid(), opsToken).expect(200)).body.schedule as Record<string, unknown>;
      expect(saved).toMatchObject({ slotMinutes: 60, opensAt: '06:00', closesAt: '22:00', openDays: [1, 2, 3, 4, 5, 6, 7], graceMinutes: 10, configured: true });
      const midnight = (await putSchedule(wh2, { ...validSchedule, opensAt: '00:00', closesAt: '24:00' }).expect(200)).body.schedule;
      expect(midnight).toMatchObject({ opensAt: '00:00', closesAt: '24:00' });
      const changes = (await sql`select changes from audit_events where tenant_id = ${tenantId} and action = 'dock_schedule.updated' and target_id = ${wh1}`) as unknown as {
        changes: Record<string, { before: unknown; after: unknown }>;
      }[];
      expect(changes[0]!.changes.slotMinutes).toEqual({ before: 30, after: 60 });
      expect(changes[0]!.changes.configured).toEqual({ before: false, after: true });
    });

    it.each([
      ['slot 45', { slotMinutes: 45 }, /slotMinutes/],
      ['closes before opens', { opensAt: '09:00', closesAt: '08:00' }, /closesAt/],
      ['off the 30 grid', { slotMinutes: 30, opensAt: '09:10' }, /opensAt/],
      ['no open day', { openDays: [] }, /openDays/],
      ['a weekday 8', { openDays: [1, 8] }, /openDays/],
      ['a repeated day', { openDays: [1, 1] }, /openDays/],
      ['grace 121', { graceMinutes: 121 }, /graceMinutes/],
      ['a malformed time', { opensAt: '9:00' }, /opensAt/],
      ['24:00 as an opening', { opensAt: '24:00' }, /opensAt/],
    ])('Schedule: %s is a 400 naming the field', async (_label, patch, field) => {
      const res = await putSchedule(wh2, { ...validSchedule, ...patch });
      expectProblem(res, 400, 'validation-failed');
      expect((res.body as { detail: string }).detail).toMatch(field);
    });

    it('an unknown warehouse is 404 on every route', async () => {
      const ghost = uuidv7();
      expectProblem(await createDoor(ghost, { code: 'G1' }), 404, 'not-found');
      expectProblem(await putSchedule(ghost, validSchedule), 404, 'not-found');
      expectProblem(await http().get(`${API}/${tenantId}/warehouses/${ghost}/dock-doors`).set('Authorization', `Bearer ${ownerToken}`), 404, 'not-found');
      expectProblem(await http().get(`${API}/${tenantId}/warehouses/${ghost}/dock-schedule`).set('Authorization', `Bearer ${ownerToken}`), 404, 'not-found');
    });
  });
});
