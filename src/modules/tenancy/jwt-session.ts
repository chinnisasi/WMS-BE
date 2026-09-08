import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUuid } from '../../shared/primitives/ids';

/**
 * Hand-signed HS256 session tokens (spec decision — minimal sign-in, no
 * refresh, no new dependency): `node:crypto` HMAC-SHA256 over the compact
 * JWS form. Short-lived (15 min); claims are `sub` (user id) + `tenant_id`.
 */

const ALGORITHM = 'HS256';
export const SESSION_TTL_SECONDS = 15 * 60;

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