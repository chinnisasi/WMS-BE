import type { TenantTx } from '../../shared/db/tenant-scope';
import { rearmTxDeadline } from '../../shared/db/tx-deadline';
import type { ExportCell, ExportColumn } from '../../shared/export/cells';
import { istWallClock } from '../../shared/primitives/time';
import { getClientLabelsInTx, getClientsInTx } from '../clients/clients.facade';
import type { BatchLifecycleView, CatalogFacade } from '../catalog/catalog.facade';
import type { InboundFacade } from '../inbound/inbound.facade';
import { PICK_NETTING_TYPES, type BatchTraceCursor, type BatchTraceEvent, type InventoryFacade, type LedgerReferenceDoc } from '../inventory/inventory.facade';
import type { OrderTraceFacts, OutboundFacade, PlannedRecallBinTask } from '../outbound/outbound.facade';
import {
  RECALL_FIGURE_NAMES,
  type CloseSummaryLot,
  type RecallLiveState,
  type RecallLotFigures,
  type RecallsFacade,
  type RecallWithLines,
} from '../recalls/recalls.facade';
import { memberDisplayNamesInTx } from '../tenancy/tenancy.service';

/**
 * Story 3-7a — a batch recall's trace, composed for the staff detail, its
 * paged lists, the portal detail and the client recall report (CSV / XLSX).
 * Every row comes from a read on the OWNING module's facade (AD-6 — like the
 * 5-3a registers, this is not a read-model exception): recalls (the document
 * and the ONE figures definition), inventory (on hand, the ledger events),
 * outbound (orders, planned tasks), inbound (receipts), catalog (lots, SKUs)
 * and tenancy (actor display names — staff only). Reporting writes nothing.
 *
 * One schema for every report row, with a `section` column (decision 8 as
 * amended by A10): `meta` rows first, then the figures (live, and at close
 * for a closed recall), where the lot sits, who holds it, where it went and
 * where it came from, and a final `end` row carrying the row count — so a
 * streamed file cut short is recognisable (it lacks its `end` row).
 *
 * PII (decision 7): the consignee's legal name and GSTIN, the destination
 * city / state / pincode, the client's order number, the channel reference,
 * the carrier and the AWB — the 5-3a outbound register's set. NO contact name,
 * phone or address line (the full-contact export is 3-7b; the meta says so).
 * The portal sees only its own client's recall (two layers — the caller
 * stamps the transaction; the recall read carries the client predicate) and
 * never a bin code, a planned pick or an actor's identity.
 */

export const RECALL_REPORT_SECTIONS = [
  'meta',
  'figure_live',
  'figure_at_close',
  'on_hand',
  'in_transit',
  'held_in_open_order',
  'planned_pick_in_recalled_bin',
  'dispatched',
  'received',
  'received_damaged',
  'returned',
  'return_scrapped',
  // Story 2-8b — recalled (or any) units of the lot sent back to their vendor.
  'returned_to_vendor',
  'adjusted_out',
  'end',
] as const;
export type RecallReportSection = (typeof RECALL_REPORT_SECTIONS)[number];

/** The surface a trace is composed for: `portal` drops bins, planned picks and identities. */
export type RecallSurface = 'staff' | 'portal';

function text(header: string): ExportColumn {
  return { header, kind: 'text' };
}

/**
 * The report's columns, in file order (the header golden is
 * `test/recalls.spec.ts`). `location` is, per section: the figure's name
 * (figure rows), the location role — `storage` or a system bin's code —
 * (on hand), the bin code (planned picks, staff only), the order's label
 * (held / dispatched) or the GRN code (received, damaged).
 */
export const RECALL_REPORT_COLUMNS: readonly ExportColumn[] = [
  text('section'),
  text('client_code'),
  text('sku_code'),
  text('sku_name'),
  text('uom'),
  text('batch_code'),
  { header: 'expiry_date', kind: 'date' },
  text('warehouse_code'),
  text('location'),
  { header: 'event_ist', kind: 'instant' },
  text('during_recall'),
  text('client_order_ref'),
  text('channel_order_ref'),
  text('consignee_legal_name'),
  text('consignee_gstin'),
  text('destination_city'),
  text('destination_state'),
  text('destination_pincode'),
  text('carrier'),
  text('awb'),
  text('vendor_name'),
  text('reason'),
  { header: 'quantity', kind: 'number' },
  text('meta_field'),
  text('meta_value'),
];

/** The events one page of the trace's walk reads (the CSV's internal page, A10). */
export const RECALL_TRACE_PAGE = 1000;

/** The meta row's note on what the file does NOT carry (B20). */
export const CONSIGNEE_CONTACTS_NOTE =
  'Consignee contact names, phone numbers and street addresses are not in this file; ask your warehouse for the full-contact export.';

export interface RecallTraceSources {
  readonly recalls: RecallsFacade;
  readonly catalog: CatalogFacade;
  readonly inventory: InventoryFacade;
  readonly outbound: OutboundFacade;
  readonly inbound: InboundFacade;
}

/** One lot of the recall with its catalog facts. */
export interface RecallLotFacts {
  readonly ordinal: number;
  readonly batchId: string;
  readonly batchCode: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly expiryDate: string | null;
  readonly blockedByRecall: boolean;
  readonly view: BatchLifecycleView | null;
}

/** Everything a trace is composed from, read once in ONE snapshot. */
export interface PreparedRecall {
  readonly surface: RecallSurface;
  readonly tenantId: string;
  readonly recall: RecallWithLines;
  readonly clientCode: string;
  readonly clientName: string;
  readonly lots: readonly RecallLotFacts[];
  readonly state: RecallLiveState;
  /** Staff only (A13); empty on the portal. */
  readonly plannedTasks: readonly PlannedRecallBinTask[];
  /** Staff only: the opener and closer display names. */
  readonly actorNames: ReadonlyMap<string, string>;
  readonly asOf: string;
}

/**
 * Read everything but the event sections, in the caller's transaction (a
 * REPEATABLE READ one), or null when the recall is unknown — or, with
 * `clientId`, another client's (the SAME null: never confirm it exists).
 */
export async function prepareRecallInTx(
  tx: TenantTx,
  sources: RecallTraceSources,
  tenantId: string,
  recallId: string,
  surface: RecallSurface,
  clientId: string | null,
  now: Date,
): Promise<PreparedRecall | null> {
  const recall = await sources.recalls.recallInTx(tx, tenantId, recallId, clientId);
  if (recall === null) return null;
  const header = recall.header;
  await rearmTxDeadline(tx);
  const client = (await getClientsInTx(tx, tenantId, [header.clientId])).get(header.clientId);
  const clientLabel = (await getClientLabelsInTx(tx, tenantId, [header.clientId])).get(header.clientId);
  const skus = await (async () => {
    await rearmTxDeadline(tx);
    return sources.catalog.skuLabelsInTx(tx, tenantId, recall.lines.map((line) => line.skuId));
  })();
  const views = await sources.catalog.batchViewsByIdsInTx(tx, tenantId, recall.lines.map((line) => line.batchId));
  const lots: RecallLotFacts[] = recall.lines.map((line, ordinal) => {
    const sku = skus.get(line.skuId);
    const view = views.get(line.batchId) ?? null;
    return {
      ordinal,
      batchId: line.batchId,
      batchCode: line.batchCode,
      skuId: line.skuId,
      skuCode: sku?.code ?? line.skuId,
      skuName: sku?.name ?? line.skuId,
      uom: sku?.uom ?? '',
      expiryDate: view?.expiryDate ?? null,
      blockedByRecall: line.blockedByRecall,
      view,
    };
  });
  const state = await sources.recalls.recallLiveStateInTx(
    tx,
    tenantId,
    header.clientId,
    recall.lines.map((line) => ({ batchId: line.batchId, skuId: line.skuId })),
  );
  let plannedTasks: PlannedRecallBinTask[] = [];
  if (surface === 'staff') {
    const pairs = new Map<string, { binId: string; skuId: string }>();
    for (const row of state.onHandRows) {
      if (row.role === 'storage') pairs.set(`${row.binId}:${row.skuId}`, { binId: row.binId, skuId: row.skuId });
    }
    plannedTasks =
      header.mode === 'live' && header.status === 'open' ? await sources.outbound.plannedTasksInBinsInTx(tx, tenantId, state.openOrderIds, [...pairs.values()]) : [];
  }
  const actorNames =
    surface === 'staff'
      ? await memberDisplayNamesInTx(tx, tenantId, [header.openedBy, ...(header.closedBy === null ? [] : [header.closedBy])])
      : new Map<string, string>();
  return {
    surface,
    tenantId,
    recall,
    clientCode: client?.code ?? header.clientId,
    clientName: clientLabel ?? client?.code ?? header.clientId,
    lots,
    state,
    plannedTasks,
    actorNames,
    asOf: now.toISOString(),
  };
}

// ── the JSON views ───────────────────────────────────────────────────────────

export interface RecallOnHandEntry {
  readonly warehouseId: string;
  readonly warehouseCode: string;
  /** `storage`, or a system bin's code (`RECEIVING`, `QC-HOLD`, `DAMAGED`, `RETURNS`, `IN-TRANSIT`). */
  readonly role: string;
  readonly batchId: string;
  readonly batchCode: string;
  readonly quantity: number;
}

/** On hand per (lot, warehouse, role) — never a bin. Ordered lot, warehouse code, role (storage first). */
export function onHandByWarehouse(prepared: PreparedRecall): RecallOnHandEntry[] {
  const out = new Map<string, { warehouseId: string; role: string; batchId: string; quantity: number }>();
  for (const row of prepared.state.onHandRows) {
    const key = `${row.batchId}:${row.warehouseId}:${row.role}`;
    const entry = out.get(key) ?? { warehouseId: row.warehouseId, role: row.role, batchId: row.batchId, quantity: 0 };
    entry.quantity = Math.round((entry.quantity + row.quantity) * 1000) / 1000;
    out.set(key, entry);
  }
  const lotOrder = new Map(prepared.lots.map((lot) => [lot.batchId, lot]));
  return [...out.values()]
    .map((entry) => ({
      warehouseId: entry.warehouseId,
      warehouseCode: prepared.state.warehouses.get(entry.warehouseId) ?? entry.warehouseId,
      role: entry.role,
      batchId: entry.batchId,
      batchCode: lotOrder.get(entry.batchId)?.batchCode ?? entry.batchId,
      quantity: entry.quantity,
    }))
    .sort(
      (a, b) =>
        (lotOrder.get(a.batchId)?.ordinal ?? 0) - (lotOrder.get(b.batchId)?.ordinal ?? 0) ||
        compareText(a.warehouseCode, b.warehouseCode) ||
        Number(a.role !== 'storage') - Number(b.role !== 'storage') ||
        compareText(a.role, b.role),
    );
}

export interface RecallHeldOrderEntry {
  readonly orderId: string;
  readonly orderLabel: string;
  readonly clientOrderRef: string | null;
  readonly channelOrderRef: string | null;
  readonly status: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly batchId: string;
  readonly batchCode: string;
  readonly quantity: number;
  readonly lastPickedAt: string;
}

/** Each open order line holding picked units of a lot, net (A7). */
export function heldOrders(prepared: PreparedRecall): RecallHeldOrderEntry[] {
  const lots = new Map(prepared.lots.map((lot) => [lot.batchId, lot]));
  return prepared.state.heldLines.map((line) => {
    const order = prepared.state.orders.get(line.orderId);
    return {
      orderId: line.orderId,
      orderLabel: order?.orderLabel ?? line.orderId.slice(-8),
      clientOrderRef: order?.clientOrderRef ?? null,
      channelOrderRef: order?.channelOrderRef ?? null,
      status: order?.status ?? 'unknown',
      warehouseId: order?.warehouseId ?? '',
      warehouseCode: order === undefined ? '' : (prepared.state.warehouses.get(order.warehouseId) ?? order.warehouseId),
      batchId: line.batchId,
      batchCode: lots.get(line.batchId)?.batchCode ?? line.batchId,
      quantity: line.quantity,
      lastPickedAt: line.lastPickedAt,
    };
  });
}

/** The close summary's lot of one batch, or null (open recall / not on the summary). */
export function closeLotOf(prepared: PreparedRecall, batchId: string): CloseSummaryLot | null {
  return prepared.recall.header.closeSummary?.lots.find((lot) => lot.batchId === batchId) ?? null;
}

/** Whole seconds from open to the first download, null before one. */
export function timeToReportSeconds(prepared: PreparedRecall): number | null {
  const first = prepared.recall.header.firstReportAt;
  if (first === null) return null;
  return Math.max(0, Math.round((Date.parse(first) - Date.parse(prepared.recall.header.openedAt)) / 1000));
}

// ── the event walk (dispatched, received, damaged, returned, scrapped, written off) ─

/** The event sections, each with the ledger types it walks. */
const EVENT_SECTIONS: Readonly<Record<'dispatched' | 'received' | 'received_damaged' | 'returned' | 'return_scrapped' | 'returned_to_vendor' | 'adjusted_out', readonly string[]>> = {
  dispatched: PICK_NETTING_TYPES,
  received: ['grn.received'],
  received_damaged: ['grn.damaged'],
  returned: ['return.received'],
  return_scrapped: ['return.scrapped'],
  // Story 2-8b — the draw out of DAMAGED at a return-to-vendor's dispatch.
  returned_to_vendor: ['rtv.dispatched'],
  adjusted_out: ['stock.adjusted'],
};
type EventSection = keyof typeof EVENT_SECTIONS;

/** The trace walk's position: the lot's ordinal, then the event keyset within it. */
export interface RecallWalkCursor {
  readonly lot: number;
  readonly after: BatchTraceCursor | null;
}

/** One rendered event row of a section, with the facts the JSON lists need too. */
export interface RecallEventRow {
  readonly section: EventSection;
  readonly lot: RecallLotFacts;
  readonly event: BatchTraceEvent;
  readonly warehouseCode: string;
  /** Base units, positive. */
  readonly quantity: number;
  readonly duringRecall: boolean;
  readonly order: OrderTraceFacts | null;
  readonly dispatchedAt: string | null;
  readonly carrier: string | null;
  readonly awb: string | null;
  readonly grnCode: string | null;
  readonly document: string | null;
  readonly vendorName: string | null;
  readonly reason: string | null;
}

function refDoc(event: BatchTraceEvent): LedgerReferenceDoc | null {
  return typeof event.referenceDoc === 'object' && event.referenceDoc !== null ? event.referenceDoc : null;
}

function present(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === '' ? null : value;
}

/**
 * One page of a section's rows across the lots, from `cursor`: at most
 * `limit` rows, and the cursor after the last one (null at the end). Each
 * page of ledger events (`pageSize`) is enriched in a bounded number of
 * statements — the GRNs, the orders' first dispatch, the damage reasons.
 */
export async function eventRowsPageInTx(
  tx: TenantTx,
  sources: RecallTraceSources,
  prepared: PreparedRecall,
  section: EventSection,
  cursor: RecallWalkCursor,
  limit: number,
  pageSize: number = RECALL_TRACE_PAGE,
): Promise<{ rows: RecallEventRow[]; next: RecallWalkCursor | null }> {
  const rows: RecallEventRow[] = [];
  let lotIndex = cursor.lot;
  let after = cursor.after;
  const openedAt = Date.parse(prepared.recall.header.openedAt);
  while (lotIndex < prepared.lots.length && rows.length < limit) {
    const lot = prepared.lots[lotIndex]!;
    const events = await sources.inventory.batchTraceEventsPageInTx(tx, prepared.tenantId, lot.batchId, EVENT_SECTIONS[section], after, pageSize);
    let kept = events;
    if (section === 'dispatched') {
      kept = events.filter((event) => {
        const doc = refDoc(event);
        return doc !== null && doc.kind === 'pick' && prepared.state.orders.get(doc.orderId)?.status === 'dispatched';
      });
    } else if (section === 'adjusted_out') {
      kept = events.filter((event) => event.quantity < 0);
    }
    const orderIds = section === 'dispatched' ? kept.map((event) => (refDoc(event) as { orderId: string }).orderId) : [];
    const dispatches = orderIds.length === 0 ? new Map() : await sources.inventory.firstDispatchByOrderInTx(tx, prepared.tenantId, orderIds);
    const grnIds = section === 'received' || section === 'received_damaged'
      ? kept.flatMap((event) => {
          const doc = refDoc(event);
          return doc !== null && doc.kind === 'grn-receipt' ? [doc.grnId] : [];
        })
      : [];
    const grns = grnIds.length === 0 ? new Map() : await sources.inbound.grnTraceFactsByIdsInTx(tx, prepared.tenantId, grnIds);
    const damageLineIds = section === 'received_damaged'
      ? kept.flatMap((event) => {
          const doc = refDoc(event);
          return doc !== null && doc.kind === 'grn-receipt' && doc.grnLineId !== undefined ? [doc.grnLineId] : [];
        })
      : [];
    const damageReasons = damageLineIds.length === 0 ? new Map<string, string>() : await sources.inbound.grnLineDamageReasonsByIdsInTx(tx, prepared.tenantId, damageLineIds);
    const vendorReturnIds = section === 'returned_to_vendor'
      ? kept.flatMap((event) => {
          const doc = refDoc(event);
          return doc !== null && doc.kind === 'vendor-return' ? [doc.vendorReturnId] : [];
        })
      : [];
    const vendorReturns = vendorReturnIds.length === 0 ? new Map<string, { code: string; vendorName: string }>() : await sources.inbound.vendorReturnTraceFactsInTx(tx, prepared.tenantId, vendorReturnIds);

    const keptSet = new Set(kept);
    let stoppedEarly = false;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (rows.length >= limit) {
        stoppedEarly = true;
        break;
      }
      after = { seq: event.seq, warehouseId: event.warehouseId };
      if (!keptSet.has(event)) continue;
      const doc = refDoc(event);
      const base = {
        section,
        lot,
        event,
        warehouseCode: prepared.state.warehouses.get(event.warehouseId) ?? event.warehouseId,
        quantity: Math.abs(event.quantity),
        duringRecall: Date.parse(event.recordedAt) >= openedAt,
        order: null,
        dispatchedAt: null,
        carrier: null,
        awb: null,
        grnCode: null,
        document: null,
        vendorName: null,
        reason: null,
      } satisfies RecallEventRow;
      if (section === 'dispatched' && doc !== null && doc.kind === 'pick') {
        const order = prepared.state.orders.get(doc.orderId) ?? null;
        const dispatch = dispatches.get(doc.orderId) as { dispatchedAt: string; carrierName: string | null; trackingNumber: string | null } | undefined;
        const carrier = present(dispatch?.carrierName);
        const awb = present(dispatch?.trackingNumber);
        const fromEvent = carrier !== null || awb !== null;
        rows.push({
          ...base,
          order,
          dispatchedAt: dispatch?.dispatchedAt ?? null,
          duringRecall: dispatch !== undefined && Date.parse(dispatch.dispatchedAt) >= openedAt,
          carrier: fromEvent ? carrier : present(order?.shipmentCarrier),
          awb: fromEvent ? awb : present(order?.shipmentTracking),
        });
      } else if ((section === 'received' || section === 'received_damaged') && doc !== null && doc.kind === 'grn-receipt') {
        const grn = grns.get(doc.grnId) as { grnCode: string; vendorName: string | null; document: string } | undefined;
        const damage = doc.grnLineId === undefined ? undefined : damageReasons.get(doc.grnLineId);
        rows.push({
          ...base,
          grnCode: grn?.grnCode ?? doc.grnId,
          document: grn?.document ?? null,
          vendorName: grn?.vendorName ?? null,
          reason:
            section === 'received'
              ? (grn?.document ?? null)
              : `damaged on receipt${damage === undefined ? '' : ` (${damage})`} — held in DAMAGED; the units leave by a write-off or a return to vendor`,
        });
      } else if (section === 'returned') {
        rows.push({ ...base, reason: 'returned by the consignee (an authorised return received into RETURNS)' });
      } else if (section === 'return_scrapped') {
        const reason = doc !== null && doc.kind === 'return-disposition' ? (doc.reasonCode ?? 'scrap') : 'scrap';
        rows.push({ ...base, reason: `${reason} — trace stops here: the returned units were scrapped` });
      } else if (section === 'returned_to_vendor') {
        const rtv = doc !== null && doc.kind === 'vendor-return' ? vendorReturns.get(doc.vendorReturnId) : undefined;
        rows.push({
          ...base,
          document: rtv?.code ?? null,
          vendorName: rtv?.vendorName ?? null,
          reason: `returned to vendor${rtv === undefined ? '' : ` on ${rtv.code}`} — trace stops here: the units left DAMAGED for the vendor`,
        });
      } else if (section === 'adjusted_out') {
        const reason = doc !== null && doc.kind === 'manual-adjustment' ? doc.reasonCode : 'adjustment';
        rows.push({ ...base, reason: `${reason} — trace stops here: the units left stock by adjustment` });
      }
    }
    if (stoppedEarly) {
      // `after` is the last event consumed, so the next page resumes on the first unread one.
      return { rows, next: { lot: lotIndex, after } };
    }
    if (events.length < pageSize) {
      lotIndex += 1;
      after = null;
    }
  }
  return { rows, next: lotIndex < prepared.lots.length ? { lot: lotIndex, after } : null };
}

// ── the report rows ──────────────────────────────────────────────────────────

const FIGURE_LABEL: Readonly<Record<(typeof RECALL_FIGURE_NAMES)[number], string>> = {
  received: 'received',
  receivedDamaged: 'received_damaged',
  onHand: 'on_hand',
  inTransit: 'in_transit',
  heldInOpenOrders: 'held_in_open_orders',
  dispatched: 'dispatched',
  returned: 'returned',
  returnScrapped: 'return_scrapped',
  adjustedOut: 'adjusted_out',
  unaccounted: 'unaccounted',
};

function at(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function ist(value: string | null): string {
  return value === null ? '' : istWallClock(new Date(value));
}

/** A row with every column null but the section — the cells the builders fill. */
function blank(section: RecallReportSection): ExportCell[] {
  const row: ExportCell[] = RECALL_REPORT_COLUMNS.map(() => null);
  row[0] = section;
  return row;
}

const COL = Object.fromEntries(RECALL_REPORT_COLUMNS.map((column, index) => [column.header, index])) as Record<string, number>;

function lotRow(section: RecallReportSection, prepared: PreparedRecall, lot: RecallLotFacts): ExportCell[] {
  const row = blank(section);
  row[COL.client_code!] = prepared.clientCode;
  row[COL.sku_code!] = lot.skuCode;
  row[COL.sku_name!] = lot.skuName;
  row[COL.uom!] = lot.uom;
  row[COL.batch_code!] = lot.batchCode;
  row[COL.expiry_date!] = at(lot.expiryDate);
  return row;
}

function orderCells(row: ExportCell[], order: OrderTraceFacts | null): void {
  if (order === null) return;
  row[COL.location!] = order.orderLabel;
  row[COL.client_order_ref!] = order.clientOrderRef;
  row[COL.channel_order_ref!] = order.channelOrderRef;
  row[COL.consignee_legal_name!] = order.consigneeLegalName;
  row[COL.consignee_gstin!] = order.consigneeGstin;
  row[COL.destination_city!] = order.destinationCity;
  row[COL.destination_state!] = order.destinationState;
  row[COL.destination_pincode!] = order.destinationPincode;
}

/** The leading `meta` rows (A10). */
export function metaRows(prepared: PreparedRecall): ExportCell[][] {
  const header = prepared.recall.header;
  const fields: [string, string][] = [
    ['recall_code', header.code],
    ['mode', header.mode === 'mock' ? 'MOCK — a drill; no lot was blocked' : 'live'],
    ['status', header.status],
    ['external_ref', header.externalRef ?? ''],
    ['client', `${prepared.clientCode} — ${prepared.clientName}`],
    ['reason_note', header.reasonNote],
    ['opened_ist', ist(header.openedAt)],
    ['closed_ist', ist(header.closedAt)],
    ['generated_ist', ist(prepared.asOf)],
    ['as_of_ist', ist(prepared.asOf)],
    ['lot_count', String(prepared.lots.length)],
    ['consignee_contacts', CONSIGNEE_CONTACTS_NOTE],
  ];
  return fields.map(([field, value]) => {
    const row = blank('meta');
    row[COL.meta_field!] = field;
    row[COL.meta_value!] = value;
    return row;
  });
}

function figureRows(section: 'figure_live' | 'figure_at_close', prepared: PreparedRecall, lot: RecallLotFacts, figures: RecallLotFigures, byReason: Readonly<Record<string, number>>): ExportCell[][] {
  const rows = RECALL_FIGURE_NAMES.map((name) => {
    const row = lotRow(section, prepared, lot);
    row[COL.location!] = FIGURE_LABEL[name];
    row[COL.quantity!] = figures[name];
    return row;
  });
  for (const [reason, quantity] of Object.entries(byReason)) {
    const row = lotRow(section, prepared, lot);
    row[COL.location!] = 'adjusted_out_by_reason';
    row[COL.reason!] = reason;
    row[COL.quantity!] = quantity;
    rows.push(row);
  }
  return rows;
}

/** The figure, on-hand, in-transit, held and planned rows — everything known before the event walk. */
export function snapshotRows(prepared: PreparedRecall): ExportCell[][] {
  const rows: ExportCell[][] = [];
  for (const lot of prepared.lots) {
    rows.push(...figureRows('figure_live', prepared, lot, prepared.state.figures.get(lot.batchId)!, prepared.state.adjustedOutByReason.get(lot.batchId) ?? {}));
  }
  if (prepared.recall.header.closeSummary !== null) {
    for (const lot of prepared.lots) {
      const closed = closeLotOf(prepared, lot.batchId);
      if (closed !== null) rows.push(...figureRows('figure_at_close', prepared, lot, closed.figures, closed.adjustedOutByReason));
    }
  }
  const lots = new Map(prepared.lots.map((lot) => [lot.batchId, lot]));
  for (const entry of onHandByWarehouse(prepared)) {
    const lot = lots.get(entry.batchId)!;
    const row = lotRow(entry.role === 'IN-TRANSIT' ? 'in_transit' : 'on_hand', prepared, lot);
    row[COL.warehouse_code!] = entry.warehouseCode;
    row[COL.location!] = entry.role;
    row[COL.quantity!] = entry.quantity;
    rows.push(row);
  }
  // in_transit rows after every on_hand row (the section order).
  rows.sort((a, b) => sectionIndex(a[0] as RecallReportSection) - sectionIndex(b[0] as RecallReportSection));
  for (const line of prepared.state.heldLines) {
    const lot = lots.get(line.batchId)!;
    const order = prepared.state.orders.get(line.orderId) ?? null;
    const row = lotRow('held_in_open_order', prepared, lot);
    orderCells(row, order);
    row[COL.warehouse_code!] = order === null ? null : (prepared.state.warehouses.get(order.warehouseId) ?? order.warehouseId);
    row[COL.event_ist!] = at(line.lastPickedAt);
    row[COL.reason!] = 'picked into an open order — dispatch refuses it while the recall is open';
    row[COL.quantity!] = line.quantity;
    rows.push(row);
  }
  if (prepared.surface === 'staff') {
    for (const task of prepared.plannedTasks) {
      // The task's own lot when the plan named one of the recall's lots; else
      // a lot of its SKU for the SKU columns, with the lot columns blank (the
      // plan's batch is another, unrecalled lot — never another lot's expiry).
      const planned = task.plannedBatchId === null ? undefined : lots.get(task.plannedBatchId);
      const lot = planned ?? prepared.lots.find((candidate) => candidate.skuId === task.skuId);
      if (lot === undefined) continue;
      const order = prepared.state.orders.get(task.orderId) ?? null;
      const row = lotRow('planned_pick_in_recalled_bin', prepared, lot);
      orderCells(row, order);
      if (planned === undefined) {
        row[COL.batch_code!] = null;
        row[COL.expiry_date!] = null;
      }
      row[COL.warehouse_code!] = prepared.state.warehouses.get(task.warehouseId) ?? task.warehouseId;
      row[COL.location!] = binCodeOf(prepared, task.binId);
      row[COL.reason!] = 'a planned pick at a bin holding the recalled lot — it refuses until the recalled units are moved out';
      row[COL.quantity!] = task.quantity;
      rows.push(row);
    }
  }
  return rows;
}

function binCodeOf(prepared: PreparedRecall, binId: string): string {
  return prepared.state.onHandRows.find((row) => row.binId === binId)?.binCode ?? binId;
}

function sectionIndex(section: RecallReportSection): number {
  return RECALL_REPORT_SECTIONS.indexOf(section);
}

/** One event row as report cells. */
export function eventCells(prepared: PreparedRecall, row: RecallEventRow): ExportCell[] {
  const cells = lotRow(row.section, prepared, row.lot);
  cells[COL.warehouse_code!] = row.warehouseCode;
  cells[COL.during_recall!] = row.duringRecall ? 'yes' : 'no';
  cells[COL.quantity!] = row.quantity;
  cells[COL.reason!] = row.reason;
  if (row.section === 'dispatched') {
    orderCells(cells, row.order);
    cells[COL.event_ist!] = at(row.dispatchedAt);
    cells[COL.carrier!] = row.carrier;
    cells[COL.awb!] = row.awb;
  } else {
    cells[COL.event_ist!] = at(row.event.recordedAt);
    if (row.grnCode !== null) cells[COL.location!] = row.grnCode;
    cells[COL.vendor_name!] = row.vendorName;
    if (row.section === 'returned' || row.section === 'return_scrapped') cells[COL.location!] = 'RETURNS';
    if (row.section === 'returned_to_vendor') cells[COL.location!] = 'DAMAGED';
  }
  return cells;
}

/** The final row: its count is every row written before it (A10 — a cut file lacks it). */
export function endRow(rowCount: number): ExportCell[] {
  const row = blank('end');
  row[COL.meta_field!] = 'row_count';
  row[COL.meta_value!] = String(rowCount);
  return row;
}

/** The event sections, in file order. */
export const RECALL_EVENT_SECTIONS: readonly EventSection[] = ['dispatched', 'received', 'received_damaged', 'returned', 'return_scrapped', 'returned_to_vendor', 'adjusted_out'];

/**
 * Every report row after the meta, in section order: the snapshot rows, then
 * each event section walked lot by lot in pages of `pageSize` events. A
 * generator, so the CSV streams without holding the file.
 */
export async function* recallReportRows(
  tx: TenantTx,
  sources: RecallTraceSources,
  prepared: PreparedRecall,
  pageSize: number = RECALL_TRACE_PAGE,
): AsyncGenerator<ExportCell[]> {
  for (const row of snapshotRows(prepared)) yield row;
  for (const section of RECALL_EVENT_SECTIONS) {
    let cursor: RecallWalkCursor | null = { lot: 0, after: null };
    while (cursor !== null) {
      const page: { rows: RecallEventRow[]; next: RecallWalkCursor | null } = await eventRowsPageInTx(tx, sources, prepared, section, cursor, pageSize, pageSize);
      for (const row of page.rows) yield eventCells(prepared, row);
      cursor = page.next;
    }
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
