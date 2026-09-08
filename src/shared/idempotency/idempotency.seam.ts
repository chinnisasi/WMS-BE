/**
 * Idempotency seam (AD-9 / epic contract): every mutating endpoint carries a
 * client-generated ULID key, de-duped tenant-scoped in the same transaction
 * as the write.
 *
 * Story 1.1 lays the seam only — the table, tenant scoping, and interceptor
 * land with the first mutating endpoints (Story 1.2) inside the tenancy
 * module. Do not build storage here, and do not consume the key as if
 * tenant scoping already exists.
 */

import { ulid } from '../primitives/ids';

export interface IdempotencyKey {
  readonly key: string;
}

/**
 * Validates the shape of a client-supplied idempotency key header. Tenant
 * scoping of the key is Story 1.2 scope — this returns the key only, never a
 * stand-in tenant id.
 */
export function parseIdempotencyKey(raw: string | undefined): IdempotencyKey | null {
  if (!raw) return null;
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw)) return null;
  return { key: raw };
}

/** Reference implementation of the key format clients must generate. */
export function newIdempotencyKey(): string {
  return ulid();
}
