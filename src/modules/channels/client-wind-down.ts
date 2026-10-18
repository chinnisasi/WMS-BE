import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { windDownBlockerInTx, type WindDownBlocker } from '../../shared/primitives/wind-down';

/**
 * Story 1-2a (decision 9) — the channels-owned wind-down blocker of one
 * client: channel mappings of its SKUs, on any connection. A departed
 * client's SKU stays mapped otherwise, and every delivery of it is refused;
 * the owner unmaps first (nothing changes automatically). `count` is the
 * number of mappings, `codes` the first five external refs. A file-level
 * read that imports nothing from `modules/clients` (pinned by
 * `test/architecture.spec.ts`).
 */
export async function clientWindDownBlockersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<WindDownBlocker[]> {
  return windDownBlockerInTx(
    tx,
    'channel-mappings',
    sql`select count(*)::bigint as n, (array_agg(m.external_ref order by m.external_ref))[1:5] as codes
        from channel_mappings m
        join skus s on s.tenant_id = m.tenant_id and s.id = m.sku_id
        where m.tenant_id = ${tenantId} and s.client_id = ${clientId}`,
    true,
  );
}
