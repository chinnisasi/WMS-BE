import { decodeDispatch, decodeReceipt, type SkuLabel } from '../../shared/primitives/client-event-facts';
import {
  buildDispatchEmailParams,
  buildReceiptEmailParams,
  clientEmailDedupeKey,
  dispatchOrderRefOf,
  qcHeldLinesOf,
} from './client-email-params';
import { CLIENT_EMAIL_DAILY_CAP, CLIENT_EMAIL_SOURCE_EVENTS, CLIENT_EMAIL_STALE_EVENT_MS, clientEmailEnabled } from './client-email-rules';

/**
 * Story 5-2b — the client notices' params builders, pinned KEY BY KEY: the
 * fractional catch-weight line (A2 — `12.500`, from milli-units), the kit
 * parent dropped, the 100-line limit, the order label rule, and the QC count
 * read beside the shared decoder.
 */
const KG = '019a0000-0000-7000-8000-0000000000a1';
const PCS = '019a0000-0000-7000-8000-0000000000a2';
const KIT = '019a0000-0000-7000-8000-0000000000a3';
const skus = new Map<string, SkuLabel>([
  [KG, { code: 'RICE-25', name: 'Basmati rice', uom: 'kg', uomPrecision: 3 }],
  [PCS, { code: 'TEE-M', name: 'Tee, medium', uom: 'pcs', uomPrecision: 0 }],
  [KIT, { code: 'GIFT-BOX', name: 'Gift box', uom: 'pcs', uomPrecision: 0 }],
]);
const GRN = '019a0000-0000-7000-8000-0000000000b1';
const ORDER = '019a0000-0000-7000-8000-0000000000b2';
const WH = '019a0000-0000-7000-8000-0000000000d1';
const CLIENT = '019a0000-0000-7000-8000-0000000000e1';
const lineId = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const names = { tenantName: 'Acme 3PL', clientName: 'ACME Brand', warehouseName: 'Main', replyTo: null };

function receiptPayload(lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return {
    goodsReceipt: {
      id: GRN,
      code: 'GRN-0007',
      clientId: CLIENT,
      warehouseId: WH,
      poId: null,
      recordedAt: '2026-10-30T08:35:00.000Z',
      deviceId: 'x',
      recordedBy: 'y',
      lines,
      ...extra,
    },
  };
}

describe('client email params (story 5-2b)', () => {
  it('a receipt: a 12.5 kg line reads "12.500", damaged and short default to 0, totals per UoM (never kg + pcs in one number)', () => {
    const payload = receiptPayload(
      [
        { id: lineId(1), skuId: KG, batchCode: 'B-1', qty: 12.5, appliedQty: 12.5, excessQty: 0 },
        { id: lineId(2), skuId: PCS, batchCode: null, qty: 4, appliedQty: 4, excessQty: 0, damagedQty: 1, shortQty: 2 },
      ],
      { qcHeldLines: 2, asnCode: 'ASN-9' },
    );
    const fact = decodeReceipt(payload)!;
    const params = buildReceiptEmailParams(fact, { ...names, poCode: 'PO-77', skus, qcHeldLines: qcHeldLinesOf(payload) });
    expect(params).toEqual({
      tenantName: 'Acme 3PL',
      clientName: 'ACME Brand',
      warehouseName: 'Main',
      grnCode: 'GRN-0007',
      poCode: 'PO-77',
      asnCode: 'ASN-9',
      recordedAt: '2026-10-30T08:35:00.000Z',
      replyTo: null,
      lines: [
        { skuCode: 'RICE-25', skuName: 'Basmati rice', uom: 'kg', batchCode: 'B-1', received: '12.500', damaged: '0.000', short: '0.000' },
        { skuCode: 'TEE-M', skuName: 'Tee, medium', uom: 'pcs', batchCode: null, received: '4', damaged: '1', short: '2' },
      ],
      moreLines: 0,
      totals: { received: '12.500 kg, 4 pcs', damaged: '0.000 kg, 1 pcs', short: '0.000 kg, 2 pcs' },
      qcHeldLines: 2,
    });
    // No payload key leaks into the params (an allowlist, never a spread).
    expect(JSON.stringify(params)).not.toMatch(/deviceId|recordedBy|appliedQty|excessQty/);
  });

  it('qcHeldLines: absent or malformed reads 0', () => {
    expect(qcHeldLinesOf(receiptPayload([]))).toBe(0);
    expect(qcHeldLinesOf(receiptPayload([], { qcHeldLines: -1 }))).toBe(0);
    expect(qcHeldLinesOf(receiptPayload([], { qcHeldLines: '3' }))).toBe(0);
    expect(qcHeldLinesOf(null)).toBe(0);
    expect(qcHeldLinesOf(receiptPayload([], { qcHeldLines: 3 }))).toBe(3);
  });

  it('101 lines: 100 shown, "moreLines" 1, totals over every line', () => {
    const lines = Array.from({ length: 101 }, (_, i) => ({ id: lineId(100 + i), skuId: PCS, batchCode: null, qty: 1, appliedQty: 1, excessQty: 0 }));
    const params = buildReceiptEmailParams(decodeReceipt(receiptPayload(lines))!, { ...names, poCode: null, skus, qcHeldLines: 0 });
    expect(params.lines).toHaveLength(100);
    expect(params.moreLines).toBe(1);
    expect(params.totals.received).toBe('101 pcs');
  });

  it('a SKU the catalog does not know is a data fault (throws — the handler logs and acks)', () => {
    const fact = decodeReceipt(receiptPayload([{ id: lineId(1), skuId: lineId(999), batchCode: null, qty: 1, appliedQty: 1, excessQty: 0 }]))!;
    expect(() => buildReceiptEmailParams(fact, { ...names, poCode: null, skus, qcHeldLines: 0 })).toThrow(/no catalog row/);
  });

  function dispatchPayload(extra: Record<string, unknown> = {}) {
    return {
      dispatch: {
        orderId: ORDER,
        warehouseId: WH,
        externalEventId: '#1042',
        clientOrderRef: 'PO-77',
        codAmountPaise: 125000,
        consigneeName: 'Someone',
        dispatchedAt: '2026-10-30T09:00:00.000Z',
        carrierName: 'Delhivery',
        trackingNumber: 'DL123',
        lines: [
          { orderLineId: lineId(1), skuId: KG, orderedQty: 12.5, dispatchedQty: 12.25, shortfallQty: 0.25 },
          { orderLineId: lineId(2), skuId: KIT, orderedQty: 1, dispatchedQty: 1, shortfallQty: 0 },
          { orderLineId: lineId(3), skuId: PCS, orderedQty: 2, dispatchedQty: 2, shortfallQty: 0 },
        ],
        ...extra,
      },
    };
  }

  it('a dispatch: the kit parent dropped, short-shipped flagged, the channel ref shown beside the client ref, no consignee data', () => {
    const params = buildDispatchEmailParams(decodeDispatch(dispatchPayload())!, { ...names, skus, kitParentLineIds: new Set([lineId(2)]) });
    expect(params).toEqual({
      tenantName: 'Acme 3PL',
      clientName: 'ACME Brand',
      warehouseName: 'Main',
      orderRef: 'PO-77',
      channelRef: '#1042',
      dispatchedAt: '2026-10-30T09:00:00.000Z',
      carrierName: 'Delhivery',
      trackingNumber: 'DL123',
      totalUnits: '12.250 kg, 2 pcs',
      replyTo: null,
      lines: [
        { skuCode: 'RICE-25', skuName: 'Basmati rice', uom: 'kg', ordered: '12.500', dispatched: '12.250', short: '0.250' },
        { skuCode: 'TEE-M', skuName: 'Tee, medium', uom: 'pcs', ordered: '2', dispatched: '2', short: '0' },
      ],
      moreLines: 0,
      shortShipped: true,
    });
    expect(JSON.stringify(params)).not.toMatch(/Someone|125000|codAmount|consignee/);
  });

  it('the order label: client ref, else the channel ref (then no separate channel line), else the id’s last eight; -BO{seq} on a follow-on', () => {
    const fact = (extra: Record<string, unknown>) => decodeDispatch(dispatchPayload(extra))!;
    expect(dispatchOrderRefOf(fact({}))).toBe('PO-77');
    const channelOnly = fact({ clientOrderRef: null });
    expect(dispatchOrderRefOf(channelOnly)).toBe('#1042');
    expect(buildDispatchEmailParams(channelOnly, { ...names, skus, kitParentLineIds: new Set() }).channelRef).toBeNull();
    expect(dispatchOrderRefOf(fact({ clientOrderRef: null, externalEventId: null }))).toBe(ORDER.slice(-8));
    expect(dispatchOrderRefOf(fact({ followOnOfOrderId: lineId(77), followOnSeq: 1 }))).toBe('PO-77-BO1');
    // A second-generation follow-on of an UNNAMED order reads the chain ROOT's short id, not its parent's.
    const root = lineId(70);
    expect(dispatchOrderRefOf(fact({ clientOrderRef: null, externalEventId: null, followOnOfOrderId: lineId(77), followOnRootOrderId: root, followOnSeq: 2 }))).toBe(
      `${root.slice(-8)}-BO2`,
    );
    // A payload without the root (pre-root record) falls back to the parent.
    expect(dispatchOrderRefOf(fact({ clientOrderRef: null, externalEventId: null, followOnOfOrderId: lineId(77), followOnSeq: 1 }))).toBe(`${lineId(77).slice(-8)}-BO1`);
  });

  it('mixed UoMs: totals are grouped per unit, each at its own precision, in order of first appearance', () => {
    const payload = dispatchPayload({
      lines: [
        { orderLineId: lineId(1), skuId: PCS, orderedQty: 3, dispatchedQty: 3, shortfallQty: 0 },
        { orderLineId: lineId(2), skuId: KG, orderedQty: 1.5, dispatchedQty: 1.5, shortfallQty: 0 },
        { orderLineId: lineId(3), skuId: PCS, orderedQty: 1, dispatchedQty: 1, shortfallQty: 0 },
        { orderLineId: lineId(4), skuId: KG, orderedQty: 0.25, dispatchedQty: 0.25, shortfallQty: 0 },
      ],
    });
    expect(buildDispatchEmailParams(decodeDispatch(payload)!, { ...names, skus, kitParentLineIds: new Set() }).totalUnits).toBe('4 pcs, 1.750 kg');
    expect(buildDispatchEmailParams(decodeDispatch(dispatchPayload({ lines: [] }))!, { ...names, skus, kitParentLineIds: new Set() }).totalUnits).toBe('0');
  });

  it('a full dispatch is not short-shipped', () => {
    const payload = dispatchPayload({ lines: [{ orderLineId: lineId(3), skuId: PCS, orderedQty: 2, dispatchedQty: 2, shortfallQty: 0 }] });
    expect(buildDispatchEmailParams(decodeDispatch(payload)!, { ...names, skus, kitParentLineIds: new Set() }).shortShipped).toBe(false);
  });

  it('the dedupe key and the rules', () => {
    expect(clientEmailDedupeKey('client-receipt', GRN, 'a@x.in')).toBe(`client-receipt:${GRN}:a@x.in`);
    expect(CLIENT_EMAIL_SOURCE_EVENTS).toEqual({ 'grn.recorded': 'receipt.recorded', 'order.dispatched': 'order.dispatched' });
    expect(CLIENT_EMAIL_DAILY_CAP).toBe(500);
    expect(CLIENT_EMAIL_STALE_EVENT_MS).toBe(24 * 60 * 60 * 1000);
    expect(clientEmailEnabled({})).toBe(false);
    expect(clientEmailEnabled({ CLIENT_EMAIL_ENABLED: ' TRUE ' })).toBe(true);
    expect(clientEmailEnabled({ CLIENT_EMAIL_ENABLED: 'false' })).toBe(false);
    expect(clientEmailEnabled({ CLIENT_EMAIL_ENABLED: 'yes' })).toBe(false);
  });
});
