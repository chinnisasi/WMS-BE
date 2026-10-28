import { sql } from 'drizzle-orm';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { isUuid } from '../../shared/primitives/ids';
import { hashSecret, sameHash } from './sessions';

/**
 * Story 6-1c — the password-reset token and its store (`password_resets`).
 *
 * Token `<id>.<secret>` (the 6-1b challenge precedent): the id names the row,
 * the secret (`newSecret()`, 256 bits; sha256 at rest, compared in constant
 * time) proves the holder. 60 minutes, single use; a user holds at most
 * `MAX_LIVE_RESETS` live tokens, and completing any one spends them all.
 * The id is looked up on the BYPASSRLS `AUTH_DATABASE` (the request carries
 * no tenant — the `sessionTenantOf` pattern); every write runs in the user's
 * tenant transaction. The raw token is never stored, logged, audited or
 * answered: it lives only in the sealed mail secret until the mail is final.
 */

export const RESET_TOKEN_SECONDS = 60 * 60;
/** Story 6-1c (A4) — live tokens per user; a sixth request spends the oldest. */
export const MAX_LIVE_RESETS = 5;
/** Story 6-1c (A4) — mails queued per user per rolling hour; over it the request is a silent 202. */
export const MAX_RESET_MAILS_PER_HOUR = 5;

export function resetTokenOf(id: string, secret: string): string {
  return `${id}.${secret}`;
}

export function parseResetToken(token: unknown): { readonly id: string; readonly secret: string } | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!isUuid(id) || !/^[A-Za-z0-9_-]{20,100}$/.test(secret)) return null;
  return { id, secret };
}

/** One answer for every unusable link: malformed, unknown, wrong secret, expired, spent, a user or client not active. */
export function resetLinkInvalid(): ProblemException {
  return new ProblemException(
    'reset-link-invalid',
    400,
    'Reset link not valid',
    'This link has expired or was already used. If you just set your password, sign in — otherwise ask for a new link.',
  );
}

/** An enrolled user's reset needs a code from the authenticator app (or a backup code). Nothing counted. */
export function secondFactorNeeded(): ProblemException {
  return new ProblemException(
    'second-factor-needed',
    422,
    'Two-factor code needed',
    'Enter a code from your authenticator app, or a backup code, to set a new password.',
  );
}

/** What the auth-connection lookup of a token finds (the row and its user), before any transaction. */
export interface LocatedReset {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  readonly clientId: string | null;
  readonly mfaEnabled: boolean;
  readonly expiresAt: string;
}

/**
 * The token, validated on the BYPASSRLS auth connection: the row exists, the
 * secret matches (constant time), it is unspent, unexpired and under its code
 * limit, and its user is `active`. A portal user's client is checked by the
 * caller. Null for every failure — one answer.
 */
export async function locateResetIn(
  authDb: Database,
  token: { readonly id: string; readonly secret: string },
): Promise<LocatedReset | null> {
  const rows = (await authDb.execute(sql`
    select r.id, r.tenant_id, r.user_id, r.secret_hash, r.expires_at::text as expires_at,
           (r.consumed_at is null and r.expires_at > now() and r.code_failures < 5) as open,
           u.email, u.status, u.client_id, (u.mfa_enabled_at is not null) as mfa_enabled
      from password_resets r
      join users u on u.id = r.user_id and u.tenant_id = r.tenant_id
     where r.id = ${token.id}
  `)) as unknown as Array<{
    id: string;
    tenant_id: string;
    user_id: string;
    secret_hash: string;
    expires_at: string;
    open: boolean;
    email: string;
    status: string;
    client_id: string | null;
    mfa_enabled: boolean;
  }>;
  const row = rows[0];
  if (row === undefined) return null;
  // The hash is compared before anything else is judged, so a wrong secret
  // and a spent token are indistinguishable.
  if (!sameHash(hashSecret(token.secret), row.secret_hash) || !row.open || row.status !== 'active') return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    email: row.email,
    clientId: row.client_id,
    mfaEnabled: row.mfa_enabled,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** Spends every open token of the user (a completed reset, a deactivation). The user row must already be locked. */
export async function spendOpenResetsInTx(tx: TenantTx, tenantId: string, userId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    update password_resets set consumed_at = now()
     where tenant_id = ${tenantId} and user_id = ${userId} and consumed_at is null
    returning id
  `)) as unknown as unknown[];
  return rows.length;
}

/**
 * The daily purge's reset block: tokens expired, or spent, over a day ago.
 * Tenants found on the BYPASSRLS auth connection; each tenant's delete in
 * its own transaction and try/catch; `beat` once per tenant.
 */
export async function purgeResetTokens(
  db: Database,
  authDb: Database,
  onError: (tenantId: string, error: unknown) => void,
  beat: () => void,
): Promise<number> {
  const stale = sql`(expires_at < now() - interval '1 day' or consumed_at < now() - interval '1 day')`;
  const tenants = (await authDb.execute(sql`
    select distinct tenant_id from password_resets where ${stale} order by tenant_id
  `)) as unknown as Array<{ tenant_id: string }>;
  let purged = 0;
  for (const { tenant_id: tenantId } of tenants) {
    beat();
    try {
      purged += await withTenantTransaction(db, tenantId, async (tx) => {
        const deleted = (await tx.execute(sql`
          delete from password_resets where tenant_id = ${tenantId} and ${stale} returning id
        `)) as unknown as unknown[];
        return deleted.length;
      });
    } catch (error) {
      onError(tenantId, error);
    }
  }
  return purged;
}
