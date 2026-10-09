import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import type { Page } from '../../shared/primitives/pagination';
import { fromMilli } from '../../shared/primitives/quantity';
import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * Story 21-7 — the client portal's stock read: one row per (SKU, warehouse)
 * of ONE client where either figure is above zero.
 *
 * - `onHand` — Σ `stock_on_hand` over EVERY bin of the warehouse (receiving
 *   and QC included: the goods are in the building; the sellable/held split
 *   is PENDING). Never a bin, never a bin code.
 * - `allocated` — Σ `reservations` held for orders (`owner_type = 'order'`,
 *   state `held`/`committed`). Not ATP: ATP reads Valkey and nets out channel
 *   buffers, another party's commercial setting.
 *
 * Each side is PRE-AGGREGATED per (sku, warehouse) and the two are FULL
 * joined — a per-bin join would fan the reservation sum out once per bin,
 * and an inner join would drop an allocated-only row. Both inherited tables
 * reach the client ONLY through a join to the stamped `skus` (explicit
 * `s.client_id = $client`); the caller's transaction is stamped
 * `app.client_id` too, so RLS filters `skus` a second time (two layers).
 */
export interface PortalStockRow {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly baseUom: string;
  readonly warehouseId: string;
  readonly warehouseName: string;
  readonly onHand: number;
  readonly allocated: number;
}

/** The stock keyset: `(skuCode, warehouseId)` ascending — its own codec. */
interface StockCursor {
  readonly skuCode: string;
  readonly warehouseId: string;
}

export function encodeStockCursor(cursor: StockCursor): string {
  return Buffer.from(JSON.stringify({ skuCode: cursor.skuCode, warehouseId: cursor.warehouseId }), 'utf8').toString('base64url');
}

export function decodeStockCursor(cursor: string): StockCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as StockCursor).skuCode !== 'string' ||
      (parsed as StockCursor).skuCode === '' ||
      typeof (parsed as StockCursor).warehouseId !== 'string' ||
      !UUID_RE.test((parsed as StockCursor).warehouseId)
    ) {
      throw new Error('malformed stock cursor');
    }
    return { skuCode: (parsed as StockCursor).skuCode, warehouseId: (parsed as StockCursor).warehouseId };
  } catch {
    throw new ProblemException(
      'invalid-cursor',
      400,
      'Malformed pagination cursor',
      'The cursor parameter is not a valid opaque page cursor.',
    );
  }
}

export async function portalStockInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  query: { readonly cursor?: string; readonly limit: number },
): Promise<Page<PortalStockRow>> {
  const after = query.cursor === undefined ? null : decodeStockCursor(query.cursor);
  const rows = (await tx.execute(sql`
    with oh as (
      select so.sku_id as sku, so.warehouse_id as wh, sum(so.quantity)::bigint as q
      from stock_on_hand so
      join skus s on s.tenant_id = so.tenant_id and s.id = so.sku_id
      where so.tenant_id = ${tenantId}::uuid and s.client_id = ${clientId}::uuid
      group by so.sku_id, so.warehouse_id
    ),
    al as (
      select r.sku_id as sku, r.warehouse_id as wh, sum(r.quantity)::bigint as q
      from reservations r
      join skus s on s.tenant_id = r.tenant_id and s.id = r.sku_id
      where r.tenant_id = ${tenantId}::uuid and s.client_id = ${clientId}::uuid
        and r.owner_type = 'order' and r.state in ('held', 'committed')
      group by r.sku_id, r.warehouse_id
    )
    select s.id as "skuId", s.code as "skuCode", s.name as "skuName", s.uom as "baseUom",
           w.id as "warehouseId", w.name as "warehouseName",
           coalesce(oh.q, 0)::bigint as "onHand", coalesce(al.q, 0)::bigint as "allocated"
    from oh
    full join al on al.sku = oh.sku and al.wh = oh.wh
    join skus s on s.tenant_id = ${tenantId}::uuid and s.id = coalesce(oh.sku, al.sku) and s.client_id = ${clientId}::uuid
    join warehouses w on w.tenant_id = ${tenantId}::uuid and w.id = coalesce(oh.wh, al.wh)
    where (coalesce(oh.q, 0) > 0 or coalesce(al.q, 0) > 0)
      ${after === null ? sql`` : sql`and (s.code, w.id) > (${after.skuCode}::text, ${after.warehouseId}::uuid)`}
    order by s.code asc, w.id asc
    limit ${query.limit + 1}::int
  `)) as unknown as {
    skuId: string;
    skuCode: string;
    skuName: string;
    baseUom: string;
    warehouseId: string;
    warehouseName: string;
    onHand: string | number;
    allocated: string | number;
  }[];
  const kept = rows.slice(0, query.limit);
  const last = kept.at(-1);
  return {
    items: kept.map((row) => ({
      skuId: row.skuId,
      skuCode: row.skuCode,
      skuName: row.skuName,
      baseUom: row.baseUom,
      warehouseId: row.warehouseId,
      warehouseName: row.warehouseName,
      // bigint sums arrive as text through postgres.js — Number() at the boundary.
      onHand: fromMilli(Number(row.onHand)),
      allocated: fromMilli(Number(row.allocated)),
    })),
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? encodeStockCursor({ skuCode: last.skuCode, warehouseId: last.warehouseId })
        : null,
  };
}
