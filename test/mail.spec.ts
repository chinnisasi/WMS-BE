import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { EmailSenderWorker } from '../src/jobs/jobs.module';
import { MailFacade, cancelUserEmailsInTx } from '../src/modules/mail/mail.facade';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { MailSender } from '../src/modules/mail/mail.sender';
import {
  EMAIL_GATEWAY,
  type EmailGateway,
  type EmailSendResult,
  type LogEmailGateway,
  type OutgoingEmail,
} from '../src/modules/mail/email.gateway';
import { EMAIL_STATUSES, EMAIL_TEMPLATES } from '../src/modules/mail/mail-rules';
import { assertMailConfigured } from '../src/modules/mail/mail.config';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { mintSignIn } from './support/sign-in';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.EMAIL_SEND_POLL_MS;
delete process.env.EMAIL_ALLOWLIST_DOMAINS;
delete process.env.EMAIL_REPLY_TO;
delete process.env.EMAIL_MAX_PER_TICK;
// Story 5-1a — this suite runs the `log` provider (the tests' environment):
// every message is captured in memory and nothing leaves the process.
process.env.EMAIL_PROVIDER = 'log';
process.env.EMAIL_FROM = 'no-reply@mail.wms.test';
process.env.WEB_BASE_URL = 'https://app.wms.test/';
process.env.EMAIL_SEAL_KEY = 'e2e-only-email-seal-key-0123456789abcdef';
delete process.env.EMAIL_SEAL_KEY_PREVIOUS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const INVITEE_PASSWORD = 'invitee-password-123';

jest.setTimeout(180_000);

interface Tenant {
  tenantId: string;
  ownerId: string;
  ownerEmail: string;
  ownerToken: string;
  name: string;
}

interface MessageRow {
  id: string;
  user_id: string | null;
  template: string;
  to_email: string;
  params: Record<string, unknown>;
  sealed_secret: string | null;
  status: string;
  attempts: number;
  provider_message_id: string | null;
  error_code: string | null;
  backoff_s: number;
}

/** A scripted gateway: answers each send with `answer(email)` and records every call. */
class ScriptedGateway implements EmailGateway {
  readonly mode = 'ses' as const;
  readonly calls: OutgoingEmail[] = [];
  constructor(private readonly answer: (email: OutgoingEmail, call: number) => EmailSendResult) {}
  async send(email: OutgoingEmail): Promise<EmailSendResult> {
    this.calls.push(email);
    return this.answer(email, this.calls.length);
  }
}

/**
 * Story 5-1a — the email queue end to end, under `EMAIL_PROVIDER=log`: the
 * invite / reactivate / resend wiring (one row per committed command, none
 * on a replay or a rollback), the sealed token and its wipe, the sender's
 * whole lifecycle against scripted gateways (transient, config, permanent,
 * suppressed, stale, unknown outcome, expiry, purge), the allowlist and the
 * `off` provider, template injection through a real tenant name, the users
 * list's owner-only `inviteEmail`, the vocabularies against the 0089 CHECKs,
 * RLS, and the worker's plumbing.
 */
describe('email service and invite emails (e2e, story 5-1a)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;
  let captured: LogEmailGateway;
  let mail: MailFacade;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('mail');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    captured = app.get<LogEmailGateway>(EMAIL_GATEWAY);
    mail = app.get(MailFacade);
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

  const http = () => request(app.getHttpServer());

  async function setupTenant(name = `Mail Co ${ulid()}`): Promise<Tenant> {
    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name, ownerEmail, password: PASSWORD })
      .expect(201);
    const signedIn = await mintSignIn(app, { email: ownerEmail, password: PASSWORD });
    return {
      tenantId: registered.body.tenant.id as string,
      ownerId: registered.body.owner.id as string,
      ownerEmail,
      ownerToken: signedIn.body.accessToken as string,
      name: registered.body.tenant.name as string,
    };
  }

  function invite(t: Tenant, body: Record<string, unknown>, key = ulid(), token = t.ownerToken) {
    return http().post(`${API}/${t.tenantId}/users`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function userAction(t: Tenant, userId: string, action: 'deactivate' | 'reactivate' | 'resend-invite', key = ulid(), token = t.ownerToken) {
    return http().post(`${API}/${t.tenantId}/users/${userId}/${action}`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key);
  }

  function accept(t: Tenant, token: string) {
    return http().post(`${API}/${t.tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token, password: INVITEE_PASSWORD });
  }

  async function messages(tenantId: string): Promise<MessageRow[]> {
    return (await sql`
      select id, user_id, template, to_email, params, sealed_secret, status, attempts, provider_message_id, error_code,
             extract(epoch from (next_attempt_at - now()))::float8 as backoff_s
      from email_messages where tenant_id = ${tenantId} order by created_at, id
    `) as unknown as MessageRow[];
  }

  function senderWith(gateway: EmailGateway): MailSender {
    return new MailSender(app.get<Database>(DATABASE), gateway);
  }

  async function makeDue(id: string): Promise<void> {
    await sql`update email_messages set next_attempt_at = now() where id = ${id}`;
  }

  async function withEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await run();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  const capturedFor = (to: string) => captured.captured.filter((email) => email.to === to);
  const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;

  // ── the invite, end to end ─────────────────────────────────────────────────

  describe('invite (EMAIL_PROVIDER=log)', () => {
    it('queues ONE sealed pending row in the invite transaction; the sender captures a mail with the tenant, role and a working link; the row is sent with the provider id and NO token after', async () => {
      const t = await setupTenant();
      const email = `a-${ulid().toLowerCase()}@x.in`;
      const key = ulid();
      const res = await invite(t, { email, role: 'operator' }, key).expect(201);
      const userId = res.body.user.id as string;

      // The response: the backend's own accept link (WEB_BASE_URL, normalised) and the queued status.
      expect(res.body.inviteUrl).toBe(
        `https://app.wms.test/accept-invite?tenant=${t.tenantId}&token=${encodeURIComponent(res.body.inviteToken as string)}`,
      );
      expect(res.body.inviteEmail).toEqual({ status: 'pending' });

      const [queued, ...rest] = await messages(t.tenantId);
      expect(rest).toHaveLength(0);
      expect(queued).toMatchObject({ user_id: userId, template: 'user-invite', to_email: email, status: 'pending', attempts: 0 });
      expect(queued!.sealed_secret).toMatch(/^v1:[0-9a-f]{8}:/);
      // No token anywhere but the sealed column: not in the params, not in the outbox.
      expect(JSON.stringify(queued!.params)).not.toContain(res.body.inviteToken);
      expect(queued!.sealed_secret).not.toContain(res.body.inviteToken);
      expect(queued!.params).toEqual({
        tenantName: t.name,
        inviterEmail: t.ownerEmail,
        role: 'operator',
        clientName: null,
        expiresAt: res.body.inviteExpiresAt,
      });
      const outbox = await sql`select payload::text as p from outbox_messages where tenant_id = ${t.tenantId}`;
      expect(outbox.some((row) => (row.p as string).includes(res.body.inviteToken as string))).toBe(false);

      // A replay of the same key: the cached response, NO second row.
      const replay = await invite(t, { email, role: 'operator' }, key).expect(201);
      expect(replay.body).toEqual(res.body);
      expect(await messages(t.tenantId)).toHaveLength(1);

      // The sender sends it.
      const summary = await mail.sendDue(t.tenantId);
      expect(summary).toMatchObject({ claimed: 1, attempted: 1, sent: 1, failed: 0 });
      const [mailed] = capturedFor(email);
      expect(mailed).toBeDefined();
      expect(mailed!.subject).toBe(`${t.name} has invited you to WMS`);
      expect(mailed!.fromName).toBe(`${t.name} via WMS`);
      expect(mailed!.replyTo).toBe(t.ownerEmail);
      expect(mailed!.text).toContain(`${t.ownerEmail} has invited you to join ${t.name} on WMS as an Operator.`);
      // The emailed link IS the response's link.
      expect(mailed!.text).toContain(res.body.inviteUrl as string);
      const [sent] = await messages(t.tenantId);
      expect(sent).toMatchObject({ status: 'sent', provider_message_id: `log-${queued!.id}`, sealed_secret: null, attempts: 1, error_code: null });

      // The emailed link works.
      const link = /https:\/\/app\.wms\.test\/accept-invite\?\S+/.exec(mailed!.text)![0];
      await accept(t, tokenOf(link)).expect(200);

      // A second pass sends nothing more.
      expect(await mail.sendDue(t.tenantId)).toMatchObject({ claimed: 0, attempted: 0 });
      expect(capturedFor(email)).toHaveLength(1);
    });

    it('a rolled-back invite queues nothing (the email exists → 409, no row)', async () => {
      const t = await setupTenant();
      await invite(t, { email: t.ownerEmail, role: 'operator' }).expect(409);
      expect(await messages(t.tenantId)).toHaveLength(0);
    });

    it('EMAIL_PROVIDER=off: the invite works exactly as before (link shown), and the row is `skipped` with no secret', async () => {
      const t = await setupTenant();
      const res = await withEnv({ EMAIL_PROVIDER: 'off' }, () => invite(t, { email: `off-${ulid().toLowerCase()}@x.in`, role: 'accountant' }).expect(201));
      expect(typeof res.body.inviteToken).toBe('string');
      expect(res.body.inviteUrl).toContain('/accept-invite?tenant=');
      expect(res.body.inviteEmail).toEqual({ status: 'skipped' });
      const [row] = await messages(t.tenantId);
      expect(row).toMatchObject({ status: 'skipped', error_code: 'provider-off', sealed_secret: null });
      await accept(t, res.body.inviteToken as string).expect(200);
    });

    it('with no WEB_BASE_URL (provider off), inviteUrl is null — the web builds the link itself', async () => {
      const t = await setupTenant();
      const res = await withEnv({ EMAIL_PROVIDER: 'off', WEB_BASE_URL: undefined }, () =>
        invite(t, { email: `nourl-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201),
      );
      expect(res.body.inviteUrl).toBeNull();
      expect(res.body.inviteEmail).toEqual({ status: 'skipped' });
    });

    it('the allowlist: an address outside it is `skipped` at queue time; one that falls outside before the send is skipped by the sender', async () => {
      const t = await setupTenant();
      const outside = `o-${ulid().toLowerCase()}@x.in`;
      const inside = `i-${ulid().toLowerCase()}@allowed.test`;
      await withEnv({ EMAIL_ALLOWLIST_DOMAINS: 'allowed.test' }, async () => {
        expect((await invite(t, { email: outside, role: 'operator' }).expect(201)).body.inviteEmail).toEqual({ status: 'skipped' });
        expect((await invite(t, { email: inside, role: 'operator' }).expect(201)).body.inviteEmail).toEqual({ status: 'pending' });
      });
      const rows = await messages(t.tenantId);
      expect(rows.map((r) => [r.to_email, r.status, r.error_code, r.sealed_secret === null])).toEqual([
        [outside, 'skipped', 'allowlist', true],
        [inside, 'pending', null, false],
      ]);
      const summary = await withEnv({ EMAIL_ALLOWLIST_DOMAINS: 'elsewhere.test' }, () => mail.sendDue(t.tenantId));
      expect(summary).toMatchObject({ claimed: 1, skipped: 1, attempted: 0 });
      expect((await messages(t.tenantId))[1]).toMatchObject({ status: 'skipped', error_code: 'allowlist', sealed_secret: null });
      expect(capturedFor(inside)).toHaveLength(0);
    });

    it('template injection through a real tenant name: escaped in the HTML, the subject has no CR or LF', async () => {
      const t = await setupTenant(`Evil <a href=x>\r\nBcc: victim@x.in ${ulid()}`);
      const email = `inj-${ulid().toLowerCase()}@x.in`;
      await invite(t, { email, role: 'operator' }).expect(201);
      await mail.sendDue(t.tenantId);
      const [mailed] = capturedFor(email);
      expect(mailed!.subject).not.toMatch(/[\r\n]/);
      expect(mailed!.fromName).not.toMatch(/[\r\n]/);
      expect(mailed!.html).not.toContain('<a href=x>');
      expect(mailed!.html).toContain('&lt;a href=x&gt;');
    });

    it('a portal invite names the client brand (LockedClientFacts.name, read in the invite transaction)', async () => {
      const t = await setupTenant();
      const client = await http()
        .post(`${API}/${t.tenantId}/clients`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: `BR${ulid().slice(-6)}`, name: 'Brand A Apparel' })
        .expect(201);
      const email = `portal-${ulid().toLowerCase()}@brand.test`;
      await invite(t, { email, role: 'client', clientId: client.body.client.id }).expect(201);
      expect((await messages(t.tenantId))[0]!.params).toMatchObject({ role: 'client', clientName: 'Brand A Apparel' });
      await mail.sendDue(t.tenantId);
      expect(capturedFor(email)[0]!.subject).toBe(`${t.name} has invited you to the Brand A Apparel portal`);
    });
  });

  // ── the sender's lifecycle (scripted gateways) ─────────────────────────────

  describe('the sender', () => {
    async function oneQueued(): Promise<{ t: Tenant; row: MessageRow; email: string }> {
      const t = await setupTenant();
      const email = `s-${ulid().toLowerCase()}@x.in`;
      await invite(t, { email, role: 'operator' }).expect(201);
      return { t, row: (await messages(t.tenantId))[0]!, email };
    }

    it('transient (throttling): retried with backoff min(2^(n−1)·30 s, 30 min); sent on a later attempt', async () => {
      const { t, row } = await oneQueued();
      const gateway = new ScriptedGateway((_e, call) => (call === 1 ? { ok: false, code: 'TooManyRequestsException' } : { ok: true, providerMessageId: 'ses-2' }));
      const sender = senderWith(gateway);
      expect(await sender.sendDue(t.tenantId)).toMatchObject({ attempted: 1, retried: 1 });
      const [retrying] = await messages(t.tenantId);
      expect(retrying).toMatchObject({ status: 'pending', attempts: 1, error_code: 'TooManyRequestsException' });
      expect(retrying!.sealed_secret).not.toBeNull();
      expect(retrying!.backoff_s).toBeGreaterThan(25);
      expect(retrying!.backoff_s).toBeLessThanOrEqual(30);
      // Not due yet: nothing is sent.
      expect(await sender.sendDue(t.tenantId)).toMatchObject({ claimed: 0 });
      await makeDue(row.id);
      expect(await sender.sendDue(t.tenantId)).toMatchObject({ sent: 1 });
      expect((await messages(t.tenantId))[0]).toMatchObject({ status: 'sent', provider_message_id: 'ses-2', attempts: 2, sealed_secret: null });
    });

    it('transient five times: the fifth failure is final — failed with the code, the secret wiped', async () => {
      const { t, row } = await oneQueued();
      const sender = senderWith(new ScriptedGateway(() => ({ ok: false, code: 'http-503' })));
      const backoffs: number[] = [];
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await makeDue(row.id);
        await sender.sendDue(t.tenantId);
        const [current] = await messages(t.tenantId);
        if (attempt < 5) backoffs.push(Math.round(current!.backoff_s / 30));
        else expect(current).toMatchObject({ status: 'failed', attempts: 5, error_code: 'http-503', sealed_secret: null });
      }
      // 30 s, 60 s, 120 s, 240 s — in units of 30 s.
      expect(backoffs).toEqual([1, 2, 4, 8]);
    });

    it('config (sending paused): stays pending, spends NO attempt, reported for the once-per-tick log; past 24 h it expires, wiped', async () => {
      const { t, row } = await oneQueued();
      const sender = senderWith(new ScriptedGateway(() => ({ ok: false, code: 'SendingPausedException' })));
      for (let pass = 0; pass < 3; pass += 1) {
        await makeDue(row.id);
        const summary = await sender.sendDue(t.tenantId);
        expect(summary.configCodes).toEqual(['SendingPausedException']);
      }
      const [waiting] = await messages(t.tenantId);
      expect(waiting).toMatchObject({ status: 'pending', attempts: 0, error_code: 'SendingPausedException' });
      expect(waiting!.backoff_s).toBeGreaterThan(50);
      await sql`update email_messages set created_at = now() - interval '25 hours' where id = ${row.id}`;
      expect(await sender.sendDue(t.tenantId)).toMatchObject({ expired: 1, claimed: 0 });
      expect((await messages(t.tenantId))[0]).toMatchObject({ status: 'expired', error_code: 'expired', sealed_secret: null });
    });

    it('a suppressed address: failed `suppressed`; a permanent rejection: failed with its code', async () => {
      const { t } = await oneQueued();
      await senderWith(new ScriptedGateway(() => ({ ok: false, code: 'suppressed' }))).sendDue(t.tenantId);
      expect((await messages(t.tenantId))[0]).toMatchObject({ status: 'failed', error_code: 'suppressed', sealed_secret: null, attempts: 1 });
      const second = await oneQueued();
      await senderWith(new ScriptedGateway(() => ({ ok: false, code: 'MessageRejected' }))).sendDue(second.t.tenantId);
      expect((await messages(second.t.tenantId))[0]).toMatchObject({ status: 'failed', error_code: 'MessageRejected', sealed_secret: null });
    });

    it('stale: a `sending` row past 10 minutes (the worker died mid-send) is failed `stale` and NEVER re-sent; a timeout counts as stale', async () => {
      const { t, row } = await oneQueued();
      await sql`update email_messages set status = 'sending', updated_at = now() - interval '11 minutes' where id = ${row.id}`;
      const gateway = new ScriptedGateway(() => ({ ok: true, providerMessageId: 'never' }));
      expect(await senderWith(gateway).sendDue(t.tenantId)).toMatchObject({ stale: 1, claimed: 0 });
      expect(gateway.calls).toHaveLength(0);
      expect((await messages(t.tenantId))[0]).toMatchObject({ status: 'failed', error_code: 'stale', sealed_secret: null });

      // A `sending` row inside the bound is left alone.
      const fresh = await oneQueued();
      await sql`update email_messages set status = 'sending', updated_at = now() - interval '9 minutes' where id = ${fresh.row.id}`;
      expect(await senderWith(gateway).sendDue(fresh.t.tenantId)).toMatchObject({ stale: 0, claimed: 0 });
      expect((await messages(fresh.t.tenantId))[0]!.status).toBe('sending');

      const timedOut = await oneQueued();
      await senderWith(new ScriptedGateway(() => ({ ok: false, code: 'timeout' }))).sendDue(timedOut.t.tenantId);
      expect((await messages(timedOut.t.tenantId))[0]).toMatchObject({ status: 'failed', error_code: 'stale', sealed_secret: null });
    });

    it('the claim commits `sending` before the provider call (a concurrent sender skips it)', async () => {
      const { t, row } = await oneQueued();
      let seen: string | undefined;
      const gateway = new ScriptedGateway(() => ({ ok: true, providerMessageId: 'x' }));
      const probing: EmailGateway = {
        mode: 'ses',
        send: async (email) => {
          seen = ((await sql`select status from email_messages where id = ${row.id}`)[0] as { status: string }).status;
          // A second sender, mid-send, finds nothing to claim.
          expect(await senderWith(gateway).sendDue(t.tenantId)).toMatchObject({ claimed: 0 });
          return gateway.send(email);
        },
      };
      await senderWith(probing).sendDue(t.tenantId);
      expect(seen).toBe('sending');
      expect(gateway.calls).toHaveLength(1);
    });

    it('a cancel during the send stands (the outcome touches only rows still `sending`)', async () => {
      const { t, row } = await oneQueued();
      const cancelling: EmailGateway = {
        mode: 'ses',
        send: async () => {
          await sql`update email_messages set status = 'cancelled', sealed_secret = null, error_code = 'deactivated' where id = ${row.id}`;
          return { ok: true, providerMessageId: 'late' };
        },
      };
      await senderWith(cancelling).sendDue(t.tenantId);
      expect((await messages(t.tenantId))[0]).toMatchObject({ status: 'cancelled', provider_message_id: null });
    });

    it('a sealed secret copied to another row does not open there (AAD = tenant:message) — failed `unsealable`, never sent', async () => {
      const { t, row } = await oneQueued();
      await invite(t, { email: `second-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      const [, other] = await messages(t.tenantId);
      await sql`update email_messages set sealed_secret = ${row.sealed_secret} where id = ${other!.id}`;
      await sql`update email_messages set next_attempt_at = now() + interval '1 hour' where id = ${row.id}`;
      const gateway = new ScriptedGateway(() => ({ ok: true, providerMessageId: 'x' }));
      await senderWith(gateway).sendDue(t.tenantId);
      expect(gateway.calls).toHaveLength(0);
      expect((await messages(t.tenantId))[1]).toMatchObject({ status: 'failed', error_code: 'unsealable', sealed_secret: null });
    });

    it('the per-call limit bounds the sends; the 90-day purge removes old final rows only', async () => {
      const t = await setupTenant();
      for (let i = 0; i < 3; i += 1) await invite(t, { email: `l${i}-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      const gateway = new ScriptedGateway(() => ({ ok: true, providerMessageId: 'x' }));
      expect(await senderWith(gateway).sendDue(t.tenantId, 2)).toMatchObject({ claimed: 2, sent: 2 });
      expect(await senderWith(gateway).sendDue(t.tenantId, 0)).toMatchObject({ claimed: 0 });
      const rows = await messages(t.tenantId);
      await sql`update email_messages set updated_at = now() - interval '91 days' where id = ${rows[0]!.id}`;
      await sql`update email_messages set updated_at = now() - interval '89 days' where id = ${rows[1]!.id}`;
      // The pending one is never purged, however old.
      await sql`update email_messages set updated_at = now() - interval '91 days', next_attempt_at = now() + interval '1 hour' where id = ${rows[2]!.id}`;
      expect(await senderWith(gateway).sendDue(t.tenantId, 0)).toMatchObject({ purged: 1 });
      expect((await messages(t.tenantId)).map((r) => r.id)).toEqual([rows[1]!.id, rows[2]!.id]);
    });

    it('the worker: drives every tenant with work (an idle tenant with only an old final row too), within EMAIL_MAX_PER_TICK', async () => {
      const busy = await setupTenant();
      await invite(busy, { email: `w-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      const idle = await setupTenant();
      await invite(idle, { email: `i-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      await mail.sendDue(idle.tenantId);
      await sql`update email_messages set updated_at = now() - interval '91 days' where tenant_id = ${idle.tenantId}`;
      const worker = new EmailSenderWorker(app.get(AUTH_DATABASE) as never, mail);
      // Earlier tests leave due rows in other tenants: a budget wide enough for all of them.
      const driven = await withEnv({ EMAIL_MAX_PER_TICK: '1000' }, () => worker.tick());
      expect(driven).toEqual(expect.arrayContaining([busy.tenantId, idle.tenantId]));
      expect((await messages(busy.tenantId))[0]!.status).toBe('sent');
      expect(await messages(idle.tenantId)).toHaveLength(0);
    });
  });

  // ── resend, reactivate, deactivate ─────────────────────────────────────────

  describe('resend, reactivate and deactivate', () => {
    it('resend: a fresh token (the old link dies), the old row cancelled `superseded`, a new pending row, audited; a replay changes nothing', async () => {
      const t = await setupTenant();
      const email = `r-${ulid().toLowerCase()}@x.in`;
      const first = await invite(t, { email, role: 'ops_manager' }).expect(201);
      const userId = first.body.user.id as string;

      const key = ulid();
      const resent = await userAction(t, userId, 'resend-invite', key).expect(200);
      expect(resent.body.user).toMatchObject({ id: userId, status: 'invited', role: 'ops_manager' });
      expect(resent.body.inviteToken).not.toBe(first.body.inviteToken);
      expect(resent.body.inviteUrl).toBe(
        `https://app.wms.test/accept-invite?tenant=${t.tenantId}&token=${encodeURIComponent(resent.body.inviteToken as string)}`,
      );
      expect(resent.body.inviteEmail).toEqual({ status: 'pending' });
      expect(Date.parse(resent.body.inviteExpiresAt as string)).toBeGreaterThanOrEqual(Date.parse(first.body.inviteExpiresAt as string));
      await expectAuditRow({ tenantId: t.tenantId, key, action: 'user.invite_resent', targetType: 'user', targetId: userId, actorUserId: t.ownerId });

      const rows = await messages(t.tenantId);
      expect(rows.map((r) => [r.status, r.error_code, r.sealed_secret === null])).toEqual([
        ['cancelled', 'superseded', true],
        ['pending', null, false],
      ]);

      // Replay: the same body, no third row, still one audit row.
      expect((await userAction(t, userId, 'resend-invite', key).expect(200)).body).toEqual(resent.body);
      expect(await messages(t.tenantId)).toHaveLength(2);
      await expectAuditRow({ tenantId: t.tenantId, key, action: 'user.invite_resent', targetType: 'user', targetId: userId, actorUserId: t.ownerId });

      // The old link is dead; the new one works (from the email itself).
      await accept(t, first.body.inviteToken as string).expect(400);
      await mail.sendDue(t.tenantId);
      const mailed = capturedFor(email);
      expect(mailed).toHaveLength(1); // the superseded row was never sent
      expect(mailed[0]!.text).toContain(resent.body.inviteUrl as string);
      await accept(t, resent.body.inviteToken as string).expect(200);

      // Now active: a resend is refused.
      const refused = await userAction(t, userId, 'resend-invite').expect(409);
      expect(refused.body.code).toBe('user-not-invited');
    });

    it('resend guards: owner-only (users.invite), 404 for an unknown user, 400 for a malformed id, 422 for a key from another arm', async () => {
      const t = await setupTenant();
      const opEmail = `op-${ulid().toLowerCase()}@x.in`;
      const op = await invite(t, { email: opEmail, role: 'ops_manager' }).expect(201);
      await accept(t, op.body.inviteToken as string).expect(200);
      const opToken = (await mintSignIn(app, { email: opEmail, password: INVITEE_PASSWORD })).body.accessToken as string;
      const pending = await invite(t, { email: `p-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      const pendingId = pending.body.user.id as string;

      expect((await userAction(t, pendingId, 'resend-invite', ulid(), opToken).expect(403)).body.code).toBe('role-denied');
      expect((await userAction(t, uuidv7(), 'resend-invite').expect(404)).body.code).toBe('not-found');
      expect((await userAction(t, 'not-a-uuid', 'resend-invite').expect(400)).body.code).toBe('validation-failed');
      const key = ulid();
      await userAction(t, pendingId, 'deactivate', key).expect(200);
      expect((await userAction(t, pendingId, 'resend-invite', key).expect(422)).body.code).toBe('idempotency-key-reuse');
      // Deactivated: not an open invitation.
      expect((await userAction(t, pendingId, 'resend-invite').expect(409)).body.code).toBe('user-not-invited');
    });

    it('deactivating an invited user cancels its pending mail (wiped); reactivating queues a new one and answers its link', async () => {
      const t = await setupTenant();
      const email = `d-${ulid().toLowerCase()}@x.in`;
      const invited = await invite(t, { email, role: 'operator' }).expect(201);
      const userId = invited.body.user.id as string;
      await userAction(t, userId, 'deactivate').expect(200);
      expect((await messages(t.tenantId))[0]).toMatchObject({ status: 'cancelled', error_code: 'deactivated', sealed_secret: null });

      const back = await userAction(t, userId, 'reactivate').expect(200);
      expect(back.body.inviteEmail).toEqual({ status: 'pending' });
      expect(back.body.inviteUrl).toContain(encodeURIComponent(back.body.inviteToken as string));
      const rows = await messages(t.tenantId);
      expect(rows.map((r) => r.status)).toEqual(['cancelled', 'pending']);
      await mail.sendDue(t.tenantId);
      expect(capturedFor(email)).toHaveLength(1);
      expect(capturedFor(email)[0]!.text).toContain(back.body.inviteUrl as string);

      // An active user's deactivate / reactivate carries no invite fields.
      const active = await userAction(t, t.ownerId, 'reactivate', noOpIdempotencyKey(t.tenantId, ulid(), 'users.reactivate:not-deactivated')).expect(200);
      expect(active.body).not.toHaveProperty('inviteUrl');
      expect(active.body).not.toHaveProperty('inviteEmail');
    });

    it('a stored pre-5-1a invite snapshot replays with inviteEmail null and a derived inviteUrl', async () => {
      const t = await setupTenant();
      const key = ulid();
      const res = await invite(t, { email: `old-${ulid().toLowerCase()}@x.in`, role: 'operator' }, key).expect(201);
      await sql`update idempotency_keys set response_snapshot = response_snapshot - 'inviteEmail' where tenant_id = ${t.tenantId} and key = ${key}`;
      const replay = await invite(t, { email: res.body.user.email, role: 'operator' }, key).expect(201);
      expect(replay.body.inviteEmail).toBeNull();
      expect(replay.body.inviteUrl).toBe(res.body.inviteUrl);
    });
  });

  // ── the users list ─────────────────────────────────────────────────────────

  describe('the users list', () => {
    it('an owner sees each invited user’s latest invite email {status, updatedAt}; other rows null; a non-owner sees no field at all', async () => {
      const t = await setupTenant();
      const opEmail = `lop-${ulid().toLowerCase()}@x.in`;
      const op = await invite(t, { email: opEmail, role: 'ops_manager' }).expect(201);
      await accept(t, op.body.inviteToken as string).expect(200);
      const pending = await invite(t, { email: `lp-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      const pendingId = pending.body.user.id as string;
      await userAction(t, pendingId, 'resend-invite').expect(200);
      await mail.sendDue(t.tenantId);

      const list = await http().get(`${API}/${t.tenantId}/users`).set('Authorization', `Bearer ${t.ownerToken}`).expect(200);
      const byId = new Map((list.body.items as { id: string; inviteEmail?: unknown }[]).map((u) => [u.id, u]));
      expect(byId.get(pendingId)!.inviteEmail).toEqual({ status: 'sent', updatedAt: expect.stringMatching(/Z$/) });
      expect(byId.get(op.body.user.id as string)!.inviteEmail).toBeNull();
      expect(byId.get(t.ownerId)!.inviteEmail).toBeNull();

      const opToken = (await mintSignIn(app, { email: opEmail, password: INVITEE_PASSWORD })).body.accessToken as string;
      const asOp = await http().get(`${API}/${t.tenantId}/users`).set('Authorization', `Bearer ${opToken}`).expect(200);
      for (const item of asOp.body.items as Record<string, unknown>[]) expect(item).not.toHaveProperty('inviteEmail');
    });
  });

  // ── code review additions ─────────────────────────────────────────────────

  describe('code review additions', () => {
    async function createClient(t: Tenant, name: string): Promise<string> {
      return (
        await http()
          .post(`${API}/${t.tenantId}/clients`)
          .set('Authorization', `Bearer ${t.ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: `BR${ulid().slice(-6)}`, name })
          .expect(201)
      ).body.client.id as string;
    }

    async function setClientStatus(t: Tenant, clientId: string, status: 'active' | 'suspended'): Promise<void> {
      await http()
        .patch(`${API}/${t.tenantId}/clients/${clientId}/status`)
        .set('Authorization', `Bearer ${t.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ status })
        .expect(200);
    }

    it('accepting the invite cancels its still-queued email (`accepted`) — the dead link is never sent', async () => {
      const t = await setupTenant();
      const email = `acc-${ulid().toLowerCase()}@x.in`;
      const res = await invite(t, { email, role: 'operator' }).expect(201);
      await accept(t, res.body.inviteToken as string).expect(200);
      expect(await mail.sendDue(t.tenantId)).toMatchObject({ attempted: 0, sent: 0 });
      expect((await messages(t.tenantId))[0]).toMatchObject({ status: 'cancelled', error_code: 'accepted', sealed_secret: null });
      expect(capturedFor(email)).toHaveLength(0);
    });

    it('a row cancelled after the claim, before its turn in the batch, is never sent and stays cancelled', async () => {
      const t = await setupTenant();
      const first = await invite(t, { email: `b1-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      const second = await invite(t, { email: `b2-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      const secondUserId = second.body.user.id as string;
      const gateway = new ScriptedGateway((_email, call) => ({ ok: true, providerMessageId: `ses-${call}` }));
      const cancelling: EmailGateway = {
        mode: 'ses',
        send: async (email) => {
          if (gateway.calls.length === 0) {
            await withTenantTransaction(app.get<Database>(DATABASE), t.tenantId, (tx) =>
              cancelUserEmailsInTx(tx, t.tenantId, secondUserId, 'user-invite', 'deactivated'),
            );
          }
          return gateway.send(email);
        },
      };
      const summary = await senderWith(cancelling).sendDue(t.tenantId);
      expect(summary).toMatchObject({ claimed: 2, attempted: 1, sent: 1 });
      expect(gateway.calls.map((e) => e.to)).toEqual([first.body.user.email]);
      const rows = await messages(t.tenantId);
      expect(rows.map((r) => [r.user_id, r.status, r.error_code])).toEqual([
        [first.body.user.id, 'sent', null],
        [secondUserId, 'cancelled', 'deactivated'],
      ]);
    });

    it('the worker with EMAIL_MAX_PER_TICK=1 and two tenants with due rows: exactly one sent, both tenants still swept; the walk rotates so a backlog starves no one', async () => {
      const worker = new EmailSenderWorker(app.get(AUTH_DATABASE) as never, mail);
      // Drain what earlier tests left due, so only the two tenants below have work.
      await withEnv({ EMAIL_MAX_PER_TICK: '1000' }, () => worker.tick());
      // `a` registers first, so it sorts first (uuidv7) — and it has a backlog of two.
      const a = await setupTenant();
      const b = await setupTenant();
      await invite(a, { email: `ta1-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      await invite(a, { email: `ta2-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      await invite(b, { email: `tb-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      const sentIn = async (t: Tenant) => (await messages(t.tenantId)).filter((r) => r.status === 'sent').length;

      const driven = await withEnv({ EMAIL_MAX_PER_TICK: '1' }, () => worker.tick());
      expect(driven).toEqual(expect.arrayContaining([a.tenantId, b.tenantId]));
      expect((await sentIn(a)) + (await sentIn(b))).toBe(1);

      // The next tick starts one tenant later: whichever went first, each has now had one send
      // (a fixed tenant_id order would have sent `a`'s backlog twice and starved `b`).
      await withEnv({ EMAIL_MAX_PER_TICK: '1' }, () => worker.tick());
      expect([await sentIn(a), await sentIn(b)]).toEqual([1, 1]);
    });

    it('the worker finds a tenant whose only row has been `sending` for 11 minutes, and fails it `stale`', async () => {
      const t = await setupTenant();
      await invite(t, { email: `st-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      await sql`update email_messages set status = 'sending', updated_at = now() - interval '11 minutes' where tenant_id = ${t.tenantId}`;
      const worker = new EmailSenderWorker(app.get(AUTH_DATABASE) as never, mail);
      expect(await withEnv({ EMAIL_MAX_PER_TICK: '1000' }, () => worker.tick())).toContain(t.tenantId);
      expect((await messages(t.tenantId))[0]).toMatchObject({ status: 'failed', error_code: 'stale', sealed_secret: null });
    });

    it('resend for a portal user whose client is suspended → 409 client-not-active, no new row', async () => {
      const t = await setupTenant();
      const clientId = await createClient(t, 'Brand S Apparel');
      const invited = await invite(t, { email: `ps-${ulid().toLowerCase()}@brand.test`, role: 'client', clientId }).expect(201);
      await setClientStatus(t, clientId, 'suspended');
      const refused = await userAction(t, invited.body.user.id as string, 'resend-invite').expect(409);
      expect(refused.body.code).toBe('client-not-active');
      expect(await messages(t.tenantId)).toHaveLength(1);
    });

    it('reactivating a never-accepted portal invitee whose client is suspended → 409 client-not-active, nothing changes', async () => {
      const t = await setupTenant();
      const clientId = await createClient(t, 'Brand R Apparel');
      const invited = await invite(t, { email: `pr-${ulid().toLowerCase()}@brand.test`, role: 'client', clientId }).expect(201);
      const userId = invited.body.user.id as string;
      await userAction(t, userId, 'deactivate').expect(200);
      await setClientStatus(t, clientId, 'suspended');
      expect((await userAction(t, userId, 'reactivate').expect(409)).body.code).toBe('client-not-active');
      const [user] = await sql`select status from users where id = ${userId}`;
      expect(user!.status).toBe('deactivated');
      expect((await messages(t.tenantId)).map((r) => r.status)).toEqual(['cancelled']);
      // Active again: the reactivation goes through and queues a new email.
      await setClientStatus(t, clientId, 'active');
      expect((await userAction(t, userId, 'reactivate').expect(200)).body.inviteEmail).toEqual({ status: 'pending' });
    });

    it('resend for a portal user of an active client: the queued params and the captured subject name the client', async () => {
      const t = await setupTenant();
      const clientId = await createClient(t, 'Brand Q Apparel');
      const email = `pq-${ulid().toLowerCase()}@brand.test`;
      const invited = await invite(t, { email, role: 'client', clientId }).expect(201);
      await userAction(t, invited.body.user.id as string, 'resend-invite').expect(200);
      const rows = await messages(t.tenantId);
      expect(rows[1]!.params).toMatchObject({ role: 'client', clientName: 'Brand Q Apparel' });
      await mail.sendDue(t.tenantId);
      const mailed = capturedFor(email);
      expect(mailed).toHaveLength(1);
      expect(mailed[0]!.subject).toBe(`${t.name} has invited you to the Brand Q Apparel portal`);
    });

    it('a row sealed under the old key is sent with a working link after EMAIL_SEAL_KEY rotates (old key in _PREVIOUS)', async () => {
      const t = await setupTenant();
      const email = `rot-${ulid().toLowerCase()}@x.in`;
      const oldKey = process.env.EMAIL_SEAL_KEY!;
      await invite(t, { email, role: 'operator' }).expect(201);
      await withEnv({ EMAIL_SEAL_KEY: 'e2e-only-rotated-email-seal-key-abcdef0123456789', EMAIL_SEAL_KEY_PREVIOUS: oldKey }, () =>
        mail.sendDue(t.tenantId),
      );
      expect((await messages(t.tenantId))[0]).toMatchObject({ status: 'sent', sealed_secret: null });
      const link = /https:\/\/app\.wms\.test\/accept-invite\?\S+/.exec(capturedFor(email)[0]!.text)![0];
      await accept(t, tokenOf(link)).expect(200);
    });
  });

  // ── vocabularies, RLS, boot ────────────────────────────────────────────────

  describe('the schema and the boot', () => {
    it('the TS vocabularies equal the 0089 CHECKs', async () => {
      const defs = (await sql`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'email_messages'::regclass and contype = 'c'
      `) as unknown as { conname: string; def: string }[];
      const listed = (name: string) => [...defs.find((d) => d.conname === name)!.def.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(listed('email_messages_status_check')).toEqual([...EMAIL_STATUSES]);
      expect(listed('email_messages_template_check')).toEqual([...EMAIL_TEMPLATES]);
      expect(listed('email_messages_secret_wipe_check')).toEqual(['pending', 'sending']);
    });

    it('RLS: email_messages is invisible across tenants and unscoped (wms_rls_probe)', async () => {
      const t = await setupTenant();
      await invite(t, { email: `rls-${ulid().toLowerCase()}@x.in`, role: 'operator' }).expect(201);
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        expect(await rls`select 1 from email_messages where tenant_id = ${t.tenantId}`).toHaveLength(0);
        const foreign = await rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
          return tx`select 1 from email_messages where tenant_id = ${t.tenantId}`;
        });
        expect(foreign).toHaveLength(0);
        const own = await rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${t.tenantId}, true)`;
          return tx`select 1 from email_messages where tenant_id = ${t.tenantId}`;
        });
        expect(own).toHaveLength(1);
      } finally {
        await rls.end();
      }
    });

    it('the boot check: ses without EMAIL_FROM refuses to boot, naming it', () => {
      expect(() => assertMailConfigured({ EMAIL_PROVIDER: 'ses', WEB_BASE_URL: 'https://app.wms.test' })).toThrow(/EMAIL_FROM/);
      expect(() => assertMailConfigured({ EMAIL_PROVIDER: 'ses', EMAIL_FROM: 'no-reply@wms.test' })).toThrow(/WEB_BASE_URL/);
      expect(assertMailConfigured({}).provider).toBe('off');
    });
  });
});
