import { Inject, Injectable } from '@nestjs/common';
import { AUTH_DATABASE, DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { decodeSignedPayload, SESSION_TTL_SECONDS, signTenantSession, tenantSessionSecret } from './jwt-session';
import { sessionEnded } from './session-cookie';
import {
  parseRefreshCookie,
  refreshCookieValue,
  refreshSecretMatchesInTx,
  refreshSessionInTx,
  revokeSessionsInTx,
  sessionTenantOf,
} from './sessions';

export interface RefreshResult {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresInSeconds: number;
  readonly refreshExpiresInSeconds: number;
  /** The rotated cookie value — null on a tab-race answer (the browser already holds the newer one). */
  readonly refreshCookie: string | null;
}

/**
 * Story 6-1a — the cookie-only session routes. Neither carries a tenant, so
 * the session's tenant is looked up by id on the BYPASSRLS auth connection
 * (`sessionTenantOf`) and every write runs in that tenant's RLS-scoped
 * transaction. Not keyed: refresh is a rotation the cookie itself
 * serialises (the row lock + the grace window), and sign-out is idempotent.
 */
@Injectable()
export class SessionCommand {
  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async refresh(cookie: string | null): Promise<RefreshResult> {
    const parsed = parseRefreshCookie(cookie);
    if (parsed === null) throw noSession();
    const tenantId = await sessionTenantOf(this.authDb, parsed.sessionId);
    if (tenantId === null) throw noSession();
    const outcome = await withTenantTransaction(this.db, tenantId, (tx) =>
      refreshSessionInTx(tx, tenantId, parsed.sessionId, parsed.secret),
    );
    if (!outcome.ok) {
      if (outcome.reason === 'invalid') throw noSession();
      throw sessionEnded(outcome.reason);
    }
    // The session's last second: nothing left to mint a token for.
    if (outcome.absoluteInSeconds <= 0) throw sessionEnded('absolute');
    const ttl = Math.min(SESSION_TTL_SECONDS, outcome.absoluteInSeconds);
    return {
      accessToken: signTenantSession(
        {
          tenantId,
          userId: outcome.userId,
          sessionId: parsed.sessionId,
          kind: outcome.kind,
          clientId: outcome.clientId,
          ttlSeconds: ttl,
        },
        tenantSessionSecret(),
      ),
      tokenType: 'Bearer',
      expiresInSeconds: ttl,
      refreshExpiresInSeconds: outcome.absoluteInSeconds,
      refreshCookie: outcome.refreshSecret === null ? null : refreshCookieValue(parsed.sessionId, outcome.refreshSecret),
    };
  }

  /**
   * Ends the caller's session. The session is named by the refresh cookie or,
   * failing that, by the bearer token's `sid` — read WITHOUT checking expiry
   * (signing out with an expired access token must work). Idempotent: no
   * session, or one already ended, is a quiet success.
   */
  async signOut(cookie: string | null, bearer: string | null): Promise<void> {
    // Code review — the cookie names a session only when its SECRET matches
    // (the `sid` is readable from any access token); a bearer names one only
    // through a valid signature (its expiry is not checked).
    const fromCookie = parseRefreshCookie(cookie);
    if (fromCookie !== null) {
      const tenantId = await sessionTenantOf(this.authDb, fromCookie.sessionId);
      if (tenantId !== null) {
        const ended = await withTenantTransaction(this.db, tenantId, async (tx) => {
          if (!(await refreshSecretMatchesInTx(tx, fromCookie.sessionId, fromCookie.secret))) return false;
          await revokeSessionsInTx(tx, tenantId, { sessionId: fromCookie.sessionId, kinds: ['web', 'portal'] }, 'signed-out');
          return true;
        });
        if (ended) return;
      }
    }
    if (bearer === null) return;
    const payload = decodeSignedPayload(bearer, tenantSessionSecret());
    if (payload === null || (payload.kind !== 'web' && payload.kind !== 'portal') || typeof payload.sid !== 'string') return;
    const sessionId = payload.sid;
    const tenantId = await sessionTenantOf(this.authDb, sessionId);
    if (tenantId === null) return;
    await withTenantTransaction(this.db, tenantId, (tx) =>
      revokeSessionsInTx(tx, tenantId, { sessionId, kinds: ['web', 'portal'] }, 'signed-out'),
    );
  }
}

function noSession(): ProblemException {
  return new ProblemException('unauthenticated', 401, 'Authentication required', 'There is no session to refresh — sign in.');
}
