import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption (Story 3.2, AD-15 stand-in): AES-256-GCM seal/open over
 * `node:crypto` — the repo's first cipher primitive (the scrypt/HMAC
 * precedents live in `passwords.ts` / `jwt-session.ts`).
 *
 * The master key comes from `DEVICE_ENCRYPTION_KEY` (the KMS stand-in — swap
 * documented): any passphrase-length secret is accepted and stretched to 32
 * bytes with sha256, so a deployment that rotates to a real 32-byte KMS data
 * key keeps working unchanged. Secret material (the offline-store key) is
 * sealed at enrollment and delivered once in the enrollment response — it is
 * never logged, never exported after that response, and never needed again
 * server-side. Sealed format: `v1:<iv b64>:<auth tag b64>:<ciphertext b64>`.
 */

const MASTER_KEY_BYTES = 32;

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      'DEVICE_ENCRYPTION_KEY is required for device enrollment (set it to at least 32 characters; see .env.example)',
    );
  }
}

/** The env-var master key stretched to a 32-byte AES-256 key (KMS stand-in). */
export function deviceMasterKey(): Buffer {
  const secret = process.env.DEVICE_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new MissingEncryptionKeyError();
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Seals plaintext under the master key — authenticated, AES-256-GCM. */
export function seal(plaintext: Buffer, key: Buffer = deviceMasterKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Opens a `seal()` blob — throws when the key is wrong or the blob was tampered with. */
export function open(sealed: string, key: Buffer = deviceMasterKey()): Buffer {
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed sealed blob');
  }
  const iv = Buffer.from(parts[1]!, 'base64');
  const authTag = Buffer.from(parts[2]!, 'base64');
  const ciphertext = Buffer.from(parts[3]!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Cryptographically strong 256-bit secret (the offline-store key size). */
export function generateSecret(): Buffer {
  return randomBytes(MASTER_KEY_BYTES);
}