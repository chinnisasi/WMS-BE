import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { windDownBlockerInTx, type WindDownBlocker } from '../../shared/primitives/wind-down';

/**
 * Story 1-2a — the billing-owned wind-down blocker of one client: client
 * invoices not yet settled — `draft`, `issued` or `disputed` (decision 8: an
 * issued invoice still awaits payment); only `settled` and `void` clear. `codes` names each by its number, else its period
 * (`YYYY-MM`, a draft has no number). A file-level read that imports nothing
 * from `modules/clients` (pinned by `test/architecture.spec.ts`).
 */
export const CLIENT_INVOICE_UNSETTLED_STATUSES = ['draft', 'issued', 'disputed'] as const;

export async function clientWindDownBlockersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<WindDownBlocker[]> {
  return [...(await unsettledInvoicesInTx(tx, tenantId, clientId)), ...(await unbilledChargesInTx(tx, tenantId, clientId))];
}

/**
 * Story 5-5a (A15) — the `unbilled-charges` blocker: pending charges, plus
 * approved charges with no `adhoc` line on an issued, disputed or settled
 * invoice — by the line link, not by month. `codes` names each by its IST
 * date and category. Deliberately asymmetric: metered usage never blocks a
 * wind-down (only unsettled invoices do), but a charge is an explicit
 * record someone asserted.
 */
async function unbilledChargesInTx(tx: TenantTx, tenantId: string, clientId: string): Promise<WindDownBlocker[]> {
  return windDownBlockerInTx(
    tx,
    'unbilled-charges',
    sql`select count(*)::bigint as n, (array_agg(label order by label))[1:5] as codes
        from (
          select c.charge_date::text || ' ' || c.category as label
          from client_charges c
          where c.tenant_id = ${tenantId} and c.client_id = ${clientId}
            and (
              c.status = 'pending'
              or (c.status = 'approved' and not exists (
                select 1 from client_invoice_lines l
                join client_invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
                where l.tenant_id = c.tenant_id and l.adhoc_charge_id = c.id
                  and i.status in ('issued', 'disputed', 'settled')
              ))
            )
        ) unbilled`,
    true,
  );
}

async function unsettledInvoicesInTx(tx: TenantTx, tenantId: string, clientId: string): Promise<WindDownBlocker[]> {
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
