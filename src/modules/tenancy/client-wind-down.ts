import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { windDownBlockerInTx, type WindDownBlocker } from '../../shared/primitives/wind-down';

/**
 * Story 1-2a — the tenancy-owned wind-down blocker of one client: review
 * queue rows (`rejected_ops`) still `open` that name one of its SKUs. A
 * file-level read that imports nothing from `modules/clients` (pinned by
 * `test/architecture.spec.ts`).
 *
 * Bounded (it runs under the client row's FOR UPDATE): only the op types
 * whose stored payload carries SKU ids are read, through their own JSON paths
 * — `skuId` (putaway, pick), `lines[*].skuId` (GRN submit, count submit, the
 * server-raised `grn.lines-refused` and — 1-2b — `grn.shelf-life-refused`,
 * 1-6d — `grn.licence-refused`),
 * `skuId` (3-1 — the bin-to-bin move; 3-2b — the handheld adjustment), `scanned[*].skuId` (pack) and
 * `entries[*].skuId` (return receive) — each id joined to `skus` by its
 * primary key (a value that is not a uuid matches nothing). No text scan of
 * the payload, no per-SKU loop.
 */
export const REJECTED_OP_OPEN_STATUSES = ['open'] as const;
export const SKU_NAMING_OP_TYPES = [
  'grn.submit',
  'grn.lines-refused',
  // Story 1-2b — the short-dated lines of a receipt (`lines[*].skuId`).
  'grn.shelf-life-refused',
  // Story 1-4b — the booked lines of an inactive SKU (`lines[*].skuId`).
  'grn.inactive-sku-received',
  // Story 1-6d — the licence-refused lines of a receipt (`lines[*].skuId`).
  'grn.licence-refused',
  'putaway.place',
  'pick.record',
  'pack.execute',
  'count.submit',
  'return.receive',
  // Story 3-1 — a refused move names its SKU (`skuId`).
  'stock.move',
  // Story 3-2b — a refused handheld adjustment names its SKU (`skuId`).
  'stock.adjust',
  // Story 4-7a — a refused handheld restock names its SKU (`skuId`).
  'return.restock',
] as const;

const UUID_TEXT = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export async function clientWindDownBlockersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<WindDownBlocker[]> {
  return windDownBlockerInTx(
    tx,
    'open-review-items',
    sql`select count(distinct r.id)::bigint as n
        from rejected_ops r
        cross join lateral (
          select jsonb_path_query(r.payload, 'lax $.skuId') #>> '{}' as sku_id
          union all select jsonb_path_query(r.payload, 'lax $.lines[*].skuId') #>> '{}'
          union all select jsonb_path_query(r.payload, 'lax $.scanned[*].skuId') #>> '{}'
          union all select jsonb_path_query(r.payload, 'lax $.entries[*].skuId') #>> '{}'
        ) named
        join skus s
          on s.tenant_id = r.tenant_id
         and s.id = case when named.sku_id ~ ${UUID_TEXT} then named.sku_id::uuid end
        where r.tenant_id = ${tenantId}
          and r.status in ${[...REJECTED_OP_OPEN_STATUSES]}
          and r.op_type in ${[...SKU_NAMING_OP_TYPES]}
          and s.client_id = ${clientId}`,
    false,
  );
}
