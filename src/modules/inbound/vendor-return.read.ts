import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { vendorReturnLines, vendorReturns } from '../../shared/db/schema';
import type { VendorReturn, VendorReturnLine } from '../../shared/db/schema';
import { UUID_RE } from '../../shared/primitives/ids';
import { decodeCursor, encodeCursor } from '../../shared/primitives/pagination';
import { fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import type { BrandDocumentType } from '../../shared/primitives/consignment-capture';
import type { AddressSnapshot } from '../../shared/primitives/address';
import type { RegisteredAddressSnapshot } from '../../shared/primitives/registered-address';
import { getWarehouseCodeInTx, invoicePartyFactsInTx, memberDisplayNamesInTx } from '../tenancy/tenancy.service';
import type { ClientPartySnapshotV1 } from '../clients/clients.facade';
import type { TransporterSnapshotV1, VendorSnapshotV1 } from '../partners/partners.facade';
import type { RtvConsigneeAddressKind, RtvReasonCode, VendorReturnStatus } from './vendor-return.command';

/**
 * Story 2-8b — the return-to-vendor reads: the detail every command answers
 * (and stores as its idempotency snapshot), the list, the codes lookup the
 * ledger register prints, and the device snapshot's open RTVs. Free functions
 * over the caller's transaction; the facade composes the returnable read
 * (it needs the inventory and catalog facades).
 */

/** Frozen per line at create (A6) — what the note prints. */
export interface RtvItemSnapshotV1 {
  readonly skuCode: string;
  readonly name: string;
  readonly hsn: string | null;
  readonly uom: string;
  readonly batchCode: string | null;
  readonly batchExpiry: string | null;
}

/** Frozen at dispatch (A6) — the warehouse the goods left from. */
export interface RtvWarehouseSnapshotV1 {
  readonly v: 1;
  readonly code: string;
  readonly name: string;
  readonly gstin: string | null;
  readonly originAddress: AddressSnapshot | null;
  readonly operatorName: string;
}

export interface RtvActorStamp {
  readonly by: string;
  readonly byName: string | null;
  readonly at: string;
}

export interface VendorReturnLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly hsn: string | null;
  readonly uom: string;
  readonly batchId: string | null;
  readonly batchCode: string | null;
  readonly batchExpiry: string | null;
  readonly reasonCode: RtvReasonCode;
  readonly quantity: number;
  readonly pickedQuantity: number | null;
  readonly source: { readonly grnLineId: string; readonly grnId: string | null; readonly grnCode: string | null; readonly poCode: string | null } | null;
}

/** One return to vendor — the commands' answer and the detail read. */
export interface VendorReturnView {
  readonly id: string;
  readonly code: string;
  readonly status: VendorReturnStatus;
  readonly warehouseId: string;
  readonly warehouse: Omit<RtvWarehouseSnapshotV1, 'v'> & { readonly frozen: boolean };
  readonly clientId: string;
  readonly client: ClientPartySnapshotV1;
  readonly vendorId: string;
  readonly vendor: VendorSnapshotV1;
  readonly consigneeAddressKind: RtvConsigneeAddressKind;
  readonly consigneeAddress: RegisteredAddressSnapshot;
  readonly note: string | null;
  readonly created: RtvActorStamp;
  readonly picked: (RtvActorStamp & { readonly deviceId: string }) | null;
  readonly dispatch:
    | (RtvActorStamp & {
        readonly brandDocument: { readonly type: BrandDocumentType; readonly number: string; readonly date: string };
        readonly consignorGstin: string | null;
        readonly debitNoteNumber: string | null;
        readonly ewayBill: { readonly number: string; readonly date: string; readonly validUntil: string | null } | null;
        readonly transporterId: string | null;
        readonly transporter: TransporterSnapshotV1 | null;
        readonly carrierName: string | null;
        readonly vehicleNumber: string | null;
        readonly trackingRef: string | null;
        readonly packageCount: number;
      })
    | null;
  readonly cancellation: (RtvActorStamp & { readonly reason: string }) | null;
  readonly lines: readonly VendorReturnLineView[];
  readonly totalQuantity: number;
  readonly totalPickedQuantity: number | null;
}

export interface VendorReturnSummary {
  readonly id: string;
  readonly code: string;
  readonly status: VendorReturnStatus;
  readonly warehouseId: string;
  readonly clientId: string;
  readonly clientCode: string;
  readonly clientName: string;
  readonly vendorId: string;
  readonly vendorName: string;
  readonly lineCount: number;
  readonly totalQuantity: number;
  readonly totalPickedQuantity: number | null;
  readonly trackingRef: string | null;
  readonly brandDocumentNumber: string | null;
  readonly createdAt: string;
  readonly pickedAt: string | null;
  readonly dispatchedAt: string | null;
  readonly cancelledAt: string | null;
}

export function vendorReturnNotFound(id: string): ProblemException {
  return new ProblemException('not-found', 404, 'Return to vendor not found', `No return to vendor with id "${id}" exists in this tenant.`);
}

/** The vendor address the consignee kind names, or null when the snapshot has none. */
export function consigneeAddressOf(vendor: VendorSnapshotV1, kind: RtvConsigneeAddressKind): RegisteredAddressSnapshot | null {
  return kind === 'dispatch' ? vendor.dispatchAddress : vendor.registeredAddress;
}

/** The warehouse as it is now (before dispatch) — the shape the dispatch freezes. */
export async function liveWarehouseSnapshotInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<RtvWarehouseSnapshotV1> {
  const party = await invoicePartyFactsInTx(tx, tenantId, warehouseId);
  const code = await getWarehouseCodeInTx(tx, tenantId, warehouseId);
  return { v: 1, code, name: party.warehouseName, gstin: party.warehouseGstin, originAddress: party.originAddress, operatorName: party.tenantName };
}

function instantOrNull(value: string | null): string | null {
  return value === null ? null : canonicalInstant(value);
}

/**
 * The detail of ONE RTV, built on the caller's transaction (the commands
 * build their answer with it after their writes). Before dispatch the
 * warehouse is the live row; after, the frozen snapshot only.
 */
export async function vendorReturnViewInTx(tx: TenantTx, tenantId: string, vendorReturnId: string): Promise<VendorReturnView> {
  const rows = UUID_RE.test(vendorReturnId)
    ? await tx
        .select()
        .from(vendorReturns)
        .where(and(eq(vendorReturns.tenantId, tenantId), eq(vendorReturns.id, vendorReturnId)))
        .limit(1)
    : [];
  const row = rows[0];
  if (row === undefined) throw vendorReturnNotFound(vendorReturnId);
  const lines = await tx
    .select()
    .from(vendorReturnLines)
    .where(and(eq(vendorReturnLines.tenantId, tenantId), eq(vendorReturnLines.vendorReturnId, row.id)))
    .orderBy(asc(vendorReturnLines.lineNo));
  return composeView(tx, tenantId, row, lines);
}

async function composeView(tx: TenantTx, tenantId: string, row: VendorReturn, lines: readonly VendorReturnLine[]): Promise<VendorReturnView> {
  const vendor = row.vendorSnapshot as VendorSnapshotV1;
  const kind = row.consigneeAddressKind as RtvConsigneeAddressKind;
  const frozenWarehouse = row.warehouseSnapshot as RtvWarehouseSnapshotV1 | null;
  const warehouse = frozenWarehouse ?? (await liveWarehouseSnapshotInTx(tx, tenantId, row.warehouseId));
  const names = await memberDisplayNamesInTx(
    tx,
    tenantId,
    [row.createdBy, row.pickedBy, row.dispatchedBy, row.cancelledBy].filter((id): id is string => id !== null),
  );
  const sourceIds = lines.flatMap((line) => (line.grnLineId === null ? [] : [line.grnLineId]));
  const sources = await grnLineSourceLabelsInTx(tx, tenantId, sourceIds);
  const client = row.clientSnapshot as ClientPartySnapshotV1;
  const lineViews: VendorReturnLineView[] = lines.map((line) => {
    const item = line.itemSnapshot as RtvItemSnapshotV1;
    const source = line.grnLineId === null ? null : (sources.get(line.grnLineId) ?? { grnId: null, grnCode: null, poCode: null });
    return {
      id: line.id,
      lineNo: line.lineNo,
      skuId: line.skuId,
      skuCode: item.skuCode,
      skuName: item.name,
      hsn: item.hsn,
      uom: item.uom,
      batchId: line.batchId,
      batchCode: item.batchCode,
      batchExpiry: item.batchExpiry,
      reasonCode: line.reasonCode as RtvReasonCode,
      quantity: fromMilli(line.qty),
      pickedQuantity: line.pickedQty === null ? null : fromMilli(line.pickedQty),
      source: line.grnLineId === null || source === null ? null : { grnLineId: line.grnLineId, ...source },
    };
  });
  const picked = lines.every((line) => line.pickedQty !== null);
  return {
    id: row.id,
    code: row.code,
    status: row.status as VendorReturnStatus,
    warehouseId: row.warehouseId,
    warehouse: {
      code: warehouse.code,
      name: warehouse.name,
      gstin: warehouse.gstin,
      originAddress: warehouse.originAddress,
      operatorName: warehouse.operatorName,
      frozen: frozenWarehouse !== null,
    },
    clientId: row.clientId,
    client,
    vendorId: row.vendorId,
    vendor,
    consigneeAddressKind: kind,
    // The create refused a kind the snapshot lacks, so this is never null.
    consigneeAddress: consigneeAddressOf(vendor, kind)!,
    note: row.note,
    created: { by: row.createdBy, byName: names.get(row.createdBy) ?? null, at: canonicalInstant(row.createdAt) },
    picked:
      row.pickedBy === null || row.pickedAt === null || row.pickedDeviceId === null
        ? null
        : { by: row.pickedBy, byName: names.get(row.pickedBy) ?? null, at: canonicalInstant(row.pickedAt), deviceId: row.pickedDeviceId },
    dispatch:
      row.status !== 'dispatched' || row.dispatchedBy === null || row.dispatchedAt === null
        ? null
        : {
            by: row.dispatchedBy,
            byName: names.get(row.dispatchedBy) ?? null,
            at: canonicalInstant(row.dispatchedAt),
            brandDocument: {
              type: row.brandDocumentType as BrandDocumentType,
              number: row.brandDocumentNumber!,
              date: row.brandDocumentDate!,
            },
            consignorGstin: row.consignorGstin ?? client.gstin,
            debitNoteNumber: row.debitNoteNumber,
            ewayBill:
              row.ewayBillNumber === null || row.ewayBillDate === null
                ? null
                : { number: row.ewayBillNumber, date: row.ewayBillDate, validUntil: row.ewayValidUntil },
            transporterId: row.transporterId,
            transporter: (row.transporterSnapshot as TransporterSnapshotV1 | null) ?? null,
            carrierName: row.carrierName,
            vehicleNumber: row.vehicleNumber,
            trackingRef: row.trackingRef,
            packageCount: row.packageCount!,
          },
    cancellation:
      row.cancelledBy === null || row.cancelledAt === null || row.cancelReason === null
        ? null
        : { by: row.cancelledBy, byName: names.get(row.cancelledBy) ?? null, at: canonicalInstant(row.cancelledAt), reason: row.cancelReason },
    lines: lineViews,
    totalQuantity: fromMilli(lines.reduce((sum, line) => sum + line.qty, 0)),
    totalPickedQuantity: picked && lines.length > 0 ? fromMilli(lines.reduce((sum, line) => sum + (line.pickedQty ?? 0), 0)) : null,
  };
}

/** GRN line → its GRN's id and code and the PO's code (the line's source label). */
export async function grnLineSourceLabelsInTx(
  tx: TenantTx,
  tenantId: string,
  grnLineIds: readonly string[],
): Promise<Map<string, { grnId: string; grnCode: string; poCode: string | null }>> {
  const ids = [...new Set(grnLineIds)].filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    select gl.id::text as "grnLineId", g.id::text as "grnId", g.code as "grnCode", po.code as "poCode"
    from goods_receipt_lines gl
    join goods_receipt_notes g on g.tenant_id = gl.tenant_id and g.id = gl.grn_id
    left join purchase_orders po on po.tenant_id = g.tenant_id and po.id = g.po_id
    where gl.tenant_id = ${tenantId}::uuid and gl.id = any(${sql.param(ids)}::uuid[])
  `)) as unknown as { grnLineId: string; grnId: string; grnCode: string; poCode: string | null }[];
  return new Map(rows.map((row) => [row.grnLineId, { grnId: row.grnId, grnCode: row.grnCode, poCode: row.poCode }]));
}

/**
 * The facts of GRN lines a return to vendor can name as its source: the
 * line's warehouse, SKU and batch, the PO's vendor, and the quantities that
 * reached DAMAGED — `damaged_qty` (2-4a) plus the failed rows of the line's
 * INSPECTED receipt holds (2-8a, through `qc_inspections.hold_id` →
 * `qc_holds.grn_line_id`). ONE definition: the create's source cap and the
 * returnable read both use it.
 */
export interface GrnLineSourceFacts {
  readonly grnLineId: string;
  readonly grnId: string;
  readonly grnCode: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly batchId: string | null;
  readonly poId: string | null;
  readonly poCode: string | null;
  readonly poVendorId: string | null;
  readonly poVendorName: string | null;
  readonly damagedMilli: number;
  readonly damageReason: string | null;
  readonly qcFailedMilli: number;
  readonly qcFailReason: string | null;
}

export async function grnLineSourceFactsInTx(tx: TenantTx, tenantId: string, grnLineIds: readonly string[]): Promise<Map<string, GrnLineSourceFacts>> {
  const ids = [...new Set(grnLineIds)].filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    select gl.id::text as "grnLineId", g.id::text as "grnId", g.code as "grnCode", g.warehouse_id::text as "warehouseId",
           gl.sku_id::text as "skuId", gl.batch_id::text as "batchId",
           g.po_id::text as "poId", po.code as "poCode", po.vendor_id::text as "poVendorId",
           coalesce(po.vendor_snapshot ->> 'name', null) as "poVendorName",
           gl.damaged_qty::text as "damagedMilli", gl.damage_reason_code as "damageReason",
           coalesce(f.failed, 0)::text as "qcFailedMilli", f.reason as "qcFailReason"
    from goods_receipt_lines gl
    join goods_receipt_notes g on g.tenant_id = gl.tenant_id and g.id = gl.grn_id
    left join purchase_orders po on po.tenant_id = g.tenant_id and po.id = g.po_id
    left join lateral (
      select sum(qil.quantity)::bigint as failed, min(qil.fail_reason) as reason
      from qc_holds h
      join qc_inspections qi on qi.tenant_id = h.tenant_id and qi.hold_id = h.id
      join qc_inspection_lines qil on qil.tenant_id = qi.tenant_id and qil.inspection_id = qi.id and qil.outcome = 'failed'
      where h.tenant_id = gl.tenant_id and h.grn_line_id = gl.id and h.kind = 'receipt' and h.status = 'inspected'
    ) f on true
    where gl.tenant_id = ${tenantId}::uuid and gl.id = any(${sql.param(ids)}::uuid[])
  `)) as unknown as (Omit<GrnLineSourceFacts, 'damagedMilli' | 'qcFailedMilli'> & { damagedMilli: string; qcFailedMilli: string })[];
  return new Map(
    rows.map((row) => [row.grnLineId, { ...row, damagedMilli: Number(row.damagedMilli), qcFailedMilli: Number(row.qcFailedMilli) }]),
  );
}

/** RTV id → code (the ledger register's reference summary; unknown or malformed ids absent). */
export async function vendorReturnCodesByIdsInTx(tx: TenantTx, tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const valid = [...new Set(ids)].filter((id) => UUID_RE.test(id));
  if (valid.length === 0) return new Map();
  const rows = await tx
    .select({ id: vendorReturns.id, code: vendorReturns.code })
    .from(vendorReturns)
    .where(and(eq(vendorReturns.tenantId, tenantId), inArray(vendorReturns.id, valid)));
  return new Map(rows.map((row) => [row.id, row.code]));
}

/** RTV id → its code and frozen vendor name (the recall trace's `returned_to_vendor` rows). */
export async function vendorReturnTraceFactsInTx(
  tx: TenantTx,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, { code: string; vendorName: string }>> {
  const valid = [...new Set(ids)].filter((id) => UUID_RE.test(id));
  if (valid.length === 0) return new Map();
  const rows = await tx
    .select({ id: vendorReturns.id, code: vendorReturns.code, vendorSnapshot: vendorReturns.vendorSnapshot })
    .from(vendorReturns)
    .where(and(eq(vendorReturns.tenantId, tenantId), inArray(vendorReturns.id, valid)));
  return new Map(
    rows.map((row) => {
      const vendor = row.vendorSnapshot as VendorSnapshotV1;
      return [row.id, { code: row.code, vendorName: vendor.legalName ?? vendor.name }];
    }),
  );
}

export interface VendorReturnListQuery {
  readonly warehouseId?: string | undefined;
  readonly clientId?: string | undefined;
  readonly status?: VendorReturnStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const DEFAULT_RTV_PAGE_SIZE = 50;

/** The list: newest first, keyset on `(created_at, id)` with the full-precision instant (§7a). */
export async function listVendorReturnsInTx(
  tx: TenantTx,
  tenantId: string,
  query: VendorReturnListQuery,
): Promise<{ items: VendorReturnSummary[]; nextCursor: string | null }> {
  const limit = query.limit ?? DEFAULT_RTV_PAGE_SIZE;
  let after: { createdAt: string; id: string } | null = null;
  if (query.cursor !== undefined) {
    try {
      after = decodeCursor(query.cursor);
    } catch {
      throw new ProblemException('invalid-cursor', 400, 'Invalid cursor', 'The cursor is malformed — start again from the first page.');
    }
    if (!UUID_RE.test(after.id) || Number.isNaN(Date.parse(after.createdAt))) {
      throw new ProblemException('invalid-cursor', 400, 'Invalid cursor', 'The cursor is malformed — start again from the first page.');
    }
  }
  const conditions = [eq(vendorReturns.tenantId, tenantId)];
  if (query.warehouseId !== undefined) conditions.push(eq(vendorReturns.warehouseId, query.warehouseId));
  if (query.clientId !== undefined) conditions.push(eq(vendorReturns.clientId, query.clientId));
  if (query.status !== undefined) conditions.push(eq(vendorReturns.status, query.status));
  if (after !== null) {
    conditions.push(
      or(
        lt(vendorReturns.createdAt, after.createdAt),
        and(eq(vendorReturns.createdAt, after.createdAt), lt(vendorReturns.id, after.id)),
      )!,
    );
  }
  const rows = await tx
    .select({
      id: vendorReturns.id,
      code: vendorReturns.code,
      status: vendorReturns.status,
      warehouseId: vendorReturns.warehouseId,
      clientId: vendorReturns.clientId,
      vendorId: vendorReturns.vendorId,
      clientSnapshot: vendorReturns.clientSnapshot,
      vendorSnapshot: vendorReturns.vendorSnapshot,
      trackingRef: vendorReturns.trackingRef,
      brandDocumentNumber: vendorReturns.brandDocumentNumber,
      createdAt: vendorReturns.createdAt,
      // The driver's raw text — microseconds — for the cursor (§7a, `fullPrecisionInstant`).
      createdAtText: sql<string>`${vendorReturns.createdAt}::text`,
      pickedAt: vendorReturns.pickedAt,
      dispatchedAt: vendorReturns.dispatchedAt,
      cancelledAt: vendorReturns.cancelledAt,
    })
    .from(vendorReturns)
    .where(and(...conditions))
    .orderBy(desc(vendorReturns.createdAt), desc(vendorReturns.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const totals =
    page.length === 0
      ? []
      : ((await tx.execute(sql`
          select vendor_return_id::text as "id", count(*)::int as "lines", sum(qty)::bigint::text as "qty",
                 case when bool_and(picked_qty is not null) then sum(picked_qty)::bigint::text end as "picked"
          from vendor_return_lines
          where tenant_id = ${tenantId}::uuid and vendor_return_id = any(${sql.param(page.map((row) => row.id))}::uuid[])
          group by vendor_return_id
        `)) as unknown as { id: string; lines: number; qty: string; picked: string | null }[]);
  const byId = new Map(totals.map((row) => [row.id, row]));
  const items = page.map((row) => {
    const total = byId.get(row.id);
    const client = row.clientSnapshot as ClientPartySnapshotV1;
    const vendor = row.vendorSnapshot as VendorSnapshotV1;
    return {
      id: row.id,
      code: row.code,
      status: row.status as VendorReturnStatus,
      warehouseId: row.warehouseId,
      clientId: row.clientId,
      clientCode: client.code,
      clientName: client.name,
      vendorId: row.vendorId,
      vendorName: vendor.name,
      lineCount: Number(total?.lines ?? 0),
      totalQuantity: fromMilli(Number(total?.qty ?? 0)),
      totalPickedQuantity: total?.picked === null || total?.picked === undefined ? null : fromMilli(Number(total.picked)),
      trackingRef: row.trackingRef,
      brandDocumentNumber: row.brandDocumentNumber,
      createdAt: canonicalInstant(row.createdAt),
      pickedAt: instantOrNull(row.pickedAt),
      dispatchedAt: instantOrNull(row.dispatchedAt),
      cancelledAt: instantOrNull(row.cancelledAt),
    };
  });
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeCursor({ createdAt: fullPrecisionInstant(last.createdAtText), id: last.id }) : null;
  return { items, nextCursor };
}

/** One open (draft) RTV as the device snapshot carries it — the handheld's pick list. */
export interface OpenVendorReturnView {
  readonly id: string;
  readonly kind: 'vendor';
  readonly code: string;
  readonly vendorName: string;
  readonly clientId: string;
  readonly createdAt: string;
  readonly lines: readonly {
    readonly id: string;
    readonly lineNo: number;
    readonly skuId: string;
    readonly skuCode: string;
    readonly skuName: string;
    readonly batchCode: string | null;
    readonly uom: string;
    readonly qty: number;
  }[];
}

/** The warehouse's DRAFT RTVs (the pick work), oldest first — the device snapshot arm (decision 11). */
export async function openVendorReturnsInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<OpenVendorReturnView[]> {
  const rows = await tx
    .select()
    .from(vendorReturns)
    .where(and(eq(vendorReturns.tenantId, tenantId), eq(vendorReturns.warehouseId, warehouseId), eq(vendorReturns.status, 'draft')))
    .orderBy(asc(vendorReturns.createdAt), asc(vendorReturns.id));
  if (rows.length === 0) return [];
  const lines = await tx
    .select()
    .from(vendorReturnLines)
    .where(and(eq(vendorReturnLines.tenantId, tenantId), inArray(vendorReturnLines.vendorReturnId, rows.map((row) => row.id))))
    .orderBy(asc(vendorReturnLines.vendorReturnId), asc(vendorReturnLines.lineNo));
  const byRtv = new Map<string, VendorReturnLine[]>();
  for (const line of lines) {
    const list = byRtv.get(line.vendorReturnId) ?? [];
    list.push(line);
    byRtv.set(line.vendorReturnId, list);
  }
  return rows.map((row) => ({
    id: row.id,
    kind: 'vendor' as const,
    code: row.code,
    vendorName: (row.vendorSnapshot as VendorSnapshotV1).name,
    clientId: row.clientId,
    createdAt: canonicalInstant(row.createdAt),
    lines: (byRtv.get(row.id) ?? []).map((line) => {
      const item = line.itemSnapshot as RtvItemSnapshotV1;
      return {
        id: line.id,
        lineNo: line.lineNo,
        skuId: line.skuId,
        skuCode: item.skuCode,
        skuName: item.name,
        batchCode: item.batchCode,
        uom: item.uom,
        qty: fromMilli(line.qty),
      };
    }),
  }));
}
