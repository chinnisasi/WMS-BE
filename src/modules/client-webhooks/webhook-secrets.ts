import { randomBytes } from 'node:crypto';
import { assertKeyringConfigured, currentKeyMaterial, open, seal, type Keyring } from '../../shared/crypto/seal';

/**
 * Story 5-2a (decision 10, A7, A17) — the endpoints' signing secrets. THE
 * ONLY FILE THAT NAMES `WEBHOOK_SEAL_KEY` (pinned by
 * `test/architecture.spec.ts`): a secret is sealed under it in
 * `webhook_endpoints.secret_sealed` (and `previous_secret_sealed` during a
 * rotation's 24-hour overlap), with associated data `tenant_id:endpoint_id`
 * — a blob copied to another row will not open.
 *
 * The secret is `whsec_` + base64 of 32 random bytes (the Standard Webhooks
 * shape); the HMAC key is the DECODED bytes after the prefix (A7). It is
 * shown once, in the create and rotate responses, and never stored in a
 * snapshot, a log, the outbox or an audit row.
 *
 * Losing the key loses every endpoint's secret (each must be rotated, and
 * the new secret handed to the client again), so `WEBHOOK_SEAL_KEY_PREVIOUS`
 * opens rows sealed before a key rotation until `bun run webhooks:reseal`
 * re-seals them under the current key (DEPLOY.md runbook).
 */

export const WEBHOOK_SEAL_KEY_MIN_LENGTH = 32;
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

export class MissingWebhookSealKeyError extends Error {
  constructor(which: 'current' | 'previous') {
    super(
      which === 'previous'
        ? `WEBHOOK_SEAL_KEY_PREVIOUS is set but shorter than ${WEBHOOK_SEAL_KEY_MIN_LENGTH} characters — set the full previous key, or unset it.`
        : `WEBHOOK_SEAL_KEY is required when WEBHOOK_GATEWAY=https, and to create or rotate a webhook secret (set it to at least ${WEBHOOK_SEAL_KEY_MIN_LENGTH} characters; see .env.example).`,
    );
    this.name = 'MissingWebhookSealKeyError';
  }
}

const WEBHOOK_KEYRING: Keyring = {
  env: 'WEBHOOK_SEAL_KEY',
  minLength: WEBHOOK_SEAL_KEY_MIN_LENGTH,
  missing: (which) => new MissingWebhookSealKeyError(which),
};

/** The boot check (`https` only): a usable key, and a well-formed `_PREVIOUS` when one is set. */
export function assertWebhookSealKeyConfigured(): void {
  assertKeyringConfigured(WEBHOOK_KEYRING);
}

/** True when a secret can be sealed now (create and rotate answer 409 `webhooks-unavailable` otherwise). */
export function webhookSealKeyAvailable(): boolean {
  try {
    currentKeyMaterial(WEBHOOK_KEYRING);
    return true;
  } catch {
    return false;
  }
}

function associatedData(tenantId: string, endpointId: string): string {
  return `${tenantId}:${endpointId}`;
}

/** A fresh `whsec_…` secret and its display hint (the last four characters). */
export function generateSigningSecret(): { secret: string; hint: string } {
  const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64')}`;
  // Code review C14 — the last four characters BEFORE the base64 padding
  // (32 bytes always end in one `=`, which would make every hint end in it).
  return { secret, hint: secret.replace(/=+$/, '').slice(-4) };
}

/** Seals an endpoint's secret for exactly this row. */
export function sealSigningSecret(secret: string, tenantId: string, endpointId: string): string {
  return seal(WEBHOOK_KEYRING, Buffer.from(secret, 'utf8'), associatedData(tenantId, endpointId));
}

/** Opens it; throws when malformed, sealed for another row, or under a key no longer configured. */
export function openSigningSecret(sealed: string, tenantId: string, endpointId: string): string {
  return open(WEBHOOK_KEYRING, sealed, associatedData(tenantId, endpointId)).toString('utf8');
}

/** The HMAC key of a `whsec_…` secret: the base64-decoded bytes after the prefix (A7). */
export function signingKeyOf(secret: string): Buffer {
  const encoded = secret.startsWith(WEBHOOK_SECRET_PREFIX) ? secret.slice(WEBHOOK_SECRET_PREFIX.length) : secret;
  const key = Buffer.from(encoded, 'base64');
  if (key.length === 0) throw new Error('The signing secret decodes to no bytes');
  return key;
}

/** The endpoint's sealed secrets, as the sender reads them. */
export interface SealedSigningSecrets {
  readonly tenantId: string;
  readonly endpointId: string;
  readonly secretSealed: string;
  readonly previousSecretSealed: string | null;
  readonly previousSecretExpiresAt: string | null;
}

/**
 * The keys a send signs with (A17): the current secret, then the previous
 * one while its overlap lasts. Throws when either does not open — the sender
 * treats that as the config fault `secret-unavailable`.
 */
export function openSigningKeys(row: SealedSigningSecrets, now: number): Buffer[] {
  const keys = [signingKeyOf(openSigningSecret(row.secretSealed, row.tenantId, row.endpointId))];
  if (row.previousSecretSealed !== null && row.previousSecretExpiresAt !== null && Date.parse(row.previousSecretExpiresAt) > now) {
    // Code review C21 — the previous secret is a courtesy for the overlap:
    // one that no longer opens (the recovery rotation after a lost key) is
    // skipped, and the current secret alone signs.
    try {
      keys.push(signingKeyOf(openSigningSecret(row.previousSecretSealed, row.tenantId, row.endpointId)));
    } catch {
      // signed with the current key only
    }
  }
  return keys;
}

/**
 * The `webhooks:reseal` body (A17): re-seal one blob under the CURRENT key
 * (opening it with the current or the previous one), so
 * `WEBHOOK_SEAL_KEY_PREVIOUS` can be retired. Returns null when it already
 * carries the current key id (nothing to do).
 */
export function resealSigningSecret(sealed: string, tenantId: string, endpointId: string): string | null {
  const currentKid = currentKeyMaterial(WEBHOOK_KEYRING).kid;
  if (sealed.split(':')[1] === currentKid) return null;
  return sealSigningSecret(openSigningSecret(sealed, tenantId, endpointId), tenantId, endpointId);
}
