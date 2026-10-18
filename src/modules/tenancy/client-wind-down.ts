import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { windDownBlockerInTx, type WindDownBlocker } from '../../shared/primitives/wind-down';

/**
 * Story 1-2a — the tenancy-owned wind-down blocker of one client: review
 * queue rows (`rejected_ops`) still `open` whose stored payload names one of
 * its SKUs (by id, anywhere in the payload — every op type carries its SKU
 * ids as uuid strings). A file-level read that imports nothing from
 * `modules/clients` (pinned by `test/architecture.spec.ts`).
 */
export const REJECTED_OP_OPEN_STATUSES = ['open'] as const;

export async function clientWindDownBlockersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<WindDownBlocker[]> {
  return windDownBlockerInTx(
    tx,
    'open-review-items',
    sql`select count(*)::bigint as n
        from rejected_ops r
        where r.tenant_id = ${tenantId} and r.status in ${[...REJECTED_OP_OPEN_STATUSES]}
          and exists (
            select 1 from skus s
            where s.tenant_id = r.tenant_id and s.client_id = ${clientId}
              and strpos(r.payload::text, s.id::text) > 0
          )`,
    false,
  );
}
