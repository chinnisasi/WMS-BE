import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { SessionPurgeWorker } from '../src/jobs/jobs.module';
import {
  base32Decode,
  base32Encode,
  clearSecondFactorLockInTx,
  generateBackupCodes,
  matchTotp,
  normaliseBackupCode,
  normaliseTotpCode,
  secondFactorRequired,
  SIGN_IN_CHALLENGE_PURPOSES,
  totpAt,
  totpStepOf,
} from '../src/modules/tenancy/second-factor';
import {
  assertSecondFactorKeyConfigured,
  backupCodeHash,
  backupCodeHashCandidates,
  MissingSecondFactorKeyError,
  openSecondFactorSecret,
  sealSecondFactorSecret,
} from '../src/modules/tenancy/second-factor-secrets';
import { PERMANENT_LOCK_INSTANT } from '../src/modules/tenancy/users.command';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { enrolledFactorOf, mintSignIn, nextTotpCode, rememberFactor, signInAs } from './support/sign-in';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.CORS_ORIGIN = 'http://localhost:3001';
process.env.COOKIE_SECURE = 'false';
// One trusted hop, so each test names its own client address.
process.env.TRUSTED_PROXY_HOPS = '1';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const PASSWORD = 'correct-horse-battery';
const MEMBER_PASSWORD = 'team-member-password';
const PROBE_LOCK = 742105;

/**
 * Story 6-1b — owner two-factor sign-in: the RFC 6238 vectors, the sealed
 * secret's associated data and key id, the 0075 vocabulary and probes, RLS,
 * and every row of the spec's I/O matrix over real HTTP.
 */
describe('two-factor sign-in (e2e, story 6-1b)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('second_factor');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
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
  const newIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  async function registerTenant(): Promise<{ tenantId: string; ownerId: string; email: string }> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const res = await http()
      .post(API)
      .set('Idempotency-Key', ulid())
      .send({ name: `2FA ${email}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    return { tenantId: res.body.tenant.id as string, ownerId: res.body.owner.id as string, email };
  }

  /** The password step, as the web sends it. */
  function passwordStep(email: string, password = PASSWORD, ip = newIp()) {
    return http().post(`${API}/sign-in`).set('X-Forwarded-For', ip).set('X-WMS-Second-Factor', '1').send({ email, password });
  }

  function codeStep(challengeToken: string, code: string, ip = newIp(), enrolmentCode?: string) {
    return http()
      .post(`${API}/sign-in/second-factor`)
      .set('X-Forwarded-For', ip)
      .send({ challengeToken, code, ...(enrolmentCode === undefined ? {} : { enrolmentCode }) });
  }

  /** An enrolled owner with a live session (the real two-step flow). */
  async function enrolledOwner(): Promise<{ tenantId: string; ownerId: string; email: string; token: string }> {
    const t = await registerTenant();
    const res = await signInAs(app, t.email, PASSWORD, { ip: newIp() });
    expect(res.status).toBe(200);
    return { ...t, token: res.body.accessToken as string };
  }

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

  /** A staff member who opted in through Security (enrolled with the helper's authenticator). */
  async function optedInMember(ownerToken: string, tenantId: string, role: string): Promise<{ userId: string; email: string; token: string }> {
    const member = await createMember(ownerToken, tenantId, role);
    const token = (await mintSignIn(app, { email: member.email, password: MEMBER_PASSWORD })).body.accessToken as string;
    const setup = await security(tenantId, token, '/setup').send({ password: MEMBER_PASSWORD }).expect(200);
    rememberFactor(member.email, setup.body.secret as string);
    await security(tenantId, token, '/confirm').send({ code: (await nextTotpCode(member.email)).code }).expect(200);
    return { ...member, token };
  }

  /** A 6-digit code that is NOT valid for this secret anywhere near now. */
  function wrongCode(secret: Buffer): string {
    const now = totpStepOf();
    const valid = new Set([-2, -1, 0, 1, 2].map((d) => totpAt(secret, now + d)));
    for (let n = 0; ; n += 1) {
      const candidate = String((123457 + n * 7919) % 1_000_000).padStart(6, '0');
      if (!valid.has(candidate)) return candidate;
    }
  }

  const me = (tenantId: string, token: string) => http().get(`${API}/${tenantId}/me`).set('Authorization', `Bearer ${token}`);
  const security = (tenantId: string, token: string, path = '') =>
    http().post(`${API}/${tenantId}/me/second-factor${path}`).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', newIp());

  async function userRow(userId: string) {
    return (
      await sql<
        { mfa_failures: number; mfa_lock_cycles: number; mfa_failed_since_success: number; mfa_locked_until: string | null; mfa_enabled_at: Date | null; mfa_last_step: string | null }[]
      >`select mfa_failures, mfa_lock_cycles, mfa_failed_since_success, mfa_locked_until::text, mfa_enabled_at, mfa_last_step from users where id = ${userId}`
    )[0]!;
  }

  // ── primitives ────────────────────────────────────────────────────────────

  describe('TOTP, base32 and backup-code primitives', () => {
    it('matches the RFC 6238 Appendix B vectors (SHA-1, SHA-256, SHA-512; 8 digits, 30 s)', () => {
      const sha1 = Buffer.from('12345678901234567890', 'ascii');
      const sha256 = Buffer.from('12345678901234567890123456789012', 'ascii');
      const sha512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii');
      const vectors: Array<[number, string, string, string]> = [
        [59, '94287082', '46119246', '90693936'],
        [1111111109, '07081804', '68084774', '25091201'],
        [1111111111, '14050471', '67062674', '99943326'],
        [1234567890, '89005924', '91819424', '93441116'],
        [2000000000, '69279037', '90698825', '38618901'],
        [20000000000, '65353130', '77737706', '47863826'],
      ];
      for (const [time, a, b, c] of vectors) {
        const step = Math.floor(time / 30);
        expect(totpAt(sha1, step, 8, 'sha1')).toBe(a);
        expect(totpAt(sha256, step, 8, 'sha256')).toBe(b);
        expect(totpAt(sha512, step, 8, 'sha512')).toBe(c);
        // The 6-digit code the app shows is the same truncation, mod 10^6.
        expect(totpAt(sha1, step)).toBe(a.slice(2));
      }
    });

    it('base32 round-trips (RFC 4648 vectors) and a code matches only within t−1…t+1', () => {
      expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
      expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
      expect(base32Decode('mzxw 6ytb-oi').toString()).toBe('foobar');
      const secret = Buffer.from('12345678901234567890');
      const now = 1_000_000;
      for (const d of [-1, 0, 1]) expect(matchTotp(secret, totpAt(secret, now + d), now)).toBe(now + d);
      for (const d of [-2, 2]) expect(matchTotp(secret, totpAt(secret, now + d), now)).toBeNull();
    });

    it('normalises inputs: spaces in a TOTP code; case, hyphens and spaces in a backup code', () => {
      expect(normaliseTotpCode(' 123 456 ')).toBe('123456');
      expect(normaliseTotpCode('12345')).toBeNull();
      expect(normaliseTotpCode('12345a')).toBeNull();
      expect(normaliseBackupCode('abcde-fgh23')).toBe('ABCDEFGH23');
      expect(normaliseBackupCode('ABCDE FGH23')).toBe('ABCDEFGH23');
      expect(normaliseBackupCode('ABCDE-FGH21')).toBeNull(); // 1 is not base32
      const codes = generateBackupCodes();
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    });

    it('owners must use a second factor; every other role may opt in', () => {
      expect(secondFactorRequired('owner')).toBe(true);
      for (const role of ['ops_manager', 'operator', 'accountant', 'client'] as const) expect(secondFactorRequired(role)).toBe(false);
    });
  });

  describe('the sealed secret and the key', () => {
    const saved = { key: process.env.MFA_ENCRYPTION_KEY, previous: process.env.MFA_ENCRYPTION_KEY_PREVIOUS };
    afterEach(() => {
      process.env.MFA_ENCRYPTION_KEY = saved.key;
      if (saved.previous === undefined) delete process.env.MFA_ENCRYPTION_KEY_PREVIOUS;
      else process.env.MFA_ENCRYPTION_KEY_PREVIOUS = saved.previous;
    });

    it('associated data binds a secret to its row: another user or tenant cannot open it', () => {
      const secret = Buffer.from('twenty-byte-secret!!');
      const sealed = sealSecondFactorSecret(secret, 't-1', 'u-1');
      expect(sealed.split(':')).toHaveLength(5);
      expect(openSecondFactorSecret(sealed, 't-1', 'u-1').equals(secret)).toBe(true);
      expect(() => openSecondFactorSecret(sealed, 't-1', 'u-2')).toThrow();
      expect(() => openSecondFactorSecret(sealed, 't-2', 'u-1')).toThrow();
    });

    it('the key id lets MFA_ENCRYPTION_KEY_PREVIOUS open old blobs and match old backup codes while the key rotates', () => {
      const secret = Buffer.from('another-20-byte-key!');
      process.env.MFA_ENCRYPTION_KEY = 'old-key-material-0123456789abcdefghijklmn';
      const sealed = sealSecondFactorSecret(secret, 't', 'u');
      const oldHash = backupCodeHash('u', 'ABCDEFGH23');
      process.env.MFA_ENCRYPTION_KEY = 'new-key-material-0123456789abcdefghijklmn';
      expect(() => openSecondFactorSecret(sealed, 't', 'u')).toThrow(/not configured/);
      expect(backupCodeHashCandidates('u', 'ABCDEFGH23')).not.toContain(oldHash);
      process.env.MFA_ENCRYPTION_KEY_PREVIOUS = 'old-key-material-0123456789abcdefghijklmn';
      expect(openSecondFactorSecret(sealed, 't', 'u').equals(secret)).toBe(true);
      expect(backupCodeHashCandidates('u', 'ABCDEFGH23')).toContain(oldHash);
      // A new seal is under the new key.
      expect(sealSecondFactorSecret(secret, 't', 'u').split(':')[1]).not.toBe(sealed.split(':')[1]);
    });

    it('MFA_ENCRYPTION_KEY unset or short: the boot check refuses (main.ts calls it before the app starts)', () => {
      delete process.env.MFA_ENCRYPTION_KEY;
      expect(() => assertSecondFactorKeyConfigured()).toThrow(MissingSecondFactorKeyError);
      process.env.MFA_ENCRYPTION_KEY = 'too-short';
      expect(() => assertSecondFactorKeyConfigured()).toThrow(MissingSecondFactorKeyError);
      process.env.MFA_ENCRYPTION_KEY = saved.key;
      expect(() => assertSecondFactorKeyConfigured()).not.toThrow();
      // A previous key set but short would be ignored, and every blob it sealed would never open.
      process.env.MFA_ENCRYPTION_KEY_PREVIOUS = 'short-previous';
      expect(() => assertSecondFactorKeyConfigured()).toThrow(/MFA_ENCRYPTION_KEY_PREVIOUS/);
      process.env.MFA_ENCRYPTION_KEY_PREVIOUS = '';
      expect(() => assertSecondFactorKeyConfigured()).not.toThrow();
      const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');
      expect(main.indexOf('assertSecondFactorKeyConfigured()')).toBeGreaterThan(-1);
      expect(main.indexOf('assertSecondFactorKeyConfigured()')).toBeLessThan(main.indexOf('await createApp('));
    });
  });

  // ── the database ──────────────────────────────────────────────────────────

  describe('migration 0075', () => {
    it('the challenge purpose vocabulary matches its CHECK, both ways', async () => {
      const [row] = await sql<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'sign_in_challenges_purpose_check'`;
      const literals = [...row!.def.matchAll(/'([a-z-]+)'::text/g)].map((match) => match[1]).sort();
      expect(literals).toEqual([...SIGN_IN_CHALLENGE_PURPOSES].sort());
    });

    it('the CHECKs refuse what they name (failures past 5, an unknown purpose, a secret without its date, a new revoke reason misspelt)', async () => {
      const t = await registerTenant();
      const refusal = async (statement: () => Promise<unknown>): Promise<string | undefined> => {
        try {
          await statement();
          return undefined;
        } catch (error) {
          return (error as { constraint_name?: string }).constraint_name;
        }
      };
      expect(
        await refusal(() => sql`insert into sign_in_challenges (id, tenant_id, user_id, purpose, secret_hash, failures, ip, expires_at)
          values (gen_random_uuid(), ${t.tenantId}, ${t.ownerId}, 'enroll', 'h', 6, 'ip', now() + interval '1 minute')`),
      ).toBe('sign_in_challenges_failures_check');
      expect(
        await refusal(() => sql`insert into sign_in_challenges (id, tenant_id, user_id, purpose, secret_hash, ip, expires_at)
          values (gen_random_uuid(), ${t.tenantId}, ${t.ownerId}, 'sms', 'h', 'ip', now() + interval '1 minute')`),
      ).toBe('sign_in_challenges_purpose_check');
      expect(await refusal(() => sql`update users set mfa_secret_sealed = 's' where id = ${t.ownerId}`)).toBe('users_mfa_secret_pairing');
      expect(await refusal(() => sql`update users set mfa_failures = -1 where id = ${t.ownerId}`)).toBe('users_mfa_counters_check');
      // An accepted shape (so a CHECK that refused everything would fail here).
      await sql`update users set mfa_failed_since_success = 0 where id = ${t.ownerId}`;
    });

    it('RLS: both new tables and the users writes are tenant-scoped (wms_rls_probe)', async () => {
      const a = await enrolledOwner();
      const b = await enrolledOwner();
      // An open challenge for each.
      await passwordStep(a.email).expect(200);
      await passwordStep(b.email).expect(200);
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
        for (const table of ['sign_in_challenges', 'user_backup_codes']) {
          const seen = await probe.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${a.tenantId}, true)`;
            return tx.unsafe<{ tenant_id: string }[]>(`select distinct tenant_id from ${table}`);
          });
          expect(seen.map((row) => row.tenant_id)).toEqual([a.tenantId]);
          const unscoped = await probe.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
          expect(unscoped[0]!.n).toBe(0);
        }
        // The users writes: the unlock helper scoped to its tenant reaches its row, another tenant's scope reaches none.
        await sql`update users set mfa_lock_cycles = 1 where id = ${b.ownerId}`;
        const scoped = await probe.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${a.tenantId}, true)`;
          return tx`update users set mfa_lock_cycles = 0 where id = ${b.ownerId} returning id`;
        });
        expect(scoped).toHaveLength(0);
        const own = await probe.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${b.tenantId}, true)`;
          return tx`update users set mfa_lock_cycles = 0 where id = ${b.ownerId} returning id`;
        });
        expect(own).toHaveLength(1);
        const unscoped = await probe`update users set mfa_lock_cycles = 0 where id = ${b.ownerId} returning id`;
        expect(unscoped).toHaveLength(0);
      } finally {
        await probe.end();
      }
      // clearSecondFactorLockInTx runs inside the tenant transaction.
      const db = app.get<Database>(DATABASE);
      await sql`update users set mfa_lock_cycles = 2 where id = ${a.ownerId}`;
      expect(await withTenantTransaction(db, a.tenantId, (tx) => clearSecondFactorLockInTx(tx, a.tenantId, a.ownerId))).toBe(1);
      expect((await userRow(a.ownerId)).mfa_lock_cycles).toBe(0);
    });
  });

  // ── the I/O matrix ────────────────────────────────────────────────────────

  describe('sign-in', () => {
    it('owner’s first sign-in: the enrolment step (no code needed), no session until the code; then the session, ten backup codes once, audited', async () => {
      const t = await registerTenant();
      const ip = newIp();
      const first = await passwordStep(t.email, PASSWORD, ip).expect(200);
      expect(Object.keys(first.body).sort()).toEqual(
        ['challenge', 'challengeToken', 'enrolmentCodeRequired', 'expiresInSeconds', 'otpauthUri', 'secret'].sort(),
      );
      expect(first.body).toMatchObject({ challenge: 'enroll', expiresInSeconds: 600, enrolmentCodeRequired: false });
      expect(first.body.otpauthUri).toContain(`otpauth://totp/WMS%20(2FA%20`);
      expect(first.body.otpauthUri).toContain(`secret=${first.body.secret as string}`);
      expect(first.headers['set-cookie']).toBeUndefined();
      // AC: right password only → no session row.
      expect(await sql`select id from sessions where user_id = ${t.ownerId}`).toHaveLength(0);

      const secret = base32Decode(first.body.secret as string);
      const done = await codeStep(first.body.challengeToken as string, totpAt(secret, totpStepOf()), ip).expect(200);
      expect(done.body).toMatchObject({ tokenType: 'Bearer', expiresInSeconds: 900, user: { id: t.ownerId, role: 'owner' } });
      expect(done.body.backupCodes).toHaveLength(10);
      expect(done.body.secondFactorFailedAttempts).toBeUndefined();
      expect((done.headers['set-cookie'] as unknown as string[]).some((line) => line.startsWith('wms_refresh='))).toBe(true);
      expect(await sql`select kind from sessions where user_id = ${t.ownerId}`).toEqual([{ kind: 'web' }]);
      const challengeId = (first.body.challengeToken as string).split('.')[0]!;
      const enabledRef = `challenge:${challengeId}@${ip}`;
      await expectAuditRow({
        tenantId: t.tenantId,
        key: enabledRef,
        action: 'user.second_factor_enabled',
        targetType: 'user',
        targetId: t.ownerId,
        actorUserId: t.ownerId,
      });
      expect((await userRow(t.ownerId)).mfa_enabled_at).not.toBeNull();
    });

    it('an enrolled owner: right password → the code step (no session); right code → the session and cookie', async () => {
      const t = await enrolledOwner();
      const before = await sql`select id from sessions where user_id = ${t.ownerId}`;
      const first = await passwordStep(t.email).expect(200);
      expect(Object.keys(first.body).sort()).toEqual(['challenge', 'challengeToken', 'expiresInSeconds']);
      expect(first.body).toMatchObject({ challenge: 'totp', expiresInSeconds: 300 });
      expect(first.headers['set-cookie']).toBeUndefined();
      expect(await sql`select id from sessions where user_id = ${t.ownerId}`).toHaveLength(before.length);
      const { code } = await nextTotpCode(t.email);
      const done = await codeStep(first.body.challengeToken as string, code).expect(200);
      expect(done.body.backupCodes).toBeUndefined();
      await me(t.tenantId, done.body.accessToken as string).expect(200);
      expect(await sql`select id from sessions where user_id = ${t.ownerId}`).toHaveLength(before.length + 1);
    });

    it('a user who need not use 2FA and has not set it up: the body is byte-identical to 6-1a’s (no header needed)', async () => {
      const t = await enrolledOwner();
      const member = await createMember(t.token, t.tenantId, 'ops_manager');
      const res = await http().post(`${API}/sign-in`).set('X-Forwarded-For', newIp()).send({ email: member.email, password: MEMBER_PASSWORD }).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(
        ['accessToken', 'client', 'expiresInSeconds', 'refreshExpiresInSeconds', 'tenant', 'tokenType', 'user'].sort(),
      );
    });

    it('an old web bundle (no X-WMS-Second-Factor) → 409 client-outdated, nothing written', async () => {
      const t = await registerTenant();
      const res = await http().post(`${API}/sign-in`).set('X-Forwarded-For', newIp()).send({ email: t.email, password: PASSWORD }).expect(409);
      expect(res.body).toMatchObject({ code: 'client-outdated', detail: 'Reload this page to sign in.' });
      expect(await sql`select id from sign_in_challenges where user_id = ${t.ownerId}`).toHaveLength(0);
      expect(await sql`select id from sessions where user_id = ${t.ownerId}`).toHaveLength(0);
      expect((await sql`select mfa_pending_secret_sealed from users where id = ${t.ownerId}`)[0]!.mfa_pending_secret_sealed).toBeNull();
    });

    it('re-sign-in mid-enrolment shows the SAME secret, so the app that scanned the first QR code works', async () => {
      const t = await registerTenant();
      const first = await passwordStep(t.email).expect(200);
      const second = await passwordStep(t.email).expect(200);
      expect(second.body.secret).toBe(first.body.secret);
      expect(second.body.challengeToken).not.toBe(first.body.challengeToken);
      const secret = base32Decode(first.body.secret as string);
      await codeStep(second.body.challengeToken as string, totpAt(secret, totpStepOf())).expect(200);
    });

    it('the same code twice (two tabs): the second is second-factor-invalid — each step is used once', async () => {
      const t = await enrolledOwner();
      const a = await passwordStep(t.email).expect(200);
      const b = await passwordStep(t.email).expect(200);
      const { code } = await nextTotpCode(t.email);
      await codeStep(a.body.challengeToken as string, code).expect(200);
      const reused = await codeStep(b.body.challengeToken as string, code).expect(401);
      expect(reused.body.code).toBe('second-factor-invalid');
    });

    it('concurrent verifies of one challenge: one session; the other challenge-ended', async () => {
      const t = await enrolledOwner();
      const first = await passwordStep(t.email).expect(200);
      const { code } = await nextTotpCode(t.email);
      const before = (await sql`select count(*)::int as n from sessions where user_id = ${t.ownerId}`)[0]!.n as number;
      const results = await Promise.all([
        codeStep(first.body.challengeToken as string, code),
        codeStep(first.body.challengeToken as string, code),
      ]);
      const statuses = results.map((res) => res.status).sort();
      expect(statuses).toEqual([200, 401]);
      expect(results.find((res) => res.status === 401)!.body.code).toBe('challenge-ended');
      expect((await sql`select count(*)::int as n from sessions where user_id = ${t.ownerId}`)[0]!.n).toBe(before + 1);
    });

    it('a wrong code: 401 with attemptsLeft — and the count is ALREADY COMMITTED (counted before the check)', async () => {
      const t = await enrolledOwner();
      const secret = enrolledFactorOf(t.email).secret;
      const first = await passwordStep(t.email).expect(200);
      const wrong = await codeStep(first.body.challengeToken as string, wrongCode(secret)).expect(401);
      expect(wrong.body).toMatchObject({ code: 'second-factor-invalid', attemptsLeft: 4 });
      // Moving the count into the transaction that then refuses would roll it back to 0.
      expect((await userRow(t.ownerId)).mfa_failures).toBe(1);
      const challengeId = (first.body.challengeToken as string).split('.')[0]!;
      expect((await sql`select failures from sign_in_challenges where id = ${challengeId}`)[0]!.failures).toBe(1);
      // An unknown challenge, a tampered secret: challenge-ended, nothing counted.
      const tampered = `${challengeId}.${'x'.repeat(43)}`;
      expect((await codeStep(tampered, '123456').expect(401)).body.code).toBe('challenge-ended');
      expect((await userRow(t.ownerId)).mfa_failures).toBe(1);
    });

    it('5 wrong codes across 3 challenges → the 6th is 423; one user.second_factor_locked row', async () => {
      const t = await enrolledOwner();
      const secret = enrolledFactorOf(t.email).secret;
      const ip = newIp();
      const tokens = [
        (await passwordStep(t.email).expect(200)).body.challengeToken as string,
        (await passwordStep(t.email).expect(200)).body.challengeToken as string,
        (await passwordStep(t.email).expect(200)).body.challengeToken as string,
      ];
      for (const [i, token] of [tokens[0], tokens[0], tokens[1], tokens[1], tokens[2]].entries()) {
        const res = await codeStep(token!, wrongCode(secret), ip).expect(401);
        expect(res.body.code).toBe('second-factor-invalid');
        if (i === 4) expect(res.body.attemptsLeft).toBe(0);
      }
      const locked = await codeStep(tokens[2]!, (await nextTotpCode(t.email)).code, ip).expect(423);
      expect(locked.body).toMatchObject({ code: 'second-factor-locked', retryAfterSeconds: expect.any(Number) });
      expect(locked.body.retryAfterSeconds).toBeGreaterThan(14 * 60);
      const lockRef = `ip:${ip}`;
      await expectAuditRow({
        tenantId: t.tenantId,
        key: lockRef,
        action: 'user.second_factor_locked',
        targetType: 'user',
        targetId: t.ownerId,
        actorUserId: '01900000-0000-7000-8000-000000000000',
      });
      // The list shows the lock (the later of the two locks).
      const list = await http().get(`${API}/${t.tenantId}/users`).set('Authorization', `Bearer ${t.token}`).expect(200);
      const row = (list.body.items as Array<{ id: string; lockedUntil: string | null; secondFactorEnabled: boolean }>).find((item) => item.id === t.ownerId)!;
      expect(row.secondFactorEnabled).toBe(true);
      expect(Date.parse(row.lockedUntil!)).toBeGreaterThan(Date.now() + 14 * 60_000);
    });

    it('the third lock cycle without a success is permanent until an owner Unlock; the next sign-in reports the failed attempts', async () => {
      const t = await enrolledOwner();
      const b = await createMember(t.token, t.tenantId, 'operator');
      await http().patch(`${API}/${t.tenantId}/users/${b.userId}`).set('Authorization', `Bearer ${t.token}`).set('Idempotency-Key', ulid()).send({ role: 'owner' }).expect(200);
      const ownerB = (await mintSignIn(app, { email: b.email, password: MEMBER_PASSWORD })).body.accessToken as string;
      const secret = enrolledFactorOf(t.email).secret;
      // Two cycles already behind it, four wrong codes into the third.
      await sql`update users set mfa_lock_cycles = 2, mfa_failures = 4, mfa_failed_since_success = 6 where id = ${t.ownerId}`;
      const challenge = (await passwordStep(t.email).expect(200)).body.challengeToken as string;
      await codeStep(challenge, wrongCode(secret)).expect(401);
      expect((await userRow(t.ownerId)).mfa_locked_until).toBe('infinity');
      const forever = await codeStep(challenge, (await nextTotpCode(t.email)).code).expect(423);
      expect(forever.body.retryAfterSeconds).toBeNull();
      expect(forever.body.detail).toContain('until an owner unlocks');
      const list = await http().get(`${API}/${t.tenantId}/users`).set('Authorization', `Bearer ${ownerB}`).expect(200);
      expect((list.body.items as Array<{ id: string; lockedUntil: string }>).find((row) => row.id === t.ownerId)!.lockedUntil).toBe(PERMANENT_LOCK_INSTANT);

      await http().post(`${API}/${t.tenantId}/users/${t.ownerId}/unlock`).set('Authorization', `Bearer ${ownerB}`).set('Idempotency-Key', ulid()).expect(200);
      expect(await userRow(t.ownerId)).toMatchObject({ mfa_failures: 0, mfa_lock_cycles: 0, mfa_locked_until: null });
      const again = await signInAs(app, t.email, PASSWORD, { ip: newIp() });
      expect(again.status).toBe(200);
      // 6 before, the 7th that set the hard lock (the refused 423 counted nothing).
      expect(again.body.secondFactorFailedAttempts).toBe(7);
      expect((await userRow(t.ownerId)).mfa_failed_since_success).toBe(0);
    });

    it('a user deactivated during the challenge: verify → challenge-ended, no session', async () => {
      const t = await enrolledOwner();
      const b = await createMember(t.token, t.tenantId, 'ops_manager');
      // B opts in, then signs in to the code step.
      const bToken = (await mintSignIn(app, { email: b.email, password: MEMBER_PASSWORD })).body.accessToken as string;
      const setup = await security(t.tenantId, bToken, '/setup').send({ password: MEMBER_PASSWORD }).expect(200);
      rememberFactor(b.email, setup.body.secret as string);
      await security(t.tenantId, bToken, '/confirm').send({ code: (await nextTotpCode(b.email)).code }).expect(200);
      const challenge = (await passwordStep(b.email, MEMBER_PASSWORD).expect(200)).body.challengeToken as string;
      await http().post(`${API}/${t.tenantId}/users/${b.userId}/deactivate`).set('Authorization', `Bearer ${t.token}`).set('Idempotency-Key', ulid()).expect(200);
      const before = (await sql`select count(*)::int as n from sessions where user_id = ${b.userId} and revoked_at is null`)[0]!.n;
      expect((await codeStep(challenge, (await nextTotpCode(b.email)).code).expect(401)).body.code).toBe('challenge-ended');
      expect((await sql`select count(*)::int as n from sessions where user_id = ${b.userId} and revoked_at is null`)[0]!.n).toBe(before);
    });

    it('a promotion to owner ends a sign-in in progress: the open code step answers challenge-ended, no session', async () => {
      const t = await enrolledOwner();
      const b = await optedInMember(t.token, t.tenantId, 'operator');
      const challenge = (await passwordStep(b.email, MEMBER_PASSWORD).expect(200)).body as { challenge: string; challengeToken: string };
      expect(challenge.challenge).toBe('totp');
      await http().patch(`${API}/${t.tenantId}/users/${b.userId}`).set('Authorization', `Bearer ${t.token}`).set('Idempotency-Key', ulid()).send({ role: 'owner' }).expect(200);
      const before = (await sql`select count(*)::int as n from sessions where user_id = ${b.userId} and revoked_at is null`)[0]!.n;
      expect((await codeStep(challenge.challengeToken, (await nextTotpCode(b.email)).code).expect(401)).body.code).toBe('challenge-ended');
      expect((await sql`select count(*)::int as n from sessions where user_id = ${b.userId} and revoked_at is null`)[0]!.n).toBe(before);
    });

    it('deactivate then reactivate during a challenge: the code step still answers challenge-ended', async () => {
      const t = await enrolledOwner();
      const b = await optedInMember(t.token, t.tenantId, 'ops_manager');
      const challenge = (await passwordStep(b.email, MEMBER_PASSWORD).expect(200)).body.challengeToken as string;
      for (const arm of ['deactivate', 'reactivate']) {
        await http().post(`${API}/${t.tenantId}/users/${b.userId}/${arm}`).set('Authorization', `Bearer ${t.token}`).set('Idempotency-Key', ulid()).expect(200);
      }
      expect((await codeStep(challenge, (await nextTotpCode(b.email)).code).expect(401)).body.code).toBe('challenge-ended');
    });

    it('an undecryptable active secret (the key it was sealed under is gone): 503, nothing counted', async () => {
      const t = await enrolledOwner();
      const saved = process.env.MFA_ENCRYPTION_KEY;
      process.env.MFA_ENCRYPTION_KEY = 'some-other-key-material-0123456789abcdefghij';
      const foreign = sealSecondFactorSecret(Buffer.from('twenty-byte-secret!!'), t.tenantId, t.ownerId);
      process.env.MFA_ENCRYPTION_KEY = saved;
      await sql`update users set mfa_secret_sealed = ${foreign} where id = ${t.ownerId}`;
      const challenge = (await passwordStep(t.email).expect(200)).body.challengeToken as string;
      const res = await codeStep(challenge, '123456').expect(503);
      expect(res.body.code).toBe('second-factor-unavailable');
      expect((await userRow(t.ownerId)).mfa_failures).toBe(0);
      const challengeId = challenge.split('.')[0]!;
      expect((await sql`select failures from sign_in_challenges where id = ${challengeId}`)[0]!.failures).toBe(0);
    });

    it('a reuse caught at commit is a wrong code: as the 5th failure it sets the lock (attemptsLeft 0)', async () => {
      const t = await enrolledOwner();
      // Every code near now is a spent step; four wrong codes already stand.
      await sql`update users set mfa_last_step = ${totpStepOf() + 5}, mfa_failures = 4 where id = ${t.ownerId}`;
      const ip = newIp();
      const challenge = (await passwordStep(t.email).expect(200)).body.challengeToken as string;
      const res = await codeStep(challenge, totpAt(enrolledFactorOf(t.email).secret, totpStepOf()), ip).expect(401);
      expect(res.body).toMatchObject({ code: 'second-factor-invalid', attemptsLeft: 0 });
      expect((await userRow(t.ownerId)).mfa_locked_until).not.toBeNull();
      const lockRef = `ip:${ip}`;
      expect(await sql`select id from audit_events where tenant_id = ${t.tenantId} and reference = ${lockRef} and action = 'user.second_factor_locked'`).toHaveLength(1);
    });

    it('an expired enrolment code is refused at the password step (403 enrolment-code-expired), no challenge, nothing counted', async () => {
      const t = await enrolledOwner();
      const b = await optedInMember(t.token, t.tenantId, 'operator');
      await http().post(`${API}/${t.tenantId}/users/${b.userId}/second-factor/reset`).set('Authorization', `Bearer ${t.token}`).set('Idempotency-Key', ulid()).expect(200);
      await sql`update users set mfa_enrol_code_expires_at = now() - interval '1 minute' where id = ${b.userId}`;
      const before = (await sql`select count(*)::int as n from sign_in_challenges where user_id = ${b.userId}`)[0]!.n;
      const res = await passwordStep(b.email, MEMBER_PASSWORD).expect(403);
      expect(res.body).toMatchObject({ code: 'enrolment-code-expired', detail: 'Ask an owner to reset your two-factor sign-in again.' });
      expect((await sql`select count(*)::int as n from sign_in_challenges where user_id = ${b.userId}`)[0]!.n).toBe(before);
      expect((await userRow(b.userId)).mfa_failures).toBe(0);
    });

    it('a reset of a non-owner: the next sign-in is the enrolment step, and it needs the code', async () => {
      const t = await enrolledOwner();
      const b = await optedInMember(t.token, t.tenantId, 'accountant');
      await sql`update users set mfa_failed_since_success = 5 where id = ${b.userId}`;
      const reset = await http().post(`${API}/${t.tenantId}/users/${b.userId}/second-factor/reset`).set('Authorization', `Bearer ${t.token}`).set('Idempotency-Key', ulid()).expect(200);
      // The reset clears the stale failure count too.
      expect((await userRow(b.userId)).mfa_failed_since_success).toBe(0);
      const list = await http().get(`${API}/${t.tenantId}/users`).set('Authorization', `Bearer ${t.token}`).expect(200);
      expect((list.body.items as Array<{ id: string; secondFactorResetPending?: boolean }>).find((row) => row.id === b.userId)!.secondFactorResetPending).toBe(true);
      const enrol = await passwordStep(b.email, MEMBER_PASSWORD).expect(200);
      expect(enrol.body).toMatchObject({ challenge: 'enroll', enrolmentCodeRequired: true });
      const secret = base32Decode(enrol.body.secret as string);
      const refused = await codeStep(enrol.body.challengeToken as string, totpAt(secret, totpStepOf() - 1)).expect(401);
      expect(refused.body.detail).toContain('The authenticator code or the enrolment code is not right.');
      await codeStep(enrol.body.challengeToken as string, totpAt(secret, totpStepOf()), newIp(), reset.body.enrolmentCode as string).expect(200);
    });

    it('`bun run auth:unlock` clears a permanent two-factor lock and its counters (audited, reference cli)', async () => {
      const t = await enrolledOwner();
      await sql`update users set mfa_locked_until = 'infinity', mfa_lock_cycles = 3, mfa_failures = 2 where id = ${t.ownerId}`;
      const run = spawnSync('bun', ['scripts/auth-unlock.ts', t.email], {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DATABASE_AUTH_URL: process.env.DATABASE_URL },
        encoding: 'utf8',
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('two-factor lock — cleared');
      expect(await userRow(t.ownerId)).toMatchObject({ mfa_failures: 0, mfa_lock_cycles: 0, mfa_locked_until: null });
      await expectAuditRow({ tenantId: t.tenantId, key: 'cli', action: 'user.unlocked', targetType: 'user', targetId: t.ownerId, actorUserId: '01900000-0000-7000-8000-000000000000' });
    });

    it('lost phone: a backup code signs in once (spent, audited); the same code again is refused', async () => {
      const t = await enrolledOwner();
      const factor = enrolledFactorOf(t.email);
      const backup = factor.backupCodes[0]!;
      const first = await passwordStep(t.email).expect(200);
      const done = await codeStep(first.body.challengeToken as string, backup.toLowerCase()).expect(200);
      await me(t.tenantId, done.body.accessToken as string).expect(200);
      const [spent] = await sql<{ id: string }[]>`select id from user_backup_codes where user_id = ${t.ownerId} and used_at is not null`;
      const spentRef = `backup-code:${spent!.id}`;
      await expectAuditRow({
        tenantId: t.tenantId,
        key: spentRef,
        action: 'user.backup_code_used',
        targetType: 'user',
        targetId: t.ownerId,
        actorUserId: t.ownerId,
      });
      const again = await passwordStep(t.email).expect(200);
      expect((await codeStep(again.body.challengeToken as string, backup).expect(401)).body.code).toBe('second-factor-invalid');
      // A backup code is never accepted at enrolment.
      const other = await registerTenant();
      const enrol = await passwordStep(other.email).expect(200);
      expect((await codeStep(enrol.body.challengeToken as string, factor.backupCodes[1]!).expect(401)).body.code).toBe('second-factor-invalid');
    });

    it('an owner badge-in on a handheld is unchanged (decision 4): no second factor', async () => {
      const t = await enrolledOwner();
      const minted = await http().post(`${API}/${t.tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${t.token}`).set('Idempotency-Key', ulid()).send({}).expect(201);
      const enrolled = await http()
        .post(`${API}/${t.tenantId}/devices/enroll`)
        .set('Idempotency-Key', ulid())
        .send({ code: minted.body.code, label: `HH-${ulid().slice(-4)}`, pin: '1357' })
        .expect(201);
      const badged = await http()
        .post(`${API}/${t.tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: t.email, pin: '1357' })
        .expect(200);
      expect(badged.body.accessToken).toEqual(expect.any(String));
    });
  });

  describe('My account → Security', () => {
    it('GET answers the state; an owner cannot turn it off (409 second-factor-required)', async () => {
      const t = await enrolledOwner();
      const status = await http().get(`${API}/${t.tenantId}/me/second-factor`).set('Authorization', `Bearer ${t.token}`).expect(200);
      expect(status.body).toEqual({ enabled: true, enabledAt: expect.any(String), required: true, backupCodesRemaining: 10 });
      expect((await security(t.tenantId, t.token, '/disable').send({ code: '123456' }).expect(409)).body.code).toBe('second-factor-required');
    });

    it('an opt-in user: setup needs the password (wrong → 422, still signed in); confirm → ten codes; regenerate and disable are audited', async () => {
      const t = await enrolledOwner();
      const m = await createMember(t.token, t.tenantId, 'accountant');
      const token = (await mintSignIn(app, { email: m.email, password: MEMBER_PASSWORD })).body.accessToken as string;
      expect((await security(t.tenantId, token, '/setup').send({}).expect(400)).body.code).toBe('validation-failed');
      expect((await security(t.tenantId, token, '/setup').send({ password: 'wrong-password' }).expect(422)).body.code).toBe('password-invalid');
      await me(t.tenantId, token).expect(200);
      const setup = await security(t.tenantId, token, '/setup').send({ password: MEMBER_PASSWORD }).expect(200);
      expect(Object.keys(setup.body).sort()).toEqual(['otpauthUri', 'secret']);
      rememberFactor(m.email, setup.body.secret as string);
      const confirmed = await security(t.tenantId, token, '/confirm').send({ code: (await nextTotpCode(m.email)).code }).expect(200);
      expect(confirmed.body.backupCodes).toHaveLength(10);
      const enabledRow = await sql<{ reference: string }[]>`select reference from audit_events where tenant_id = ${t.tenantId} and target_id = ${m.userId} and action = 'user.second_factor_enabled'`;
      await expectAuditRow({ tenantId: t.tenantId, key: enabledRow[0]!.reference, action: 'user.second_factor_enabled', targetType: 'user', targetId: m.userId, actorUserId: m.userId });

      const regenerated = await security(t.tenantId, token, '/backup-codes').send({ code: (await nextTotpCode(m.email)).code }).expect(200);
      expect(regenerated.body.backupCodes).toHaveLength(10);
      expect(regenerated.body.backupCodes).not.toEqual(confirmed.body.backupCodes);
      const regenRow = await sql<{ reference: string }[]>`select reference from audit_events where tenant_id = ${t.tenantId} and action = 'user.backup_codes_regenerated'`;
      await expectAuditRow({ tenantId: t.tenantId, key: regenRow[0]!.reference, action: 'user.backup_codes_regenerated', targetType: 'user', targetId: m.userId, actorUserId: m.userId });
      // The old set is void.
      const oldCode = confirmed.body.backupCodes[0] as string;
      expect((await security(t.tenantId, token, '/disable').send({ code: oldCode }).expect(422)).body.code).toBe('second-factor-invalid');

      const disabled = await security(t.tenantId, token, '/disable').send({ code: regenerated.body.backupCodes[0] as string }).expect(200);
      expect(disabled.body).toEqual({ enabled: false, enabledAt: null, required: false, backupCodesRemaining: 0 });
      const disRow = await sql<{ reference: string }[]>`select reference from audit_events where tenant_id = ${t.tenantId} and action = 'user.second_factor_disabled'`;
      await expectAuditRow({ tenantId: t.tenantId, key: disRow[0]!.reference, action: 'user.second_factor_disabled', targetType: 'user', targetId: m.userId, actorUserId: m.userId });
      expect(await sql`select id from user_backup_codes where user_id = ${m.userId}`).toHaveLength(0);
    });

    it('a wrong code on Security is 422: still signed in, and it counts toward the lock', async () => {
      const t = await enrolledOwner();
      const res = await security(t.tenantId, t.token, '/backup-codes').send({ code: wrongCode(enrolledFactorOf(t.email).secret) }).expect(422);
      expect(res.body).toMatchObject({ code: 'second-factor-invalid', attemptsLeft: 4 });
      await me(t.tenantId, t.token).expect(200);
      expect((await userRow(t.ownerId)).mfa_failures).toBe(1);
    });

    it('replace the authenticator within one step: accepted (its own sequence); the old one stops working; other sessions end', async () => {
      const t = await enrolledOwner();
      const other = await signInAs(app, t.email, PASSWORD, { ip: newIp() });
      expect(other.status).toBe(200);
      const oldSecret = enrolledFactorOf(t.email).secret;
      const setup = await security(t.tenantId, t.token, '/setup').send({ code: (await nextTotpCode(t.email)).code }).expect(200);
      const newSecret = base32Decode(setup.body.secret as string);
      // Confirm with the CURRENT step of the new secret, right after the old one spent a step.
      await security(t.tenantId, t.token, '/confirm').send({ code: totpAt(newSecret, totpStepOf()) }).expect(200);
      rememberFactor(t.email, setup.body.secret as string, totpStepOf());
      await me(t.tenantId, t.token).expect(200);
      const ended = await me(t.tenantId, other.body.accessToken as string).expect(401);
      expect(ended.body).toMatchObject({ code: 'session-ended', reason: 'second-factor-changed' });
      const challenge = (await passwordStep(t.email).expect(200)).body.challengeToken as string;
      expect((await codeStep(challenge, totpAt(oldSecret, totpStepOf() + 1)).expect(401)).body.code).toBe('second-factor-invalid');
    });

    it('lost phone with backup codes left: Security replaces the authenticator with a backup code', async () => {
      const t = await enrolledOwner();
      const backup = enrolledFactorOf(t.email).backupCodes[2]!;
      const setup = await security(t.tenantId, t.token, '/setup').send({ code: backup }).expect(200);
      expect(setup.body.secret).toEqual(expect.any(String));
      const status = await http().get(`${API}/${t.tenantId}/me/second-factor`).set('Authorization', `Bearer ${t.token}`).expect(200);
      expect(status.body.backupCodesRemaining).toBe(9);
    });
  });

  describe('reset by another owner', () => {
    async function twoOwners() {
      const a = await enrolledOwner();
      const b = await createMember(a.token, a.tenantId, 'operator');
      await http().patch(`${API}/${a.tenantId}/users/${b.userId}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', ulid()).send({ role: 'owner' }).expect(200);
      const bToken = (await mintSignIn(app, { email: b.email, password: MEMBER_PASSWORD })).body.accessToken as string;
      return { a, b: { ...b, token: bToken } };
    }
    const reset = (tenantId: string, token: string, userId: string, key = ulid()) =>
      http().post(`${API}/${tenantId}/users/${userId}/second-factor/reset`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key);

    it('owner B resets A: A’s tab ends (second-factor-reset), B sees the code once, A enrols only with it; an attacker with the password but no code is refused', async () => {
      const { a, b } = await twoOwners();
      const key = ulid();
      const res = await reset(a.tenantId, b.token, a.ownerId, key).expect(200);
      expect(res.body.enrolmentCode).toMatch(/^[A-Z2-9]{8}$/);
      expect(Date.parse(res.body.enrolmentCodeExpiresAt as string)).toBeGreaterThan(Date.now() + 71 * 3600_000);
      await expectAuditRow({ tenantId: a.tenantId, key, action: 'user.second_factor_reset', targetType: 'user', targetId: a.ownerId, actorUserId: b.userId });
      const replay = await reset(a.tenantId, b.token, a.ownerId, key).expect(200);
      expect(replay.body).toEqual(res.body);
      await expectAuditRow({ tenantId: a.tenantId, key, action: 'user.second_factor_reset', targetType: 'user', targetId: a.ownerId, actorUserId: b.userId });
      const ended = await me(a.tenantId, a.token).expect(401);
      expect(ended.body).toMatchObject({ code: 'session-ended', reason: 'second-factor-reset' });
      expect(await sql`select id from user_backup_codes where user_id = ${a.ownerId}`).toHaveLength(0);

      const enrol = await passwordStep(a.email).expect(200);
      expect(enrol.body).toMatchObject({ challenge: 'enroll', enrolmentCodeRequired: true });
      const secret = base32Decode(enrol.body.secret as string);
      // The attacker: the right password and a right authenticator code, but no enrolment code.
      const refused = await codeStep(enrol.body.challengeToken as string, totpAt(secret, totpStepOf() - 1)).expect(401);
      expect(refused.body.code).toBe('second-factor-invalid');
      expect((await userRow(a.ownerId)).mfa_failures).toBe(1);
      const wrongEnrolment = await codeStep(enrol.body.challengeToken as string, totpAt(secret, totpStepOf()), newIp(), 'AAAAAAAA').expect(401);
      expect(wrongEnrolment.body.code).toBe('second-factor-invalid');
      const done = await codeStep(enrol.body.challengeToken as string, totpAt(secret, totpStepOf() + 1), newIp(), (res.body.enrolmentCode as string).toLowerCase()).expect(200);
      expect(done.body.backupCodes).toHaveLength(10);
      expect((await sql`select mfa_enrol_code_hash from users where id = ${a.ownerId}`)[0]!.mfa_enrol_code_hash).toBeNull();
    });

    it('self-reset is 409; a user with nothing to reset is the named no-op (key stored, nothing audited)', async () => {
      const { a, b } = await twoOwners();
      expect((await reset(a.tenantId, a.token, a.ownerId).expect(409)).body.code).toBe('self-reset');
      const op = await createMember(a.token, a.tenantId, 'operator');
      const key = noOpIdempotencyKey(a.tenantId, ulid(), 'users.resetSecondFactor:not-enrolled');
      const res = await reset(a.tenantId, b.token, op.userId, key).expect(200);
      expect(res.body).toEqual({ enrolmentCode: null, enrolmentCodeExpiresAt: null });
      expect(await sql`select id from audit_events where tenant_id = ${a.tenantId} and reference = ${key}`).toHaveLength(0);
      // Authority: an operator cannot reset.
      const opToken = (await mintSignIn(app, { email: op.email, password: MEMBER_PASSWORD })).body.accessToken as string;
      expect((await reset(a.tenantId, opToken, b.userId).expect(403)).body.code).toBe('role-denied');
      expect((await reset(a.tenantId, b.token, '01900000-0000-7000-8000-00000000abcd').expect(404)).body.code).toBe('not-found');
    });

    it('same-key resets parked on the target lock both answer the same body — one reset, one key (the replay under the lock)', async () => {
      const { a, b } = await twoOwners();
      const key = ulid();
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from users where id = ${a.ownerId} for update`) as unknown as { pid: number }[];
          first = (async () => reset(a.tenantId, b.token, a.ownerId, key))();
          second = (async () => reset(a.tenantId, b.token, a.ownerId, key))();
          await waitParked(locked[0]!.pid, 2);
        });
        const [x, y] = await Promise.all([first!, second!]);
        expect(x.status).toBe(200);
        expect(y.status).toBe(200);
        expect(y.body).toEqual(x.body);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
      expect(await sql`select id from idempotency_keys where tenant_id = ${a.tenantId} and key = ${key}`).toHaveLength(1);
      expect(await sql`select id from audit_events where tenant_id = ${a.tenantId} and reference = ${key}`).toHaveLength(1);
    });

    async function waitParked(holderPid: number, min: number): Promise<void> {
      const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active'
              and a.query ilike '%from users%' and a.query ilike '%for update%'
          `) as unknown as { pid: number; blockers: number[] }[];
          const chain = new Set<number>([holderPid]);
          for (let grew = true; grew; ) {
            grew = false;
            for (const row of waiting) {
              if (!chain.has(row.pid) && row.blockers.some((pid) => chain.has(pid))) {
                chain.add(row.pid);
                grew = true;
              }
            }
          }
          if (chain.size - 1 >= min) return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`fewer than ${min} request(s) parked on the users row`);
      } finally {
        await probe.end();
      }
    }

    it('the sole owner lost everything: `bun run auth:reset-2fa <email>` prints the enrolment code (audited, reference cli)', async () => {
      const t = await enrolledOwner();
      const run = spawnSync('bun', ['scripts/auth-reset-2fa.ts', t.email], {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DATABASE_AUTH_URL: process.env.DATABASE_URL },
        encoding: 'utf8',
      });
      expect(run.status).toBe(0);
      const code = /Enrolment code: ([A-Z2-9]{8})/.exec(run.stdout)?.[1];
      expect(code).toBeDefined();
      await expectAuditRow({
        tenantId: t.tenantId,
        key: 'cli',
        action: 'user.second_factor_reset',
        targetType: 'user',
        targetId: t.ownerId,
        actorUserId: '01900000-0000-7000-8000-000000000000',
      });
      const enrol = await passwordStep(t.email).expect(200);
      expect(enrol.body.enrolmentCodeRequired).toBe(true);
      const secret = base32Decode(enrol.body.secret as string);
      await codeStep(enrol.body.challengeToken as string, totpAt(secret, totpStepOf()), newIp(), code).expect(200);
    });
  });

  describe('secrets never leak; purge; contract', () => {
    it('no TOTP secret or backup code in audit rows or idempotency_keys (only the response that issues it)', async () => {
      const t = await registerTenant();
      const first = await passwordStep(t.email).expect(200);
      const secret = first.body.secret as string;
      const done = await codeStep(first.body.challengeToken as string, totpAt(base32Decode(secret), totpStepOf())).expect(200);
      const codes = (done.body.backupCodes as string[]).map((code) => normaliseBackupCode(code)!);
      const audit = await sql<{ text: string }[]>`select row_to_json(a)::text as text from audit_events a where tenant_id = ${t.tenantId}`;
      const keys = await sql<{ text: string }[]>`select row_to_json(k)::text as text from idempotency_keys k where tenant_id = ${t.tenantId}`;
      const users = await sql<{ text: string }[]>`select row_to_json(u)::text as text from users u where id = ${t.ownerId}`;
      for (const { text } of [...audit, ...keys, ...users]) {
        expect(text).not.toContain(secret);
        for (const code of codes) {
          expect(text).not.toContain(code);
          expect(text).not.toContain(`${code.slice(0, 5)}-${code.slice(5)}`);
        }
      }
      // A later status read carries no secret.
      const status = await http().get(`${API}/${t.tenantId}/me/second-factor`).set('Authorization', `Bearer ${done.body.accessToken as string}`).expect(200);
      expect(JSON.stringify(status.body)).not.toContain(secret);
    });

    it('the purge deletes challenges expired over a day ago and pending secrets older than 24 h — and keeps live ones', async () => {
      const t = await registerTenant();
      const live = await passwordStep(t.email).expect(200);
      const liveId = (live.body.challengeToken as string).split('.')[0]!;
      await sql`insert into sign_in_challenges (id, tenant_id, user_id, purpose, secret_hash, ip, created_at, expires_at)
                values (gen_random_uuid(), ${t.tenantId}, ${t.ownerId}, 'enroll', 'h', 'ip', now() - interval '3 days', now() - interval '2 days')`;
      const other = await registerTenant();
      await passwordStep(other.email).expect(200);
      await sql`update users set mfa_pending_created_at = now() - interval '25 hours' where id = ${other.ownerId}`;
      await app.get(SessionPurgeWorker).tick();
      expect((await sql`select id from sign_in_challenges where user_id = ${t.ownerId}`).map((row) => row.id)).toEqual([liveId]);
      expect((await sql`select mfa_pending_secret_sealed from users where id = ${other.ownerId}`)[0]!.mfa_pending_secret_sealed).toBeNull();
      expect((await sql`select mfa_pending_secret_sealed from users where id = ${t.ownerId}`)[0]!.mfa_pending_secret_sealed).not.toBeNull();
    });

    it('the OpenAPI document lists every new route, and sign-in answers a oneOf of the three bodies', () => {
      const doc = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8')) as {
        paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: { oneOf?: Array<{ $ref: string }> } }> }> }>>;
      };
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([
          '/tenants/sign-in/second-factor',
          '/tenants/{tenantId}/me/second-factor',
          '/tenants/{tenantId}/me/second-factor/setup',
          '/tenants/{tenantId}/me/second-factor/confirm',
          '/tenants/{tenantId}/me/second-factor/backup-codes',
          '/tenants/{tenantId}/me/second-factor/disable',
          '/tenants/{tenantId}/users/{userId}/second-factor/reset',
        ]),
      );
      const oneOf = doc.paths['/tenants/sign-in']!.post!.responses['200']!.content!['application/json']!.schema.oneOf!;
      expect(oneOf.map((entry) => entry.$ref)).toEqual([
        '#/components/schemas/SignInResponse',
        '#/components/schemas/TotpChallengeResponse',
        '#/components/schemas/EnrollChallengeResponse',
      ]);
    });
  });
});
