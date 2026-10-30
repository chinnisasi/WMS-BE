import { ArithmeticOverflowError } from './arith';
import { istDateOf as sharedIstDateOf } from '../../shared/primitives/time';

/**
 * The e-way bill threshold (story 8-2b): which consignments need an EWB.
 *
 * Thresholds are versioned DATA, never code literals (AD-9): the national
 * rule (CGST Rule 138(1), ₹50,000) lives in `eway_national_thresholds`, and a
 * tenant's per-state intra-state overrides in the append-only
 * `eway_state_thresholds`. The one in force on the invoice's IST issue date
 * applies.
 */

/** One frozen invoice line as the value computation sees it (paise / bps). */
export interface EwayValueLine {
  readonly gstBps: number;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
}

/**
 * The consignment value (Rule 138, Explanation 2): Σ (taxable + CGST + SGST
 * + IGST) over the TAXABLE lines, in exact integer paise. A 0% line is an
 * exempt supply and is excluded. Cess is never modelled (always 0).
 */
export function consignmentValuePaise(lines: readonly EwayValueLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (line.gstBps <= 0) continue;
    total += line.taxablePaise + line.cgstPaise + line.sgstPaise + line.igstPaise;
  }
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ArithmeticOverflowError(`e-way consignment value is not a safe non-negative integer (got ${String(total)})`);
  }
  return total;
}

/**
 * The IST calendar date (`YYYY-MM-DD`) an instant falls on — the shared
 * primitive (`shared/primitives/time.ts`, moved there by story 21-3),
 * re-exported with this module's typed failure: an unparseable instant is
 * an `ArithmeticOverflowError`, which `eway.delivery.ts` acks as a data
 * fault rather than retrying.
 */
export function istDateOf(instant: string): string {
  try {
    return sharedIstDateOf(instant);
  } catch {
    throw new ArithmeticOverflowError(`e-way: unparseable instant "${instant}"`);
  }
}

// Story 4-6a (A8, D6) — moved to `shared/eway/eway-threshold.ts` unchanged
// (the order consignment gate and the return dispatches share them);
// re-exported so every importer of this file stands.
export {
  THRESHOLD_RULE_RE,
  ewayRequired,
  thresholdFor,
  type ThresholdInForce,
  type ThresholdQuery,
} from '../../shared/eway/eway-threshold';
