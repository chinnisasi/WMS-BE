/**
 * The shipment address primitive (story 11-1): the ONE field set both the
 * order destination and the warehouse origin use. Structured, never free
 * text — carriers rate, label and manifest from it (story 4-6d), so every
 * field is queryable and the pincode stays TEXT (`/^\d{6}$/`, leading zeros
 * are significant), never an integer.
 *
 * Validation lives HERE, at the command layer (`assertAddress`), not only in
 * the DTOs — the Epic 7 adapter path and every other non-HTTP caller bypass
 * the ValidationPipe, and the command is the boundary that keeps a bad
 * address out of the columns. The DTOs import the same constants and the
 * same regex (their message wording is class-validator's own; the command's
 * wording here is the canonical one).
 *
 * No country field — India-only by design (GST, paise, Indian carriers).
 * Extensibility is noted, not built.
 */
import { ProblemException } from '../problem-details/problem.exception';

/** The pincode is text: six digits exactly, leading zeros preserved. */
export const PINCODE_RE = /^\d{6}$/;

/**
 * Length ceilings per field (the command's 400 names the offender). The DTOs
 * import these rather than copying literals — a literal here and one there
 * drifts silently (the pack-bounds import precedent in `outbound.dto.ts`).
 */
export const ADDRESS_FIELD_LENGTHS = {
  contactName: 120,
  phone: 20,
  line1: 200,
  line2: 200,
  city: 100,
  state: 100,
} as const;

/** One address as the client supplies it. `line2` is the only optional field. */
export interface AddressInput {
  readonly contactName: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2?: string | undefined;
  readonly city: string;
  readonly state: string;
  readonly pincode: string;
}

/** One stored address as every read of it returns. Absent `line2` is null. */
export interface AddressSnapshot {
  readonly contactName: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly state: string;
  readonly pincode: string;
}

const REQUIRED_ADDRESS_FIELDS = [
  'contactName',
  'phone',
  'line1',
  'city',
  'state',
  'pincode',
] as const;

type RequiredAddressField = (typeof REQUIRED_ADDRESS_FIELDS)[number];

/** Every field of the address, `line2` included (typed, then shaped). */
const ADDRESS_FIELDS = [...REQUIRED_ADDRESS_FIELDS, 'line2'] as const;

/**
 * Trims every field and treats a whitespace-only `line2` as absent — the
 * command-layer twin of the DTO's `@Trim`. Pure and deterministic, so the
 * idempotency payload hash (which fingerprints the NORMALIZED address, fixed
 * key order) is stable across equivalent inputs. Returns `undefined` when
 * nothing at all was supplied (an absent address), so callers can distinguish
 * "no address" from "an address to validate".
 */
export function normalizeAddressInput(
  input: AddressInput | null | undefined,
): AddressInput | undefined {
  if (input === undefined || input === null) return undefined;
  const trim = (value: unknown): string | undefined =>
    typeof value === 'string' ? value.trim() : undefined;
  const line2 = trim(input.line2);
  return {
    contactName: trim(input.contactName) ?? '',
    phone: trim(input.phone) ?? '',
    line1: trim(input.line1) ?? '',
    line2: line2 === '' ? undefined : line2,
    city: trim(input.city) ?? '',
    state: trim(input.state) ?? '',
    pincode: trim(input.pincode) ?? '',
  };
}

/**
 * The fixed-key-order fingerprint both payload hashes carry (the
 * idempotency hash is key-order dependent). `line2` absent fingerprints as
 * `undefined` — `JSON.stringify` drops it, so a body without line2 and one
 * with `line2: ''` hash identically.
 */
export function addressFingerprint(
  address: AddressInput | null | undefined,
): Record<string, unknown> | undefined {
  if (address === undefined || address === null) return undefined;
  return {
    contactName: address.contactName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    pincode: address.pincode,
  };
}

/**
 * Command-side address validation — the boundary that keeps a bad address
 * out of the columns (the Epic 7 adapter path bypasses DTO validation).
 * Two rules, in this order:
 *
 * 1. **Atomic**: an address is entered whole. Any field present (or the
 *    address required but absent) with a required one missing is a 400
 *    naming every missing field — never a partial address in the columns.
 * 2. **Shapes**: each field non-empty and inside its ceiling; the pincode
 *    exactly six digits.
 *
 * Call it behind the command's replay lookup (the order-create preflight
 * precedent): a refusal here must never answer 400 to an op that already
 * committed. Returns the NORMALIZED address — every caller writes what this
 * returns, never the raw input.
 */
export function assertAddress(
  input: AddressInput | null | undefined,
  label: string,
): AddressInput {
  // Typed before shaped: a non-string field (JSON numbers, booleans, nulls)
  // is refused by name — never coerced into a missing field or a silent
  // drop. A null/absent address falls through to the required refusal below.
  const raw = input as Record<string, unknown> | null | undefined;
  for (const field of ADDRESS_FIELDS) {
    const value = raw?.[field];
    if (value !== undefined && typeof value !== 'string') {
      throw addressValidationFailed(`${label}.${field} must be text.`);
    }
  }
  const address = normalizeAddressInput(input);
  if (address === undefined) {
    throw addressValidationFailed(
      `${label} is required — an order (or warehouse) carries a full address: contactName, phone, line1, city, state and pincode.`,
    );
  }
  // After normalization every required field is a string; only '' is missing.
  const missing: RequiredAddressField[] = REQUIRED_ADDRESS_FIELDS.filter(
    (field) => address[field] === '',
  );
  // An address is atomic: a caller who supplied some fields but left a
  // required one out (or supplied an empty object) is refused by name, never
  // silently stored as a partial address.
  if (missing.length > 0) {
    throw addressValidationFailed(
      `${label} is incomplete — missing ${missing
        .map((field) => `${label}.${field}`)
        .join(', ')}. An address is entered whole, never partial.`,
    );
  }
  for (const field of REQUIRED_ADDRESS_FIELDS) {
    const value = address[field] as string;
    const ceiling = field === 'pincode' ? 6 : ADDRESS_FIELD_LENGTHS[field];
    if (value.length > ceiling) {
      throw addressValidationFailed(
        `${label}.${field} is at most ${ceiling} characters (got ${value.length}).`,
      );
    }
  }
  if (address.line2 !== undefined && address.line2.length > ADDRESS_FIELD_LENGTHS.line2) {
    throw addressValidationFailed(
      `${label}.line2 is at most ${ADDRESS_FIELD_LENGTHS.line2} characters (got ${address.line2.length}).`,
    );
  }
  if (!PINCODE_RE.test(address.pincode)) {
    throw addressValidationFailed(
      `${label}.pincode must be a 6-digit Indian pincode, as text (got "${address.pincode}").`,
    );
  }
  return address as AddressInput;
}

/**
 * Builds the read shape from nullable columns. Pre-11.1 rows (all null)
 * read back `destination: null` — the null-vs-absent convention.
 */
export function addressFromColumns(columns: {
  contactName: string | null;
  phone: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
}): AddressSnapshot | null {
  if (columns.contactName === null) return null;
  return {
    contactName: columns.contactName,
    phone: columns.phone ?? '',
    line1: columns.line1 ?? '',
    line2: columns.line2,
    city: columns.city ?? '',
    state: columns.state ?? '',
    pincode: columns.pincode ?? '',
  };
}

function addressValidationFailed(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Address validation failed', detail);
}
