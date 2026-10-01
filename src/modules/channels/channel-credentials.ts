import { createHash, createHmac } from 'node:crypto';
import { open, seal } from '../../shared/crypto/envelope';
import type { ChannelAdapter } from './channel-registry';

/**
 * Channel credential sealing (story 7.1, AD-15 — the carrier-credentials
 * 4.6b stand-in verbatim) — **the only file that holds the master key or
 * produces and opens the sealed blob.** Plaintext travels only inbound
 * (the DTO carries it write-only) and lives just long enough to be sealed;
 * everything past the seal (the snapshot, the audit trail, the list rows,
 * the outbox) handles the connection's public face only. What is confined
 * here, and what the architecture test pins, is
 * `process.env.CHANNEL_ENCRYPTION_KEY` and the `envelope.ts` primitives
 * touching channel material in this one file.
 *
 * The master key is `CHANNEL_ENCRYPTION_KEY`, deliberately NOT
 * `CARRIER_ENCRYPTION_KEY` (an independent blast radius is the point of the
 * AD-15 rule: channel secrets and carrier secrets fail and rotate
 * separately). **Losing this key makes every stored channel credential
 * unrecoverable** — a rotation against an unrecoverable blob is simply a
 * re-seal; the disconnect path deletes without opening.
 */

/** A channel credential: field name → secret value. Plaintext. */
export type ChannelCredential = Readonly<Record<string, string>>;

/** Thrown when `CHANNEL_ENCRYPTION_KEY` is missing or too short. */
export class MissingChannelEncryptionKeyError extends Error {
  constructor() {
    super(
      'CHANNEL_ENCRYPTION_KEY is required for channel connections (set it to at least 32 characters; see .env.example)',
    );
  }
}

/** The env-var master key stretched to a 32-byte AES-256 key (KMS stand-in). */
export function channelMasterKey(): Buffer {
  const secret = process.env.CHANNEL_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new MissingChannelEncryptionKeyError();
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Canonical credential bytes: keys sorted, so the same logical material
 * always produces the same JSON regardless of the order the caller sent its
 * fields in. Both the seal and the HMAC read this — key order must not make
 * a replay look like a different payload.
 */
function canonicalCredentialJson(credential: ChannelCredential): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(credential).sort()) {
    sorted[key] = credential[key]!;
  }
  return JSON.stringify(sorted);
}

/** Seals credential material under the channel master key (AES-256-GCM). */
export function sealCredential(credential: ChannelCredential): string {
  return seal(Buffer.from(canonicalCredentialJson(credential), 'utf8'), channelMasterKey());
}

/**
 * Opens a sealed credential — the adapter-use path (7.2's deliveries and
 * webhook consumption) and the tests that prove a rotation actually
 * replaced the material. Throws when the key is wrong or the blob was
 * tampered with.
 */
export function openCredential(sealed: string): ChannelCredential {
  const plaintext = open(sealed, channelMasterKey()).toString('utf8');
  return JSON.parse(plaintext) as ChannelCredential;
}

/**
 * The credential's contribution to the command payload hash (the carriers
 * module's rationale verbatim): the persisted `payload_hash` must
 * distinguish replayed material from reused-key-different-material without
 * storing a brute-forceable digest — HMAC over the canonical JSON, keyed by
 * the master key.
 */
export function credentialHmac(credential: ChannelCredential): string {
  return createHmac('sha256', channelMasterKey())
    .update(canonicalCredentialJson(credential), 'utf8')
    .digest('hex');
}

/**
 * Per-value ceiling. Channel credentials are shop domains and API tokens —
 * none of them longer than 512 characters (the carrier bound, the same
 * reasoning).
 */
export const MAX_CREDENTIAL_VALUE_LENGTH = 512;

/** Ceiling on how many fields a caller may supply (the carrier precedent). */
export const MAX_CREDENTIAL_FIELDS = 16;

/** What `validateCredential` refuses, and why — the caller maps it to a 400. */
export interface CredentialValidationFailure {
  readonly reason:
    | 'not-an-object'
    | 'missing-field'
    | 'unknown-field'
    | 'non-string-value'
    | 'value-too-long'
    | 'too-many-fields';
  /** The offending field name (absent on `not-an-object`/`too-many-fields`). */
  readonly field?: string;
}

/**
 * Validates supplied material against what the adapter declares, and returns
 * the accepted record. Every value is trimmed; a blank optional field is
 * simply not stored; no supplied value is ever echoed. (The carrier
 * module's `validateCredential` logic, restated against
 * `ChannelAdapter`.)
 */
export function validateCredential(
  adapter: ChannelAdapter,
  supplied: unknown,
): { credential: ChannelCredential } | { failure: CredentialValidationFailure } {
  if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
    return { failure: { reason: 'not-an-object' } };
  }
  const declared = new Map(adapter.credentialFields.map((field) => [field.name, field]));
  const record = supplied as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > MAX_CREDENTIAL_FIELDS) {
    return { failure: { reason: 'too-many-fields' } };
  }
  for (const key of keys) {
    if (!declared.has(key)) {
      return { failure: { reason: 'unknown-field', field: key } };
    }
    const value = record[key];
    if (typeof value !== 'string') {
      return { failure: { reason: 'non-string-value', field: key } };
    }
    // Bounded before the trim, so padding cannot smuggle length past it.
    if (value.length > MAX_CREDENTIAL_VALUE_LENGTH) {
      return { failure: { reason: 'value-too-long', field: key } };
    }
  }
  const credential: Record<string, string> = {};
  for (const field of adapter.credentialFields) {
    const raw = record[field.name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      if (field.required) {
        return { failure: { reason: 'missing-field', field: field.name } };
      }
      continue; // an optional field left blank is simply not stored
    }
    credential[field.name] = value;
  }
  return { credential };
}