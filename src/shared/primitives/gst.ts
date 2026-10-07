import { divideRoundHalfUp, type Paise } from './money';
import { QUANTITY_SCALE, type GstBps } from './quantity';
import { IST_OFFSET_MS } from './time';

/**
 * The GST primitive (story 21-5): the exact integer tax arithmetic and the
 * tax-invoice numbering that BOTH invoice paths share — the goods tax invoice
 * (`modules/invoicing`, story 8-1) and the 3PL services tax invoice
 * (`modules/billing` client invoices, story 21-5). Moved here unchanged from
 * `invoicing/arith.ts` and `invoicing/generator.ts`, which re-export every
 * name so their importers stand; the error class moved WITH them, so
 * `ArithmeticOverflowError` is one class whichever path imports it (the
 * invoicing delivery handlers ack exactly that type as a data fault).
 *
 * Every money value is integer paise, every GST rate basis points, every
 * quantity milli-units — and the two divisions this math performs (qty ×
 * rate → taxable, taxable × bps → tax) round HALF-UP at the line boundary,
 * per line, never on totals (totals are sums of already-rounded lines, which
 * is what keeps the two-sum invariants provable).
 *
 * Multiplications run through BigInt internally: at the extremes of the
 * domain's ranges the intermediate product exceeds 2⁵³, and a `number`
 * multiply would silently round BEFORE the half-up divide. The RESULT is
 * converted back with a loud safe-integer assertion. No floats anywhere.
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

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArithmeticOverflowError(
      `invoice arithmetic left the exact paise range: ${value.toString()} (ceiling ${Number.MAX_SAFE_INTEGER})`,
    );
  }
  return Number(value);
}
// ── FY numbering ─────────────────────────────────────────────────────────────

/**
 * The financial-year label of an issuance instant: April 1 – March 31 in
 * Asia/Kolkata, rendered `FY-2627` (October 2026 opens FY-2627; March 2027
 * still closes FY-2627 — the label of the FY the instant falls INSIDE).
 * India is UTC+05:30 year-round (no DST) — the FY is read off the IST clock.
 */
export function fyLabelFor(instant: string): string {
  const ist = new Date(Date.parse(instant) + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  // getUTCMonth(): 0 = January … 3 = April. Month ≥ 3 (April) opens the FY
  // named for THAT year; Jan–Mar belongs to the FY the previous year opened.
  const startYear = ist.getUTCMonth() >= 3 ? year : year - 1;
  const pad = (n: number): string => String(n % 100).padStart(2, '0');
  return `FY-${pad(startYear)}${pad(startYear + 1)}`;
}

/**
 * GST's ceiling on a tax-invoice number (Rule 46(b), CGST Rules): at most 16
 * characters. The goods format is 14 at a 6-digit sequence; the services
 * format (`formatServiceInvoiceNo`) is 15.
 */
export const INVOICE_NO_MAX_LENGTH = 16;

function assertNumberParts(kind: string, gstin: string, fyLabel: string, seq: number): void {
  if (!/^FY-\d{4}$/.test(fyLabel)) {
    throw new ArithmeticOverflowError(`${kind}: malformed FY label "${fyLabel}"`);
  }
  if (!/^[0-9]{2}/.test(gstin)) {
    throw new ArithmeticOverflowError(`${kind}: supplier GSTIN "${gstin}" carries no state-code prefix`);
  }
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new ArithmeticOverflowError(`${kind}: sequence must be a positive integer (got ${String(seq)})`);
  }
}

function assertNumberLength(invoiceNo: string, gstin: string, fyLabel: string): string {
  if (invoiceNo.length > INVOICE_NO_MAX_LENGTH) {
    throw new ArithmeticOverflowError(
      `invoice number "${invoiceNo}" exceeds GST's ${INVOICE_NO_MAX_LENGTH}-character limit — the series for ${gstin} ${fyLabel} is exhausted`,
    );
  }
  return invoiceNo;
}

/**
 * The goods invoice number (story 8-1b): the supplier GSTIN's two-digit state
 * code, the FY digits, and the 6-digit sequence — `29/2627/000001` (14
 * chars). The prefix is ALWAYS the GSTIN's own first two characters, never a
 * resolved state code. Two GSTINs in one state print identical numbers by
 * design; consumers key on (originGstin, invoiceNo), never the number alone.
 */
export function formatInvoiceNo(originGstin: string, fyLabel: string, seq: number): string {
  assertNumberParts('invoice number', originGstin, fyLabel, seq);
  return assertNumberLength(`${originGstin.slice(0, 2)}/${fyLabel.slice(3)}/${String(seq).padStart(6, '0')}`, originGstin, fyLabel);
}

/**
 * The SERVICES invoice number (story 21-5, decision 3): a 3PL client invoice
 * numbers in its OWN series per supplying GSTIN per FY, never interleaved
 * with the goods series — `29/S2627/000001` (15 chars; the `S` keeps the two
 * series apart on paper, since both start at 000001). Same prefix rule as
 * `formatInvoiceNo` (the GSTIN's own two characters), same ≤ 16 assertion —
 * a 7-digit sequence (16 chars) still fits, sequence 10,000,000 throws.
 */
export function formatServiceInvoiceNo(supplierGstin: string, fyLabel: string, seq: number): string {
  assertNumberParts('service invoice number', supplierGstin, fyLabel, seq);
  return assertNumberLength(
    `${supplierGstin.slice(0, 2)}/S${fyLabel.slice(3)}/${String(seq).padStart(6, '0')}`,
    supplierGstin,
    fyLabel,
  );
}
