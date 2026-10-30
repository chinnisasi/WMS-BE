/**
 * Story 4-4a (A7) — the parcel tag's code: `'O'` + the order id's LAST 16
 * hex digits, upper-cased (17 characters, Code 128 subset B, 222 modules —
 * it fits the 4×2 label at 2-dot bars; the full 32-hex id would not). The
 * code is a MATCH KEY against a list the server provided (the device's
 * snapshot, the web's candidates read) — never resolved server-side alone:
 * 64 random bits make a collision among one warehouse's packed orders
 * negligible, and a list holding two matches makes the client ask which.
 * Pure. Mirrored byte for byte in wms-fe and wms-mobile, pinned by
 * `parcel-tag.vectors.json`.
 */

import { PARCEL_TAG_CODE_RE } from './awb';

/** The 17-character code printed on the parcel tag. */
export function parcelTagCode(orderId: string): string {
  const hex = orderId.replace(/-/g, '').toUpperCase();
  return `O${hex.slice(-16)}`;
}

/** The order-id suffix (16 lower-case hex digits) a tag code names, or null when it is not a tag code. */
export function parcelTagOrderSuffix(code: string): string | null {
  const value = code.trim().toUpperCase();
  return PARCEL_TAG_CODE_RE.test(value) ? value.slice(1).toLowerCase() : null;
}

/** Does `code` name `orderId`? */
export function parcelTagMatches(code: string, orderId: string): boolean {
  const suffix = parcelTagOrderSuffix(code);
  return suffix !== null && orderId.replace(/-/g, '').toLowerCase().endsWith(suffix);
}
