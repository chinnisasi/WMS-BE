import { divideRoundHalfUp, type Paise } from '../../shared/primitives/money';
import { QUANTITY_SCALE, type GstBps } from '../../shared/primitives/quantity';

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

export type SupplyType = 'intra' | 'inter';

/** GST rate ceiling in basis points (10000 = 100%). Zero consumers before 8-1. */
export const GST_BPS_CEILING = 10_000;

/** Money ceiling: every paise amount the math emits is an exact double — or it fails loudly. */
const PAISE_CEILING = Number.MAX_SAFE_INTEGER;

export class ArithmeticOverflowError extends Error {}

/**
 * The branded boundary: integer paise and integer basis points as they come
 * off the DB or a command input. (`paise()`/`gstBps()` in shared/primitives
 * take rupees and percent — the wrong unit here.) Out-of-range values are the
 * same typed failure `computeLineTax`'s own guards raise.
 */
export function asPaise(value: number): Paise {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArithmeticOverflowError(`paise must be a non-negative safe integer (got ${String(value)})`);
  }
  return value as Paise;
}

export function asGstBps(value: number): GstBps {
  if (!Number.isSafeInteger(value) || value < 0 || value > GST_BPS_CEILING) {
    throw new ArithmeticOverflowError(`gstBps out of range (0–${GST_BPS_CEILING}): ${String(value)}`);
  }
  return value as GstBps;
}

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
 * One line's tax slab, computed exactly. `taxable = roundHalfUp(qty × rate,
 * 1000)` (qty milli × rate paise-per-BASE-unit), then `tax =
 * roundHalfUp(taxable × gstBps, 10000)`. Intra-state splits the tax CGST /
 * SGST with the odd paise to SGST (rendered "SGST/UTGST" on the document —
 * the union-territory arm is SGST-shaped at the storage layer by the
 * 8-1 review's UTGST disposition); inter-state carries the whole tax as
 * IGST. Outputs are asserted safe integers — a rate that pushes a line past
 * the exact range throws a typed overflow instead of silently rounding.
 */
export interface LineTax {
  readonly taxablePaise: Paise;
  readonly gstPaise: Paise;
  readonly cgstPaise: Paise;
  readonly sgstPaise: Paise;
  readonly igstPaise: Paise;
}

export function computeLineTax(
  qtyMilli: number,
  ratePaise: Paise,
  gstBps: GstBps,
  supplyType: SupplyType | null,
): LineTax {
  for (const [name, value] of Object.entries({ qtyMilli, ratePaise, gstBps })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ArithmeticOverflowError(
        `computeLineTax ${name} must be a non-negative safe integer (got ${String(value)})`,
      );
    }
  }
  if (gstBps > GST_BPS_CEILING) {
    throw new ArithmeticOverflowError(`gstBps out of range (0–${GST_BPS_CEILING}): ${gstBps}`);
  }

  // The two divisions run in BigInt space so the intermediate product is
  // exact at any safe-integer operand combination the callers can send.
  const taxable = divideRoundHalfUp(BigInt(qtyMilli) * BigInt(ratePaise), BigInt(QUANTITY_SCALE));
  let totalTax = divideRoundHalfUp(taxable * BigInt(gstBps), BigInt(GST_BPS_CEILING));

  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  if (supplyType === null) {
    // The supply type is unresolvable (place-of-supply gap): the taxable
    // value still computes (the parked invoice's totals stay reviewable)
    // but NO tax is charged — the whole slab settles to zero, which keeps
    // gst == cgst + sgst + igst true here too (0 == 0); the flip to
    // `issued` is what makes the invariants load-bearing.
    totalTax = 0n;
  } else if (supplyType === 'intra') {
    // Half-up split with the odd paise to SGST (rendered "SGST/UTGST"):
    // CGST takes the floor half.
    cgst = totalTax / 2n;
    sgst = totalTax - cgst;
    if (cgst + sgst !== totalTax) {
      throw new ArithmeticOverflowError('cgst + sgst != gst: split invariant breached');
    }
  } else {
    igst = totalTax;
  }

  const out: LineTax = {
    taxablePaise: asPaise(toSafeNumber(taxable)),
    gstPaise: asPaise(toSafeNumber(totalTax)),
    cgstPaise: asPaise(toSafeNumber(cgst)),
    sgstPaise: asPaise(toSafeNumber(sgst)),
    igstPaise: asPaise(toSafeNumber(igst)),
  };
  // cgst+sgst+igst == totalTax is asserted inside the intra split above and
  // holds trivially for inter; the invoice-level family lives in
  // assertInvoiceTotals.
  return out;
}

/**
 * The invoice-level two-sum invariants (`arith.ts`'s checked totals):
 * subtotal + gst = total, and cgst + sgst + igst = gst. Throws on breach —
 * a generation path that violates them must fail loudly here rather than
 * storing money that does not reconcile (FR-26).
 */
export function assertInvoiceTotals(input: {
  subtotalPaise: number;
  gstPaise: number;
  totalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}): void {
  const { subtotalPaise, gstPaise, totalPaise, cgstPaise, sgstPaise, igstPaise } = input;
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ArithmeticOverflowError(
        `invoice totals ${name} must be a non-negative safe integer (got ${String(value)})`,
      );
    }
  }
  if (subtotalPaise + gstPaise !== totalPaise) {
    throw new ArithmeticOverflowError(
      `two-sum invariant breached: subtotal (${subtotalPaise}) + gst (${gstPaise}) != total (${totalPaise})`,
    );
  }
  if (cgstPaise + sgstPaise + igstPaise !== gstPaise) {
    throw new ArithmeticOverflowError(
      `two-sum invariant breached: cgst (${cgstPaise}) + sgst (${sgstPaise}) + igst (${igstPaise}) != gst (${gstPaise})`,
    );
  }
  if (totalPaise > PAISE_CEILING) {
    // Unreachable after the safe-integer guard above; kept named because
    // "the total is a paise integer" is the contract 21-5 will read.
    throw new ArithmeticOverflowError(`total out of safe paise range: ${String(totalPaise)}`);
  }
}

/** The signed round-off bounds: half-up at 50 paise puts `payable − total` in −49…+50. */
export const ROUND_OFF_MIN = -49;
export const ROUND_OFF_MAX = 50;

/**
 * The rupee rounding of an invoice's payable (story 8-1b, the human decision):
 * half-up at 50 paise — `payable = ⌊(total + 50) / 100⌋ × 100` and
 * `roundOff = payable − total`, so 228060 → 228100 (+40), 435449 → 435400
 * (−49), 435450 → 435500 (+50). It touches ONLY total → payable; taxable,
 * GST and every per-tax amount stay paise-exact.
 *
 * `roundOff` is a plain checked integer, NOT `Paise` (`asPaise` rejects the
 * negative arm). The arithmetic is integer-only (`%` on a safe integer is
 * exact — no float division), and `total + 50` is guarded inside the safe
 * range. Migration 0054's `div(total + 50, 100) * 100` is the SQL twin; the
 * parity test in invoicing.spec.ts pins that the two agree.
 */
export function roundToRupee(total: Paise): { payable: Paise; roundOff: number } {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ArithmeticOverflowError(`roundToRupee total must be a non-negative safe integer (got ${String(total)})`);
  }
  if (total > PAISE_CEILING - 50) {
    throw new ArithmeticOverflowError(
      `roundToRupee total + 50 leaves the exact paise range: ${String(total)} (ceiling ${PAISE_CEILING - 50})`,
    );
  }
  const shifted = total + 50;
  const payable = shifted - (shifted % 100);
  const roundOff = payable - total;
  if (!Number.isSafeInteger(roundOff) || roundOff < ROUND_OFF_MIN || roundOff > ROUND_OFF_MAX) {
    throw new ArithmeticOverflowError(`round-off out of range (${ROUND_OFF_MIN}…${ROUND_OFF_MAX}): ${String(roundOff)}`);
  }
  return { payable: asPaise(payable), roundOff };
}

/**
 * The BigInt half-up divide arith.ts runs everything through — moved to
 * `shared/primitives/money.ts` (story 21-4: storage metering rounds the same
 * way) and re-exported here unchanged.
 */
export { divideRoundHalfUp };

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArithmeticOverflowError(
      `invoice arithmetic left the exact paise range: ${value.toString()} (ceiling ${Number.MAX_SAFE_INTEGER})`,
    );
  }
  return Number(value);
}