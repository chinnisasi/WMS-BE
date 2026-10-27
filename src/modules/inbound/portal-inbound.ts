import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { CursorPayload, Page } from '../../shared/primitives/pagination';
import { portalPageByCreatedAt } from '../../shared/primitives/portal-page';
import { fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant } from '../../shared/primitives/time';
import type { AsnStatus } from './asn.command';
import type { PoStatus } from './po.command';
import { listByParentInTx } from '../attachments/attachment-records';

/**
 * Story 21-7 — the client portal's inbound reads: ONE client's advance
 * shipment notices and purchase orders. No vendor, no unit cost, no status
 * note (operator-written), no warehouse code, no carried-from link. Both
 * headers are stamped tables (explicit `client_id = $client`); their lines
 * are inherited and reached ONLY through their header. The caller's
 * transaction is stamped `app.client_id` too (RLS — the second layer).
 * Quantities are base units (`fromMilli`); the totals sum across UoMs and
 * are indicative only, exactly like the operator list's.
 */
export interface PortalAsnRow {
  readonly id: string;
  readonly code: string;
  readonly status: AsnStatus;
  readonly expectedAt: string | null;
  readonly warehouseName: string;
  readonly lineCount: number;
  readonly announcedTotal: number;
  readonly receivedTotal: number;
  readonly createdAt: string;
}

export interface PortalAsnLine {
  readonly skuCode: string | null;
  readonly skuName: string | null;
  readonly announcedQty: number;
  readonly receivedQty: number;
}

export interface PortalAsnDetail extends PortalAsnRow {
  readonly lines: readonly PortalAsnLine[];
}

export interface PortalPurchaseOrderRow {
  readonly id: string;
  readonly code: string;
  readonly status: PoStatus;
  readonly warehouseName: string;
  readonly lineCount: number;
  readonly orderedTotal: number;
  readonly receivedTotal: number;
  readonly createdAt: string;
}

export interface PortalPurchaseOrderLine {
  readonly skuCode: string | null;
  readonly skuName: string | null;
  readonly orderedQty: number;
  readonly receivedQty: number;
  readonly expectedDate: string | null;
}

export interface PortalPurchaseOrderDetail extends PortalPurchaseOrderRow {
  readonly lines: readonly PortalPurchaseOrderLine[];
}

interface ListQuery<S> {
  readonly status?: S;
  readonly before: CursorPayload | null;
  readonly limit: number;
}

// ── advance shipment notices ────────────────────────────────────────────────

interface AsnHeaderRow {
  id: string;
  code: string;
  status: string;
  expectedAt: string | null;
  warehouseName: string;
  lineCount: number;
  announcedMilli: string | number;
  receivedMilli: string | number;
  createdAt: string;
  createdAtText: string;
}

function asnHeaderSelect(tenantId: string, clientId: string): ReturnType<typeof sql> {
  return sql`
    select a.id, a.asn_code as "code", a.status, a.expected_at as "expectedAt",
           w.name as "warehouseName",
           coalesce(t.line_count, 0)::int as "lineCount",
           coalesce(t.announced, 0)::bigint as "announcedMilli",
           coalesce(t.received, 0)::bigint as "receivedMilli",
           a.created_at as "createdAt",
           a.created_at::text as "createdAtText"
    from advance_shipment_notices a
    join warehouses w on w.tenant_id = a.tenant_id and w.id = a.warehouse_id
    left join lateral (
      select count(*) as line_count, sum(al.announced_qty) as announced, sum(al.received_qty) as received
      from asn_lines al
      where al.tenant_id = a.tenant_id and al.asn_id = a.id
    ) t on true
    where a.tenant_id = ${tenantId}::uuid
      and a.client_id = ${clientId}::uuid`;
}

function toAsnRow(row: AsnHeaderRow): PortalAsnRow {
  return {
    id: row.id,
    code: row.code,
    status: row.status as AsnStatus,
    expectedAt: row.expectedAt === null ? null : canonicalInstant(String(row.expectedAt)),
    warehouseName: row.warehouseName,
    lineCount: Number(row.lineCount),
    announcedTotal: fromMilli(Number(row.announcedMilli)),
    receivedTotal: fromMilli(Number(row.receivedMilli)),
    createdAt: canonicalInstant(String(row.createdAt)),
  };
}

export async function portalAsnsInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  query: ListQuery<AsnStatus>,
): Promise<Page<PortalAsnRow>> {
  const rows = (await tx.execute(sql`
    ${asnHeaderSelect(tenantId, clientId)}
      ${query.status === undefined ? sql`` : sql`and a.status = ${query.status}`}
      ${query.before === null ? sql`` : sql`and (a.created_at, a.id) < (${query.before.createdAt}::timestamptz, ${query.before.id}::uuid)`}
    order by a.created_at desc, a.id desc
    limit ${query.limit + 1}::int
  `)) as unknown as AsnHeaderRow[];
  return portalPageByCreatedAt(rows, query.limit, toAsnRow);
}

export async function portalAsnInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  asnId: string,
): Promise<PortalAsnDetail | null> {
  const headers = (await tx.execute(sql`
    ${asnHeaderSelect(tenantId, clientId)}
      and a.id = ${asnId}::uuid
    limit 1
  `)) as unknown as AsnHeaderRow[];
  const header = headers[0];
  if (header === undefined) return null;
  const lines = (await tx.execute(sql`
    select s.code as "skuCode", s.name as "skuName",
           al.announced_qty::bigint as "announcedMilli", al.received_qty::bigint as "receivedMilli"
    from asn_lines al
    join advance_shipment_notices a on a.tenant_id = al.tenant_id and a.id = al.asn_id
    left join skus s on s.tenant_id = al.tenant_id and s.id = al.sku_id
    where al.tenant_id = ${tenantId}::uuid
      and a.client_id = ${clientId}::uuid
      and al.asn_id = ${asnId}::uuid
    order by al.created_at asc, al.id asc
  `)) as unknown as { skuCode: string | null; skuName: string | null; announcedMilli: string | number; receivedMilli: string | number }[];
  return {
    ...toAsnRow(header),
    lines: lines.map((line) => ({
      skuCode: line.skuCode,
      skuName: line.skuName,
      announcedQty: fromMilli(Number(line.announcedMilli)),
      receivedQty: fromMilli(Number(line.receivedMilli)),
    })),
  };
}

// ── purchase orders ─────────────────────────────────────────────────────────

interface PoHeaderRow {
  id: string;
  code: string;
  status: string;
  warehouseName: string;
  lineCount: number;
  orderedMilli: string | number;
  receivedMilli: string | number;
  createdAt: string;
  createdAtText: string;
}

function poHeaderSelect(tenantId: string, clientId: string): ReturnType<typeof sql> {
  return sql`
    select p.id, p.code, p.status,
           w.name as "warehouseName",
           coalesce(t.line_count, 0)::int as "lineCount",
           coalesce(t.ordered, 0)::bigint as "orderedMilli",
           coalesce(t.received, 0)::bigint as "receivedMilli",
           p.created_at as "createdAt",
           p.created_at::text as "createdAtText"
    from purchase_orders p
    join warehouses w on w.tenant_id = p.tenant_id and w.id = p.warehouse_id
    left join lateral (
      select count(*) as line_count, sum(pl.ordered_qty) as ordered, sum(pl.received_qty) as received
      from purchase_order_lines pl
      where pl.tenant_id = p.tenant_id and pl.po_id = p.id
    ) t on true
    where p.tenant_id = ${tenantId}::uuid
      and p.client_id = ${clientId}::uuid`;
}

function toPoRow(row: PoHeaderRow): PortalPurchaseOrderRow {
  return {
    id: row.id,
    code: row.code,
    status: row.status as PoStatus,
    warehouseName: row.warehouseName,
    lineCount: Number(row.lineCount),
    orderedTotal: fromMilli(Number(row.orderedMilli)),
    receivedTotal: fromMilli(Number(row.receivedMilli)),
    createdAt: canonicalInstant(String(row.createdAt)),
  };
}

export async function portalPurchaseOrdersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  query: ListQuery<PoStatus>,
): Promise<Page<PortalPurchaseOrderRow>> {
  const rows = (await tx.execute(sql`
    ${poHeaderSelect(tenantId, clientId)}
      ${query.status === undefined ? sql`` : sql`and p.status = ${query.status}`}
      ${query.before === null ? sql`` : sql`and (p.created_at, p.id) < (${query.before.createdAt}::timestamptz, ${query.before.id}::uuid)`}
    order by p.created_at desc, p.id desc
    limit ${query.limit + 1}::int
  `)) as unknown as PoHeaderRow[];
  return portalPageByCreatedAt(rows, query.limit, toPoRow);
}

export async function portalPurchaseOrderInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  poId: string,
): Promise<PortalPurchaseOrderDetail | null> {
  const headers = (await tx.execute(sql`
    ${poHeaderSelect(tenantId, clientId)}
      and p.id = ${poId}::uuid
    limit 1
  `)) as unknown as PoHeaderRow[];
  const header = headers[0];
  if (header === undefined) return null;
  const lines = (await tx.execute(sql`
    select s.code as "skuCode", s.name as "skuName",
           pl.ordered_qty::bigint as "orderedMilli", pl.received_qty::bigint as "receivedMilli",
           pl.expected_date as "expectedDate"
    from purchase_order_lines pl
    join purchase_orders p on p.tenant_id = pl.tenant_id and p.id = pl.po_id
    left join skus s on s.tenant_id = pl.tenant_id and s.id = pl.sku_id
    where pl.tenant_id = ${tenantId}::uuid
      and p.client_id = ${clientId}::uuid
      and pl.po_id = ${poId}::uuid
    order by pl.created_at asc, pl.id asc
  `)) as unknown as {
    skuCode: string | null;
    skuName: string | null;
    orderedMilli: string | number;
    receivedMilli: string | number;
    expectedDate: string | null;
  }[];
  return {
    ...toPoRow(header),
    lines: lines.map((line) => ({
      skuCode: line.skuCode,
      skuName: line.skuName,
      orderedQty: fromMilli(Number(line.orderedMilli)),
      receivedQty: fromMilli(Number(line.receivedMilli)),
      expectedDate: line.expectedDate === null ? null : canonicalInstant(String(line.expectedDate)),
    })),
  };
}

// ── story 2-5a: goods receipts (the minimal read roadmap 2.9 extends) ──────

export interface PortalGoodsReceiptRow {
  readonly id: string;
  readonly code: string;
  readonly warehouseName: string;
  readonly poCode: string | null;
  readonly asnCode: string | null;
  readonly lineCount: number;
  readonly receivedTotal: number;
  readonly damagedTotal: number;
  readonly shortTotal: number;
  readonly photoCount: number;
  readonly receivedAt: string;
  readonly createdAt: string;
}

/** One photo row the portal may see — an `attached` one, or a removed placeholder (A4: no reason, no remover). */
export interface PortalReceiptPhotoRow {
  readonly id: string;
  readonly grnLineId: string;
  readonly status: 'attached' | 'removed';
  readonly objectKey: string | null;
  readonly contentType: string | null;
  readonly purgedAt: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly capturedAt: string | null;
  readonly createdAt: string;
}

export interface PortalGoodsReceiptLineRow {
  readonly id: string;
  readonly lineNo: number;
  readonly skuCode: string;
  readonly skuName: string;
  readonly qty: number;
  readonly damagedQty: number;
  readonly damageReasonCode: string | null;
  readonly shortQty: number;
  readonly shortReasonCode: string | null;
}

export interface PortalGoodsReceiptRead extends PortalGoodsReceiptRow {
  readonly lines: readonly PortalGoodsReceiptLineRow[];
  readonly photos: readonly PortalReceiptPhotoRow[];
}

interface GrnHeaderRow {
  id: string;
  code: string;
  warehouseName: string;
  poCode: string | null;
  asnCode: string | null;
  lineCount: number;
  qtyMilli: string | number;
  damagedMilli: string | number;
  shortMilli: string | number;
  photoCount: number;
  occurredAt: string;
  createdAt: string;
  createdAtText: string;
}

/**
 * Two layers (guide §7e): the caller's transaction is client-stamped, AND —
 * because `goods_receipt_notes` RLS is tenant-only (0013) — every query
 * carries `g.client_id = $client` on the header, reaches the lines ONLY
 * through an inner join to `skus` carrying the same predicate, and the
 * photos with `client_id = $client` on `attachments`. A null-client (legacy
 * unattributed) receipt never matches: the same 404 as an unknown id.
 */
function grnHeaderSelect(tenantId: string, clientId: string): ReturnType<typeof sql> {
  return sql`
    select g.id, g.code, w.name as "warehouseName",
           p.code as "poCode", a.asn_code as "asnCode",
           coalesce(t.line_count, 0)::int as "lineCount",
           coalesce(t.qty, 0)::bigint as "qtyMilli",
           coalesce(t.damaged, 0)::bigint as "damagedMilli",
           coalesce(t.short, 0)::bigint as "shortMilli",
           coalesce(ph.n, 0)::int as "photoCount",
           g.occurred_at as "occurredAt",
           g.created_at as "createdAt",
           g.created_at::text as "createdAtText"
    from goods_receipt_notes g
    join warehouses w on w.tenant_id = g.tenant_id and w.id = g.warehouse_id
    left join purchase_orders p on p.tenant_id = g.tenant_id and p.id = g.po_id and p.client_id = ${clientId}::uuid
    left join advance_shipment_notices a on a.tenant_id = g.tenant_id and a.id = g.asn_id and a.client_id = ${clientId}::uuid
    left join lateral (
      select count(*) as line_count, sum(l.qty) as qty, sum(l.damaged_qty) as damaged, sum(l.short_qty) as short
      from goods_receipt_lines l
      join skus s on s.tenant_id = l.tenant_id and s.id = l.sku_id and s.client_id = ${clientId}::uuid
      where l.tenant_id = g.tenant_id and l.grn_id = g.id
    ) t on true
    left join lateral (
      select count(*) as n
      from attachments x
      where x.tenant_id = g.tenant_id and x.owner_parent_id = g.id
        and x.client_id = ${clientId}::uuid and x.status = 'attached'
    ) ph on true
    where g.tenant_id = ${tenantId}::uuid
      and g.client_id = ${clientId}::uuid`;
}

function toGrnRow(row: GrnHeaderRow): PortalGoodsReceiptRow {
  return {
    id: row.id,
    code: row.code,
    warehouseName: row.warehouseName,
    poCode: row.poCode,
    asnCode: row.asnCode,
    lineCount: Number(row.lineCount),
    receivedTotal: fromMilli(Number(row.qtyMilli)),
    damagedTotal: fromMilli(Number(row.damagedMilli)),
    shortTotal: fromMilli(Number(row.shortMilli)),
    photoCount: Number(row.photoCount),
    receivedAt: canonicalInstant(String(row.occurredAt)),
    createdAt: canonicalInstant(String(row.createdAt)),
  };
}

export async function portalGoodsReceiptsInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  query: { readonly before: CursorPayload | null; readonly limit: number },
): Promise<Page<PortalGoodsReceiptRow>> {
  const rows = (await tx.execute(sql`
    ${grnHeaderSelect(tenantId, clientId)}
      ${query.before === null ? sql`` : sql`and (g.created_at, g.id) < (${query.before.createdAt}::timestamptz, ${query.before.id}::uuid)`}
    order by g.created_at desc, g.id desc
    limit ${query.limit + 1}::int
  `)) as unknown as GrnHeaderRow[];
  return portalPageByCreatedAt(rows, query.limit, toGrnRow);
}

export async function portalGoodsReceiptInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  grnId: string,
): Promise<PortalGoodsReceiptRead | null> {
  const headers = (await tx.execute(sql`
    ${grnHeaderSelect(tenantId, clientId)}
      and g.id = ${grnId}::uuid
    limit 1
  `)) as unknown as GrnHeaderRow[];
  const header = headers[0];
  if (header === undefined) return null;
  const lines = (await tx.execute(sql`
    select l.id, s.code as "skuCode", s.name as "skuName",
           l.qty::bigint as "qtyMilli", l.damaged_qty::bigint as "damagedMilli", l.damage_reason_code as "damageReasonCode",
           l.short_qty::bigint as "shortMilli", l.short_reason_code as "shortReasonCode"
    from goods_receipt_lines l
    join goods_receipt_notes g on g.tenant_id = l.tenant_id and g.id = l.grn_id
    join skus s on s.tenant_id = l.tenant_id and s.id = l.sku_id and s.client_id = ${clientId}::uuid
    where l.tenant_id = ${tenantId}::uuid
      and g.client_id = ${clientId}::uuid
      and l.grn_id = ${grnId}::uuid
    order by l.created_at asc, l.id asc
  `)) as unknown as {
    id: string;
    skuCode: string;
    skuName: string;
    qtyMilli: string | number;
    damagedMilli: string | number;
    damageReasonCode: string | null;
    shortMilli: string | number;
    shortReasonCode: string | null;
  }[];
  const rows = await listByParentInTx(tx, { tenantId, grnId, clientId });
  const photos: PortalReceiptPhotoRow[] = rows
    // Attached photos, and removed ones that once held bytes (a cancelled
    // placeholder was never a photo); never awaited or expired.
    .filter((row) => row.status === 'attached' || (row.status === 'removed' && row.sha256 !== null))
    .map((row) => ({
      id: row.id,
      grnLineId: row.ownerId!,
      status: row.status as 'attached' | 'removed',
      objectKey: row.status === 'attached' ? row.objectKey : null,
      contentType: row.contentType,
      purgedAt: row.purgedAt,
      width: row.width,
      height: row.height,
      capturedAt: row.capturedAt === null ? null : canonicalInstant(row.capturedAt),
      createdAt: row.createdAt,
    }));
  return {
    ...toGrnRow(header),
    lines: lines.map((line, index) => ({
      id: line.id,
      lineNo: index + 1,
      skuCode: line.skuCode,
      skuName: line.skuName,
      qty: fromMilli(Number(line.qtyMilli)),
      damagedQty: fromMilli(Number(line.damagedMilli)),
      damageReasonCode: Number(line.damagedMilli) > 0 ? line.damageReasonCode : null,
      shortQty: fromMilli(Number(line.shortMilli)),
      shortReasonCode: Number(line.shortMilli) > 0 ? line.shortReasonCode : null,
    })),
    photos,
  };
}
