import {
  GST_BPS_CEILING,
  ArithmeticOverflowError,
  asGstBps,
  asPaise,
  assertInvoiceTotals,
  computeLineTax as computeLineTaxBranded,
  divRound,
  roundToRupee,
} from '../src/modules/invoicing/arith';
import type { SupplyType } from '../src/modules/invoicing/arith';
import type { Paise } from '../src/shared/primitives/money';
import { MAX_QUANTITY_MILLI, QUANTITY_SCALE, type GstBps } from '../src/shared/primitives/quantity';
import {
  INVOICE_NO_MAX_LENGTH,
  documentsEqual,
  formatInvoiceNo,
  fyLabelFor,
  normalizeStateName,
  resolveStateCode,
} from '../src/modules/invoicing/generator';
import type { InvoiceDocument, StateCodeEntry } from '../src/modules/invoicing/generator';

/**
 * The invoicing arithmetic suite (story 8-1): pure unit tests over arith.ts
 * and the generator's pure helpers. No DB, no app — everything here is the
 * exact-integer contract: half-up at the line boundary, the two-sum
 * invariants, and the loud overflow. FR-26's reconciliation is only as good
 * as this math; these tests are its proof.
 */

/**
 * The table below feeds raw numbers — including invalid ones — on purpose:
 * it proves `computeLineTax`'s RUNTIME guards, which the brands cannot. The
 * shim lifts the brands for exactly that; production callers go through
 * `asPaise`/`asGstBps` (pinned at the end of this suite).
 */
function computeLineTax(qtyMilli: number, ratePaise: number, gstBps: number, supplyType: SupplyType | null) {
  return computeLineTaxBranded(qtyMilli, ratePaise as Paise, gstBps as GstBps, supplyType);
}

describe('invoicing arithmetic (story 8-1, unit)', () => {
  describe('divRound — THE half-up of the invoice', () => {
    it('rounds half-up at exactly the remainder boundary and nowhere else', () => {
      expect(divRound(0, 1000)).toBe(0);
      expect(divRound(1, 1000)).toBe(0); // .001 down
      expect(divRound(499, 1000)).toBe(0); // .499 down
      expect(divRound(500, 1000)).toBe(1); // exactly .5 → UP
      expect(divRound(501, 1000)).toBe(1); // .501 up
      expect(divRound(999, 1000)).toBe(1);
      expect(divRound(1000, 1000)).toBe(1);
      expect(divRound(1501, 1000)).toBe(2); // 1.501 → 2
      expect(divRound(2499, 1000)).toBe(2); // 2.499 → 2
      expect(divRound(2500, 1000)).toBe(3); // 2.5 → 3
    });

    it('rejects a negative numerator, a denominator of zero, and a non-safe-integer operand — loudly', () => {
      expect(() => divRound(-1, 1000)).toThrow(ArithmeticOverflowError);
      expect(() => divRound(1, 0)).toThrow(ArithmeticOverflowError);
      expect(() => divRound(1, -2)).toThrow(ArithmeticOverflowError);
      expect(() => divRound(1.5, 2)).toThrow(ArithmeticOverflowError);
      expect(() => divRound(Number.MAX_SAFE_INTEGER + 1, 2)).toThrow(ArithmeticOverflowError);
    });
  });

  describe('computeLineTax — per-line rounding, never on totals', () => {
    it('computes the documented example chain: taxable half-up over the milli scale, tax half-up over bps', () => {
      // 1.5 units at ₹1.00/unit, 18% GST, intra-state.
      // taxable = round(1500 × 100 / 1000) = 150 paise.
      const line = computeLineTax(1500, 100, 1800, 'intra');
      expect(line.taxablePaise).toBe(150);
      expect(line.gstPaise).toBe(27); // round(150 × 1800 / 10000) = 27
      // The odd paise of the split goes to SGST (rendered SGST/UTGST):
      expect(line.cgstPaise).toBe(13);
      expect(line.sgstPaise).toBe(14);
      expect(line.igstPaise).toBe(0);
      expect(line.cgstPaise + line.sgstPaise).toBe(line.gstPaise);
    });

    it('inter-state carries the whole tax as IGST with both halves at zero', () => {
      const line = computeLineTax(1500, 100, 1800, 'inter');
      expect(line.taxablePaise).toBe(150);
      expect(line.gstPaise).toBe(27);
      expect(line.igstPaise).toBe(27);
      expect(line.cgstPaise).toBe(0);
      expect(line.sgstPaise).toBe(0);
      expect(line.cgstPaise + line.sgstPaise + line.igstPaise).toBe(line.gstPaise);
    });

    it('splits every odd paise so cgst + sgst == gst, proven across a sweep of tax values', () => {
      // 0..500 paise covers every remainder class of /2 under the sweep.
      for (let taxable = 0; taxable <= 500; taxable += 1) {
        const line = computeLineTax(QUANTITY_SCALE, taxable, 10000, 'intra');
        expect(line.cgstPaise + line.sgstPaise).toBe(line.gstPaise);
        expect(line.gstPaise).toBe(taxable);
        if (line.gstPaise % 2 === 1) {
          expect(line.sgstPaise).toBe(line.gstPaise - line.cgstPaise);
          expect(line.cgstPaise).toBe(Math.floor(line.gstPaise / 2));
        }
      }
    });

    it('zero quantity, zero rate and zero bps all compute to zero without inventing negatives', () => {
      expect(computeLineTax(0, 100, 1800, 'intra')).toMatchObject({
        taxablePaise: 0, gstPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0,
      });
      expect(computeLineTax(1500, 0, 1800, 'inter')).toMatchObject({
        taxablePaise: 0, gstPaise: 0, igstPaise: 0,
      });
      expect(computeLineTax(1500, 100, 0, 'intra')).toMatchObject({
        taxablePaise: 150, gstPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0,
      });
    });

    it('stays EXACT at the domain edge: MAX_QUANTITY_MILLI against a real rate does not lose a paise', () => {
      // qty at the ceiling × ₹0.002/unit: the product (1.8×10¹³) is inside
      // the double's exact range, so the BigInt path must return exactly
      // what long division says.
      const line = computeLineTax(MAX_QUANTITY_MILLI, 2, 0, 'intra');
      expect(line.taxablePaise).toBe(18014398509480);
      // …and with GST: tax = round(18014398509480 × 1800 / 10000)
      // = round(3242591731706.4) → 3242591731706, half-up.
      const taxed = computeLineTax(MAX_QUANTITY_MILLI, 2, 1800, 'inter');
      expect(taxed.taxablePaise).toBe(18014398509480);
      expect(taxed.igstPaise).toBe(3242591731706);
      expect(taxed.cgstPaise).toBe(0); // inter
    });

    it('throws the typed overflow when the result leaves the exact paise range, instead of silently rounding', () => {
      // MAX_QUANTITY_MILLI × 2000 paise / 1000 = 1.8×10¹⁶ > 2⁵³−1.
      expect(() => computeLineTax(MAX_QUANTITY_MILLI, 2000, 1800, 'intra')).toThrow(
        ArithmeticOverflowError,
      );
    });

    it('rejects out-of-domain inputs by name', () => {
      expect(() => computeLineTax(-1, 100, 1800, 'intra')).toThrow(ArithmeticOverflowError);
      expect(() => computeLineTax(1500, -1, 1800, 'intra')).toThrow(ArithmeticOverflowError);
      expect(() => computeLineTax(1500, 100, -1, 'intra')).toThrow(ArithmeticOverflowError);
      expect(() => computeLineTax(1.5, 100, 1800, 'intra')).toThrow(ArithmeticOverflowError);
      expect(() => computeLineTax(1500, 100, GST_BPS_CEILING + 1, 'intra')).toThrow(
        ArithmeticOverflowError,
      );
      expect(computeLineTax(1500, 100, GST_BPS_CEILING, 'inter')).toMatchObject({
        taxablePaise: 150,
        igstPaise: 150, // 100% GST, the bps ceiling is legal
      });
    });

    it('an unresolvable supply type (null) computes taxable but charges NO tax — the parked arm stays reviewable', () => {
      const line = computeLineTax(1500, 100, 1800, null);
      expect(line.taxablePaise).toBe(150);
      expect(line.gstPaise).toBe(0);
      expect(line.cgstPaise).toBe(0);
      expect(line.sgstPaise).toBe(0);
      expect(line.igstPaise).toBe(0);
    });
  });

  describe('assertInvoiceTotals — FR-26, the two-sum invariants', () => {
    const balanced = {
      subtotalPaise: 150,
      gstPaise: 27,
      totalPaise: 177,
      cgstPaise: 13,
      sgstPaise: 14,
      igstPaise: 0,
    };

    it('accepts a balanced set and an inter-shaped one', () => {
      expect(() => assertInvoiceTotals(balanced)).not.toThrow();
      expect(() =>
        assertInvoiceTotals({ subtotalPaise: 150, gstPaise: 27, totalPaise: 177, cgstPaise: 0, sgstPaise: 0, igstPaise: 27 }),
      ).not.toThrow();
      expect(() =>
        assertInvoiceTotals({ subtotalPaise: 0, gstPaise: 0, totalPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 }),
      ).not.toThrow();
    });

    it('refuses any subtotal/gst/total mismatch, any cgst+sgst+igst mismatch, any negative, any non-integer', () => {
      expect(() => assertInvoiceTotals({ ...balanced, totalPaise: 178 })).toThrow(ArithmeticOverflowError);
      expect(() => assertInvoiceTotals({ ...balanced, igstPaise: 27 })).toThrow(ArithmeticOverflowError);
      expect(() => assertInvoiceTotals({ ...balanced, gstPaise: 26 })).toThrow(ArithmeticOverflowError);
      expect(() => assertInvoiceTotals({ ...balanced, subtotalPaise: -1, gstPaise: 28, totalPaise: 177 })).toThrow(
        ArithmeticOverflowError,
      );
      expect(() => assertInvoiceTotals({ ...balanced, cgstPaise: 13.5 })).toThrow(ArithmeticOverflowError);
    });
  });

  describe('fyLabelFor — the India FY (Apr 1–Mar 31, Asia/Kolkata)', () => {
    it('renders the label of the FY the instant falls inside', () => {
      // October 2026 opens FY 2026-27.
      expect(fyLabelFor('2026-10-03T05:56:00.000Z')).toBe('FY-2627');
      // March 2027 CLOSES the same FY-2627 (IST 17:30).
      expect(fyLabelFor('2027-03-31T12:00:00.000Z')).toBe('FY-2627');
      expect(fyLabelFor('2027-04-01T01:30:00.000Z')).toBe('FY-2728'); // IST 07:00, Apr 1
      // April 1 IST at midnight: '2027-03-31T18:30:00Z' IS Apr 1 00:00 IST.
      expect(fyLabelFor('2027-03-31T18:30:00.000Z')).toBe('FY-2728');
      // …and the minute before it is still the old FY.
      expect(fyLabelFor('2027-03-31T18:29:59.000Z')).toBe('FY-2627');
      // January 2026 belongs to FY-2526 (the previous year opened it).
      expect(fyLabelFor('2026-01-15T06:00:00.000Z')).toBe('FY-2526');
    });
  });

  describe('state-code resolution — GSTIN outranks text, mismatches report', () => {
    const rows: StateCodeEntry[] = [
      { stateCode: '24', stateName: 'Gujarat' },
      { stateCode: '27', stateName: 'Maharashtra' },
      { stateCode: '21', stateName: 'Odisha' },
      { stateCode: '29', stateName: 'Karnataka' },
      { stateCode: '99', stateName: 'Other Country' },
      { stateCode: '01', stateName: 'Jammu and Kashmir' },
    ];
    const byGstin = new Map(rows.map((r) => [r.stateCode, r]));
    const byName = new Map(rows.map((r) => [normalizeStateName(r.stateName), r]));

    it('the GSTIN digits are the state code and win over text', () => {
      const resolved = resolveStateCode(byGstin, byName, '27AAAPZ1234C1ZV', 'Karnataka');
      expect(resolved!.code).toBe('27');
      expect(resolved!.textCode).toBe('29'); // reported for the pos-discrepancy warning
    });

    it('a GSTIN-lacking consignee resolves through the state text — trimmed, case-, ampersand-insensitively', () => {
      expect(resolveStateCode(byGstin, byName, null, '  Gujarat ')!.code).toBe('24');
      expect(resolveStateCode(byGstin, byName, null, 'ODISHA')!.code).toBe('21');
      expect(resolveStateCode(byGstin, byName, null, 'Guja & rat & something') ?? null).toBeNull();
    });

    it('a text with no code, and absence on both arms, resolve to null (the blocking gap)', () => {
      expect(resolveStateCode(byGstin, byName, null, 'Atlantis')).toBeNull();
      expect(resolveStateCode(byGstin, byName, null, null)).toBeNull();
      expect(resolveStateCode(byGstin, byName, null, '')).toBeNull();
    });

    it('a GSTIN whose digits match but no address text still resolves', () => {
      expect(resolveStateCode(byGstin, byName, '29X', null)!.code).toBe('29');
    });

    it('the renamed-state aliases resolve through the module alias map — the fixture carries only the OFFICIAL names', () => {
      // No hand-added alias rows: `orissa` resolves ONLY because
      // STATE_NAME_ALIASES maps it to the official 'odisha' (deleting the
      // map entry fails this).
      expect(byName.has('orissa')).toBe(false);
      expect(resolveStateCode(byGstin, byName, null, 'Orissa')!.code).toBe('21');
      expect(resolveStateCode(byGstin, byName, null, '  ORISSA ')!.code).toBe('21');
      // 'uttaranchal' aliases to the official name, which this fixture does
      // not carry — alias ≠ data, the resolution still lands null.
      expect(resolveStateCode(byGstin, byName, null, 'Uttaranchal')).toBeNull();
    });

    it('an ampersand in the address text reads as "and" (the seeded names spell it out)', () => {
      expect(resolveStateCode(byGstin, byName, null, 'Jammu & Kashmir')!.code).toBe('01');
      expect(resolveStateCode(byGstin, byName, null, 'Jammu&Kashmir')!.code).toBe('01');
      expect(normalizeStateName('Andaman & Nicobar Islands')).toBe('andaman and nicobar islands');
    });
  });

  describe('documentsEqual — revision numbers content changes, never causes one', () => {
    const base: InvoiceDocument = {
      header: {
        invoiceNo: 'FY-2627-000001',
        fyLabel: 'FY-2627',
        orderRef: '00000000-0000-7000-8000-000000000001',
        issuedAt: '2026-10-03T06:00:00.000Z',
        supplyType: 'intra',
        placeOfSupply: '27',
        originGstin: '27AAAPZ1234C1ZV',
        consigneeGstin: null,
        originAddress: null,
        consigneeAddress: null,
      },
      seller: { name: 'WH', gstin: '27AAAPZ1234C1ZV' },
      buyer: { name: null, gstin: null },
      lines: [],
      totals: { subtotal: 0, gst: 0, total: 0, roundOff: 0, payable: 0 },
      gaps: [],
      revision: 1,
    };

    it('calls two documents differing ONLY in revision equal', () => {
      expect(documentsEqual(base, { ...base, revision: 7 })).toBe(true);
    });

    it('calls a changed total, line list or gap list different', () => {
      expect(
        documentsEqual(base, { ...base, totals: { subtotal: 1, gst: 0, total: 1, roundOff: -1, payable: 0 } }),
      ).toBe(false);
      // The rounding is content too: two documents whose stored round-off
      // and payable differ (the figures e-way and GSTR-1 read) are different
      // documents. Both triples respect the rounding invariants.
      const up: InvoiceDocument = { ...base, totals: { subtotal: 450, gst: 0, total: 450, roundOff: 50, payable: 500 } };
      const down: InvoiceDocument = { ...base, totals: { subtotal: 449, gst: 0, total: 449, roundOff: -49, payable: 400 } };
      expect(roundToRupee(asPaise(450))).toEqual({ payable: 500, roundOff: 50 });
      expect(roundToRupee(asPaise(449))).toEqual({ payable: 400, roundOff: -49 });
      expect(documentsEqual(up, down)).toBe(false);
      const addedLine: InvoiceDocument = { ...base, lines: [baseLine()] };
      expect(documentsEqual(base, addedLine)).toBe(false);
      const addedGap: InvoiceDocument = {
        ...base,
        gaps: [{ kind: 'hsn-gap', detail: 'line SKU-1 issued with a blank HSN — the SKU carries none in the catalog' }],
      };
      expect(documentsEqual(base, addedGap)).toBe(false);
    });

    it('is reflexive for an identical pair', () => {
      const clone = structuredClone(base);
      expect(documentsEqual(base, clone)).toBe(true);
    });
  });

  // The helper for the addedLine assertion above (kept inline-level).
  function baseLine(): InvoiceDocument['lines'][number] {
    return {
      orderLineId: '00000000-0000-7000-8000-000000000002',
      skuCode: 'SKU-1',
      skuName: 'SKU 1',
      hsn: '1234',
      qtyMilli: 1500,
      uom: 'pcs',
      ratePaise: 100,
      rateSource: 'order_line',
      taxablePaise: 150,
      gstBps: 1800,
      cgstPaise: 13,
      sgstPaise: 14,
      igstPaise: 0,
      hsnGap: false,
    };
  }

  describe('roundToRupee — the stored rupee round-off (story 8-1b)', () => {
    // [total, payable, roundOff]: remainders 00 / 40 / 49 / 50 / 99 / 01,
    // the zero total, and the spec's own matrix rows.
    const table: readonly (readonly [number, number, number])[] = [
      [0, 0, 0],
      [100, 100, 0], // remainder 00 — no rounding
      [435400, 435400, 0],
      [228060, 228100, 40], // remainder 60 → up
      [228040, 228000, -40], // remainder 40 → down
      [435449, 435400, -49], // remainder 49 → down, the negative edge
      [435450, 435500, 50], // remainder 50 → UP (half-up), the positive edge
      [435499, 435500, 1],
      [435401, 435400, -1],
      [49, 0, -49],
      [50, 100, 50],
    ];
    it.each(table)('rounds %i paise to a payable of %i (round-off %i)', (total, payable, roundOff) => {
      const out = roundToRupee(asPaise(total));
      expect(out).toEqual({ payable, roundOff });
      expect(out.payable % 100).toBe(0);
      expect(out.payable).toBe(total + out.roundOff);
    });

    it('keeps the round-off inside −49…+50 for every remainder', () => {
      const seen = new Set<number>();
      for (let r = 0; r < 100; r += 1) {
        const { roundOff } = roundToRupee(asPaise(1_000_000 + r));
        expect(roundOff).toBeGreaterThanOrEqual(-49);
        expect(roundOff).toBeLessThanOrEqual(50);
        seen.add(roundOff);
      }
      expect(seen.size).toBe(100); // every remainder lands on its own round-off
    });

    it('guards total + 50 inside the safe-integer range, and refuses a negative or fractional total', () => {
      const ceiling = Number.MAX_SAFE_INTEGER - 50;
      expect(() => roundToRupee(asPaise(ceiling))).not.toThrow();
      expect(roundToRupee(asPaise(ceiling)).payable % 100).toBe(0);
      expect(() => roundToRupee(asPaise(ceiling + 1))).toThrow(ArithmeticOverflowError);
      expect(() => roundToRupee(-1 as Paise)).toThrow(ArithmeticOverflowError);
      expect(() => roundToRupee(1.5 as Paise)).toThrow(ArithmeticOverflowError);
    });
  });

  describe('formatInvoiceNo — the per-GSTIN series number (story 8-1b)', () => {
    it('is the GSTIN state code / FY digits / 6-digit sequence — 14 characters', () => {
      const no = formatInvoiceNo('29AAACR5055K1Z5', 'FY-2627', 3);
      expect(no).toBe('29/2627/000003');
      expect(no).toHaveLength(14);
      expect(formatInvoiceNo('07AAACR5055K1Z5', 'FY-2627', 1)).toBe('07/2627/000001');
    });

    it('takes the prefix from the GSTIN itself, never a resolved state', () => {
      // A 27 GSTIN numbers in the 27 series whatever its address says.
      expect(formatInvoiceNo('27BBBPT5678M2AB', 'FY-2728', 999999)).toBe('27/2728/999999');
    });

    it('stays within GST’s 16-character limit and fails loudly past it', () => {
      expect(INVOICE_NO_MAX_LENGTH).toBe(16);
      expect(formatInvoiceNo('29AAACR5055K1Z5', 'FY-2627', 1_000_000)).toHaveLength(15);
      expect(formatInvoiceNo('29AAACR5055K1Z5', 'FY-2627', 9_999_999)).toHaveLength(15);
      expect(formatInvoiceNo('29AAACR5055K1Z5', 'FY-2627', 99_999_999)).toHaveLength(16);
      expect(() => formatInvoiceNo('29AAACR5055K1Z5', 'FY-2627', 100_000_000)).toThrow(ArithmeticOverflowError);
    });

    it('refuses a malformed FY label, a prefix-less GSTIN or a non-positive sequence', () => {
      expect(() => formatInvoiceNo('29AAACR5055K1Z5', '2627', 1)).toThrow(ArithmeticOverflowError);
      expect(() => formatInvoiceNo('XXAAACR5055K1Z5', 'FY-2627', 1)).toThrow(ArithmeticOverflowError);
      expect(() => formatInvoiceNo('29AAACR5055K1Z5', 'FY-2627', 0)).toThrow(ArithmeticOverflowError);
    });
  });

  describe('asPaise / asGstBps — the branded boundary', () => {
    it('admits non-negative safe integers (bps up to the ceiling) and refuses the rest with the typed failure', () => {
      expect(asPaise(0)).toBe(0);
      expect(asPaise(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
      expect(asGstBps(1800)).toBe(1800);
      expect(asGstBps(GST_BPS_CEILING)).toBe(GST_BPS_CEILING);
      for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => asPaise(bad)).toThrow(ArithmeticOverflowError);
      }
      for (const bad of [-1, 12.5, GST_BPS_CEILING + 1]) {
        expect(() => asGstBps(bad)).toThrow(ArithmeticOverflowError);
      }
    });
  });
});