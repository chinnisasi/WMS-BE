import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Story 5-1a (extracted from 6-1b's `second-factor-secrets.ts`) — sealing a
 * small secret at rest under a key taken from the environment.
 *
 * - **AES-256-GCM with associated data.** The caller names the row the
 *   secret belongs to (`tenant_id:user_id` for an authenticator secret,
 *   `tenant_id:message_id` for an email's invite token), so a sealed blob
 *   copied to another row will not open.
 * - **A key id in the blob** (`v1:<kid>:<iv>:<tag>:<ciphertext>`, `kid` = the
 *   first 8 hex of sha256(key)), so while a key rotates, `<NAME>_PREVIOUS`
 *   still opens what the old key sealed.
 * - **The key** is the env value stretched with sha256 (the `envelope.ts`
 *   stand-in); a value shorter than the keyring's minimum is refused.
 *
 * This file reads the env BY THE NAME ITS CALLER PASSES and names no key
 * itself. Each keyring has exactly one owner that names it (pinned by
 * `test/architecture.spec.ts`): `MFA_ENCRYPTION_KEY` in
 * `modules/tenancy/second-factor-secrets.ts`, `EMAIL_SEAL_KEY` in
 * `modules/mail/mail-secrets.ts`.
 */

const SEALED_VERSION = 'v1';

/** A key read from the environment: its variable, its minimum length, and the error a missing key throws. */
export interface Keyring {
  /** The variable holding the current key; `${env}_PREVIOUS` holds the one being rotated out. */
  readonly env: string;
  readonly minLength: number;
  /** The owner's own error (its message names the variable and what losing it costs). */
  readonly missing: (which: 'current' | 'previous') => Error;
}

export interface KeyMaterial {
  readonly kid: string;
  readonly key: Buffer;
}

function stretch(secret: string): KeyMaterial {
  const key = createHash('sha256').update(secret, 'utf8').digest();
  return { kid: createHash('sha256').update(key).digest('hex').slice(0, 8), key };
}

function previousName(keyring: Keyring): string {
  return `${keyring.env}_PREVIOUS`;
}

/** The current key; throws the keyring's own error when it is unset or too short. */
export function currentKeyMaterial(keyring: Keyring): KeyMaterial {
  const secret = process.env[keyring.env];
  if (secret === undefined || secret.length < keyring.minLength) throw keyring.missing('current');
  return stretch(secret);
}

/** The current key first, then the previous one while a rotation is under way. */
export function openingKeyMaterials(keyring: Keyring): KeyMaterial[] {
  const keys = [currentKeyMaterial(keyring)];
  const previous = process.env[previousName(keyring)];
  if (previous !== undefined && previous.length >= keyring.minLength) keys.push(stretch(previous));
  return keys;
}

/**
 * The boot check: a usable current key, and a `_PREVIOUS` that is either
 * unset/empty or long enough (a too-short previous key would be ignored, and
 * every blob sealed under it would never open).
 */
export function assertKeyringConfigured(keyring: Keyring): void {
  currentKeyMaterial(keyring);
  const previous = process.env[previousName(keyring)];
  if (previous !== undefined && previous !== '' && previous.length < keyring.minLength) {
    throw keyring.missing('previous');
  }
}

/** Seals `plaintext` for exactly the row `aad` names. */
export function seal(keyring: Keyring, plaintext: Buffer, aad: string): string {
  const { kid, key } = currentKeyMaterial(keyring);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [SEALED_VERSION, kid, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Opens a sealed blob for the row `aad` names. Throws when the blob is
 * malformed, was sealed for another row, or under a key no longer configured.
 */
export function open(keyring: Keyring, sealed: string, aad: string): Buffer {
  const parts = sealed.split(':');
  if (parts.length !== 5 || parts[0] !== SEALED_VERSION) throw new Error('Malformed sealed secret');
  const [, kid, iv, tag, ciphertext] = parts as [string, string, string, string, string];
  const material = openingKeyMaterials(keyring).find((candidate) => candidate.kid === kid);
  if (material === undefined) throw new Error('The sealed secret names a key that is not configured');
  const decipher = createDecipheriv('aes-256-gcm', material.key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
}
