import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AUTH_DATABASE, DATABASE } from '../../shared/shared.module';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Database } from '../../shared/db/db';
import { tenants, users } from '../../shared/db/schema';
import type { UserRole, UserStatus } from '../../shared/db/schema';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { SESSION_TTL_SECONDS, signTenantSession, tenantSessionSecret } from './jwt-session';
import type { TenantTx } from '../../shared/db/tenant-scope';
import {
  base32Encode,
  clientOutdated,
  createChallengeInTx,
  enrolmentCodeExpired,
  ENROLL_CHALLENGE_SECONDS,
  otpauthUri,
  pendingSecretInTx,
  secondFactorRequired,
  TOTP_CHALLENGE_SECONDS,
} from './second-factor';
import {
  SIGNIN_LIMIT_PER_IP_PER_MINUTE,
  clearSignInAttempts,
  countSignInAttempt,
  hitRateLimit,
  settleSignInFailure,
  signInLocked,
} from './auth-attempts';
import { auditSecurityEventInTx, createSessionInTx, refreshCookieValue } from './sessions';
import { DUMMY_HASH, verifyPassword } from './passwords';
import { clientInactive, readSessionClientIn } from '../clients/clients.facade';

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  /** Story 6-1a — the caller's address (`clientIpOf`): the lockout and attempt-limit key. */
  readonly ip: string;
  /**
   * Story 6-1b — the caller sent `X-WMS-Second-Factor: 1` (a web build that
   * can complete the second step). When a challenge would be issued and it
   * did not, the answer is 409 `client-outdated` and nothing is written — an
   * open tab with an old bundle never writes a broken session.
   */
  readonly secondFactorCapable?: boolean;
}

/** Story 6-1a's sign-in body, unchanged, plus the cookie value the controller sets. */
export interface IssuedWebSession {
  accessToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
  refreshExpiresInSeconds: number;
  /** Story 6-1a — the refresh cookie's value (`<sid>.<secret>`); the controller sets it, the body never carries it. */
  refreshCookie: string;
  tenant: { id: string; name: string; gstin: string | null };
  user: SignInUser;
  client: SignInClient | null;
}

/** Story 6-1b — an enrolled user's second step: a code from the authenticator app. */
export interface TotpChallenge {
  readonly challenge: 'totp';
  readonly challengeToken: string;
  readonly expiresInSeconds: number;
}

/** Story 6-1b — an owner who has not enrolled yet: set up the authenticator, then the code. */
export interface EnrollChallenge {
  readonly challenge: 'enroll';
  readonly challengeToken: string;
  readonly expiresInSeconds: number;
  /** The base32 secret (the QR code's fallback). Reused for 24 h across challenges. */
  readonly secret: string;
  readonly otpauthUri: string;
  /** An owner reset this user's 2FA: the one-time enrolment code is needed too. */
  readonly enrolmentCodeRequired: boolean;
}

export type SignInOutcome = IssuedWebSession | TotpChallenge | EnrollChallenge;

/**
 * Story 6-1b — the session creation extracted from sign-in (6-1a): the
 * server-side session row, written in the CALLER's tenant transaction (the
 * second-factor step issues it in the same transaction that consumes its
 * challenge), and the access token over it. The body is byte-identical to
 * 6-1a's sign-in response.
 */
export async function issueWebSessionInTx(
  tx: TenantTx,
  user: {
    readonly id: string;
    readonly tenantId: string;
    readonly email: string;
    readonly role: UserRole;
    readonly status: string;
    readonly clientId: string | null;
    readonly createdAt: string;
  },
  tenant: { readonly id: string; readonly name: string; readonly gstin: string | null },
  client: SignInClient | null,
): Promise<IssuedWebSession> {
  const kind = user.clientId === null ? 'web' : 'portal';
  const created = await createSessionInTx(tx, { tenantId: user.tenantId, userId: user.id, kind, clientId: user.clientId });
  const accessTtl = Math.min(SESSION_TTL_SECONDS, created.absoluteInSeconds);
  return {
    accessToken: signTenantSession(
      {
        tenantId: user.tenantId,
        userId: user.id,
        sessionId: created.sessionId,
        kind,
        clientId: user.clientId,
        ttlSeconds: accessTtl,
      },
      tenantSessionSecret(),
    ),
    tokenType: 'Bearer',
    expiresInSeconds: accessTtl,
    refreshExpiresInSeconds: created.absoluteInSeconds,
    refreshCookie: refreshCookieValue(created.sessionId, created.refreshSecret!),
    tenant: { id: tenant.id, name: tenant.name, gstin: tenant.gstin },
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status as UserStatus,
      clientId: user.clientId,
      createdAt: user.createdAt,
    },
    client,
  };
}

/** The signed-in user's shape in the sign-in response (Story 1.5). */
export interface SignInUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  /** Story 21-7 — the portal user's client; null for the tenant's own staff. */
  readonly clientId: string | null;
  readonly createdAt: string;
}

/** Story 21-7 — the portal user's client, for the portal shell's header. */
export interface SignInClient {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/**
 * Minimal sign-in (spec decision): verifies the password and issues a
 * short-lived HS256 session token carrying `sub` + `tenant_id`. No refresh;
 * the token stays transport-only with **no role claim** — authority is
 * re-read from the DB at every command service entry (Story 1.5). Not a state
 * change, so no idempotency key applies.
 *
 * The email lookup is cross-tenant by nature (the caller has no tenant scope
 * yet), so it reads through the AUTH_DATABASE connection — a BYPASSRLS role
 * (review loop 1 decision); the fail-closed RLS policies would hide every row
 * from the scoped app role. The auth connection is read-only here and never
 * sees tenant-scoped query paths.
 *
 * Story 1.5: the response carries `user {id, email, role, status}` (the FE
 * session needs the role for surface gating — reads only; the command-path
 * authority is the DB read), and an `invited` user is rejected with 403
 * `invite-pending` until they accept their invite and set a password.
 */
@Injectable()
export class SignInCommand {
  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async execute(command: SignInInput): Promise<SignInOutcome> {
    const email = command.email.trim().toLowerCase();
    // Story 6-1a — the attempt limit, then this attempt is COUNTED before the
    // password is checked (own committed statement; a lock answers 423 for
    // any password, real or unknown email alike).
    await hitRateLimit(this.db, `signin-ip:${command.ip}`, SIGNIN_LIMIT_PER_IP_PER_MINUTE);
    const counted = await countSignInAttempt(this.db, email, command.ip);
    const userRows = await this.authDb
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const user = userRows[0];
    if (counted.locked) {
      if (counted.newlyLocked && user !== undefined) await this.auditLock(user, command.ip);
      throw signInLocked(counted.retryAfterSeconds);
    }
    if (user?.status === 'invited') {
      // An invited user has no password yet (a DUMMY_HASH sentinel that no
      // credential verifies) — the 403 invite-pending must fire for ANY
      // password, but still pay one scrypt round against the sentinel so the
      // rejection is time-indistinguishable from the 401 paths (no
      // enumeration of pending invites via timing).
      await verifyPassword(command.password, DUMMY_HASH);
      // Code review — not a guess at a password (an invitee has none): this
      // refusal never counts toward the lock.
      await clearSignInAttempts(this.db, email, command.ip);
      throw new ProblemException(
        'invite-pending',
        403,
        'Invitation not yet accepted',
        'This account is still pending — accept the invitation and set a password first.',
      );
    }
    // Always pay one scrypt round — unknown email vs wrong password must be
    // indistinguishable in body *and* in time (no enumeration).
    const ok = await verifyPassword(command.password, user?.passwordHash ?? DUMMY_HASH);
    // Story 6-1a — a deactivated user answers exactly like a wrong password.
    if (user === undefined || !ok || user.status !== 'active') {
      const locked = await settleSignInFailure(this.db, email, command.ip);
      if (locked && user !== undefined) await this.auditLock(user, command.ip);
      // One message for unknown email and wrong password — no enumeration.
      throw new ProblemException(
        'unauthenticated',
        401,
        'Authentication required',
        'Unknown email or wrong password.',
      );
    }
    const tenantRows = await this.authDb
      .select({ id: tenants.id, name: tenants.name, gstin: tenants.gstin })
      .from(tenants)
      .where(eq(tenants.id, user.tenantId))
      .limit(1);
    const tenant = tenantRows[0]!;

    // Story 21-7 — a client-portal user: its client must be `active`.
    // Checked AFTER the password (a wrong password stays the one 401, so a
    // suspension is disclosed only to a holder of the credential), read by
    // tenant AND id. The token then carries `client_id` — the fence's claim.
    let client: SignInClient | null = null;
    if (user.clientId !== null) {
      const facts = await readSessionClientIn(this.authDb, user.tenantId, user.clientId);
      if (facts === null || facts.status !== 'active') {
        // The password was right: a suspension is not a failed attempt.
        // Story 1-2a — a departed client answers `client-departed`.
        await clearSignInAttempts(this.db, email, command.ip);
        throw clientInactive(facts?.status ?? null);
      }
      client = { id: facts.id, code: facts.code, name: facts.name };
    }
    await clearSignInAttempts(this.db, email, command.ip);

    // Story 6-1b — the branch (sign-in is unchanged up to here). A staff
    // user who has enrolled gets the code step; an owner who has not gets
    // the enrolment step; both before any session exists. Everyone else —
    // and every portal user (decision 4: the portal is untouched) — gets the
    // 6-1a body, byte-identical.
    // Spec amendment 2026-10-18: any staff user holding a reset's enrolment
    // code meets the enrolment step too, owner or not.
    if (
      user.clientId === null &&
      (user.mfaEnabledAt !== null || secondFactorRequired(user.role) || user.mfaEnrolCodeHash !== null)
    ) {
      if (command.secondFactorCapable !== true) throw clientOutdated();
      return withTenantTransaction(this.db, user.tenantId, (tx) =>
        issueChallengeInTx(tx, { ...user, mfaEnabledAt: user.mfaEnabledAt }, tenant, command.ip),
      );
    }

    // Story 6-1a — the server-side session, written in the user's tenant
    // transaction (RLS); its id rides the access token as `sid`.
    return withTenantTransaction(this.db, user.tenantId, (tx) => issueWebSessionInTx(tx, user, tenant, client));
  }

  /** Code review (C11) — the lock is audited once, when it is set, against the account (the system acted). */
  private async auditLock(user: { id: string; tenantId: string }, ip: string): Promise<void> {
    await withTenantTransaction(this.db, user.tenantId, (tx) =>
      auditSecurityEventInTx(tx, {
        tenantId: user.tenantId,
        action: 'user.sign_in_locked',
        targetType: 'user',
        targetId: user.id,
        actorUserId: null,
        reference: `ip:${ip}`,
      }),
    );
  }
}

/**
 * Story 6-1b — the challenge arm of sign-in, in the user's tenant
 * transaction: no session row, no cookie. An enrolled user gets a `totp`
 * challenge recording the factor it was issued against; an owner not yet
 * enrolled gets an `enroll` challenge and the pending secret (reused for
 * 24 h, under the user row's lock, so a second challenge shows the same QR
 * code).
 */
async function issueChallengeInTx(
  tx: TenantTx,
  user: { readonly id: string; readonly tenantId: string; readonly email: string; readonly mfaEnabledAt: string | null },
  tenant: { readonly name: string },
  ip: string,
): Promise<TotpChallenge | EnrollChallenge> {
  const locked = (await tx.execute(sql`
    select mfa_enabled_at::text as enabled_at, (mfa_enrol_code_hash is not null) as enrol_code_required,
           (mfa_enrol_code_hash is not null and mfa_enrol_code_expires_at <= now()) as enrol_code_expired
      from users where tenant_id = ${user.tenantId} and id = ${user.id} for update
  `)) as unknown as Array<{ enabled_at: string | null; enrol_code_required: boolean; enrol_code_expired: boolean }>;
  const row = locked[0]!;
  // Spec amendment 2026-10-18 — an expired enrolment code is answered here,
  // before any challenge exists (nothing counted): a fresh reset is needed.
  if (row.enabled_at === null && row.enrol_code_expired) throw enrolmentCodeExpired();
  if (row.enabled_at !== null) {
    const challengeToken = await createChallengeInTx(tx, {
      tenantId: user.tenantId,
      userId: user.id,
      purpose: 'totp',
      enabledAtSeen: row.enabled_at,
      ip,
    });
    return { challenge: 'totp', challengeToken, expiresInSeconds: TOTP_CHALLENGE_SECONDS };
  }
  const secret = base32Encode(await pendingSecretInTx(tx, user.tenantId, user.id, { reuse: true }));
  const challengeToken = await createChallengeInTx(tx, {
    tenantId: user.tenantId,
    userId: user.id,
    purpose: 'enroll',
    enabledAtSeen: null,
    ip,
  });
  return {
    challenge: 'enroll',
    challengeToken,
    expiresInSeconds: ENROLL_CHALLENGE_SECONDS,
    secret,
    otpauthUri: otpauthUri(secret, user.email, tenant.name),
    enrolmentCodeRequired: row.enrol_code_required,
  };
}
