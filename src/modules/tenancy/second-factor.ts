import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '../../shared/db/db';
import type { UserRole } from '../../shared/db/schema';
import { userBackupCodes } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { hitRateLimit, ipKey, minutesText, SIGNIN_LIMIT_PER_IP_PER_MINUTE } from './auth-attempts';
import { auditSecurityEventInTx, hashSecret, newSecret, sameHash } from './sessions';
import {
  backupCodeHash,
  backupCodeHashCandidates,
  openSecondFactorSecret,
  sealSecondFactorSecret,
} from './second-factor-secrets';

/**
 * Story 6-1b — two-factor sign-in: RFC 6238 TOTP (SHA-1, 6 digits, 30 s),
 * single-use backup codes, the sign-in challenge store and the ONE verifier
 * every code-bearing route runs (`verifySecondFactorInput` +
 * `commitSecondFactorInTx`).
 *
 * The verifier's order is load-bearing (spec §Verifying a code):
 *  1. the per-IP attempt limit;
 *  2. tx1 — lock the challenge, validate it, check the user's lock, COUNT the
 *     attempt (challenge + user) and COMMIT, before any code is checked (the
 *     `countBadgeInAttemptInTx` precedent: a count made in the transaction
 *     that then refuses would roll back with the refusal);
 *  3. check the code with no transaction open;
 *  4. tx2 (the caller's, so the route's work commits with it) — lock the user
 *     then the challenge, re-check, advance the step or spend the backup code,
 *     consume the challenge, reset the counters.
 */

// ── constants ───────────────────────────────────────────────────────────────

/** Pinned against `sign_in_challenges_purpose_check` (0075). */
export const SIGN_IN_CHALLENGE_PURPOSES = ['totp', 'enroll'] as const;
export type SignInChallengePurpose = (typeof SIGN_IN_CHALLENGE_PURPOSES)[number];

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now that are accepted (t−1, t, t+1). */
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;

export const TOTP_CHALLENGE_SECONDS = 300;
export const ENROLL_CHALLENGE_SECONDS = 600;
/** A pending (unconfirmed) secret is reused for this long, so a scanned QR code keeps working. */
export const PENDING_SECRET_SECONDS = 24 * 60 * 60;
/** The one-time enrolment code an owner's reset hands over. */
export const ENROLMENT_CODE_SECONDS = 72 * 60 * 60;
export const ENROLMENT_CODE_LENGTH = 8;

/** Consecutive wrong codes before a lock; a challenge also ends at this many. */
export const MAX_SECOND_FACTOR_FAILURES = 5;
export const SECOND_FACTOR_LOCK_SECONDS = 15 * 60;
/** The lock cycle (without a success between) that becomes permanent until an owner unlocks. */
export const HARD_LOCK_CYCLE = 3;

export const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Enrolment codes avoid the look-alikes 0/O, 1/I/L. */
const ENROLMENT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Decision 1 — owners must use a second factor; every other web staff role may opt in. */
export function secondFactorRequired(role: UserRole): boolean {
  return role === 'owner';
}

// ── base32 + TOTP (RFC 4648 / RFC 6238), on node:crypto only ───────────────

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Not a base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The TOTP step containing this instant. */
export function totpStepOf(epochMs: number = Date.now()): number {
  return Math.floor(epochMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The HOTP value of `secret` at `step` (RFC 4226 dynamic truncation),
 * `digits` long. Exported for the scripts and the tests (the RFC 6238
 * vectors use 8 digits and 30 s steps).
 */
export function totpAt(secret: Buffer, step: number, digits: number = TOTP_DIGITS, algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac(algorithm, secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The step a 6-digit code matches within t−1…t+1, or null. Constant work per step. */
export function matchTotp(secret: Buffer, code: string, nowStep: number = totpStepOf()): number | null {
  let matched: number | null = null;
  for (let step = nowStep - TOTP_WINDOW; step <= nowStep + TOTP_WINDOW; step += 1) {
    const expected = Buffer.from(totpAt(secret, step), 'utf8');
    const given = Buffer.from(code, 'utf8');
    if (expected.length === given.length && timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  return matched;
}

export function newTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** `otpauth://totp/<issuer>:<email>?secret=…&issuer=…` — the issuer is `WMS (<tenant name>)`. */
export function otpauthUri(secretBase32: string, email: string, tenantName: string): string {
  // A ':' splits issuer from account in the label: keep it out of both parts.
  const issuer = `WMS (${tenantName})`.replace(/:/g, ' ');
  const label = encodeURIComponent(`${issuer}:${email.replace(/:/g, ' ')}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
}

/** A 6-digit code with spaces stripped, or null. */
export function normaliseTotpCode(input: string): string | null {
  const clean = input.replace(/\s+/g, '');
  return /^\d{6}$/.test(clean) ? clean : null;
}

// ── backup codes ────────────────────────────────────────────────────────────

/** Ten fresh codes, shown as `XXXXX-XXXXX` (10 base32 characters, 50 bits each). */
export function generateBackupCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < BACKUP_CODE_COUNT) {
    let raw = '';
    for (let i = 0; i < BACKUP_CODE_LENGTH; i += 1) raw += BASE32_ALPHABET[randomInt(32)];
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

/** Case-insensitive; hyphens and spaces ignored. Null when it is not a backup code's shape. */
export function normaliseBackupCode(input: string): string | null {
  const clean = input.replace(/[\s-]+/g, '').toUpperCase();
  return new RegExp(`^[A-Z2-7]{${BACKUP_CODE_LENGTH}}$`).test(clean) ? clean : null;
}

/** Replaces the user's backup codes whole (never appends) and returns the new set — shown once. */
export async function replaceBackupCodesInTx(tx: TenantTx, tenantId: string, userId: string): Promise<string[]> {
  await tx.execute(sql`delete from user_backup_codes where tenant_id = ${tenantId} and user_id = ${userId}`);
  const codes = generateBackupCodes();
  await tx.insert(userBackupCodes).values(
    codes.map((code) => ({
      tenantId,
      userId,
      codeHash: backupCodeHash(userId, normaliseBackupCode(code)!),
    })),
  );
  return codes;
}

// ── enrolment codes (an owner's reset) ──────────────────────────────────────

export function newEnrolmentCode(): string {
  let code = '';
  for (let i = 0; i < ENROLMENT_CODE_LENGTH; i += 1) code += ENROLMENT_ALPHABET[randomInt(ENROLMENT_ALPHABET.length)];
  return code;
}

export function hashEnrolmentCode(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]+/g, '').toUpperCase(), 'utf8').digest('hex');
}

// ── challenge tokens ────────────────────────────────────────────────────────

/** `<id>.<secret>` — the id names the row, the secret (sha256 at rest) proves the holder. */
export function challengeTokenOf(id: string, secret: string): string {
  return `${id}.${secret}`;
}

export function parseChallengeToken(token: unknown): { id: string; secret: string } | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(secret)) return null;
  return { id, secret };
}

/** Inserts a challenge (no session exists yet) and returns its token. */
export async function createChallengeInTx(
  tx: TenantTx,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly purpose: SignInChallengePurpose;
    /** The user's `mfa_enabled_at` (totp only). */
    readonly enabledAtSeen: string | null;
    readonly ip: string;
  },
): Promise<string> {
  const id = uuidv7();
  const secret = newSecret();
  const seconds = input.purpose === 'totp' ? TOTP_CHALLENGE_SECONDS : ENROLL_CHALLENGE_SECONDS;
  await tx.execute(sql`
    insert into sign_in_challenges (id, tenant_id, user_id, purpose, secret_hash, enabled_at_seen, ip, expires_at)
    values (${id}, ${input.tenantId}, ${input.userId}, ${input.purpose}, ${hashSecret(secret)},
            ${input.enabledAtSeen}::timestamptz, ${input.ip}, now() + make_interval(secs => ${seconds}))
  `);
  return challengeTokenOf(id, secret);
}

/** The challenge's tenant, read by id on the BYPASSRLS auth connection (the `sessionTenantOf` shape). */
export async function challengeTenantOf(authDb: Database, challengeId: string): Promise<string | null> {
  const rows = (await authDb.execute(sql`select tenant_id from sign_in_challenges where id = ${challengeId}`)) as unknown as Array<{
    tenant_id: string;
  }>;
  return rows[0]?.tenant_id ?? null;
}

/** Any change to a user's 2FA or status ends their open challenges (reset, disable, confirm, deactivation, a role change). */
export async function clearOpenChallengesInTx(tx: TenantTx, tenantId: string, userId: string): Promise<void> {
  await tx.execute(sql`delete from sign_in_challenges where tenant_id = ${tenantId} and user_id = ${userId} and consumed_at is null`);
}

/** Owner Unlock and the CLI: the second-factor lock and its counters. Only inside a tenant transaction (RLS). */
export async function clearSecondFactorLockInTx(tx: TenantTx, tenantId: string, userId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    update users set mfa_failures = 0, mfa_lock_cycles = 0, mfa_locked_until = null
     where tenant_id = ${tenantId} and id = ${userId}
    returning id
  `)) as unknown as unknown[];
  return rows.length;
}

/**
 * The pending secret an enrolment shows: the one already pending when it is
 * under 24 h old (a second enrolment challenge — re-sign-in, another tab —
 * shows the SAME QR code, so an app that scanned the first still works),
 * else a fresh one. The user row must already be locked by the caller.
 */
export async function pendingSecretInTx(
  tx: TenantTx,
  tenantId: string,
  userId: string,
  options: { readonly reuse: boolean },
): Promise<Buffer> {
  if (options.reuse) {
    const rows = (await tx.execute(sql`
      select mfa_pending_secret_sealed as sealed from users
       where tenant_id = ${tenantId} and id = ${userId}
         and mfa_pending_secret_sealed is not null
         and mfa_pending_created_at > now() - make_interval(secs => ${PENDING_SECRET_SECONDS})
    `)) as unknown as Array<{ sealed: string }>;
    if (rows[0] !== undefined) {
      try {
        return openSecondFactorSecret(rows[0].sealed, tenantId, userId);
      } catch {
        // Sealed under a key no longer configured: start over with a fresh one.
      }
    }
  }
  const secret = newTotpSecret();
  await tx.execute(sql`
    update users set mfa_pending_secret_sealed = ${sealSecondFactorSecret(secret, tenantId, userId)},
                     mfa_pending_created_at = now()
     where tenant_id = ${tenantId} and id = ${userId}
  `);
  return secret;
}

// ── refusals ────────────────────────────────────────────────────────────────

export function challengeEnded(): ProblemException {
  return new ProblemException(
    'challenge-ended',
    401,
    'Sign-in step ended',
    'This sign-in step has ended — sign in again.',
  );
}

export function secondFactorLocked(retryAfterSeconds: number | null): ProblemException {
  return new ProblemException(
    'second-factor-locked',
    423,
    'Two-factor sign-in locked',
    retryAfterSeconds === null
      ? 'Too many wrong codes — two-factor sign-in is locked until an owner unlocks it.'
      : `Too many wrong codes. Try again in ${minutesText(retryAfterSeconds)}.`,
    { retryAfterSeconds },
  );
}

export function secondFactorInvalid(status: 401 | 422, attemptsLeft: number, detail = 'That code is not right.'): ProblemException {
  return new ProblemException(
    'second-factor-invalid',
    status,
    'Wrong code',
    attemptsLeft > 0 ? `${detail} ${attemptsLeft === 1 ? '1 attempt' : `${attemptsLeft} attempts`} left.` : detail,
    { attemptsLeft },
  );
}

/** The sealed secret will not open (the key it was sealed under is not configured): nothing counted. */
export function secondFactorUnavailable(): ProblemException {
  return new ProblemException(
    'second-factor-unavailable',
    503,
    'Two-factor sign-in unavailable',
    'Two-factor sign-in cannot be checked right now — tell an owner (the server key is not configured).',
  );
}

/** The reset's enrolment code expired: a fresh reset is needed (answered at the password step). */
export function enrolmentCodeExpired(): ProblemException {
  return new ProblemException(
    'enrolment-code-expired',
    403,
    'Enrolment code expired',
    'Ask an owner to reset your two-factor sign-in again.',
  );
}

export function clientOutdated(): ProblemException {
  return new ProblemException(
    'client-outdated',
    409,
    'Reload required',
    'Reload this page to sign in.',
  );
}

export function secondFactorRequiredRefusal(): ProblemException {
  return new ProblemException(
    'second-factor-required',
    409,
    'Two-factor sign-in is required',
    'Owners must use two-factor sign-in — it cannot be turned off.',
  );
}

export function secondFactorNotEnabled(): ProblemException {
  return new ProblemException(
    'second-factor-not-enabled',
    409,
    'Two-factor sign-in is off',
    'Two-factor sign-in is not set up for this account.',
  );
}

export function setupExpired(): ProblemException {
  return new ProblemException(
    'second-factor-setup-expired',
    409,
    'Setup expired',
    'This setup has expired or was replaced — start again.',
  );
}

export function factorChanged(): ProblemException {
  return new ProblemException(
    'second-factor-changed',
    409,
    'Two-factor settings changed',
    'Your two-factor settings changed while this was in progress — start again.',
  );
}

// ── the verifier ────────────────────────────────────────────────────────────

/** Which secret the code is checked against: the active one, or the one being set up. */
export type SecretSource = 'active' | 'pending';

export interface VerifyInput {
  readonly tenantId: string;
  /**
   * The user: the signed-in caller (self-service), or — at sign-in — the
   * challenge's user from the auth-connection lookup (tx1 locks this row
   * FIRST, the order tx2 takes; the challenge must belong to it).
   */
  readonly userId: string;
  readonly ip: string;
  readonly code: string;
  /** The sign-in step's challenge; absent on the self-service routes. */
  readonly challenge?: { readonly id: string; readonly secret: string };
  readonly source: SecretSource;
  readonly allowBackupCode: boolean;
  /** 401 at sign-in; 422 on the self-service routes (a 401 would sign the web user out). */
  readonly invalidStatus: 401 | 422;
  /** The reset's one-time code, checked on an `enroll` challenge when the user holds one. */
  readonly enrolmentCode?: string | null;
  /**
   * Story 6-1c (A8) — where a wrong code is counted. `'user'` (the default:
   * every 6-1b caller, unchanged) feeds the user's escalating lock. A
   * password-reset page counts on its token instead (`password_resets.
   * code_failures`; the 5th wrong code spends it): the user's live 2FA lock
   * is HONOURED (423) but never fed, so a mailbox holder alone cannot lock
   * an owner's second factor — and tx2 resets no user counter.
   */
  readonly countOn?: 'user' | { readonly resetId: string };
}

export interface VerifiedFactor {
  readonly tenantId: string;
  readonly userId: string;
  readonly ip: string;
  readonly challenge: { readonly id: string; readonly purpose: SignInChallengePurpose } | null;
  readonly source: SecretSource;
  /** `mfa_enabled_at` (active) or `mfa_pending_created_at` (pending) when tx1 read it. */
  readonly factorSeen: string | null;
  readonly invalidStatus: 401 | 422;
  /** The wrong-code detail this attempt answers (the enrolment step after a reset names both codes). */
  readonly invalidDetail?: string;
  readonly match: { readonly kind: 'totp'; readonly step: number } | { readonly kind: 'backup'; readonly hashes: readonly string[] };
  /** Story 6-1c (A8) — the reset token the attempt was counted on (absent: the user). */
  readonly resetId?: string;
}

type Tx1Outcome =
  | { readonly kind: 'challenge-ended' }
  /** Story 6-1c — the reset token is spent, expired, out of attempts or not this user's. */
  | { readonly kind: 'reset-ended' }
  | { readonly kind: 'no-factor' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number | null }
  | {
      readonly kind: 'counted';
      readonly purpose: SignInChallengePurpose | null;
      readonly secret: Buffer;
      readonly factorSeen: string;
      readonly unusedBackupHashes: readonly string[];
      readonly enrolCodeHash: string | null;
      readonly enrolCodeLive: boolean;
    };

const logger = new Logger('SecondFactor');

/** The enrolment step after a reset: the code that was wrong may be either. */
export const ENROLMENT_INVALID_DETAIL = 'The authenticator code or the enrolment code is not right.';

/**
 * Steps 1–3 of the shared verifier. Counts the attempt and COMMITS before the
 * code is checked; a wrong code answers `second-factor-invalid` (status per
 * route) with the count already standing, and may set the lock. Returns what
 * `commitSecondFactorInTx` needs. `missingFactor` is the refusal when the
 * source secret is absent (self-service routes).
 */
export async function verifySecondFactorInput(
  db: Database,
  input: VerifyInput,
  missingFactor: () => ProblemException = challengeEnded,
  /** Story 6-1c — the refusal when the reset token (`countOn.resetId`) is no longer usable. */
  resetEnded: () => ProblemException = challengeEnded,
): Promise<VerifiedFactor> {
  // 1. The per-IP attempt limit (story 6-1c, A11: the address key — an IPv6 /64).
  await hitRateLimit(db, `second-factor-ip:${ipKey(input.ip)}`, SIGNIN_LIMIT_PER_IP_PER_MINUTE);
  const resetId = typeof input.countOn === 'object' ? input.countOn.resetId : undefined;

  // 2. tx1 — validate, check the lock, open the secret, count, commit.
  const outcome = await withTenantTransaction(db, input.tenantId, (tx) => countAttemptInTx(tx, input));
  if (outcome.kind === 'reset-ended') throw resetEnded();
  if (outcome.kind === 'challenge-ended') throw challengeEnded();
  if (outcome.kind === 'no-factor') throw missingFactor();
  if (outcome.kind === 'unavailable') throw secondFactorUnavailable();
  if (outcome.kind === 'locked') throw secondFactorLocked(outcome.retryAfterSeconds);

  // 3. Check the code with no transaction open.
  let match: VerifiedFactor['match'] | null = null;
  const totp = normaliseTotpCode(input.code);
  if (totp !== null) {
    const step = matchTotp(outcome.secret, totp);
    if (step !== null) match = { kind: 'totp', step };
  } else if (input.allowBackupCode) {
    const backup = normaliseBackupCode(input.code);
    if (backup !== null) {
      const hashes = backupCodeHashCandidates(input.userId, backup);
      if (hashes.some((hash) => outcome.unusedBackupHashes.some((stored) => sameHash(hash, stored)))) {
        match = { kind: 'backup', hashes };
      }
    }
  }
  // The reset's enrolment code: required whenever the user holds one (an
  // expired one is refused at the password step — `enrolment-code-expired`).
  const enrolmentStep = outcome.purpose === 'enroll' && outcome.enrolCodeHash !== null;
  if (match !== null && enrolmentStep) {
    const given = input.enrolmentCode ?? '';
    const ok = outcome.enrolCodeLive && given.length > 0 && sameHash(hashEnrolmentCode(given), outcome.enrolCodeHash!);
    if (!ok) match = null;
  }
  const invalidDetail = enrolmentStep ? ENROLMENT_INVALID_DETAIL : undefined;
  if (match === null) {
    const left =
      resetId === undefined
        ? await settleWrongCode(db, input.tenantId, input.userId, input.ip, input.challenge?.id ?? null)
        : await settleWrongResetCode(db, input.tenantId, resetId);
    throw secondFactorInvalid(input.invalidStatus, left, invalidDetail);
  }
  return {
    tenantId: input.tenantId,
    userId: input.userId,
    ip: input.ip,
    challenge: input.challenge === undefined || outcome.purpose === null ? null : { id: input.challenge.id, purpose: outcome.purpose },
    source: input.source,
    factorSeen: outcome.factorSeen,
    invalidStatus: input.invalidStatus,
    ...(invalidDetail === undefined ? {} : { invalidDetail }),
    match,
    ...(resetId === undefined ? {} : { resetId }),
  };
}

async function countAttemptInTx(tx: TenantTx, input: VerifyInput): Promise<Tx1Outcome> {
  const userId = input.userId;
  // The user row FIRST, then the challenge — the order tx2 takes (a
  // different order deadlocks a duplicate verify against another's tx2).
  const users = (await tx.execute(sql`
    select status, mfa_failures,
           case when ${input.source}::text = 'active' then mfa_secret_sealed else mfa_pending_secret_sealed end as sealed,
           case when ${input.source}::text = 'active' then mfa_enabled_at::text else mfa_pending_created_at::text end as factor_seen,
           (${input.source}::text = 'pending' and mfa_pending_created_at <= now() - make_interval(secs => ${PENDING_SECRET_SECONDS})) as pending_stale,
           (mfa_locked_until is not null and mfa_locked_until > now()) as locked,
           (mfa_locked_until = 'infinity') as locked_forever,
           coalesce(greatest(1, ceil(extract(epoch from (mfa_locked_until - now())))), 0)::float8 as retry_after,
           mfa_enrol_code_hash,
           (mfa_enrol_code_expires_at is not null and mfa_enrol_code_expires_at > now()) as enrol_code_live
      from users
     where tenant_id = ${input.tenantId} and id = ${userId}
     for update
  `)) as unknown as Array<{
    status: string;
    mfa_failures: number;
    sealed: string | null;
    factor_seen: string | null;
    pending_stale: boolean | null;
    locked: boolean;
    locked_forever: boolean | null;
    retry_after: number;
    mfa_enrol_code_hash: string | null;
    enrol_code_live: boolean;
  }>;
  const user = users[0];

  let purpose: SignInChallengePurpose | null = null;
  if (input.challenge !== undefined) {
    const rows = (await tx.execute(sql`
      select user_id, purpose, secret_hash, failures,
             (consumed_at is null and expires_at > now()) as open
        from sign_in_challenges
       where id = ${input.challenge.id} and tenant_id = ${input.tenantId}
       for update
    `)) as unknown as Array<{ user_id: string; purpose: SignInChallengePurpose; secret_hash: string; failures: number; open: boolean }>;
    const row = rows[0];
    if (
      row === undefined ||
      !sameHash(hashSecret(input.challenge.secret), row.secret_hash) ||
      !row.open ||
      row.failures >= MAX_SECOND_FACTOR_FAILURES ||
      row.user_id !== userId
    ) {
      return { kind: 'challenge-ended' };
    }
    purpose = row.purpose;
  }
  // Story 6-1c (A8, A9) — a reset page's attempt: the token row, locked
  // AFTER the user (the user-then-token order everywhere), must be open,
  // unexpired, under its attempt limit and this user's.
  const resetId = typeof input.countOn === 'object' ? input.countOn.resetId : undefined;
  if (resetId !== undefined) {
    const rows = (await tx.execute(sql`
      select user_id, code_failures, (consumed_at is null and expires_at > now()) as open
        from password_resets
       where id = ${resetId} and tenant_id = ${input.tenantId}
       for update
    `)) as unknown as Array<{ user_id: string; code_failures: number; open: boolean }>;
    const row = rows[0];
    if (row === undefined || !row.open || row.code_failures >= MAX_SECOND_FACTOR_FAILURES || row.user_id !== userId) {
      return { kind: 'reset-ended' };
    }
  }

  if (user === undefined || user.status !== 'active') return { kind: 'challenge-ended' };
  if (user.locked) {
    return { kind: 'locked', retryAfterSeconds: user.locked_forever ? null : Number(user.retry_after) };
  }
  // The secret the code is checked against must exist (an enroll challenge
  // checks the pending one, a totp challenge the active one).
  const expectedSource: SecretSource = purpose === 'enroll' ? 'pending' : purpose === 'totp' ? 'active' : input.source;
  if (expectedSource !== input.source) return { kind: 'challenge-ended' };
  if (user.sealed === null || user.factor_seen === null || user.pending_stale === true) {
    return purpose === null ? { kind: 'no-factor' } : { kind: 'challenge-ended' };
  }
  // The secret must open BEFORE anything is counted: a key lost or rotated
  // away is the operator's fault, never the user's wrong code.
  let secret: Buffer;
  try {
    secret = openSecondFactorSecret(user.sealed, input.tenantId, userId);
  } catch (error) {
    logger.error(
      `Second-factor secret of user ${userId} (tenant ${input.tenantId}) does not open: ${error instanceof Error ? error.message : 'unknown error'} — is MFA_ENCRYPTION_KEY (or _PREVIOUS) the key it was sealed under?`,
    );
    return { kind: 'unavailable' };
  }
  // Backstop: a count already at the limit with no lock (a crash between the
  // count and the settle) locks now. Never on a reset page (A8: the user's
  // counters are honoured, never fed).
  if (resetId === undefined && user.mfa_failures >= MAX_SECOND_FACTOR_FAILURES) {
    const lock = await setLockInTx(tx, input.tenantId, userId);
    if (lock !== null) {
      await auditSecurityEventInTx(tx, {
        tenantId: input.tenantId,
        action: 'user.second_factor_locked',
        targetType: 'user',
        targetId: userId,
        actorUserId: null,
        reference: `ip:${input.ip}`,
      });
      return { kind: 'locked', retryAfterSeconds: lock.forever ? null : SECOND_FACTOR_LOCK_SECONDS };
    }
  }

  if (resetId !== undefined) {
    await tx.execute(sql`
      update password_resets set code_failures = code_failures + 1
       where id = ${resetId} and tenant_id = ${input.tenantId}
    `);
  } else {
    await tx.execute(sql`
      update users set mfa_failures = mfa_failures + 1, mfa_failed_since_success = mfa_failed_since_success + 1
       where tenant_id = ${input.tenantId} and id = ${userId}
    `);
  }
  if (input.challenge !== undefined) {
    await tx.execute(sql`
      update sign_in_challenges set failures = failures + 1
       where id = ${input.challenge.id} and tenant_id = ${input.tenantId}
    `);
  }
  const unused = input.allowBackupCode
    ? ((await tx.execute(sql`
        select code_hash from user_backup_codes
         where tenant_id = ${input.tenantId} and user_id = ${userId} and used_at is null
      `)) as unknown as Array<{ code_hash: string }>)
    : [];
  return {
    kind: 'counted',
    purpose,
    secret,
    factorSeen: user.factor_seen,
    unusedBackupHashes: unused.map((row) => row.code_hash),
    enrolCodeHash: user.mfa_enrol_code_hash,
    enrolCodeLive: user.enrol_code_live,
  };
}

/**
 * Sets the lock when the user's count has reached the limit and no lock is
 * live: 15 minutes, or permanent on the `HARD_LOCK_CYCLE`th cycle without a
 * success. Resets the count (the next cycle starts at zero).
 */
async function setLockInTx(tx: TenantTx, tenantId: string, userId: string): Promise<{ forever: boolean } | null> {
  const rows = (await tx.execute(sql`
    update users set
      mfa_lock_cycles = mfa_lock_cycles + 1,
      mfa_locked_until = case when mfa_lock_cycles + 1 >= ${HARD_LOCK_CYCLE} then 'infinity'::timestamptz
                              else now() + make_interval(secs => ${SECOND_FACTOR_LOCK_SECONDS}) end,
      mfa_failures = 0
     where tenant_id = ${tenantId} and id = ${userId}
       and mfa_failures >= ${MAX_SECOND_FACTOR_FAILURES}
       and (mfa_locked_until is null or mfa_locked_until <= now())
    returning (mfa_locked_until = 'infinity') as forever
  `)) as unknown as Array<{ forever: boolean }>;
  return rows[0] === undefined ? null : { forever: rows[0].forever };
}

/**
 * After a wrong code — at the check, or a reuse caught at commit: lock if the
 * count has reached the limit (audited once, by the statement that sets it),
 * and answer the attempts really left (0 once locked).
 */
async function settleWrongCode(
  db: Database,
  tenantId: string,
  userId: string,
  ip: string,
  challengeId: string | null,
): Promise<number> {
  return withTenantTransaction(db, tenantId, async (tx) => {
    const lock = await setLockInTx(tx, tenantId, userId);
    if (lock !== null) {
      await auditSecurityEventInTx(tx, {
        tenantId,
        action: 'user.second_factor_locked',
        targetType: 'user',
        targetId: userId,
        actorUserId: null,
        reference: `ip:${ip}`,
      });
      return 0;
    }
    const rows = (await tx.execute(sql`
      select u.mfa_failures,
             (select c.failures from sign_in_challenges c where c.tenant_id = u.tenant_id and c.id = ${challengeId}::uuid) as challenge_failures
        from users u where u.tenant_id = ${tenantId} and u.id = ${userId}
    `)) as unknown as Array<{ mfa_failures: number; challenge_failures: number | null }>;
    const row = rows[0];
    if (row === undefined) return 0;
    const userLeft = MAX_SECOND_FACTOR_FAILURES - row.mfa_failures;
    const challengeLeft = row.challenge_failures === null ? MAX_SECOND_FACTOR_FAILURES : MAX_SECOND_FACTOR_FAILURES - row.challenge_failures;
    return Math.max(0, Math.min(userLeft, challengeLeft));
  });
}

/**
 * Story 6-1c (A8) — after a wrong code on a reset page: the token's count
 * stands (tx1 committed it); the 5th spends the token. Answers the attempts
 * really left on it. The user's 2FA counters are untouched.
 */
async function settleWrongResetCode(db: Database, tenantId: string, resetId: string): Promise<number> {
  return withTenantTransaction(db, tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      update password_resets
         set consumed_at = case when code_failures >= ${MAX_SECOND_FACTOR_FAILURES} and consumed_at is null
                                then now() else consumed_at end
       where id = ${resetId} and tenant_id = ${tenantId}
      returning code_failures
    `)) as unknown as Array<{ code_failures: number }>;
    const row = rows[0];
    return row === undefined ? 0 : Math.max(0, MAX_SECOND_FACTOR_FAILURES - row.code_failures);
  });
}

/** A step already spent or a backup code already used, found under tx2's lock. */
class SecondFactorReuse extends Error {}

/**
 * tx2 and the route's work in one transaction (`commitSecondFactorInTx`, then
 * `work`). A reuse found at commit rolls the transaction back, then settles
 * exactly as a wrong code does (the tx1 count stands; the 5th locks) and
 * answers the attempts really left.
 */
export async function withCommittedFactor<T>(
  db: Database,
  verified: VerifiedFactor,
  options: { readonly stepRule: 'advance' | 'set'; readonly signIn: boolean },
  work: (tx: TenantTx, committed: CommittedFactor) => Promise<T>,
): Promise<T> {
  try {
    return await withTenantTransaction(db, verified.tenantId, async (tx) => work(tx, await commitSecondFactorInTx(tx, verified, options)));
  } catch (error) {
    if (!(error instanceof SecondFactorReuse)) throw error;
    const left =
      verified.resetId === undefined
        ? await settleWrongCode(db, verified.tenantId, verified.userId, verified.ip, verified.challenge?.id ?? null)
        : await settleWrongResetCode(db, verified.tenantId, verified.resetId);
    throw secondFactorInvalid(verified.invalidStatus, left, verified.invalidDetail);
  }
}

export interface CommittedFactor {
  /** Wrong codes since the last successful sign-in, this attempt excluded. */
  readonly failedSinceSuccess: number;
  readonly usedBackupCode: boolean;
}

/**
 * Step 4, in the CALLER's transaction (the route's work commits with it):
 * lock the user, then the challenge; re-check that the challenge is unspent,
 * the user active and the factor the one tx1 read; advance `mfa_last_step` to
 * the matched step (`set` — a new secret starts its own sequence — or
 * `advance`, monotonic: a spent step is a reuse) or spend the backup code;
 * consume the challenge; reset the counters. `signIn` also zeroes the
 * failed-since-success count (the response reports it).
 */
export async function commitSecondFactorInTx(
  tx: TenantTx,
  verified: VerifiedFactor,
  options: { readonly stepRule: 'advance' | 'set'; readonly signIn: boolean },
): Promise<CommittedFactor> {
  const { tenantId, userId } = verified;
  const users = (await tx.execute(sql`
    select status, mfa_failed_since_success,
           (case when ${verified.source}::text = 'active' then mfa_enabled_at else mfa_pending_created_at end)
             is not distinct from ${verified.factorSeen}::timestamptz as same_factor,
           (mfa_enabled_at is null) as not_enabled
      from users where tenant_id = ${tenantId} and id = ${userId}
      for update
  `)) as unknown as Array<{ status: string; mfa_failed_since_success: number; same_factor: boolean; not_enabled: boolean }>;
  const user = users[0];
  const ended = verified.challenge !== null ? challengeEnded : factorChanged;
  if (verified.challenge !== null) {
    const rows = (await tx.execute(sql`
      select consumed_at from sign_in_challenges where tenant_id = ${tenantId} and id = ${verified.challenge.id} for update
    `)) as unknown as Array<{ consumed_at: string | null }>;
    if (rows[0] === undefined || rows[0].consumed_at !== null) throw challengeEnded();
  }
  if (user === undefined || user.status !== 'active') throw ended();
  if (!user.same_factor) throw ended();
  // An enroll challenge completes only for a user still not enrolled.
  if (verified.challenge?.purpose === 'enroll' && !user.not_enabled) throw challengeEnded();

  let usedBackupCode = false;
  if (verified.match.kind === 'totp') {
    const step = verified.match.step;
    const advanced = (await tx.execute(
      options.stepRule === 'set'
        ? sql`update users set mfa_last_step = ${step} where tenant_id = ${tenantId} and id = ${userId} returning id`
        : sql`update users set mfa_last_step = ${step}
               where tenant_id = ${tenantId} and id = ${userId}
                 and (mfa_last_step is null or mfa_last_step < ${step})
              returning id`,
    )) as unknown as unknown[];
    if (advanced.length === 0) throw new SecondFactorReuse();
  } else {
    const spent = (await tx.execute(sql`
      update user_backup_codes set used_at = now()
       where tenant_id = ${tenantId} and user_id = ${userId} and used_at is null
         and code_hash in (${sql.join(verified.match.hashes.map((hash) => sql`${hash}`), sql`, `)})
      returning id
    `)) as unknown as Array<{ id: string }>;
    if (spent[0] === undefined) throw new SecondFactorReuse();
    usedBackupCode = true;
    await auditSecurityEventInTx(tx, {
      tenantId,
      action: 'user.backup_code_used',
      targetType: 'user',
      targetId: userId,
      actorUserId: userId,
      reference: `backup-code:${spent[0].id}`,
    });
  }
  if (verified.challenge !== null) {
    await tx.execute(sql`update sign_in_challenges set consumed_at = now() where tenant_id = ${tenantId} and id = ${verified.challenge.id}`);
  }
  const failedSinceSuccess = Math.max(0, user.mfa_failed_since_success - 1);
  // Story 6-1c (A8) — a reset page counted nothing on the user, so it resets
  // nothing on the user (a live lock was refused at tx1).
  if (verified.resetId !== undefined) return { failedSinceSuccess: user.mfa_failed_since_success, usedBackupCode };
  await tx.execute(sql`
    update users set mfa_failures = 0, mfa_lock_cycles = 0, mfa_locked_until = null,
                     mfa_failed_since_success = ${options.signIn ? 0 : failedSinceSuccess}
     where tenant_id = ${tenantId} and id = ${userId}
  `);
  return { failedSinceSuccess, usedBackupCode };
}

/**
 * The daily purge's 2FA block: challenges that expired over a day ago and
 * pending secrets older than 24 h. Tenants are found on the BYPASSRLS auth
 * connection; each tenant's writes run in its own transaction, in its own
 * try/catch (one tenant's failure never stops the rest).
 */
export async function purgeSecondFactorState(
  db: Database,
  authDb: Database,
  onError: (tenantId: string, error: unknown) => void,
): Promise<number> {
  const tenants = (await authDb.execute(sql`
    select tenant_id from sign_in_challenges where expires_at < now() - interval '1 day'
    union
    select tenant_id from users
     where mfa_pending_created_at < now() - make_interval(secs => ${PENDING_SECRET_SECONDS})
    order by 1
  `)) as unknown as Array<{ tenant_id: string }>;
  let purged = 0;
  for (const { tenant_id: tenantId } of tenants) {
    try {
      purged += await withTenantTransaction(db, tenantId, async (tx) => {
        const deleted = (await tx.execute(sql`
          delete from sign_in_challenges where tenant_id = ${tenantId} and expires_at < now() - interval '1 day' returning id
        `)) as unknown as unknown[];
        const cleared = (await tx.execute(sql`
          update users set mfa_pending_secret_sealed = null, mfa_pending_created_at = null
           where tenant_id = ${tenantId}
             and mfa_pending_created_at < now() - make_interval(secs => ${PENDING_SECRET_SECONDS})
          returning id
        `)) as unknown as unknown[];
        return deleted.length + cleared.length;
      });
    } catch (error) {
      onError(tenantId, error);
    }
  }
  return purged;
}
