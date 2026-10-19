/**
 * The REGISTERED address shape (story 1-2a for clients; story 1-3 moved it
 * here so business partners share the one rule): `line1, line2?, city,
 * stateCode, pincode` — the 21-5 billing columns' shapes, a two-digit GST
 * REGISTRATION state code and a six-digit pincode. Mirrored by the
 * `clients_registered_address_format` CHECK (0077) and the two
 * `business_partners_*_address_format` CHECKs (0079).
 *
 * Two steps, the house split: a LENIENT normalize that never throws (it is
 * what an idempotency hash fingerprints) and a strict assert that answers a
 * 400 `validation-failed` naming the field, behind the replay lookup.
 */
import { ProblemException } from '../problem-details/problem.exception';
import { ADDRESS_FIELD_LENGTHS, PINCODE_RE } from './address';
import { isGstinStateCode } from './gstin';

/** A registered address as a caller supplies it (`line2` optional). */
export interface RegisteredAddressInput {
  readonly line1: string;
  readonly line2?: string | null | undefined;
  readonly city: string;
  readonly stateCode: string;
  readonly pincode: string;
}

/** A registered address normalized (trimmed; a blank line2 absent). */
export interface NormalizedRegisteredAddress {
  readonly line1: string;
  readonly line2: string | undefined;
  readonly city: string;
  readonly stateCode: string;
  readonly pincode: string;
}

/** A registered address as every read returns it (an absent line2 is null). */
export interface RegisteredAddressSnapshot {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly stateCode: string;
  readonly pincode: string;
}

/** The lenient normalize (hashed; never throws). */
export function normalizeRegisteredAddress(input: RegisteredAddressInput | null): NormalizedRegisteredAddress | null {
  if (input === null) return null;
  const trim = (value: unknown): string => (typeof value === 'string' ? value.trim() : (value as string));
  const line2 = input.line2 === undefined || input.line2 === null ? undefined : trim(input.line2);
  return {
    line1: trim(input.line1),
    line2: line2 === '' ? undefined : line2,
    city: trim(input.city),
    stateCode: trim(input.stateCode),
    pincode: trim(input.pincode),
  };
}

/**
 * The shape rules: every field but line2 required, the ceilings, a GST
 * registration state code, a six-digit pincode. 400 `validation-failed`
 * naming `<label>.<field>` (`registeredAddress` unless the caller says).
 */
export function assertRegisteredAddress(
  address: NormalizedRegisteredAddress,
  label = 'registeredAddress',
): NormalizedRegisteredAddress {
  const invalid = (detail: string): ProblemException =>
    new ProblemException('validation-failed', 400, 'Invalid address', detail);
  for (const field of ['line1', 'city', 'stateCode', 'pincode'] as const) {
    if (typeof address[field] !== 'string' || address[field] === '') {
      throw invalid(`${label}.${field} is required — an address is entered whole, never partial.`);
    }
  }
  if (address.line2 !== undefined && typeof address.line2 !== 'string') {
    throw invalid(`${label}.line2 must be text.`);
  }
  const ceilings = { line1: ADDRESS_FIELD_LENGTHS.line1, line2: ADDRESS_FIELD_LENGTHS.line2, city: ADDRESS_FIELD_LENGTHS.city } as const;
  for (const field of ['line1', 'line2', 'city'] as const) {
    const value = address[field];
    if (value !== undefined && [...value].length > ceilings[field]) {
      throw invalid(`${label}.${field} is at most ${ceilings[field]} characters (got ${[...value].length}).`);
    }
  }
  if (!isGstinStateCode(address.stateCode)) {
    throw invalid(`${label}.stateCode must be a GST registration state code (got "${address.stateCode}").`);
  }
  if (!PINCODE_RE.test(address.pincode)) {
    throw invalid(`${label}.pincode must be six digits (got "${address.pincode}").`);
  }
  return address;
}
