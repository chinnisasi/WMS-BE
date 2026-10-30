import { ProblemException } from '../problem-details/problem.exception';
import {
  EWAY_EXEMPTION_REASONS,
  ORDER_BRAND_DOCUMENT_TYPES,
  assertConsignmentRecordShape,
  brandDocumentTag,
  cartonLabelConsignmentLine,
  formatEwayBillNumber,
  formatRupees,
  packingSlipConsignmentLines,
  type ConsignmentPrintFacts,
  normalizeConsignmentRecordInput,
  type ConsignmentRecordInput,
} from './consignment-record';
import { RTV_BRAND_DOCUMENT_TYPES } from './consignment-capture';

const VALID: ConsignmentRecordInput = {
  brandDocument: { type: 'invoice', number: ' INV/26-27/0042 ', date: '2026-10-30' },
  declaredValuePaise: 11_800_000,
};

function detailOf(input: ConsignmentRecordInput): string {
  try {
    assertConsignmentRecordShape(normalizeConsignmentRecordInput(input));
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    const problem = err as ProblemException;
    expect(problem.getStatus()).toBe(400);
    expect((problem.getResponse() as { code: string }).code).toBe('validation-failed');
    return problem.message;
  }
  throw new Error('accepted');
}

describe('story 4-6a — the order consignment record shape (A8, A33, A34)', () => {
  it('the vocabularies: the order types are a superset of the RTV ones; four exemption reasons', () => {
    expect([...ORDER_BRAND_DOCUMENT_TYPES]).toEqual(['invoice', 'challan', 'bill-of-supply']);
    for (const type of RTV_BRAND_DOCUMENT_TYPES) expect(ORDER_BRAND_DOCUMENT_TYPES as readonly string[]).toContain(type);
    expect([...EWAY_EXEMPTION_REASONS]).toEqual(['exempt-goods', 'non-motorised', 'customs', 'other']);
  });

  it('normalize: trims, blank is null, upper-cases the GSTIN, flattens the nested e-way bill; every key present', () => {
    expect(
      normalizeConsignmentRecordInput({
        ...VALID,
        consignorGstin: ' 29abcde1234f1z5 ',
        ewayBill: { number: ' 123456789012 ', date: '2026-10-30', validUntil: '' },
        ewayExemption: { reason: '  ', note: null },
        reason: '  ',
      }),
    ).toEqual({
      brandDocumentType: 'invoice',
      brandDocumentNumber: 'INV/26-27/0042',
      brandDocumentDate: '2026-10-30',
      consignorGstin: '29ABCDE1234F1Z5',
      declaredValuePaise: 11_800_000,
      ewayBillNumber: '123456789012',
      ewayBillDate: '2026-10-30',
      ewayValidUntil: null,
      ewayExemptionReason: null,
      ewayExemptionNote: null,
      reason: null,
    });
  });

  it('accepts the minimal record, one with an e-way bill and validity, one with an exemption', () => {
    expect(() => assertConsignmentRecordShape(normalizeConsignmentRecordInput(VALID))).not.toThrow();
    expect(() =>
      assertConsignmentRecordShape(normalizeConsignmentRecordInput({ ...VALID, ewayBill: { number: '123456789012', date: '2026-10-30', validUntil: '2026-11-01' } })),
    ).not.toThrow();
    expect(() => assertConsignmentRecordShape(normalizeConsignmentRecordInput({ ...VALID, ewayExemption: { reason: 'other', note: 'Hand carried' } }))).not.toThrow();
    expect(() => assertConsignmentRecordShape(normalizeConsignmentRecordInput({ ...VALID, declaredValuePaise: 0, brandDocument: { type: 'bill-of-supply', number: 'B', date: '2026-10-30' } }))).not.toThrow();
  });

  it.each([
    [{ ...VALID, brandDocument: null }, /brandDocument is required/],
    [{ ...VALID, brandDocument: { type: 'debit-note', number: 'X', date: '2026-10-30' } }, /brandDocument.type must be one of \["invoice","challan","bill-of-supply"\]/],
    [{ ...VALID, brandDocument: { type: 'invoice', number: 'X'.repeat(41), date: '2026-10-30' } }, /1–40/],
    [{ ...VALID, declaredValuePaise: undefined }, /declaredValuePaise is required/],
    [{ ...VALID, declaredValuePaise: -1 }, /declaredValuePaise is required/],
    [{ ...VALID, declaredValuePaise: 1.5 }, /declaredValuePaise is required/],
    [{ ...VALID, declaredValuePaise: 1_000_000_000_001 }, /declaredValuePaise is required/],
    [{ ...VALID, consignorGstin: '29ABC' }, /consignorGstin must be a GSTIN/],
    [{ ...VALID, ewayBill: { number: '12345678901', date: '2026-10-30', validUntil: '2026-10-31' } }, /^ewayBill.number must be 12 digits/],
    [{ ...VALID, ewayBill: { number: '123456789012', validUntil: '2026-10-31' } }, /^ewayBill.date is required with an ewayBill.number/],
    [{ ...VALID, ewayBill: { date: '2026-10-30' } }, /go with an ewayBill.number/],
    [{ ...VALID, ewayBill: { number: '123456789012', date: '2026-10-30' } }, /^ewayBill.validUntil is required/],
    [{ ...VALID, ewayBill: { number: '123456789012', date: '2026-10-30', validUntil: '2026-10-29' } }, /is before ewayBill.date/],
    [{ ...VALID, ewayBill: { number: '123456789012', date: '2026-10-29', validUntil: '2026-10-31' } }, /^ewayBill.date is before brandDocument.date/],
    [{ ...VALID, ewayBill: { number: '123456789012', date: '2026-10-30', validUntil: '2026-10-31' }, ewayExemption: { reason: 'customs' } }, /not both/],
    [{ ...VALID, ewayExemption: { reason: 'diplomatic' } }, /ewayExemption.reason must be one of/],
    [{ ...VALID, ewayExemption: { note: 'x' } }, /ewayExemption.reason must be one of/],
    [{ ...VALID, ewayExemption: { reason: 'other' } }, /ewayExemption.note is required/],
    [{ ...VALID, ewayExemption: { reason: 'customs', note: 'x'.repeat(201) } }, /ewayExemption.note is 1–200/],
    [{ ...VALID, reason: 'x'.repeat(201) }, /reason is 1–200/],
  ] as [ConsignmentRecordInput, RegExp][])('refuses %#', (input, pattern) => {
    expect(detailOf(input)).toMatch(pattern);
  });

  it('prints an e-way number in groups of four, and tags the document type', () => {
    expect(formatEwayBillNumber('123456789012')).toBe('1234 5678 9012');
    expect(formatEwayBillNumber('12345')).toBe('12345');
    expect([brandDocumentTag('invoice'), brandDocumentTag('challan'), brandDocumentTag('bill-of-supply')]).toEqual(['INV', 'DC', 'BOS']);
  });

  it('A19 — the carton label line (ASCII, the document number last) and the packing slip lines (never the value)', () => {
    const facts: ConsignmentPrintFacts = {
      brandDocumentType: 'invoice',
      brandDocumentNumber: 'INV/26-27/0042',
      brandDocumentDate: '2026-10-30',
      consignorGstin: '29ABCDE1234F1Z5',
      consignorName: 'Acme Brand Private Limited',
      ewayStatus: 'recorded',
      ewayBillNumber: '123456789012',
      ewayBillDate: '2026-10-30',
      ewayValidUntil: '2026-11-01',
      ewayExemptionReason: null,
    };
    expect(cartonLabelConsignmentLine(facts)).toBe('EWB 1234 5678 9012 / INV INV/26-27/0042');
    expect(cartonLabelConsignmentLine({ ...facts, brandDocumentType: 'challan', ewayStatus: 'pending', ewayBillNumber: null })).toBe('DC INV/26-27/0042');
    expect(cartonLabelConsignmentLine({ ...facts, brandDocumentType: 'bill-of-supply', ewayStatus: 'exempt', ewayBillNumber: null, ewayExemptionReason: 'customs' })).toBe('EWB EXEMPT / BOS INV/26-27/0042');
    expect(packingSlipConsignmentLines(facts)).toEqual([
      'Tax document: Invoice INV/26-27/0042 dated 30 Oct 2026, issued by Acme Brand Private Limited (GSTIN 29ABCDE1234F1Z5)',
      'E-way bill 1234 5678 9012 dated 30 Oct 2026, valid until 1 Nov 2026',
    ]);
    expect(packingSlipConsignmentLines({ ...facts, ewayStatus: 'exempt', ewayBillNumber: null, ewayBillDate: null, ewayValidUntil: null, ewayExemptionReason: 'exempt-goods' })[1]).toBe('E-way bill: not required — exempt goods');
    expect(packingSlipConsignmentLines({ ...facts, ewayStatus: 'not-required', ewayBillNumber: null })).toHaveLength(1);
    expect(packingSlipConsignmentLines(facts).join(' ')).not.toMatch(/₹|Rs|value/i);
  });

  it('formats rupees with Indian grouping, paise only when present', () => {
    expect(formatRupees(11_800_000)).toBe('₹1,18,000');
    expect(formatRupees(5_000_050)).toBe('₹50,000.50');
    expect(formatRupees(0)).toBe('₹0');
  });
});
