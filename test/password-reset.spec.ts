import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import request from 'supertest';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { SYSTEM_ACTOR_ID } from '../src/shared/primitives/audit';
import { EMAIL_GATEWAY, type LogEmailGateway } from '../src/modules/mail/email.gateway';
import { MailFacade } from '../src/modules/mail/mail.facade';
import { SessionPurgeWorker } from '../src/jobs/jobs.module';
import { emailDigest, hitRateLimit, ipKey } from '../src/modules/tenancy/auth-attempts';
import { DEVICE_COOKIE_NAME } from '../src/modules/tenancy/device-cookie';
import { REFRESH_COOKIE_NAME } from '../src/modules/tenancy/session-cookie';
import { RESET_REQUESTED_MESSAGE } from '../src/modules/tenancy/password-reset.command';
import { totpAt } from '../src/modules/tenancy/second-factor';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow } from './support/audit-guard';
import { enrolledFactorOf, mintSignIn, nextTotpCode, rememberFactor, signInAs } from './support/sign-in';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.CORS_ORIGIN = 'http://localhost:3001';
process.env.COOKIE_SECURE = 'false';
// One trusted hop, so each request names its own client address.
process.env.TRUSTED_PROXY_HOPS = '1';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.EMAIL_SEND_POLL_MS;
delete process.env.EMAIL_ALLOWLIST_DOMAINS;
delete process.env.EMAIL_REPLY_TO;
// The `log` provider: every mail is captured in memory, nothing leaves the process.
process.env.EMAIL_PROVIDER = 'log';
process.env.EMAIL_FROM = 'no-reply@mail.wms.test';
process.env.WEB_BASE_URL = 'https://app.wms.test/';
process.env.EMAIL_SEAL_KEY = 'e2e-only-email-seal-key-0123456789abcdef';
delete process.env.EMAIL_SEAL_KEY_PREVIOUS;

const API = '/api/v1/tenants';
const ORIGIN = 'http://localhost:3001';
const PASSWORD = 'correct-horse-battery';
const MEMBER_PASSWORD = 'team-member-password';
const NEW_PASSWORD = 'a-brand-new-password';
const PROBE_LOCK = 742105;

jest.setTimeout(240_000);

/**
 * Story 6-1c — password reset and login rate limits, end to end: the
 * request's one answer, the token rules (single use, 60 minutes, the
 * fragment link, never stored or logged raw), the second factor at the
 * reset (counted on the token, never the user; no bypass at the next
 * sign-in), every session revoked, deactivation, the device cookie (trusted
 * attempts), the untrusted hour buckets and their refunds, the IPv6 /64 key,
 * the purge and the vocabularies.
 */
describe('password reset and login rate limits (e2e, story 6-1c)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql;
  let captured: LogEmailGateway;
  let mail: MailFacade;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('password_reset');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    captured = app.get<LogEmailGateway>(EMAIL_GATEWAY);
    mail = app.get(MailFacade);
  });

  afterAll(async () => {
    try {
      await sql.end();
      const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
      await db.$client?.end();
      const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
      await authDb.$client?.end();
      await app.close();
    } finally {
      await suiteDb.drop();
    }
  });

  // ── fixtures ───────────────────────────────────────────────────────────────

  const http = () => request(app.getHttpServer());
  const newIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  interface Tenant {
    tenantId: string;
    ownerId: string;
    email: string;
    name: string;
    ownerToken: string;
  }

  /** A tenant whose owner has signed in for real (both steps: enrolled with the helper's authenticator). */
  async function registerTenant(): Promise<Tenant> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const name = `Reset Co ${ulid()}`;
    const res = await http().post(API).set('Idempotency-Key', ulid()).send({ name, ownerEmail: email, password: PASSWORD }).expect(201);
    const signedIn = await signInAs(app, email, PASSWORD, { ip: newIp() });
    expect(signedIn.status).toBe(200);
    return {
      tenantId: res.body.tenant.id as string,
      ownerId: res.body.owner.id as string,
      email,
      name,
      ownerToken: signedIn.body.accessToken as string,
    };
  }

  async function createMember(t: Tenant, role: string, extra: Record<string, unknown> = {}): Promise<{ userId: string; email: string }> {
    const email = `member-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${t.tenantId}/users`)
      .set('Authorization', `Bearer ${t.ownerToken}`)
      .set('Idempotency-Key', ulid())
      .send({ email, role, ...extra })
      .expect(201);
    await http()
      .post(`${API}/${t.tenantId}/accept-invite`)
      .set('Idempotency-Key', ulid())
      .send({ token: invited.body.inviteToken, password: MEMBER_PASSWORD })
      .expect(200);
    return { userId: invited.body.user.id as string, email };
  }

  async function createClient(t: Tenant): Promise<string> {
    return (
      await http()
        .post(`${API}/${t.tenantId}/clients`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set('Idempotency-Key', ulid())
        .send({ code: `BR${ulid().slice(-6)}`, name: 'Brand A Apparel' })
        .expect(201)
    ).body.client.id as string;
  }

  async function setClientStatus(t: Tenant, clientId: string, status: 'active' | 'suspended'): Promise<void> {
    await http()
      .patch(`${API}/${t.tenantId}/clients/${clientId}/status`)
      .set('Authorization', `Bearer ${t.ownerToken}`)
      .set('Idempotency-Key', ulid())
      .send({ status })
      .expect(200);
  }

  const requestReset = (email: string, ip = newIp()) => http().post(`${API}/password-reset`).set('X-Forwarded-For', ip).send({ email });
  const check = (token: string, ip = newIp()) => http().post(`${API}/password-reset/check`).set('X-Forwarded-For', ip).send({ token });
  const confirm = (token: string, body: { password?: string; code?: string } = {}, ip = newIp()) =>
    http()
      .post(`${API}/password-reset/confirm`)
      .set('X-Forwarded-For', ip)
      .send({ token, password: body.password ?? NEW_PASSWORD, ...(body.code === undefined ? {} : { code: body.code }) });

  const signInReq = (email: string, password: string, ip = newIp(), cookie?: string) => {
    const req = http().post(`${API}/sign-in`).set('X-Forwarded-For', ip).set('X-WMS-Second-Factor', '1');
    if (cookie !== undefined) req.set('Cookie', cookie);
    return req.send({ email, password });
  };

  const me = (tenantId: string, token: string) => http().get(`${API}/${tenantId}/me`).set('Authorization', `Bearer ${token}`);

  function cookieOf(res: request.Response, name: string): string | null {
    const raw = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const line = raw.find((value) => value.startsWith(`${name}=`));
    return line === undefined ? null : line.split(';')[0]!;
  }

  /** Sends the tenant's due mail, then the newest reset link captured for the email → its token (from the fragment). */
  async function linkFor(tenantId: string, email: string): Promise<string> {
    await sql`update email_messages set next_attempt_at = now() where tenant_id = ${tenantId} and status = 'pending'`;
    await mail.sendDue(tenantId);
    const mails = captured.captured.filter((m) => m.to === email && m.template === 'password-reset');
    const last = mails[mails.length - 1];
    if (last === undefined) throw new Error(`no reset mail for ${email}`);
    const url = /https:\/\/app\.wms\.test\/reset-password#token=[^\s"<]+/.exec(last.text)![0];
    const parsed = new URL(url);
    expect(parsed.search).toBe('');
    return new URLSearchParams(parsed.hash.slice(1)).get('token')!;
  }

  async function messages(tenantId: string, userId: string) {
    return sql<{ id: string; template: string; status: string; error_code: string | null; sealed_secret: string | null; params: Record<string, unknown> }[]>`
      select id, template, status, error_code, sealed_secret, params from email_messages
       where tenant_id = ${tenantId} and user_id = ${userId} order by created_at, id`;
  }

  async function resets(tenantId: string, userId: string) {
    return sql<{ id: string; consumed: boolean; code_failures: number; requested_ip: string }[]>`
      select id, (consumed_at is not null) as consumed, code_failures, requested_ip from password_resets
       where tenant_id = ${tenantId} and user_id = ${userId} order by created_at, id`;
  }

  const userRow = async (userId: string) =>
    (await sql<{ mfa_failures: number; mfa_lock_cycles: number; mfa_locked_until: string | null; mfa_failed_since_success: number; mfa_last_step: string | null }[]>`
      select mfa_failures, mfa_lock_cycles, mfa_locked_until::text, mfa_failed_since_success, mfa_last_step::text from users where id = ${userId}`)[0]!;

  /** A 6-digit code that is NOT valid for this secret anywhere near now. */
  function wrongCode(email: string): string {
    const secret = enrolledFactorOf(email).secret;
    const step = Math.floor(Date.now() / 30_000);
    const near = new Set([-2, -1, 0, 1, 2].map((d) => totpAt(secret, step + d)));
    for (let n = 0; ; n += 1) {
      const candidate = String(n).padStart(6, '0');
      if (!near.has(candidate)) return candidate;
    }
  }

  // ── the request ────────────────────────────────────────────────────────────

  describe('the request', () => {
    it('staff without 2FA: 202; ONE sealed pending mail (params without the token); the link carries the token in the fragment; check; confirm → 200 and the device cookie; the new password signs in, the old does not; a password-changed notice is queued', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      const ip = newIp();
      // Capture every log line the flow writes: the raw token must reach none.
      const lines: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
        lines.push(String(chunk));
        return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
      });
      let token: string;
      try {
        const res = await requestReset(m.email, ip).expect(202);
        expect(res.body).toEqual({ message: RESET_REQUESTED_MESSAGE });
        const [queued] = await messages(t.tenantId, m.userId).then((rows) => rows.filter((r) => r.template === 'password-reset'));
        expect(queued).toMatchObject({ status: 'pending', error_code: null });
        expect(queued!.sealed_secret).not.toBeNull();
        expect(Object.keys(queued!.params).sort()).toEqual(['expiresAt', 'tenantName']);
        expect(queued!.params.tenantName).toBe(t.name);
        await expectAuditRow({ action: 'user.password_reset_requested', targetType: 'user', tenantId: t.tenantId, key: `ip:${ip}`, targetId: m.userId, actorUserId: SYSTEM_ACTOR_ID });

        token = await linkFor(t.tenantId, m.email);
        const sentMail = captured.captured.filter((x) => x.to === m.email && x.template === 'password-reset').pop()!;
        expect(sentMail.text).toContain(`Someone asked to reset the password for ${m.email} at ${t.name}.`);
        expect(sentMail.text).toContain("If this wasn't you, ignore this email — your password stays the same.");
        expect(sentMail.text).toMatch(/expires at \d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} \(IST\)/);
        expect(sentMail.replyTo).toBeNull();
        // Once final, the sealed secret is wiped.
        expect((await messages(t.tenantId, m.userId)).find((r) => r.template === 'password-reset')).toMatchObject({ status: 'sent', sealed_secret: null });

        const checked = await check(token).expect(200);
        expect(checked.body).toEqual({ email: m.email, expiresAt: expect.any(String), secondFactorRequired: false });
        const minutes = (Date.parse(checked.body.expiresAt as string) - Date.now()) / 60_000;
        expect(minutes).toBeGreaterThan(58);
        expect(minutes).toBeLessThanOrEqual(60);

        const confirmIp = newIp();
        const done = await confirm(token, {}, confirmIp).expect(200);
        expect(done.body).toEqual({ email: m.email });
        // No session, no refresh cookie: only the device cookie.
        expect(done.body.accessToken).toBeUndefined();
        expect(cookieOf(done, REFRESH_COOKIE_NAME)).toBeNull();
        expect(cookieOf(done, DEVICE_COOKIE_NAME)).toMatch(/^wms_device=v1\./);
        const [reset] = await resets(t.tenantId, m.userId);
        await expectAuditRow({ action: 'user.password_reset', targetType: 'user', tenantId: t.tenantId, key: `reset:${reset!.id}@${confirmIp}`, targetId: m.userId, actorUserId: m.userId });
        expect(reset).toMatchObject({ consumed: true, requested_ip: ip });
      } finally {
        spy.mockRestore();
      }

      // The raw token is in no params, audit row, idempotency key or log line.
      const secretPart = token.split('.')[1]!;
      const leaks = await sql<{ n: number }[]>`
        select ((select count(*) from email_messages e where e.params::text like ${`%${secretPart}%`})
              + (select count(*) from audit_events a where a::text like ${`%${secretPart}%`})
              + (select count(*) from idempotency_keys k where k::text like ${`%${secretPart}%`}))::int as n`;
      expect(leaks[0]!.n).toBe(0);
      expect(lines.filter((line) => line.includes(secretPart))).toEqual([]);

      await signInReq(m.email, MEMBER_PASSWORD).expect(401);
      expect((await signInReq(m.email, NEW_PASSWORD).expect(200)).body.accessToken).toEqual(expect.any(String));
      const changed = (await messages(t.tenantId, m.userId)).filter((r) => r.template === 'password-changed');
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({ status: 'pending', sealed_secret: null });
      await sql`update email_messages set next_attempt_at = now() where tenant_id = ${t.tenantId} and status = 'pending'`;
      await mail.sendDue(t.tenantId);
      const notice = captured.captured.filter((x) => x.to === m.email && x.template === 'password-changed').pop()!;
      expect(notice.text).toContain(`The password for ${m.email} at ${t.name} was changed at`);
      expect(notice.text).toContain('Every device was signed out.');
    });

    it('an unknown, an invited and a deactivated email: the same 202 and body; no token, no mail, no audit row', async () => {
      const t = await registerTenant();
      const invitedEmail = `invited-${ulid().toLowerCase()}@example.com`;
      const invited = await http()
        .post(`${API}/${t.tenantId}/users`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set('Idempotency-Key', ulid())
        .send({ email: invitedEmail, role: 'operator' })
        .expect(201);
      const gone = await createMember(t, 'operator');
      await http()
        .post(`${API}/${t.tenantId}/users/${gone.userId}/deactivate`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set('Idempotency-Key', ulid())
        .expect(200);
      const real = await createMember(t, 'operator');
      const answers = await Promise.all(
        [`nobody-${ulid().toLowerCase()}@example.com`, invitedEmail, gone.email, real.email].map(async (email) => {
          const res = await requestReset(email).expect(202);
          return { status: res.status, body: JSON.stringify(res.body), type: res.headers['content-type'] };
        }),
      );
      expect(new Set(answers.map((a) => `${a.status}|${a.body}|${a.type}`)).size).toBe(1);
      for (const userId of [invited.body.user.id as string, gone.userId]) {
        expect(await resets(t.tenantId, userId)).toEqual([]);
        expect((await messages(t.tenantId, userId)).filter((r) => r.template === 'password-reset')).toEqual([]);
        expect(await sql`select 1 from audit_events where target_id = ${userId} and action = 'user.password_reset_requested'`).toHaveLength(0);
      }
      expect(await resets(t.tenantId, real.userId)).toHaveLength(1);
    });

    it('a portal user: works while the client is active; suspended → the same 202 and no mail, and an older link checks 400', async () => {
      const t = await registerTenant();
      const clientId = await createClient(t);
      const p = await createMember(t, 'client', { clientId });
      await requestReset(p.email).expect(202);
      const token = await linkFor(t.tenantId, p.email);
      expect((await check(token).expect(200)).body.secondFactorRequired).toBe(false);
      await setClientStatus(t, clientId, 'suspended');
      expect((await check(token).expect(400)).body.code).toBe('reset-link-invalid');
      expect((await confirm(token).expect(400)).body.code).toBe('reset-link-invalid');
      const before = (await resets(t.tenantId, p.userId)).length;
      expect((await requestReset(p.email).expect(202)).body).toEqual({ message: RESET_REQUESTED_MESSAGE });
      expect(await resets(t.tenantId, p.userId)).toHaveLength(before);
      await setClientStatus(t, clientId, 'active');
      await confirm(token).expect(200);
      // The portal session path: the new password signs in to the portal.
      expect((await signInReq(p.email, NEW_PASSWORD).expect(200)).body.client).toMatchObject({ id: clientId });
    });

    it('past 20 requests an hour from one address → 429 in minutes', async () => {
      const ip = newIp();
      await sql`insert into auth_rate_limits (bucket, window_start, count)
                values (${`reset-request-ip:${ip}`}, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 20)`;
      const res = await requestReset(`x-${ulid().toLowerCase()}@example.com`, ip).expect(429);
      expect(res.body).toMatchObject({ code: 'rate-limited', retryAfterSeconds: expect.any(Number) });
      if ((res.body.retryAfterSeconds as number) > 120) expect(res.body.detail).toMatch(/Try again in \d+ minutes?\./);
    });

    it('a flood: at most 5 mails an hour; every link in the inbox still works (no supersede); the 6th request is the same silent 202', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      for (let i = 0; i < 6; i += 1) expect((await requestReset(m.email).expect(202)).body).toEqual({ message: RESET_REQUESTED_MESSAGE });
      const rows = await resets(t.tenantId, m.userId);
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => !r.consumed)).toBe(true);
      const queued = (await messages(t.tenantId, m.userId)).filter((r) => r.template === 'password-reset');
      expect(queued.map((r) => r.status)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
      await sql`update email_messages set next_attempt_at = now() where tenant_id = ${t.tenantId}`;
      await mail.sendDue(t.tenantId, 50);
      const links = captured.captured
        .filter((x) => x.to === m.email && x.template === 'password-reset')
        .map((x) => new URLSearchParams(new URL(/https:\/\/\S+/.exec(x.text)![0]).hash.slice(1)).get('token')!);
      expect(links).toHaveLength(5);
      for (const link of links) await check(link).expect(200);
      // Completing one spends them all.
      await confirm(links[2]!).expect(200);
      for (const link of links) expect((await check(link).expect(400)).body.code).toBe('reset-link-invalid');
    });

    it('a sixth LIVE token (the hourly cap lifted) spends the oldest and cancels its still-queued mail `superseded`', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      for (let i = 0; i < 5; i += 1) await requestReset(m.email).expect(202);
      // Age every token past the rolling hour while keeping them live.
      await sql`update password_resets set created_at = now() - interval '61 minutes', expires_at = now() + interval '30 minutes' where user_id = ${m.userId}`;
      await requestReset(m.email).expect(202);
      const rows = await resets(t.tenantId, m.userId);
      expect(rows.map((r) => r.consumed)).toEqual([true, false, false, false, false, false]);
      const queued = (await messages(t.tenantId, m.userId)).filter((r) => r.template === 'password-reset');
      expect(queued.map((r) => `${r.status}:${r.error_code ?? ''}`)).toEqual([
        'cancelled:superseded',
        'pending:',
        'pending:',
        'pending:',
        'pending:',
        'pending:',
      ]);
      expect(queued[0]!.sealed_secret).toBeNull();
    });
  });

  // ── tokens ─────────────────────────────────────────────────────────────────

  describe('the token', () => {
    it('one 400 for a malformed, unknown, wrong-secret, expired and spent token; check writes nothing; a used link answers 400 the second time', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      await requestReset(m.email).expect(202);
      const token = await linkFor(t.tenantId, m.email);
      const id = token.split('.')[0]!;
      const before = await sql`select * from password_resets where user_id = ${m.userId}`;
      for (let i = 0; i < 3; i += 1) await check(token).expect(200);
      expect(await sql`select * from password_resets where user_id = ${m.userId}`).toEqual(before);
      const bodies = new Set<string>();
      for (const bad of ['nope', `${ulid()}.${'a'.repeat(43)}`, `00000000-0000-7000-8000-000000000000.${'a'.repeat(43)}`, `${id}.${'b'.repeat(43)}`]) {
        const res = await check(bad).expect(400);
        bodies.add(`${res.body.code}|${res.body.detail}`);
      }
      await sql`update password_resets set expires_at = now() - interval '1 second', created_at = now() - interval '61 minutes' where id = ${id}`;
      const expired = await check(token).expect(400);
      bodies.add(`${expired.body.code}|${expired.body.detail}`);
      await sql`update password_resets set expires_at = now() + interval '10 minutes' where id = ${id}`;
      await confirm(token).expect(200);
      const again = await confirm(token).expect(400);
      bodies.add(`${again.body.code}|${again.body.detail}`);
      expect([...bodies]).toEqual([
        'reset-link-invalid|This link has expired or was already used. If you just set your password, sign in — otherwise ask for a new link.',
      ]);
      // The DTO's password rule (8–200), before anything is counted.
      await requestReset(m.email).expect(202);
      const next = await linkFor(t.tenantId, m.email);
      expect((await confirm(next, { password: 'short' }).expect(400)).body.code).toBe('validation-failed');
    });

    it('race: two confirms of one token (no 2FA) → exactly one 200 and one 400', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      await requestReset(m.email).expect(202);
      const token = await linkFor(t.tenantId, m.email);
      const [a, b] = await Promise.all([confirm(token, { password: 'first-new-password' }), confirm(token, { password: 'second-new-password' })]);
      expect([a.status, b.status].sort()).toEqual([200, 400]);
      const winner = a.status === 200 ? 'first-new-password' : 'second-new-password';
      await signInReq(m.email, winner).expect(200);
      expect(await sql`select 1 from audit_events where target_id = ${m.userId} and action = 'user.password_reset'`).toHaveLength(1);
    });

    it('check and confirm share a 30-a-minute address limit (429)', async () => {
      const ip = newIp();
      await sql`insert into auth_rate_limits (bucket, window_start, count) values (${`reset-ip:${ip}`}, date_trunc('minute', now()), 30)`;
      expect((await check('x.y', ip).expect(429)).body.code).toBe('rate-limited');
      expect((await confirm('x.y', {}, ip).expect(429)).body.code).toBe('rate-limited');
    });

    it('deactivation spends every reset link and cancels its queued mail `deactivated`', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      await requestReset(m.email).expect(202);
      await requestReset(m.email).expect(202);
      await http()
        .post(`${API}/${t.tenantId}/users/${m.userId}/deactivate`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set('Idempotency-Key', ulid())
        .expect(200);
      expect((await resets(t.tenantId, m.userId)).every((r) => r.consumed)).toBe(true);
      expect((await messages(t.tenantId, m.userId)).filter((r) => r.template === 'password-reset').map((r) => `${r.status}:${r.error_code}`)).toEqual([
        'cancelled:deactivated',
        'cancelled:deactivated',
      ]);
    });
  });

  // ── the second factor ──────────────────────────────────────────────────────

  describe('the second factor at the reset', () => {
    it('an enrolled owner: no code → 422 (nothing counted); a wrong code → 422 attemptsLeft, counted on the TOKEN; a right one → 200; the next sign-in still asks for a code, and the code used at the reset is a reuse there', async () => {
      const t = await registerTenant();
      await requestReset(t.email).expect(202);
      const token = await linkFor(t.tenantId, t.email);
      expect((await check(token).expect(200)).body.secondFactorRequired).toBe(true);

      const none = await confirm(token).expect(422);
      expect(none.body.code).toBe('second-factor-needed');
      expect((await resets(t.tenantId, t.ownerId))[0]!.code_failures).toBe(0);

      const wrong = await confirm(token, { code: wrongCode(t.email) }).expect(422);
      expect(wrong.body).toMatchObject({ code: 'second-factor-invalid', attemptsLeft: 4 });
      expect((await resets(t.tenantId, t.ownerId))[0]!.code_failures).toBe(1);
      // A8 — the user's 2FA counters are never fed by a reset page.
      expect(await userRow(t.ownerId)).toMatchObject({ mfa_failures: 0, mfa_lock_cycles: 0, mfa_locked_until: null, mfa_failed_since_success: 0 });

      const { code, step } = await nextTotpCode(t.email);
      await confirm(token, { code }).expect(200);
      expect((await userRow(t.ownerId)).mfa_last_step).toBe(String(step));

      // The next sign-in runs the second step unchanged — no bypass.
      const passwordStep = await signInReq(t.email, NEW_PASSWORD).expect(200);
      expect(passwordStep.body.challenge).toBe('totp');
      expect(passwordStep.body.accessToken).toBeUndefined();
      // A10 — the same TOTP step at the sign-in is a reuse: second-factor-invalid, counted.
      const reuse = await http()
        .post(`${API}/sign-in/second-factor`)
        .set('X-Forwarded-For', newIp())
        .send({ challengeToken: passwordStep.body.challengeToken, code: totpAt(enrolledFactorOf(t.email).secret, step) })
        .expect(401);
      expect(reuse.body.code).toBe('second-factor-invalid');
      expect((await userRow(t.ownerId)).mfa_failures).toBe(1);
      // And a fresh code signs in.
      expect((await signInAs(app, t.email, NEW_PASSWORD, { ip: newIp() })).status).toBe(200);
    });

    it('a mailbox holder guessing codes: the 5th wrong code spends the token; the owner’s 2FA counters are untouched; a live 2FA lock answers 423 and counts nothing', async () => {
      const t = await registerTenant();
      await requestReset(t.email).expect(202);
      const token = await linkFor(t.tenantId, t.email);
      const lefts: number[] = [];
      for (let i = 0; i < 5; i += 1) lefts.push((await confirm(token, { code: wrongCode(t.email) }).expect(422)).body.attemptsLeft as number);
      expect(lefts).toEqual([4, 3, 2, 1, 0]);
      expect((await resets(t.tenantId, t.ownerId))[0]).toMatchObject({ code_failures: 5, consumed: true });
      expect((await confirm(token, { code: (await nextTotpCode(t.email)).code }).expect(400)).body.code).toBe('reset-link-invalid');
      expect(await userRow(t.ownerId)).toMatchObject({ mfa_failures: 0, mfa_lock_cycles: 0, mfa_locked_until: null });

      await requestReset(t.email).expect(202);
      const next = await linkFor(t.tenantId, t.email);
      await sql`update users set mfa_locked_until = now() + interval '10 minutes' where id = ${t.ownerId}`;
      const locked = await confirm(next, { code: (await nextTotpCode(t.email)).code }).expect(423);
      expect(locked.body).toMatchObject({ code: 'second-factor-locked', retryAfterSeconds: expect.any(Number) });
      const latest = (await resets(t.tenantId, t.ownerId)).pop()!;
      expect(latest).toMatchObject({ code_failures: 0, consumed: false });
      expect((await userRow(t.ownerId)).mfa_lock_cycles).toBe(0);
      await sql`update users set mfa_locked_until = null where id = ${t.ownerId}`;
    });

    it('a backup code completes a reset and is spent; codes tried on reset links are capped at 25 a day per user (429)', async () => {
      const t = await registerTenant();
      // Enrolment through the helper keeps the ten backup codes.
      const backup = enrolledFactorOf(t.email).backupCodes[0]!;
      await requestReset(t.email).expect(202);
      const token = await linkFor(t.tenantId, t.email);
      await confirm(token, { code: backup }).expect(200);
      expect(await sql`select 1 from user_backup_codes where user_id = ${t.ownerId} and used_at is not null`).toHaveLength(1);

      await requestReset(t.email).expect(202);
      const next = await linkFor(t.tenantId, t.email);
      await sql`insert into auth_rate_limits (bucket, window_start, count)
                values (${`reset-code:${t.ownerId}`}, to_timestamp(floor(extract(epoch from now()) / 86400) * 86400), 25)
                on conflict (bucket) do update set count = 25, window_start = excluded.window_start`;
      expect((await confirm(next, { code: wrongCode(t.email) }).expect(429)).body.code).toBe('rate-limited');
      expect((await resets(t.tenantId, t.ownerId)).pop()!.code_failures).toBe(0);
    });

    it('a staff user who enrolled AFTER checking the link: the confirm without a code is 422 second-factor-needed', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'ops_manager');
      await requestReset(m.email).expect(202);
      const token = await linkFor(t.tenantId, m.email);
      expect((await check(token).expect(200)).body.secondFactorRequired).toBe(false);
      const memberToken = (await mintSignIn(app, { email: m.email, password: MEMBER_PASSWORD })).body.accessToken as string;
      const security = (path: string) => http().post(`${API}/${t.tenantId}/me/second-factor${path}`).set('Authorization', `Bearer ${memberToken}`);
      const setup = await security('/setup').send({ password: MEMBER_PASSWORD }).expect(200);
      rememberFactor(m.email, setup.body.secret as string);
      await security('/confirm').send({ code: (await nextTotpCode(m.email)).code }).expect(200);
      // The link was checked before the enrolment; the confirm reads the factor again.
      expect((await confirm(token).expect(422)).body.code).toBe('second-factor-needed');
      expect((await check(token).expect(200)).body.secondFactorRequired).toBe(true);
      await confirm(token, { code: (await nextTotpCode(m.email)).code }).expect(200);
    });
  });

  // ── what a completed reset ends ────────────────────────────────────────────

  describe('a completed reset', () => {
    it('ends every session: web tabs and refresh → session-ended `password-reset`; a badge session → 401 unauthenticated `password-reset`; an older sign-in challenge → challenge-ended; every lockout clears', async () => {
      const t = await registerTenant();
      const op = await createMember(t, 'operator');
      // A web session with its refresh cookie.
      const web = await signInReq(op.email, MEMBER_PASSWORD).expect(200);
      const refreshCookie = cookieOf(web, REFRESH_COOKIE_NAME)!;
      // A badge session on a handheld.
      const minted = await http().post(`${API}/${t.tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${t.ownerToken}`).set('Idempotency-Key', ulid()).send({}).expect(201);
      const enrolled = await http().post(`${API}/${t.tenantId}/devices/enroll`).set('Idempotency-Key', ulid()).send({ code: minted.body.code, label: `HH-${ulid().slice(-4)}`, pin: '1357' }).expect(201);
      const badged = await http().post(`${API}/${t.tenantId}/devices/badge-in`).set('Authorization', `Bearer ${enrolled.body.deviceToken}`).send({ operatorEmail: op.email, pin: '1357' }).expect(200);
      const echo = () =>
        http().post(`${API}/${t.tenantId}/devices/self-test/echo`).set('Authorization', `Bearer ${badged.body.accessToken}`).set('Idempotency-Key', ulid()).send({ payload: { probe: true } });
      await echo().expect(200);
      // A lock on another address.
      const lockedIp = newIp();
      for (let i = 0; i < 5; i += 1) await signInReq(op.email, 'wrong-password', lockedIp).expect(401);
      await signInReq(op.email, MEMBER_PASSWORD, lockedIp).expect(423);

      await requestReset(op.email).expect(202);
      await confirm(await linkFor(t.tenantId, op.email)).expect(200);

      expect((await me(t.tenantId, web.body.accessToken as string).expect(401)).body).toMatchObject({ code: 'session-ended', reason: 'password-reset' });
      const refreshed = await http().post(`${API}/session/refresh`).set('Origin', ORIGIN).set('X-WMS-Session', '1').set('Cookie', refreshCookie).expect(401);
      expect(refreshed.body).toMatchObject({ code: 'session-ended', reason: 'password-reset', detail: 'Your password was reset — sign in with the new password.' });
      expect((await echo().expect(401)).body).toMatchObject({ code: 'unauthenticated', reason: 'password-reset' });
      expect(await sql`select kind from sessions where user_id = ${op.userId} and revoked_reason = 'password-reset' order by kind`).toEqual([{ kind: 'badge' }, { kind: 'web' }]);
      // The lockout cleared; the badge PIN is unchanged.
      await signInReq(op.email, NEW_PASSWORD, lockedIp).expect(200);
      await http().post(`${API}/${t.tenantId}/devices/badge-in`).set('Authorization', `Bearer ${enrolled.body.deviceToken}`).send({ operatorEmail: op.email, pin: '1357' }).expect(200);
    });

    it('a 2FA challenge issued before the reset can no longer complete (challenge-ended); the factor and backup codes are untouched', async () => {
      const t = await registerTenant();
      const passwordStep = await signInReq(t.email, PASSWORD).expect(200);
      expect(passwordStep.body.challenge).toBe('totp');
      const codesBefore = await sql`select id, used_at from user_backup_codes where user_id = ${t.ownerId} order by id`;
      const factorBefore = await sql`select mfa_secret_sealed, mfa_enabled_at from users where id = ${t.ownerId}`;
      await requestReset(t.email).expect(202);
      await confirm(await linkFor(t.tenantId, t.email), { code: (await nextTotpCode(t.email)).code }).expect(200);
      const late = await http()
        .post(`${API}/sign-in/second-factor`)
        .set('X-Forwarded-For', newIp())
        .send({ challengeToken: passwordStep.body.challengeToken, code: (await nextTotpCode(t.email)).code })
        .expect(401);
      expect(late.body.code).toBe('challenge-ended');
      expect(await sql`select id, used_at from user_backup_codes where user_id = ${t.ownerId} order by id`).toEqual(codesBefore);
      expect(await sql`select mfa_secret_sealed, mfa_enabled_at from users where id = ${t.ownerId}`).toEqual(factorBefore);
    });

    it('two requests in a row: completing the second spends the first; both queued mails are cancelled `accepted`; the password-changed notice is queued after', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      await requestReset(m.email).expect(202);
      await requestReset(m.email).expect(202);
      // Read the second link from the sealed row without sending (both stay queued).
      const rows = await resets(t.tenantId, m.userId);
      expect(rows).toHaveLength(2);
      await sql`update email_messages set next_attempt_at = now() + interval '1 hour' where user_id = ${m.userId} and template = 'password-reset' and id = (select email_message_id from password_resets where id = ${rows[0]!.id})`;
      await mail.sendDue(t.tenantId);
      const sent = captured.captured.filter((x) => x.to === m.email && x.template === 'password-reset');
      expect(sent).toHaveLength(1);
      const second = new URLSearchParams(new URL(/https:\/\/\S+/.exec(sent[0]!.text)![0]).hash.slice(1)).get('token')!;
      expect(second.split('.')[0]).toBe(rows[1]!.id);
      await confirm(second).expect(200);
      const mails = await messages(t.tenantId, m.userId);
      expect(mails.filter((r) => r.template === 'password-reset').map((r) => `${r.status}:${r.error_code ?? ''}`)).toEqual(['cancelled:accepted', 'sent:']);
      expect(mails[mails.length - 1]).toMatchObject({ template: 'password-changed', status: 'pending' });
      expect((await resets(t.tenantId, m.userId)).every((r) => r.consumed)).toBe(true);
    });
  });

  // ── login limits and the device cookie ─────────────────────────────────────

  describe('login limits and the device cookie', () => {
    it('botnet: the 21st untrusted attempt in the hour → 429 from every new address (in minutes); the browser holding a device cookie still signs in; a new browser escapes through the reset, whose cookie it then holds', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      const trusted = await signInReq(m.email, MEMBER_PASSWORD).expect(200);
      const deviceCookie = cookieOf(trusted, DEVICE_COOKIE_NAME)!;
      for (let i = 0; i < 20; i += 1) await signInReq(m.email, 'wrong-password').expect(401);
      const refused = await signInReq(m.email, MEMBER_PASSWORD).expect(429);
      expect(refused.body).toMatchObject({ code: 'rate-limited' });
      expect(refused.body.retryAfterSeconds as number).toBeGreaterThan(0);
      if ((refused.body.retryAfterSeconds as number) > 120) expect(refused.body.detail).toMatch(/minutes?\./);
      // The cookie holder, from any address, is unaffected.
      await signInReq(m.email, MEMBER_PASSWORD, newIp(), deviceCookie).expect(200);
      // A new browser: the reset is not limited by the sign-in buckets, and its confirm issues the cookie.
      await requestReset(m.email).expect(202);
      const done = await confirm(await linkFor(t.tenantId, m.email)).expect(200);
      const fresh = cookieOf(done, DEVICE_COOKIE_NAME)!;
      await signInReq(m.email, NEW_PASSWORD, newIp()).expect(429);
      await signInReq(m.email, NEW_PASSWORD, newIp(), fresh).expect(200);
      // A3 — the reset invalidated every OLDER cookie (hash-bound): untrusted again → the bucket.
      await signInReq(m.email, NEW_PASSWORD, newIp(), deviceCookie).expect(429);
    });

    it('a right password is refunded: 25 right sign-ins in a row stay under the 20-an-hour account bucket', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      for (let i = 0; i < 25; i += 1) await signInReq(m.email, MEMBER_PASSWORD).expect(200);
      const [bucket] = await sql<{ count: number }[]>`select count from auth_rate_limits where bucket = ${`signin-account:${emailDigest(m.email)}`}`;
      expect(bucket!.count).toBe(0);
    });

    it('the address-hour bucket: past 200 untrusted attempts an hour → 429 in minutes, and the refused attempt gives the account bucket its hit back', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      const ip = newIp();
      await sql`insert into auth_rate_limits (bucket, window_start, count)
                values (${`signin-ip-hour:${ip}`}, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 200)`;
      const res = await signInReq(m.email, MEMBER_PASSWORD, ip).expect(429);
      expect(res.body.code).toBe('rate-limited');
      const [account] = await sql<{ count: number }[]>`select count from auth_rate_limits where bucket = ${`signin-account:${emailDigest(m.email)}`}`;
      expect(account!.count).toBe(0);
      // A refused attempt is never counted on the pair.
      expect(await sql`select 1 from signin_attempts where ip = ${ip}`).toHaveLength(0);
    });

    it('an insider on the shared address locks only their own pair: the colleague holding a cookie signs in from that address', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      const nat = newIp();
      const deviceCookie = cookieOf(await signInReq(m.email, MEMBER_PASSWORD, nat).expect(200), DEVICE_COOKIE_NAME)!;
      for (let i = 0; i < 5; i += 1) await signInReq(m.email, 'wrong-password', nat).expect(401);
      await signInReq(m.email, MEMBER_PASSWORD, nat).expect(423);
      await signInReq(m.email, MEMBER_PASSWORD, nat, deviceCookie).expect(200);
    });

    it('a stolen device cookie buys 5 guesses: the 6th is 423 on that cookie; the lock is keyed on the cookie, not the address; a cookie for another email is untrusted', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      const other = await createMember(t, 'operator');
      const deviceCookie = cookieOf(await signInReq(m.email, MEMBER_PASSWORD).expect(200), DEVICE_COOKIE_NAME)!;
      for (let i = 0; i < 5; i += 1) await signInReq(m.email, 'wrong-password', newIp(), deviceCookie).expect(401);
      expect((await signInReq(m.email, MEMBER_PASSWORD, newIp(), deviceCookie).expect(423)).body.code).toBe('sign-in-locked');
      expect(await sql`select 1 from signin_attempts where ip like 'device:%' and locked_until > now()`).not.toHaveLength(0);
      // Without the cookie the account still signs in (the address pairs are untouched).
      await signInReq(m.email, MEMBER_PASSWORD).expect(200);
      // The cookie names m: for `other` it verifies nothing (untrusted path, normal answer).
      await signInReq(other.email, MEMBER_PASSWORD, newIp(), deviceCookie).expect(200);
      // A forged MAC is untrusted too.
      const forged = `${deviceCookie.slice(0, -4)}AAAA`;
      for (let i = 0; i < 5; i += 1) await signInReq(other.email, 'wrong-password', '10.250.250.1', forged).expect(401);
      await signInReq(other.email, MEMBER_PASSWORD, '10.250.250.1', forged).expect(423);
      await sql`delete from signin_attempts where ip = '10.250.250.1'`;
    });

    it('IPv6: one /64 is one key — sign-in failures and Security password failures from two addresses in it add up to one lock', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      const memberToken = (await mintSignIn(app, { email: m.email, password: MEMBER_PASSWORD })).body.accessToken as string;
      const prefix = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:a`;
      for (let i = 0; i < 3; i += 1) await signInReq(m.email, 'wrong-password', `${prefix}::1`).expect(401);
      for (let i = 0; i < 2; i += 1) {
        await http()
          .post(`${API}/${t.tenantId}/me/second-factor/setup`)
          .set('Authorization', `Bearer ${memberToken}`)
          .set('X-Forwarded-For', `${prefix}:0:0:0:ffff`)
          .send({ password: 'wrong-password' })
          .expect(422);
      }
      expect((await signInReq(m.email, MEMBER_PASSWORD, `${prefix}:1234::9`).expect(423)).body.code).toBe('sign-in-locked');
      // The audit reference keeps the FULL address.
      expect(await sql`select reference from audit_events where target_id = ${m.userId} and action = 'user.sign_in_locked'`).toEqual([
        expect.objectContaining({ reference: expect.stringMatching(/^ip:2001:db8:/) }),
      ]);
      expect(await sql`select ip from signin_attempts where ip = ${ipKey(`${prefix}::1`)}`).toHaveLength(1);
      // Another /64 is another key.
      await signInReq(m.email, MEMBER_PASSWORD, `2001:db8:ffff:b::1`).expect(200);
    });

    it('hitRateLimit(windowSeconds): one fixed window per bucket — an hour window starts on the hour and answers the wait to its end', async () => {
      const db = app.get<Database>(DATABASE);
      const bucket = `test-window-${ulid()}`;
      const hit = await hitRateLimit(db, bucket, 1, 3600);
      const [row] = await sql<{ on_hour: boolean }[]>`
        select window_start = to_timestamp(floor(extract(epoch from now()) / 3600) * 3600) as on_hour from auth_rate_limits where bucket = ${bucket}`;
      expect(row!.on_hour).toBe(true);
      expect(hit.bucket).toBe(bucket);
      await expect(hitRateLimit(db, bucket, 1, 3600)).rejects.toMatchObject({ status: 429 });
      // The default stays the one-minute window (6-1a's callers unchanged).
      const minute = `test-minute-${ulid()}`;
      await hitRateLimit(db, minute, 1);
      const [m] = await sql<{ on_minute: boolean }[]>`select window_start = date_trunc('minute', now()) as on_minute from auth_rate_limits where bucket = ${minute}`;
      expect(m!.on_minute).toBe(true);
    });
  });

  // ── storage ────────────────────────────────────────────────────────────────

  describe('storage', () => {
    it('the purge removes tokens expired or spent over a day ago, keeps the rest', async () => {
      const t = await registerTenant();
      const m = await createMember(t, 'operator');
      for (let i = 0; i < 3; i += 1) await requestReset(m.email).expect(202);
      const rows = await resets(t.tenantId, m.userId);
      await sql`update password_resets set created_at = now() - interval '3 days', expires_at = now() - interval '2 days' where id = ${rows[0]!.id}`;
      await sql`update password_resets set consumed_at = now() - interval '2 days' where id = ${rows[1]!.id}`;
      await app.get(SessionPurgeWorker).tick();
      expect((await resets(t.tenantId, m.userId)).map((r) => r.id)).toEqual([rows[2]!.id]);
    });

    it('RLS: the app role sees only its own tenant’s reset tokens (wms_rls_probe)', async () => {
      const a = await registerTenant();
      const b = await registerTenant();
      await requestReset(a.email).expect(202);
      await requestReset(b.email).expect(202);
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
          return tx<{ tenant_id: string }[]>`select distinct tenant_id from password_resets`;
        });
        expect(seen.map((row) => row.tenant_id)).toEqual([a.tenantId]);
        expect((await probe<{ n: number }[]>`select count(*)::int as n from password_resets`)[0]!.n).toBe(0);
      } finally {
        await probe.end();
      }
    });

    it('the CHECKs: code_failures 0..5 and expiry after creation (the migration probes them too)', async () => {
      const defs = await sql<{ conname: string; def: string }[]>`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
         where conname in ('password_resets_code_failures_check', 'password_resets_expiry_check') order by conname`;
      expect(defs.map((d) => d.conname)).toEqual(['password_resets_code_failures_check', 'password_resets_expiry_check']);
    });

    it('the three routes are in the OpenAPI document, unguarded and unkeyed', () => {
      const doc = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8')) as {
        paths: Record<string, Record<string, { parameters?: Array<{ name: string }>; security?: unknown }>>;
      };
      for (const path of ['/tenants/password-reset', '/tenants/password-reset/check', '/tenants/password-reset/confirm']) {
        const post = doc.paths[path]!.post!;
        expect(post).toBeDefined();
        expect((post.parameters ?? []).map((p) => p.name)).not.toContain('Idempotency-Key');
        expect(post.security).toBeUndefined();
      }
    });
  });
});
