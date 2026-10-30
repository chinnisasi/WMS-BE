import { toMilli } from '../../shared/primitives/quantity';
import { formatBaseQuantity, formatQuantity, type DispatchFact, type ReceiptFact, type SkuLabel } from '../../shared/primitives/client-event-facts';
import { WEBHOOK_BODY_MAX_BYTES, type WebhookEventType, type WebhookSchemaVersion } from './webhook-rules';

/**
 * Story 5-2a (decision 5 as amended by A6, A22, A23, A24) — the v1 webhook
 * bodies, built KEY BY KEY from an allowlist (never a spread of the outbox
 * payload: the receiver gets exactly these keys, in this order). Pure: the
 * caller has already read every label it needs.
 *
 * - Quantities are decimal STRINGS at the SKU UoM's precision (`"12.500"`
 *   for `kg` at 3, `"4"` for `pcs`), formatted from milli-units with integer
 *   maths — never from a float.
 * - `uom` is the SKU's base UoM.
 * - No device, operator, consignee, address, phone, GSTIN, COD amount,
 *   reservation, ledger or internal SKU/line id ever appears.
 * - A body over `WEBHOOK_BODY_MAX_BYTES` drops `lines` and carries
 *   `linesOmitted: true, lineCount: N` (staff can download the full stored
 *   body of a delivery instead — there is none past the limit; PENDING a
 *   client pull for the lines).
 */

// Story 5-2b (D2) — the decoders, their fact types and the quantity
// formatters live in `shared/primitives/client-event-facts.ts` (shared with
// the client emails); re-exported here unchanged.
export {
  decodeDispatch,
  decodeReceipt,
  formatBaseQuantity,
  formatQuantity,
  type DispatchFact,
  type DispatchLineFact,
  type ReceiptFact,
  type ReceiptLineFact,
  type SkuLabel,
} from '../../shared/primitives/client-event-facts';

// ── the bodies ───────────────────────────────────────────────────────────

/** The envelope every webhook carries (decision 4). */
export interface WebhookEnvelopeHead {
  readonly id: string;
  readonly type: WebhookEventType | 'webhook.test';
  readonly schemaVersion: WebhookSchemaVersion;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly clientCode: string;
}

/** Serialises an envelope with its keys in the documented order. */
export function serialiseEnvelope(head: WebhookEnvelopeHead, data: Record<string, unknown>): string {
  return JSON.stringify({
    id: head.id,
    type: head.type,
    schemaVersion: head.schemaVersion,
    occurredAt: head.occurredAt,
    createdAt: head.createdAt,
    client: { code: head.clientCode },
    data,
  });
}

/** The labels a receipt body reads beside its payload. */
export interface ReceiptLabels {
  readonly warehouseCode: string;
  readonly purchaseOrderCode: string | null;
  readonly skus: ReadonlyMap<string, SkuLabel>;
  readonly qcHeldLineIds: ReadonlySet<string>;
}

function labelOf(skus: ReadonlyMap<string, SkuLabel>, skuId: string): SkuLabel {
  const label = skus.get(skuId);
  if (label === undefined) throw new Error(`webhook body: SKU ${skuId} has no catalog row`);
  return label;
}

/** `receipt.recorded` v1 data (decision 5, A24). */
export function receiptData(fact: ReceiptFact, labels: ReceiptLabels): { data: Record<string, unknown>; lines: Record<string, unknown>[] } {
  const lines = fact.lines.map((line) => {
    const sku = labelOf(labels.skus, line.skuId);
    const p = sku.uomPrecision;
    return {
      skuCode: sku.code,
      skuName: sku.name,
      uom: sku.uom,
      batchCode: line.batchCode,
      qty: formatBaseQuantity(line.qty, p),
      appliedQty: formatBaseQuantity(line.appliedQty, p),
      excessQty: formatBaseQuantity(line.excessQty, p),
      ...(line.damagedQty !== null && line.damagedQty > 0 ? { damagedQty: formatBaseQuantity(line.damagedQty, p) } : {}),
      ...(line.shortQty !== null && line.shortQty > 0 ? { shortQty: formatBaseQuantity(line.shortQty, p) } : {}),
      qcHeld: labels.qcHeldLineIds.has(line.id),
    };
  });
  return {
    data: {
      receiptId: fact.grnId,
      grnCode: fact.grnCode,
      warehouseCode: labels.warehouseCode,
      purchaseOrderCode: labels.purchaseOrderCode,
      asnCode: fact.asnCode,
      recordedAt: fact.recordedAt,
    },
    lines,
  };
}

/** The labels a dispatch body reads beside its payload. */
export interface DispatchLabels {
  readonly warehouseCode: string;
  readonly skus: ReadonlyMap<string, SkuLabel>;
  /** Kit parent lines (A6): dropped — the components remain. */
  readonly kitParentLineIds: ReadonlySet<string>;
}

/** `order.dispatched` v1 data (decision 5, A6, A22, A23). */
export function dispatchData(fact: DispatchFact, labels: DispatchLabels): { data: Record<string, unknown>; lines: Record<string, unknown>[] } {
  const kept = fact.lines.filter((line) => !labels.kitParentLineIds.has(line.orderLineId));
  let totalMilli = 0;
  let totalPrecision = 0;
  const lines = kept.map((line) => {
    const sku = labelOf(labels.skus, line.skuId);
    const p = sku.uomPrecision;
    totalMilli += toMilli(line.dispatchedQty);
    totalPrecision = Math.max(totalPrecision, p);
    return {
      skuCode: sku.code,
      skuName: sku.name,
      uom: sku.uom,
      orderedQty: formatBaseQuantity(line.orderedQty, p),
      dispatchedQty: formatBaseQuantity(line.dispatchedQty, p),
      shortfallQty: formatBaseQuantity(line.shortfallQty, p),
    };
  });
  return {
    data: {
      orderId: fact.orderId,
      clientOrderRef: fact.clientOrderRef,
      channelOrderRef: fact.channelOrderRef,
      warehouseCode: labels.warehouseCode,
      dispatchedAt: fact.dispatchedAt,
      carrierName: fact.carrierName,
      trackingNumber: fact.trackingNumber,
      // A sum across units: at the finest precision among the lines.
      totalUnits: formatQuantity(totalMilli, totalPrecision),
      // Story 4-2c — CONDITIONAL keys (v1 stays byte-identical for an order
      // that is no follow-on and shipped in full): a follow-on's dispatch
      // names the order it ships the rest of and its place in the chain, and a
      // short dispatch names the follow-on that will carry the remainder.
      ...(fact.followOnOfOrderId === null ? {} : { backorderOf: fact.followOnOfOrderId, backorderSeq: fact.followOnSeq }),
      ...(fact.followOnOrderId === null ? {} : { remainderOrderId: fact.followOnOrderId }),
    },
    lines,
  };
}

/**
 * The stored body: the envelope with `data.lines`, or — past the byte limit
 * — without them, carrying `linesOmitted: true, lineCount: N`. Null only when
 * even that does not fit (it always does: the head is bounded).
 */
export function buildWebhookBody(head: WebhookEnvelopeHead, built: { data: Record<string, unknown>; lines: Record<string, unknown>[] }): string | null {
  const full = serialiseEnvelope(head, { ...built.data, lines: built.lines });
  if (Buffer.byteLength(full, 'utf8') <= WEBHOOK_BODY_MAX_BYTES) return full;
  const omitted = serialiseEnvelope(head, { ...built.data, linesOmitted: true, lineCount: built.lines.length });
  return Buffer.byteLength(omitted, 'utf8') <= WEBHOOK_BODY_MAX_BYTES ? omitted : null;
}
