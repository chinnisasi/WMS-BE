import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { windDownBlockerInTx, type WindDownBlocker } from '../../shared/primitives/wind-down';

/**
 * Story 1-2a — the billing-owned wind-down blocker of one client: client
 * invoices still `draft` or `disputed` (an issued or settled invoice, and a
 * void one, are done). `codes` names each by its number, else its period
 * (`YYYY-MM`, a draft has no number). A file-level read that imports nothing
 * from `modules/clients` (pinned by `test/architecture.spec.ts`).
 */
export const CLIENT_INVOICE_UNSETTLED_STATUSES = ['draft', 'disputed'] as const;

export async function clientWindDownBlockersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<WindDownBlocker[]> {
  return windDownBlockerInTx(
    tx,
    'unsettled-invoices',
    sql`select count(*)::bigint as n, (array_agg(label order by label))[1:5] as codes
        from (
          select coalesce(invoice_no, to_char(period_start, 'YYYY-MM')) as label
          from client_invoices
          where tenant_id = ${tenantId} and client_id = ${clientId}
            and status in ${[...CLIENT_INVOICE_UNSETTLED_STATUSES]}
        ) unsettled`,
    true,
  );
}
