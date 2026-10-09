import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { createParamDecorator, Injectable } from '@nestjs/common';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import {
  tenantSessionSecret,
  verifyDeviceSession,
  verifyTenantSession,
  type DeviceSession,
  type TenantSession,
} from './jwt-session';
import { operatorSurfaceRefused } from './tenant-session.guard';

export interface AnySessionRequest {
  headers: Record<string, unknown>;
  anySession?: AnySession;
}

/**
 * One route, either session family (Story 12-8, UX-DR30): the excursion
 * record route accepts a WEB session (the 12-5 surface, unchanged) or a
 * DEVICE session (the floor's arm). The branch key is frozen and
 * load-bearing — the **presence of the `device_id` claim**, read from the
 * token's unverified payload. Before 21-7 a badge-in token also verified
 * under the tenant-JWT verifier (the PENDING-1 accident), so a composite that
 * tried the tenant family first would have routed device tokens down the web
 * arm; since 21-7 `verifyTenantSession` refuses any token carrying
 * `device_id`. Branching on the claim routes device tokens to device semantics (the command re-resolves
 * the device row in its tenant transaction, so revocation works) and web
 * tokens to web semantics; both verifiers reject the other family by shape.
 */
export type AnySession =
  | { readonly family: 'device'; readonly session: DeviceSession }
  | { readonly family: 'web'; readonly session: TenantSession };

const BEARER_RE = /^bearer\s+(.+)$/i;

/**
 * True when the token's UNVERIFIED payload carries a `device_id` claim. The
 * signature is still verified by the family verifier this predicate selects —
 * an attacker cannot steer a forged token anywhere: a tampered payload breaks
 * the HMAC and both verifiers reject it.
 */
function tokenCarriesDeviceClaim(token: string): boolean {
  const payloadPart = token.split('.')[1];
  if (payloadPart === undefined) return false;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return 'device_id' in payload;
  } catch {
    return false;
  }
}

@Injectable()
export class AnySessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AnySessionRequest>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? BEARER_RE.exec(header) : null;
    if (match === null) {
      throw unauthenticated('A Bearer session token is required (web or device).');
    }
    const token = match[1]!.trim();
    const secret = tenantSessionSecret();
    const session: AnySession | null = tokenCarriesDeviceClaim(token)
      ? mapNullable('device', verifyDeviceSession(token, secret))
      : mapNullable('web', verifyTenantSession(token, secret));
    if (session === null) {
      throw unauthenticated('The session token is invalid or expired.');
    }
    // Story 21-7 — the fence on the web arm (the device verifier already
    // rejects any token carrying `client_id`).
    if (session.family === 'web' && session.session.clientId !== null) {
      throw operatorSurfaceRefused();
    }
    request.anySession = session;
    return true;
  }
}

/** Injects the verified session of either family, tagged with its family. */
export const CurrentAnySession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AnySession => {
    const request = context.switchToHttp().getRequest<AnySessionRequest>();
    const session = request.anySession;
    if (session === undefined) {
      throw unauthenticated('A Bearer session token is required (web or device).');
    }
    return session;
  },
);

function unauthenticated(detail: string): ProblemException {
  return new ProblemException('unauthenticated', 401, 'Authentication required', detail);
}

/** Lifts a verifier's nullable result into the tagged union — null stays null. */
function mapNullable<F extends 'device' | 'web'>(
  family: F,
  session: F extends 'device' ? DeviceSession | null : TenantSession | null,
): AnySession | null {
  if (session === null) return null;
  return { family, session } as AnySession;
}