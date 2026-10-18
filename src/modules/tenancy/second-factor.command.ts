import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { AUTH_DATABASE, DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, tenants, users } from '../../shared/db/schema';
import type { UserRole } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from './idempotency-guard';
import { idempotencyKeyReuse } from './registration.command';
import { assertPermission } from './permissions';
import { getMemberRoleIn } from './tenancy.service';
import { verifyPassword } from './passwords';
import {
  clearSignInAttempts,
  countSignInAttempt,
  hitRateLimit,
  settleSignInFailure,
  signInLocked,
  SIGNIN_LIMIT_PER_IP_PER_MINUTE,
} from './auth-attempts';
import { auditSecurityEventInTx, revokeSessionsInTx, type SecurityAuditAction } from './sessions';
import { nowIso } from '../../shared/primitives/time';
import { issueWebSessionInTx, type IssuedWebSession } from './sign-in.command';
import {
  base32Encode,
  challengeEnded,
  clearOpenChallengesInTx,
  commitSecondFactorInTx,
  ENROLMENT_CODE_SECONDS,
  hashEnrolmentCode,
  newEnrolmentCode,
  otpauthUri,
  parseChallengeToken,
  pendingSecretInTx,
  replaceBackupCodesInTx,
  secondFactorNotEnabled,
  secondFactorRequired,
  secondFactorRequiredRefusal,
  setupExpired,
  verifySecondFactorInput,
  type SignInChallengePurpose,
} from './second-factor';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** Story 6-1b — the second step's answer: the 6-1a session body, plus what this step adds. */
export interface SecondFactorSignInResult extends IssuedWebSession {
  /** Enrolment only — the ten backup codes, shown this once and never again. */
  backupCodes?: string[];
  /** Wrong codes since the last successful sign-in, when there were any. */
  secondFactorFailedAttempts?: number;
}

export interface SecondFactorStatus {
  readonly enabled: boolean;
  readonly enabledAt: string | null;
  readonly required: boolean;
  readonly backupCodesRemaining: number;
}

/** The self-service caller: always themselves, on a staff web session. */
export interface SelfServiceCaller {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly ip: string;
}

/** The reset's answer — and its stored snapshot (the invite-token precedent). Null on the no-op arm. */
export interface SecondFactorResetSnapshot {
  readonly enrolmentCode: string | null;
  readonly enrolmentCodeExpiresAt: string | null;
}

/**
 * Story 6-1b — two-factor sign-in's commands: the sign-in's second step,
 * My account → Security (self-service), and an owner's reset of a
 * colleague. Every route that takes a code runs the ONE verifier
 * (`verifySecondFactorInput` → `commitSecondFactorInTx`, `second-factor.ts`).
 *
 * The self-service routes are not keyed: their responses carry secrets or
 * backup codes (never stored in `idempotency_keys`); a lost response is
 * recovered by regenerating. Their audit reference is a fresh uuidv7 per
 * call. The reset IS keyed (`arm: 'second-factor-reset'`) and its snapshot
 * carries the one-time enrolment code — short-lived and useless without the
 * password, as the invite snapshot carries its token.
 */
@Injectable()
export class SecondFactorCommand {
  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  // ── the sign-in step ──────────────────────────────────────────────────────

  async completeSignIn(input: {
    readonly challengeToken: string;
    readonly code: string;
    readonly enrolmentCode?: string | null;
    readonly ip: string;
  }): Promise<SecondFactorSignInResult> {
    const parsed = parseChallengeToken(input.challengeToken);
    if (parsed === null) throw challengeEnded();
    const located = (await this.authDb.execute(sql`
      select tenant_id, purpose from sign_in_challenges where id = ${parsed.id}
    `)) as unknown as Array<{ tenant_id: string; purpose: SignInChallengePurpose }>;
    const found = located[0];
    if (found === undefined) throw challengeEnded();
    const tenantId = found.tenant_id;
    const purpose = found.purpose;

    const verified = await verifySecondFactorInput(this.db, {
      tenantId,
      ip: input.ip,
      code: input.code,
      challenge: parsed,
      source: purpose === 'enroll' ? 'pending' : 'active',
      // No backup code exists before enrolment completes.
      allowBackupCode: purpose === 'totp',
      invalidStatus: 401,
      enrolmentCode: input.enrolmentCode ?? null,
    });

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const committed = await commitSecondFactorInTx(tx, verified, { stepRule: 'advance', signIn: true });
      const userId = verified.userId;
      let backupCodes: string[] | undefined;
      if (purpose === 'enroll') {
        await tx.execute(sql`
          update users set mfa_secret_sealed = mfa_pending_secret_sealed, mfa_enabled_at = now(),
                           mfa_pending_secret_sealed = null, mfa_pending_created_at = null,
                           mfa_enrol_code_hash = null, mfa_enrol_code_expires_at = null
           where tenant_id = ${tenantId} and id = ${userId}
        `);
        await clearOpenChallengesInTx(tx, tenantId, userId);
        backupCodes = await replaceBackupCodesInTx(tx, tenantId, userId);
        await auditSecurityEventInTx(tx, {
          tenantId,
          action: 'user.second_factor_enabled',
          targetType: 'user',
          targetId: userId,
          actorUserId: userId,
          reference: `challenge:${parsed.id}@${input.ip}`,
        });
      }
      const user = (await tx.select().from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, userId))).limit(1))[0]!;
      const tenant = (await tx
        .select({ id: tenants.id, name: tenants.name, gstin: tenants.gstin })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1))[0]!;
      const session = await issueWebSessionInTx(tx, user, tenant, null);
      return {
        ...session,
        ...(backupCodes === undefined ? {} : { backupCodes }),
        ...(committed.failedSinceSuccess > 0 ? { secondFactorFailedAttempts: committed.failedSinceSuccess } : {}),
      };
    });
  }

  // ── My account → Security ─────────────────────────────────────────────────

  async status(tenantId: string, userId: string): Promise<SecondFactorStatus> {
    return withTenantTransaction(this.db, tenantId, (tx) => this.statusInTx(tx, tenantId, userId));
  }

  private async statusInTx(tx: TenantTx, tenantId: string, userId: string): Promise<SecondFactorStatus> {
    const rows = (await tx.execute(sql`
      select u.role, u.mfa_enabled_at,
             (select count(*) from user_backup_codes b
               where b.tenant_id = u.tenant_id and b.user_id = u.id and b.used_at is null)::int as remaining
        from users u where u.tenant_id = ${tenantId} and u.id = ${userId}
    `)) as unknown as Array<{ role: UserRole; mfa_enabled_at: string | null; remaining: number }>;
    const row = rows[0];
    if (row === undefined) throw new ProblemException('not-found', 404, 'User not found', 'No user with this id exists in this tenant.');
    const enabled = row.mfa_enabled_at !== null;
    return {
      enabled,
      enabledAt: enabled ? new Date(row.mfa_enabled_at!).toISOString() : null,
      required: secondFactorRequired(row.role),
      backupCodesRemaining: enabled ? Number(row.remaining) : 0,
    };
  }

  /**
   * Starts (or replaces) the authenticator: stores a fresh pending secret and
   * shows it. With 2FA off it needs the current password (counted on
   * `signin_attempts` like sign-in; wrong → 422 `password-invalid`); with 2FA
   * on, a current code (TOTP or backup) through the shared verifier.
   */
  async setup(
    caller: SelfServiceCaller,
    proof: { readonly password?: string; readonly code?: string },
  ): Promise<{ secret: string; otpauthUri: string }> {
    const current = await this.status(caller.tenantId, caller.userId);
    if (current.enabled) {
      if (proof.code === undefined) throw proofRequired('Enter a current code from your authenticator app, or a backup code.');
      const verified = await verifySecondFactorInput(
        this.db,
        { ...this.selfServiceInput(caller, proof.code), source: 'active', allowBackupCode: true },
        secondFactorNotEnabled,
      );
      return withTenantTransaction(this.db, caller.tenantId, async (tx) => {
        await commitSecondFactorInTx(tx, verified, { stepRule: 'advance', signIn: false });
        return this.startSetupInTx(tx, caller);
      });
    }
    if (proof.password === undefined) throw proofRequired('Enter your current password.');
    await this.assertPassword(caller, proof.password);
    return withTenantTransaction(this.db, caller.tenantId, async (tx) => {
      await tx.execute(sql`select id from users where tenant_id = ${caller.tenantId} and id = ${caller.userId} for update`);
      return this.startSetupInTx(tx, caller);
    });
  }

  /**
   * Confirms the pending authenticator with a code from it: the pending
   * secret becomes the active one, `mfa_last_step` is set to the matched step
   * unconditionally (a new secret starts its own sequence), the backup codes
   * are replaced and returned. Replacing an authenticator ends the user's
   * other web sessions (`second-factor-changed`).
   */
  async confirm(caller: SelfServiceCaller, code: string): Promise<{ backupCodes: string[] }> {
    const verified = await verifySecondFactorInput(
      this.db,
      { ...this.selfServiceInput(caller, code), source: 'pending', allowBackupCode: false },
      setupExpired,
    );
    return withTenantTransaction(this.db, caller.tenantId, async (tx) => {
      await commitSecondFactorInTx(tx, verified, { stepRule: 'set', signIn: false });
      const before = (await tx.execute(sql`
        select (mfa_enabled_at is not null) as replacing from users where tenant_id = ${caller.tenantId} and id = ${caller.userId}
      `)) as unknown as Array<{ replacing: boolean }>;
      await tx.execute(sql`
        update users set mfa_secret_sealed = mfa_pending_secret_sealed, mfa_enabled_at = now(),
                         mfa_pending_secret_sealed = null, mfa_pending_created_at = null,
                         mfa_enrol_code_hash = null, mfa_enrol_code_expires_at = null
         where tenant_id = ${caller.tenantId} and id = ${caller.userId}
      `);
      await clearOpenChallengesInTx(tx, caller.tenantId, caller.userId);
      const backupCodes = await replaceBackupCodesInTx(tx, caller.tenantId, caller.userId);
      if (before[0]?.replacing === true) await this.endOtherSessionsInTx(tx, caller);
      await this.auditSelf(tx, caller, 'user.second_factor_enabled');
      return { backupCodes };
    });
  }

  /** A fresh set of ten backup codes (the old set is void); other web sessions end. */
  async regenerateBackupCodes(caller: SelfServiceCaller, code: string): Promise<{ backupCodes: string[] }> {
    const verified = await verifySecondFactorInput(
      this.db,
      { ...this.selfServiceInput(caller, code), source: 'active', allowBackupCode: true },
      secondFactorNotEnabled,
    );
    return withTenantTransaction(this.db, caller.tenantId, async (tx) => {
      await commitSecondFactorInTx(tx, verified, { stepRule: 'advance', signIn: false });
      const backupCodes = await replaceBackupCodesInTx(tx, caller.tenantId, caller.userId);
      await this.endOtherSessionsInTx(tx, caller);
      await this.auditSelf(tx, caller, 'user.backup_codes_regenerated');
      return { backupCodes };
    });
  }

  /** Turns 2FA off (never for a role that requires it — 409 `second-factor-required`); other web sessions end. */
  async disable(caller: SelfServiceCaller, code: string): Promise<SecondFactorStatus> {
    const current = await this.status(caller.tenantId, caller.userId);
    if (current.required) throw secondFactorRequiredRefusal();
    if (!current.enabled) throw secondFactorNotEnabled();
    const verified = await verifySecondFactorInput(
      this.db,
      { ...this.selfServiceInput(caller, code), source: 'active', allowBackupCode: true },
      secondFactorNotEnabled,
    );
    return withTenantTransaction(this.db, caller.tenantId, async (tx) => {
      await commitSecondFactorInTx(tx, verified, { stepRule: 'advance', signIn: false });
      // The role is re-read under the user lock commit took: a promotion to
      // owner between the check above and here still refuses.
      const role = (await tx.execute(sql`select role from users where tenant_id = ${caller.tenantId} and id = ${caller.userId}`)) as unknown as Array<{ role: UserRole }>;
      if (secondFactorRequired(role[0]!.role)) throw secondFactorRequiredRefusal();
      await tx.execute(sql`
        update users set mfa_secret_sealed = null, mfa_enabled_at = null, mfa_last_step = null,
                         mfa_pending_secret_sealed = null, mfa_pending_created_at = null
         where tenant_id = ${caller.tenantId} and id = ${caller.userId}
      `);
      await tx.execute(sql`delete from user_backup_codes where tenant_id = ${caller.tenantId} and user_id = ${caller.userId}`);
      await clearOpenChallengesInTx(tx, caller.tenantId, caller.userId);
      await this.endOtherSessionsInTx(tx, caller);
      await this.auditSelf(tx, caller, 'user.second_factor_disabled');
      return this.statusInTx(tx, caller.tenantId, caller.userId);
    });
  }

  // ── an owner's reset of a colleague ───────────────────────────────────────

  /**
   * `users.role_change`, keyed (`arm: 'second-factor-reset'`), in skeleton
   * order: authority → replay → lock the target (404) → replay under the lock
   * → self-target 409 → the no-op arm (no 2FA and no enrolment code: stores
   * the key, writes nothing) → clear the factor, set a one-time enrolment
   * code (72 h) → end the target's web sessions → audit → the key.
   */
  async reset(
    command: { readonly tenantId: string; readonly actorUserId: string; readonly targetUserId: string },
    idempotencyKey: string,
  ): Promise<SecondFactorResetSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'second-factor-reset',
      tenantId: command.tenantId,
      targetUserId: command.targetUserId,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'users.role_change');
      const replayed = await replayResetKey(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const targetRows = (await tx.execute(sql`
        select id, mfa_enabled_at, mfa_enrol_code_hash from users
         where tenant_id = ${command.tenantId} and id = ${command.targetUserId}
         for update
      `)) as unknown as Array<{ id: string; mfa_enabled_at: string | null; mfa_enrol_code_hash: string | null }>;
      const target = targetRows[0];
      if (target === undefined) {
        throw new ProblemException('not-found', 404, 'User not found', 'No user with this id exists in this tenant.');
      }
      const again = await replayResetKey(tx, command.tenantId, idempotencyKey, payloadHash);
      if (again !== null) return again;
      if (target.id === command.actorUserId) {
        throw new ProblemException(
          'self-reset',
          409,
          'Cannot reset your own two-factor sign-in',
          'Use My account → Security to change your own authenticator — another owner resets yours.',
        );
      }
      let body: SecondFactorResetSnapshot;
      if (target.mfa_enabled_at === null && target.mfa_enrol_code_hash === null) {
        body = { enrolmentCode: null, enrolmentCodeExpiresAt: null };
      } else {
        body = await resetSecondFactorInTx(tx, command.tenantId, target.id);
        // Step 10 of the skeleton: the keyed command's audit row, reference = the key.
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'user.second_factor_reset' satisfies SecurityAuditAction,
          targetType: 'user',
          targetId: target.id,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });
      }
      try {
        await tx.insert(idempotencyKeys).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          key: idempotencyKey,
          payloadHash,
          responseSnapshot: body as unknown as Record<string, unknown>,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
          throw new ProblemException(
            'conflict',
            409,
            'Concurrent idempotent request',
            'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
          );
        }
        throw err;
      }
      return body;
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private selfServiceInput(caller: SelfServiceCaller, code: string) {
    return {
      tenantId: caller.tenantId,
      userId: caller.userId,
      ip: caller.ip,
      code,
      // 422, never 401: a 401 would sign the web user out.
      invalidStatus: 422 as const,
    };
  }

  private async startSetupInTx(tx: TenantTx, caller: SelfServiceCaller): Promise<{ secret: string; otpauthUri: string }> {
    const rows = (await tx.execute(sql`
      select u.email, t.name as tenant_name from users u join tenants t on t.id = u.tenant_id
       where u.tenant_id = ${caller.tenantId} and u.id = ${caller.userId}
    `)) as unknown as Array<{ email: string; tenant_name: string }>;
    const secret = base32Encode(await pendingSecretInTx(tx, caller.tenantId, caller.userId, { reuse: false }));
    return { secret, otpauthUri: otpauthUri(secret, rows[0]!.email, rows[0]!.tenant_name) };
  }

  /** The password proof (2FA off): counted before the scrypt check, like sign-in. */
  private async assertPassword(caller: SelfServiceCaller, password: string): Promise<void> {
    await hitRateLimit(this.db, `signin-ip:${caller.ip}`, SIGNIN_LIMIT_PER_IP_PER_MINUTE);
    const rows = await withTenantTransaction(this.db, caller.tenantId, (tx) =>
      tx
        .select({ email: users.email, passwordHash: users.passwordHash })
        .from(users)
        .where(and(eq(users.tenantId, caller.tenantId), eq(users.id, caller.userId)))
        .limit(1),
    );
    const user = rows[0]!;
    const counted = await countSignInAttempt(this.db, user.email, caller.ip);
    if (counted.locked) {
      if (counted.newlyLocked) await this.auditSignInLock(caller);
      throw signInLocked(counted.retryAfterSeconds);
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      if (await settleSignInFailure(this.db, user.email, caller.ip)) await this.auditSignInLock(caller);
      throw new ProblemException('password-invalid', 422, 'Wrong password', 'That password is not right.');
    }
    await clearSignInAttempts(this.db, user.email, caller.ip);
  }

  private async auditSignInLock(caller: SelfServiceCaller): Promise<void> {
    await withTenantTransaction(this.db, caller.tenantId, (tx) =>
      auditSecurityEventInTx(tx, {
        tenantId: caller.tenantId,
        action: 'user.sign_in_locked',
        targetType: 'user',
        targetId: caller.userId,
        actorUserId: null,
        reference: `ip:${caller.ip}`,
      }),
    );
  }

  /** The caller's OTHER web sessions end; their own stays signed in. */
  private async endOtherSessionsInTx(tx: TenantTx, caller: SelfServiceCaller): Promise<void> {
    await revokeSessionsInTx(
      tx,
      caller.tenantId,
      { userId: caller.userId, kinds: ['web'], exceptSessionId: caller.sessionId },
      'second-factor-changed',
    );
  }

  private async auditSelf(
    tx: TenantTx,
    caller: SelfServiceCaller,
    action: 'user.second_factor_enabled' | 'user.second_factor_disabled' | 'user.backup_codes_regenerated',
  ): Promise<void> {
    await auditSecurityEventInTx(tx, {
      tenantId: caller.tenantId,
      action,
      targetType: 'user',
      targetId: caller.userId,
      actorUserId: caller.userId,
      // A fresh reference per call (the self-service routes are unkeyed).
      reference: uuidv7(),
    });
  }
}

/**
 * The reset itself (the web reset and `bun run auth:reset-2fa`), in a tenant
 * transaction with the target row locked: clears the secret, the pending
 * secret, the backup codes, the counters and the open challenges; sets a
 * one-time enrolment code (sha256 at rest, 72 h); ends the target's web
 * sessions (`second-factor-reset`). Never on a bare `db` — RLS would match
 * nothing.
 */
export async function resetSecondFactorInTx(
  tx: TenantTx,
  tenantId: string,
  userId: string,
): Promise<{ enrolmentCode: string; enrolmentCodeExpiresAt: string }> {
  const enrolmentCode = newEnrolmentCode();
  const expiresAt = new Date(Date.now() + ENROLMENT_CODE_SECONDS * 1000).toISOString();
  await tx.execute(sql`
    update users set mfa_secret_sealed = null, mfa_enabled_at = null, mfa_last_step = null,
                     mfa_failures = 0, mfa_lock_cycles = 0, mfa_locked_until = null,
                     mfa_pending_secret_sealed = null, mfa_pending_created_at = null,
                     mfa_enrol_code_hash = ${hashEnrolmentCode(enrolmentCode)},
                     mfa_enrol_code_expires_at = ${expiresAt}::timestamptz
     where tenant_id = ${tenantId} and id = ${userId}
  `);
  await tx.execute(sql`delete from user_backup_codes where tenant_id = ${tenantId} and user_id = ${userId}`);
  await clearOpenChallengesInTx(tx, tenantId, userId);
  await revokeSessionsInTx(tx, tenantId, { userId, kinds: ['web'] }, 'second-factor-reset');
  return { enrolmentCode, enrolmentCodeExpiresAt: expiresAt };
}

async function replayResetKey(
  tx: TenantTx,
  tenantId: string,
  key: string,
  payloadHash: string,
): Promise<SecondFactorResetSnapshot | null> {
  const existing = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
    .limit(1);
  if (existing[0] === undefined) return null;
  if (existing[0].payloadHash !== payloadHash) throw idempotencyKeyReuse();
  return existing[0].responseSnapshot as unknown as SecondFactorResetSnapshot;
}

function proofRequired(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Validation failed', detail);
}
