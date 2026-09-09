import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUuid } from '../../shared/primitives/ids';

/**
 * Hand-signed HS256 session tokens (spec decision — minimal sign-in, no
 * refresh, no new dependency): `node:crypto` HMAC-SHA256 over the compact
 * JWS form. Short-lived (15 min); claims are `sub` (user id) + `tenant_id`.
 */

const ALGORITHM = 'HS256';
export const SESSION_TTL_SECONDS = 15 * 60;

/**
 * Device sessions (Story 3.2): longer-lived than the 15-min web JWT, but
 * **server-checked** — the token carries `device_id` (and `sub` = the
 * badge-in operator once badged in) and every device-authenticated request
 * re-resolves the device row + operator role from the DB (fail-closed), so
 * revocation is effective on the device's next request. No refresh-token
 * machinery — revocable server-side instead.
 */
export const DEVICE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface TenantSession {
  readonly userId: string;
  readonly tenantId: string;
  readonly issuedAt: number; // unix seconds
  readonly expiresAt: number; // unix seconds
}

export function tenantSessionSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'JWT_SECRET is required for tenant sessions (set it to at least 16 characters; see .env.example)',
    );
  }
  return secret;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function signTenantSession(
  tenantId: string,
  userId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: ALGORITHM, typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: userId,
      tenant_id: tenantId,
      iat: nowSeconds,
      exp: nowSeconds + SESSION_TTL_SECONDS,
    }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Returns the claims for a well-formed, unexpired token — null otherwise. */
export function verifyTenantSession(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TenantSession | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === undefined || part === '')) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    (header as { alg?: unknown }).alg !== ALGORITHM
  ) {
    return null;
  }

  const expected = createHmac('sha256', secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');
  const actual = Buffer.from(signaturePart, 'base64url');
  const expectedBytes = Buffer.from(expected, 'base64url');
  if (actual.length !== expectedBytes.length || !timingSafeEqual(actual, expectedBytes)) {
    return null;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const { sub, tenant_id: tenantId, iat, exp } = payload;
  if (typeof sub !== 'string' || !isUuid(sub)) return null;
  if (typeof tenantId !== 'string' || !isUuid(tenantId)) return null;
  if (typeof exp !== 'number' || exp <= nowSeconds) return null;
  return {
    userId: sub,
    tenantId,
    issuedAt: typeof iat === 'number' ? iat : exp - SESSION_TTL_SECONDS,
    expiresAt: exp,
  };
}

/** Device-token claims — a device credential (no operator yet, `sub` null) or a badge-in session (`sub` = operator id). */
export interface DeviceSession {
  readonly deviceId: string;
  readonly tenantId: string;
  /** The badge-in operator — null on the bare enrollment credential. */
  readonly userId: string | null;
  readonly issuedAt: number; // unix seconds
  readonly expiresAt: number; // unix seconds
}

function signDeviceClaims(
  tenantId: string,
  deviceId: string,
  userId: string | null,
  secret: string,
  ttlSeconds: number,
  nowSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: ALGORITHM, typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      device_id: deviceId,
      tenant_id: tenantId,
      ...(userId === null ? {} : { sub: userId }),
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
    }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** The device credential minted at enrollment (device identity, no operator). */
export function signDeviceToken(
  tenantId: string,
  deviceId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  return signDeviceClaims(tenantId, deviceId, null, secret, DEVICE_SESSION_TTL_SECONDS, nowSeconds);
}

/** The revocable badge-in session (device + operator bound). */
export function signBadgeInSession(
  tenantId: string,
  deviceId: string,
  userId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  return signDeviceClaims(
    tenantId,
    deviceId,
    userId,
    secret,
    DEVICE_SESSION_TTL_SECONDS,
    nowSeconds,
  );
}

/**
 * Verifies a device-claim token (well-formed, unexpired, HAS a `device_id`).
 * Returns null for tenant-session tokens (no `device_id` claim) — the two
 * token families are mutually exclusive by claim shape.
 */
export function verifyDeviceSession(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): DeviceSession | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === undefined || part === '')) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    (header as { alg?: unknown }).alg !== ALGORITHM
  ) {
    return null;
  }

  const expected = createHmac('sha256', secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');
  const actual = Buffer.from(signaturePart, 'base64url');
  const expectedBytes = Buffer.from(expected, 'base64url');
  if (actual.length !== expectedBytes.length || !timingSafeEqual(actual, expectedBytes)) {
    return null;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const { device_id: deviceId, tenant_id: tenantId, sub, iat, exp } = payload;
  if (typeof deviceId !== 'string' || !isUuid(deviceId)) return null;
  if (typeof tenantId !== 'string' || !isUuid(tenantId)) return null;
  if (sub !== undefined && (typeof sub !== 'string' || !isUuid(sub))) return null;
  if (typeof exp !== 'number' || exp <= nowSeconds) return null;
  return {
    deviceId,
    tenantId,
    userId: typeof sub === 'string' ? sub : null,
    issuedAt: typeof iat === 'number' ? iat : exp - DEVICE_SESSION_TTL_SECONDS,
    expiresAt: exp,
  };
}