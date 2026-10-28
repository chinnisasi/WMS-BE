import { sql, type SQL } from 'drizzle-orm';
import { rearmTxDeadline } from '../../shared/db/tx-deadline';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
import { ORDER_OPEN_STATUSES } from './client-wind-down';

/**
 * Story 3-7a — the outbound reads behind a batch recall's trace, delegated to
 * by `OutboundFacade`. Read-only, in the caller's transaction; every
 * statement re-arms the caller's whole-read deadline first. Quantities leave
 * in base units.
 */

function idsParam(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase()))];
}

/**
 * The ids of one client's OPEN orders (`ORDER_OPEN_STATUSES` — picked or
 * packed units may sit in them) across the named warehouses: the partial
 * `orders_tenant_client_open_idx` (0101), whose predicate the query states
 * verbatim. A8 — the held-order read starts here, never by walking every
 * pick of the lot. Exported statement for its EXPLAIN.
 */
export async function openOrderIdsOfClientInTx(tx: TenantTx, tenantId: string, clientId: string, warehouseIds: readonly string[]): Promise<string[]> {
  const w = idsParam(warehouseIds);
  if (w.length === 0 || !UUID_RE.test(clientId)) return [];
  await rearmTxDeadline(tx);
  const rows = (await tx.execute(openOrdersQuery(tenantId, clientId.toLowerCase(), w))) as unknown as { id: string }[];
  return rows.map((row) => row.id);
}

export function openOrdersQuery(tenantId: string, clientId: string, warehouseIds: readonly string[]): SQL {
  return sql`
    select o.id::text as "id"
    from orders o
    where o.tenant_id = ${tenantId}::uuid and o.client_id = ${clientId}::uuid
      and o.warehouse_id = any(${sql.param([...warehouseIds])}::uuid[])
      and o."status" IN ('accepted','ready_to_dispatch')
    order by o.id
  `;
}

// Pinned: the partial index's literal predicate above is exactly the open-status list.
if (ORDER_OPEN_STATUSES.join(',') !== 'accepted,ready_to_dispatch') {
  throw new Error('recall-trace: ORDER_OPEN_STATUSES changed — widen orders_tenant_client_open_idx and openOrdersQuery together');
}

/** One order's facts as a recall's trace prints them (the 5-3a outbound register's PII set, no contact fields). */
export interface OrderTraceFacts {
  readonly orderId: string;
  readonly warehouseId: string;
  readonly clientId: string;
  readonly status: string;
  /** The one order label (4-1b): the client's order number, else the channel reference, else the id's last eight characters. */
  readonly orderLabel: string;
  readonly clientOrderRef: string | null;
  /** `external_event_id` only on an ingested order (5-3a's rule). */
  readonly channelOrderRef: string | null;
  readonly consigneeLegalName: string | null;
  readonly consigneeGstin: string | null;
  readonly destinationCity: string | null;
  readonly destinationState: string | null;
  readonly destinationPincode: string | null;
  /** The order's LATEST shipment's carrier and tracking number (the dispatch event's own arms win — the caller's rule). */
  readonly shipmentCarrier: string | null;
  readonly shipmentTracking: string | null;
}

/** These orders' trace facts, in ONE statement (a lateral latest shipment, the outbound register's B8 rule). */
export async function orderTraceFactsByIdsInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, OrderTraceFacts>> {
  const o = idsParam(orderIds);
  if (o.length === 0) return new Map();
  await rearmTxDeadline(tx);
  const rows = (await tx.execute(sql`
    select o.id::text as "orderId", o.warehouse_id::text as "warehouseId", o.client_id::text as "clientId", o.status as "status",
           coalesce(o.client_order_ref, o.external_event_id, right(o.id::text, 8)) as "orderLabel",
           o.client_order_ref as "clientOrderRef",
           case when o.source = 'ingested' then o.external_event_id end as "channelOrderRef",
           o.consignee_legal_name as "consigneeLegalName", o.consignee_gstin as "consigneeGstin",
           o.destination_city as "destinationCity", o.destination_state as "destinationState", o.destination_pincode as "destinationPincode",
           sh.carrier_name as "shipmentCarrier", sh.tracking_number as "shipmentTracking"
    from orders o
    left join lateral (
      select s.carrier_name, s.tracking_number from shipments s
      where s.tenant_id = o.tenant_id and s.order_id = o.id
      order by s.labelled_at desc, s.id desc
      limit 1
    ) sh on true
    where o.tenant_id = ${tenantId}::uuid and o.id = any(${sql.param(o)}::uuid[])
  `)) as unknown as OrderTraceFacts[];
  return new Map(rows.map((row) => [row.orderId, row]));
}

/** A planned pick task in a bin that holds a recalled lot (A13 — staff only). */
export interface PlannedRecallBinTask {
  readonly picklistLineId: string;
  readonly orderId: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly skuId: string;
  /** The plan's suggested batch (advisory); null when untracked. */
  readonly plannedBatchId: string | null;
  /** Base units. */
  readonly quantity: number;
}

/**
 * The `planned` pick lines of these (open) orders that point at one of these
 * (bin, SKU) pairs — `picklist_lines_tenant_order_idx`, then the pair filter.
 * Such a task will refuse at the bin (`recalled-lot-in-bin`) until the
 * recalled units are moved out.
 */
export async function plannedTasksInBinsInTx(
  tx: TenantTx,
  tenantId: string,
  orderIds: readonly string[],
  binSkuPairs: readonly { readonly binId: string; readonly skuId: string }[],
): Promise<PlannedRecallBinTask[]> {
  const o = idsParam(orderIds);
  const pairs = binSkuPairs.filter((pair) => UUID_RE.test(pair.binId) && UUID_RE.test(pair.skuId));
  if (o.length === 0 || pairs.length === 0) return [];
  await rearmTxDeadline(tx);
  const rows = (await tx.execute(sql`
    select pl.id::text as "picklistLineId", pl.order_id::text as "orderId", o.warehouse_id::text as "warehouseId",
           pl.bin_id::text as "binId", pl.sku_id::text as "skuId", pl.batch_id::text as "plannedBatchId", pl.qty::text as "quantity"
    from picklist_lines pl
    join orders o on o.tenant_id = pl.tenant_id and o.id = pl.order_id
    where pl.tenant_id = ${tenantId}::uuid and pl.order_id = any(${sql.param(o)}::uuid[])
      and pl.status = 'planned' and pl.bin_id is not null
      and (pl.bin_id, pl.sku_id) in (
        select * from unnest(${sql.param(pairs.map((pair) => pair.binId.toLowerCase()))}::uuid[], ${sql.param(pairs.map((pair) => pair.skuId.toLowerCase()))}::uuid[])
      )
    order by o.warehouse_id, pl.bin_code collate "C", pl.id
  `)) as unknown as (Omit<PlannedRecallBinTask, 'quantity'> & { quantity: string })[];
  return rows.map((row) => ({ ...row, quantity: fromMilli(Number(row.quantity)) }));
}
