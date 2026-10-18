import { ProblemException } from '../../shared/problem-details/problem.exception';
import type { SessionEndReason } from './sessions';

/**
 * Story 6-1a — the refresh cookie and the wire shapes of a session ending.
 *
 * The cookie: `wms_refresh=<sid>.<secret>`, httpOnly, `SameSite=Strict`,
 * scoped to `/api/v1/tenants/session` (refresh AND sign-out receive it), and
 * `Secure` unless `COOKIE_SECURE=false` (dev only — Safari refuses a Secure
 * cookie on http://localhost). Deploy constraint (6.2): the web and the API
 * must share a registrable domain that is not on the public suffix list.
 */

export const REFRESH_COOKIE_NAME = 'wms_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/tenants/session';
/** The custom header refresh and sign-out require (a CSRF guard beyond SameSite). */
export const SESSION_HEADER = 'x-wms-session';

function cookieSecure(): boolean {
  return process.env.COOKIE_SECURE !== 'false';
}

export function refreshCookieHeader(value: string, maxAgeSeconds: number): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=${value}`,
    `Path=${REFRESH_COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (cookieSecure()) parts.push('Secure');
  return parts.join('; ');
}

export function clearedRefreshCookieHeader(): string {
  return refreshCookieHeader('', 0);
}

/** Reads one cookie from a raw `Cookie` header (no dependency: the format is `a=b; c=d`). */
export function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

/** The CORS allow-list (the same `CORS_ORIGIN` the app factory reads). */
export function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGIN ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Refresh and sign-out ride a cookie, so they need more than SameSite: an
 * allow-listed `Origin` and the `X-WMS-Session: 1` header (a cross-site form
 * can set neither).
 */
export function assertSessionRequestOrigin(headers: Record<string, unknown>): void {
  const origin = headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins().includes(origin) || headers[SESSION_HEADER] !== '1') {
    throw new ProblemException(
      'role-denied',
      403,
      'Role lacks the required capability',
      'Session requests must come from the WMS web app.',
    );
  }
}

/**
 * The web 401 for an ended session — the client must sign in again (no
 * refresh can fix it). `reason` says why, for the sign-in page's notice.
 */
export function sessionEnded(reason: SessionEndReason): ProblemException {
  return new ProblemException('session-ended', 401, 'Session ended', SESSION_END_DETAIL[reason], { reason });
}

/** The web 401 for an expired ACCESS token — a refresh fixes it. */
export function tokenExpired(): ProblemException {
  return new ProblemException(
    'token-expired',
    401,
    'Authentication required',
    'The access token has expired — refresh the session.',
  );
}

/**
 * The DEVICE 401: the code stays `unauthenticated` (handhelds in the field
 * keep their queue only on that code — `replay-classification.ts`), and the
 * additive `reason` tells a 6-1a build why.
 */
export function deviceSessionEnded(reason: SessionEndReason | 'expired'): ProblemException {
  return new ProblemException(
    'unauthenticated',
    401,
    'Authentication required',
    reason === 'expired' ? 'The badge-in session has expired — badge in again.' : SESSION_END_DETAIL[reason],
    { reason },
  );
}

const SESSION_END_DETAIL: Record<SessionEndReason, string> = {
  'signed-out': 'You signed out.',
  deactivated: 'This account has been deactivated.',
  'role-changed': 'Your role changed — sign in again.',
  'client-suspended': "Your company's portal access is suspended.",
  'refresh-reuse': 'This session was used from somewhere else and has been ended for safety — sign in again.',
  released: 'A supervisor released this device — badge in again.',
  'device-revoked': 'This device was revoked.',
  idle: 'You were signed out after a period of inactivity.',
  absolute: 'Your session reached its time limit — sign in again.',
  legacy: 'Sessions were upgraded — sign in again.',
  'second-factor-reset': 'An owner reset your two-factor sign-in — sign in and set it up again.',
  'second-factor-changed': 'Your two-factor settings changed on another device — sign in again.',
};
