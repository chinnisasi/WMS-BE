import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { windDownBlockerInTx, type WindDownBlocker } from '../../shared/primitives/wind-down';

/**
 * Story 1-2a — the inbound-owned wind-down blockers of one client (the
 * departure check, composed by `ClientsCommand.updateStatus`). A file-level
 * read on the caller's transaction that imports nothing from
 * `modules/clients` — and no inbound command file (they import the clients
 * facade) — pinned by `test/architecture.spec.ts`. The status lists are
 * pinned equal to the owners' vocabularies by `test/client-master.spec.ts`.
 *
 * - `open-purchase-orders` — POs still `open`;
 * - `open-asns` — ASNs `announced` or `partially_received` (`OPEN_ASN_STATUSES`);
 * - `pending-over-receipts` — over-receipts awaiting a decision, on ANY
 *   document, for one of its SKUs (`codes` = the GRN codes).
 * - `open-vendor-returns` — story 2-8b: returns to vendor still `draft` or
 *   `picked` (`codes` = the RTV codes); pinned against
 *   `VENDOR_RETURN_STATUSES` by test/client-master.spec.ts.
 */
export const PO_OPEN_STATUSES = ['open'] as const;
export const ASN_OPEN_STATUSES = ['announced', 'partially_received'] as const;
export const OVER_RECEIPT_PENDING_STATUSES = ['pending'] as const;
export const VENDOR_RETURN_OPEN_STATUSES = ['draft', 'picked'] as const;

export async function clientWindDownBlockersInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<WindDownBlocker[]> {
  const pos = await windDownBlockerInTx(
    tx,
    'open-purchase-orders',
    sql`select count(*)::bigint as n, (array_agg(code order by code))[1:5] as codes
        from purchase_orders
        where tenant_id = ${tenantId} and client_id = ${clientId} and status in ${[...PO_OPEN_STATUSES]}`,
    true,
  );
  const asns = await windDownBlockerInTx(
    tx,
    'open-asns',
    sql`select count(*)::bigint as n, (array_agg(asn_code order by asn_code))[1:5] as codes
        from advance_shipment_notices
        where tenant_id = ${tenantId} and client_id = ${clientId} and status in ${[...ASN_OPEN_STATUSES]}`,
    true,
  );
  const overReceipts = await windDownBlockerInTx(
    tx,
    'pending-over-receipts',
    sql`select count(*)::bigint as n,
               (array_agg(distinct g.code order by g.code))[1:5] as codes
        from over_receipts o
        join skus s on s.tenant_id = o.tenant_id and s.id = o.sku_id
        left join goods_receipt_notes g on g.tenant_id = o.tenant_id and g.id = o.grn_id
        where o.tenant_id = ${tenantId} and s.client_id = ${clientId}
          and o.status in ${[...OVER_RECEIPT_PENDING_STATUSES]}`,
    true,
  );
  const vendorReturns = await windDownBlockerInTx(
    tx,
    'open-vendor-returns',
    sql`select count(*)::bigint as n, (array_agg(code order by code))[1:5] as codes
        from vendor_returns
        where tenant_id = ${tenantId} and client_id = ${clientId} and status in ${[...VENDOR_RETURN_OPEN_STATUSES]}`,
    true,
  );
  return [...pos, ...asns, ...overReceipts, ...vendorReturns];
}
