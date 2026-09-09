import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { createParamDecorator, Injectable } from '@nestjs/common';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import {
  verifyDeviceSession,
  tenantSessionSecret,
  type DeviceSession,
} from './jwt-session';

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
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<DeviceSessionRequest>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^bearer\s+(.+)$/i.exec(header) : null;
    if (match === null) {
      throw unauthenticated('A Bearer device token is required.');
    }
    const session = verifyDeviceSession(match[1]!.trim(), tenantSessionSecret());
    if (!session) {
      throw unauthenticated('The device token is invalid or expired.');
    }
    request.deviceSession = session;
    return true;
  }
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