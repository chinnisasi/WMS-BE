import { sql, type SQL } from 'drizzle-orm';
import { skuOfClient } from '../../shared/db/client-filter';
import { rearmTxDeadline } from '../../shared/db/tx-deadline';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
import { fullPrecisionInstant } from '../../shared/primitives/time';

/**
 * Story 5-3a — the inbound register's read (one row per GRN line), delegated
 * to by `InboundFacade.inboundRegisterInTx`. Read-only, inside the caller's
 * REPEATABLE READ transaction; every statement re-arms the caller's
 * whole-read deadline first.
 *
 * The walk: the warehouse's GRN headers whose `created_at` is in
 * `[from, to)`, on the existing `(tenant_id, warehouse_id, created_at, id)`
 * keyset (full-precision cursor), one page per statement; then that page's
 * lines with their header, document and gate-in facts. **Client attribution
 * is the LINE's SKU** (decision 6) — a GRN with a null `client_id` (a legacy
 * or blind receipt) is still attributed through its lines, and a filtered
 * register keeps exactly the client's lines (`skuOfClient`).
 *
 * The gate-in documents a row prints are the ones that NAME this receipt's
 * PO or ASN (`gate_in_documents.po_id` / `asn_id`). A truck carries several
 * clients' goods, so an unlinked document (or one naming another document)
 * is never printed beside this line — a client-filtered register must not
 * carry another client's invoice numbers. A blind receipt therefore prints
 * its gate-in code and no documents.
 */

export interface InboundRegisterScope {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly clientId: string | null;
  /** `[from, to)` on `goods_receipt_notes.created_at`, ISO instants. */
  readonly from: string;
  readonly to: string;
}

export interface InboundRegisterRow {
  readonly grnId: string;
  readonly grnCode: string;
  /** The GRN's `created_at` — the period's basis, ISO. */
  readonly createdAt: string;
  /** The GRN's `recorded_at` (server ingest instant), ISO. */
  readonly recordedAt: string;
  /** `po:<PO code>`, `asn:<ASN code>` or `blind:<reason>`. */
  readonly document: string;
  /** The PO's frozen vendor (`vendor_snapshot` legal name, else name); null on an ASN or blind receipt. */
  readonly vendorName: string | null;
  /** The line SKU's client. */
  readonly clientId: string;
  readonly gateInCode: string | null;
  /** `<kind> <number>` of each linked gate-in document, `; `-joined in position order; null with none. */
  readonly supplierDocuments: string | null;
  /** Each linked document's date (`YYYY-MM-DD`, as typed), `; `-joined in the same order (`-` for none). */
  readonly supplierDocumentDates: string | null;
  /** Each linked document's e-way bill number, `; `-joined in the same order — `-` where a document has none, so the three lists align. */
  readonly ewayBillNumbers: string | null;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly batchId: string | null;
  /** Base units — everything that arrived. */
  readonly qty: number;
  /** Base units — the within-open slice that hit the ledger. */
  readonly appliedQty: number;
  readonly recordedBy: string;
}

/** GRN headers per walk statement. */
export const INBOUND_REGISTER_PAGE = 1000;

function iso(column: SQL): SQL {
  return sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

interface RawLine {
  grnId: string;
  grnCode: string;
  createdAt: string;
  recordedAt: string;
  poCode: string | null;
  asnCode: string | null;
  blindReasonCode: string | null;
  vendorName: string | null;
  clientId: string;
  gateInCode: string | null;
  supplierDocuments: string | null;
  supplierDocumentDates: string | null;
  ewayBillNumbers: string | null;
  skuId: string;
  skuCode: string;
  skuName: string;
  uom: string;
  batchId: string | null;
  qty: string;
  appliedQty: string;
  recordedBy: string;
}

function documentOf(row: RawLine): string {
  if (row.poCode !== null) return `po:${row.poCode}`;
  if (row.asnCode !== null) return `asn:${row.asnCode}`;
  return `blind:${row.blindReasonCode ?? 'unknown'}`;
}

export async function inboundRegisterInTx(
  tx: TenantTx,
  scope: InboundRegisterScope,
  limit: number,
  pageSize: number = INBOUND_REGISTER_PAGE,
): Promise<InboundRegisterRow[]> {
  const out: InboundRegisterRow[] = [];
  let after: { createdAt: string; id: string } | null = null;
  while (out.length < limit) {
    await rearmTxDeadline(tx);
    const cursor: SQL = after === null ? sql`` : sql` and (g.created_at, g.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`;
    const headers = (await tx.execute(sql`
      select g.id::text as "id", g.created_at::text as "createdAtText"
      from goods_receipt_notes g
      where g.tenant_id = ${scope.tenantId}::uuid and g.warehouse_id = ${scope.warehouseId}::uuid
        and g.created_at >= ${scope.from}::timestamptz and g.created_at < ${scope.to}::timestamptz${cursor}
      order by g.created_at, g.id
      limit ${pageSize}::int
    `)) as unknown as { id: string; createdAtText: string }[];
    if (headers.length === 0) break;

    await rearmTxDeadline(tx);
    const clientFilter = scope.clientId === null ? sql`` : sql` and ${skuOfClient(sql`l.sku_id`, scope.tenantId, scope.clientId)}`;
    const lines = (await tx.execute(sql`
      select g.id::text as "grnId", g.code as "grnCode", ${iso(sql`g.created_at`)} as "createdAt", ${iso(sql`g.recorded_at`)} as "recordedAt",
             po.code as "poCode", asn.asn_code as "asnCode", g.blind_reason_code as "blindReasonCode",
             coalesce(po.vendor_snapshot ->> 'legalName', po.vendor_snapshot ->> 'name') as "vendorName",
             k.client_id::text as "clientId", gi.code as "gateInCode",
             docs.documents as "supplierDocuments", docs.dates as "supplierDocumentDates", docs.eway as "ewayBillNumbers",
             k.id::text as "skuId", k.code as "skuCode", k.name as "skuName", k.uom as "uom",
             l.batch_id::text as "batchId", l.qty::text as "qty", l.applied_qty::text as "appliedQty",
             g.recorded_by::text as "recordedBy"
      from goods_receipt_lines l
      join goods_receipt_notes g on g.tenant_id = l.tenant_id and g.id = l.grn_id
      join skus k on k.tenant_id = l.tenant_id and k.id = l.sku_id
      left join purchase_orders po on po.tenant_id = g.tenant_id and po.id = g.po_id
      left join advance_shipment_notices asn on asn.tenant_id = g.tenant_id and asn.id = g.asn_id
      left join gate_ins gi on gi.tenant_id = g.tenant_id and gi.id = g.gate_in_id
      left join lateral (
        select string_agg(d.kind || ' ' || d.number, '; ' order by d.position) as documents,
               -- Aligned slots: one entry per document in all three lists, '-' where a document has none.
               string_agg(coalesce(d.document_date::text, '-'), '; ' order by d.position) as dates,
               string_agg(coalesce(d.eway_bill_no, '-'), '; ' order by d.position) as eway
        from gate_in_documents d
        where d.tenant_id = g.tenant_id and d.gate_in_id = g.gate_in_id
          and ((g.po_id is not null and d.po_id = g.po_id) or (g.asn_id is not null and d.asn_id = g.asn_id))
      ) docs on true
      where l.tenant_id = ${scope.tenantId}::uuid
        and l.grn_id = any(${sql.param(headers.map((header) => header.id))}::uuid[])${clientFilter}
      order by g.created_at, g.id, l.created_at, l.id
      limit ${limit - out.length + 1}::int
    `)) as unknown as RawLine[];
    for (const row of lines) {
      if (out.length >= limit) break;
      out.push({
        grnId: row.grnId,
        grnCode: row.grnCode,
        createdAt: row.createdAt,
        recordedAt: row.recordedAt,
        document: documentOf(row),
        vendorName: row.vendorName,
        clientId: row.clientId,
        gateInCode: row.gateInCode,
        supplierDocuments: row.supplierDocuments,
        supplierDocumentDates: row.supplierDocumentDates,
        ewayBillNumbers: row.ewayBillNumbers,
        skuId: row.skuId,
        skuCode: row.skuCode,
        skuName: row.skuName,
        uom: row.uom,
        batchId: row.batchId,
        qty: fromMilli(Number(row.qty)),
        appliedQty: fromMilli(Number(row.appliedQty)),
        recordedBy: row.recordedBy,
      });
    }
    if (headers.length < pageSize) break;
    const last = headers.at(-1)!;
    after = { createdAt: fullPrecisionInstant(last.createdAtText), id: last.id };
  }
  return out;
}

/** GRN id → code for a set of ids, in the caller's transaction (unknown or malformed ids absent). */
export async function grnCodesByIdsInTx(tx: TenantTx, tenantId: string, grnIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(grnIds)].filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return new Map();
  await rearmTxDeadline(tx);
  const rows = (await tx.execute(sql`
    select g.id::text as "id", g.code as "code" from goods_receipt_notes g
    where g.tenant_id = ${tenantId}::uuid and g.id = any(${sql.param(ids)}::uuid[])
  `)) as unknown as { id: string; code: string }[];
  return new Map(rows.map((row) => [row.id, row.code]));
}
