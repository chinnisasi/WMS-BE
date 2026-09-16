import { createHash, createHmac } from 'node:crypto';
import { open, seal } from '../../shared/crypto/envelope';
import type { CarrierAdapter } from './carrier-registry';

/**
 * Carrier credential sealing (Story 4.6b, AD-15) — **the only file in the
 * repo that touches carrier plaintext.** Everything downstream (the command,
 * the facade, the DTOs, the outbox, the audit trail) handles either the
 * sealed blob or the connection's public face, and the architecture test
 * pins that confinement.
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

/** What `validateCredential` refuses, and why — the caller maps it to a 400. */
export interface CredentialValidationFailure {
  readonly reason: 'not-an-object' | 'missing-field' | 'unknown-field' | 'non-string-value';
  /** The offending field name (absent only for `not-an-object`). */
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
 *    later, at the first real carrier call.
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
  for (const key of Object.keys(record)) {
    if (!declared.has(key)) {
      return { failure: { reason: 'unknown-field', field: key } };
    }
    if (typeof record[key] !== 'string') {
      return { failure: { reason: 'non-string-value', field: key } };
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
