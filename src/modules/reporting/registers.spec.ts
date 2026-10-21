import { referenceSummary } from './registers';
import type { LedgerReferenceDoc } from '../inventory/inventory.facade';

// Story 5-3a — the ledger register's reference summary: every arm of the
// `LedgerReferenceDoc` union (the switch is exhaustive at compile time), the
// GRN code lookup, and a kind this build does not know.
describe('referenceSummary (story 5-3a)', () => {
  const GRN = '0192f1a2-0000-7000-8000-000000000001';
  const codes = new Map([[GRN, 'GRN-0042']]);
  const cases: [LedgerReferenceDoc, string][] = [
    [{ kind: 'manual-adjustment', reasonCode: 'damage', note: 'crushed' }, 'adjustment damage — crushed'],
    [{ kind: 'manual-adjustment', reasonCode: 'stock-count', note: '' }, 'adjustment stock-count'],
    [{ kind: 'grn-receipt', grnId: GRN, poId: 'p' }, 'receipt GRN GRN-0042'],
    [{ kind: 'grn-receipt', grnId: 'unknown-grn' }, 'receipt GRN unknown-grn'],
    [{ kind: 'qc-hold', holdId: 'h1' }, 'QC hold h1'],
    [{ kind: 'putaway', grnId: GRN, grnLineId: 'l1' }, 'putaway GRN GRN-0042'],
    [{ kind: 'bin-merge', mergeId: 'm1' }, 'bin merge m1'],
    [{ kind: 'pick', picklistId: 'pl', picklistLineId: 'pll', waveId: 'w', orderId: 'o1', orderLineId: 'ol' }, 'pick order o1'],
    [{ kind: 'pick', picklistId: 'pl', picklistLineId: 'pll', waveId: 'w', orderId: 'o1', orderLineId: 'ol', shortPick: true }, 'pick order o1 (short)'],
    [{ kind: 'pack', orderId: 'o1', orderLineId: 'ol', packedQty: 1 }, 'pack order o1'],
    [{ kind: 'dispatch', orderId: 'o1', orderLineId: 'ol', dispatchedQty: 1, carrierName: 'BlueDart', trackingNumber: 'BD-1' }, 'dispatch order o1 · BlueDart BD-1'],
    [{ kind: 'dispatch', orderId: 'o1', orderLineId: 'ol', dispatchedQty: 1 }, 'dispatch order o1'],
    [{ kind: 'excursion', excursionId: 'e', binId: 'b', readingC: 9.5 }, 'excursion 9.5 °C'],
    [{ kind: 'transfer', transferId: 't1' }, 'transfer t1'],
    [{ kind: 'return-receipt', returnReceiptId: 'r', rmaId: 'rma1', rmaLineId: 'rl' }, 'return rma1'],
  ];

  it.each(cases)('%j → %s', (doc, expected) => {
    expect(referenceSummary(doc, codes)).toBe(expected);
  });

  it('covers every kind of the union', () => {
    expect(new Set(cases.map(([doc]) => doc.kind)).size).toBe(11);
  });

  it('a kind this build does not know prints its kind; a non-object prints unknown', () => {
    expect(referenceSummary({ kind: 'legacy-thing' } as unknown as LedgerReferenceDoc, codes)).toBe('legacy-thing');
    expect(referenceSummary(null as unknown as LedgerReferenceDoc, codes)).toBe('unknown');
  });
});
