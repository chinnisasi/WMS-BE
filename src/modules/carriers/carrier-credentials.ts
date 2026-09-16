import { createHash, createHmac } from 'node:crypto';
import { open, seal } from '../../shared/crypto/envelope';
import type { CarrierAdapter } from './carrier-registry';

/**
 * Carrier credential sealing (Story 4.6b, AD-15) — **the only file that holds
 * the master key or produces and opens the sealed blob.** Plaintext itself
 * does travel: the DTO carries it inbound (write-only) and the command holds
 * the validated record long enough to seal it. What is confined here, and
 * what the architecture test pins, is narrower and is the part that matters —
 * `process.env.CARRIER_ENCRYPTION_KEY` and the `envelope.ts` primitives live
 * nowhere else, so there is exactly one place that can turn material into
 * storage or storage back into material. Everything past the seal (the
 * outbox, the audit trail, the snapshot, every response) handles the
 * connection's public face only.
 *
 * The master key is `CARRIER_ENCRYPTION_KEY`, deliberately NOT
 * `DEVICE_ENCRYPTION_KEY` (human decision, 2026-09-16): carrier secrets and
 * device offline-store keys then have independent blast radii and rotate
 * independently, at the cost of one required env var. `envelope.ts` stays the
 * documented KMS stand-in — same AES-256-GCM `v1:<iv>:<tag>:<ct>` format,
 * same "any >= 32-char secret stretched with sha256" rule, so a deployment
 * that swaps in a real 32-byte KMS data key keeps working unchanged.
 * **Losing this key makes every stored credential unrecoverable** (see
 * `.env.example`).
 */

/** A carrier credential: field name → secret value. Plaintext. */
export type CarrierCredential = Readonly<Record<string, string>>;

/** Thrown when `CARRIER_ENCRYPTION_KEY` is missing or too short. */
export class MissingCarrierEncryptionKeyError extends Error {
  constructor() {
    super(
      'CARRIER_ENCRYPTION_KEY is required for carrier connections (set it to at least 32 characters; see .env.example)',
    );
  }
}

/** The env-var master key stretched to a 32-byte AES-256 key (KMS stand-in). */
export function carrierMasterKey(): Buffer {
  const secret = process.env.CARRIER_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new MissingCarrierEncryptionKeyError();
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Canonical credential bytes: keys sorted, so the same logical material
 * always produces the same JSON regardless of the order the caller sent its
 * fields in. Both the seal and the HMAC read this — key order must not make a
 * replay look like a different payload.
 */
function canonicalCredentialJson(credential: CarrierCredential): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(credential).sort()) {
    sorted[key] = credential[key]!;
  }
  return JSON.stringify(sorted);
}

/** Seals credential material under the carrier master key (AES-256-GCM). */
export function sealCredential(credential: CarrierCredential): string {
  return seal(Buffer.from(canonicalCredentialJson(credential), 'utf8'), carrierMasterKey());
}

/**
 * Opens a sealed credential — the adapter-use path (rating, 4-6c's labels)
 * and the tests that prove a rotation actually replaced the material. Throws
 * when the key is wrong or the blob was tampered with.
 */
export function openCredential(sealed: string): CarrierCredential {
  const plaintext = open(sealed, carrierMasterKey()).toString('utf8');
  return JSON.parse(plaintext) as CarrierCredential;
}

/**
 * The credential's contribution to the command payload hash.
 *
 * Idempotency has to distinguish "the same connect replayed" from "the same
 * key reused for DIFFERENT material" — the second must be 422, so the
 * credential cannot simply be dropped from the hash. But `hashCommandPayload`
 * is a bare sha256 over `JSON.stringify` and its output is PERSISTED in
 * `idempotency_keys.payload_hash`, a durable, tenant-readable jsonb-adjacent
 * column; hashing the raw key there would store a digest an attacker with DB
 * access can brute-force against a low-entropy API key.
 *
 * Keying the digest with the master key keeps both properties: identical
 * material hashes identically (replay still works), different material
 * collides into the 422, and the persisted digest is worthless without the
 * master key.
 */
export function credentialHmac(credential: CarrierCredential): string {
  return createHmac('sha256', carrierMasterKey())
    .update(canonicalCredentialJson(credential), 'utf8')
    .digest('hex');
}

/**
 * Per-value ceiling. Credential material is API tokens, licence keys and
 * login ids — none of them long. Without a bound, a `carrier.manage` holder
 * could seal a multi-megabyte value into a row that every list query and
 * every future adapter call has to carry; story 4.6 bounded its carrier and
 * tracking strings at 200 characters on exactly this reasoning, and 512
 * leaves generous headroom for a long signed token.
 */
export const MAX_CREDENTIAL_VALUE_LENGTH = 512;

/**
 * Ceiling on how many fields a caller may supply. Undeclared fields are
 * refused one at a time, so this bounds the work done before that refusal —
 * no adapter declares anything close to it.
 */
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
 * the accepted record. Two rules, both naming the offender and **never
 * echoing a supplied value**:
 *
 *  - every field the adapter marks `required` must be present and non-blank;
 *  - no field the adapter does not declare may be stored — a typo'd field
 *    name would otherwise seal a useless credential that only fails much
 *    later, at the first real carrier call;
 *  - no value exceeds `MAX_CREDENTIAL_VALUE_LENGTH` and no request supplies
 *    more than `MAX_CREDENTIAL_FIELDS` of them.
 *
 * Values are trimmed: a credential pasted with trailing whitespace is the
 * same credential, and a whitespace-only value is no value at all.
 */
export function validateCredential(
  adapter: CarrierAdapter,
  supplied: unknown,
): { credential: CarrierCredential } | { failure: CredentialValidationFailure } {
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
