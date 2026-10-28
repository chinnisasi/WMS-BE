import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';

/**
 * Story 2-8b (A2) — the open return-to-vendor CLAIMS on the DAMAGED pool, as
 * a free-function seam over the caller's transaction (§7h). It imports only
 * `drizzle-orm` and `shared/` — pinned by `test/architecture.spec.ts` — so
 * inventory's write-off guard reads it without a module edge on inbound
 * (and 4-7c's return-to-client claims will sit beside it, in returns).
 *
 * A claim is an OPEN RTV's line on a DAMAGED arm `(sku, batch | null)` of one
 * warehouse: a `draft` line claims its `qty`, a `picked` line its
 * `picked_qty`. Dispatched and cancelled RTVs claim nothing (the units left,
 * or were released). Milli-units.
 */
export const VENDOR_RETURN_CLAIMING_STATUSES = ['draft', 'picked'] as const;
/** A source (GRN line) claim survives the dispatch: only a cancel releases it. */
export const VENDOR_RETURN_SOURCE_CLAIMING_STATUSES = ['draft', 'picked', 'dispatched'] as const;

/** One arm's open claims: the milli-units and the RTV codes claiming them (sorted). */
export interface DamagedArmClaims {
  readonly claimedMilli: number;
  readonly codes: readonly string[];
}

/** The `Map` key of a DAMAGED arm: `<skuId>:<batchId | ''>`. */
export function damagedArmKey(skuId: string, batchId: string | null): string {
  return `${skuId}:${batchId ?? ''}`;
}

/** The open RTV claims on ONE arm of one warehouse's DAMAGED pool (the write-off guard's read). */
export async function openVendorReturnClaimsInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  skuId: string,
  batchId: string | null,
): Promise<DamagedArmClaims> {
  const rows = (await tx.execute(sql`
    select coalesce(sum(case when r.status = 'draft' then l.qty else l.picked_qty end), 0)::bigint as "claimed",
           coalesce(array_agg(distinct r.code order by r.code), '{}') as "codes"
    from vendor_return_lines l
    join vendor_returns r on r.tenant_id = l.tenant_id and r.id = l.vendor_return_id
    where r.tenant_id = ${tenantId}::uuid and r.warehouse_id = ${warehouseId}::uuid
      and r.status in ${[...VENDOR_RETURN_CLAIMING_STATUSES]}
      and l.sku_id = ${skuId}::uuid and l.batch_id is not distinct from ${batchId}::uuid
  `)) as unknown as { claimed: string; codes: string[] | null }[];
  return { claimedMilli: Number(rows[0]?.claimed ?? 0), codes: rows[0]?.codes ?? [] };
}

/**
 * Every arm's open RTV claims in one warehouse, optionally for a set of SKUs
 * (the create's pool check and the returnable read), keyed by
 * `damagedArmKey`. An arm nothing claims is absent.
 */
export async function openVendorReturnClaimsByArmInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  skuIds: readonly string[] | null,
): Promise<Map<string, DamagedArmClaims>> {
  if (skuIds !== null && skuIds.length === 0) return new Map();
  const skuFilter = skuIds === null ? sql`` : sql`and l.sku_id = any(${sql.param([...new Set(skuIds)])}::uuid[])`;
  const rows = (await tx.execute(sql`
    select l.sku_id::text as "skuId", l.batch_id::text as "batchId",
           sum(case when r.status = 'draft' then l.qty else l.picked_qty end)::bigint as "claimed",
           array_agg(distinct r.code order by r.code) as "codes"
    from vendor_return_lines l
    join vendor_returns r on r.tenant_id = l.tenant_id and r.id = l.vendor_return_id
    where r.tenant_id = ${tenantId}::uuid and r.warehouse_id = ${warehouseId}::uuid
      and r.status in ${[...VENDOR_RETURN_CLAIMING_STATUSES]}
      ${skuFilter}
    group by l.sku_id, l.batch_id
  `)) as unknown as { skuId: string; batchId: string | null; claimed: string; codes: string[] }[];
  const out = new Map<string, DamagedArmClaims>();
  for (const row of rows) {
    out.set(damagedArmKey(row.skuId, row.batchId), { claimedMilli: Number(row.claimed), codes: row.codes });
  }
  return out;
}

/**
 * The SOURCE claims of GRN lines: per GRN line, the milli-units every
 * NON-CANCELLED RTV line naming it holds — a draft line's `qty`, a picked or
 * dispatched line's `picked_qty` (Design Notes: a dispatched claim stays
 * counted, or a second RTV would double the vendor's debit note).
 */
export async function sourceClaimsByGrnLineInTx(
  tx: TenantTx,
  tenantId: string,
  grnLineIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(grnLineIds)];
  if (ids.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    select l.grn_line_id::text as "grnLineId",
           sum(case when r.status = 'draft' then l.qty else l.picked_qty end)::bigint as "claimed"
    from vendor_return_lines l
    join vendor_returns r on r.tenant_id = l.tenant_id and r.id = l.vendor_return_id
    where l.tenant_id = ${tenantId}::uuid and l.grn_line_id = any(${sql.param(ids)}::uuid[])
      and l.grn_line_id is not null
      and r.status in ${[...VENDOR_RETURN_SOURCE_CLAIMING_STATUSES]}
    group by l.grn_line_id
  `)) as unknown as { grnLineId: string; claimed: string }[];
  return new Map(rows.map((row) => [row.grnLineId, Number(row.claimed)]));
}
