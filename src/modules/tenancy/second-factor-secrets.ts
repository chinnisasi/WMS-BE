import { createHmac, hkdfSync } from 'node:crypto';
import {
  assertKeyringConfigured,
  currentKeyMaterial,
  open,
  openingKeyMaterials,
  seal,
  type KeyMaterial,
  type Keyring,
} from '../../shared/crypto/seal';

/**
 * Story 6-1b — the second factor's key material. THE ONLY FILE THAT NAMES
 * `MFA_ENCRYPTION_KEY` (and so the only reader of it and its `_PREVIOUS`,
 * through `shared/crypto/seal.ts`) — pinned by `test/architecture.spec.ts`.
 *
 * - **Sealing.** An authenticator secret is sealed with AES-256-GCM (story
 *   5-1a moved the cipher, the key id and the rotation to `seal.ts`) with
 *   **associated data** `tenant_id:user_id`: a sealed secret copied to
 *   another user's row will not open. The blob names its key
 *   (`v1:<kid>:<iv>:<tag>:<ciphertext>`), so while a key rotates,
 *   `MFA_ENCRYPTION_KEY_PREVIOUS` still opens what the old one sealed.
 * - **The backup-code pepper.** HKDF-SHA256 over the key, info
 *   `backup-codes`; a code is stored as HMAC-SHA256(pepper, user_id || code).
 *   During a rotation both peppers are tried.
 * - **The boot check.** `assertSecondFactorKeyConfigured()` refuses a missing
 *   or short key — without it every owner would be locked out on deploy day
 *   (IMPLEMENTATION-GUIDE §8's fail-the-boot rule). `main.ts` calls it.
 *
 * Neither this file nor `seal.ts` touches `envelope.ts`, whose `seal`/`open`
 * default to the device key.
 */

export const MFA_KEY_MIN_LENGTH = 32;

export class MissingSecondFactorKeyError extends Error {
  constructor(name: 'MFA_ENCRYPTION_KEY' | 'MFA_ENCRYPTION_KEY_PREVIOUS' = 'MFA_ENCRYPTION_KEY') {
    super(
      name === 'MFA_ENCRYPTION_KEY_PREVIOUS'
        ? `MFA_ENCRYPTION_KEY_PREVIOUS is set but shorter than ${MFA_KEY_MIN_LENGTH} characters — set the full previous key, or unset it.`
        : `MFA_ENCRYPTION_KEY is required for two-factor sign-in (set it to at least ${MFA_KEY_MIN_LENGTH} characters; see .env.example). ` +
        'Losing it makes every enrolled authenticator unreadable — every owner must then be reset with `bun run auth:reset-2fa <email>`.',
    );
  }
}

/**
 * The keyring this file owns. Story 5-1a extracted the GCM, the key id and
 * the rotation into `shared/crypto/seal.ts`; the blob format, the AAD and
 * the errors are unchanged (a blob sealed before the extraction opens).
 */
const MFA_KEYRING: Keyring = {
  env: 'MFA_ENCRYPTION_KEY',
  minLength: MFA_KEY_MIN_LENGTH,
  missing: (which) => new MissingSecondFactorKeyError(which === 'previous' ? 'MFA_ENCRYPTION_KEY_PREVIOUS' : 'MFA_ENCRYPTION_KEY'),
};

/**
 * The boot check (main.ts): the app refuses to start without a usable key —
 * and with a `MFA_ENCRYPTION_KEY_PREVIOUS` that is set but too short (it
 * would be ignored, and every blob sealed under it would never open).
 * Unset or empty, the previous key is simply absent.
 */
export function assertSecondFactorKeyConfigured(): void {
  assertKeyringConfigured(MFA_KEYRING);
}

function associatedData(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

/** Seals an authenticator secret (raw bytes) for exactly this user's row. */
export function sealSecondFactorSecret(secret: Buffer, tenantId: string, userId: string): string {
  return seal(MFA_KEYRING, secret, associatedData(tenantId, userId));
}

/**
 * Opens a sealed secret for this user's row. Throws when the blob is
 * malformed, was sealed for another row, or under a key no longer configured.
 */
export function openSecondFactorSecret(sealed: string, tenantId: string, userId: string): Buffer {
  return open(MFA_KEYRING, sealed, associatedData(tenantId, userId));
}

function pepper(material: KeyMaterial): Buffer {
  return Buffer.from(hkdfSync('sha256', material.key, Buffer.alloc(0), 'backup-codes', 32));
}

/** HMAC-SHA256 under the current key's pepper over `user_id || code` (the code already normalised). */
export function backupCodeHash(userId: string, normalisedCode: string): string {
  return createHmac('sha256', pepper(currentKeyMaterial(MFA_KEYRING))).update(`${userId}${normalisedCode}`, 'utf8').digest('hex');
}

/** Every hash the code could be stored under (current key, then the previous one during a rotation). */
export function backupCodeHashCandidates(userId: string, normalisedCode: string): string[] {
  return openingKeyMaterials(MFA_KEYRING).map((material) =>
    createHmac('sha256', pepper(material)).update(`${userId}${normalisedCode}`, 'utf8').digest('hex'),
  );
}
