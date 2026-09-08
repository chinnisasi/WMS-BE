/**
 * Idempotency seam (AD-9 / epic contract): every mutating endpoint carries a
 * client-generated ULID key, de-duped tenant-scoped in the same transaction
 * as the write.
 *
 * Story 1.2 landed the real storage: the `idempotency_keys` table (unique
 * `(tenant_id, key)`, payload hash, response snapshot) and the
 * same-transaction de-dupe live in the tenancy module's command services
 * (`modules/tenancy/*-command.ts`) — the first command-layer consumers.
 * This file stays the contract-only key-format primitive; new mutating
 * endpoints follow the command-service pattern rather than building
 * storage here.
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
