import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { AUTH_DATABASE, DATABASE } from '../../src/shared/shared.module';
import type { Database } from '../../src/shared/db/db';
import { clients, tenants, users } from '../../src/shared/db/schema';
import { withTenantTransaction } from '../../src/shared/db/tenant-scope';
import { createSessionInTx } from '../../src/modules/tenancy/sessions';
import { signTenantSession, tenantSessionSecret } from '../../src/modules/tenancy/jwt-session';
import { verifyPassword } from '../../src/modules/tenancy/passwords';
import { issueWebSessionInTx } from '../../src/modules/tenancy/sign-in.command';
import { base32Decode, totpAt, totpStepOf, TOTP_STEP_SECONDS } from '../../src/modules/tenancy/second-factor';

/**
 * Story 6-1b — sessions for the e2e suites.
 *
 * An owner's web sign-in now takes two steps (a code from an authenticator
 * app), and a TOTP step can be used once — so a suite that merely NEEDS a
 * session (it is not testing sign-in) mints one directly: the same
 * `createSessionInTx` + `signTenantSession` the sign-in uses, in the user's
 * tenant transaction (`mintSessionToken`, and `mintSignIn`, which returns the
 * sign-in body). No bypass flag and no clock exist in production code; this
 * is test-only.
 *
 * A suite that tests sign-in ITSELF uses `signInAs`: the real two-step
 * HTTP flow, completed with the exported TOTP (the secret cached per email
 * from the enrolment step), waiting for the next step when the current one
 * is spent.
 */

const API = '/api/v1/tenants';

export type MintedKind = 'web' | 'portal';

/** A real server-side session row and an access token over it (no HTTP, no password, no second factor). */
export async function mintSessionToken(
  app: INestApplication,
  input: { readonly tenantId: string; readonly userId: string; readonly kind: MintedKind; readonly clientId?: string | null },
): Promise<string> {
  const db = app.get<Database>(DATABASE);
  const clientId = input.kind === 'portal' ? (input.clientId ?? null) : null;
  const created = await withTenantTransaction(db, input.tenantId, (tx) =>
    createSessionInTx(tx, { tenantId: input.tenantId, userId: input.userId, kind: input.kind, clientId }),
  );
  return signTenantSession(
    { tenantId: input.tenantId, userId: input.userId, sessionId: created.sessionId, kind: input.kind, clientId },
    tenantSessionSecret(),
  );
}

/**
 * The sign-in BODY for a suite that is not testing sign-in: the account is
 * looked up and its password checked (a mis-set-up fixture still fails), then
 * a session is minted. Shaped like a supertest response (`{status, body}`) so
 * a `….post('/sign-in').send(x).expect(200)` chain is a drop-in swap.
 */
export async function mintSignIn(
  app: INestApplication,
  credentials: { readonly email: string; readonly password: string },
  // The body is as loosely typed as supertest's (`any`), so swapped chains read it unchanged.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: 200; body: any }> {
  const authDb = app.get<Database>(AUTH_DATABASE);
  const db = app.get<Database>(DATABASE);
  const email = credentials.email.trim().toLowerCase();
  const user = (await authDb.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (user === undefined || user.status !== 'active' || !(await verifyPassword(credentials.password, user.passwordHash))) {
    throw new Error(`mintSignIn: ${email} is not an active account with that password`);
  }
  const tenant = (await authDb
    .select({ id: tenants.id, name: tenants.name, gstin: tenants.gstin })
    .from(tenants)
    .where(eq(tenants.id, user.tenantId))
    .limit(1))[0]!;
  const client =
    user.clientId === null
      ? null
      : ((await authDb
          .select({ id: clients.id, code: clients.code, name: clients.name })
          .from(clients)
          .where(eq(clients.id, user.clientId))
          .limit(1))[0] ?? null);
  const issued = await withTenantTransaction(db, user.tenantId, (tx) => issueWebSessionInTx(tx, user, tenant, client));
  // The refresh cookie rides a header on the real route; a minted body never carries it.
  const body: Partial<typeof issued> = { ...issued };
  delete body.refreshCookie;
  return { status: 200, body };
}

// ── the real two-step flow ──────────────────────────────────────────────────

interface Enrolled {
  readonly secret: Buffer;
  /** The last TOTP step this helper spent for the account (each step is usable once). */
  lastStep: number;
  backupCodes: readonly string[];
}

const enrolled = new Map<string, Enrolled>();

/** The authenticator this helper enrolled for the email (throws when none). */
export function enrolledFactorOf(email: string): Enrolled {
  const found = enrolled.get(email.trim().toLowerCase());
  if (found === undefined) throw new Error(`signInAs: no authenticator enrolled for ${email} by this helper`);
  return found;
}

/** Remember an authenticator a test set up some other way (e.g. through Security). */
export function rememberFactor(email: string, secretBase32: string, lastStep = 0, backupCodes: readonly string[] = []): void {
  enrolled.set(email.trim().toLowerCase(), { secret: base32Decode(secretBase32), lastStep, backupCodes });
}

export function forgetFactor(email: string): void {
  enrolled.delete(email.trim().toLowerCase());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The next unspent code for the account: step max(now−1, last+1) — the server
 * accepts t−1…t+1 — and when that is past now+1, wait for the clock to reach
 * it. Records the step as spent.
 */
export async function nextTotpCode(email: string): Promise<{ code: string; step: number }> {
  const factor = enrolledFactorOf(email);
  let now = totpStepOf();
  let step = Math.max(now - 1, factor.lastStep + 1);
  while (step > now + 1) {
    const nextBoundary = (now + 1) * TOTP_STEP_SECONDS * 1000;
    await sleep(Math.max(50, nextBoundary - Date.now() + 50));
    now = totpStepOf();
    step = Math.max(now - 1, factor.lastStep + 1);
  }
  factor.lastStep = step;
  return { code: totpAt(factor.secret, step), step };
}

export interface SignInAsOptions {
  readonly ip?: string;
  readonly enrolmentCode?: string;
  /** Use a backup code (the next unused one this helper holds) instead of a TOTP code. */
  readonly backupCode?: boolean;
}

/**
 * The real web sign-in, both steps: password (with `X-WMS-Second-Factor: 1`),
 * then — when challenged — the enrolment or the code step. Answers the final
 * response (the session, its body and its refresh cookie).
 */
export async function signInAs(
  app: INestApplication,
  email: string,
  password: string,
  options: SignInAsOptions = {},
): Promise<request.Response> {
  const http = () => request(app.getHttpServer());
  const withIp = (req: request.Test) => (options.ip === undefined ? req : req.set('X-Forwarded-For', options.ip));
  const first = await withIp(http().post(`${API}/sign-in`).set('X-WMS-Second-Factor', '1')).send({ email, password });
  if (first.status !== 200 || !Object.hasOwn(first.body as object, 'challenge')) return first;
  const key = email.trim().toLowerCase();
  const body = first.body as { challenge: 'totp' | 'enroll'; challengeToken: string; secret?: string };
  if (body.challenge === 'enroll') {
    const existing = enrolled.get(key);
    // The pending secret is reused for 24 h: keep the spent-step record when it is the same one.
    if (existing === undefined || base32Decode(body.secret!).compare(existing.secret) !== 0) {
      enrolled.set(key, { secret: base32Decode(body.secret!), lastStep: 0, backupCodes: [] });
    }
  }
  let code: string;
  if (options.backupCode === true) {
    const factor = enrolledFactorOf(key);
    code = factor.backupCodes[0]!;
    factor.backupCodes = factor.backupCodes.slice(1);
  } else {
    code = (await nextTotpCode(key)).code;
  }
  const second = await withIp(http().post(`${API}/sign-in/second-factor`)).send({
    challengeToken: body.challengeToken,
    code,
    ...(options.enrolmentCode === undefined ? {} : { enrolmentCode: options.enrolmentCode }),
  });
  if (second.status === 200 && Array.isArray((second.body as { backupCodes?: unknown }).backupCodes)) {
    enrolledFactorOf(key).backupCodes = (second.body as { backupCodes: string[] }).backupCodes;
  }
  return second;
}
