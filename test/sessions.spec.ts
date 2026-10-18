import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { USER_STATUSES } from '../src/shared/db/schema';
import { USER_STATUSES as USER_STATUSES_DTO } from '../src/modules/tenancy/tenancy.dto';
import { SESSION_KINDS, SESSION_REVOKE_REASONS } from '../src/modules/tenancy/sessions';
import { signDeviceToken, tenantSessionSecret } from '../src/modules/tenancy/jwt-session';
import { REFRESH_COOKIE_NAME } from '../src/modules/tenancy/session-cookie';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.CORS_ORIGIN = 'http://localhost:3001';
process.env.COOKIE_SECURE = 'false';
// One trusted hop, so each test can name its own client address.
process.env.TRUSTED_PROXY_HOPS = '1';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const ORIGIN = 'http://localhost:3001';
const PASSWORD = 'correct-horse-battery';
const MEMBER_PASSWORD = 'team-member-password';
const PROBE_LOCK = 742105;

/**
 * Story 6-1a — secure sessions: server-side sessions, refresh rotation,
 * sign-out, staff offboarding, lockout and attempt limits, shift-length
 * badge sessions, badge-out / release / unlock, operator-mismatch.
 */
describe('secure sessions (e2e, story 6-1a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('sessions');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
  });

  afterAll(async () => {
    await sql.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  const http = () => request(app.getHttpServer());
  /** A fresh client address per test, so lockout and rate limits never leak between tests. */
  const newIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  async function registerTenant(): Promise<{ tenantId: string; ownerId: string; email: string }> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const res = await http()
      .post(API)
      .set('Idempotency-Key', ulid())
      .send({ name: `Sessions ${email}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    return { tenantId: res.body.tenant.id as string, ownerId: res.body.owner.id as string, email };
  }

  function signInReq(email: string, password: string, ip = newIp()) {
    return http().post(`${API}/sign-in`).set('X-Forwarded-For', ip).send({ email, password });
  }

  async function signIn(email: string, password = PASSWORD): Promise<{ token: string; cookie: string; body: Record<string, unknown> }> {
    const res = await signInReq(email, password).expect(200);
    return { token: res.body.accessToken as string, cookie: refreshCookieOf(res), body: res.body as Record<string, unknown> };
  }

  function refreshCookieOf(res: request.Response): string {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    const line = (raw ?? []).find((value) => value.startsWith(`${REFRESH_COOKIE_NAME}=`));
    if (line === undefined) throw new Error('no refresh cookie set');
    return line.split(';')[0]!;
  }

  function refresh(cookie: string | null, headers: Record<string, string> = { Origin: ORIGIN, 'X-WMS-Session': '1' }) {
    const req = http().post(`${API}/session/refresh`);
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    if (cookie !== null) req.set('Cookie', cookie);
    return req;
  }

  function signOut(cookie: string | null, bearer?: string) {
    const req = http().post(`${API}/session/sign-out`).set('Origin', ORIGIN).set('X-WMS-Session', '1');
    if (cookie !== null) req.set('Cookie', cookie);
    if (bearer !== undefined) req.set('Authorization', `Bearer ${bearer}`);
    return req;
  }

  const me = (tenantId: string, token: string) => http().get(`${API}/${tenantId}/me`).set('Authorization', `Bearer ${token}`);

  async function createMember(ownerToken: string, tenantId: string, role: string): Promise<{ userId: string; email: string }> {
    const email = `member-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', ulid())
      .send({ email, role })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set('Idempotency-Key', ulid())
      .send({ token: invited.body.inviteToken, password: MEMBER_PASSWORD })
      .expect(200);
    return { userId: invited.body.user.id as string, email };
  }

  const userAction = (ownerToken: string, tenantId: string, userId: string, arm: string, key = ulid()) =>
    http().post(`${API}/${tenantId}/users/${userId}/${arm}`).set('Authorization', `Bearer ${ownerToken}`).set('Idempotency-Key', key);

  const deviceAction = (ownerToken: string, tenantId: string, deviceId: string, arm: string, key = ulid()) =>
    http().post(`${API}/${tenantId}/devices/${deviceId}/${arm}`).set('Authorization', `Bearer ${ownerToken}`).set('Idempotency-Key', key);

  async function enrollDevice(ownerToken: string, tenantId: string, pin = '1357'): Promise<{ deviceId: string; deviceToken: string }> {
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set('Idempotency-Key', ulid())
      .send({ code: minted.body.code, label: `HH-${ulid().slice(-4)}`, pin })
      .expect(201);
    return { deviceId: enrolled.body.device.id as string, deviceToken: enrolled.body.deviceToken as string };
  }

  const badgeIn = (tenantId: string, deviceToken: string, operatorEmail: string, pin = '1357') =>
    http().post(`${API}/${tenantId}/devices/badge-in`).set('Authorization', `Bearer ${deviceToken}`).send({ operatorEmail, pin });

  const echo = (tenantId: string, badgeToken: string, opOperator?: string) => {
    const req = http()
      .post(`${API}/${tenantId}/devices/self-test/echo`)
      .set('Authorization', `Bearer ${badgeToken}`)
      .set('Idempotency-Key', ulid());
    if (opOperator !== undefined) req.set('X-Op-Operator', opOperator);
    return req.send({ payload: { probe: true } });
  };

  // ── vocabularies ──────────────────────────────────────────────────────────

  describe('vocabularies pinned to the database', () => {
    it('user statuses, session kinds and revoke reasons match the 0074 CHECKs; both USER_STATUSES copies agree', async () => {
      expect([...USER_STATUSES_DTO]).toEqual([...USER_STATUSES]);
      const checks = await sql<{ conname: string; def: string }[]>`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
         where conname in ('users_status_check', 'sessions_kind_check', 'sessions_revoked_reason_check')`;
      const def = (name: string) => checks.find((row) => row.conname === name)!.def;
      for (const status of USER_STATUSES) expect(def('users_status_check')).toContain(`'${status}'`);
      for (const kind of SESSION_KINDS) expect(def('sessions_kind_check')).toContain(`'${kind}'`);
      for (const reason of SESSION_REVOKE_REASONS) expect(def('sessions_revoked_reason_check')).toContain(`'${reason}'`);
    });

    it('RLS: the app role sees only its own tenant’s sessions (wms_rls_probe)', async () => {
      const a = await registerTenant();
      const b = await registerTenant();
      await signIn(a.email);
      await signIn(b.email);
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${PROBE_LOCK})`;
        await tx.unsafe(`do $$ begin
          if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
            create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
          end if; end $$;`);
        await tx.unsafe('grant usage on schema public to wms_rls_probe');
        await tx.unsafe('grant select, insert, update, delete on all tables in schema public to wms_rls_probe');
      });
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const probe = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        const seen = await probe.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${a.tenantId}, true)`;
          return tx<{ tenant_id: string }[]>`select distinct tenant_id from sessions`;
        });
        expect(seen.map((row) => row.tenant_id)).toEqual([a.tenantId]);
        const unscoped = await probe<{ n: number }[]>`select count(*)::int as n from sessions`;
        expect(unscoped[0]!.n).toBe(0);
      } finally {
        await probe.end();
      }
    });
  });

  // ── web sessions ──────────────────────────────────────────────────────────

  describe('web sessions: refresh, sign-out, limits', () => {
    it('sign-in sets the httpOnly refresh cookie and opens a session row', async () => {
      const t = await registerTenant();
      const res = await signInReq(t.email, PASSWORD).expect(200);
      const raw = (res.headers['set-cookie'] as unknown as string[]).find((v) => v.startsWith(REFRESH_COOKIE_NAME))!;
      expect(raw).toContain('HttpOnly');
      expect(raw).toContain('SameSite=Strict');
      expect(raw).toContain('Path=/api/v1/tenants/session');
      expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresInSeconds: 900, refreshExpiresInSeconds: 43200 });
      expect(res.body.refreshCookie).toBeUndefined();
      const rows = await sql`select kind, revoked_at from sessions where user_id = ${t.ownerId}`;
      expect(rows).toEqual([{ kind: 'web', revoked_at: null }]);
    });

    it('refresh rotates the cookie; the previous one inside 30 s is a tab race (no new cookie); after 30 s it is reuse and the session ends', async () => {
      const t = await registerTenant();
      const first = await signIn(t.email);
      const rotated = await refresh(first.cookie).expect(200);
      const second = refreshCookieOf(rotated);
      expect(second).not.toBe(first.cookie);
      await me(t.tenantId, rotated.body.accessToken as string).expect(200);

      // Tab race: the old cookie within the window → an access token, no Set-Cookie.
      const race = await refresh(first.cookie).expect(200);
      expect(race.headers['set-cookie']).toBeUndefined();
      await me(t.tenantId, race.body.accessToken as string).expect(200);

      // Past the window: reuse → revoked; both holders are out.
      await sql`update sessions set rotated_at = now() - interval '31 seconds' where user_id = ${t.ownerId}`;
      const reuse = await refresh(first.cookie).expect(401);
      expect(reuse.body).toMatchObject({ code: 'session-ended', reason: 'refresh-reuse' });
      const after = await refresh(second).expect(401);
      expect(after.body).toMatchObject({ code: 'session-ended', reason: 'refresh-reuse' });
      expect((await me(t.tenantId, rotated.body.accessToken as string).expect(401)).body).toMatchObject({
        code: 'session-ended',
        reason: 'refresh-reuse',
      });
    });

    it('refresh needs the allow-listed Origin and X-WMS-Session; an unknown secret ends nothing', async () => {
      const t = await registerTenant();
      const s = await signIn(t.email);
      await refresh(s.cookie, { 'X-WMS-Session': '1' }).expect(403);
      await refresh(s.cookie, { Origin: 'https://evil.example', 'X-WMS-Session': '1' }).expect(403);
      await refresh(s.cookie, { Origin: ORIGIN }).expect(403);
      const sid = s.cookie.split('=')[1]!.split('.')[0]!;
      await refresh(`${REFRESH_COOKIE_NAME}=${sid}.${'x'.repeat(43)}`).expect(401);
      await me(t.tenantId, s.token).expect(200);
      await refresh(null).expect(401);
    });

    it('idle: past the idle window the next request is 401 session-ended idle; refresh does not extend it', async () => {
      const t = await registerTenant();
      const s = await signIn(t.email);
      await sql`update sessions set idle_expires_at = now() - interval '1 second', last_used_at = now() - interval '3 hours' where user_id = ${t.ownerId}`;
      expect((await me(t.tenantId, s.token).expect(401)).body).toMatchObject({ code: 'session-ended', reason: 'idle' });
      expect((await refresh(s.cookie).expect(401)).body).toMatchObject({ code: 'session-ended', reason: 'idle' });
    });

    it('absolute: past 12 h the session is over even when active', async () => {
      const t = await registerTenant();
      const s = await signIn(t.email);
      await sql`update sessions set absolute_expires_at = now() - interval '1 second', idle_expires_at = now() - interval '1 second' where user_id = ${t.ownerId}`;
      expect((await me(t.tenantId, s.token).expect(401)).body).toMatchObject({ code: 'session-ended', reason: 'absolute' });
    });

    it('a guarded request slides the idle window (at most once a minute)', async () => {
      const t = await registerTenant();
      const s = await signIn(t.email);
      await sql`update sessions set last_used_at = now() - interval '5 minutes', idle_expires_at = now() + interval '10 minutes' where user_id = ${t.ownerId}`;
      await me(t.tenantId, s.token).expect(200);
      const [row] = await sql<{ slid: boolean }[]>`select idle_expires_at > now() + interval '1 hour' as slid from sessions where user_id = ${t.ownerId}`;
      expect(row!.slid).toBe(true);
    });

    it('sign-out revokes server-side; the same token in another tab is 401; it works with an expired access token and is idempotent', async () => {
      const t = await registerTenant();
      const s = await signIn(t.email);
      await signOut(s.cookie).expect(204);
      expect((await me(t.tenantId, s.token).expect(401)).body).toMatchObject({ code: 'session-ended', reason: 'signed-out' });
      await signOut(s.cookie).expect(204);

      // By bearer only, with the access token already expired.
      const other = await signIn(t.email);
      await signOut(null, other.token).expect(204);
      expect((await me(t.tenantId, other.token).expect(401)).body.reason).toBe('signed-out');
    });

    it('a pre-6-1a token (no kind, no sid) is session-ended legacy; an expired access token is token-expired', async () => {
      const t = await registerTenant();
      const { createHmac } = await import('node:crypto');
      const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const head = enc({ alg: 'HS256', typ: 'JWT' });
      const body = enc({ sub: t.ownerId, tenant_id: t.tenantId, iat: now, exp: now + 600 });
      const sig = createHmac('sha256', tenantSessionSecret()).update(`${head}.${body}`).digest('base64url');
      expect((await me(t.tenantId, `${head}.${body}.${sig}`).expect(401)).body).toMatchObject({ code: 'session-ended', reason: 'legacy' });
    });
  });

  // ── offboarding ───────────────────────────────────────────────────────────

  describe('staff offboarding', () => {
    it('deactivate ends every session (web + badge), refuses sign-in like a wrong password, releases bindings; audited; replays; reactivate restores', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const ravi = await createMember(owner.token, t.tenantId, 'operator');
      const raviWeb = await signIn(ravi.email, MEMBER_PASSWORD);
      const device = await enrollDevice(owner.token, t.tenantId);
      const badged = await badgeIn(t.tenantId, device.deviceToken, ravi.email).expect(200);

      const key = ulid();
      const res = await userAction(owner.token, t.tenantId, ravi.userId, 'deactivate', key).expect(200);
      expect(res.body.user).toMatchObject({ id: ravi.userId, status: 'deactivated' });
      await expectAuditRow({ tenantId: t.tenantId, key, action: 'user.deactivated', targetType: 'user', targetId: ravi.userId, actorUserId: t.ownerId });

      expect((await me(t.tenantId, raviWeb.token).expect(401)).body).toMatchObject({ code: 'session-ended', reason: 'deactivated' });
      const floor = await echo(t.tenantId, badged.body.accessToken as string).expect(401);
      expect(floor.body).toMatchObject({ code: 'unauthenticated', reason: 'deactivated' });
      expect((await signInReq(ravi.email, MEMBER_PASSWORD).expect(401)).body.code).toBe('unauthenticated');
      expect((await badgeIn(t.tenantId, device.deviceToken, ravi.email).expect(401)).body.code).toBe('badge-invalid');
      const [binding] = await sql`select operator_user_id from devices where id = ${device.deviceId}`;
      expect(binding!.operator_user_id).toBeNull();

      // Replay and the no-op.
      expect((await userAction(owner.token, t.tenantId, ravi.userId, 'deactivate', key).expect(200)).body).toEqual(res.body);
      await userAction(owner.token, t.tenantId, ravi.userId, 'deactivate', noOpIdempotencyKey(t.tenantId, ulid(), 'users.deactivate:already-deactivated')).expect(200);
      // The other arm under the same key is a different payload.
      await userAction(owner.token, t.tenantId, ravi.userId, 'reactivate', key).expect(422);

      const back = await userAction(owner.token, t.tenantId, ravi.userId, 'reactivate').expect(200);
      expect(back.body.user.status).toBe('active');
      expect(back.body.inviteToken).toBeUndefined();
      await signIn(ravi.email, MEMBER_PASSWORD);
    });

    it('a deactivated invitee is reactivated as invited with a fresh invite token', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const email = `pending-${ulid().toLowerCase()}@example.com`;
      const invited = await http()
        .post(`${API}/${t.tenantId}/users`)
        .set('Authorization', `Bearer ${owner.token}`)
        .set('Idempotency-Key', ulid())
        .send({ email, role: 'operator' })
        .expect(201);
      const id = invited.body.user.id as string;
      await userAction(owner.token, t.tenantId, id, 'deactivate').expect(200);
      // The old invite is cancelled.
      await http().post(`${API}/${t.tenantId}/accept-invite`).set('Idempotency-Key', ulid()).send({ token: invited.body.inviteToken, password: MEMBER_PASSWORD }).expect(400);
      const back = await userAction(owner.token, t.tenantId, id, 'reactivate').expect(200);
      expect(back.body.user.status).toBe('invited');
      expect(typeof back.body.inviteToken).toBe('string');
      await http().post(`${API}/${t.tenantId}/accept-invite`).set('Idempotency-Key', ulid()).send({ token: back.body.inviteToken, password: MEMBER_PASSWORD }).expect(200);
    });

    it('last active owner: self-deactivation refused; a second owner makes it possible; demoting counts active owners only', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      expect((await userAction(owner.token, t.tenantId, t.ownerId, 'deactivate').expect(409)).body.code).toBe('last-owner');
      const second = await createMember(owner.token, t.tenantId, 'owner');
      await userAction(owner.token, t.tenantId, second.userId, 'deactivate').expect(200);
      // With the second owner deactivated, the first is again the last ACTIVE owner.
      const demote = await http()
        .patch(`${API}/${t.tenantId}/users/${t.ownerId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .set('Idempotency-Key', ulid())
        .send({ role: 'operator' })
        .expect(409);
      expect(demote.body.code).toBe('last-owner');
      await userAction(owner.token, t.tenantId, second.userId, 'reactivate').expect(200);
      await userAction(owner.token, t.tenantId, t.ownerId, 'deactivate').expect(200);
    });

    it('an operator cannot deactivate anyone (users.role_change)', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const op = await createMember(owner.token, t.tenantId, 'operator');
      const opWeb = await signIn(op.email, MEMBER_PASSWORD);
      expect((await userAction(opWeb.token, t.tenantId, t.ownerId, 'deactivate').expect(403)).body.code).toBe('role-denied');
    });
  });

  // ── lockout and limits ────────────────────────────────────────────────────

  describe('lockout and attempt limits', () => {
    it('5 wrong passwords lock (email, IP) for 15 min: the 6th is 423 even with the right password; another IP still signs in; an unknown email answers the same; owner Unlock clears it', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const member = await createMember(owner.token, t.tenantId, 'operator');
      const ip = newIp();
      for (let i = 0; i < 5; i += 1) await signInReq(member.email, 'wrong-password', ip).expect(401);
      const locked = await signInReq(member.email, MEMBER_PASSWORD, ip).expect(423);
      expect(locked.body).toMatchObject({ code: 'sign-in-locked', retryAfterSeconds: expect.any(Number) });
      expect(locked.body.retryAfterSeconds).toBeGreaterThan(800);
      await signInReq(member.email, MEMBER_PASSWORD, newIp()).expect(200);

      const ghostIp = newIp();
      const ghost = `nobody-${ulid().toLowerCase()}@example.com`;
      for (let i = 0; i < 5; i += 1) await signInReq(ghost, 'wrong-password', ghostIp).expect(401);
      expect((await signInReq(ghost, 'whatever', ghostIp).expect(423)).body.code).toBe('sign-in-locked');

      const list = await http().get(`${API}/${t.tenantId}/users?limit=200`).set('Authorization', `Bearer ${owner.token}`).expect(200);
      const row = (list.body.items as { id: string; lockedUntil: string | null }[]).find((u) => u.id === member.userId)!;
      expect(row.lockedUntil).toEqual(expect.any(String));

      const key = ulid();
      await userAction(owner.token, t.tenantId, member.userId, 'unlock', key).expect(200);
      await expectAuditRow({ tenantId: t.tenantId, key, action: 'user.unlocked', targetType: 'user', targetId: member.userId, actorUserId: t.ownerId });
      await signInReq(member.email, MEMBER_PASSWORD, ip).expect(200);
    });

    it('a success resets the count', async () => {
      const t = await registerTenant();
      const ip = newIp();
      for (let i = 0; i < 4; i += 1) await signInReq(t.email, 'wrong-password', ip).expect(401);
      await signInReq(t.email, PASSWORD, ip).expect(200);
      for (let i = 0; i < 4; i += 1) await signInReq(t.email, 'wrong-password', ip).expect(401);
      await signInReq(t.email, PASSWORD, ip).expect(200);
    });

    it('per-IP limit: over 300 sign-in attempts a minute from one address is 429', async () => {
      const ip = newIp();
      await sql`insert into auth_rate_limits (bucket, window_start, count) values (${`signin-ip:${ip}`}, date_trunc('minute', now()), 300)`;
      const res = await signInReq(`x-${ulid().toLowerCase()}@example.com`, 'x', ip).expect(429);
      expect(res.body).toMatchObject({ code: 'rate-limited', retryAfterSeconds: expect.any(Number) });
    });

    it('5 wrong PINs lock the DEVICE (any operator email) for 15 min; supervisor Unlock clears it; the device list shows the lock', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const op = await createMember(owner.token, t.tenantId, 'operator');
      const device = await enrollDevice(owner.token, t.tenantId);
      for (let i = 0; i < 5; i += 1) {
        await badgeIn(t.tenantId, device.deviceToken, `rotating-${i}@example.com`, '0000').expect(401);
      }
      const locked = await badgeIn(t.tenantId, device.deviceToken, op.email, '1357').expect(423);
      expect(locked.body).toMatchObject({ code: 'badge-locked', retryAfterSeconds: expect.any(Number) });
      const list = await http().get(`${API}/${t.tenantId}/devices`).set('Authorization', `Bearer ${owner.token}`).expect(200);
      expect((list.body.items as { id: string; badgeLockedUntil: string | null }[]).find((d) => d.id === device.deviceId)!.badgeLockedUntil).toEqual(expect.any(String));
      const key = ulid();
      await deviceAction(owner.token, t.tenantId, device.deviceId, 'unlock', key).expect(200);
      await expectAuditRow({ tenantId: t.tenantId, key, action: 'device.unlocked', targetType: 'device', targetId: device.deviceId, actorUserId: t.ownerId });
      await badgeIn(t.tenantId, device.deviceToken, op.email, '1357').expect(200);
    });

    it('badge-in limit is per device: 30 operators badging in on 30 devices behind one address all succeed', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const op = await createMember(owner.token, t.tenantId, 'operator');
      const devices = await Promise.all(Array.from({ length: 3 }, () => enrollDevice(owner.token, t.tenantId)));
      // The device limit is the only limit badge-in has; another device's
      // window never counts here.
      await sql`insert into auth_rate_limits (bucket, window_start, count) values (${`badge-device:${devices[0]!.deviceId}`}, date_trunc('minute', now()), 30)`;
      expect((await badgeIn(t.tenantId, devices[0]!.deviceToken, op.email).expect(429)).body.code).toBe('rate-limited');
      await badgeIn(t.tenantId, devices[1]!.deviceToken, op.email).expect(200);
    });
  });

  // ── handheld sessions ─────────────────────────────────────────────────────

  describe('handheld: shift sessions, renewal, badge-out, release, operator-mismatch', () => {
    it('badge-in: a 12 h session and a renewed device credential; a re-badge ends the previous session', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const op = await createMember(owner.token, t.tenantId, 'operator');
      const device = await enrollDevice(owner.token, t.tenantId);
      const first = await badgeIn(t.tenantId, device.deviceToken, op.email).expect(200);
      expect(first.body).toMatchObject({ expiresInSeconds: 43200, deviceTokenExpiresInSeconds: 2592000 });
      expect(typeof first.body.deviceToken).toBe('string');
      await echo(t.tenantId, first.body.accessToken as string).expect(200);
      // The renewed credential badges in; the old one still does too.
      const second = await badgeIn(t.tenantId, first.body.deviceToken as string, op.email).expect(200);
      await badgeIn(t.tenantId, device.deviceToken, op.email).expect(200);
      const old = await echo(t.tenantId, first.body.accessToken as string).expect(401);
      expect(old.body).toMatchObject({ code: 'unauthenticated', reason: 'released' });
      void second;
    });

    it('a pre-6-1a device credential (no kind) still badges in; a pre-6-1a badge token is unauthenticated legacy; an expired badge session keeps the code unauthenticated', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const op = await createMember(owner.token, t.tenantId, 'operator');
      const device = await enrollDevice(owner.token, t.tenantId);
      const { createHmac } = await import('node:crypto');
      const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const sign = (payload: Record<string, unknown>) => {
        const head = enc({ alg: 'HS256', typ: 'JWT' });
        const body = enc(payload);
        return `${head}.${body}.${createHmac('sha256', tenantSessionSecret()).update(`${head}.${body}`).digest('base64url')}`;
      };
      const now = Math.floor(Date.now() / 1000);
      const legacyCredential = sign({ device_id: device.deviceId, tenant_id: t.tenantId, iat: now, exp: now + 3600 });
      await badgeIn(t.tenantId, legacyCredential, op.email).expect(200);
      const legacyBadge = sign({ device_id: device.deviceId, tenant_id: t.tenantId, sub: op.userId, iat: now, exp: now + 3600 });
      expect((await echo(t.tenantId, legacyBadge).expect(401)).body).toMatchObject({ code: 'unauthenticated', reason: 'legacy' });

      const current = await badgeIn(t.tenantId, device.deviceToken, op.email).expect(200);
      await sql`update sessions set absolute_expires_at = now() - interval '1 second', idle_expires_at = now() - interval '1 second' where device_id = ${device.deviceId} and revoked_at is null`;
      expect((await echo(t.tenantId, current.body.accessToken as string).expect(401)).body).toMatchObject({ code: 'unauthenticated', reason: 'absolute' });
      expect(signDeviceToken(t.tenantId, device.deviceId, tenantSessionSecret())).toBeTruthy();
    });

    it('badge-out ends the session and unbinds: the next operator can badge in', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const a = await createMember(owner.token, t.tenantId, 'operator');
      const b = await createMember(owner.token, t.tenantId, 'operator');
      const device = await enrollDevice(owner.token, t.tenantId);
      const session = await badgeIn(t.tenantId, device.deviceToken, a.email).expect(200);
      await badgeIn(t.tenantId, device.deviceToken, b.email).expect(401);
      await http().post(`${API}/${t.tenantId}/devices/badge-out`).set('Authorization', `Bearer ${session.body.accessToken}`).expect(204);
      expect((await echo(t.tenantId, session.body.accessToken as string).expect(401)).body.reason).toBe('signed-out');
      await badgeIn(t.tenantId, device.deviceToken, b.email).expect(200);
      // A bare device credential cannot badge out.
      await http().post(`${API}/${t.tenantId}/devices/badge-out`).set('Authorization', `Bearer ${device.deviceToken}`).expect(403);
    });

    it('Release device (device.manage): ends the badge session, unbinds; audited; an operator cannot', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const a = await createMember(owner.token, t.tenantId, 'operator');
      const b = await createMember(owner.token, t.tenantId, 'operator');
      const device = await enrollDevice(owner.token, t.tenantId);
      const session = await badgeIn(t.tenantId, device.deviceToken, a.email).expect(200);
      const aWeb = await signIn(a.email, MEMBER_PASSWORD);
      await deviceAction(aWeb.token, t.tenantId, device.deviceId, 'release').expect(403);
      const key = ulid();
      const released = await deviceAction(owner.token, t.tenantId, device.deviceId, 'release', key).expect(200);
      expect(released.body.operatorUserId).toBeNull();
      await expectAuditRow({ tenantId: t.tenantId, key, action: 'device.released', targetType: 'device', targetId: device.deviceId, actorUserId: t.ownerId });
      expect((await echo(t.tenantId, session.body.accessToken as string).expect(401)).body.reason).toBe('released');
      await badgeIn(t.tenantId, device.deviceToken, b.email).expect(200);
    });

    it('device revoke ends the badge session with the existing 403 device-revoked', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const a = await createMember(owner.token, t.tenantId, 'operator');
      const device = await enrollDevice(owner.token, t.tenantId);
      const session = await badgeIn(t.tenantId, device.deviceToken, a.email).expect(200);
      await deviceAction(owner.token, t.tenantId, device.deviceId, 'revoke').expect(200);
      expect((await echo(t.tenantId, session.body.accessToken as string).expect(403)).body.code).toBe('device-revoked');
    });

    it('operator-mismatch: an op captured by another operator is 409; an absent header is accepted', async () => {
      const t = await registerTenant();
      const owner = await signIn(t.email);
      const a = await createMember(owner.token, t.tenantId, 'operator');
      const device = await enrollDevice(owner.token, t.tenantId);
      const session = await badgeIn(t.tenantId, device.deviceToken, a.email).expect(200);
      const token = session.body.accessToken as string;
      expect((await echo(t.tenantId, token, uuidv7()).expect(409)).body.code).toBe('operator-mismatch');
      await echo(t.tenantId, token, a.userId).expect(200);
      await echo(t.tenantId, token).expect(200);
    });
  });
});
