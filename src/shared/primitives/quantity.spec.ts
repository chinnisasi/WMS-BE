import { validateRecordableQuantity } from './quantity';

// The `positive` sign arm (the ASN import, 2026-10-17): an announced quantity
// must be above zero — the import edge of the HTTP field's `@Min(0.001)`.
describe('validateRecordableQuantity — sign positive', () => {
  it('accepts a positive quantity at the unit precision', () => {
    expect(validateRecordableQuantity(2.5, 'quantity', 'kg', 3, 'positive')).toEqual({ ok: true, milli: 2500 });
    expect(validateRecordableQuantity(0.001, 'quantity', 'kg', 3, 'positive')).toEqual({ ok: true, milli: 1 });
  });

  it('refuses zero and a negative quantity on the sign arm', () => {
    for (const value of [0, -1, -0.5]) {
      expect(validateRecordableQuantity(value, 'quantity', 'kg', 3, 'positive')).toEqual({
        ok: false,
        arm: 'sign',
        detail: `quantity must be a positive quantity (got ${value}).`,
      });
    }
  });

  it('leaves the other signs as they were: non-negative admits zero, signed admits a negative', () => {
    expect(validateRecordableQuantity(0, 'q', 'each', 0, 'non-negative')).toEqual({ ok: true, milli: 0 });
    expect(validateRecordableQuantity(-2, 'q', 'each', 0, 'signed')).toEqual({ ok: true, milli: -2000 });
  });
});
