import { referenceSummary } from './registers';
import type { LedgerReferenceDoc } from '../inventory/inventory.facade';

// Story 5-3a — the ledger register's reference summary: every arm of the
// `LedgerReferenceDoc` union (the switch is exhaustive at compile time), the
// GRN code lookup, and a kind this build does not know.
describe('referenceSummary (story 5-3a)', () => {
  const GRN = '0192f1a2-0000-7000-8000-000000000001';
  const codes = new Map([[GRN, 'GRN-0042']]);
  const RTV = '0192f1a2-0000-7000-8000-000000000002';
  const rtvCodes = new Map([[RTV, 'RTV-0007']]);
  const RTC = '0192f1a2-0000-7000-8000-000000000003';
  const rtcCodes = new Map([[RTC, 'RTC-0003']]);
  const cases: [LedgerReferenceDoc, string][] = [
    [{ kind: 'manual-adjustment', reasonCode: 'damage', note: 'crushed' }, 'adjustment damage — crushed'],
    [{ kind: 'manual-adjustment', reasonCode: 'stock-count', note: '' }, 'adjustment stock-count'],
    [{ kind: 'grn-receipt', grnId: GRN, poId: 'p' }, 'receipt GRN GRN-0042'],
    [{ kind: 'grn-receipt', grnId: 'unknown-grn' }, 'receipt GRN unknown-grn'],
    [{ kind: 'qc-hold', holdId: 'h1' }, 'QC hold h1'],
    [{ kind: 'putaway', grnId: GRN, grnLineId: 'l1' }, 'putaway GRN GRN-0042'],
    [{ kind: 'bin-merge', mergeId: 'm1' }, 'bin merge m1'],
    [{ kind: 'bin-move', moveId: 'mv1', reasonCode: 'consolidate' }, 'bin move mv1'],
    [{ kind: 'pick', picklistId: 'pl', picklistLineId: 'pll', waveId: 'w', orderId: 'o1', orderLineId: 'ol' }, 'pick order o1'],
    [{ kind: 'pick', picklistId: 'pl', picklistLineId: 'pll', waveId: 'w', orderId: 'o1', orderLineId: 'ol', shortPick: true }, 'pick order o1 (short)'],
    [{ kind: 'pack', orderId: 'o1', orderLineId: 'ol', packedQty: 1 }, 'pack order o1'],
    [{ kind: 'dispatch', orderId: 'o1', orderLineId: 'ol', dispatchedQty: 1, carrierName: 'BlueDart', trackingNumber: 'BD-1' }, 'dispatch order o1 · BlueDart BD-1'],
    [{ kind: 'dispatch', orderId: 'o1', orderLineId: 'ol', dispatchedQty: 1 }, 'dispatch order o1'],
    [{ kind: 'excursion', excursionId: 'e', binId: 'b', readingC: 9.5 }, 'excursion 9.5 °C'],
    [{ kind: 'transfer', transferId: 't1' }, 'transfer t1'],
    [{ kind: 'return-receipt', returnReceiptId: 'r', rmaId: 'rma1', rmaLineId: 'rl' }, 'return rma1'],
    [{ kind: 'return-disposition', dispositionId: 'd', returnReceiptLineId: 'rl', rmaId: 'rma1', outcome: 'restock' }, 'return restock rma1'],
    [{ kind: 'return-disposition', dispositionId: 'd', returnReceiptLineId: 'rl', rmaId: 'rma1', outcome: 'scrap', reasonCode: 'damaged' }, 'return scrap rma1 (damaged)'],
    [{ kind: 'restock', restockId: 'r', orderId: 'o1', orderLineId: 'ol', picklistLineId: 'pl', drawEventId: 'e' }, 'restock order o1'],
    // Story 2-8b — the RTV's code from the lookup; an id the lookup lacks prints itself.
    [{ kind: 'vendor-return', vendorReturnId: RTV, vendorReturnLineId: 'vl', grnLineId: 'g' }, 'return to vendor RTV-0007'],
    [{ kind: 'vendor-return', vendorReturnId: 'unknown-rtv', vendorReturnLineId: 'vl' }, 'return to vendor unknown-rtv'],
    // Story 4-7c — the RTC's code from the lookup (a RETURNS line and a DAMAGED line); an id the lookup lacks prints itself.
    [{ kind: 'client-return', clientReturnId: RTC, clientReturnLineId: 'cl', returnReceiptLineId: 'rl', rmaId: 'rma1' }, 'return to client RTC-0003'],
    [{ kind: 'client-return', clientReturnId: RTC, clientReturnLineId: 'cl' }, 'return to client RTC-0003'],
    [{ kind: 'client-return', clientReturnId: 'unknown-rtc', clientReturnLineId: 'cl' }, 'return to client unknown-rtc'],
  ];

  it.each(cases)('%j → %s', (doc, expected) => {
    expect(referenceSummary(doc, codes, rtvCodes, rtcCodes)).toBe(expected);
  });

  it('covers every kind of the union', () => {
    // Story 4-7c — sixteen with `client-return`.
    expect(new Set(cases.map(([doc]) => doc.kind)).size).toBe(16);
  });

  it('a kind this build does not know prints its kind; a non-object prints unknown', () => {
    expect(referenceSummary({ kind: 'legacy-thing' } as unknown as LedgerReferenceDoc, codes)).toBe('legacy-thing');
    expect(referenceSummary(null as unknown as LedgerReferenceDoc, codes)).toBe('unknown');
  });
});
