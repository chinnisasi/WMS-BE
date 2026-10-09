import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { CursorPayload, Page } from '../../shared/primitives/pagination';
import { portalPageByCreatedAt } from '../../shared/primitives/portal-page';
import { fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant } from '../../shared/primitives/time';
import type { OrderSource, OrderStatus } from './order.command';

/**
 * Story 21-7 — the client portal's order reads. ONE client's orders, never
 * the operator's shape: no integration id, no source hash, no phone or
 * street address, no rate, no reservation or pick state. `orders` is a
 * stamped table, so the predicate is explicit (`o.client_id = $client`);
 * the lines are inherited and reached ONLY through their order. The caller's
 * transaction is stamped `app.client_id` as well (RLS — the second layer).
 */
export interface PortalOrderRow {
  readonly id: string;
  readonly status: OrderStatus;
  readonly source: OrderSource;
  /** The channel's own order reference (`external_event_id`); null for a manual order. */
  readonly externalRef: string | null;
  readonly warehouseName: string;
  readonly destinationName: string | null;
  readonly destinationCity: string | null;
  readonly destinationPincode: string | null;
  /** Top-level lines only — a kit counts once, its components never. */
  readonly lineCount: number;
  readonly createdAt: string;
}

export interface PortalOrderComponent {
  readonly skuCode: string | null;
  readonly skuName: string | null;
  readonly qty: number;
}

export interface PortalOrderLine extends PortalOrderComponent {
  readonly components: readonly PortalOrderComponent[];
}

export interface PortalOrderDetail extends PortalOrderRow {
  readonly lines: readonly PortalOrderLine[];
}

interface OrderHeaderRow {
  id: string;
  status: string;
  source: string;
  externalRef: string | null;
  warehouseName: string;
  destinationName: string | null;
  destinationCity: string | null;
  destinationPincode: string | null;
  lineCount: number;
  createdAt: string;
  createdAtText: string;
}

function headerSelect(tenantId: string): ReturnType<typeof sql> {
  return sql`
    select o.id, o.status, o.source, o.external_event_id as "externalRef",
           w.name as "warehouseName",
           o.destination_contact_name as "destinationName",
           o.destination_city as "destinationCity",
           o.destination_pincode as "destinationPincode",
           (select count(*)::int from order_lines ol
              where ol.tenant_id = o.tenant_id and ol.order_id = o.id and ol.parent_line_id is null) as "lineCount",
           o.created_at as "createdAt",
           o.created_at::text as "createdAtText"
    from orders o
    join warehouses w on w.tenant_id = o.tenant_id and w.id = o.warehouse_id
    where o.tenant_id = ${tenantId}::uuid`;
}

function toRow(row: OrderHeaderRow): PortalOrderRow {
  return {
    id: row.id,
    status: row.status as OrderStatus,
    source: row.source as OrderSource,
    externalRef: row.externalRef,
    warehouseName: row.warehouseName,
    destinationName: row.destinationName,
    destinationCity: row.destinationCity,
    destinationPincode: row.destinationPincode,
    lineCount: Number(row.lineCount),
    createdAt: canonicalInstant(String(row.createdAt)),
  };
}

export async function portalOrdersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  query: { readonly status?: OrderStatus; readonly before: CursorPayload | null; readonly limit: number },
): Promise<Page<PortalOrderRow>> {
  const rows = (await tx.execute(sql`
    ${headerSelect(tenantId)}
      and o.client_id = ${clientId}::uuid
      ${query.status === undefined ? sql`` : sql`and o.status = ${query.status}`}
      ${query.before === null ? sql`` : sql`and (o.created_at, o.id) < (${query.before.createdAt}::timestamptz, ${query.before.id}::uuid)`}
    order by o.created_at desc, o.id desc
    limit ${query.limit + 1}::int
  `)) as unknown as OrderHeaderRow[];
  return portalPageByCreatedAt(rows, query.limit, toRow);
}

/** One order of this client with its lines, or null (an unknown or another client's id → 404). */
export async function portalOrderInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  orderId: string,
): Promise<PortalOrderDetail | null> {
  const headers = (await tx.execute(sql`
    ${headerSelect(tenantId)}
      and o.client_id = ${clientId}::uuid
      and o.id = ${orderId}::uuid
    limit 1
  `)) as unknown as OrderHeaderRow[];
  const header = headers[0];
  if (header === undefined) return null;
  // Lines reach the client ONLY through their (stamped) order; `skus` is
  // LEFT-joined so a line whose SKU is invisible (a client move under RLS)
  // still shows, with a null code, rather than vanishing.
  const lines = (await tx.execute(sql`
    select ol.id, ol.parent_line_id as "parentLineId", ol.qty::bigint as "qtyMilli",
           s.code as "skuCode", s.name as "skuName"
    from order_lines ol
    join orders o on o.tenant_id = ol.tenant_id and o.id = ol.order_id
    left join skus s on s.tenant_id = ol.tenant_id and s.id = ol.sku_id
    where ol.tenant_id = ${tenantId}::uuid
      and o.client_id = ${clientId}::uuid
      and ol.order_id = ${orderId}::uuid
    order by ol.created_at asc, ol.id asc
  `)) as unknown as {
    id: string;
    parentLineId: string | null;
    qtyMilli: string | number;
    skuCode: string | null;
    skuName: string | null;
  }[];
  const components = new Map<string, PortalOrderComponent[]>();
  for (const line of lines) {
    if (line.parentLineId === null) continue;
    const list = components.get(line.parentLineId) ?? [];
    list.push({ skuCode: line.skuCode, skuName: line.skuName, qty: fromMilli(Number(line.qtyMilli)) });
    components.set(line.parentLineId, list);
  }
  return {
    ...toRow(header),
    lines: lines
      .filter((line) => line.parentLineId === null)
      .map((line) => ({
        skuCode: line.skuCode,
        skuName: line.skuName,
        qty: fromMilli(Number(line.qtyMilli)),
        components: components.get(line.id) ?? [],
      })),
  };
}
