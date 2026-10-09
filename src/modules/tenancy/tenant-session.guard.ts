import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { createParamDecorator, Injectable } from '@nestjs/common';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { verifyTenantSession, tenantSessionSecret, type TenantSession } from './jwt-session';

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
 * Session transport for operator endpoints (spec decision): a valid,
 * unexpired HS256 Bearer token minted by sign-in. Transport only — the token
 * proves *who* is calling; tenant-ownership of the path is enforced at the
 * controller boundary (`assertOwnTenant`), so any future non-HTTP caller of a
 * command service must bring its own authority check.
 */
@Injectable()
export class TenantSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TenantSessionRequest>();
    const header = request.headers.authorization;
    // The auth scheme is case-insensitive (RFC 7235 §5.1 — "bearer" is valid).
    const match = typeof header === 'string' ? /^bearer\s+(.+)$/i.exec(header) : null;
    if (match === null) {
      throw unauthenticated('A Bearer session token is required.');
    }
    const session = verifyTenantSession(match[1]!.trim(), tenantSessionSecret());
    if (!session) {
      throw unauthenticated('The session token is invalid or expired.');
    }
    // Story 21-7 — the fence: a client-portal token never opens an operator
    // route. One check here covers every route behind this guard, so no
    // per-controller copy can forget it.
    if (session.clientId !== null) {
      throw operatorSurfaceRefused();
    }
    request.tenantSession = session;
    return true;
  }
}

/** Story 21-7 — the fence's one refusal (exact detail pinned by test/portal.spec.ts). */
export const OPERATOR_SURFACE_DETAIL = 'This is an operator surface.';

export function operatorSurfaceRefused(): ProblemException {
  return new ProblemException(
    'role-denied',
    403,
    'Role lacks the required capability',
    OPERATOR_SURFACE_DETAIL,
  );
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