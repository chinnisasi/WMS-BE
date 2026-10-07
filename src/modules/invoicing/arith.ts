import { divideRoundHalfUp } from '../../shared/primitives/money';
import { ArithmeticOverflowError } from '../../shared/primitives/gst';

/**
 * Invoicing's exact integer arithmetic (story 8-1). Every money value is
 * integer paise, every GST rate basis points, every quantity milli-units —
 * and the two divisions this math performs (qty × rate → taxable, taxable ×
 * bps → tax) round HALF-UP at the line boundary, per line, never on totals
 * (totals are sums of already-rounded lines, which is what keeps the
 * two-sum invariants provable).
 *
 * Multiplications run through BigInt internally: at the extremes of the
 * domain's ranges (`MAX_QUANTITY_MILLI` ≈ 9×10¹⁵ against a real paise rate)
 * the intermediate product exceeds the IEEE double's 2⁵³ exact-integer
 * ceiling, and a `number` multiply would silently round BEFORE the half-up
 * divide — inventing paise nobody agreed to. BigInt carries the product and
 * the division exactly; the RESULT is converted back with a loud safe-integer
 * assertion (the `assertExactQuantity` philosophy in quantity.ts: an
 * out-of-range value is a named failure at the boundary, never a silent wrap
 * downstream).
 *
 * No floats anywhere in this file, and no dependency on order of summation.
 */

/**
 * Story 21-5 — the tax arithmetic (`computeLineTax`, `assertInvoiceTotals`,
 * `roundToRupee`, `asPaise`, `asGstBps`, the bounds and the error class)
 * moved UNCHANGED to `shared/primitives/gst.ts`: the 3PL services invoice
 * (billing) computes tax the same way. Re-exported here so every importer
 * stands; `ArithmeticOverflowError` is the SAME class (the delivery handlers
 * ack it as a data fault — a wrapper would have changed that contract).
 */
export {
  ArithmeticOverflowError,
  GST_BPS_CEILING,
  ROUND_OFF_MAX,
  ROUND_OFF_MIN,
  asGstBps,
  asPaise,
  assertInvoiceTotals,
  computeLineTax,
  roundToRupee,
  type LineTax,
  type SupplyType,
} from '../../shared/primitives/gst';

/**
 * Half-up division `numerator / denominator` for non-negative safe-integer
 * operands, exact at the remainder boundary (r × 2 ≥ denominator rounds up).
 * This is THE half-up of the invoice: one definition, one rounding edge.
 */
export function divRound(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new ArithmeticOverflowError(
      `divRound numerator must be a non-negative safe integer (got ${String(numerator)})`,
    );
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new ArithmeticOverflowError(
      `divRound denominator must be a positive safe integer (got ${String(denominator)})`,
    );
  }
  if (numerator === 0) return 0;
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator - quotient * denominator;
  // The doubled-remainder comparison avoids the `numerator/denominator + 0.5`
  // float expression, which can flip on values that sit exactly on the edge.
  return remainder * 2 >= denominator ? quotient + 1 : quotient;
}

/**
 * The BigInt half-up divide arith.ts runs everything through — moved to
 * `shared/primitives/money.ts` (story 21-4: storage metering rounds the same
 * way) and re-exported here unchanged.
 */
export { divideRoundHalfUp };
