import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Story 6-1b — the second factor's key material. THE ONLY READER of
 * `MFA_ENCRYPTION_KEY` (and `MFA_ENCRYPTION_KEY_PREVIOUS`) in the codebase —
 * pinned by `test/architecture.spec.ts`.
 *
 * - **Sealing.** An authenticator secret is sealed with AES-256-GCM under a
 *   key stretched from the env value (sha256, the `envelope.ts` stand-in),
 *   with **associated data** `tenant_id:user_id`: a sealed secret copied to
 *   another user's row will not open. The blob names its key
 *   (`v1:<kid>:<iv>:<tag>:<ciphertext>`, `kid` = the first 8 hex of
 *   sha256(key)), so while a key rotates, `MFA_ENCRYPTION_KEY_PREVIOUS` still
 *   opens what the old one sealed.
 * - **The backup-code pepper.** HKDF-SHA256 over the key, info
 *   `backup-codes`; a code is stored as HMAC-SHA256(pepper, user_id || code).
 *   During a rotation both peppers are tried.
 * - **The boot check.** `assertSecondFactorKeyConfigured()` refuses a missing
 *   or short key — without it every owner would be locked out on deploy day
 *   (IMPLEMENTATION-GUIDE §8's fail-the-boot rule). `main.ts` calls it.
 *
 * This file does its own GCM (with AAD) and does not touch `envelope.ts`,
 * whose `seal`/`open` default to the device key.
 */

export const MFA_KEY_MIN_LENGTH = 32;
const SEALED_VERSION = 'v1';

export class MissingSecondFactorKeyError extends Error {
  constructor() {
    super(
      `MFA_ENCRYPTION_KEY is required for two-factor sign-in (set it to at least ${MFA_KEY_MIN_LENGTH} characters; see .env.example). ` +
        'Losing it makes every enrolled authenticator unreadable — every owner must then be reset with `bun run auth:reset-2fa <email>`.',
    );
  }
}

interface KeyMaterial {
  readonly kid: string;
  readonly key: Buffer;
}

function stretch(secret: string): KeyMaterial {
  const key = createHash('sha256').update(secret, 'utf8').digest();
  return { kid: createHash('sha256').update(key).digest('hex').slice(0, 8), key };
}

function currentKey(): KeyMaterial {
  const secret = process.env.MFA_ENCRYPTION_KEY;
  if (secret === undefined || secret.length < MFA_KEY_MIN_LENGTH) throw new MissingSecondFactorKeyError();
  return stretch(secret);
}

/** The current key first, then the previous one while a rotation is under way. */
function openingKeys(): KeyMaterial[] {
  const keys = [currentKey()];
  const previous = process.env.MFA_ENCRYPTION_KEY_PREVIOUS;
  if (previous !== undefined && previous.length >= MFA_KEY_MIN_LENGTH) keys.push(stretch(previous));
  return keys;
}

/** The boot check (main.ts): the app refuses to start without a usable key. */
export function assertSecondFactorKeyConfigured(): void {
  currentKey();
}

function associatedData(tenantId: string, userId: string): Buffer {
  return Buffer.from(`${tenantId}:${userId}`, 'utf8');
}

/** Seals an authenticator secret (raw bytes) for exactly this user's row. */
export function sealSecondFactorSecret(secret: Buffer, tenantId: string, userId: string): string {
  const { kid, key } = currentKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData(tenantId, userId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [SEALED_VERSION, kid, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Opens a sealed secret for this user's row. Throws when the blob is
 * malformed, was sealed for another row, or under a key no longer configured.
 */
export function openSecondFactorSecret(sealed: string, tenantId: string, userId: string): Buffer {
  const parts = sealed.split(':');
  if (parts.length !== 5 || parts[0] !== SEALED_VERSION) throw new Error('Malformed sealed second-factor secret');
  const [, kid, iv, tag, ciphertext] = parts as [string, string, string, string, string];
  const material = openingKeys().find((candidate) => candidate.kid === kid);
  if (material === undefined) throw new Error('The sealed second-factor secret names a key that is not configured');
  const decipher = createDecipheriv('aes-256-gcm', material.key, Buffer.from(iv, 'base64'));
  decipher.setAAD(associatedData(tenantId, userId));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
}

function pepper(material: KeyMaterial): Buffer {
  return Buffer.from(hkdfSync('sha256', material.key, Buffer.alloc(0), 'backup-codes', 32));
}

/** HMAC-SHA256 under the current key's pepper over `user_id || code` (the code already normalised). */
export function backupCodeHash(userId: string, normalisedCode: string): string {
  return createHmac('sha256', pepper(currentKey())).update(`${userId}${normalisedCode}`, 'utf8').digest('hex');
}

/** Every hash the code could be stored under (current key, then the previous one during a rotation). */
export function backupCodeHashCandidates(userId: string, normalisedCode: string): string[] {
  return openingKeys().map((material) =>
    createHmac('sha256', pepper(material)).update(`${userId}${normalisedCode}`, 'utf8').digest('hex'),
  );
}
