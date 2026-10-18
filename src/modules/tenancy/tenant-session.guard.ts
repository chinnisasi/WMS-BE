import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { createParamDecorator, Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../shared/db/tokens';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { verifyTenantSessionDetailed, tenantSessionSecret, type TenantSession } from './jwt-session';
import { sessionEnded, tokenExpired } from './session-cookie';
import { checkSessionInTx } from './sessions';

export interface TenantSessionRequest {
  headers: Record<string, unknown>;
  tenantSession?: TenantSession;
}

/** Injects the verified session claims (guard has populated them). */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantSession => {
    const request = context.switchToHttp().getRequest<TenantSessionRequest>();
    return requireTenantSession(request);
  },
);

/**
 * Session transport for operator endpoints: a valid HS256 access token of
 * kind `web`. Story 6-1a — the token is no longer trusted alone: every
 * request re-reads its server-side session and the user's status in a tenant
 * transaction (`checkSessionInTx`), so sign-out, deactivation, a role change
 * or the session's idle / absolute limit bites on the next request.
 *
 * Answers: no / malformed token → 401 `unauthenticated`; an expired access
 * token → 401 `token-expired` (a refresh fixes it); a pre-6-1a token or an
 * ended session → 401 `session-ended` with `reason`; a portal token → 403
 * (the 21-7 fence). Tenant ownership of the path stays the controller's
 * `assertOwnTenant`.
 */
@Injectable()
export class TenantSessionGuard implements CanActivate {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantSessionRequest>();
    request.tenantSession = await verifyWebRequest(this.db, request.headers, 'web');
    return true;
  }
}

const BEARER_RE = /^bearer\s+(.+)$/i;

/**
 * The shared web-family check (the operator guard, the portal guard and
 * `AnySessionGuard`'s web arm): token → kind → server-side session. `expect`
 * is the kind the route admits; the other kind is the caller's fence.
 */
export async function verifyWebRequest(
  db: Database,
  headers: Record<string, unknown>,
  expect: 'web' | 'portal',
): Promise<TenantSession> {
  const header = headers.authorization;
  // The auth scheme is case-insensitive (RFC 7235 §5.1 — "bearer" is valid).
  const match = typeof header === 'string' ? BEARER_RE.exec(header) : null;
  if (match === null) {
    throw unauthenticated('A Bearer session token is required.');
  }
  const verified = verifyTenantSessionDetailed(match[1]!.trim(), tenantSessionSecret());
  if (!verified.ok) {
    if (verified.failure === 'expired') throw tokenExpired();
    if (verified.failure === 'legacy') throw sessionEnded('legacy');
    throw unauthenticated('The session token is invalid.');
  }
  const session = verified.session;
  // Story 21-7 — the fences, before any database read.
  if (expect === 'web' && session.kind !== 'web') throw operatorSurfaceRefused();
  if (expect === 'portal' && session.kind !== 'portal') throw portalSurfaceRefused();

  const check = await withTenantTransaction(
    db,
    session.tenantId,
    (tx) =>
      checkSessionInTx(tx, {
        tenantId: session.tenantId,
        sessionId: session.sessionId,
        userId: session.userId,
        kind: session.kind,
      }),
    session.clientId === null ? {} : { clientId: session.clientId },
  );
  if (!check.ok) {
    if (check.reason === 'invalid') throw unauthenticated('The session token is invalid.');
    throw sessionEnded(check.reason);
  }
  return session;
}

/** Story 21-7 — the fence's one refusal (exact detail pinned by test/portal.spec.ts). */
export const OPERATOR_SURFACE_DETAIL = 'This is an operator surface.';

/** Story 21-7 — the reverse fence's one refusal (exact detail pinned by test/portal.spec.ts). */
export const PORTAL_SURFACE_DETAIL = 'This is a client-portal surface.';

export function operatorSurfaceRefused(): ProblemException {
  return new ProblemException(
    'role-denied',
    403,
    'Role lacks the required capability',
    OPERATOR_SURFACE_DETAIL,
  );
}

export function portalSurfaceRefused(): ProblemException {
  return new ProblemException('role-denied', 403, 'Role lacks the required capability', PORTAL_SURFACE_DETAIL);
}

export function requireTenantSession(request: TenantSessionRequest): TenantSession {
  const session = request.tenantSession;
  if (!session) {
    throw unauthenticated('A Bearer session token is required.');
  }
  return session;
}

function unauthenticated(detail: string): ProblemException {
  return new ProblemException('unauthenticated', 401, 'Authentication required', detail);
}
