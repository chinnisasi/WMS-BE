import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../../shared/db/db';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * Story 6-1a — lockout and attempt limits, all in Postgres (never memory).
 *
 * Every count is taken BEFORE the expensive check (scrypt) in its own
 * committed statement — an atomic `insert … on conflict … returning` — so a
 * failure is never rolled back by the refusal that follows it, and parallel
 * guesses cannot all slip past an unlocked counter (each one counts first).
 * A success resets the counter.
 *
 * - Password (A3): keyed on (sha256 of the normalised email, client IP),
 *   whether or not the account exists — an unknown email locks exactly like
 *   a real one, and an attacker elsewhere cannot lock an owner out of their
 *   own network.
 * - PIN (A1): keyed on the device — the PIN is the device's.
 * - Attempt limits (A2): sign-in per client IP, badge-in per device; fixed
 *   one-minute windows in `auth_rate_limits`.
 */

export const MAX_CONSECUTIVE_FAILURES = 5;
export const LOCK_SECONDS = 15 * 60;
export const SIGNIN_LIMIT_PER_IP_PER_MINUTE = 300;
export const BADGE_IN_LIMIT_PER_DEVICE_PER_MINUTE = 30;

export function emailDigest(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

export function signInLocked(retryAfterSeconds: number): ProblemException {
  return new ProblemException(
    'sign-in-locked',
    423,
    'Sign-in locked',
    `Too many failed sign-in attempts. Try again in ${minutesText(retryAfterSeconds)}.`,
    { retryAfterSeconds },
  );
}

export function badgeLocked(retryAfterSeconds: number): ProblemException {
  return new ProblemException(
    'badge-locked',
    423,
    'Badge-in locked',
    `Too many wrong PINs on this device. Try again in ${minutesText(retryAfterSeconds)}.`,
    { retryAfterSeconds },
  );
}

export function rateLimited(retryAfterSeconds: number): ProblemException {
  return new ProblemException(
    'rate-limited',
    429,
    'Too many attempts',
    `Too many attempts. Try again in ${retryAfterSeconds} seconds.`,
    { retryAfterSeconds },
  );
}

function minutesText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * One hit on a fixed one-minute window. Throws 429 `rate-limited` past the
 * limit. Autocommitted on its own (no surrounding transaction).
 */
export async function hitRateLimit(db: Database, bucket: string, limit: number): Promise<void> {
  const rows = (await db.execute(sql`
    insert into auth_rate_limits (bucket, window_start, count)
    values (${bucket}, date_trunc('minute', now()), 1)
    on conflict (bucket) do update set
      count = case when auth_rate_limits.window_start = date_trunc('minute', now())
                   then auth_rate_limits.count + 1 else 1 end,
      window_start = date_trunc('minute', now())
    returning count,
      greatest(1, ceil(extract(epoch from (date_trunc('minute', now()) + interval '1 minute' - now()))))::int as retry_after
  `)) as unknown as Array<{ count: number; retry_after: number }>;
  const row = rows[0]!;
  if (row.count > limit) throw rateLimited(row.retry_after);
}

type Counted = { failures: number; locked: boolean; retry_after: number };

/**
 * Counts a sign-in attempt for (email, IP) before the password is checked.
 * A lapsed lock starts a fresh count. Throws 423 while locked, and locks (and
 * throws) when this attempt is past the limit — a parallel burst never
 * reaches scrypt.
 */
export interface AttemptCount {
  /** The pair is locked now (this attempt is refused 423). */
  readonly locked: boolean;
  readonly retryAfterSeconds: number;
  /** This very attempt set the lock (code review C11 — audited once, at the transition). */
  readonly newlyLocked: boolean;
}

export async function countSignInAttempt(db: Database, email: string, ip: string): Promise<AttemptCount> {
  const rows = (await db.execute(sql`
    insert into signin_attempts (email_hash, ip, failures, updated_at)
    values (${emailDigest(email)}, ${ip}, 1, now())
    on conflict (email_hash, ip) do update set
      failures = case when signin_attempts.locked_until is not null and signin_attempts.locked_until <= now()
                      then 1 else signin_attempts.failures + 1 end,
      locked_until = case when signin_attempts.locked_until is not null and signin_attempts.locked_until <= now()
                          then null
                          when signin_attempts.locked_until is null and signin_attempts.failures + 1 > ${MAX_CONSECUTIVE_FAILURES}
                          then now() + make_interval(secs => ${LOCK_SECONDS})
                          else signin_attempts.locked_until end,
      updated_at = now()
    returning failures,
      (locked_until is not null and locked_until > now()) as locked,
      -- Set by THIS statement: now() is fixed for the transaction, so a lock
      -- set earlier carries an earlier instant.
      (locked_until = now() + make_interval(secs => ${LOCK_SECONDS})) as newly_locked,
      coalesce(greatest(1, ceil(extract(epoch from (locked_until - now())))), 0)::int as retry_after
  `)) as unknown as Array<Counted & { newly_locked: boolean }>;
  const row = rows[0]!;
  return { locked: row.locked, retryAfterSeconds: row.retry_after, newlyLocked: row.newly_locked };
}

/** A wrong password on the attempt that reached the limit locks the pair. */
export async function settleSignInFailure(db: Database, email: string, ip: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    update signin_attempts
       set locked_until = now() + make_interval(secs => ${LOCK_SECONDS}), updated_at = now()
     where email_hash = ${emailDigest(email)} and ip = ${ip}
       and locked_until is null and failures >= ${MAX_CONSECUTIVE_FAILURES}
    returning ip
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** A correct password resets the pair's count. */
export async function clearSignInAttempts(db: Database, email: string, ip: string): Promise<void> {
  await db.execute(sql`delete from signin_attempts where email_hash = ${emailDigest(email)} and ip = ${ip}`);
}

/** The owner's Unlock (and the CLI fallback): every IP's count for this email. Returns rows cleared. */
export async function unlockSignIn(db: Database, email: string): Promise<number> {
  const rows = (await db.execute(sql`
    delete from signin_attempts where email_hash = ${emailDigest(email)} returning ip
  `)) as unknown as unknown[];
  return rows.length;
}

/** Is any lock on this email live? (The Team card's `lockedUntil`.) */
export async function signInLockedUntil(db: Database, emails: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (emails.length === 0) return out;
  const digests = emails.map((email) => emailDigest(email));
  const rows = (await db.execute(sql`
    select email_hash, max(locked_until)::text as locked_until
      from signin_attempts
     where email_hash in (${sql.join(digests.map((d) => sql`${d}`), sql`, `)})
       and locked_until > now()
     group by email_hash
  `)) as unknown as Array<{ email_hash: string; locked_until: string }>;
  const byDigest = new Map(rows.map((row) => [row.email_hash, row.locked_until]));
  for (const email of emails) {
    const until = byDigest.get(emailDigest(email));
    if (until !== undefined) out.set(email, new Date(until).toISOString());
  }
  return out;
}

/**
 * Counts a badge-in PIN attempt on the device (in the caller's tenant
 * transaction, which must COMMIT before the PIN is checked). Same rules as
 * the password count.
 */
export async function countBadgeInAttemptInTx(tx: TenantTx, tenantId: string, deviceId: string): Promise<AttemptCount> {
  const rows = (await tx.execute(sql`
    update devices set
      failed_badge_ins = case when badge_locked_until is not null and badge_locked_until <= now()
                              then 1 else failed_badge_ins + 1 end,
      badge_locked_until = case when badge_locked_until is not null and badge_locked_until <= now()
                                then null
                                when badge_locked_until is null and failed_badge_ins + 1 > ${MAX_CONSECUTIVE_FAILURES}
                                then now() + make_interval(secs => ${LOCK_SECONDS})
                                else badge_locked_until end
     where tenant_id = ${tenantId} and id = ${deviceId}
    returning failed_badge_ins as failures,
      (badge_locked_until is not null and badge_locked_until > now()) as locked,
      (badge_locked_until = now() + make_interval(secs => ${LOCK_SECONDS})) as newly_locked,
      coalesce(greatest(1, ceil(extract(epoch from (badge_locked_until - now())))), 0)::int as retry_after
  `)) as unknown as Array<Counted & { newly_locked: boolean }>;
  const row = rows[0];
  if (row === undefined) return { locked: false, retryAfterSeconds: 0, newlyLocked: false };
  return { locked: row.locked, retryAfterSeconds: row.retry_after, newlyLocked: row.newly_locked };
}

export async function settleBadgeInFailureInTx(tx: TenantTx, tenantId: string, deviceId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    update devices set badge_locked_until = now() + make_interval(secs => ${LOCK_SECONDS})
     where tenant_id = ${tenantId} and id = ${deviceId}
       and badge_locked_until is null and failed_badge_ins >= ${MAX_CONSECUTIVE_FAILURES}
    returning id
  `)) as unknown as unknown[];
  return rows.length > 0;
}

export async function clearBadgeInAttemptsInTx(tx: TenantTx, tenantId: string, deviceId: string): Promise<void> {
  await tx.execute(sql`
    update devices set failed_badge_ins = 0, badge_locked_until = null
     where tenant_id = ${tenantId} and id = ${deviceId}
  `);
}

/** Purges rate-limit windows older than a day (the daily session purge calls it). */
export async function purgeAuthCounters(db: Database): Promise<void> {
  await db.execute(sql`delete from auth_rate_limits where window_start < now() - interval '1 day'`);
  await db.execute(sql`
    delete from signin_attempts
     where updated_at < now() - interval '1 day' and (locked_until is null or locked_until < now())
  `);
}

/**
 * The caller's address. Behind a proxy, `TRUSTED_PROXY_HOPS` (default 0)
 * names how many trusted hops append to `X-Forwarded-For`; the address that
 * many entries from the right is the client. With 0 hops the header is
 * ignored (a client could forge it) and the socket address is used.
 */
export function clientIpOf(request: {
  headers: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '0', 10);
  if (Number.isInteger(hops) && hops > 0) {
    const header = request.headers['x-forwarded-for'];
    const raw = Array.isArray(header) ? header.join(',') : typeof header === 'string' ? header : '';
    const chain = raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
    const candidate = chain[chain.length - hops];
    if (candidate !== undefined) return normaliseIp(candidate);
  }
  return normaliseIp(request.socket?.remoteAddress ?? request.ip ?? 'unknown');
}

/** An IPv4 address seen through an IPv6 socket (`::ffff:a.b.c.d`) keys as `a.b.c.d`. */
function normaliseIp(address: string): string {
  return address.startsWith('::ffff:') && address.includes('.') ? address.slice('::ffff:'.length) : address;
}
