import {
  formatBaseQuantity,
  formatQuantity,
  type DispatchFact,
  type ReceiptFact,
  type SkuLabel,
} from '../../shared/primitives/client-event-facts';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { toMilli } from '../../shared/primitives/quantity';
import { brandDocumentWords, formatRupees } from '../../shared/primitives/consignment-record';
import {
  CLIENT_EMAIL_MAX_LINES,
  SHEET_PARCELS_SHOWN,
  type ClientDocumentsNeededEmailParams,
  type DocumentsNeededReason,
  type ClientShipmentDocumentEmailParams,
  type ShipmentDocumentKind,
  type ClientDispatchEmailParams,
  type ClientDispatchLineParams,
  type ClientEmailTemplate,
  type ClientReceiptEmailParams,
  type ClientReceiptLineParams,
} from '../mail/mail.facade';
import type { ShipmentDocumentEmailFacts, ShipmentDocumentFactInput } from '../outbound/outbound.facade';

/**
 * Story 5-2b — the client notices' stored parameters, built KEY BY KEY from
 * an allowlist (never a spread of an outbox payload). Pure: the caller has
 * read every label. Every body fact comes from the frozen payload (A1) —
 * lines, quantities, batch codes, carrier, tracking, times; only labels
 * (SKU code / name / UoM, the PO code, the client, warehouse and tenant
 * names) are looked up. Quantities are decimal strings at the SKU UoM's
 * precision, from milli-units (A2: `toMilli` of the payload's base-unit
 * number, then integer formatting — a 12.5 kg line reads `"12.500"`).
 */

/** The names a notice carries besides its payload facts. */
export interface ClientEmailNames {
  readonly tenantName: string;
  readonly clientName: string;
  readonly warehouseName: string;
  /** The client's own Reply-To (null → the deployment's). */
  readonly replyTo: string | null;
}

/** `{template}:{subjectId}:{email}` — one row per (event, recipient), however often the relay re-delivers. */
export function clientEmailDedupeKey(template: ClientEmailTemplate, subjectId: string, email: string): string {
  return `${template}:${subjectId}:${email}`;
}

function labelOf(skus: ReadonlyMap<string, SkuLabel>, skuId: string): SkuLabel {
  const label = skus.get(skuId);
  if (label === undefined) throw new Error(`client email: SKU ${skuId} has no catalog row`);
  return label;
}

function unitOf(skus: ReadonlyMap<string, SkuLabel>, skuId: string): { uom: string; precision: number } {
  const label = labelOf(skus, skuId);
  return { uom: label.uom, precision: label.uomPrecision };
}

/**
 * Sums base-unit quantities PER UoM (never kg and pcs into one number), each
 * group in milli-units formatted at its own unit's precision with integer
 * maths, in order of first appearance: `"16.500 kg, 4 pcs"`. No lines → `"0"`.
 */
export function totalsByUom(entries: readonly { readonly uom: string; readonly precision: number; readonly qty: number }[]): string {
  const groups = new Map<string, { precision: number; milli: number }>();
  for (const entry of entries) {
    const group = groups.get(entry.uom) ?? { precision: entry.precision, milli: 0 };
    group.milli += toMilli(entry.qty);
    groups.set(entry.uom, group);
  }
  if (groups.size === 0) return '0';
  return [...groups.entries()].map(([uom, group]) => `${formatQuantity(group.milli, group.precision)} ${uom}`).join(', ');
}

/**
 * `qcHeldLines` of a `grn.recorded` payload (2-8a; present only when > 0,
 * `receiving.command.ts`) — read beside the shared `decodeReceipt`, so the
 * shared decoder keeps its shape (D2, D6). Absent or malformed reads 0.
 */
export function qcHeldLinesOf(payload: unknown): number {
  const receipt =
    typeof payload === 'object' && payload !== null ? (payload as { goodsReceipt?: unknown }).goodsReceipt : undefined;
  const value = typeof receipt === 'object' && receipt !== null ? (receipt as { qcHeldLines?: unknown }).qcHeldLines : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** The `client-receipt` params. "Received" is the line's `qty` (the good units); damaged and short read 0 when absent. */
export function buildReceiptEmailParams(
  fact: ReceiptFact,
  names: ClientEmailNames & {
    readonly poCode: string | null;
    readonly skus: ReadonlyMap<string, SkuLabel>;
    readonly qcHeldLines: number;
  },
): ClientReceiptEmailParams {
  const lines: ClientReceiptLineParams[] = fact.lines.map((line) => {
    const sku = labelOf(names.skus, line.skuId);
    const p = sku.uomPrecision;
    return {
      skuCode: sku.code,
      skuName: sku.name,
      uom: sku.uom,
      batchCode: line.batchCode,
      received: formatBaseQuantity(line.qty, p),
      damaged: formatBaseQuantity(line.damagedQty ?? 0, p),
      short: formatBaseQuantity(line.shortQty ?? 0, p),
    };
  });
  return {
    tenantName: names.tenantName,
    clientName: names.clientName,
    warehouseName: names.warehouseName,
    grnCode: fact.grnCode,
    poCode: names.poCode,
    asnCode: fact.asnCode,
    recordedAt: fact.recordedAt,
    replyTo: names.replyTo,
    lines: lines.slice(0, CLIENT_EMAIL_MAX_LINES),
    moreLines: Math.max(0, lines.length - CLIENT_EMAIL_MAX_LINES),
    totals: {
      received: totalsByUom(fact.lines.map((line) => ({ ...unitOf(names.skus, line.skuId), qty: line.qty }))),
      damaged: totalsByUom(fact.lines.map((line) => ({ ...unitOf(names.skus, line.skuId), qty: line.damagedQty ?? 0 }))),
      short: totalsByUom(fact.lines.map((line) => ({ ...unitOf(names.skus, line.skuId), qty: line.shortQty ?? 0 }))),
    },
    qcHeldLines: names.qcHeldLines,
    // Story 2-9a — the GRN's id: the portal link opens that receipt (decision 18).
    grnId: fact.grnId,
  };
}

/**
 * The order's label — the ONE order label rule (`shared/primitives/order-label.ts`,
 * the web's `orderLabel`): `clientOrderRef ?? channel reference ?? the short
 * id`, then `-BO{seq}` on a backorder follow-on. From the payload.
 */
export function dispatchOrderRefOf(fact: DispatchFact): string {
  return orderLabelOf({
    id: fact.orderId,
    clientOrderRef: fact.clientOrderRef,
    externalEventId: fact.channelOrderRef,
    followOnSeq: fact.followOnSeq,
    // The chain's ROOT names an unnamed follow-on; a pre-root payload falls back to the parent.
    followOnRootOrderId: fact.followOnRootOrderId ?? fact.followOnOfOrderId,
  });
}

/**
 * Story 4-6a (A20) — the brand's document the goods left under, from the
 * consignment version stamped at dispatch (immutable: the fact is frozen).
 */
export interface DispatchDocumentsFact {
  readonly brandDocumentType: string;
  readonly brandDocumentNumber: string;
  readonly brandDocumentDate: string;
  readonly ewayBillNumber: string | null;
  readonly ewayValidUntil: string | null;
}

/** The `client-dispatch` params. Kit parent lines are dropped (their components remain). */
export function buildDispatchEmailParams(
  fact: DispatchFact,
  names: ClientEmailNames & {
    readonly skus: ReadonlyMap<string, SkuLabel>;
    readonly kitParentLineIds: ReadonlySet<string>;
  },
  documents: DispatchDocumentsFact | null = null,
): ClientDispatchEmailParams {
  const kept = fact.lines.filter((line) => !names.kitParentLineIds.has(line.orderLineId));
  const lines: ClientDispatchLineParams[] = kept.map((line) => {
    const sku = labelOf(names.skus, line.skuId);
    const p = sku.uomPrecision;
    return {
      skuCode: sku.code,
      skuName: sku.name,
      uom: sku.uom,
      ordered: formatBaseQuantity(line.orderedQty, p),
      dispatched: formatBaseQuantity(line.dispatchedQty, p),
      short: formatBaseQuantity(line.shortfallQty, p),
    };
  });
  return {
    tenantName: names.tenantName,
    clientName: names.clientName,
    warehouseName: names.warehouseName,
    orderRef: dispatchOrderRefOf(fact),
    // Shown only when it is not already the label (both references exist).
    channelRef: fact.clientOrderRef !== null && fact.channelOrderRef !== null ? fact.channelOrderRef : null,
    dispatchedAt: fact.dispatchedAt,
    carrierName: fact.carrierName,
    trackingNumber: fact.trackingNumber,
    totalUnits: totalsByUom(kept.map((line) => ({ ...unitOf(names.skus, line.skuId), qty: line.dispatchedQty }))),
    replyTo: names.replyTo,
    lines: lines.slice(0, CLIENT_EMAIL_MAX_LINES),
    moreLines: Math.max(0, lines.length - CLIENT_EMAIL_MAX_LINES),
    shortShipped: kept.some((line) => toMilli(line.shortfallQty) > 0),
    // Story 4-6a (A20) — only when a version was stamped: a dispatch without
    // the brand's documents stores 5-2b's keys exactly.
    ...(documents === null
      ? {}
      : {
          taxDocument: { label: brandDocumentWords(documents.brandDocumentType), number: documents.brandDocumentNumber, date: documents.brandDocumentDate },
          ...(documents.ewayBillNumber === null ? {} : { ewayBill: { number: documents.ewayBillNumber, validUntil: documents.ewayValidUntil } }),
        }),
  };
}

/** Story 4-6a (A20) — the order an `order.packed` payload names, or null when malformed. */
export function decodePackedOrderId(payload: unknown): string | null {
  const pack = typeof payload === 'object' && payload !== null ? (payload as { pack?: unknown }).pack : undefined;
  const orderId = typeof pack === 'object' && pack !== null ? (pack as { orderId?: unknown }).orderId : undefined;
  return typeof orderId === 'string' && UUID.test(orderId) ? orderId.toLowerCase() : null;
}

/** Story 4-6a (A20) — the documents-needed reminder's params, key by key from the gate read at delivery. */
export function buildDocumentsNeededEmailParams(
  input: {
    readonly orderId: string;
    readonly orderRef: string;
    readonly state: 'missing' | 'eway-required' | 'eway-expired';
    readonly requiredBecause: 'policy-all' | 'policy-b2b' | 'value' | null;
    readonly nationalThresholdPaise: number;
    readonly recordThresholdPaise: number | null;
    readonly ewayValidUntil: string | null;
  },
  names: ClientEmailNames,
): ClientDocumentsNeededEmailParams {
  const reason: DocumentsNeededReason =
    input.state === 'eway-required' ? 'eway-pending' : input.state === 'eway-expired' ? 'eway-expired' : (input.requiredBecause ?? 'value');
  const thresholdPaise = reason === 'value' ? input.nationalThresholdPaise : reason === 'eway-pending' ? input.recordThresholdPaise : null;
  return {
    tenantName: names.tenantName,
    clientName: names.clientName,
    warehouseName: names.warehouseName,
    orderId: input.orderId,
    orderRef: input.orderRef,
    needs: input.state === 'missing' ? 'invoice' : 'eway-bill',
    reason,
    threshold: thresholdPaise === null ? null : formatRupees(thresholdPaise),
    ewayValidUntil: input.state === 'eway-expired' ? input.ewayValidUntil : null,
    replyTo: names.replyTo,
  };
}

// ── story 4-4a: a shared shipping document ─────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOC_KINDS = ['invoice', 'challan', 'eway-bill', 'pod', 'other'] as const;

/** D6 — the `shipment.document-shared` payload, decoded key by key; null when malformed. */
export function decodeDocumentShared(payload: unknown): ShipmentDocumentFactInput | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  const id = (key: string, nullable: boolean): string | null | undefined => {
    const raw = value[key];
    if (raw === null && nullable) return null;
    return typeof raw === 'string' && UUID.test(raw) ? raw : undefined;
  };
  const attachmentId = id('attachmentId', false);
  const clientId = id('clientId', false);
  const orderId = id('orderId', true);
  const handoverId = id('handoverId', true);
  const purpose = value.purpose;
  const docKind = value.docKind;
  if (attachmentId == null || clientId == null || orderId === undefined || handoverId === undefined) return null;
  if (purpose !== 'shipping-document' && purpose !== 'handover-sheet') return null;
  if (purpose === 'shipping-document' && (typeof docKind !== 'string' || !(DOC_KINDS as readonly string[]).includes(docKind) || orderId === null)) return null;
  if (purpose === 'handover-sheet' && handoverId === null) return null;
  return { attachmentId, clientId, orderId, handoverId, purpose, docKind: typeof docKind === 'string' ? docKind : null };
}

/** The `client-shipment-document` params, key by key from the payload and the enqueue-time facts. */
export function buildShipmentDocumentEmailParams(
  fact: ShipmentDocumentFactInput,
  facts: ShipmentDocumentEmailFacts,
  names: Omit<ClientEmailNames, 'warehouseName'> & { readonly warehouseName?: string },
): ClientShipmentDocumentEmailParams {
  const documentKind: ShipmentDocumentKind = fact.purpose === 'handover-sheet' ? 'handover-sheet' : (fact.docKind as ShipmentDocumentKind);
  return {
    tenantName: names.tenantName,
    clientName: names.clientName,
    replyTo: names.replyTo,
    documentKind,
    subjectLabel: facts.subjectLabel,
    orderId: facts.orderId,
    orderRef: facts.orderRef,
    handoverCode: facts.handoverCode,
    handedOverAt: facts.handedOverAt,
    courierName: facts.courierName,
    awb: facts.awb,
    fileName: facts.fileName,
    page: facts.page,
    parcels: facts.parcels.slice(0, SHEET_PARCELS_SHOWN).map((parcel) => ({ orderRef: parcel.orderRef, awb: parcel.awb })),
    moreParcels: Math.max(0, facts.parcels.length - SHEET_PARCELS_SHOWN),
  };
}
