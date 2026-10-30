import { UUID_RE } from './ids';
import { QUANTITY_DECIMALS, QUANTITY_SCALE, toMilli } from './quantity';

/**
 * Stories 5-2a and 5-2b (5-2b drift amendment D2) — the facts of the two
 * client-facing source events (`grn.recorded`, `order.dispatched`), decoded
 * ONCE for every consumer: the webhook bodies (`client-webhooks`) and the
 * receipt and dispatch emails (`client-emails`). One decoder per payload, so
 * an email and a webhook can never read a payload differently. Moved here
 * unchanged from `client-webhooks/webhook-payloads.ts` (which re-exports
 * them, so 5-2a's specs and v1 bodies stay byte-identical). Pure: imports
 * only `shared/primitives`.
 *
 * Quantities are decimal STRINGS at the SKU UoM's precision, formatted from
 * milli-units with integer maths — never from a float.
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
  /**
   * Story 5-2b — the follow-on chain's ROOT order (the order label's short
   * id). Present only when the payload carries it — absent from a dispatch
   * record stored before 4-2c, and never read by the webhook body.
   */
  readonly followOnRootOrderId?: string | null;
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
    ...(dispatch.followOnRootOrderId === undefined ? {} : { followOnRootOrderId: uuidOf(dispatch.followOnRootOrderId) }),
    lines,
  };
}
