/**
 * Story 2-6a — serial numbers captured at receipt: the shape every serial
 * must have, the per-SKU serial FORMAT (`free` | `imei`) and the caps.
 *
 * One rule set, two runtimes: the handheld carries the same rules in
 * `wms-mobile src/lib/serial.ts`, and both repos run the SAME vector file
 * (`test/fixtures/serial-vectors.json` here, `src/lib/serial-vectors.json`
 * there — byte-identical, its sha256 pinned in each repo's test), so the
 * device can never accept offline what the server refuses.
 */

/** The serial formats a serial-tracked SKU may declare (`skus.serial_format`, CHECK in 0096). */
export const SERIAL_FORMATS = ['free', 'imei'] as const;
export type SerialFormat = (typeof SERIAL_FORMATS)[number];

export function isSerialFormat(value: unknown): value is SerialFormat {
  return typeof value === 'string' && (SERIAL_FORMATS as readonly string[]).includes(value);
}

/**
 * A serial after trimming: 1–64 printable ASCII characters, no whitespace
 * (`!`..`~`). 64 is putaway's own bound (`putaway.dto.ts`), so a serial that
 * books can always be placed. Case-sensitive; never normalised further.
 */
export const SERIAL_NUMBER_RE = /^[\x21-\x7E]{1,64}$/;
export const MAX_SERIAL_NUMBER_LENGTH = 64;

/** True when `value` (already trimmed) has a serial's shape. */
export function isSerialNumberShape(value: string): boolean {
  return SERIAL_NUMBER_RE.test(value);
}

/**
 * An IMEI: exactly 15 ASCII digits whose last digit is the Luhn check digit
 * of the first 14 (3GPP TS 23.003). The server runs it as-is on the trimmed
 * value — no spaces, hyphens or prefixes are stripped here (the device
 * parses those before it queues).
 */
export function isValidImei(value: string): boolean {
  if (!/^[0-9]{15}$/.test(value)) {
    return false;
  }
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    let digit = value.charCodeAt(index) - 48;
    // Luhn doubles every second digit counting from the right of the body;
    // with a 14-digit body that is every odd index (0-based).
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === value.charCodeAt(14) - 48;
}

/**
 * At most this many units per GRN line carry a serial row — captured serials
 * PLUS unreadable units (A9). Pinned against `grls_ordinal_range`'s literal
 * `499` (ordinal 0..499) by `test/serial-receipt.spec.ts`.
 */
export const MAX_GRN_SERIALS_PER_LINE = 500;

/** At most this many serials in one receipt — the adjustment's own bound. */
export const MAX_GRN_SERIALS_PER_RECEIPT = 1000;

/** The states of a `goods_receipt_line_serials` row (`grls_state_check`, 0096). */
export const GRN_LINE_SERIAL_STATES = ['applied', 'pending', 'rejected', 'unreadable'] as const;
export type GrnLineSerialState = (typeof GRN_LINE_SERIAL_STATES)[number];
