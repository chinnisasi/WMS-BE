import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { createParamDecorator, Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../shared/db/tokens';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import {
  verifyDeviceSessionDetailed,
  tenantSessionSecret,
  type DeviceSession,
} from './jwt-session';
import { deviceSessionEnded } from './session-cookie';
import { checkSessionInTx } from './sessions';

export interface DeviceSessionRequest {
  headers: Record<string, unknown>;
  deviceSession?: DeviceSession;
}

/** Injects the verified device-token claims (guard has populated them). */
export const CurrentDeviceSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): DeviceSession => {
    const request = context.switchToHttp().getRequest<DeviceSessionRequest>();
    return requireDeviceSession(request);
  },
);

/**
 * Session transport for device endpoints (Story 3.2): a valid, unexpired
 * HS256 device token minted at enrollment or badge-in. **Transport only** —
 * the token proves who is calling; authority is re-resolved server-side on
 * every request: the device row (fail-closed — unknown/revoked device → 403
 * `device-revoked`) and the operator's role (re-read from the DB per
 * command). Resolution happens in the command service's tenant transaction,
 * not here (the guard has no tenant scope of its own).
 */
@Injectable()
export class DeviceSessionGuard implements CanActivate {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DeviceSessionRequest>();
    request.deviceSession = await verifyDeviceRequest(this.db, request.headers);
    return true;
  }
}

/**
 * Story 6-1a — the device-family check shared with `AnySessionGuard`. A
 * device credential (`kind: device`, or the pre-6-1a no-`kind` shape) has no
 * session — its authority is the device row the command re-reads. A badge
 * token's server-side session is re-read here (revoked / released / user
 * deactivated / the 12 h shift → 401). Every 401 keeps the code
 * `unauthenticated` — handhelds in the field keep their queue only on that
 * code — and carries a `reason`.
 */
export async function verifyDeviceRequest(db: Database, headers: Record<string, unknown>): Promise<DeviceSession> {
  const header = headers.authorization;
  const match = typeof header === 'string' ? /^bearer\s+(.+)$/i.exec(header) : null;
  if (match === null) {
    throw unauthenticated('A Bearer device token is required.');
  }
  const verified = verifyDeviceSessionDetailed(match[1]!.trim(), tenantSessionSecret());
  if (!verified.ok) {
    if (verified.failure === 'expired') throw deviceSessionEnded('expired');
    if (verified.failure === 'legacy') throw deviceSessionEnded('legacy');
    throw unauthenticated('The device token is invalid.');
  }
  const session = verified.session;
  if (session.kind === 'badge') {
    const check = await withTenantTransaction(db, session.tenantId, (tx) =>
      checkSessionInTx(tx, {
        tenantId: session.tenantId,
        sessionId: session.sessionId!,
        userId: session.userId!,
        kind: 'badge',
        deviceId: session.deviceId,
      }),
    );
    if (!check.ok) {
      if (check.reason === 'invalid') throw unauthenticated('The device token is invalid.');
      throw deviceSessionEnded(check.reason);
    }
    // Story 6-1a (A4) — a queued op names the operator who captured it; it
    // never replays under another operator's session. An absent header is
    // accepted (builds before 6-1a send none).
    const opOperator = headers['x-op-operator'];
    if (typeof opOperator === 'string' && opOperator !== '' && opOperator !== session.userId) {
      throw new ProblemException(
        'operator-mismatch',
        409,
        'Operator mismatch',
        'This scan was captured by another operator — it goes to review instead of replaying under this badge-in.',
      );
    }
  }
  return session;
}

export function requireDeviceSession(request: DeviceSessionRequest): DeviceSession {
  const session = request.deviceSession;
  if (!session) {
    throw unauthenticated('A Bearer device token is required.');
  }
  return session;
}

function unauthenticated(detail: string): ProblemException {
  return new ProblemException('unauthenticated', 401, 'Authentication required', detail);
}