import { sql, type SQL } from 'drizzle-orm';
import { rearmTxDeadline } from '../../shared/db/tx-deadline';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
import { ON_HAND_FOLD_TERM } from './client-metering';
import type { LedgerReferenceDoc } from './ledger-registry';

/**
 * Story 3-7a — the inventory reads behind a batch recall's figures and trace
 * (`recalls/recall-figures.ts`, `reporting/recall-trace.ts`), delegated to by
 * `InventoryFacade`. Read-only, in the caller's transaction; every statement
 * re-arms the caller's whole-read deadline first (`rearmTxDeadline` — a
 * no-op for a caller with none). Quantities leave in BASE units; ids as text.
 *
 * Every per-batch ledger read rides `ledger_events_tenant_batch_ref_seq_idx`
 * (0010): `tenant_id = $t AND batch_ref = any($batches)`. The order-ref reads
 * state `reference_doc ? 'orderId'` beside the `->>` equality so the planner
 * can use 0039's PARTIAL `ledger_events_order_ref_idx` (guide §9).
 */

/** The exact text[] of distinct, well-formed, lower-cased ids (bound as ONE parameter). */
function idsParam(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase()))];
}

function iso(column: SQL): SQL {
  return sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

// ── where the lot sits ───────────────────────────────────────────────────────

/** A bin's place in the trace: a storage bin, or the system bin's own code (RECEIVING, QC-HOLD, DAMAGED, RETURNS, IN-TRANSIT). */
export type RecallLocationRole = string;

export interface RecallOnHandRow {
  readonly warehouseId: string;
  readonly binId: string;
  readonly binCode: string;
  /** `storage`, or the system bin's code — `IN-TRANSIT` is the in-transit figure, never on hand. */
  readonly role: RecallLocationRole;
  readonly skuId: string;
  readonly batchId: string;
  /** Base units, > 0. */
  readonly quantity: number;
}

/**
 * Every positive `batch_on_hand` row of these batches, across the tenant's
 * warehouses. ONE statement on the `(tenant_id, warehouse_id, sku_id)` index
 * (0010 — the warehouses and SKUs are named explicitly; A8), joined to its bin
 * for the code and the system role. Ordered warehouse, role (storage first),
 * bin code, batch. The statement is exported for its EXPLAIN.
 */
export async function batchOnHandForRecallInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseIds: readonly string[],
  skuIds: readonly string[],
  batchIds: readonly string[],
): Promise<RecallOnHandRow[]> {
  const w = idsParam(warehouseIds);
  const s = idsParam(skuIds);
  const b = idsParam(batchIds);
  if (w.length === 0 || s.length === 0 || b.length === 0) return [];
  await rearmTxDeadline(tx);
  const rows = (await tx.execute(recallOnHandQuery(tenantId, w, s, b))) as unknown as (Omit<RecallOnHandRow, 'quantity'> & { quantity: string })[];
  return rows.map((row) => ({ ...row, quantity: fromMilli(Number(row.quantity)) }));
}

export function recallOnHandQuery(tenantId: string, warehouseIds: readonly string[], skuIds: readonly string[], batchIds: readonly string[]): SQL {
  return sql`
    select bo.warehouse_id::text as "warehouseId", bo.bin_id::text as "binId", bi.code as "binCode",
           case when bi.system_owned then bi.code else 'storage' end as "role",
           bo.sku_id::text as "skuId", bo.batch_id::text as "batchId", bo.quantity::text as "quantity"
    from batch_on_hand bo
    join bins bi on bi.tenant_id = bo.tenant_id and bi.id = bo.bin_id and bi.warehouse_id = bo.warehouse_id
    where bo.tenant_id = ${tenantId}::uuid
      and bo.warehouse_id = any(${sql.param([...warehouseIds])}::uuid[])
      and bo.sku_id = any(${sql.param([...skuIds])}::uuid[])
      and bo.batch_id = any(${sql.param([...batchIds])}::uuid[])
      and bo.quantity > 0
    order by bo.warehouse_id, bi.system_owned, bi.code collate "C", bo.batch_id
  `;
}

// ── the ledger figures of a batch ────────────────────────────────────────────

export interface BatchLedgerFigures {
  readonly batchId: string;
  /** Σ `grn.received` (base units). */
  readonly received: number;
  /** Σ `grn.damaged`. */
  readonly receivedDamaged: number;
  /** Σ `return.received`. */
  readonly returned: number;
  /** Σ |δ| `return.scrapped` (4-7a — a returned unit of the lot scrapped out of RETURNS). */
  readonly returnScrapped: number;
  /** Σ |δ| of NEGATIVE `stock.adjusted`. */
  readonly adjustedOut: number;
  /** The same, grouped by the adjustment's `reasonCode`. */
  readonly adjustedOutByReason: Readonly<Record<string, number>>;
  /** Σ `ON_HAND_FOLD_TERM` over EVERY event of the batch — what the projection should hold. */
  readonly ledgerOnHand: number;
}

/**
 * ONE grouped statement over every event of these batches (the batch-ref
 * index): the receipt, damage, return, scrap and write-off sums, the
 * write-offs per reason code, and the whole-history fold (the metering
 * fold's term — `client-metering.ts`, never a copy). A batch with no event
 * answers zeros.
 */
export async function batchLedgerFiguresInTx(tx: TenantTx, tenantId: string, batchIds: readonly string[]): Promise<Map<string, BatchLedgerFigures>> {
  const b = idsParam(batchIds);
  const out = new Map<string, BatchLedgerFigures>();
  if (b.length === 0) return out;
  await rearmTxDeadline(tx);
  const rows = (await tx.execute(sql`
    select le.batch_ref as "batchId", le.type as "type",
           case when le.type = 'stock.adjusted' then le.reference_doc ->> 'reasonCode' end as "reasonCode",
           -- A write-off's magnitude; an intake adjustment contributes 0.
           sum(case when le.type = 'stock.adjusted' then greatest(-le.quantity_delta, 0::bigint) else abs(le.quantity_delta) end)::text as "magnitude",
           sum(${ON_HAND_FOLD_TERM})::text as "fold"
    from ledger_events le
    where le.tenant_id = ${tenantId}::uuid and le.batch_ref = any(${sql.param(b)}::text[])
    group by 1, 2, 3
  `)) as unknown as { batchId: string; type: string; reasonCode: string | null; magnitude: string; fold: string }[];
  const acc = new Map<string, { received: number; receivedDamaged: number; returned: number; returnScrapped: number; adjustedOut: number; byReason: Map<string, number>; fold: number }>();
  for (const id of b) acc.set(id, { received: 0, receivedDamaged: 0, returned: 0, returnScrapped: 0, adjustedOut: 0, byReason: new Map(), fold: 0 });
  for (const row of rows) {
    const a = acc.get(row.batchId);
    if (a === undefined) continue;
    const magnitude = Number(row.magnitude);
    a.fold += Number(row.fold);
    switch (row.type) {
      case 'grn.received':
        a.received += magnitude;
        break;
      case 'grn.damaged':
        a.receivedDamaged += magnitude;
        break;
      case 'return.received':
        a.returned += magnitude;
        break;
      case 'return.scrapped':
        a.returnScrapped += magnitude;
        break;
      case 'stock.adjusted':
        if (magnitude > 0) {
          const reason = row.reasonCode ?? 'unknown';
          a.adjustedOut += magnitude;
          a.byReason.set(reason, (a.byReason.get(reason) ?? 0) + magnitude);
        }
        break;
      default:
        break;
    }
  }
  for (const [id, a] of acc) {
    out.set(id, {
      batchId: id,
      received: fromMilli(a.received),
      receivedDamaged: fromMilli(a.receivedDamaged),
      returned: fromMilli(a.returned),
      returnScrapped: fromMilli(a.returnScrapped),
      adjustedOut: fromMilli(a.adjustedOut),
      adjustedOutByReason: Object.fromEntries([...a.byReason].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => [k, fromMilli(v)])),
      ledgerOnHand: fromMilli(a.fold),
    });
  }
  return out;
}

// ── the trace's event pages ──────────────────────────────────────────────────

export interface BatchTraceEvent {
  readonly id: string;
  readonly warehouseId: string;
  readonly seq: number;
  readonly type: string;
  readonly skuId: string;
  readonly batchId: string;
  /** SIGNED base units. */
  readonly quantity: number;
  readonly fromBinId: string | null;
  readonly toBinId: string | null;
  readonly recordedAt: string;
  readonly occurredAt: string;
  readonly referenceDoc: LedgerReferenceDoc;
}

/** The keyset of a batch's event walk: `(seq, warehouse_id)` — seq is per warehouse, the warehouse breaks its ties. */
export interface BatchTraceCursor {
  readonly seq: number;
  readonly warehouseId: string;
}

/**
 * One page of ONE batch's events of the given types, in `(seq, warehouse_id)`
 * order after the cursor — the batch-ref index walked in seq order with the
 * type as a filter. A page of `limit` rows (the CSV stream's internal page,
 * the detail's paged lists).
 */
export async function batchTraceEventsPageInTx(
  tx: TenantTx,
  tenantId: string,
  batchId: string,
  types: readonly string[],
  after: BatchTraceCursor | null,
  limit: number,
): Promise<BatchTraceEvent[]> {
  if (!UUID_RE.test(batchId) || types.length === 0) return [];
  await rearmTxDeadline(tx);
  const cursor: SQL = after === null ? sql`` : sql` and (le.seq, le.warehouse_id) > (${after.seq}::int, ${after.warehouseId}::uuid)`;
  const rows = (await tx.execute(sql`
    select le.id::text as "id", le.warehouse_id::text as "warehouseId", le.seq as "seq", le.type as "type",
           le.sku_id::text as "skuId", le.batch_ref as "batchId", le.quantity_delta::text as "quantity",
           le.from_bin_id::text as "fromBinId", le.to_bin_id::text as "toBinId",
           ${iso(sql`le.recorded_at`)} as "recordedAt", ${iso(sql`le.occurred_at`)} as "occurredAt",
           le.reference_doc as "referenceDoc"
    from ledger_events le
    where le.tenant_id = ${tenantId}::uuid and le.batch_ref = ${batchId.toLowerCase()}
      and le.type = any(${sql.param([...types])}::text[])${cursor}
    order by le.seq, le.warehouse_id
    limit ${limit}::int
  `)) as unknown as (Omit<BatchTraceEvent, 'quantity' | 'seq' | 'referenceDoc'> & { quantity: string; seq: number | string; referenceDoc: unknown })[];
  return rows.map((row) => ({
    ...row,
    seq: Number(row.seq),
    quantity: fromMilli(Number(row.quantity)),
    referenceDoc: (typeof row.referenceDoc === 'string' ? JSON.parse(row.referenceDoc) : row.referenceDoc) as LedgerReferenceDoc,
  }));
}

// ── picks of orders ──────────────────────────────────────────────────────────

/**
 * Story 3-7a (A7) — the ledger types whose SIGNED sum is a batch's net pick
 * quantity on an order line. On this base exactly `pick.picked`: no
 * registered type reverses a pick (pack and dispatch carry the order line but
 * move nothing and close the batch arm). `test/architecture.spec.ts` fails
 * when a registered type that carries an order line with the batch arm OPEN
 * is missing here — the packed-order cancel/unpack (deferred from 4.2) must
 * join it.
 */
export const PICK_NETTING_TYPES = ['pick.picked'] as const;

export interface BatchOrderPickTotal {
  readonly batchId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  /** NET base units drawn (positive — the signed sum, negated). */
  readonly quantity: number;
}

/**
 * Every order line's NET pick quantity of these batches — ONE grouped
 * statement on the batch-ref index (`PICK_NETTING_TYPES`), so the caller
 * reads one row per (batch, order line), never one per slice. The
 * `dispatched` figure is its rows whose order dispatched.
 */
export async function batchPickTotalsByOrderLineInTx(tx: TenantTx, tenantId: string, batchIds: readonly string[]): Promise<BatchOrderPickTotal[]> {
  const b = idsParam(batchIds);
  if (b.length === 0) return [];
  await rearmTxDeadline(tx);
  const rows = (await tx.execute(sql`
    select le.batch_ref as "batchId", le.reference_doc ->> 'orderId' as "orderId", le.reference_doc ->> 'orderLineId' as "orderLineId",
           (-sum(le.quantity_delta))::text as "quantity"
    from ledger_events le
    where le.tenant_id = ${tenantId}::uuid and le.batch_ref = any(${sql.param(b)}::text[])
      and le.type = any(${sql.param([...PICK_NETTING_TYPES])}::text[])
    group by 1, 2, 3
    order by 1, 2, 3
  `)) as unknown as (Omit<BatchOrderPickTotal, 'quantity'> & { quantity: string })[];
  return rows.map((row) => ({ ...row, quantity: fromMilli(Number(row.quantity)) }));
}

export interface OrderPickEvent {
  readonly id: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly batchId: string;
  /** SIGNED base units (a draw is negative). */
  readonly quantity: number;
  readonly recordedAt: string;
}

/**
 * The `pick.picked` events of these ORDERS that carry one of these batches —
 * ONE statement, the set-valued sibling of `ledgerEventsByOrderRefInTx`
 * (A8): its order-ref qual (`reference_doc ? 'orderId'`, the 0039 partial
 * index), `->> 'orderId' = any($)`, the type and `batch_ref = any($)`.
 * Exported statement for its EXPLAIN.
 */
export async function ledgerPickEventsByOrderRefsInTx(
  tx: TenantTx,
  tenantId: string,
  orderIds: readonly string[],
  batchIds: readonly string[],
): Promise<OrderPickEvent[]> {
  const o = idsParam(orderIds);
  const b = idsParam(batchIds);
  if (o.length === 0 || b.length === 0) return [];
  await rearmTxDeadline(tx);
  const rows = (await tx.execute(orderPickEventsQuery(tenantId, o, b))) as unknown as (Omit<OrderPickEvent, 'quantity'> & { quantity: string })[];
  return rows.map((row) => ({ ...row, quantity: fromMilli(Number(row.quantity)) }));
}

export function orderPickEventsQuery(tenantId: string, orderIds: readonly string[], batchIds: readonly string[]): SQL {
  return sql`
    select le.id::text as "id", le.reference_doc ->> 'orderId' as "orderId", le.reference_doc ->> 'orderLineId' as "orderLineId",
           le.warehouse_id::text as "warehouseId", le.sku_id::text as "skuId", le.batch_ref as "batchId",
           le.quantity_delta::text as "quantity", ${iso(sql`le.recorded_at`)} as "recordedAt"
    from ledger_events le
    where le.reference_doc ? 'orderId'
      and (le.reference_doc ->> 'orderId') = any(${sql.param([...orderIds])}::text[])
      and le.tenant_id = ${tenantId}::uuid
      and le.type = any(${sql.param([...PICK_NETTING_TYPES])}::text[])
      and le.batch_ref = any(${sql.param([...batchIds])}::text[])
    order by le.reference_doc ->> 'orderId', le.id
  `;
}

/**
 * The distinct batches ONE order's picks drew (A3 — the dispatch guard locks
 * every one). The same order-ref qual; `batch_ref is not null` (an untracked
 * or serial draw carries none).
 */
export async function pickedBatchRefsOfOrderInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<string[]> {
  if (!UUID_RE.test(orderId)) return [];
  const rows = (await tx.execute(pickedBatchRefsQuery(tenantId, orderId.toLowerCase()))) as unknown as { batchId: string }[];
  return rows.map((row) => row.batchId);
}

export function pickedBatchRefsQuery(tenantId: string, orderId: string): SQL {
  return sql`
    select distinct le.batch_ref as "batchId"
    from ledger_events le
    where le.reference_doc ? 'orderId'
      and (le.reference_doc ->> 'orderId') = ${orderId}
      and le.tenant_id = ${tenantId}::uuid
      and le.type = 'pick.picked'
      and le.batch_ref is not null
    order by 1
  `;
}
