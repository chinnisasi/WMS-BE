import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../shared/db/db';
import { isUuid } from '../../shared/primitives/ids';
import { sessions } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';

/**
 * Story 6-1a — server-side sessions. One `sessions` row per web, portal and
 * badge-in session; the access token carries its id (`sid`) and every guard
 * re-reads the row and the user's status (`checkSessionInTx`), so a
 * revocation — sign-out, deactivation, role change, client suspend, device
 * revoke or release — bites on the next request. Every time comparison is
 * the database's `now()` (one clock).
 *
 * Connections: the guards call `checkSessionInTx` inside a tenant-scoped
 * transaction (RLS). The cookie-only paths (refresh, sign-out) learn the
 * tenant from `sessionTenantOf` on the BYPASSRLS `AUTH_DATABASE`, then do
 * every write in a tenant-scoped transaction on `DATABASE`.
 */

export const SESSION_KINDS = ['web', 'portal', 'badge'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** The stored revoke reasons — pinned against `sessions_revoked_reason_check` (0074). */
export const SESSION_REVOKE_REASONS = [
  'signed-out',
  'deactivated',
  'role-changed',
  'client-suspended',
  'refresh-reuse',
  'released',
  'device-revoked',
] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

/**
 * The wire `reason` on a session-ended 401: a stored revoke reason, or one
 * derived at read time — `idle`, `absolute` (the session's limits),
 * `legacy` (a pre-6-1a token naming no session).
 */
export const SESSION_END_REASONS = [...SESSION_REVOKE_REASONS, 'idle', 'absolute', 'legacy'] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/** Story 6-1a decision 1 — the limits, as constants. `idleSeconds: null` = no idle limit. */
export const SESSION_LIMITS: Record<SessionKind, { readonly idleSeconds: number | null; readonly absoluteSeconds: number }> = {
  web: { idleSeconds: 2 * 60 * 60, absoluteSeconds: 12 * 60 * 60 },
  portal: { idleSeconds: 2 * 60 * 60, absoluteSeconds: 7 * 24 * 60 * 60 },
  badge: { idleSeconds: null, absoluteSeconds: 12 * 60 * 60 },
};

/** A rotated refresh token presented within this window is a tab race, not reuse. */
export const REFRESH_GRACE_SECONDS = 30;

/** `last_used_at` / the idle window move at most once a minute (write amplification). */
const TOUCH_INTERVAL_SECONDS = 60;

/** Session rows ended this long ago are purged by the daily job. */
export const SESSION_RETENTION_DAYS = 30;

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function seconds(n: number) {
  return sql`make_interval(secs => ${n})`;
}

export interface CreatedSession {
  readonly sessionId: string;
  /** The plaintext refresh secret (web / portal only) — goes into the cookie, never stored. */
  readonly refreshSecret: string | null;
  /** Seconds until the session's absolute end, by the database clock. */
  readonly absoluteInSeconds: number;
}

export async function createSessionInTx(
  tx: TenantTx,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly kind: SessionKind;
    readonly deviceId?: string | null;
    readonly clientId?: string | null;
  },
): Promise<CreatedSession> {
  const limits = SESSION_LIMITS[input.kind];
  const refreshSecret = input.kind === 'badge' ? null : newSecret();
  const idleSeconds = limits.idleSeconds ?? limits.absoluteSeconds;
  const rows = await tx
    .insert(sessions)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      kind: input.kind,
      deviceId: input.deviceId ?? null,
      clientId: input.clientId ?? null,
      refreshHash: refreshSecret === null ? null : hashSecret(refreshSecret),
      idleExpiresAt: sql`now() + ${seconds(Math.min(idleSeconds, limits.absoluteSeconds))}`,
      absoluteExpiresAt: sql`now() + ${seconds(limits.absoluteSeconds)}`,
    })
    .returning({ id: sessions.id });
  return { sessionId: rows[0]!.id, refreshSecret, absoluteInSeconds: limits.absoluteSeconds };
}

export type SessionCheck =
  | { readonly ok: true; readonly absoluteInSeconds: number }
  | { readonly ok: false; readonly reason: SessionEndReason | 'invalid' };

/**
 * The guard's per-request check, inside the caller's tenant transaction.
 * `invalid` — no such session, or one that does not match the token (another
 * user, another kind, another device); otherwise the first reason the session
 * is over, in order: revoked → user not active (`deactivated`) → `absolute` →
 * `idle`. A live session's idle window slides forward (at most once a minute).
 */
export async function checkSessionInTx(
  tx: TenantTx,
  input: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly userId: string;
    readonly kind: SessionKind;
    readonly deviceId?: string;
  },
): Promise<SessionCheck> {
  const rows = (await tx.execute(sql`
    select s.user_id, s.kind, s.device_id, s.revoked_reason,
           u.status as user_status,
           (now() >= s.absolute_expires_at) as absolute_over,
           (now() >= s.idle_expires_at) as idle_over,
           greatest(0, floor(extract(epoch from (s.absolute_expires_at - now()))))::int as absolute_in
      from sessions s
      left join users u on u.id = s.user_id and u.tenant_id = s.tenant_id
     where s.id = ${input.sessionId} and s.tenant_id = ${input.tenantId}
  `)) as unknown as Array<{
    user_id: string;
    kind: string;
    device_id: string | null;
    revoked_reason: string | null;
    user_status: string | null;
    absolute_over: boolean;
    idle_over: boolean;
    absolute_in: number;
  }>;
  const row = rows[0];
  if (row === undefined || row.user_id !== input.userId || row.kind !== input.kind) {
    return { ok: false, reason: 'invalid' };
  }
  if (input.deviceId !== undefined && row.device_id !== input.deviceId) {
    return { ok: false, reason: 'invalid' };
  }
  if (row.revoked_reason !== null) return { ok: false, reason: row.revoked_reason as SessionRevokeReason };
  if (row.user_status !== 'active') return { ok: false, reason: 'deactivated' };
  if (row.absolute_over) return { ok: false, reason: 'absolute' };
  if (row.idle_over) return { ok: false, reason: 'idle' };

  const idleSeconds = SESSION_LIMITS[input.kind].idleSeconds;
  if (idleSeconds !== null) {
    await tx.execute(sql`
      update sessions
         set last_used_at = now(),
             idle_expires_at = least(now() + ${seconds(idleSeconds)}, absolute_expires_at)
       where id = ${input.sessionId}
         and last_used_at < now() - ${seconds(TOUCH_INTERVAL_SECONDS)}
    `);
  }
  return { ok: true, absoluteInSeconds: row.absolute_in };
}

export interface RevokeFilter {
  readonly sessionId?: string;
  readonly userId?: string;
  readonly clientId?: string;
  readonly deviceId?: string;
  readonly kinds?: readonly SessionKind[];
}

/**
 * The one revocation seam (tenancy-owned, exported for the clients module's
 * suspend): ends every live session of the tenant matching the filter. At
 * least one of session / user / client / device must be named.
 */
export async function revokeSessionsInTx(
  tx: TenantTx,
  tenantId: string,
  filter: RevokeFilter,
  reason: SessionRevokeReason,
): Promise<number> {
  const conditions = [eq(sessions.tenantId, tenantId), isNull(sessions.revokedAt)];
  if (filter.sessionId !== undefined) conditions.push(eq(sessions.id, filter.sessionId));
  if (filter.userId !== undefined) conditions.push(eq(sessions.userId, filter.userId));
  if (filter.clientId !== undefined) conditions.push(eq(sessions.clientId, filter.clientId));
  if (filter.deviceId !== undefined) conditions.push(eq(sessions.deviceId, filter.deviceId));
  if (filter.kinds !== undefined) conditions.push(inArray(sessions.kind, [...filter.kinds]));
  if (
    filter.sessionId === undefined &&
    filter.userId === undefined &&
    filter.clientId === undefined &&
    filter.deviceId === undefined
  ) {
    throw new Error('revokeSessionsInTx: name a session, user, client or device');
  }
  const revoked = await tx
    .update(sessions)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(...conditions))
    .returning({ id: sessions.id });
  return revoked.length;
}

/**
 * Code review — does this secret belong to the session (its current or its
 * previous refresh token)? Sign-out by cookie checks it: the `sid` alone is
 * readable from any access token and must not be enough to end a session.
 */
export async function refreshSecretMatchesInTx(tx: TenantTx, sessionId: string, secret: string): Promise<boolean> {
  const rows = await tx
    .select({ current: sessions.refreshHash, previous: sessions.prevRefreshHash })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return false;
  const presented = hashSecret(secret);
  return (row.current !== null && sameHash(presented, row.current)) || (row.previous !== null && sameHash(presented, row.previous));
}

/** Code review — does the device hold a badge session that is still live (not revoked, not past its end)? */
export async function hasLiveBadgeSessionInTx(tx: TenantTx, tenantId: string, deviceId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    select 1 from sessions
     where tenant_id = ${tenantId} and device_id = ${deviceId} and kind = 'badge'
       and revoked_at is null and absolute_expires_at > now()
     limit 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** The refresh cookie's value: `<sid>.<secret>`. */
export function parseRefreshCookie(value: unknown): { sessionId: string; secret: string } | null {
  if (typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const sessionId = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (!isUuid(sessionId) || !/^[A-Za-z0-9_-]{20,100}$/.test(secret)) return null;
  return { sessionId, secret };
}

export function refreshCookieValue(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

/**
 * The cookie-only paths' tenant lookup (refresh, sign-out): which tenant owns
 * this session id. Reads through the BYPASSRLS auth connection — the request
 * carries no tenant — and nothing else; every write follows in a tenant
 * transaction.
 */
export async function sessionTenantOf(authDb: Database, sessionId: string): Promise<string | null> {
  const rows = await authDb
    .select({ tenantId: sessions.tenantId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return rows[0]?.tenantId ?? null;
}

export type RefreshOutcome =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly kind: 'web' | 'portal';
      readonly clientId: string | null;
      /** The new refresh secret — null on a grace-window answer (the browser already holds the newer cookie). */
      readonly refreshSecret: string | null;
      readonly absoluteInSeconds: number;
    }
  | { readonly ok: false; readonly reason: SessionEndReason | 'invalid' };

/**
 * Rotates a web / portal refresh token under the session row's lock:
 *  - the current secret → rotate (new secret; the old hash kept as `prev`);
 *  - the previous secret within `REFRESH_GRACE_SECONDS` of the rotation → a
 *    tab race: a fresh access token, NO new cookie (the browser's jar already
 *    holds the rotated one);
 *  - the previous secret after the window → reuse: the session is revoked
 *    `refresh-reuse` (both holders signed out);
 *  - anything else → `invalid`, nothing revoked (the `sid` is readable from
 *    any access token, so an unknown secret must not be able to end a
 *    session).
 * Refresh never extends the idle window — only a guarded request does.
 */
export async function refreshSessionInTx(
  tx: TenantTx,
  tenantId: string,
  sessionId: string,
  secret: string,
): Promise<RefreshOutcome> {
  const rows = (await tx.execute(sql`
    select s.user_id, s.kind, s.client_id, s.refresh_hash, s.prev_refresh_hash, s.revoked_reason,
           u.status as user_status,
           (now() >= s.absolute_expires_at) as absolute_over,
           (now() >= s.idle_expires_at) as idle_over,
           (s.rotated_at is not null and s.rotated_at > now() - ${seconds(REFRESH_GRACE_SECONDS)}) as in_grace,
           greatest(0, floor(extract(epoch from (s.absolute_expires_at - now()))))::int as absolute_in
      from sessions s
      left join users u on u.id = s.user_id and u.tenant_id = s.tenant_id
     where s.id = ${sessionId} and s.tenant_id = ${tenantId}
       for update of s
  `)) as unknown as Array<{
    user_id: string;
    kind: string;
    client_id: string | null;
    refresh_hash: string | null;
    prev_refresh_hash: string | null;
    revoked_reason: string | null;
    user_status: string | null;
    absolute_over: boolean;
    idle_over: boolean;
    in_grace: boolean;
    absolute_in: number;
  }>;
  const row = rows[0];
  if (row === undefined || (row.kind !== 'web' && row.kind !== 'portal') || row.refresh_hash === null) {
    return { ok: false, reason: 'invalid' };
  }
  const presented = hashSecret(secret);
  const isCurrent = sameHash(presented, row.refresh_hash);
  const isPrevious = row.prev_refresh_hash !== null && sameHash(presented, row.prev_refresh_hash);
  if (!isCurrent && !isPrevious) return { ok: false, reason: 'invalid' };

  if (row.revoked_reason !== null) return { ok: false, reason: row.revoked_reason as SessionRevokeReason };
  if (row.user_status !== 'active') return { ok: false, reason: 'deactivated' };
  if (row.absolute_over) return { ok: false, reason: 'absolute' };
  if (row.idle_over) return { ok: false, reason: 'idle' };

  const kind = row.kind;
  if (isPrevious) {
    if (row.in_grace) {
      return { ok: true, userId: row.user_id, kind, clientId: row.client_id, refreshSecret: null, absoluteInSeconds: row.absolute_in };
    }
    await revokeSessionsInTx(tx, tenantId, { sessionId }, 'refresh-reuse');
    return { ok: false, reason: 'refresh-reuse' };
  }
  const next = newSecret();
  await tx
    .update(sessions)
    .set({ refreshHash: hashSecret(next), prevRefreshHash: row.refresh_hash, rotatedAt: sql`now()` })
    .where(eq(sessions.id, sessionId));
  return { ok: true, userId: row.user_id, kind, clientId: row.client_id, refreshSecret: next, absoluteInSeconds: row.absolute_in };
}

const ENDED_LONG_AGO = sql`(revoked_at is not null and revoked_at < now() - make_interval(days => ${SESSION_RETENTION_DAYS}))
    or absolute_expires_at < now() - make_interval(days => ${SESSION_RETENTION_DAYS})`;

/**
 * The daily purge: session rows that ended more than `SESSION_RETENTION_DAYS`
 * ago. The tenants holding such rows are found cross-tenant on the read-only
 * BYPASSRLS auth connection (the worker precedent); each delete runs in that
 * tenant's own RLS-scoped transaction.
 */
export async function purgeEndedSessions(db: Database, authDb: Database): Promise<number> {
  const tenants = (await authDb.execute(sql`
    select distinct tenant_id as "tenantId" from sessions where ${ENDED_LONG_AGO} order by tenant_id
  `)) as unknown as Array<{ tenantId: string }>;
  let purged = 0;
  for (const { tenantId } of tenants) {
    purged += await withTenantTransaction(db, tenantId, async (tx) => {
      const deleted = (await tx.execute(sql`
        delete from sessions where tenant_id = ${tenantId} and (${ENDED_LONG_AGO}) returning id
      `)) as unknown as unknown[];
      return deleted.length;
    });
  }
  return purged;
}
