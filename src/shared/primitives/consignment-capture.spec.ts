import { ProblemException } from '../problem-details/problem.exception';
import {
  assertBrandDocumentDateWindow,
  assertConsignmentCaptureShape,
  gstinStateCode,
  normalizeConsignmentCapture,
  RTV_BRAND_DOCUMENT_TYPES,
  type ConsignmentCaptureInput,
} from './consignment-capture';

// Story 2-8b — the shared consignment capture (4-7c reuses it): the lenient
// normalize (the hash input) and the named 400s.
const VALID: ConsignmentCaptureInput = {
  brandDocument: { type: 'challan', number: ' CH-77 ', date: '2026-10-27' },
  carrierName: 'BlueDart',
  packageCount: 2,
};

function detailOf(input: ConsignmentCaptureInput): string {
  try {
    assertConsignmentCaptureShape(normalizeConsignmentCapture(input));
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    const problem = err as ProblemException;
    expect(problem.getStatus()).toBe(400);
    expect((problem.getResponse() as { code: string }).code).toBe('validation-failed');
    return problem.message;
  }
  throw new Error('accepted');
}

describe('consignment capture (story 2-8b)', () => {
  it('the brand document vocabulary is challan and invoice (A8 — a debit note is a claim, not a movement document)', () => {
    expect([...RTV_BRAND_DOCUMENT_TYPES]).toEqual(['challan', 'invoice']);
  });

  it('normalize: trims, blank is null, upper-cases the GSTIN, normalises the vehicle; every key present', () => {
    expect(
      normalizeConsignmentCapture({
        ...VALID,
        consignorGstin: ' 29abcde1234f1z5 ',
        vehicleNumber: 'ka-01.ab 1234',
        trackingRef: '  ',
        debitNoteNumber: '',
      }),
    ).toEqual({
      brandDocumentType: 'challan',
      brandDocumentNumber: 'CH-77',
      brandDocumentDate: '2026-10-27',
      consignorGstin: '29ABCDE1234F1Z5',
      debitNoteNumber: null,
      ewayBillNumber: null,
      ewayBillDate: null,
      ewayValidUntil: null,
      transporterId: null,
      carrierName: 'BlueDart',
      vehicleNumber: 'KA01AB1234',
      trackingRef: null,
      packageCount: 2,
    });
  });

  it('accepts the minimal valid capture and one with an e-way bill and validity', () => {
    expect(() => assertConsignmentCaptureShape(normalizeConsignmentCapture(VALID))).not.toThrow();
    expect(() =>
      assertConsignmentCaptureShape(
        normalizeConsignmentCapture({ ...VALID, ewayBillNumber: '123456789012', ewayBillDate: '2026-10-27', ewayValidUntil: '2026-10-27' }),
      ),
    ).not.toThrow();
  });

  it.each([
    [{ ...VALID, brandDocument: null }, /brandDocument is required/],
    [{ ...VALID, brandDocument: { type: 'debit_note', number: 'X', date: '2026-10-27' } }, /brandDocument.type/],
    [{ ...VALID, brandDocument: { type: 'invoice', number: 'X'.repeat(41), date: '2026-10-27' } }, /1–40/],
    [{ ...VALID, brandDocument: { type: 'invoice', number: 'X', date: '2026-02-30' } }, /calendar date/],
    [{ ...VALID, consignorGstin: '29ABC' }, /consignorGstin must be a GSTIN/],
    [{ ...VALID, consignorGstin: '99ABCDE1234F1Z5' }, /not a GST registration state code/],
    [{ ...VALID, ewayBillNumber: '12345' }, /12 digits/],
    [{ ...VALID, ewayBillNumber: '123456789012' }, /ewayBillDate is required/],
    [{ ...VALID, ewayBillDate: '2026-10-27' }, /go with an ewayBillNumber/],
    [{ ...VALID, ewayBillNumber: '123456789012', ewayBillDate: '2026-10-27', ewayValidUntil: '2026-10-26' }, /before ewayBillDate/],
    [{ ...VALID, carrierName: null }, /who carries the goods/],
    [{ ...VALID, transporterId: 'nope' }, /transporterId must be a uuid/],
    [{ ...VALID, vehicleNumber: 'AB' }, /vehicleNumber/],
    [{ ...VALID, trackingRef: 'X'.repeat(51) }, /trackingRef/],
    [{ ...VALID, packageCount: null }, /packageCount is required/],
    [{ ...VALID, packageCount: 10000 }, /packageCount/],
    [{ ...VALID, packageCount: 1.5 }, /packageCount/],
  ] as [ConsignmentCaptureInput, RegExp][])('%# refuses %j', (input, pattern) => {
    expect(detailOf(input)).toMatch(pattern);
  });

  it('the document-date window: today and exactly 30 days before creation are accepted; tomorrow and 31 days are refused', () => {
    expect(() => assertBrandDocumentDateWindow('2026-10-28', '2026-10-20', '2026-10-28')).not.toThrow();
    expect(() => assertBrandDocumentDateWindow('2026-09-20', '2026-10-20', '2026-10-28')).not.toThrow();
    expect(() => assertBrandDocumentDateWindow('2026-10-29', '2026-10-20', '2026-10-28')).toThrow(/after today/);
    expect(() => assertBrandDocumentDateWindow('2026-09-19', '2026-10-20', '2026-10-28')).toThrow(/earliest accepted date is 2026-09-20/);
  });

  it('gstinStateCode reads the prefix', () => {
    expect(gstinStateCode('29ABCDE1234F1Z5')).toBe('29');
    expect(gstinStateCode(null)).toBeNull();
  });
});
