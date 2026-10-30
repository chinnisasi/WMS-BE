/**
 * Story 4-5a (A12, A36, A9) — the ONE model every packing document is drawn
 * from: the A4 packing slip (both audiences), the 4×6 thermal slips and the
 * carton labels, at the pack station, in the client portal and on the
 * dispatch email.
 *
 * One read, under the CALLER'S stamp: staff (tenant), portal and mail
 * (client-stamped, with `orders.client_id = $client` on the order read — the
 * second layer; every other row is reached through that order). Nothing here
 * writes.
 *
 * The parties are the pack's frozen ones; a pack with none (the virtual pack
 * of an order packed before 4-5a) prints the live parties with a note (2-9a's
 * legacy rule — no backfill). The lines come from the order and the
 * `pack.packed` docs (ordered, packed, short — kit parents as headings, never
 * short); the cartons from the pack (each from its own source — the bench
 * counts SKUs, never order lines). Totals are per UoM only (guide §7p).
 */

import { and, asc, desc, eq, ne } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { orderLines, orders, picks, shipments } from '../../shared/db/schema';
import type { LedgerEvent, Order } from '../../shared/db/schema';
import { formatQuantity } from '../../shared/primitives/client-event-facts';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { parcelTagCode } from '../../shared/primitives/parcel-tag';
import { fromMilli, toMilli } from '../../shared/primitives/quantity';
import { canonicalInstant, istDateOf } from '../../shared/primitives/time';
import type { DocumentWarehouseParty } from '../../shared/documents/parties';
import type { LabelConsignee, LabelPayment } from '../../shared/labels/shipping/carton-label';
import type { ClientPartySnapshotV1 } from '../clients/clients.facade';
import { uomPrecision } from '../catalog/uom';
import { memberDisplayNamesInTx } from '../tenancy/tenancy.service';
import { packRecordOfOrderInTx, skuFactsByIdInTx, type OrderLedgerEventsReader, type PackRecord } from './cartons.read';
import { documentPartiesInTx } from './order-packs';
import type { CartonDimensions } from './cartons';

/** A48 — at most this many batch sub-rows under one line, then "+N more batches". */
export const SLIP_MAX_BATCHES_PER_LINE = 10;
/** A17 — at most this many serials under one line, then "(+N more)". */
export const SLIP_MAX_SERIALS_PER_LINE = 20;

/** The batch-facts seam (`CatalogFacade.batchFactsByIdsInTx` — outbound reads no catalog table). */
export type BatchFactsReader = (
  tx: TenantTx,
  tenantId: string,
  batchIds: readonly string[],
) => Promise<ReadonlyMap<string, { readonly code: string; readonly expiryDate: string | null }>>;

export interface PackDocumentBatch {
  readonly code: string;
  /** IST calendar date, or null when the batch has none. */
  readonly expiryDate: string | null;
}

/** One order line on the slip. Quantities are display strings at the UoM's precision. */
export interface PackDocumentLine {
  readonly lineNo: number;
  /** `kit` — a kit parent (a heading: no packed, no short); `component` — under its kit; `line` — any other. */
  readonly kind: 'line' | 'kit' | 'component';
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly ordered: string;
  /** Null on a kit parent. */
  readonly packed: string | null;
  /** Null on a kit parent; "0" when complete. */
  readonly short: string | null;
  readonly shortMilli: number;
  readonly batches: readonly PackDocumentBatch[];
  readonly moreBatches: number;
  readonly serials: readonly string[];
  readonly moreSerials: number;
}

export interface PackDocumentCartonLine {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  /** Base units. */
  readonly qty: number;
  readonly handlingUnitIds: readonly string[] | null;
}

export interface PackDocumentCarton {
  readonly seq: number;
  readonly code: string;
  readonly weightGrams: number | null;
  readonly dimensionsMm: CartonDimensions | null;
  readonly lines: readonly PackDocumentCartonLine[];
  /** Per UoM, e.g. `12 EA, 2.5 KG` (never a cross-UoM unit total — A36). */
  readonly totals: string;
}

/** The order's shortfall: none, still to follow (before dispatch), or the named follow-on (after it — A36). */
export type PackDocumentShortfall =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly totals: string }
  | { readonly kind: 'follow-on'; readonly totals: string; readonly followOnLabel: string };

export interface PackDocument {
  readonly orderId: string;
  readonly orderLabel: string;
  readonly parcelTag: string;
  readonly clientOrderRef: string | null;
  readonly channelRef: string | null;
  readonly orderType: string | null;
  readonly orderStatus: string;
  readonly orderedAt: string;
  readonly payment: LabelPayment | null;
  readonly packSeq: number;
  readonly legacy: boolean;
  /** The physical pack (A47 — a re-carton keeps it). */
  readonly packedAt: string;
  /** "Re-packed {IST}" — set when the pack number is above 1 (A47). */
  readonly repackedAt: string | null;
  /** Staff only (null on the client read). */
  readonly packerName: string | null;
  readonly printedAt: string;
  readonly partiesFrozen: boolean;
  /** Set when the parties were frozen after the physical pack (a re-carton of a legacy order — A9). */
  readonly partiesAsAt: string | null;
  readonly client: ClientPartySnapshotV1;
  readonly warehouse: DocumentWarehouseParty;
  readonly consignee: LabelConsignee;
  readonly shipment: { readonly courierName: string; readonly awb: string } | null;
  readonly cartonCount: number;
  readonly grossWeightGrams: number | null;
  readonly cartons: readonly PackDocumentCarton[];
  readonly lines: readonly PackDocumentLine[];
  /** Packed per UoM over every packed line. */
  readonly totals: string;
  readonly shortfall: PackDocumentShortfall;
  /** The 4-6a / 4-10a seam (the brand's invoice, the e-way bill, hazard notes) — empty in 4-5a. */
  readonly annotations: readonly string[];
}

/** `12 EA, 2.5 KG` over milli quantities, each UoM at its own precision, in first-seen order. */
export function milliTotalsPerUom(rows: readonly { readonly uom: string; readonly milli: number }[]): string {
  const totals = new Map<string, number>();
  for (const row of rows) if (row.milli !== 0) totals.set(row.uom, (totals.get(row.uom) ?? 0) + row.milli);
  if (totals.size === 0) return '0';
  return [...totals].map(([uom, milli]) => `${formatQuantity(milli, uomPrecision(uom))} ${uom}`).join(', ');
}

/** The payment the label prints: COD with its amount, prepaid, or nothing on a legacy order with no type. */
export function paymentOf(order: Pick<Order, 'codAmountPaise' | 'orderType'>): LabelPayment | null {
  if (order.codAmountPaise !== null && order.codAmountPaise > 0) return { kind: 'cod', amountPaise: order.codAmountPaise };
  return order.orderType === null ? null : { kind: 'prepaid' };
}

export function consigneeOf(order: Order): LabelConsignee {
  return {
    contactName: order.destinationContactName ?? '—',
    legalName: order.consigneeLegalName ?? null,
    line1: order.destinationLine1 ?? '',
    line2: order.destinationLine2 ?? null,
    city: order.destinationCity ?? '',
    state: order.destinationState ?? '',
    pincode: order.destinationPincode ?? '',
    phone: order.destinationPhone ?? null,
    gstin: order.consigneeGstin ?? null,
  };
}

interface PackedDocRef {
  readonly kind?: string;
  readonly orderLineId?: string;
  readonly packedQty?: number;
}

export interface PackDocumentDeps {
  readonly ledgerEvents: OrderLedgerEventsReader;
  readonly batchFacts: BatchFactsReader;
}

/**
 * The document model of a packed order, or null when the order is unknown,
 * is not `clientId`'s (when given — one null for both), or has never been
 * packed (no stored pack and no `pack.packed` event).
 */
export async function packDocumentInTx(
  tx: TenantTx,
  tenantId: string,
  orderId: string,
  deps: PackDocumentDeps,
  options: { readonly clientId?: string; readonly printedAt: string },
): Promise<{ readonly doc: PackDocument; readonly record: PackRecord; readonly order: Order } | null> {
  const orderRows = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, orderId),
        ...(options.clientId === undefined ? [] : [eq(orders.clientId, options.clientId)]),
      ),
    )
    .limit(1);
  const order = orderRows[0];
  if (order === undefined) return null;

  // One ledger read serves the virtual pack, the packed quantities and the serials.
  let events: readonly LedgerEvent[] | null = null;
  const ledger: OrderLedgerEventsReader = async (t, tenant, warehouse, id) => {
    events ??= await deps.ledgerEvents(t, tenant, warehouse, id);
    return events;
  };
  const record = await packRecordOfOrderInTx(tx, tenantId, order, ledger);
  if (record === null) return null;
  const orderEvents = await ledger(tx, tenantId, order.warehouseId, order.id);

  // ── the parties: frozen, else live with the note ─────────────────────────
  const parties = record.parties ?? (await documentPartiesInTx(tx, tenantId, order.clientId, order.warehouseId));

  // ── the live shipment's courier and AWB (4-4a's live read) ───────────────
  const shipmentRows = await tx
    .select({ carrierName: shipments.carrierName, trackingNumber: shipments.trackingNumber })
    .from(shipments)
    .where(and(eq(shipments.tenantId, tenantId), eq(shipments.orderId, order.id), ne(shipments.status, 'voided')))
    .orderBy(desc(shipments.createdAt), desc(shipments.id))
    .limit(1);
  const shipment = shipmentRows[0] ?? null;

  // ── the lines ────────────────────────────────────────────────────────────
  const lineRows = await tx
    .select()
    .from(orderLines)
    .where(and(eq(orderLines.tenantId, tenantId), eq(orderLines.orderId, order.id)))
    .orderBy(asc(orderLines.createdAt), asc(orderLines.id));
  const packedByLine = new Map<string, number>();
  const serialsByLine = new Map<string, string[]>();
  for (const event of orderEvents) {
    const doc = (event.referenceDoc ?? {}) as PackedDocRef;
    if (event.type === 'pack.packed' && typeof doc.orderLineId === 'string') {
      packedByLine.set(doc.orderLineId, (packedByLine.get(doc.orderLineId) ?? 0) + toMilli(doc.packedQty ?? 0));
    } else if (event.type === 'pick.picked' && event.serialRef !== null && typeof doc.orderLineId === 'string') {
      serialsByLine.set(doc.orderLineId, [...(serialsByLine.get(doc.orderLineId) ?? []), event.serialRef]);
    }
  }
  const pickBatchRows = await tx
    .selectDistinct({ orderLineId: picks.orderLineId, batchId: picks.batchId })
    .from(picks)
    .where(and(eq(picks.tenantId, tenantId), eq(picks.orderId, order.id)));
  const batchIdsByLine = new Map<string, string[]>();
  for (const row of pickBatchRows) {
    if (row.batchId === null) continue;
    batchIdsByLine.set(row.orderLineId, [...(batchIdsByLine.get(row.orderLineId) ?? []), row.batchId]);
  }
  const batchFacts = await deps.batchFacts(tx, tenantId, pickBatchRows.flatMap((row) => (row.batchId === null ? [] : [row.batchId])));
  const skuFacts = await skuFactsByIdInTx(tx, tenantId, [
    ...lineRows.map((line) => line.skuId),
    ...record.cartons.flatMap((carton) => carton.lines.map((line) => line.skuId)),
  ]);
  const skuOf = (skuId: string) => skuFacts.get(skuId) ?? { code: skuId, name: skuId, uom: '' };

  const parentIds = new Set(lineRows.flatMap((line) => (line.parentLineId === null ? [] : [line.parentLineId])));
  const ordered: (typeof lineRows)[number][] = [];
  for (const line of lineRows) {
    if (line.parentLineId !== null && lineRows.some((candidate) => candidate.id === line.parentLineId)) continue;
    ordered.push(line);
    if (parentIds.has(line.id)) ordered.push(...lineRows.filter((candidate) => candidate.parentLineId === line.id));
  }
  const lines: PackDocumentLine[] = ordered.map((line, index) => {
    const sku = skuOf(line.skuId);
    const precision = uomPrecision(sku.uom);
    const kit = parentIds.has(line.id);
    const packedMilli = packedByLine.get(line.id) ?? 0;
    const shortMilli = kit ? 0 : Math.max(0, line.qty - packedMilli);
    const batches = (batchIdsByLine.get(line.id) ?? [])
      .map((id) => batchFacts.get(id))
      .filter((fact): fact is { code: string; expiryDate: string | null } => fact !== undefined)
      .map((fact) => ({ code: fact.code, expiryDate: fact.expiryDate === null ? null : istDateOf(fact.expiryDate) }))
      .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
    const serials = [...(serialsByLine.get(line.id) ?? [])].sort();
    return {
      lineNo: index + 1,
      kind: kit ? 'kit' : line.parentLineId !== null ? 'component' : 'line',
      skuId: line.skuId,
      skuCode: sku.code,
      skuName: sku.name,
      uom: sku.uom,
      ordered: formatQuantity(line.qty, precision),
      packed: kit ? null : formatQuantity(packedMilli, precision),
      short: kit ? null : formatQuantity(shortMilli, precision),
      shortMilli,
      batches: batches.slice(0, SLIP_MAX_BATCHES_PER_LINE),
      moreBatches: Math.max(0, batches.length - SLIP_MAX_BATCHES_PER_LINE),
      serials: serials.slice(0, SLIP_MAX_SERIALS_PER_LINE),
      moreSerials: Math.max(0, serials.length - SLIP_MAX_SERIALS_PER_LINE),
    };
  });
  const packedTotals = milliTotalsPerUom(
    ordered.filter((line) => !parentIds.has(line.id)).map((line) => ({ uom: skuOf(line.skuId).uom, milli: packedByLine.get(line.id) ?? 0 })),
  );
  const shortTotals = milliTotalsPerUom(lines.filter((line) => line.kind !== 'kit').map((line) => ({ uom: line.uom, milli: line.shortMilli })));

  // ── the shortfall: named only once the follow-on exists (A36) ────────────
  let shortfall: PackDocumentShortfall = { kind: 'none' };
  if (lines.some((line) => line.shortMilli > 0)) {
    shortfall = { kind: 'pending', totals: shortTotals };
    if (order.status === 'dispatched') {
      const followOn = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.followOnOfOrderId, order.id),
            ...(options.clientId === undefined ? [] : [eq(orders.clientId, options.clientId)]),
          ),
        )
        .orderBy(asc(orders.followOnSeq))
        .limit(1);
      if (followOn[0] !== undefined) shortfall = { kind: 'follow-on', totals: shortTotals, followOnLabel: orderLabelOf(followOn[0]) };
    }
  }

  // ── the cartons ──────────────────────────────────────────────────────────
  const cartons: PackDocumentCarton[] = record.cartons.map((carton) => {
    const cartonLines = carton.lines
      .map((line) => {
        const sku = skuOf(line.skuId);
        return { skuId: line.skuId, skuCode: sku.code, skuName: sku.name, uom: sku.uom, qty: fromMilli(line.qty), handlingUnitIds: line.handlingUnitIds, milli: line.qty };
      })
      .sort((left, right) => (left.skuCode < right.skuCode ? -1 : left.skuCode > right.skuCode ? 1 : 0));
    return {
      seq: carton.seq,
      code: carton.code,
      weightGrams: carton.weightGrams,
      dimensionsMm: carton.dimensionsMm,
      lines: cartonLines.map((line) => ({ skuId: line.skuId, skuCode: line.skuCode, skuName: line.skuName, uom: line.uom, qty: line.qty, handlingUnitIds: line.handlingUnitIds })),
      totals: milliTotalsPerUom(cartonLines),
    };
  });

  const packerName =
    options.clientId === undefined ? ((await memberDisplayNamesInTx(tx, tenantId, [record.packedBy])).get(record.packedBy) ?? null) : null;
  const partiesFrozenAt = record.partiesFrozenAt;
  const doc: PackDocument = {
    orderId: order.id,
    orderLabel: orderLabelOf(order),
    parcelTag: parcelTagCode(order.id),
    clientOrderRef: order.clientOrderRef ?? null,
    channelRef: order.externalEventId ?? null,
    orderType: order.orderType ?? null,
    orderStatus: order.status,
    orderedAt: canonicalInstant(order.createdAt),
    payment: paymentOf(order),
    packSeq: record.seq,
    legacy: record.legacy,
    packedAt: record.packedAt,
    repackedAt: record.seq > 1 ? record.createdAt : null,
    packerName,
    printedAt: canonicalInstant(options.printedAt),
    partiesFrozen: record.parties !== null,
    partiesAsAt: partiesFrozenAt !== null && partiesFrozenAt !== record.packedAt ? partiesFrozenAt : null,
    client: parties.client,
    warehouse: parties.warehouse,
    consignee: consigneeOf(order),
    shipment: shipment === null ? null : { courierName: shipment.carrierName, awb: shipment.trackingNumber },
    cartonCount: record.cartonCount,
    grossWeightGrams: record.grossWeightGrams,
    cartons,
    lines,
    totals: packedTotals,
    shortfall,
    annotations: [],
  };
  return { doc, record, order };
}
