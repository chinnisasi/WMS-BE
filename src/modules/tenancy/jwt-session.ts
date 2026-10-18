import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUuid } from '../../shared/primitives/ids';

/**
 * Hand-signed HS256 tokens over `node:crypto` HMAC-SHA256 (no JWT library).
 *
 * Story 6-1a — every token now carries a `kind` (`web` | `portal` | `device`
 * | `badge`) and, for the three session kinds, the server-side session id
 * `sid` (`sessions.id`). Each verifier requires its own kinds; the older
 * claim-shape exclusions (`device_id` never on a web token, `client_id`
 * never on a device token) stay as a second check. Short access tokens are
 * transport: every guard re-reads the session row and the user's status
 * (`sessions.ts`), so revocation bites on the next request.
 *
 * Legacy shapes (minted before 6-1a) are recognised for one TTL after the
 * deploy: a no-`kind` token with `device_id` and no `sub` is still a device
 * credential (it lives its 30 days); a no-`kind` badge token (`sub`, no
 * `sid`) and a no-`sid` web token verify as `legacy` — the session-ended
 * 401 with reason `legacy`.
 */

const ALGORITHM = 'HS256';

/** The web / portal ACCESS token TTL — the session itself lives on through refresh. */
export const SESSION_TTL_SECONDS = 15 * 60;

/** The device credential minted at enrollment and renewed at every badge-in (a rolling 30 days). */
export const DEVICE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Story 6-1a — a badge-in session lasts one shift: 12 h absolute, no idle limit, no refresh. */
export const BADGE_SESSION_TTL_SECONDS = 12 * 60 * 60;

export type WebTokenKind = 'web' | 'portal';
export type DeviceTokenKind = 'device' | 'badge';

export interface TenantSession {
  readonly userId: string;
  readonly tenantId: string;
  /**
   * Story 21-7 (AD-4 amended, for the FENCE only) — the client brand of a
   * client-portal user; null for the tenant's own staff.
   */
  readonly clientId: string | null;
  /** Story 6-1a — `web` (staff) or `portal` (a client brand's user). */
  readonly kind: WebTokenKind;
  /** Story 6-1a — the server-side session (`sessions.id`) the guard re-reads. */
  readonly sessionId: string;
  readonly issuedAt: number; // unix seconds
  readonly expiresAt: number; // unix seconds
}

/** Why a token did not verify — the guards map each to its own answer. */
export type TokenFailure = 'invalid' | 'expired' | 'legacy';

export type WebVerification =
  | { readonly ok: true; readonly session: TenantSession }
  | { readonly ok: false; readonly failure: TokenFailure };

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

function signPayload(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: ALGORITHM, typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export interface AccessTokenInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly kind: WebTokenKind;
  /** Required for `portal`, refused for `web`. */
  readonly clientId?: string | null;
  readonly nowSeconds?: number;
  /** Defaults to `SESSION_TTL_SECONDS`; the sign-in / refresh path caps it at the session's absolute end. */
  readonly ttlSeconds?: number;
}

/**
 * The web / portal access token. Payload keys in order: `sub`, `tenant_id`,
 * `client_id` (portal only), `kind`, `sid`, `iat`, `exp`.
 */
export function signTenantSession(input: AccessTokenInput, secret: string): string {
  const clientId = input.clientId ?? null;
  if ((input.kind === 'portal') !== (clientId !== null)) {
    throw new Error('signTenantSession: a portal token carries client_id and a web token never does');
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return signPayload(
    {
      sub: input.userId,
      tenant_id: input.tenantId,
      ...(clientId === null ? {} : { client_id: clientId }),
      kind: input.kind,
      sid: input.sessionId,
      iat: now,
      exp: now + (input.ttlSeconds ?? SESSION_TTL_SECONDS),
    },
    secret,
  );
}

/**
 * Verifies the signature and returns the payload, IGNORING `exp` — null for
 * a malformed or forged token. Sign-out reads its session id through this:
 * it must work with an expired access token.
 */
export function decodeSignedPayload(token: string, secret: string): Record<string, unknown> | null {
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

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as unknown;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The web-family verifier, with the failure reason. Order: signature and
 * shape (`invalid`) → the legacy no-`sid` shape (`legacy`, whatever its
 * expiry) → `exp` (`expired` — a refresh can fix it).
 */
export function verifyTenantSessionDetailed(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): WebVerification {
  const invalid = { ok: false, failure: 'invalid' } as const;
  const payload = decodeSignedPayload(token, secret);
  if (payload === null) return invalid;
  const { sub, tenant_id: tenantId, iat, exp, kind, sid } = payload;
  if (typeof sub !== 'string' || !isUuid(sub)) return invalid;
  if (typeof tenantId !== 'string' || !isUuid(tenantId)) return invalid;
  if (typeof exp !== 'number') return invalid;
  // The 21-7 claim-shape exclusion, kept as the second check: a device-family
  // token is never a web token.
  if ('device_id' in payload) return invalid;
  let clientId: string | null = null;
  if ('client_id' in payload) {
    const claim = payload.client_id;
    if (typeof claim !== 'string' || !isUuid(claim)) return invalid;
    clientId = claim;
  }
  if (kind === undefined) {
    // A pre-6-1a web or portal token: no kind, no sid. It names no session,
    // so it can never be checked or revoked — the session is over.
    if ('sid' in payload) return invalid;
    return { ok: false, failure: 'legacy' };
  }
  if (kind !== 'web' && kind !== 'portal') return invalid;
  if ((kind === 'portal') !== (clientId !== null)) return invalid;
  if (typeof sid !== 'string' || !isUuid(sid)) return invalid;
  if (exp <= nowSeconds) return { ok: false, failure: 'expired' };
  return {
    ok: true,
    session: {
      userId: sub,
      tenantId,
      clientId,
      kind,
      sessionId: sid,
      issuedAt: typeof iat === 'number' ? iat : exp - SESSION_TTL_SECONDS,
      expiresAt: exp,
    },
  };
}

/** Returns the claims for a well-formed, unexpired, current-shape web token — null otherwise. */
export function verifyTenantSession(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TenantSession | null {
  const result = verifyTenantSessionDetailed(token, secret, nowSeconds);
  return result.ok ? result.session : null;
}

/** Device-token claims — a device credential (no operator, no session) or a badge-in session. */
export interface DeviceSession {
  readonly deviceId: string;
  readonly tenantId: string;
  /** The badge-in operator — null on the bare device credential. */
  readonly userId: string | null;
  /** Story 6-1a — `device` (the credential) or `badge` (an operator's shift session). */
  readonly kind: DeviceTokenKind;
  /** Story 6-1a — the badge session's `sessions.id`; null on the device credential. */
  readonly sessionId: string | null;
  readonly issuedAt: number; // unix seconds
  readonly expiresAt: number; // unix seconds
}

export type DeviceVerification =
  | { readonly ok: true; readonly session: DeviceSession }
  | { readonly ok: false; readonly failure: TokenFailure };

/** The device credential minted at enrollment and renewed at badge-in (device identity, no operator). */
export function signDeviceToken(
  tenantId: string,
  deviceId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  return signPayload(
    {
      device_id: deviceId,
      tenant_id: tenantId,
      kind: 'device',
      iat: nowSeconds,
      exp: nowSeconds + DEVICE_SESSION_TTL_SECONDS,
    },
    secret,
  );
}

export interface BadgeTokenInput {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly nowSeconds?: number;
  readonly ttlSeconds?: number;
}

/** The revocable badge-in session token (device + operator + session). */
export function signBadgeInSession(input: BadgeTokenInput, secret: string): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return signPayload(
    {
      device_id: input.deviceId,
      tenant_id: input.tenantId,
      sub: input.userId,
      kind: 'badge',
      sid: input.sessionId,
      iat: now,
      exp: now + (input.ttlSeconds ?? BADGE_SESSION_TTL_SECONDS),
    },
    secret,
  );
}

/**
 * The device-family verifier, with the failure reason. A token carrying
 * `client_id` is never a device token (21-7). Legacy: a no-`kind` token
 * without `sub` is the pre-6-1a device credential (accepted until its own
 * expiry); a no-`kind` token WITH `sub` is a pre-6-1a badge session —
 * `legacy`, the operator badges in again.
 */
export function verifyDeviceSessionDetailed(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): DeviceVerification {
  const invalid = { ok: false, failure: 'invalid' } as const;
  const payload = decodeSignedPayload(token, secret);
  if (payload === null) return invalid;
  const { device_id: deviceId, tenant_id: tenantId, sub, iat, exp, kind, sid } = payload;
  if ('client_id' in payload) return invalid;
  if (typeof deviceId !== 'string' || !isUuid(deviceId)) return invalid;
  if (typeof tenantId !== 'string' || !isUuid(tenantId)) return invalid;
  if (sub !== undefined && (typeof sub !== 'string' || !isUuid(sub))) return invalid;
  if (typeof exp !== 'number') return invalid;

  let resolvedKind: DeviceTokenKind;
  let sessionId: string | null = null;
  if (kind === undefined) {
    if ('sid' in payload) return invalid;
    if (sub !== undefined) return { ok: false, failure: 'legacy' };
    resolvedKind = 'device';
  } else if (kind === 'device') {
    if (sub !== undefined || 'sid' in payload) return invalid;
    resolvedKind = 'device';
  } else if (kind === 'badge') {
    if (typeof sub !== 'string') return invalid;
    if (typeof sid !== 'string' || !isUuid(sid)) return invalid;
    resolvedKind = 'badge';
    sessionId = sid;
  } else {
    return invalid;
  }
  if (exp <= nowSeconds) return { ok: false, failure: 'expired' };
  return {
    ok: true,
    session: {
      deviceId,
      tenantId,
      userId: typeof sub === 'string' ? sub : null,
      kind: resolvedKind,
      sessionId,
      issuedAt:
        typeof iat === 'number'
          ? iat
          : exp - (resolvedKind === 'badge' ? BADGE_SESSION_TTL_SECONDS : DEVICE_SESSION_TTL_SECONDS),
      expiresAt: exp,
    },
  };
}

/** Returns the claims for a well-formed, unexpired device-family token — null otherwise. */
export function verifyDeviceSession(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): DeviceSession | null {
  const result = verifyDeviceSessionDetailed(token, secret, nowSeconds);
  return result.ok ? result.session : null;
}
