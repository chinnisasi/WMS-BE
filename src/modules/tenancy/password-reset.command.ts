import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AUTH_DATABASE, DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { cancelEmailMessagesInTx, cancelUserEmailsInTx, queueEmailInTx } from '../mail/mail.facade';
import { readSessionClientIn, shareLockClientInTx } from '../clients/clients.facade';
import {
  emailDigest,
  hitRateLimit,
  ipKey,
  ONE_DAY_SECONDS,
  ONE_HOUR_SECONDS,
  RESET_CODE_LIMIT_PER_USER_PER_DAY,
  RESET_LIMIT_PER_IP_PER_MINUTE,
  RESET_REQUEST_LIMIT_PER_IP_PER_HOUR,
} from './auth-attempts';
import { hashPassword } from './passwords';
import { auditSecurityEventInTx, hashSecret, newSecret, revokeSessionsInTx } from './sessions';
import { clearOpenChallengesInTx, verifySecondFactorInput, withCommittedFactor } from './second-factor';
import {
  locateResetIn,
  MAX_LIVE_RESETS,
  MAX_RESET_MAILS_PER_HOUR,
  parseResetToken,
  resetLinkInvalid,
  resetTokenOf,
  RESET_TOKEN_SECONDS,
  secondFactorNeeded,
  spendOpenResetsInTx,
  type LocatedReset,
} from './password-reset';

/** The one body `POST /tenants/password-reset` answers, for every email. */
export const RESET_REQUESTED_MESSAGE =
  "If an account exists for that email, we've sent a link to reset its password. It expires in 60 minutes.";

export interface ResetCheck {
  readonly email: string;
  readonly expiresAt: string;
  readonly secondFactorRequired: boolean;
}

/** The confirm's answer, plus what the controller needs for the device cookie (never in the body). */
export interface ResetConfirmed {
  readonly email: string;
  readonly passwordHash: string;
}

/**
 * Story 6-1c — self-service password reset, shared by staff and portal users.
 *
 * Three unkeyed routes (they set a credential or change nothing — the
 * `sign-in/second-factor` precedent; a double request queues at most one
 * more mail, bounded by the hourly cap; a retried confirm answers 400):
 *  - `request` — the address limit, the lookup, and for an ELIGIBLE user
 *    (active; a portal user's client active) a token and its mail in the
 *    user's tenant transaction. One 202 body for every email (decision 6).
 *  - `check` — validates a token and writes nothing (a mail scanner that
 *    opens the link spends nothing).
 *  - `confirm` — sets the password. An enrolled user must give a code
 *    (decision 3), counted on the TOKEN, never the user (A8). The work
 *    (decision 4) spends every token, revokes EVERY session (web, portal,
 *    badge), ends open sign-in challenges, clears every lockout row for the
 *    email, audits, and queues the password-changed notice — and never signs
 *    anyone in (decision 2). It never touches the factor, the backup codes
 *    or a 2FA lock.
 *
 * The lock order everywhere is the user, then the token (A9).
 */
@Injectable()
export class PasswordResetCommand {
  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  // ── request ───────────────────────────────────────────────────────────────

  async request(input: { readonly email: string; readonly ip: string }): Promise<{ message: string }> {
    await hitRateLimit(this.db, `reset-request-ip:${ipKey(input.ip)}`, RESET_REQUEST_LIMIT_PER_IP_PER_HOUR, ONE_HOUR_SECONDS);
    const email = input.email.trim().toLowerCase();
    const found = (await this.authDb.execute(sql`
      select id, tenant_id, status from users where email = ${email} limit 1
    `)) as unknown as Array<{ id: string; tenant_id: string; status: string }>;
    const user = found[0];
    // An unknown, invited or deactivated email queues nothing — and answers
    // the same body and status.
    if (user !== undefined && user.status === 'active') {
      await withTenantTransaction(this.db, user.tenant_id, (tx) => this.issueInTx(tx, user.tenant_id, user.id, input.ip));
    }
    return { message: RESET_REQUESTED_MESSAGE };
  }

  private async issueInTx(tx: TenantTx, tenantId: string, userId: string, ip: string): Promise<void> {
    const locked = (await tx.execute(sql`
      select u.email, u.status, u.client_id, t.name as tenant_name
        from users u join tenants t on t.id = u.tenant_id
       where u.tenant_id = ${tenantId} and u.id = ${userId}
       for update of u
    `)) as unknown as Array<{ email: string; status: string; client_id: string | null; tenant_name: string }>;
    const user = locked[0];
    if (user === undefined || user.status !== 'active') return;
    if (user.client_id !== null) {
      // A6 — a missing client throws 404 here; the request stays a silent 202.
      try {
        const client = await shareLockClientInTx(tx, tenantId, user.client_id);
        if (client.status !== 'active') return;
      } catch (error) {
        if (error instanceof ProblemException) return;
        throw error;
      }
    }
    // A4 — at most 5 mails per user per rolling hour, counted on the tokens
    // actually issued. Over it: a silent 202, nothing queued.
    const recent = (await tx.execute(sql`
      select count(*)::int as n from password_resets
       where tenant_id = ${tenantId} and user_id = ${userId} and created_at > now() - interval '1 hour'
    `)) as unknown as Array<{ n: number }>;
    if (recent[0]!.n >= MAX_RESET_MAILS_PER_HOUR) return;
    // A4 — a request never supersedes the links already sent; a sixth live
    // token spends the oldest (and cancels its still-queued mail).
    const live = (await tx.execute(sql`
      select id, email_message_id from password_resets
       where tenant_id = ${tenantId} and user_id = ${userId} and consumed_at is null and expires_at > now()
       order by created_at desc, id desc
    `)) as unknown as Array<{ id: string; email_message_id: string | null }>;
    const spent = live.slice(MAX_LIVE_RESETS - 1);
    if (spent.length > 0) {
      await tx.execute(sql`
        update password_resets set consumed_at = now()
         where tenant_id = ${tenantId} and id in (${sql.join(spent.map((row) => sql`${row.id}`), sql`, `)})
      `);
      await cancelEmailMessagesInTx(
        tx,
        tenantId,
        spent.map((row) => row.email_message_id).filter((id): id is string => id !== null),
        'superseded',
      );
    }
    const id = uuidv7();
    const secret = newSecret();
    const inserted = (await tx.execute(sql`
      insert into password_resets (id, tenant_id, user_id, secret_hash, requested_ip, expires_at)
      values (${id}, ${tenantId}, ${userId}, ${hashSecret(secret)}, ${ip}, now() + make_interval(secs => ${RESET_TOKEN_SECONDS}))
      returning expires_at::text as expires_at
    `)) as unknown as Array<{ expires_at: string }>;
    const queued = await queueEmailInTx(tx, {
      tenantId,
      to: user.email,
      template: 'password-reset',
      params: { tenantName: user.tenant_name, expiresAt: new Date(inserted[0]!.expires_at).toISOString() },
      // The raw token goes ONLY into the sealed secret (wiped once final).
      secret: resetTokenOf(id, secret),
      sourceRef: { userId },
    });
    await tx.execute(sql`update password_resets set email_message_id = ${queued.id} where tenant_id = ${tenantId} and id = ${id}`);
    // A7 — written only when a mail is queued; the system acted.
    await auditSecurityEventInTx(tx, {
      tenantId,
      action: 'user.password_reset_requested',
      targetType: 'user',
      targetId: userId,
      actorUserId: null,
      reference: `ip:${ip}`,
    });
  }

  // ── check ─────────────────────────────────────────────────────────────────

  async check(input: { readonly token: string; readonly ip: string }): Promise<ResetCheck> {
    await hitRateLimit(this.db, `reset-ip:${ipKey(input.ip)}`, RESET_LIMIT_PER_IP_PER_MINUTE);
    const located = await this.locate(input.token);
    return { email: located.email, expiresAt: located.expiresAt, secondFactorRequired: located.mfaEnabled };
  }

  /** The token on the auth connection, plus (portal) its client active. One 400 for every failure. */
  private async locate(token: string): Promise<LocatedReset> {
    const parsed = parseResetToken(token);
    if (parsed === null) throw resetLinkInvalid();
    const located = await locateResetIn(this.authDb, parsed);
    if (located === null) throw resetLinkInvalid();
    if (located.clientId !== null) {
      const client = await readSessionClientIn(this.authDb, located.tenantId, located.clientId);
      if (client === null || client.status !== 'active') throw resetLinkInvalid();
    }
    return located;
  }

  // ── confirm ───────────────────────────────────────────────────────────────

  async confirm(input: {
    readonly token: string;
    readonly password: string;
    readonly code?: string | null;
    readonly ip: string;
  }): Promise<ResetConfirmed> {
    await hitRateLimit(this.db, `reset-ip:${ipKey(input.ip)}`, RESET_LIMIT_PER_IP_PER_MINUTE);
    const located = await this.locate(input.token);
    // scrypt BEFORE any transaction (the accept-invite precedent).
    const passwordHash = await hashPassword(input.password);
    const { tenantId, userId } = located;

    if (!located.mfaEnabled) {
      return withTenantTransaction(this.db, tenantId, async (tx) => {
        const rows = (await tx.execute(sql`
          select (mfa_enabled_at is null) as not_enrolled from users
           where tenant_id = ${tenantId} and id = ${userId} for update
        `)) as unknown as Array<{ not_enrolled: boolean }>;
        if (rows[0] === undefined) throw resetLinkInvalid();
        // Enrolled since the link was checked: the code is needed now.
        if (!rows[0].not_enrolled) throw secondFactorNeeded();
        return this.workInTx(tx, located, passwordHash, input.ip);
      });
    }

    const code = input.code?.trim() ?? '';
    if (code === '') throw secondFactorNeeded();
    // A8 — every code tried on reset pages is bounded per user per day
    // (5 tokens × 5 wrong codes), across every token.
    await hitRateLimit(this.db, `reset-code:${userId}`, RESET_CODE_LIMIT_PER_USER_PER_DAY, ONE_DAY_SECONDS);
    let verified;
    try {
      verified = await verifySecondFactorInput(
        this.db,
        {
          tenantId,
          userId,
          ip: input.ip,
          code,
          source: 'active',
          allowBackupCode: true,
          // 422, never 401: a 401 would sign a signed-in tab out (K2).
          invalidStatus: 422,
          countOn: { resetId: located.id },
        },
        // A9 — the factor is gone since the check (an owner reset it): 422
        // `second-factor-needed`, and the page re-checks the link (which now
        // says no code is required) before the next confirm.
        secondFactorNeeded,
        resetLinkInvalid,
      );
    } catch (error) {
      // A9 — tx1's `challenge-ended` means the user is no longer active.
      if (error instanceof ProblemException && codeOf(error) === 'challenge-ended') throw resetLinkInvalid();
      throw error;
    }
    try {
      return await withCommittedFactor(this.db, verified, { stepRule: 'advance', signIn: false }, (tx) =>
        this.workInTx(tx, located, passwordHash, input.ip),
      );
    } catch (error) {
      // A9 — tx2's 409 `second-factor-changed`: the user is no longer active
      // (400), or the factor changed (422 — re-check, then enter a code).
      if (error instanceof ProblemException && codeOf(error) === 'second-factor-changed') {
        const rows = (await this.authDb.execute(sql`
          select status from users where tenant_id = ${tenantId} and id = ${userId}
        `)) as unknown as Array<{ status: string }>;
        throw rows[0]?.status === 'active' ? secondFactorNeeded() : resetLinkInvalid();
      }
      throw error;
    }
  }

  /** Decision 4, in one transaction, with the user row already locked. Then the token, locked after it. */
  private async workInTx(tx: TenantTx, located: LocatedReset, passwordHash: string, ip: string): Promise<ResetConfirmed> {
    const { tenantId, userId } = located;
    const tokens = (await tx.execute(sql`
      select r.user_id, (r.consumed_at is null and r.expires_at > now()) as open,
             u.status, u.email, t.name as tenant_name
        from password_resets r
        join users u on u.id = r.user_id and u.tenant_id = r.tenant_id
        join tenants t on t.id = r.tenant_id
       where r.tenant_id = ${tenantId} and r.id = ${located.id}
       for update of r
    `)) as unknown as Array<{ user_id: string; open: boolean; status: string; email: string; tenant_name: string }>;
    const token = tokens[0];
    // Spent (a twin confirm won), expired while typing, or the user no
    // longer active: 400, and the whole transaction rolls back (a backup
    // code checked by tx2 is not spent).
    if (token === undefined || !token.open || token.user_id !== userId || token.status !== 'active') throw resetLinkInvalid();
    const changed = (await tx.execute(sql`
      update users set password_hash = ${passwordHash}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${userId}
      returning now()::text as changed_at
    `)) as unknown as Array<{ changed_at: string }>;
    await spendOpenResetsInTx(tx, tenantId, userId);
    await revokeSessionsInTx(tx, tenantId, { userId }, 'password-reset');
    // A challenge issued against the old password must die.
    await clearOpenChallengesInTx(tx, tenantId, userId);
    // The owner's Unlock: every lockout row for the email (address and device keys).
    await tx.execute(sql`delete from signin_attempts where email_hash = ${emailDigest(token.email)}`);
    await auditSecurityEventInTx(tx, {
      tenantId,
      action: 'user.password_reset',
      targetType: 'user',
      targetId: userId,
      actorUserId: userId,
      reference: `reset:${located.id}@${ip}`,
    });
    // Every link still queued for this user is dead now.
    await cancelUserEmailsInTx(tx, tenantId, userId, 'password-reset', 'accepted');
    await queueEmailInTx(tx, {
      tenantId,
      to: token.email,
      template: 'password-changed',
      params: { tenantName: token.tenant_name, changedAt: new Date(changed[0]!.changed_at).toISOString() },
      sourceRef: { userId },
    });
    return { email: token.email, passwordHash };
  }
}

function codeOf(error: ProblemException): unknown {
  return (error.getResponse() as { code?: unknown }).code;
}
