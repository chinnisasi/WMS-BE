import { decimalPlaces, precisionRefusalDetail, validateRecordableQuantity } from '../primitives/quantity';

/**
 * A spreadsheet quantity cell's text rule — moved here from the ASN import's
 * parse (story 4-1c) so the order import reads quantities exactly as the ASN
 * import does; `inbound/asn-import.parse.ts` re-exports both unchanged.
 */

const QUANTITY_TEXT = /^\d+(\.\d+)?$/;

/** The quantity cell's SHAPE: digits with an optional fraction — no sign, no exponent, no separators. */
export function isQuantityText(text: string): boolean {
  return QUANTITY_TEXT.test(text.trim());
}

/**
 * The quantity cell → milli-units, at the SKU's declared precision, through
 * the catalog's import-edge core (`validateRecordableQuantity`, sign
 * `positive` — the HTTP field's `@Min(0.001)`). The precision is read from
 * the cell's TEXT (trailing zeros of the fraction dropped), never from a
 * float: `1.0000000000000000001` is refused, not rounded to 1. An XLSX
 * number cell arrives as its shortest round-tripping decimal string.
 */
export function quantityToMilli(
  text: string,
  uom: string,
  precision: number,
):
  | { ok: true; milli: number }
  | { ok: false; code: 'invalid-quantity' | 'quantity-precision'; detail: string } {
  const value = text.trim();
  if (!QUANTITY_TEXT.test(value)) {
    return {
      ok: false,
      code: 'invalid-quantity',
      detail: `quantity must be a positive number in the SKU's base unit — digits with an optional decimal point (got "${value}").`,
    };
  }
  const fraction = value.includes('.') ? value.slice(value.indexOf('.') + 1).replace(/0+$/, '') : '';
  const number = Number(value);
  if (fraction.length > precision) {
    return {
      ok: false,
      code: 'quantity-precision',
      detail:
        decimalPlaces(number) === fraction.length
          ? precisionRefusalDetail('quantity', number, uom, precision)
          : `quantity "${value}" carries ${fraction.length} decimal places; base UoM "${uom}" declares ${precision}. It is refused rather than rounded.`,
    };
  }
  const result = validateRecordableQuantity(number, 'quantity', uom, precision, 'positive');
  if (result.ok) {
    return { ok: true, milli: result.milli };
  }
  return {
    ok: false,
    code: result.arm === 'precision' ? 'quantity-precision' : 'invalid-quantity',
    detail: result.detail,
  };
}

