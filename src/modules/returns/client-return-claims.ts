import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';

/**
 * Story 4-7c (decision 6, D2) — the open return-to-client CLAIMS on the
 * DAMAGED pool, as a free-function seam over the caller's transaction (§7h),
 * the twin of 2-8b's `inbound/vendor-return-claims.ts`. It imports only
 * `drizzle-orm` and `shared/` — pinned by `test/architecture.spec.ts` — so
 * inventory's write-off guard and inbound's RTV create and returnable read
 * count RTC claims without a module edge on returns.
 *
 * A claim is an OPEN RTC's `damaged` line on a DAMAGED arm `(sku, batch |
 * null)` of one warehouse: a `draft` line claims its `qty`, a `picked` line
 * its `picked_qty`. Dispatched and cancelled RTCs claim nothing (the units
 * left, or were released). A `returns` line claims RETURNS, never DAMAGED —
 * its claim lives in the receipt line's `open_qty`. Milli-units.
 */
export const CLIENT_RETURN_CLAIMING_STATUSES = ['draft', 'picked'] as const;

/** One arm's open RTC claims: the milli-units and the RTC codes claiming them (sorted). */
export interface ClientReturnArmClaims {
  readonly claimedMilli: number;
  readonly codes: readonly string[];
}

/**
 * The `Map` key of a DAMAGED arm: `<skuId>:<batchId | ''>` — its own copy of
 * 2-8b's `damagedArmKey` (this seam may not import inbound); the two formats
 * are pinned equal by `test/client-returns.spec.ts`.
 */
export function clientReturnArmKey(skuId: string, batchId: string | null): string {
  return `${skuId}:${batchId ?? ''}`;
}

/** The open RTC claims on ONE arm of one warehouse's DAMAGED pool (the write-off guard's read). */
export async function openClientReturnClaimsInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  skuId: string,
  batchId: string | null,
): Promise<ClientReturnArmClaims> {
  const rows = (await tx.execute(sql`
    select coalesce(sum(case when r.status = 'draft' then l.qty else l.picked_qty end), 0)::bigint as "claimed",
           coalesce(array_agg(distinct r.code order by r.code), '{}') as "codes"
    from client_return_lines l
    join client_returns r on r.tenant_id = l.tenant_id and r.id = l.client_return_id
    where r.tenant_id = ${tenantId}::uuid and r.warehouse_id = ${warehouseId}::uuid
      and r.status in ${[...CLIENT_RETURN_CLAIMING_STATUSES]}
      and l.source = 'damaged'
      and l.sku_id = ${skuId}::uuid and l.batch_id is not distinct from ${batchId}::uuid
  `)) as unknown as { claimed: string; codes: string[] | null }[];
  return { claimedMilli: Number(rows[0]?.claimed ?? 0), codes: rows[0]?.codes ?? [] };
}

/**
 * Every arm's open RTC claims in one warehouse, optionally for a set of SKUs
 * (the RTV and RTC creates' pool checks and the returnable reads), keyed by
 * `clientReturnArmKey`. An arm nothing claims is absent.
 */
export async function openClientReturnClaimsByArmInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  skuIds: readonly string[] | null,
): Promise<Map<string, ClientReturnArmClaims>> {
  if (skuIds !== null && skuIds.length === 0) return new Map();
  const skuFilter = skuIds === null ? sql`` : sql`and l.sku_id = any(${sql.param([...new Set(skuIds)])}::uuid[])`;
  const rows = (await tx.execute(sql`
    select l.sku_id::text as "skuId", l.batch_id::text as "batchId",
           sum(case when r.status = 'draft' then l.qty else l.picked_qty end)::bigint as "claimed",
           array_agg(distinct r.code order by r.code) as "codes"
    from client_return_lines l
    join client_returns r on r.tenant_id = l.tenant_id and r.id = l.client_return_id
    where r.tenant_id = ${tenantId}::uuid and r.warehouse_id = ${warehouseId}::uuid
      and r.status in ${[...CLIENT_RETURN_CLAIMING_STATUSES]}
      and l.source = 'damaged'
      ${skuFilter}
    group by l.sku_id, l.batch_id
  `)) as unknown as { skuId: string; batchId: string | null; claimed: string; codes: string[] }[];
  const out = new Map<string, ClientReturnArmClaims>();
  for (const row of rows) {
    out.set(clientReturnArmKey(row.skuId, row.batchId), { claimedMilli: Number(row.claimed), codes: row.codes });
  }
  return out;
}
