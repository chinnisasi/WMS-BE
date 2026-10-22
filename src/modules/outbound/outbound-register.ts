import { sql, type SQL } from 'drizzle-orm';
import { orderOfClient } from '../../shared/db/client-filter';
import { rearmTxDeadline } from '../../shared/db/tx-deadline';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { fromMilli } from '../../shared/primitives/quantity';
import { fullPrecisionInstant } from '../../shared/primitives/time';

/**
 * Story 5-3a — the outbound register's read (one row per order line),
 * delegated to by `OutboundFacade.outboundRegisterInTx`. Read-only, inside
 * the caller's REPEATABLE READ transaction; every statement re-arms the
 * caller's whole-read deadline first.
 *
 * The walk: the warehouse's orders whose `created_at` (received) is in
 * `[from, to)` — and, filtered, whose own `orders.client_id` is the client
 * (decision 6) — on the existing `(tenant_id, [client_id,] warehouse_id,
 * created_at, id)` keyset (full-precision cursor), one page per statement;
 * then that page's lines. A kit's exploded component lines are rows too,
 * each naming its kit line's SKU (`kitOf`), so a reader can tell a component
 * from a top-level line and never sums the two.
 *
 * The shipment is the order's LATEST by `(labelled_at, id)` — a lateral
 * `limit 1`, so a second (manifested, relabelled) shipment row never
 * duplicates a line (design review B8). The dispatch time and its carrier
 * reference are the ledger's (`InventoryFacade.firstDispatchByOrderInTx`),
 * composed by the caller; the shipment's carrier and tracking number are the
 * fallback when the dispatch event named none.
 */

export interface OutboundRegisterScope {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly clientId: string | null;
  /** `[from, to)` on `orders.created_at`, ISO instants. */
  readonly from: string;
  readonly to: string;
}

export interface OutboundRegisterRow {
  readonly orderId: string;
  /** The order's `created_at` (received), ISO. */
  readonly createdAt: string;
  readonly status: string;
  readonly source: string;
  /** `external_event_id` — the channel's order reference, on an ingested order only. */
  readonly channelOrderRef: string | null;
  readonly clientId: string;
  readonly consigneeLegalName: string | null;
  readonly consigneeGstin: string | null;
  readonly destinationCity: string | null;
  readonly destinationState: string | null;
  readonly destinationPincode: string | null;
  readonly lineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  /** The kit line's SKU code, on an exploded component line; null on a top-level line. */
  readonly kitOf: string | null;
  /** Ordered, base units. */
  readonly quantity: number;
  readonly shipmentCarrier: string | null;
  readonly shipmentTracking: string | null;
}

/** Orders per walk statement. */
export const OUTBOUND_REGISTER_PAGE = 1000;

function iso(column: SQL): SQL {
  return sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

export async function outboundRegisterInTx(
  tx: TenantTx,
  scope: OutboundRegisterScope,
  limit: number,
  pageSize: number = OUTBOUND_REGISTER_PAGE,
): Promise<OutboundRegisterRow[]> {
  const out: OutboundRegisterRow[] = [];
  let after: { createdAt: string; id: string } | null = null;
  // The shared 1-5a predicate (`client-filter.ts`): an order's own client.
  const client: SQL = scope.clientId === null ? sql`` : sql` and ${orderOfClient(sql`o.id`, scope.tenantId, scope.clientId)}`;
  while (out.length < limit) {
    await rearmTxDeadline(tx);
    const cursor: SQL = after === null ? sql`` : sql` and (o.created_at, o.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`;
    const orders = (await tx.execute(sql`
      select o.id::text as "id", o.created_at::text as "createdAtText"
      from orders o
      where o.tenant_id = ${scope.tenantId}::uuid${client} and o.warehouse_id = ${scope.warehouseId}::uuid
        and o.created_at >= ${scope.from}::timestamptz and o.created_at < ${scope.to}::timestamptz${cursor}
      order by o.created_at, o.id
      limit ${pageSize}::int
    `)) as unknown as { id: string; createdAtText: string }[];
    if (orders.length === 0) break;

    await rearmTxDeadline(tx);
    const lines = (await tx.execute(sql`
      select o.id::text as "orderId", ${iso(sql`o.created_at`)} as "createdAt", o.status as "status", o.source as "source",
             case when o.source = 'ingested' then o.external_event_id end as "channelOrderRef",
             o.client_id::text as "clientId", o.consignee_legal_name as "consigneeLegalName", o.consignee_gstin as "consigneeGstin",
             o.destination_city as "destinationCity", o.destination_state as "destinationState", o.destination_pincode as "destinationPincode",
             ol.id::text as "lineId", k.id::text as "skuId", k.code as "skuCode", k.name as "skuName", k.uom as "uom",
             pk.code as "kitOf", ol.qty::text as "quantity",
             sh.carrier_name as "shipmentCarrier", sh.tracking_number as "shipmentTracking"
      from order_lines ol
      join orders o on o.tenant_id = ol.tenant_id and o.id = ol.order_id
      join skus k on k.tenant_id = ol.tenant_id and k.id = ol.sku_id
      left join order_lines pl on pl.tenant_id = ol.tenant_id and pl.id = ol.parent_line_id
      left join skus pk on pk.tenant_id = pl.tenant_id and pk.id = pl.sku_id
      left join lateral (
        select s.carrier_name, s.tracking_number from shipments s
        where s.tenant_id = o.tenant_id and s.order_id = o.id
        order by s.labelled_at desc, s.id desc
        limit 1
      ) sh on true
      where ol.tenant_id = ${scope.tenantId}::uuid
        and ol.order_id = any(${sql.param(orders.map((order) => order.id))}::uuid[])
      order by o.created_at, o.id, ol.created_at, ol.id
      limit ${limit - out.length + 1}::int
    `)) as unknown as (Omit<OutboundRegisterRow, 'quantity'> & { quantity: string })[];
    for (const row of lines) {
      if (out.length >= limit) break;
      out.push({ ...row, quantity: fromMilli(Number(row.quantity)) });
    }
    if (orders.length < pageSize) break;
    const last = orders.at(-1)!;
    after = { createdAt: fullPrecisionInstant(last.createdAtText), id: last.id };
  }
  return out;
}
