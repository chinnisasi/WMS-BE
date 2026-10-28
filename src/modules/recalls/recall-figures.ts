import type { TenantTx } from '../../shared/db/tenant-scope';
import { IN_TRANSIT_BIN_CODE } from '../tenancy/receiving-bin';
import { warehouseCodesOfTenantInTx } from '../tenancy/tenancy.service';
import type { InventoryFacade, OrderPickEvent, RecallOnHandRow } from '../inventory/inventory.facade';
import type { OrderTraceFacts, OutboundFacade } from '../outbound/outbound.facade';

/**
 * Story 3-7a (A7) — a recall's figures per lot, in BASE units: ONE definition,
 * read live by the detail and the report and frozen by the close
 * (`close-summary.ts`). Derived from the ledger and the projections through
 * the owning facades (AD-6); never stored anywhere but the close summary.
 *
 *   received          Σ `grn.received`
 *   receivedDamaged   Σ `grn.damaged`
 *   onHand            Σ `batch_on_hand`, EXCLUDING the IN-TRANSIT bin
 *   inTransit         `batch_on_hand` in IN-TRANSIT bins (a transfer not yet confirmed)
 *   heldInOpenOrders  NET pick quantity per (order line, batch) for orders in
 *                     `ORDER_OPEN_STATUSES` — the client's open orders first
 *                     (the 0101 partial index, A8), never a walk of the lot
 *   dispatched        the same, for `dispatched` orders
 *   returned          Σ `return.received`
 *   returnScrapped    Σ |δ| `return.scrapped` (4-7a — a returned unit scrapped)
 *   adjustedOut       Σ |δ| of negative `stock.adjusted` (by reason code too)
 *   unaccounted       the whole-history fold (`ON_HAND_FOLD_TERM`) − onHand − inTransit
 *
 * They are figures, not a reconciliation: moves, QC and damage are not
 * summed. `unaccounted` should read 0 — non-zero means the projection has
 * diverged (or the batch sits in a quarantined scope); the close then needs
 * an explicit acknowledgement.
 */
export const RECALL_FIGURE_NAMES = [
  'received',
  'receivedDamaged',
  'onHand',
  'inTransit',
  'heldInOpenOrders',
  'dispatched',
  'returned',
  'returnScrapped',
  'adjustedOut',
  'unaccounted',
] as const;
export type RecallFigureName = (typeof RECALL_FIGURE_NAMES)[number];
export type RecallLotFigures = Readonly<Record<RecallFigureName, number>>;

export interface RecallLotRef {
  readonly batchId: string;
  readonly skuId: string;
}

/** One open order line holding picked units of a recalled lot. */
export interface RecallHeldLine {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly batchId: string;
  /** NET base units. */
  readonly quantity: number;
  /** The latest pick of the line's units (an ISO instant). */
  readonly lastPickedAt: string;
}

export interface RecallLiveState {
  /** The tenant's warehouses, id → code. */
  readonly warehouses: ReadonlyMap<string, string>;
  /** Every positive on-hand row of the lots (IN-TRANSIT included, by role). */
  readonly onHandRows: readonly RecallOnHandRow[];
  /** The client's open orders (any warehouse). */
  readonly openOrderIds: readonly string[];
  /** The open orders' order lines holding units of the lots, net. */
  readonly heldLines: readonly RecallHeldLine[];
  /** The facts of every order the held lines and the dispatched figure name. */
  readonly orders: ReadonlyMap<string, OrderTraceFacts>;
  readonly figures: ReadonlyMap<string, RecallLotFigures>;
  readonly adjustedOutByReason: ReadonlyMap<string, Readonly<Record<string, number>>>;
}

export interface RecallFigureSources {
  readonly inventory: InventoryFacade;
  readonly outbound: OutboundFacade;
}

/** Base units held exactly to the milli-unit (float noise never reaches a figure). */
function exact(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The NET held quantity per (order line, batch) of these pick events, clamped at 0. */
export function heldLinesOf(events: readonly OrderPickEvent[]): RecallHeldLine[] {
  const byKey = new Map<string, { orderId: string; orderLineId: string; batchId: string; net: number; last: string }>();
  for (const event of events) {
    const key = `${event.orderLineId}:${event.batchId}`;
    const entry = byKey.get(key) ?? { orderId: event.orderId, orderLineId: event.orderLineId, batchId: event.batchId, net: 0, last: event.recordedAt };
    entry.net += -event.quantity;
    if (event.recordedAt > entry.last) entry.last = event.recordedAt;
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((entry) => ({ orderId: entry.orderId, orderLineId: entry.orderLineId, batchId: entry.batchId, quantity: exact(entry.net), lastPickedAt: entry.last }))
    .filter((line) => line.quantity > 0)
    .sort((a, b) => (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : a.orderLineId < b.orderLineId ? -1 : a.orderLineId > b.orderLineId ? 1 : a.batchId < b.batchId ? -1 : 1));
}

/**
 * The live state of a recall's lots, in the caller's transaction (a
 * REPEATABLE READ one for a read, the command's for a close): every figure
 * and the rows the trace's on-hand and held sections are built from — one
 * snapshot, so each figure equals its section's sum (B19).
 */
export async function recallLiveStateInTx(
  tx: TenantTx,
  sources: RecallFigureSources,
  tenantId: string,
  clientId: string,
  lots: readonly RecallLotRef[],
): Promise<RecallLiveState> {
  const batchIds = lots.map((lot) => lot.batchId);
  const skuIds = [...new Set(lots.map((lot) => lot.skuId))];
  const warehouses = await warehouseCodesOfTenantInTx(tx, tenantId);
  const warehouseIds = [...warehouses.keys()];
  const onHandRows = await sources.inventory.batchOnHandForRecallInTx(tx, tenantId, warehouseIds, skuIds, batchIds);
  const ledger = await sources.inventory.batchLedgerFiguresInTx(tx, tenantId, batchIds);
  const openOrderIds = await sources.outbound.openOrderIdsOfClientInTx(tx, tenantId, clientId, warehouseIds);
  const heldLines = heldLinesOf(await sources.inventory.ledgerPickEventsByOrderRefsInTx(tx, tenantId, openOrderIds, batchIds));
  const pickTotals = await sources.inventory.batchPickTotalsByOrderLineInTx(tx, tenantId, batchIds);
  const orders = await sources.outbound.orderTraceFactsByIdsInTx(tx, tenantId, [
    ...new Set([...heldLines.map((line) => line.orderId), ...pickTotals.map((total) => total.orderId)]),
  ]);

  const figures = new Map<string, RecallLotFigures>();
  const adjustedOutByReason = new Map<string, Readonly<Record<string, number>>>();
  for (const lot of lots) {
    const rows = onHandRows.filter((row) => row.batchId === lot.batchId);
    const onHand = exact(rows.filter((row) => row.role !== IN_TRANSIT_BIN_CODE).reduce((sum, row) => sum + row.quantity, 0));
    const inTransit = exact(rows.filter((row) => row.role === IN_TRANSIT_BIN_CODE).reduce((sum, row) => sum + row.quantity, 0));
    const held = exact(heldLines.filter((line) => line.batchId === lot.batchId).reduce((sum, line) => sum + line.quantity, 0));
    const dispatched = exact(
      pickTotals
        .filter((total) => total.batchId === lot.batchId && orders.get(total.orderId)?.status === 'dispatched')
        .reduce((sum, total) => sum + Math.max(0, total.quantity), 0),
    );
    const l = ledger.get(lot.batchId);
    figures.set(lot.batchId, {
      received: l?.received ?? 0,
      receivedDamaged: l?.receivedDamaged ?? 0,
      onHand,
      inTransit,
      heldInOpenOrders: held,
      dispatched,
      returned: l?.returned ?? 0,
      returnScrapped: l?.returnScrapped ?? 0,
      adjustedOut: l?.adjustedOut ?? 0,
      unaccounted: exact((l?.ledgerOnHand ?? 0) - onHand - inTransit),
    });
    adjustedOutByReason.set(lot.batchId, l?.adjustedOutByReason ?? {});
  }
  return { warehouses, onHandRows, openOrderIds, heldLines, orders, figures, adjustedOutByReason };
}
