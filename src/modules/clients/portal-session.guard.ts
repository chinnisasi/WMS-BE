import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { createParamDecorator, Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { tenantSessionSecret, verifyTenantSession } from '../tenancy/jwt-session';
import { getMemberPortalFactsIn } from '../tenancy/tenancy.service';
import { clientSuspended, readSessionClientIn } from './clients.facade';

/** Story 21-7 — what a portal route knows about its caller (re-read this request). */
export interface PortalSession {
  readonly userId: string;
  readonly tenantId: string;
  /** The client the database re-read confirmed — every portal read stamps it. */
  readonly clientId: string;
}

export interface PortalSessionRequest {
  headers: Record<string, unknown>;
  portalSession?: PortalSession;
}

/** Story 21-7 — the reverse fence's one refusal (exact detail pinned by test/portal.spec.ts). */
export const PORTAL_SURFACE_DETAIL = 'This is a client-portal surface.';

const BEARER_RE = /^bearer\s+(.+)$/i;

/**
 * Story 21-7 — the client-portal session guard (the clients module owns
 * portal scoping, 3PL architecture.md). It admits ONLY a web token carrying
 * a `client_id` claim — an operator token is refused 403 `role-denied`
 * ("This is a client-portal surface."), the mirror of the operator fence in
 * `TenantSessionGuard`.
 *
 * The claim is never trusted alone. Every request re-reads, inside a tenant
 * transaction stamped with the claimed client (`withTenantTransaction(db,
 * tenantId, …, { clientId })`, never the BYPASSRLS `AUTH_DATABASE`):
 *  - the user — missing, not `active`, or carrying another client → 401
 *    (the token no longer describes a portal user);
 *  - the client — not `active` → 403 `client-suspended`, so suspension
 *    bites on the next request, not at the 15-minute expiry.
 *
 * It then parks `{userId, tenantId, clientId}` on the request for
 * `@CurrentPortalSession()`. Tenant ownership of the path stays the
 * controller's `assertOwnTenant`.
 */
@Injectable()
export class PortalSessionGuard implements CanActivate {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PortalSessionRequest>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? BEARER_RE.exec(header) : null;
    if (match === null) {
      throw unauthenticated('A Bearer session token is required.');
    }
    const session = verifyTenantSession(match[1]!.trim(), tenantSessionSecret());
    if (session === null) {
      throw unauthenticated('The session token is invalid or expired.');
    }
    if (session.clientId === null) {
      throw new ProblemException('role-denied', 403, 'Role lacks the required capability', PORTAL_SURFACE_DETAIL);
    }
    const clientId = session.clientId;

    await withTenantTransaction(
      this.db,
      session.tenantId,
      async (tx) => {
        const user = await getMemberPortalFactsIn(tx, session.tenantId, session.userId);
        if (user === null || user.status !== 'active' || user.clientId !== clientId) {
          throw unauthenticated('The session no longer describes a client-portal user — sign in again.');
        }
        const client = await readSessionClientIn(tx, session.tenantId, clientId);
        if (client === null || client.status !== 'active') {
          throw clientSuspended();
        }
      },
      { clientId },
    );

    request.portalSession = { userId: session.userId, tenantId: session.tenantId, clientId };
    return true;
  }
}

/** Injects the portal session the guard verified and re-read. */
export const CurrentPortalSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PortalSession => {
    const request = context.switchToHttp().getRequest<PortalSessionRequest>();
    const session = request.portalSession;
    if (session === undefined) {
      throw unauthenticated('A Bearer session token is required.');
    }
    return session;
  },
);

function unauthenticated(detail: string): ProblemException {
  return new ProblemException('unauthenticated', 401, 'Authentication required', detail);
}
