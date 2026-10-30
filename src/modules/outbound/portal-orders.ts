import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { CursorPayload, Page } from '../../shared/primitives/pagination';
import { portalPageByCreatedAt } from '../../shared/primitives/portal-page';
import { fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant } from '../../shared/primitives/time';
import type { OrderSource, OrderStatus } from './order.command';
import { orderReferenceMatch } from './order-reference';
import { completeKits } from './follow-on';
import type { OrderPriority, OrderType } from './order-urgency';

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
  /**
   * Story 4-1b — the client's OWN order number (raw; null when none). The web
   * composes the label `clientOrderRef ?? externalRef ?? …`.
   */
  readonly clientOrderRef: string | null;
  /**
   * Story 4-2a — the order header fields (raw). `orderType` is null on an
   * order created before 4-2a; `priority` reads `normal`; `codAmountPaise`
   * null means prepaid. The web composes the chips and the payment line.
   */
  readonly orderType: OrderType | null;
  readonly priority: OrderPriority;
  readonly shipByDate: string | null;
  readonly codAmountPaise: number | null;
  readonly warehouseName: string;
  readonly destinationName: string | null;
  readonly destinationCity: string | null;
  readonly destinationPincode: string | null;
  /** Top-level lines only — a kit counts once, its components never. */
  readonly lineCount: number;
  /**
   * Story 4-2c — the backorder chain, raw (the web composes "Backorder of
   * 1042" and the label `1042-BO1`): this order's parent, the chain's root and
   * its `-BO{seq}` (all null on a root); the follow-on its short dispatch
   * opened (null when none). The ids are this client's own orders.
   */
  readonly followOnOfOrderId: string | null;
  readonly followOnRootOrderId: string | null;
  readonly followOnSeq: number | null;
  readonly followOnOrderId: string | null;
  readonly createdAt: string;
  /** Story 4-4a — the live shipment's AWB and courier; omitted when the order has none. */
  readonly awb?: string;
  readonly courierName?: string;
  /** Story 4-9a (A22) — the order's truck: its LR, transporter and delivery; omitted when it rode none (or is only planned). */
  readonly freight?: {
    readonly lrNumber: string | null;
    readonly transporterName: string;
    readonly deliveredAt: string | null;
    readonly outcome: string | null;
  };
}

export interface PortalOrderComponent {
  readonly skuCode: string | null;
  readonly skuName: string | null;
  readonly qty: number;
  /**
   * Story 4-2c (A14) — what SHIPPED of this line once the order is
   * `dispatched` (Σ its picks; on a kit parent the number of COMPLETE kits),
   * base units; null before dispatch.
   */
  readonly shippedQty: number | null;
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
  clientOrderRef: string | null;
  orderType: string | null;
  priority: string;
  shipByDate: string | null;
  codAmountPaise: string | number | null;
  warehouseName: string;
  destinationName: string | null;
  destinationCity: string | null;
  destinationPincode: string | null;
  lineCount: number;
  followOnOfOrderId: string | null;
  followOnRootOrderId: string | null;
  followOnSeq: number | string | null;
  followOnOrderId: string | null;
  createdAt: string;
  createdAtText: string;
  awb: string | null;
  courierName: string | null;
  freightLr: string | null;
  freightTransporter: string | null;
  freightDeliveredAt: string | null;
  freightOutcome: string | null;
}

function headerSelect(tenantId: string): ReturnType<typeof sql> {
  return sql`
    select o.id, o.status, o.source, o.external_event_id as "externalRef",
           o.client_order_ref as "clientOrderRef",
           o.order_type as "orderType",
           o.priority as "priority",
           o.ship_by_date::text as "shipByDate",
           o.cod_amount_paise as "codAmountPaise",
           w.name as "warehouseName",
           o.destination_contact_name as "destinationName",
           o.destination_city as "destinationCity",
           o.destination_pincode as "destinationPincode",
           (select count(*)::int from order_lines ol
              where ol.tenant_id = o.tenant_id and ol.order_id = o.id and ol.parent_line_id is null) as "lineCount",
           o.follow_on_of_order_id as "followOnOfOrderId",
           o.follow_on_root_order_id as "followOnRootOrderId",
           o.follow_on_seq as "followOnSeq",
           (select fo.id from orders fo
              where fo.tenant_id = o.tenant_id and fo.follow_on_of_order_id = o.id and fo.client_id = o.client_id
              limit 1) as "followOnOrderId",
           o.created_at as "createdAt",
           o.created_at::text as "createdAtText",
           (select s.tracking_number from shipments s
              where s.tenant_id = o.tenant_id and s.order_id = o.id and s.client_id = o.client_id and s.status <> 'voided'
              limit 1) as "awb",
           (select s.carrier_name from shipments s
              where s.tenant_id = o.tenant_id and s.order_id = o.id and s.client_id = o.client_id and s.status <> 'voided'
              limit 1) as "courierName",
           fc.lr_number as "freightLr",
           fc.carriage_snapshot ->> 'transporterName' as "freightTransporter",
           fc.delivered_at::text as "freightDeliveredAt",
           fc.delivery_outcome as "freightOutcome"
    from orders o
    left join freight_consignments fc
      on fc.tenant_id = o.tenant_id and fc.order_id = o.id and fc.client_id = o.client_id and fc.status = 'dispatched'
    join warehouses w on w.tenant_id = o.tenant_id and w.id = o.warehouse_id
    where o.tenant_id = ${tenantId}::uuid`;
}

function toRow(row: OrderHeaderRow): PortalOrderRow {
  return {
    id: row.id,
    status: row.status as OrderStatus,
    source: row.source as OrderSource,
    externalRef: row.externalRef,
    clientOrderRef: row.clientOrderRef,
    orderType: row.orderType as OrderType | null,
    priority: row.priority as OrderPriority,
    shipByDate: row.shipByDate,
    // bigint over raw SQL is a string (IMPLEMENTATION-GUIDE §2).
    codAmountPaise: row.codAmountPaise === null ? null : Number(row.codAmountPaise),
    warehouseName: row.warehouseName,
    destinationName: row.destinationName,
    destinationCity: row.destinationCity,
    destinationPincode: row.destinationPincode,
    lineCount: Number(row.lineCount),
    followOnOfOrderId: row.followOnOfOrderId,
    followOnRootOrderId: row.followOnRootOrderId,
    followOnSeq: row.followOnSeq === null ? null : Number(row.followOnSeq),
    followOnOrderId: row.followOnOrderId,
    createdAt: canonicalInstant(String(row.createdAt)),
    ...(row.awb === null || row.awb === undefined ? {} : { awb: row.awb }),
    ...(row.courierName === null || row.courierName === undefined ? {} : { courierName: row.courierName }),
    ...(row.freightTransporter === null || row.freightTransporter === undefined
      ? {}
      : {
          freight: {
            lrNumber: row.freightLr,
            transporterName: row.freightTransporter,
            deliveredAt: row.freightDeliveredAt === null ? null : canonicalInstant(row.freightDeliveredAt),
            outcome: row.freightOutcome,
          },
        }),
  };
}

export async function portalOrdersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  query: {
    readonly status?: OrderStatus;
    /** Story 4-1b — an exact match on this client's order number (any status) or channel reference. */
    readonly reference?: string;
    readonly before: CursorPayload | null;
    readonly limit: number;
  },
): Promise<Page<PortalOrderRow>> {
  const rows = (await tx.execute(sql`
    ${headerSelect(tenantId)}
      and o.client_id = ${clientId}::uuid
      ${query.status === undefined ? sql`` : sql`and o.status = ${query.status}`}
      ${query.reference === undefined ? sql`` : sql`and ${orderReferenceMatch(sql`o.id`, tenantId, query.reference, clientId)}`}
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
           s.code as "skuCode", s.name as "skuName",
           coalesce((select sum(p.qty) from picks p where p.tenant_id = ol.tenant_id and p.order_line_id = ol.id), 0)::bigint::text as "pickedMilli"
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
    pickedMilli: string;
  }[];
  // A14 — `shippedQty` only once the order is dispatched (null before).
  const dispatched = header.status === 'dispatched';
  const components = new Map<string, PortalOrderComponent[]>();
  const coverage = new Map<string, { qty: number; covered: number }[]>();
  for (const line of lines) {
    if (line.parentLineId === null) continue;
    const list = components.get(line.parentLineId) ?? [];
    list.push({
      skuCode: line.skuCode,
      skuName: line.skuName,
      qty: fromMilli(Number(line.qtyMilli)),
      shippedQty: dispatched ? fromMilli(Number(line.pickedMilli)) : null,
    });
    components.set(line.parentLineId, list);
    const covered = coverage.get(line.parentLineId) ?? [];
    covered.push({ qty: Number(line.qtyMilli), covered: Number(line.pickedMilli) });
    coverage.set(line.parentLineId, covered);
  }
  return {
    ...toRow(header),
    lines: lines
      .filter((line) => line.parentLineId === null)
      .map((line) => {
        const kit = coverage.get(line.id);
        // A kit parent ships COMPLETE kits only (decision 2's `complete`).
        const shippedMilli = kit === undefined ? Number(line.pickedMilli) : completeKits(Number(line.qtyMilli), kit);
        return {
          skuCode: line.skuCode,
          skuName: line.skuName,
          qty: fromMilli(Number(line.qtyMilli)),
          shippedQty: dispatched ? fromMilli(shippedMilli) : null,
          components: components.get(line.id) ?? [],
        };
      }),
  };
}
