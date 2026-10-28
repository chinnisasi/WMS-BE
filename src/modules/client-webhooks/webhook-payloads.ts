import { UUID_RE } from '../../shared/primitives/ids';
import { QUANTITY_DECIMALS, QUANTITY_SCALE, toMilli } from '../../shared/primitives/quantity';
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

/** A quantity in milli-units → its decimal string at `precision` places (0–3). */
export function formatQuantity(milli: number, precision: number): string {
  if (!Number.isSafeInteger(milli)) throw new Error(`Quantity must be an exact integer in milli-units: ${String(milli)}`);
  const places = Math.min(Math.max(Math.trunc(precision), 0), QUANTITY_DECIMALS);
  // Below the unit's precision the value cannot be non-zero (every write edge
  // refuses it); if it ever is, round half-up at the last kept place rather
  // than print a digit the unit cannot express. Integer maths throughout.
  const unit = 10 ** (QUANTITY_DECIMALS - places);
  const magnitude = Math.round(Math.abs(milli) / unit) * unit;
  const whole = Math.floor(magnitude / QUANTITY_SCALE);
  const fraction = (magnitude % QUANTITY_SCALE) / unit;
  const sign = milli < 0 && magnitude !== 0 ? '-' : '';
  if (places === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${String(fraction).padStart(places, '0')}`;
}

/** A base-unit quantity (an outbox payload's JS number) → its decimal string. */
export function formatBaseQuantity(base: number, precision: number): string {
  return formatQuantity(toMilli(base), precision);
}

/** The labels a builder reads per SKU (`CatalogFacade.skuLabelsInTx`). */
export interface SkuLabel {
  readonly code: string;
  readonly name: string;
  readonly uom: string;
  readonly uomPrecision: number;
}

// ── decoding the source payloads (a shape the builder cannot carry is null) ──

type Payload = Record<string, unknown>;

function record(value: unknown): Payload | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Payload) : null;
}
function uuidOf(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface ReceiptLineFact {
  readonly id: string;
  readonly skuId: string;
  readonly batchCode: string | null;
  readonly qty: number;
  readonly appliedQty: number;
  readonly excessQty: number;
  readonly damagedQty: number | null;
  readonly shortQty: number | null;
}

/** The facts of a `grn.recorded` payload the receipt body is built from. */
export interface ReceiptFact {
  readonly grnId: string;
  readonly grnCode: string;
  readonly clientId: string | null;
  readonly warehouseId: string;
  readonly poId: string | null;
  readonly asnCode: string | null;
  readonly recordedAt: string;
  readonly lines: readonly ReceiptLineFact[];
}

/** `{goodsReceipt: …}` (receiving.command.ts) → the facts, or null when malformed. */
export function decodeReceipt(payload: unknown): ReceiptFact | null {
  const receipt = record(record(payload)?.goodsReceipt);
  if (receipt === null) return null;
  const grnId = uuidOf(receipt.id);
  const grnCode = stringOrNull(receipt.code);
  const warehouseId = uuidOf(receipt.warehouseId);
  const recordedAt = stringOrNull(receipt.recordedAt);
  if (grnId === null || grnCode === null || warehouseId === null || recordedAt === null || !Array.isArray(receipt.lines)) return null;
  const lines: ReceiptLineFact[] = [];
  for (const raw of receipt.lines) {
    const line = record(raw);
    if (line === null) return null;
    const id = uuidOf(line.id);
    const skuId = uuidOf(line.skuId);
    const qty = finite(line.qty);
    const appliedQty = finite(line.appliedQty);
    const excessQty = finite(line.excessQty);
    if (id === null || skuId === null || qty === null || appliedQty === null || excessQty === null) return null;
    lines.push({
      id,
      skuId,
      batchCode: stringOrNull(line.batchCode),
      qty,
      appliedQty,
      excessQty,
      damagedQty: finite(line.damagedQty),
      shortQty: finite(line.shortQty),
    });
  }
  return {
    grnId,
    grnCode,
    clientId: uuidOf(receipt.clientId),
    warehouseId,
    poId: uuidOf(receipt.poId),
    asnCode: stringOrNull(receipt.asnCode),
    recordedAt,
    lines,
  };
}

export interface DispatchLineFact {
  readonly orderLineId: string;
  readonly skuId: string;
  readonly orderedQty: number;
  readonly dispatchedQty: number;
  readonly shortfallQty: number;
}

/** The facts of an `order.dispatched` payload. */
export interface DispatchFact {
  readonly orderId: string;
  readonly warehouseId: string;
  readonly clientOrderRef: string | null;
  /** `orders.external_event_id` — the sales channel's order reference (A23). */
  readonly channelOrderRef: string | null;
  readonly dispatchedAt: string;
  readonly carrierName: string | null;
  readonly trackingNumber: string | null;
  /**
   * Story 4-2c — the backorder chain, from the dispatch record (absent on a
   * record stored before 4-2c → null): this order's parent and `-BO{seq}`
   * when it is a follow-on, and the follow-on this dispatch opened.
   */
  readonly followOnOfOrderId: string | null;
  readonly followOnSeq: number | null;
  readonly followOnOrderId: string | null;
  readonly lines: readonly DispatchLineFact[];
}

/** `{dispatch: …}` (dispatch.command.ts) → the facts, or null when malformed. */
export function decodeDispatch(payload: unknown): DispatchFact | null {
  const dispatch = record(record(payload)?.dispatch);
  if (dispatch === null) return null;
  const orderId = uuidOf(dispatch.orderId);
  const warehouseId = uuidOf(dispatch.warehouseId);
  const dispatchedAt = stringOrNull(dispatch.dispatchedAt);
  if (orderId === null || warehouseId === null || dispatchedAt === null || !Array.isArray(dispatch.lines)) return null;
  const lines: DispatchLineFact[] = [];
  for (const raw of dispatch.lines) {
    const line = record(raw);
    if (line === null) return null;
    const orderLineId = uuidOf(line.orderLineId);
    const skuId = uuidOf(line.skuId);
    const orderedQty = finite(line.orderedQty);
    const dispatchedQty = finite(line.dispatchedQty);
    const shortfallQty = finite(line.shortfallQty);
    if (orderLineId === null || skuId === null || orderedQty === null || dispatchedQty === null || shortfallQty === null) return null;
    lines.push({ orderLineId, skuId, orderedQty, dispatchedQty, shortfallQty });
  }
  return {
    orderId,
    warehouseId,
    clientOrderRef: stringOrNull(dispatch.clientOrderRef),
    channelOrderRef: stringOrNull(dispatch.externalEventId),
    dispatchedAt,
    carrierName: stringOrNull(dispatch.carrierName),
    trackingNumber: stringOrNull(dispatch.trackingNumber),
    followOnOfOrderId: uuidOf(dispatch.followOnOfOrderId),
    followOnSeq: finite(dispatch.followOnSeq),
    followOnOrderId: uuidOf(dispatch.followOnOrderId),
    lines,
  };
}

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
