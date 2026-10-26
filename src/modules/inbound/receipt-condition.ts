/**
 * Story 2-4a — the condition of a received line: the two closed vocabularies
 * a `grn.submit` line names beside its good quantity.
 *
 * - **Damaged** (`damagedQty` + `damageReasonCode`): units that arrived
 *   damaged. They are booked straight into the warehouse's system DAMAGED
 *   bin (`grn.damaged`), outside ATP, and never credit the PO or ASN line.
 * - **Short** (`shortQty` + `shortReasonCode`): units the supplier's invoice
 *   or challan listed that never arrived. Recorded on the line only — no
 *   stock, no document effect.
 *
 * Three mirrored layers (IMPLEMENTATION-GUIDE §4): these tuples, the pairing
 * CHECKs in `drizzle/0087_receipt_line_condition.sql`, and `@IsIn` on the
 * DTO. `test/receipt-condition.spec.ts` pins the tuples against the CHECKs.
 */
export const DAMAGE_REASON_CODES = ['crushed', 'wet', 'torn-packaging', 'broken', 'leaking', 'pest', 'other'] as const;
export type DamageReasonCode = (typeof DAMAGE_REASON_CODES)[number];

export const SHORT_REASON_CODES = ['not-shipped', 'short-packed', 'lost-in-transit', 'other'] as const;
export type ShortReasonCode = (typeof SHORT_REASON_CODES)[number];

export function isDamageReasonCode(value: unknown): value is DamageReasonCode {
  return typeof value === 'string' && (DAMAGE_REASON_CODES as readonly string[]).includes(value);
}

export function isShortReasonCode(value: unknown): value is ShortReasonCode {
  return typeof value === 'string' && (SHORT_REASON_CODES as readonly string[]).includes(value);
}

/**
 * The line-condition keys a stored review row, a `rejectedLines` entry and a
 * snapshot line carry — each ONLY when its quantity is > 0, so a line
 * without damage or short is byte-identical to its pre-2-4a shape (a reason
 * never rides without its quantity). Quantities as given (the caller passes
 * base units for a wire shape).
 */
export function lineConditionFields(line: {
  readonly damagedQty?: number | null | undefined;
  readonly damageReasonCode?: string | null | undefined;
  readonly shortQty?: number | null | undefined;
  readonly shortReasonCode?: string | null | undefined;
}): {
  damagedQty?: number;
  damageReasonCode?: string;
  shortQty?: number;
  shortReasonCode?: string;
} {
  const damaged = typeof line.damagedQty === 'number' && line.damagedQty > 0 ? line.damagedQty : 0;
  const short = typeof line.shortQty === 'number' && line.shortQty > 0 ? line.shortQty : 0;
  return {
    ...(damaged > 0 ? { damagedQty: damaged } : {}),
    ...(damaged > 0 && typeof line.damageReasonCode === 'string' ? { damageReasonCode: line.damageReasonCode } : {}),
    ...(short > 0 ? { shortQty: short } : {}),
    ...(short > 0 && typeof line.shortReasonCode === 'string' ? { shortReasonCode: line.shortReasonCode } : {}),
  };
}

/**
 * Story 2-5a (A3) — the photo refs a stored review row's line carries, ONLY
 * when non-empty, so a row without photos is byte-identical to its pre-2-5a
 * shape (the `lineConditionFields` precedent). Used by the three review-row
 * payload builders only (`grn.lines-refused`, `grn.shelf-life-refused`,
 * `grn.licence-refused`) — never by `clientRefusalLines` or a
 * `rejectedLines` entry.
 */
export function linePhotoFields(line: { readonly photoRefs?: readonly string[] | null | undefined }): { photoRefs?: string[] } {
  return Array.isArray(line.photoRefs) && line.photoRefs.length > 0 ? { photoRefs: [...line.photoRefs] } : {};
}
