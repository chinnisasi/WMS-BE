import { WEBHOOK_BODY_MAX_BYTES } from './webhook-rules';
import {
  buildWebhookBody,
  decodeDelivery,
  decodeDispatch,
  deliveryData,
  deliverySubjectUuid,
  decodeReceipt,
  dispatchData,
  formatQuantity,
  receiptData,
  type SkuLabel,
  type WebhookEnvelopeHead,
} from './webhook-payloads';

/**
 * Story 5-2a — the v1 bodies, pinned by KEY-BY-KEY goldens (the JSON is
 * written out literally, so an added, renamed or reordered key fails): the
 * fractional catch-weight line (A22), the kit (A6), the receipt (A24) and the
 * omitted-lines fallback.
 */
const head: WebhookEnvelopeHead = {
  id: '019a0000-0000-7000-8000-000000000001',
  type: 'order.dispatched',
  schemaVersion: 1,
  occurredAt: '2026-10-27T10:00:00.000Z',
  createdAt: '2026-10-27T10:00:01.000Z',
  clientCode: 'ACME',
};
const KG = '019a0000-0000-7000-8000-0000000000a1';
const PCS = '019a0000-0000-7000-8000-0000000000a2';
const KIT = '019a0000-0000-7000-8000-0000000000a3';
const skus = new Map<string, SkuLabel>([
  [KG, { code: 'RICE-25', name: 'Basmati rice', uom: 'kg', uomPrecision: 3 }],
  [PCS, { code: 'TEE-M', name: 'Tee, medium', uom: 'pcs', uomPrecision: 0 }],
  [KIT, { code: 'GIFT-BOX', name: 'Gift box', uom: 'pcs', uomPrecision: 0 }],
]);
const ORDER = '019a0000-0000-7000-8000-0000000000b1';
const L1 = '019a0000-0000-7000-8000-0000000000c1';
const L2 = '019a0000-0000-7000-8000-0000000000c2';
const L3 = '019a0000-0000-7000-8000-0000000000c3';
const WH = '019a0000-0000-7000-8000-0000000000d1';

const dispatchPayload = {
  dispatch: {
    orderId: ORDER,
    tenantId: '019a0000-0000-7000-8000-0000000000e1',
    warehouseId: WH,
    orderStatus: 'dispatched',
    source: 'manual',
    integrationId: null,
    externalEventId: '#1042',
    clientOrderRef: 'PO-77',
    orderType: 'b2b',
    codAmountPaise: 125000,
    dispatchedBy: '019a0000-0000-7000-8000-0000000000f1',
    dispatchedAt: '2026-10-27T10:00:00.000Z',
    carrierName: 'Delhivery',
    trackingNumber: 'DL123',
    totalUnits: 13.5,
    retiredReservationIds: ['019a0000-0000-7000-8000-0000000000f2'],
    lines: [
      { orderLineId: L1, skuId: KG, skuCode: 'RICE-25', skuName: 'Basmati rice', orderedQty: 12.5, dispatchedQty: 12.5, shortfallQty: 0, ledgerEventId: 'x' },
      { orderLineId: L2, skuId: KIT, skuCode: 'GIFT-BOX', skuName: 'Gift box', orderedQty: 1, dispatchedQty: 0, shortfallQty: 1, ledgerEventId: 'y' },
      { orderLineId: L3, skuId: PCS, skuCode: 'TEE-M', skuName: 'Tee, medium', orderedQty: 2, dispatchedQty: 1, shortfallQty: 1, ledgerEventId: 'z' },
    ],
  },
};

describe('webhook payloads (story 5-2a)', () => {
  it('formats milli-units as decimal strings at the unit precision, integer maths only', () => {
    expect(formatQuantity(12_500, 3)).toBe('12.500');
    expect(formatQuantity(4_000, 0)).toBe('4');
    expect(formatQuantity(1, 3)).toBe('0.001');
    expect(formatQuantity(0, 2)).toBe('0.00');
    expect(formatQuantity(-2_250, 2)).toBe('-2.25');
    expect(formatQuantity(9_007_199_254_740_000, 3)).toBe('9007199254740.000');
    // Below a unit's precision (never written) rounds half-up rather than printing a digit the unit cannot hold.
    expect(formatQuantity(1_500, 0)).toBe('2');
    expect(() => formatQuantity(1.5, 3)).toThrow();
  });

  it('order.dispatched: a fractional kg line, the kit parent dropped, its component kept (golden, key by key)', () => {
    const fact = decodeDispatch(dispatchPayload)!;
    const built = dispatchData(fact, { warehouseCode: 'BLR-1', skus, kitParentLineIds: new Set([L2]) });
    expect(buildWebhookBody(head, built)).toBe(
      '{"id":"019a0000-0000-7000-8000-000000000001","type":"order.dispatched","schemaVersion":1,' +
        '"occurredAt":"2026-10-27T10:00:00.000Z","createdAt":"2026-10-27T10:00:01.000Z","client":{"code":"ACME"},' +
        '"data":{"orderId":"019a0000-0000-7000-8000-0000000000b1","clientOrderRef":"PO-77","channelOrderRef":"#1042",' +
        '"warehouseCode":"BLR-1","dispatchedAt":"2026-10-27T10:00:00.000Z","carrierName":"Delhivery","trackingNumber":"DL123",' +
        '"totalUnits":"13.500","lines":[' +
        '{"skuCode":"RICE-25","skuName":"Basmati rice","uom":"kg","orderedQty":"12.500","dispatchedQty":"12.500","shortfallQty":"0.000"},' +
        '{"skuCode":"TEE-M","skuName":"Tee, medium","uom":"pcs","orderedQty":"2","dispatchedQty":"1","shortfallQty":"1"}]}}',
    );
  });

  it('story 4-2c: the backorder keys are CONDITIONAL — a short dispatch names the remainder order; a follow-on names the order it completes and its seq; a plain order is byte-identical (the golden above)', () => {
    const REMAINDER = '019a0000-0000-7000-8000-0000000000b2';
    const short = decodeDispatch({ dispatch: { ...dispatchPayload.dispatch, followOnOrderId: REMAINDER, followOnOfOrderId: null, followOnSeq: null } })!;
    const shortData = dispatchData(short, { warehouseCode: 'BLR-1', skus, kitParentLineIds: new Set([L2]) }).data;
    expect(Object.keys(shortData).slice(-2)).toEqual(['totalUnits', 'remainderOrderId']);
    expect(shortData.remainderOrderId).toBe(REMAINDER);
    expect(shortData).not.toHaveProperty('backorderOf');
    const followOn = decodeDispatch({ dispatch: { ...dispatchPayload.dispatch, orderId: REMAINDER, followOnOrderId: null, followOnOfOrderId: ORDER, followOnSeq: 1 } })!;
    const followData = dispatchData(followOn, { warehouseCode: 'BLR-1', skus, kitParentLineIds: new Set() }).data;
    expect(Object.keys(followData).slice(-3)).toEqual(['totalUnits', 'backorderOf', 'backorderSeq']);
    expect([followData.backorderOf, followData.backorderSeq]).toEqual([ORDER, 1]);
    // A record stored before 4-2c (no keys at all) decodes to nulls and adds nothing.
    const legacy = dispatchData(decodeDispatch(dispatchPayload)!, { warehouseCode: 'BLR-1', skus, kitParentLineIds: new Set() }).data;
    for (const key of ['backorderOf', 'backorderSeq', 'remainderOrderId']) expect(legacy).not.toHaveProperty(key);
  });

  it('order.dispatched never carries the consignee, COD, the dispatcher, reservations or internal ids', () => {
    const body = buildWebhookBody(head, dispatchData(decodeDispatch(dispatchPayload)!, { warehouseCode: 'BLR-1', skus, kitParentLineIds: new Set() }))!;
    for (const leak of ['codAmountPaise', 'dispatchedBy', 'retiredReservationIds', 'ledgerEventId', 'orderLineId', 'skuId', 'tenantId', 'warehouseId', 'orderType', '125000']) {
      expect(body).not.toContain(leak);
    }
  });

  it('receipt.recorded: lines keep the GRN names, condition keys only when > 0, the QC flag per line (golden)', () => {
    const payload = {
      goodsReceipt: {
        id: '019a0000-0000-7000-8000-000000000101',
        tenantId: 't',
        warehouseId: WH,
        code: 'GRN-0042',
        poId: '019a0000-0000-7000-8000-000000000102',
        asnCode: 'ASN-9',
        clientId: '019a0000-0000-7000-8000-000000000103',
        blindReasonCode: null,
        status: 'recorded',
        deviceId: 'd',
        recordedBy: 'u',
        occurredAt: '2026-10-27T09:59:00.000Z',
        recordedAt: '2026-10-27T10:00:00.000Z',
        lines: [
          { id: L1, grnId: 'g', poLineId: null, skuId: KG, batchId: 'b', batchCode: 'LOT-7', qty: 25.25, appliedQty: 25, excessQty: 0.25, toleranceQty: 0.25, damagedQty: 0.5, damageReasonCode: 'torn-bag' },
          { id: L3, grnId: 'g', poLineId: null, skuId: PCS, batchId: null, batchCode: null, qty: 10, appliedQty: 10, excessQty: 0, shortQty: 2, shortReasonCode: 'short-shipped' },
        ],
        rejectedLines: [{ skuId: PCS }],
        reviewOpId: 'op',
        qcHeldLines: 1,
      },
    };
    const fact = decodeReceipt(payload)!;
    const built = receiptData(fact, { warehouseCode: 'BLR-1', purchaseOrderCode: 'PO-0007', skus, qcHeldLineIds: new Set([L1]) });
    expect(buildWebhookBody({ ...head, type: 'receipt.recorded' }, built)).toBe(
      '{"id":"019a0000-0000-7000-8000-000000000001","type":"receipt.recorded","schemaVersion":1,' +
        '"occurredAt":"2026-10-27T10:00:00.000Z","createdAt":"2026-10-27T10:00:01.000Z","client":{"code":"ACME"},' +
        '"data":{"receiptId":"019a0000-0000-7000-8000-000000000101","grnCode":"GRN-0042","warehouseCode":"BLR-1",' +
        '"purchaseOrderCode":"PO-0007","asnCode":"ASN-9","recordedAt":"2026-10-27T10:00:00.000Z","lines":[' +
        '{"skuCode":"RICE-25","skuName":"Basmati rice","uom":"kg","batchCode":"LOT-7","qty":"25.250","appliedQty":"25.000","excessQty":"0.250","damagedQty":"0.500","qcHeld":true},' +
        '{"skuCode":"TEE-M","skuName":"Tee, medium","uom":"pcs","batchCode":null,"qty":"10","appliedQty":"10","excessQty":"0","shortQty":"2","qcHeld":false}]}}',
    );
    const body = buildWebhookBody(head, built)!;
    for (const leak of ['toleranceQty', 'rejectedLines', 'reviewOpId', 'deviceId', 'recordedBy', 'damageReasonCode', 'batchId', 'poLineId']) {
      expect(body).not.toContain(leak);
    }
  });

  it('a receipt without a client decodes with clientId null (no webhook is the enqueue’s call)', () => {
    const fact = decodeReceipt({ goodsReceipt: { id: L1, code: 'GRN-1', warehouseId: WH, recordedAt: '2026-10-27T10:00:00Z', lines: [] } });
    expect(fact?.clientId).toBeNull();
  });

  it('malformed payloads decode to null', () => {
    expect(decodeDispatch({})).toBeNull();
    expect(decodeDispatch({ dispatch: { ...dispatchPayload.dispatch, orderId: 'nope' } })).toBeNull();
    expect(decodeReceipt({ goodsReceipt: { id: L1 } })).toBeNull();
  });

  it(`a body over ${WEBHOOK_BODY_MAX_BYTES} bytes drops its lines and says how many there were`, () => {
    const many = { dispatch: { ...dispatchPayload.dispatch, lines: Array.from({ length: 3000 }, (_, i) => ({ ...dispatchPayload.dispatch.lines[2]!, orderLineId: `019a0000-0000-7000-8000-${String(i).padStart(12, '0')}` })) } };
    const longSkus = new Map(skus);
    longSkus.set(PCS, { code: 'TEE-M', name: 'n'.repeat(120), uom: 'pcs', uomPrecision: 0 });
    const body = buildWebhookBody(head, dispatchData(decodeDispatch(many)!, { warehouseCode: 'BLR-1', skus: longSkus, kitParentLineIds: new Set() }))!;
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(WEBHOOK_BODY_MAX_BYTES);
    const parsed = JSON.parse(body) as { data: Record<string, unknown> };
    expect(parsed.data.linesOmitted).toBe(true);
    expect(parsed.data.lineCount).toBe(3000);
    expect(parsed.data.lines).toBeUndefined();
    expect(parsed.data.totalUnits).toBe('3000');
  });

  describe('story 4-9a (A28, A67) — order.delivered', () => {
    const CONS = '019a0000-0000-7000-8000-0000000000c9';
    const CLIENT = '019a0000-0000-7000-8000-0000000000ca';
    const deliveryPayload = {
      consignmentId: CONS,
      orderId: ORDER,
      clientId: CLIENT,
      warehouseId: WH,
      deliverySeq: 2,
      outcome: 'delivered-with-exceptions',
      deliveredAt: '2026-11-02T05:50:00.000Z',
      receiverName: 'A. Kumar',
      shortPackageCount: 0,
      damagedPackageCount: 1,
      note: 'pallet 4 crushed corner',
      lrNumber: '4410',
      transporterName: 'VRL Logistics',
      vehicleNumber: 'KA01AB1234',
      dispatchedAt: '2026-10-30T10:35:00.000Z',
      consignmentRef: 'LD-0007/03',
      amended: true,
      recordedAt: '2026-11-02T06:00:00.000Z',
      // Staff-only facts a payload might carry must never reach the body.
      driverPhone: '+919800000000',
      loadId: '019a0000-0000-7000-8000-0000000000cb',
    };
    const deliveredHead: WebhookEnvelopeHead = { ...head, type: 'order.delivered' };

    it('the v1 body is pinned key by key, with no lines key at all', () => {
      const fact = decodeDelivery(deliveryPayload)!;
      const body = buildWebhookBody(deliveredHead, deliveryData(fact, { warehouseCode: 'BLR-1', clientOrderRef: 'PO-77', channelOrderRef: '#1042' }, head.occurredAt));
      expect(body).toBe(
        '{"id":"019a0000-0000-7000-8000-000000000001","type":"order.delivered","schemaVersion":1,"occurredAt":"2026-10-27T10:00:00.000Z","createdAt":"2026-10-27T10:00:01.000Z","client":{"code":"ACME"},' +
          '"data":{"orderId":"019a0000-0000-7000-8000-0000000000b1","clientOrderRef":"PO-77","channelOrderRef":"#1042","warehouseCode":"BLR-1","consignmentRef":"LD-0007/03",' +
          '"dispatchedAt":"2026-10-30T10:35:00.000Z","deliveredAt":"2026-11-02T05:50:00.000Z","outcome":"delivered-with-exceptions","transporterName":"VRL Logistics","lrNumber":"4410",' +
          '"vehicleNumber":"KA01AB1234","receiverName":"A. Kumar","shortPackages":0,"damagedPackages":1,"note":"pallet 4 crushed corner","amended":true,"deliverySeq":2,"recordedAt":"2026-11-02T06:00:00.000Z"}}',
      );
      expect(body).not.toContain('driverPhone');
      expect(body).not.toContain('loadId');
      expect(body).not.toContain(CLIENT);
    });

    it('an older payload without recordedAt dates the record by the event; absent counts read 0', () => {
      const older: Record<string, unknown> = { ...deliveryPayload };
      for (const key of ['recordedAt', 'shortPackageCount', 'damagedPackageCount']) delete older[key];
      const built = deliveryData(decodeDelivery({ ...older, outcome: 'delivered', amended: false, deliverySeq: 1 })!, { warehouseCode: 'BLR-1', clientOrderRef: null, channelOrderRef: null }, head.occurredAt);
      expect(built.data.recordedAt).toBe(head.occurredAt);
      expect(built.data.shortPackages).toBe(0);
      expect(built.data.damagedPackages).toBe(0);
      expect(built.lines).toEqual([]);
    });

    it('malformed delivery payloads decode to null', () => {
      expect(decodeDelivery({})).toBeNull();
      expect(decodeDelivery({ ...deliveryPayload, outcome: 'lost' })).toBeNull();
      expect(decodeDelivery({ ...deliveryPayload, deliverySeq: 0 })).toBeNull();
      expect(decodeDelivery({ ...deliveryPayload, clientId: 'nope' })).toBeNull();
      expect(decodeDelivery({ ...deliveryPayload, amended: 'yes' })).toBeNull();
    });

    it('the subject is one uuid per recorded version: deterministic, distinct per seq and per consignment', () => {
      const a = deliverySubjectUuid(CONS, 1);
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(deliverySubjectUuid(CONS, 1)).toBe(a);
      expect(deliverySubjectUuid(CONS, 2)).not.toBe(a);
      expect(deliverySubjectUuid(ORDER, 1)).not.toBe(a);
    });
  });
});
