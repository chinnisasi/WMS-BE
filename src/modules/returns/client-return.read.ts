import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { clientReturnLines, clientReturns, returnAuthorizations } from '../../shared/db/schema';
import type { ClientReturnLineRow, ClientReturnRow } from '../../shared/db/schema';
import { UUID_RE } from '../../shared/primitives/ids';
import { decodeCursor, encodeCursor } from '../../shared/primitives/pagination';
import type { CursorPayload, Page } from '../../shared/primitives/pagination';
import { portalPageByCreatedAt } from '../../shared/primitives/portal-page';
import { fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import type { AddressSnapshot } from '../../shared/primitives/address';
import type { BrandDocumentType } from '../../shared/primitives/consignment-capture';
import { getWarehouseCodeInTx, invoicePartyFactsInTx, memberDisplayNamesInTx } from '../tenancy/tenancy.service';
import type { ClientPartySnapshotV1 } from '../clients/clients.facade';
import type { TransporterSnapshotV1 } from '../partners/partners.facade';
import type { ReturnCondition } from './return-receipt.command';
import type { ReturnDispositionReason } from './return-disposition.command';

/**
 * Story 4-7c — the return-to-client reads: the detail every command answers
 * (and stores as its idempotency snapshot), the list, the codes lookup the
 * ledger register prints, the device snapshot's open RTCs and the client
 * portal's two reads. Free functions over the caller's transaction; the
 * facade composes the returnable read (it needs the catalog and inventory
 * facades).
 */

/** Decision 4 — the lifecycle; dispatched and cancelled are terminal. Mirrored by `client_returns_status_check` (0113). */
export const CLIENT_RETURN_STATUSES = ['draft', 'picked', 'dispatched', 'cancelled'] as const;
export type ClientReturnStatus = (typeof CLIENT_RETURN_STATUSES)[number];

/** Decision 5/6 — where a line's units come from. Mirrored by `client_return_lines_source_check`. */
export const RTC_LINE_SOURCES = ['damaged', 'returns'] as const;
export type RtcLineSource = (typeof RTC_LINE_SOURCES)[number];

/** Decision 7 — which client address is the consignee. Mirrored by `client_returns_consignee_address_kind_check`. */
export const RTC_ADDRESS_KINDS = ['return', 'registered'] as const;
export type RtcAddressKind = (typeof RTC_ADDRESS_KINDS)[number];

/**
 * A2 — the consignee address as frozen at create, every key present. From
 * the return address `stateCode` is null (1-2a stores its state as free
 * text); from the registered address `contactName`, `phone` and `state` are.
 */
export interface ConsigneeAddressV1 {
  readonly v: 1;
  readonly kind: RtcAddressKind;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly state: string | null;
  readonly stateCode: string | null;
  readonly pincode: string;
}

/** Frozen per line at create (decision 7, A9) — what the note prints. */
export interface RtcItemSnapshotV1 {
  readonly skuCode: string;
  readonly name: string;
  readonly hsn: string | null;
  readonly uom: string;
  readonly batchCode: string | null;
  readonly batchExpiry: string | null;
  readonly serialNumber: string | null;
  readonly rmaCode: string | null;
  /** A9 — the receipt grade (returns lines); null on a DAMAGED line. */
  readonly condition: ReturnCondition | null;
  /** A9 — the RMA's order reference (returns lines); null otherwise. */
  readonly orderReference: string | null;
}

/** D7 — the warehouse the goods left from, frozen at dispatch (2-8b's shape, built from the same tenancy helpers). */
export interface ClientReturnWarehouseSnapshotV1 {
  readonly v: 1;
  readonly code: string;
  readonly name: string;
  readonly gstin: string | null;
  readonly originAddress: AddressSnapshot | null;
  readonly operatorName: string;
}

export interface RtcActorStamp {
  readonly by: string;
  readonly byName: string | null;
  readonly at: string;
}

export interface ClientReturnLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly source: RtcLineSource;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly hsn: string | null;
  readonly uom: string;
  readonly batchId: string | null;
  readonly batchCode: string | null;
  readonly batchExpiry: string | null;
  readonly serialId: string | null;
  readonly serialNumber: string | null;
  readonly returnReceiptLineId: string | null;
  readonly rmaId: string | null;
  readonly rmaCode: string | null;
  readonly orderReference: string | null;
  readonly condition: ReturnCondition | null;
  readonly reasonCode: ReturnDispositionReason;
  readonly quantity: number;
  readonly pickedQuantity: number | null;
}

export type ConsigneeAddressView = Omit<ConsigneeAddressV1, 'v'>;

/** One return to client — the commands' answer and the detail read. */
export interface ClientReturnView {
  readonly id: string;
  readonly code: string;
  readonly status: ClientReturnStatus;
  readonly warehouseId: string;
  readonly warehouse: Omit<ClientReturnWarehouseSnapshotV1, 'v'> & { readonly frozen: boolean };
  readonly clientId: string;
  readonly client: ClientPartySnapshotV1;
  readonly consigneeAddressKind: RtcAddressKind;
  readonly consigneeAddress: ConsigneeAddressView;
  readonly note: string | null;
  readonly created: RtcActorStamp;
  readonly picked: (RtcActorStamp & { readonly deviceId: string }) | null;
  readonly dispatch:
    | (RtcActorStamp & {
        readonly brandDocument: { readonly type: BrandDocumentType; readonly number: string; readonly date: string };
        /** As entered at dispatch, else the brand's frozen GSTIN; null when neither (the note prints "Unregistered"). */
        readonly consignorGstin: string | null;
        /** A2 — as entered at dispatch, else the brand's frozen GSTIN; null when neither. */
        readonly consigneeGstin: string | null;
        readonly declaredValuePaise: number | null;
        /** Story 4-6a (A41) — no value was sent, so the e-way threshold was not judged. Optional: older views lack it. */
        readonly ewayUnjudged?: boolean;
        readonly ewayBill: { readonly number: string; readonly date: string; readonly validUntil: string | null } | null;
        readonly transporterId: string | null;
        readonly transporter: TransporterSnapshotV1 | null;
        readonly carrierName: string | null;
        readonly vehicleNumber: string | null;
        readonly trackingRef: string | null;
        readonly packageCount: number;
      })
    | null;
  readonly cancellation: (RtcActorStamp & { readonly reason: string }) | null;
  readonly lines: readonly ClientReturnLineView[];
  readonly totalQuantity: number;
  readonly totalPickedQuantity: number | null;
}

export interface ClientReturnSummary {
  readonly id: string;
  readonly code: string;
  readonly status: ClientReturnStatus;
  readonly warehouseId: string;
  readonly clientId: string;
  readonly clientCode: string;
  readonly clientName: string;
  readonly consigneeAddressKind: RtcAddressKind;
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

export function clientReturnNotFound(id: string): ProblemException {
  return new ProblemException('not-found', 404, 'Return to client not found', `No return to client with id "${id}" exists in this tenant.`);
}

/** D7 — the warehouse as it is now (before dispatch) — the shape the dispatch freezes. */
export async function liveClientReturnWarehouseInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<ClientReturnWarehouseSnapshotV1> {
  const party = await invoicePartyFactsInTx(tx, tenantId, warehouseId);
  const code = await getWarehouseCodeInTx(tx, tenantId, warehouseId);
  return { v: 1, code, name: party.warehouseName, gstin: party.warehouseGstin, originAddress: party.originAddress, operatorName: party.tenantName };
}

function instantOrNull(value: string | null): string | null {
  return value === null ? null : canonicalInstant(value);
}

function addressView(address: ConsigneeAddressV1): ConsigneeAddressView {
  return {
    kind: address.kind,
    contactName: address.contactName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    stateCode: address.stateCode,
    pincode: address.pincode,
  };
}

/**
 * The detail of ONE RTC, built on the caller's transaction (the commands
 * build their answer with it after their writes). Before dispatch the
 * warehouse is the live row; after, the frozen snapshot only.
 */
export async function clientReturnViewInTx(tx: TenantTx, tenantId: string, clientReturnId: string): Promise<ClientReturnView> {
  const rows = UUID_RE.test(clientReturnId)
    ? await tx
        .select()
        .from(clientReturns)
        .where(and(eq(clientReturns.tenantId, tenantId), eq(clientReturns.id, clientReturnId)))
        .limit(1)
    : [];
  const row = rows[0];
  if (row === undefined) throw clientReturnNotFound(clientReturnId);
  const lines = await tx
    .select()
    .from(clientReturnLines)
    .where(and(eq(clientReturnLines.tenantId, tenantId), eq(clientReturnLines.clientReturnId, row.id)))
    .orderBy(asc(clientReturnLines.lineNo));
  return composeView(tx, tenantId, row, lines);
}

function lineView(line: ClientReturnLineRow): ClientReturnLineView {
  const item = line.itemSnapshot as RtcItemSnapshotV1;
  return {
    id: line.id,
    lineNo: line.lineNo,
    source: line.source as RtcLineSource,
    skuId: line.skuId,
    skuCode: item.skuCode,
    skuName: item.name,
    hsn: item.hsn,
    uom: item.uom,
    batchId: line.batchId,
    batchCode: item.batchCode,
    batchExpiry: item.batchExpiry,
    serialId: line.serialId,
    serialNumber: item.serialNumber,
    returnReceiptLineId: line.returnReceiptLineId,
    rmaId: line.rmaId,
    rmaCode: item.rmaCode,
    orderReference: item.orderReference,
    condition: item.condition,
    reasonCode: line.reasonCode as ReturnDispositionReason,
    quantity: fromMilli(line.qty),
    pickedQuantity: line.pickedQty === null ? null : fromMilli(line.pickedQty),
  };
}

async function composeView(tx: TenantTx, tenantId: string, row: ClientReturnRow, lines: readonly ClientReturnLineRow[]): Promise<ClientReturnView> {
  const frozenWarehouse = row.warehouseSnapshot as ClientReturnWarehouseSnapshotV1 | null;
  const warehouse = frozenWarehouse ?? (await liveClientReturnWarehouseInTx(tx, tenantId, row.warehouseId));
  const names = await memberDisplayNamesInTx(
    tx,
    tenantId,
    [row.createdBy, row.pickedBy, row.dispatchedBy, row.cancelledBy].filter((id): id is string => id !== null),
  );
  const client = row.clientSnapshot as ClientPartySnapshotV1;
  const picked = lines.every((line) => line.pickedQty !== null);
  return {
    id: row.id,
    code: row.code,
    status: row.status as ClientReturnStatus,
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
    consigneeAddressKind: row.consigneeAddressKind as RtcAddressKind,
    consigneeAddress: addressView(row.consigneeAddress as ConsigneeAddressV1),
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
            consigneeGstin: row.consigneeGstin ?? client.gstin,
            declaredValuePaise: row.declaredValuePaise,
            ewayUnjudged: row.declaredValuePaise === null,
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
    lines: lines.map(lineView),
    totalQuantity: fromMilli(lines.reduce((sum, line) => sum + line.qty, 0)),
    totalPickedQuantity: picked && lines.length > 0 ? fromMilli(lines.reduce((sum, line) => sum + (line.pickedQty ?? 0), 0)) : null,
  };
}

/** RTC id → code (the ledger register's reference summary; unknown or malformed ids absent). */
export async function clientReturnCodesByIdsInTx(tx: TenantTx, tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const valid = [...new Set(ids)].filter((id) => UUID_RE.test(id));
  if (valid.length === 0) return new Map();
  const rows = await tx
    .select({ id: clientReturns.id, code: clientReturns.code })
    .from(clientReturns)
    .where(and(eq(clientReturns.tenantId, tenantId), inArray(clientReturns.id, valid)));
  return new Map(rows.map((row) => [row.id, row.code]));
}

/** RMA id → its code and order reference (the frozen line identity). */
export async function rmaFactsByIdsInTx(
  tx: TenantTx,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, { code: string; orderReference: string | null }>> {
  const valid = [...new Set(ids)];
  if (valid.length === 0) return new Map();
  const rows = await tx
    .select({ id: returnAuthorizations.id, code: returnAuthorizations.code, orderReference: returnAuthorizations.orderReference })
    .from(returnAuthorizations)
    .where(and(eq(returnAuthorizations.tenantId, tenantId), inArray(returnAuthorizations.id, valid)));
  return new Map(rows.map((row) => [row.id, { code: row.code, orderReference: row.orderReference }]));
}

export interface ClientReturnListQuery {
  readonly warehouseId?: string | undefined;
  readonly clientId?: string | undefined;
  readonly status?: ClientReturnStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const DEFAULT_RTC_PAGE_SIZE = 50;

function decodeListCursor(cursor: string): { createdAt: string; id: string } {
  let after: { createdAt: string; id: string };
  try {
    after = decodeCursor(cursor);
  } catch {
    throw new ProblemException('invalid-cursor', 400, 'Invalid cursor', 'The cursor is malformed — start again from the first page.');
  }
  if (!UUID_RE.test(after.id) || Number.isNaN(Date.parse(after.createdAt))) {
    throw new ProblemException('invalid-cursor', 400, 'Invalid cursor', 'The cursor is malformed — start again from the first page.');
  }
  return after;
}

/** Per RTC: line count, Σ qty, and Σ picked once every line is picked (milli, as text). */
async function totalsByRtcInTx(tx: TenantTx, tenantId: string, ids: readonly string[]): Promise<Map<string, { lines: number; qty: string; picked: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    select client_return_id::text as "id", count(*)::int as "lines", sum(qty)::bigint::text as "qty",
           case when bool_and(picked_qty is not null) then sum(picked_qty)::bigint::text end as "picked"
    from client_return_lines
    where tenant_id = ${tenantId}::uuid and client_return_id = any(${sql.param([...ids])}::uuid[])
    group by client_return_id
  `)) as unknown as { id: string; lines: number; qty: string; picked: string | null }[];
  return new Map(rows.map((row) => [row.id, row]));
}

/** The list: newest first, keyset on `(created_at, id)` with the full-precision instant (§7a). */
export async function listClientReturnsInTx(
  tx: TenantTx,
  tenantId: string,
  query: ClientReturnListQuery,
): Promise<{ items: ClientReturnSummary[]; nextCursor: string | null }> {
  const limit = query.limit ?? DEFAULT_RTC_PAGE_SIZE;
  const after = query.cursor === undefined ? null : decodeListCursor(query.cursor);
  const conditions = [eq(clientReturns.tenantId, tenantId)];
  if (query.warehouseId !== undefined) conditions.push(eq(clientReturns.warehouseId, query.warehouseId.toLowerCase()));
  if (query.clientId !== undefined) conditions.push(eq(clientReturns.clientId, query.clientId.toLowerCase()));
  if (query.status !== undefined) conditions.push(eq(clientReturns.status, query.status));
  if (after !== null) {
    conditions.push(
      or(lt(clientReturns.createdAt, after.createdAt), and(eq(clientReturns.createdAt, after.createdAt), lt(clientReturns.id, after.id)))!,
    );
  }
  const rows = await tx
    .select({
      id: clientReturns.id,
      code: clientReturns.code,
      status: clientReturns.status,
      warehouseId: clientReturns.warehouseId,
      clientId: clientReturns.clientId,
      clientSnapshot: clientReturns.clientSnapshot,
      consigneeAddressKind: clientReturns.consigneeAddressKind,
      trackingRef: clientReturns.trackingRef,
      brandDocumentNumber: clientReturns.brandDocumentNumber,
      createdAt: clientReturns.createdAt,
      createdAtText: sql<string>`${clientReturns.createdAt}::text`,
      pickedAt: clientReturns.pickedAt,
      dispatchedAt: clientReturns.dispatchedAt,
      cancelledAt: clientReturns.cancelledAt,
    })
    .from(clientReturns)
    .where(and(...conditions))
    .orderBy(desc(clientReturns.createdAt), desc(clientReturns.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const totals = await totalsByRtcInTx(
    tx,
    tenantId,
    page.map((row) => row.id),
  );
  const items = page.map((row) => {
    const total = totals.get(row.id);
    const client = row.clientSnapshot as ClientPartySnapshotV1;
    return {
      id: row.id,
      code: row.code,
      status: row.status as ClientReturnStatus,
      warehouseId: row.warehouseId,
      clientId: row.clientId,
      clientCode: client.code,
      clientName: client.name,
      consigneeAddressKind: row.consigneeAddressKind as RtcAddressKind,
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

/** A10 — one open (draft) RTC as the device snapshot carries it — the handheld's pick list. */
export interface OpenClientReturnView {
  readonly id: string;
  readonly kind: 'client';
  readonly code: string;
  readonly clientId: string;
  /** The brand's frozen name (the inbox card's party). */
  readonly clientName: string;
  readonly createdAt: string;
  readonly lines: readonly {
    readonly id: string;
    readonly lineNo: number;
    readonly source: RtcLineSource;
    readonly skuId: string;
    readonly skuCode: string;
    readonly skuName: string;
    readonly batchCode: string | null;
    readonly serialNumber: string | null;
    readonly uom: string;
    readonly qty: number;
    readonly rmaCode: string | null;
  }[];
}

/** Decision 13 — the warehouse's DRAFT RTCs (the pick work), oldest first — the device snapshot arm. */
export async function openClientReturnsInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<OpenClientReturnView[]> {
  const rows = await tx
    .select()
    .from(clientReturns)
    .where(and(eq(clientReturns.tenantId, tenantId), eq(clientReturns.warehouseId, warehouseId), eq(clientReturns.status, 'draft')))
    .orderBy(asc(clientReturns.createdAt), asc(clientReturns.id));
  if (rows.length === 0) return [];
  const lines = await tx
    .select()
    .from(clientReturnLines)
    .where(and(eq(clientReturnLines.tenantId, tenantId), inArray(clientReturnLines.clientReturnId, rows.map((row) => row.id))))
    .orderBy(asc(clientReturnLines.clientReturnId), asc(clientReturnLines.lineNo));
  const byRtc = new Map<string, ClientReturnLineRow[]>();
  for (const line of lines) {
    const list = byRtc.get(line.clientReturnId) ?? [];
    list.push(line);
    byRtc.set(line.clientReturnId, list);
  }
  return rows.map((row) => ({
    id: row.id,
    kind: 'client' as const,
    code: row.code,
    clientId: row.clientId,
    clientName: (row.clientSnapshot as ClientPartySnapshotV1).name,
    createdAt: canonicalInstant(row.createdAt),
    lines: (byRtc.get(row.id) ?? []).map((line) => {
      const item = line.itemSnapshot as RtcItemSnapshotV1;
      return {
        id: line.id,
        lineNo: line.lineNo,
        source: line.source as RtcLineSource,
        skuId: line.skuId,
        skuCode: item.skuCode,
        skuName: item.name,
        batchCode: item.batchCode,
        serialNumber: item.serialNumber,
        uom: item.uom,
        qty: fromMilli(line.qty),
        rmaCode: item.rmaCode,
      };
    }),
  }));
}

// ── the client portal (decision 15, A14) ─────────────────────────────────────

/** One of the client's RTCs — an exact allowlist: no user, device, bin, note or cancel reason. */
export interface PortalClientReturnRow {
  readonly id: string;
  readonly code: string;
  readonly status: ClientReturnStatus;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
  readonly lineCount: number;
  readonly totalQuantity: number;
  /** Σ picked once dispatched (what left), else null. */
  readonly shippedQuantity: number | null;
  readonly carrierName: string | null;
  readonly transporterName: string | null;
  readonly trackingRef: string | null;
  readonly packageCount: number | null;
}

export interface PortalClientReturnLine {
  readonly lineNo: number;
  readonly source: RtcLineSource;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly batchCode: string | null;
  readonly serialNumber: string | null;
  readonly rmaCode: string | null;
  readonly condition: ReturnCondition | null;
  readonly quantity: number;
  /** Once dispatched: what left on the line; null before. */
  readonly shippedQuantity: number | null;
}

export interface PortalClientReturnDetail extends PortalClientReturnRow {
  readonly consigneeAddress: ConsigneeAddressView;
  readonly vehicleNumber: string | null;
  readonly brandDocument: { readonly type: BrandDocumentType; readonly number: string; readonly date: string } | null;
  readonly ewayBillNumber: string | null;
  readonly lines: readonly PortalClientReturnLine[];
}

function portalRow(row: ClientReturnRow, total: { lines: number; qty: string; picked: string | null } | undefined): PortalClientReturnRow {
  const transporter = row.transporterSnapshot as TransporterSnapshotV1 | null;
  const dispatched = row.status === 'dispatched';
  return {
    id: row.id,
    code: row.code,
    status: row.status as ClientReturnStatus,
    createdAt: canonicalInstant(row.createdAt),
    dispatchedAt: instantOrNull(row.dispatchedAt),
    lineCount: Number(total?.lines ?? 0),
    totalQuantity: fromMilli(Number(total?.qty ?? 0)),
    shippedQuantity: dispatched && total?.picked !== null && total?.picked !== undefined ? fromMilli(Number(total.picked)) : null,
    carrierName: row.carrierName,
    transporterName: transporter === null ? null : transporter.name,
    trackingRef: row.trackingRef,
    packageCount: row.packageCount,
  };
}

/**
 * The client's RTCs, newest first (keyset `(created_at, id)` DESC). Runs in
 * the caller's CLIENT-STAMPED transaction (RLS) and carries
 * `client_returns.client_id = $client` (the predicate) — both layers.
 */
export async function portalClientReturnsInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  query: { readonly before: CursorPayload | null; readonly limit: number },
): Promise<Page<PortalClientReturnRow>> {
  const rows = await tx
    .select({ row: clientReturns, createdAtText: sql<string>`${clientReturns.createdAt}::text` })
    .from(clientReturns)
    .where(
      and(
        eq(clientReturns.tenantId, tenantId),
        eq(clientReturns.clientId, clientId),
        query.before === null
          ? undefined
          : sql`(${clientReturns.createdAt}, ${clientReturns.id}) < (${query.before.createdAt}::timestamptz, ${query.before.id}::uuid)`,
      ),
    )
    .orderBy(desc(clientReturns.createdAt), desc(clientReturns.id))
    .limit(query.limit + 1);
  const totals = await totalsByRtcInTx(
    tx,
    tenantId,
    rows.slice(0, query.limit).map((entry) => entry.row.id),
  );
  return portalPageByCreatedAt(
    rows.map((entry) => ({ id: entry.row.id, createdAtText: entry.createdAtText, row: entry.row })),
    query.limit,
    (entry) => portalRow(entry.row, totals.get(entry.row.id)),
  );
}

/** One of the client's RTCs; null for an unknown id and for another client's (the same 404). */
export async function portalClientReturnInTx(tx: TenantTx, tenantId: string, clientId: string, id: string): Promise<PortalClientReturnDetail | null> {
  if (!UUID_RE.test(id)) return null;
  const rows = await tx
    .select()
    .from(clientReturns)
    .where(and(eq(clientReturns.tenantId, tenantId), eq(clientReturns.clientId, clientId), eq(clientReturns.id, id.toLowerCase())))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  // The lines reach the client only through the stamped header (an inner join).
  const lines = await tx
    .select({ line: clientReturnLines })
    .from(clientReturnLines)
    .innerJoin(clientReturns, and(eq(clientReturns.tenantId, clientReturnLines.tenantId), eq(clientReturns.id, clientReturnLines.clientReturnId)))
    .where(and(eq(clientReturns.tenantId, tenantId), eq(clientReturns.clientId, clientId), eq(clientReturnLines.clientReturnId, row.id)))
    .orderBy(asc(clientReturnLines.lineNo));
  const totals = await totalsByRtcInTx(tx, tenantId, [row.id]);
  const dispatched = row.status === 'dispatched';
  return {
    ...portalRow(row, totals.get(row.id)),
    consigneeAddress: addressView(row.consigneeAddress as ConsigneeAddressV1),
    vehicleNumber: row.vehicleNumber,
    brandDocument:
      dispatched && row.brandDocumentType !== null && row.brandDocumentNumber !== null && row.brandDocumentDate !== null
        ? { type: row.brandDocumentType as BrandDocumentType, number: row.brandDocumentNumber, date: row.brandDocumentDate }
        : null,
    ewayBillNumber: row.ewayBillNumber,
    lines: lines.map(({ line }) => {
      const item = line.itemSnapshot as RtcItemSnapshotV1;
      return {
        lineNo: line.lineNo,
        source: line.source as RtcLineSource,
        skuCode: item.skuCode,
        skuName: item.name,
        uom: item.uom,
        batchCode: item.batchCode,
        serialNumber: item.serialNumber,
        rmaCode: item.rmaCode,
        condition: item.condition,
        quantity: fromMilli(line.qty),
        shippedQuantity: dispatched && line.pickedQty !== null ? fromMilli(line.pickedQty) : null,
      };
    }),
  };
}
