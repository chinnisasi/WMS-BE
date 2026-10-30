import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { canonicalInstant, istDateOf } from '../../shared/primitives/time';
import { CatalogFacade } from '../catalog/catalog.facade';
import { uomPrecision } from '../catalog/uom';
import { clientPartySnapshotOf, getClientInTx } from '../clients/clients.facade';
import type { VendorSnapshotV1 } from '../partners/partners.facade';
import { photoCountsByParentInTx } from '../attachments/attachment-records';
import { QcCommand } from './qc.command';
import { MAX_SUCCESSOR_HOPS } from './receiving.command';
import { liveWarehouseSnapshotInTx } from './vendor-return.read';
import {
  grnWarehousePartyOf,
  type GrnArrival,
  type GrnDocument,
  type GrnDocumentKind,
  type GrnDocumentLine,
  type GrnPartiesSnapshotV1,
} from './grn-document.types';

/** Who is reading: the staff copy (`null`) or ONE client's copy (the portal, the receipt email). */
export type GrnDocumentScope = { readonly clientId: string } | null;

interface HeaderRow {
  id: string;
  code: string;
  warehouseId: string;
  clientId: string | null;
  poId: string | null;
  asnId: string | null;
  blindReasonCode: string | null;
  gateInId: string | null;
  occurredAt: string;
  recordedAt: string;
  documentParties: GrnPartiesSnapshotV1 | null;
  poCode: string | null;
  vendorSnapshot: VendorSnapshotV1 | null;
  asnCode: string | null;
}

interface LineRow {
  id: string;
  skuCode: string;
  skuName: string;
  uom: string;
  clientCode: string;
  batchId: string | null;
  qtyMilli: string | number;
  damagedMilli: string | number;
  damageReasonCode: string | null;
  shortMilli: string | number;
  shortReasonCode: string | null;
  toleranceMilli: string | number;
  expectedMilli: string | number | null;
}

/**
 * Story 2-9a — THE read of one GRN as its document prints it. One model for
 * every door: the staff web (`scope: null`), the client portal and the
 * receipt email (`scope: {clientId}` — the caller's transaction is also
 * client-stamped). An `@Injectable()` (D4): it needs the catalog's batch
 * facts and QC's own record.
 *
 * Statements, in order (A12: at most 15 for a frozen GRN — one per step, never per line):
 *  1. the header (+ the PO code and its frozen vendor, the ASN code);
 *  2. a legacy GRN only (`document_parties` NULL): the live parties;
 *  3. the lines with their SKU, client, UoM and expected quantity;
 *  4. the batch facts (one read);
 *  5. the over-receipt sums by line and status;
 *  6. QC (`receiptQcOutcomesByGrnInTx`: holds, ledger totals, inspections);
 *  7. the serial counts by line;
 *  8. the attached-photo counts;
 *  9. the gate-in and its documents (A9's filter).
 *
 * Scoped (guide §7e, Boundaries): the header carries `g.client_id = $client`;
 * lines are reached only through an inner join to `skus` with
 * `s.client_id = $client`; over-receipts, holds and serials only through
 * those line ids; photos with `attachments.client_id = $client`. Unknown,
 * another client's and a null-client GRN are the same `null`. It never reads
 * `users` (decision 6: no personal name on the document).
 */
@Injectable()
export class GrnDocumentReader {
  constructor(
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(QcCommand) private readonly qc: QcCommand,
  ) {}

  async readInTx(tx: TenantTx, tenantId: string, grnId: string, scope: GrnDocumentScope, printedAt: string): Promise<GrnDocument | null> {
    if (!UUID_RE.test(grnId)) return null;
    const clientId = scope?.clientId ?? null;

    // 1. The header.
    const headers = (await tx.execute(sql`
      select g.id, g.code, g.warehouse_id as "warehouseId", g.client_id as "clientId",
             g.po_id as "poId", g.asn_id as "asnId", g.blind_reason_code as "blindReasonCode",
             g.gate_in_id as "gateInId", g.occurred_at as "occurredAt", g.recorded_at as "recordedAt",
             g.document_parties as "documentParties",
             p.code as "poCode", p.vendor_snapshot as "vendorSnapshot", a.asn_code as "asnCode"
      from goods_receipt_notes g
      left join purchase_orders p on p.tenant_id = g.tenant_id and p.id = g.po_id
        ${clientId === null ? sql`` : sql`and p.client_id = ${clientId}::uuid`}
      left join advance_shipment_notices a on a.tenant_id = g.tenant_id and a.id = g.asn_id
        ${clientId === null ? sql`` : sql`and a.client_id = ${clientId}::uuid`}
      where g.tenant_id = ${tenantId}::uuid and g.id = ${grnId}::uuid
        ${clientId === null ? sql`` : sql`and g.client_id = ${clientId}::uuid`}
      limit 1
    `)) as unknown as HeaderRow[];
    const header = headers[0];
    if (header === undefined) return null;

    // 2. The parties: frozen, else live (a GRN recorded before 2-9a — no backfill).
    const frozen = header.documentParties;
    const parties =
      frozen !== null
        ? { frozen: true, warehouse: frozen.warehouse, client: frozen.client, vendor: frozen.vendor }
        : {
            frozen: false,
            warehouse: grnWarehousePartyOf(await liveWarehouseSnapshotInTx(tx, tenantId, header.warehouseId)),
            client: header.clientId === null ? null : clientPartySnapshotOf(await getClientInTx(tx, tenantId, header.clientId)),
            vendor: header.poId === null ? null : (header.vendorSnapshot ?? null),
          };

    // 3. The lines (2-5a's order), each through its SKU (and the client predicate).
    const lineRows = (await tx.execute(sql`
      select l.id, s.code as "skuCode", s.name as "skuName", s.uom as "uom", c.code as "clientCode",
             l.batch_id as "batchId",
             l.qty::bigint as "qtyMilli", l.damaged_qty::bigint as "damagedMilli", l.damage_reason_code as "damageReasonCode",
             l.short_qty::bigint as "shortMilli", l.short_reason_code as "shortReasonCode",
             l.tolerance_qty::bigint as "toleranceMilli",
             coalesce(pl.ordered_qty, al.announced_qty)::bigint as "expectedMilli"
      from goods_receipt_lines l
      join skus s on s.tenant_id = l.tenant_id and s.id = l.sku_id
        ${clientId === null ? sql`` : sql`and s.client_id = ${clientId}::uuid`}
      join clients c on c.tenant_id = s.tenant_id and c.id = s.client_id
      left join purchase_order_lines pl on pl.tenant_id = l.tenant_id and pl.id = l.po_line_id
      left join asn_lines al on al.tenant_id = l.tenant_id and al.id = l.asn_line_id
      where l.tenant_id = ${tenantId}::uuid and l.grn_id = ${grnId}::uuid
      order by l.created_at asc, l.id asc
    `)) as unknown as LineRow[];
    const lineIds = lineRows.map((row) => row.id);

    // 4. The batch facts.
    const batchFacts = await this.catalog.batchFactsByIdsInTx(
      tx,
      tenantId,
      lineRows.flatMap((row) => (row.batchId === null ? [] : [row.batchId])),
    );

    // 5. The over-receipts, summed by line and status (D8's index).
    const excessRows =
      lineIds.length === 0
        ? []
        : ((await tx.execute(sql`
            select o.grn_line_id as "lineId", o.status, sum(o.excess_qty)::bigint as "milli"
            from over_receipts o
            where o.tenant_id = ${tenantId}::uuid and o.grn_line_id = any(${sql.param(lineIds)}::uuid[])
            group by o.grn_line_id, o.status
          `)) as unknown as { lineId: string; status: string; milli: string | number }[]);
    const excess = new Map<string, { pendingMilli: number; approvedMilli: number; rejectedMilli: number }>();
    for (const row of excessRows) {
      const entry = excess.get(row.lineId) ?? { pendingMilli: 0, approvedMilli: 0, rejectedMilli: 0 };
      if (row.status === 'pending') entry.pendingMilli += Number(row.milli);
      else if (row.status === 'approved') entry.approvedMilli += Number(row.milli);
      else if (row.status === 'rejected') entry.rejectedMilli += Number(row.milli);
      excess.set(row.lineId, entry);
    }

    // 6. QC, from QC's own record.
    const qc = await this.qc.receiptQcOutcomesByGrnInTx(tx, tenantId, grnId, lineIds);

    // 7. The serial counts (A8: captured = applied + pending; unreadable and rejected apart).
    const serialRows =
      lineIds.length === 0
        ? []
        : ((await tx.execute(sql`
            select r.grn_line_id as "lineId",
                   (count(*) filter (where r.serial_id is not null and r.state in ('applied', 'pending')))::int as "captured",
                   (count(*) filter (where r.serial_id is null))::int as "unreadable",
                   (count(*) filter (where r.serial_id is not null and r.state = 'rejected'))::int as "rejected"
            from goods_receipt_line_serials r
            where r.tenant_id = ${tenantId}::uuid and r.grn_line_id = any(${sql.param(lineIds)}::uuid[])
            group by r.grn_line_id
          `)) as unknown as { lineId: string; captured: number; unreadable: number; rejected: number }[]);
    const serials = new Map(serialRows.map((row) => [row.lineId, row]));

    // 8. The attached photos (counted, never embedded — decision 8).
    const photos = (await photoCountsByParentInTx(tx, tenantId, [grnId], clientId ?? undefined)).get(grnId)?.byLine;

    // 9. The arrival.
    const arrival = header.gateInId === null ? null : await this.arrivalInTx(tx, tenantId, header);

    const lines: GrnDocumentLine[] = lineRows.map((row, index) => {
      const facts = row.batchId === null ? undefined : batchFacts.get(row.batchId);
      const lineQc = qc.get(row.id);
      const serial = serials.get(row.id);
      return {
        id: row.id,
        lineNo: index + 1,
        skuCode: row.skuCode,
        skuName: row.skuName,
        clientCode: row.clientCode,
        uom: row.uom,
        uomPrecision: uomPrecision(row.uom),
        batchCode: facts?.code ?? null,
        mfgDate: facts?.mfgDate == null ? null : istDateOf(facts.mfgDate),
        expiryDate: facts?.expiryDate == null ? null : istDateOf(facts.expiryDate),
        expirySource: facts?.expiryDate == null ? null : (facts.expirySource ?? null),
        expectedMilli: row.expectedMilli === null ? null : Number(row.expectedMilli),
        goodMilli: Number(row.qtyMilli),
        damagedMilli: Number(row.damagedMilli),
        damageReasonCode: Number(row.damagedMilli) > 0 ? row.damageReasonCode : null,
        shortMilli: Number(row.shortMilli),
        shortReasonCode: Number(row.shortMilli) > 0 ? row.shortReasonCode : null,
        toleranceMilli: Number(row.toleranceMilli),
        excess: excess.get(row.id) ?? { pendingMilli: 0, approvedMilli: 0, rejectedMilli: 0 },
        qc: {
          status: lineQc?.status ?? null,
          heldMilli: lineQc?.heldMilli ?? 0,
          onHoldMilli: lineQc?.onHoldMilli ?? 0,
          releasedMilli: lineQc?.releasedMilli ?? 0,
          passedMilli: lineQc?.passedMilli ?? 0,
          failedMilli: lineQc?.failedMilli ?? 0,
        },
        serialCount: serial?.captured ?? 0,
        unreadableSerialCount: serial?.unreadable ?? 0,
        rejectedSerialCount: serial?.rejected ?? 0,
        photoCount: photos?.get(row.id)?.photoCount ?? 0,
      };
    });

    const kind: GrnDocumentKind = header.poId !== null ? 'po' : header.asnId !== null ? 'asn' : 'blind';
    return {
      id: header.id,
      code: header.code,
      receivedAt: canonicalInstant(String(header.occurredAt)),
      recordedAt: canonicalInstant(String(header.recordedAt)),
      printedAt,
      clientId: header.clientId,
      parties,
      document: {
        kind,
        code: kind === 'po' ? header.poCode : kind === 'asn' ? header.asnCode : null,
        blindReasonCode: kind === 'blind' ? header.blindReasonCode : null,
      },
      arrival,
      lines,
    };
  }

  /**
   * The gate-in and the supplier documents this GRN may print (A9). A
   * document prints when (a) it names this GRN's ASN, or its PO or any
   * predecessor of it (walked by `carried_from_po_id`, at most
   * `MAX_SUCCESSOR_HOPS`), or (b) it names no document and the visit is
   * single-client — every GRN of the gate-in is this GRN's client and no
   * document of it names another client's PO or ASN. Anything else is
   * omitted, and the arrival says so. Package counts and the driver are
   * never read (decisions 6, 7).
   */
  private async arrivalInTx(tx: TenantTx, tenantId: string, header: HeaderRow): Promise<GrnArrival | null> {
    // The header was already scoped: its client is the reader's (or null, staff only).
    const receiptClient = header.clientId;
    const rows = (await tx.execute(sql`
      with recursive chain(id, depth) as (
        select ${header.poId}::uuid, 0 where ${header.poId}::uuid is not null
        union all
        select p.carried_from_po_id, c.depth + 1
        from purchase_orders p
        join chain c on p.tenant_id = ${tenantId}::uuid and p.id = c.id
        where p.carried_from_po_id is not null and c.depth < ${MAX_SUCCESSOR_HOPS}
      ),
      single as (
        select (
          ${receiptClient}::uuid is not null
          and not exists (
            select 1 from goods_receipt_notes g2
            where g2.tenant_id = ${tenantId}::uuid and g2.gate_in_id = ${header.gateInId}::uuid
              and g2.client_id is distinct from ${receiptClient}::uuid
          )
          and not exists (
            select 1 from gate_in_documents d2
            where d2.tenant_id = ${tenantId}::uuid and d2.gate_in_id = ${header.gateInId}::uuid
              and (
                (d2.po_id is not null and not exists (
                  select 1 from purchase_orders p2
                  where p2.tenant_id = ${tenantId}::uuid and p2.id = d2.po_id and p2.client_id = ${receiptClient}::uuid))
                or (d2.asn_id is not null and not exists (
                  select 1 from advance_shipment_notices a2
                  where a2.tenant_id = ${tenantId}::uuid and a2.id = d2.asn_id and a2.client_id = ${receiptClient}::uuid))
              )
          )
        ) as ok
      )
      select gi.code as "gateInCode", gi.vehicle_no as "vehicleNo", gi.container_no as "containerNo",
             coalesce(gi.transporter_snapshot->>'name', gi.transporter_name) as "transporterName",
             gi.lr_number as "lrNumber", gi.seal_status as "sealStatus", gi.seal_number as "sealNumber",
             gi.dock_door as "dockDoor", gi.gated_in_at as "gatedInAt",
             gi.unload_started_at as "unloadStartedAt", gi.unload_ended_at as "unloadEndedAt",
             d.kind as "docKind", d.number as "docNumber", d.document_date::text as "docDate",
             d.eway_bill_no as "docEway",
             case
               when d.id is null then null
               when ${header.asnId}::uuid is not null and d.asn_id = ${header.asnId}::uuid then true
               when d.po_id is not null and d.po_id in (select id from chain) then true
               when d.po_id is null and d.asn_id is null and (select ok from single) then true
               else false
             end as "docPrinted"
      from gate_ins gi
      left join gate_in_documents d on d.tenant_id = gi.tenant_id and d.gate_in_id = gi.id
      where gi.tenant_id = ${tenantId}::uuid and gi.id = ${header.gateInId}::uuid
      order by d.position asc nulls last
    `)) as unknown as {
      gateInCode: string;
      vehicleNo: string | null;
      containerNo: string | null;
      transporterName: string | null;
      lrNumber: string | null;
      sealStatus: string;
      sealNumber: string | null;
      dockDoor: string | null;
      gatedInAt: string;
      unloadStartedAt: string | null;
      unloadEndedAt: string | null;
      docKind: string | null;
      docNumber: string | null;
      docDate: string | null;
      docEway: string | null;
      docPrinted: boolean | null;
    }[];
    const first = rows[0];
    if (first === undefined) return null;
    const instant = (value: string | null) => (value === null ? null : canonicalInstant(String(value)));
    const documents = rows
      .filter((row) => row.docPrinted === true)
      .map((row) => ({ kind: row.docKind!, number: row.docNumber!, date: row.docDate!, ewayBillNo: row.docEway }));
    return {
      gateInCode: first.gateInCode,
      vehicleNo: first.vehicleNo,
      containerNo: first.containerNo,
      transporterName: first.transporterName,
      lrNumber: first.lrNumber,
      sealStatus: first.sealStatus,
      sealNumber: first.sealNumber,
      dockDoor: first.dockDoor,
      gatedInAt: canonicalInstant(String(first.gatedInAt)),
      unloadStartedAt: instant(first.unloadStartedAt),
      unloadEndedAt: instant(first.unloadEndedAt),
      documents,
      documentsOmitted: rows.some((row) => row.docPrinted === false),
    };
  }
}
