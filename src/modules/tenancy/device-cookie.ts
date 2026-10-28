import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { emailDigest } from './auth-attempts';
import { tenantSessionSecret } from './jwt-session';

/**
 * Story 6-1c (A1) — the trusted-browser signal: a signed device cookie (the
 * OWASP "device cookie" scheme), never a trusted address.
 *
 * `wms_device=v1.<email digest, first 32 hex>.<exp epoch s>.<nonce>.<mac>`,
 * httpOnly, `SameSite=Strict`, `Secure` (the `COOKIE_SECURE` rule), scoped to
 * the sign-in route (`/api/v1/tenants/sign-in`, which also covers its second
 * step), 30 days. The MAC is HMAC-SHA256 under a key derived from
 * `JWT_SECRET` (HKDF, info `device-cookie`) over the full email digest, the
 * expiry, the nonce and sha256 of the user's CURRENT password hash — so a
 * password reset invalidates every device cookie of the account at once,
 * with no table (B4).
 *
 * Issued on a right password at sign-in (every arm) and on a completed
 * reset. A sign-in that presents a cookie verifying for the typed email and
 * the account's current hash is TRUSTED: counted on its own key
 * (`deviceAttemptKey(nonce)`, 5 failures → 15 min) and exempt from the
 * (email, address) lock and the untrusted hour buckets.
 *
 * This is the ONLY file that derives the key (`test/architecture.spec.ts`).
 */

export const DEVICE_COOKIE_NAME = 'wms_device';
export const DEVICE_COOKIE_PATH = '/api/v1/tenants/sign-in';
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const VERSION = 'v1';
const NONCE_BYTES = 16;

function deviceCookieKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', tenantSessionSecret(), Buffer.alloc(0), 'device-cookie', 32));
}

function macOf(digest: string, exp: number, nonce: string, passwordHash: string): string {
  const hashOfHash = createHash('sha256').update(passwordHash, 'utf8').digest('hex');
  return createHmac('sha256', deviceCookieKey())
    .update(`${VERSION}|${digest}|${exp}|${nonce}|${hashOfHash}`, 'utf8')
    .digest('base64url');
}

/** A fresh cookie value for the account, bound to its current password hash. */
export function issueDeviceCookie(email: string, passwordHash: string, nowMs: number = Date.now()): string {
  const digest = emailDigest(email);
  const exp = Math.floor(nowMs / 1000) + DEVICE_COOKIE_MAX_AGE_SECONDS;
  const nonce = randomBytes(NONCE_BYTES).toString('base64url');
  return [VERSION, digest.slice(0, 32), String(exp), nonce, macOf(digest, exp, nonce, passwordHash)].join('.');
}

/**
 * The cookie's nonce when it verifies for this email and this password hash
 * and has not expired; null otherwise (malformed, another account, a hash
 * changed since — a reset —, expired, a forged MAC).
 */
export function verifyDeviceCookie(
  value: string | null,
  email: string,
  passwordHash: string,
  nowMs: number = Date.now(),
): { readonly nonce: string } | null {
  if (value === null || value.length > 300) return null;
  const parts = value.split('.');
  if (parts.length !== 5) return null;
  const [version, prefix, expText, nonce, mac] = parts as [string, string, string, string, string];
  if (version !== VERSION || !/^[0-9a-f]{32}$/.test(prefix) || !/^\d{1,12}$/.test(expText)) return null;
  if (!/^[A-Za-z0-9_-]{22}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  const digest = emailDigest(email);
  if (digest.slice(0, 32) !== prefix) return null;
  const exp = Number(expText);
  if (exp * 1000 <= nowMs) return null;
  const expected = Buffer.from(macOf(digest, exp, nonce, passwordHash), 'utf8');
  const given = Buffer.from(mac, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { nonce };
}

function cookieSecure(): boolean {
  return process.env.COOKIE_SECURE !== 'false';
}

export function deviceCookieHeader(value: string): string {
  const parts = [
    `${DEVICE_COOKIE_NAME}=${value}`,
    `Path=${DEVICE_COOKIE_PATH}`,
    `Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (cookieSecure()) parts.push('Secure');
  return parts.join('; ');
}
