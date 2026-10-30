import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { freightConsignments, freightLoads, orders, type FreightConsignment, type Order } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { parcelTagCode } from '../../shared/primitives/parcel-tag';
import { canonicalInstant, isIsoDate, istMidnightOf, addIsoDays, nowIso } from '../../shared/primitives/time';
import { consignmentRef } from '../../shared/primitives/freight';
import { documentWarehousePartyOf, type DocumentWarehouseParty } from '../../shared/documents/parties';
import { renderLoadingSheetPdf, loadingSheetFileName, type LoadingSheetModel } from '../../shared/documents/loading-sheet.layout';
import { renderFreightNotePdf, freightNoteFileName, type FreightNoteAudience, type FreightNoteModel } from '../../shared/documents/freight-note.layout';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { getClientsInTx, type ClientPartySnapshotV1 } from '../clients/clients.facade';
import { ROLE_CAPABILITIES } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn, getWarehouseCodeInTx, invoicePartyFactsInTx, userEmailsInTx } from '../tenancy/tenancy.service';
import { AttachmentsFacade } from '../attachments/attachments.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import { dispatchedConsignmentRecordsOfOrdersInTx } from '../invoicing/consignment-seam';
import type { TransporterSnapshotV1 } from '../partners/partners.facade';
import { AllocationCommandService } from './allocation.command';
import { DispatchCommandService } from './dispatch.command';
import { parcelConsignmentsInTx, consignmentTodayIst, type ParcelConsignment } from './consignment.read';
import { decodeKeyset, encodeKeyset, type UnsignedFile } from './shipping.read';
import type { FileView } from './shipping.service';
import { FreightLoadCommand, type CreateFreightLoadCommand, type FreightLoadSnapshot, type FreightOrdersCommand, type FreightScanSnapshot, type RecordFreightScanCommand, type RemoveFreightOrderCommand, type CancelFreightLoadCommand, type UpdateFreightLoadCommand } from './freight-load.command';
import { FreightDispatchCommand, type DispatchFreightLoadCommand, type FreightDispatchSnapshot } from './freight-dispatch.command';
import { FreightConsignmentCommand, type FreightConsignmentSnapshot, type RecordFreightDeliveryCommand, type RecordFreightLrCommand } from './freight-consignment.command';
import {
  deliveryViewOf,
  freightLoadViewInTx,
  loadedScansOfConsignmentsInTx,
  packageSetsOfOrdersInTx,
  progressOf,
  readLoadInTx,
  type CarriageSnapshotV1,
  type FreightDeliveryView,
  type FreightLoadView,
  type PackMeasurementsReader,
} from './freight.read';
import type { FreightCandidateStatus, FreightListView, PortalFreightStatus } from './freight-vocabulary';

/**
 * Story 4-9a — the freight service the outbound facade delegates to: the
 * commands (and the departure's after-commit work — counter restores and the
 * follow-on allocations, never thrown), the staff reads (A20, A21 — the sheet
 * pages signed after the read), the two prints (A25, A26), the portal's
 * freight facts (A22) and the device snapshot's open loads (A23, A56).
 */

export const FREIGHT_LIST_DEFAULT_LIMIT = 50;
export const FREIGHT_LIST_MAX_LIMIT = 100;
/** A20 — the candidates read scans at most this many orders (`truncated` beyond). */
export const FREIGHT_CANDIDATES_SCAN = 2_000;
export const FREIGHT_CANDIDATES_DEFAULT_LIMIT = 200;
export const FREIGHT_CANDIDATES_MAX_LIMIT = 500;
/** A56 — the handheld carries at most this many open loads… */
export const DEVICE_FREIGHT_LOADS_MAX = 50;
/** …and at most this many loaded codes in all (A23). */
export const DEVICE_FREIGHT_CODES_MAX = 20_000;

export interface FreightLoadListRow {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly mode: string;
  readonly transporterName: string;
  readonly vehicleNumber: string | null;
  readonly dockDoor: string | null;
  readonly consignmentCount: number;
  readonly clientCodes: readonly string[];
  readonly clientMore: number;
  readonly packages: { readonly loaded: number; readonly total: number };
  readonly palletCount: number;
  readonly grossWeightGrams: number | null;
  readonly capacityKg: number | null;
  readonly dispatchedAt: string | null;
  readonly deliveredCount: number;
  readonly createdAt: string;
}

export interface FreightLoadListQuery {
  readonly view?: FreightListView | undefined;
  readonly clientId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface FreightCandidate {
  readonly orderId: string;
  readonly orderLabel: string;
  readonly clientId: string;
  readonly clientCode: string;
  readonly status: string;
  readonly consignee: { readonly name: string | null; readonly city: string | null; readonly state: string | null; readonly pincode: string | null };
  readonly packages: { readonly cartons: number; readonly pallets: number; readonly packed: boolean };
  readonly grossWeightGrams: number | null;
  readonly consignment?: { readonly state: string; readonly blocking: boolean };
}

export interface FreightCandidatesQuery {
  readonly clientId?: string | undefined;
  readonly state?: string | undefined;
  readonly city?: string | undefined;
  readonly pincode?: string | undefined;
  readonly status?: FreightCandidateStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** A20 — the order's freight block on the staff shipping read. */
export interface OrderFreightBlock {
  readonly consignmentId: string;
  readonly loadId: string;
  readonly loadCode: string;
  readonly consignmentRef: string;
  readonly status: string;
  readonly stopSeq: number;
  readonly lrNumber: string | null;
  readonly lrDate: string | null;
  readonly freightTerms: string | null;
  readonly transporterName: string;
  readonly vehicleNumber: string | null;
  readonly dispatchedAt: string | null;
  readonly packageCount: number | null;
  readonly loadedPackageCount: number | null;
  readonly loadException: string | null;
  readonly delivery: { readonly outcome: string; readonly deliveredAt: string; readonly receiverName: string | null; readonly short: number | null; readonly damaged: number | null; readonly note: string | null; readonly deliverySeq: number } | null;
}

/** A22 — the portal's freight block: an exact key allowlist; while planned, only the status. */
export interface PortalFreightBlock {
  readonly status: PortalFreightStatus;
  readonly consignmentRef?: string;
  readonly transporterName?: string;
  readonly vehicleNumber?: string;
  readonly containerNumber?: string | null;
  readonly seals?: readonly string[] | null;
  readonly driverName?: string;
  readonly lrNumber?: string | null;
  readonly lrDate?: string | null;
  readonly freightTerms?: string | null;
  readonly packageCount?: number;
  readonly palletCount?: number;
  readonly weightGrams?: number | null;
  readonly dispatchedAt?: string;
  readonly deliveredAt?: string | null;
  readonly receiverName?: string | null;
  readonly shortPackageCount?: number | null;
  readonly damagedPackageCount?: number | null;
  readonly deliveryNote?: string | null;
  readonly noteAvailable?: boolean;
}

/** A23 — one open load as the handheld snapshot carries it. */
export interface DeviceFreightLoad {
  readonly loadId: string;
  readonly code: string;
  readonly mode: string;
  readonly transporterName: string;
  readonly vehicleNumber: string | null;
  readonly driverName: string | null;
  readonly dockDoor: string | null;
  readonly consignments: readonly {
    readonly consignmentId: string;
    readonly orderId: string;
    readonly clientId: string;
    readonly orderLabel: string;
    readonly parcelTagCode: string;
    readonly packSeq: number | null;
    readonly packageCount: number | null;
    readonly palletCount: number;
    readonly stopSeq: number;
    readonly lrNumber: string | null;
    readonly consignment?: ParcelConsignment;
  }[];
  readonly loadedCodes: readonly string[];
}

function instant(value: string | null): string | null {
  return value === null ? null : canonicalInstant(value);
}

function addressLinesOf(address: { line1?: string; line2?: string | null; city?: string; state?: string; stateCode?: string; pincode?: string } | null | undefined): string[] {
  if (address === null || address === undefined) return [];
  return [address.line1 ?? '', address.line2 ?? '', [address.city, address.pincode].filter(Boolean).join(' '), address.state ?? address.stateCode ?? ''].filter((line) => line !== '');
}

function partyOfWarehouse(party: DocumentWarehouseParty): { name: string; gstin: string | null; addressLines: string[]; code: string } {
  return { code: party.code, name: party.name, gstin: party.gstin, addressLines: addressLinesOf(party.address) };
}

/** A22 — the portal freight block of one consignment (a client-stamped read of `freight_consignments` only). */
export function portalFreightBlockOf(row: FreightConsignment, mode: string | null): PortalFreightBlock {
  if (row.status === 'planned') return { status: 'planned' };
  const carriage = row.carriageSnapshot as CarriageSnapshotV1;
  const status: PortalFreightBlock['status'] =
    row.deliveryOutcome === 'delivered' ? 'delivered' : row.deliveryOutcome === 'delivered-with-exceptions' ? 'delivered-with-exceptions' : row.deliveryOutcome === 'refused' ? 'refused' : 'dispatched';
  return {
    status,
    consignmentRef: carriage.consignmentRef,
    transporterName: carriage.transporterName,
    vehicleNumber: carriage.vehicleNumber,
    containerNumber: carriage.containerNumber,
    seals: (mode ?? carriage.mode) === 'ftl' ? [...carriage.seals] : null,
    driverName: carriage.driverName,
    lrNumber: row.lrNumber,
    lrDate: row.lrDate,
    freightTerms: row.freightTerms,
    packageCount: row.packageCount ?? 0,
    palletCount: row.palletCount ?? 0,
    weightGrams: row.weightGrams,
    dispatchedAt: canonicalInstant(row.dispatchedAt!),
    deliveredAt: instant(row.deliveredAt),
    receiverName: row.receiverName,
    shortPackageCount: row.shortPackageCount,
    damagedPackageCount: row.damagedPackageCount,
    deliveryNote: row.deliveryNote,
    noteAvailable: true,
  };
}

/** A22, A52 — the live consignment of each order, as the portal sees it (two layers: the stamp + `client_id`). */
export async function portalFreightBlocksInTx(tx: TenantTx, tenantId: string, clientId: string, orderIds: readonly string[]): Promise<Map<string, PortalFreightBlock>> {
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ row: freightConsignments })
    .from(freightConsignments)
    .innerJoin(orders, and(eq(orders.tenantId, freightConsignments.tenantId), eq(orders.id, freightConsignments.orderId), eq(orders.clientId, clientId)))
    .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.clientId, clientId), inArray(freightConsignments.orderId, ids), ne(freightConsignments.status, 'removed')))
    .orderBy(desc(freightConsignments.createdAt));
  const out = new Map<string, PortalFreightBlock>();
  for (const { row } of rows) if (!out.has(row.orderId)) out.set(row.orderId, portalFreightBlockOf(row, null));
  return out;
}

/** A20 — the order's freight block (its live consignment, A52); null when none. */
export async function orderFreightBlockInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<OrderFreightBlock | null> {
  const rows = await tx
    .select({ row: freightConsignments, load: freightLoads })
    .from(freightConsignments)
    .innerJoin(freightLoads, and(eq(freightLoads.tenantId, freightConsignments.tenantId), eq(freightLoads.id, freightConsignments.loadId)))
    .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.orderId, orderId), ne(freightConsignments.status, 'removed')))
    .orderBy(desc(freightConsignments.createdAt))
    .limit(1);
  const found = rows[0];
  if (found === undefined) return null;
  const { row, load } = found;
  const carriage = row.carriageSnapshot as CarriageSnapshotV1 | null;
  const delivery: FreightDeliveryView | null = deliveryViewOf(row);
  return {
    consignmentId: row.id,
    loadId: load.id,
    loadCode: load.code,
    consignmentRef: consignmentRef(load.code, row.stopSeq),
    status: row.status,
    stopSeq: row.stopSeq,
    lrNumber: row.lrNumber,
    lrDate: row.lrDate,
    freightTerms: row.freightTerms,
    transporterName: carriage?.transporterName ?? load.transporterName,
    vehicleNumber: carriage?.vehicleNumber ?? load.vehicleNumber,
    dispatchedAt: instant(row.dispatchedAt),
    packageCount: row.packageCount,
    loadedPackageCount: row.loadedPackageCount,
    loadException: row.loadException,
    delivery:
      delivery === null
        ? null
        : { outcome: delivery.outcome, deliveredAt: delivery.deliveredAt, receiverName: delivery.receiverName, short: delivery.short, damaged: delivery.damaged, note: delivery.note, deliverySeq: delivery.deliverySeq },
  };
}

/**
 * A20, A60, A68 — one page of a warehouse's loads (exported so the suite
 * EXPLAINs the REAL query). Each consignment-side filter is a semi-join that
 * a partial index of `freight_consignments` serves: the client filter
 * `freight_consignments_client_live_idx`, POD pending
 * `freight_consignments_pod_pending_idx`, delivery exceptions
 * `freight_consignments_delivery_exceptions_idx`; the open set rides
 * `freight_loads_open_idx` (or the warehouse keyset index).
 */
export function freightLoadsListQuery(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  query: { readonly view: FreightListView; readonly clientId?: string | undefined; readonly from?: string | undefined; readonly to?: string | undefined; readonly after?: { readonly at: string; readonly id: string } | null },
  limit: number,
) {
  const view = query.view;
  const byDispatch = view === 'dispatched' || view === 'pod-pending' || view === 'delivery-exceptions';
  const at = byDispatch ? sql`"freight_loads"."dispatched_at"` : sql`"freight_loads"."created_at"`;
  const status = view === 'open' ? 'open' : view === 'cancelled' ? 'cancelled' : 'dispatched';
  const filters: SQL[] = [sql`"freight_loads"."tenant_id" = ${tenantId}::uuid`, sql`"freight_loads"."warehouse_id" = ${warehouseId}::uuid`, sql`"freight_loads"."status" = ${status}`];
  if (query.from !== undefined) filters.push(sql`${at} >= ${istMidnightOf(query.from)}::timestamptz`);
  if (query.to !== undefined) filters.push(sql`${at} < ${istMidnightOf(addIsoDays(query.to, 1))}::timestamptz`);
  if (query.clientId !== undefined) {
    filters.push(
      sql`"freight_loads"."id" in (select fc.load_id from freight_consignments fc where fc.tenant_id = ${tenantId}::uuid and fc.client_id = ${query.clientId.toLowerCase()}::uuid and fc.status <> 'removed')`,
    );
  }
  if (view === 'pod-pending') {
    filters.push(
      sql`"freight_loads"."id" in (select fc.load_id from freight_consignments fc where fc.tenant_id = ${tenantId}::uuid and fc.warehouse_id = ${warehouseId}::uuid and fc.status = 'dispatched' and fc.delivery_outcome is null)`,
    );
  }
  if (view === 'delivery-exceptions') {
    filters.push(
      sql`"freight_loads"."id" in (select fc.load_id from freight_consignments fc where fc.tenant_id = ${tenantId}::uuid and fc.warehouse_id = ${warehouseId}::uuid and fc.delivery_outcome in ('refused', 'delivered-with-exceptions'))`,
    );
  }
  if (query.after !== undefined && query.after !== null) filters.push(sql`(${at}, "freight_loads"."id") < (${query.after.at}::timestamptz, ${query.after.id}::uuid)`);
  return tx
    .select({ load: freightLoads, cursorAt: sql<string>`${at}::text` })
    .from(freightLoads)
    .where(and(...filters))
    .orderBy(byDispatch ? desc(freightLoads.dispatchedAt) : desc(freightLoads.createdAt), desc(freightLoads.id))
    .limit(limit);
}

@Injectable()
export class FreightService {
  private readonly logger = new Logger('FreightService');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AttachmentsFacade) private readonly attachments: AttachmentsFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(FreightLoadCommand) private readonly loads: FreightLoadCommand,
    @Inject(FreightDispatchCommand) private readonly departures: FreightDispatchCommand,
    @Inject(FreightConsignmentCommand) private readonly consignments: FreightConsignmentCommand,
    @Inject(DispatchCommandService) private readonly dispatch: DispatchCommandService,
    @Inject(AllocationCommandService) private readonly allocation: AllocationCommandService,
  ) {}

  private readonly measurements: PackMeasurementsReader = (tx, tenantId, orderIds) => this.inventory.packMeasurementsOfOrdersInTx(tx, tenantId, orderIds);

  // ── commands ──────────────────────────────────────────────────────────

  createLoad(command: CreateFreightLoadCommand, key: string): Promise<FreightLoadSnapshot> {
    return this.loads.createLoad(command, key);
  }
  updateLoad(command: UpdateFreightLoadCommand, key: string): Promise<FreightLoadSnapshot> {
    return this.loads.updateLoad(command, key);
  }
  addOrders(command: FreightOrdersCommand, key: string): Promise<FreightLoadSnapshot> {
    return this.loads.addOrders(command, key);
  }
  removeOrder(command: RemoveFreightOrderCommand, key: string): Promise<FreightLoadSnapshot> {
    return this.loads.removeOrder(command, key);
  }
  reorderStops(command: FreightOrdersCommand, key: string): Promise<FreightLoadSnapshot> {
    return this.loads.reorderStops(command, key);
  }
  cancelLoad(command: CancelFreightLoadCommand, key: string): Promise<FreightLoadSnapshot> {
    return this.loads.cancelLoad(command, key);
  }
  recordScan(command: RecordFreightScanCommand, key: string): Promise<FreightScanSnapshot> {
    return this.loads.recordScan(command, key);
  }
  recordLr(command: RecordFreightLrCommand, key: string): Promise<FreightConsignmentSnapshot> {
    return this.consignments.recordLr(command, key);
  }
  recordDelivery(command: RecordFreightDeliveryCommand, key: string): Promise<FreightConsignmentSnapshot> {
    return this.consignments.recordDelivery(command, key);
  }

  /** A14 — the departure, then (after the commit) each order's counter restores and follow-on allocation, isolated. */
  async dispatchLoad(command: DispatchFreightLoadCommand, key: string): Promise<FreightDispatchSnapshot> {
    const outcome = await this.departures.dispatchLoad(command, key);
    for (const entry of outcome.after) {
      try {
        await this.dispatch.applyCounterRestores(command.tenantId, entry.warehouseId, entry.orderId, entry.restores);
      } catch (err) {
        this.logger.error(`After-departure counter restore of ${entry.orderId} failed — the parity pass repairs it: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (entry.followOnOrderId !== null) {
        try {
          await this.allocation.allocateOrderCore(command.tenantId, entry.followOnOrderId, { entry: 'dispatch' });
        } catch (err) {
          this.logger.error(`After-departure allocation of follow-on ${entry.followOnOrderId} failed — the sweep retries it: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return outcome.snapshot;
  }

  // ── staff reads ───────────────────────────────────────────────────────

  /** A21 — the load (null when unknown); the phone and licence unmasked for a `dispatch.execute` holder; the sheet signed. */
  async loadDetail(tenantId: string, loadId: string, actorUserId: string): Promise<FreightLoadView | null> {
    const read = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const load = await readLoadInTx(tx, tenantId, loadId);
      if (load === null) return null;
      const role = await getMemberRoleIn(tx, tenantId, actorUserId);
      return freightLoadViewInTx(tx, tenantId, load, { unmask: ROLE_CAPABILITIES[role].has('dispatch.execute'), todayIst: consignmentTodayIst(), measurements: this.measurements });
    });
    if (read === null) return null;
    const sheet = await Promise.all(read.sheet.map((file) => this.fileView(file)));
    return { ...read.view, sheet };
  }

  /** A20, A60, A68 — a warehouse's loads, newest first, keyset on the view's instant. */
  async listLoads(tenantId: string, warehouseId: string, query: FreightLoadListQuery): Promise<{ items: FreightLoadListRow[]; nextCursor: string | null }> {
    const view = query.view ?? 'open';
    const limit = Math.min(Math.max(query.limit ?? FREIGHT_LIST_DEFAULT_LIMIT, 1), FREIGHT_LIST_MAX_LIMIT);
    for (const [name, value] of [['from', query.from], ['to', query.to]] as const) {
      if (value !== undefined && !isIsoDate(value)) throw new ProblemException('validation-failed', 400, 'Validation failed', `${name} must be an ISO date (YYYY-MM-DD).`);
    }
    if (query.clientId !== undefined && !UUID_RE.test(query.clientId)) throw new ProblemException('validation-failed', 400, 'Validation failed', 'clientId must be a uuid.');
    const after = decodeKeyset(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await freightLoadsListQuery(tx, tenantId, warehouseId, { view, clientId: query.clientId, from: query.from, to: query.to, after }, limit + 1);
      const page = rows.slice(0, limit);
      const loadIds = page.map((row) => row.load.id);
      const members = loadIds.length === 0
        ? []
        : await tx
            .select()
            .from(freightConsignments)
            .where(and(eq(freightConsignments.tenantId, tenantId), inArray(freightConsignments.loadId, loadIds), ne(freightConsignments.status, 'removed')))
            .orderBy(asc(freightConsignments.stopSeq));
      const clients = await getClientsInTx(tx, tenantId, members.map((row) => row.clientId));
      const planned = members.filter((row) => row.status === 'planned');
      const sets = await packageSetsOfOrdersInTx(tx, tenantId, planned.map((row) => row.orderId), this.measurements);
      const scans = await loadedScansOfConsignmentsInTx(tx, tenantId, planned.map((row) => row.id));
      const items = page.map(({ load }): FreightLoadListRow => {
        const own = members.filter((row) => row.loadId === load.id);
        const codes = [...new Set(own.map((row) => clients.get(row.clientId)?.code ?? ''))].sort();
        let loaded = 0;
        let total = 0;
        let pallets = 0;
        const weights: (number | null)[] = [];
        for (const row of own) {
          if (row.status === 'dispatched') {
            loaded += row.loadedPackageCount ?? 0;
            total += row.packageCount ?? 0;
            pallets += row.palletCount ?? 0;
            weights.push(row.weightGrams);
          } else {
            const set = sets.get(row.orderId) ?? null;
            const progress = progressOf(scans.filter((scan) => scan.consignmentId === row.id), set);
            loaded += progress.loaded;
            total += progress.total;
            pallets += set?.palletCount ?? 0;
            weights.push(set?.grossWeightGrams ?? null);
          }
        }
        const known = weights.length > 0 && weights.every((w) => w !== null);
        return {
          id: load.id,
          code: load.code,
          status: load.status,
          mode: load.mode,
          transporterName: load.transporterName,
          vehicleNumber: load.vehicleNumber,
          dockDoor: load.dockDoor,
          consignmentCount: own.length,
          clientCodes: codes.slice(0, 5),
          clientMore: Math.max(codes.length - 5, 0),
          packages: { loaded, total },
          palletCount: pallets,
          grossWeightGrams: load.status === 'dispatched' ? load.grossWeightGrams : known ? weights.reduce<number>((sum, w) => sum + (w ?? 0), 0) : null,
          capacityKg: load.vehicleCapacityKg,
          dispatchedAt: instant(load.dispatchedAt),
          deliveredCount: own.filter((row) => row.deliveryOutcome !== null).length,
          createdAt: canonicalInstant(load.createdAt),
        };
      });
      const last = rows.length > limit ? page[page.length - 1] : undefined;
      return { items, nextCursor: last === undefined ? null : encodeKeyset(last.cursorAt, last.load.id) };
    });
  }

  /** A20 — the orders a load may take: open, of this warehouse, on no truck and with no live label; packed first. */
  async candidates(tenantId: string, warehouseId: string, query: FreightCandidatesQuery): Promise<{ items: FreightCandidate[]; nextCursor: string | null; truncated: boolean }> {
    const limit = Math.min(Math.max(query.limit ?? FREIGHT_CANDIDATES_DEFAULT_LIMIT, 1), FREIGHT_CANDIDATES_MAX_LIMIT);
    if (query.clientId !== undefined && !UUID_RE.test(query.clientId)) throw new ProblemException('validation-failed', 400, 'Validation failed', 'clientId must be a uuid.');
    let offset = 0;
    if (query.cursor !== undefined) {
      const parsed = Number(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > FREIGHT_CANDIDATES_SCAN) throw new ProblemException('validation-failed', 400, 'Validation failed', 'cursor is not a cursor this read issued.');
      offset = parsed;
    }
    const status = query.status ?? 'all';
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const statuses = status === 'packed' ? ['ready_to_dispatch'] : status === 'accepted' ? ['accepted'] : ['ready_to_dispatch', 'accepted'];
      const filters: SQL[] = [
        sql`o.tenant_id = ${tenantId}::uuid`,
        sql`o.warehouse_id = ${warehouseId}::uuid`,
        sql`o.status = any(${sql.param(statuses)}::text[])`,
        sql`not exists (select 1 from freight_consignments fc where fc.tenant_id = o.tenant_id and fc.order_id = o.id and fc.status <> 'removed')`,
        sql`not exists (select 1 from shipments s where s.tenant_id = o.tenant_id and s.order_id = o.id and s.status <> 'voided')`,
      ];
      if (query.clientId !== undefined) filters.push(sql`o.client_id = ${query.clientId.toLowerCase()}::uuid`);
      if (query.state !== undefined && query.state.trim() !== '') filters.push(sql`lower(o.destination_state) = lower(${query.state.trim()})`);
      if (query.city !== undefined && query.city.trim() !== '') filters.push(sql`lower(o.destination_city) = lower(${query.city.trim()})`);
      if (query.pincode !== undefined && query.pincode.trim() !== '') filters.push(sql`o.destination_pincode = ${query.pincode.trim()}`);
      const ids = (await tx.execute(sql`
        select o.id as "id"
        from orders o
        where ${sql.join(filters, sql` and `)}
        order by (o.status = 'ready_to_dispatch') desc, o.created_at, o.id
        limit ${FREIGHT_CANDIDATES_SCAN + 1}
      `)) as unknown as { id: string }[];
      const truncated = ids.length > FREIGHT_CANDIDATES_SCAN;
      const scanned = ids.slice(0, FREIGHT_CANDIDATES_SCAN).map((row) => row.id);
      const pageIds = scanned.slice(offset, offset + limit);
      const rows = pageIds.length === 0 ? [] : await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), inArray(orders.id, pageIds)));
      const byId = new Map(rows.map((row) => [row.id, row]));
      const clients = await getClientsInTx(tx, tenantId, rows.map((row) => row.clientId));
      const sets = await packageSetsOfOrdersInTx(tx, tenantId, pageIds, this.measurements);
      const gates = await parcelConsignmentsInTx(tx, tenantId, pageIds, consignmentTodayIst());
      const items = pageIds.map((id): FreightCandidate => {
        const order = byId.get(id)!;
        const set = sets.get(id) ?? null;
        const gate = gates.get(id);
        return {
          orderId: id,
          orderLabel: orderLabelOf(order),
          clientId: order.clientId,
          clientCode: clients.get(order.clientId)?.code ?? '',
          status: order.status,
          consignee: { name: order.consigneeLegalName ?? order.destinationContactName, city: order.destinationCity, state: order.destinationState, pincode: order.destinationPincode },
          packages: { cartons: set === null ? 0 : set.packageCount - set.palletCount, pallets: set?.palletCount ?? 0, packed: set !== null },
          grossWeightGrams: set?.grossWeightGrams ?? null,
          ...(gate === undefined ? {} : { consignment: { state: gate.state, blocking: gate.blocking } }),
        };
      });
      const next = offset + limit < scanned.length ? Buffer.from(String(offset + limit), 'utf8').toString('base64url') : null;
      return { items, nextCursor: next, truncated };
    });
  }

  // ── prints ────────────────────────────────────────────────────────────

  /** A25 — the loading sheet (plan before departure, final after); a file read. */
  async loadingSheet(tenantId: string, loadId: string): Promise<{ body: Buffer; fileName: string }> {
    const model = await withTenantTransaction(this.db, tenantId, async (tx): Promise<LoadingSheetModel> => {
      const load = await readLoadInTx(tx, tenantId, loadId);
      if (load === null) throw new ProblemException('not-found', 404, 'Freight load not found', `No freight load with id "${loadId}" exists in this tenant.`);
      if (load.status === 'cancelled') throw new ProblemException('load-cancelled', 409, 'The load was cancelled', `${load.code} was cancelled — there is nothing to load.`);
      const { view } = await freightLoadViewInTx(tx, tenantId, load, { unmask: true, todayIst: consignmentTodayIst(), measurements: this.measurements });
      const warehouse: DocumentWarehouseParty =
        load.warehouseSnapshot !== null
          ? (load.warehouseSnapshot as DocumentWarehouseParty)
          : await (async () => {
              const party = await invoicePartyFactsInTx(tx, tenantId, load.warehouseId);
              return documentWarehousePartyOf({ code: await getWarehouseCodeInTx(tx, tenantId, load.warehouseId), name: party.warehouseName, gstin: party.warehouseGstin, originAddress: party.originAddress });
            })();
      const transporter = load.transporterSnapshot as TransporterSnapshotV1 | null;
      const emails = await userEmailsInTx(tx, tenantId, [load.ewayPartBConfirmedBy, load.dispatchedBy].filter((id): id is string => id !== null));
      const cartons = view.consignments.reduce((sum, c) => sum + (c.packages.total - c.packages.pallets), 0);
      return {
        loadCode: load.code,
        mode: load.mode === 'ftl' ? 'ftl' : 'ltl',
        status: load.status === 'dispatched' ? 'dispatched' : 'open',
        printedAt: nowIso(),
        dispatchedAt: instant(load.dispatchedAt),
        warehouse: partyOfWarehouse(warehouse),
        transporter: { name: load.transporterName, gstin: transporter?.gstin ?? null, addressLines: addressLinesOf(transporter?.registeredAddress as never) },
        vehicle: { number: load.vehicleNumber, type: load.vehicleType, containerNumber: load.containerNumber, capacityKg: load.vehicleCapacityKg },
        driver: { name: load.driverName, licenceNumber: load.driverLicenceNumber },
        dockDoor: load.dockDoor,
        seals: view.seals,
        partB: { required: view.partB.required, confirmedByName: load.ewayPartBConfirmedBy === null ? null : (emails.get(load.ewayPartBConfirmedBy) ?? 'staff') },
        capacityExceeded: load.capacityExceeded,
        capacityAcknowledgedByName: load.capacityExceeded && load.dispatchedBy !== null ? (emails.get(load.dispatchedBy) ?? 'staff') : null,
        rows: view.consignments.map((c) => ({
          stopSeq: c.stopSeq,
          clientCode: c.clientCode,
          orderLabel: c.orderLabel,
          consigneeName: c.consignee.name ?? '',
          city: c.consignee.city ?? '',
          pincode: c.consignee.pincode ?? '',
          lrNumber: c.lr.number,
          invoiceNumber: c.invoice?.number ?? null,
          ewayBillNumber: c.eway.number,
          ewayValidUntil: c.eway.validUntil,
          cartons: c.packages.total - c.packages.pallets,
          pallets: c.packages.pallets,
          weightGrams: c.weightGrams,
          loaded: c.packages.loaded,
          total: c.packages.total,
        })),
        totals: {
          consignments: view.totals.consignments,
          cartons,
          pallets: view.totals.pallets,
          loaded: view.totals.loaded,
          packages: view.totals.packages,
          grossWeightGrams: view.totals.grossWeightGrams,
        },
      };
    });
    return { body: await renderLoadingSheetPdf(model), fileName: loadingSheetFileName(model.loadCode) };
  }

  /** A26 — the staff freight note of a dispatched consignment. */
  async freightNote(tenantId: string, consignmentId: string): Promise<{ body: Buffer; fileName: string }> {
    const model = await withTenantTransaction(this.db, tenantId, async (tx) => {
      if (!UUID_RE.test(consignmentId)) throw noteNotFound();
      const rows = await tx.select().from(freightConsignments).where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.id, consignmentId.toLowerCase()))).limit(1);
      const row = rows[0];
      if (row === undefined) throw noteNotFound();
      if (row.status !== 'dispatched') throw new ProblemException('consignment-not-dispatched', 409, 'Not dispatched', 'The freight note prints once the truck has left.');
      return this.freightNoteModelInTx(tx, tenantId, row);
    });
    return { body: await renderFreightNotePdf(model, 'staff'), fileName: freightNoteFileName(model.consignmentRef) };
  }

  /**
   * A22 — the client-audience freight note's model, inside the caller's
   * client-stamped transaction (two layers: the stamp and `client_id`):
   * `freight_consignments` only, inner-joined to the client's order; 404 for
   * an unknown, foreign or undispatched order alike.
   */
  async portalFreightNoteModelInTx(tx: TenantTx, tenantId: string, clientId: string, orderId: string): Promise<FreightNoteModel> {
    if (!UUID_RE.test(orderId)) throw noteNotFound();
    const rows = await tx
      .select({ row: freightConsignments })
      .from(freightConsignments)
      .innerJoin(orders, and(eq(orders.tenantId, freightConsignments.tenantId), eq(orders.id, freightConsignments.orderId), eq(orders.clientId, clientId)))
      .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.clientId, clientId), eq(freightConsignments.orderId, orderId.toLowerCase()), eq(freightConsignments.status, 'dispatched')))
      .limit(1);
    const row = rows[0]?.row;
    if (row === undefined) throw noteNotFound();
    return this.freightNoteModelInTx(tx, tenantId, row);
  }

  async renderClientFreightNote(model: FreightNoteModel): Promise<{ body: Buffer; fileName: string }> {
    return { body: await renderFreightNotePdf(model, 'client' satisfies FreightNoteAudience), fileName: freightNoteFileName(model.consignmentRef) };
  }

  /** A26, A63 — the note's model from the consignment's frozen snapshots (never the staff-only load). */
  private async freightNoteModelInTx(tx: TenantTx, tenantId: string, row: FreightConsignment): Promise<FreightNoteModel> {
    const carriage = row.carriageSnapshot as CarriageSnapshotV1;
    const client = row.clientSnapshot as ClientPartySnapshotV1;
    const order = (await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.id, row.orderId))).limit(1))[0] as Order;
    const record = (await dispatchedConsignmentRecordsOfOrdersInTx(tx, tenantId, [row.orderId])).get(row.orderId) ?? null;
    const sets = await packageSetsOfOrdersInTx(tx, tenantId, [row.orderId], this.measurements);
    const set = sets.get(row.orderId) ?? null;
    const warehouse = carriage.warehouse as DocumentWarehouseParty;
    const transporter = carriage.transporter as { name: string; gstin: string | null } | undefined;
    const packages =
      set !== null && set.packages.length > 0
        ? set.packages.map((p) => ({ code: p.code, type: p.type, seq: p.seq, innerCount: p.innerCount, weightGrams: p.weightGrams }))
        : [{ code: `${parcelTagCode(row.orderId)}.1.1`, type: 'carton' as const, seq: 1, innerCount: null, weightGrams: row.weightGrams }];
    const pallets = packages.filter((p) => p.type === 'pallet').length;
    return {
      consignmentRef: carriage.consignmentRef,
      dispatchedAt: canonicalInstant(row.dispatchedAt!),
      printedAt: nowIso(),
      consignor: { name: client.name, legalName: client.legalName, gstin: client.gstin, addressLines: addressLinesOf(client.registeredAddress) },
      careOf: { code: warehouse.code, name: warehouse.name, gstin: warehouse.gstin, addressLines: addressLinesOf(warehouse.address) },
      consignee: {
        name: order.destinationContactName ?? order.consigneeLegalName ?? '',
        legalName: order.consigneeLegalName,
        gstin: order.consigneeGstin,
        addressLines: [order.destinationLine1 ?? '', order.destinationLine2 ?? ''].filter((line) => line !== ''),
        city: order.destinationCity ?? '',
        state: order.destinationState ?? '',
        pincode: order.destinationPincode ?? '',
      },
      transporter: { name: transporter?.name ?? carriage.transporterName, gstin: transporter?.gstin ?? carriage.transporterGstin },
      vehicle: { number: carriage.vehicleNumber, type: carriage.vehicleType, containerNumber: carriage.containerNumber },
      driverName: carriage.driverName,
      seals: [...carriage.seals],
      mode: carriage.mode === 'ftl' ? 'ftl' : 'ltl',
      orderLabel: orderLabelOf(order),
      clientOrderRef: order.clientOrderRef,
      lr: { number: row.lrNumber, date: row.lrDate, terms: row.freightTerms },
      invoice: record === null ? null : { type: record.brandDocumentType, number: record.brandDocumentNumber, date: record.brandDocumentDate },
      ewayBill: record === null || record.ewayBillNumber === null ? null : { number: record.ewayBillNumber, validUntil: record.ewayValidUntil },
      packages,
      totals: {
        packages: row.packageCount ?? packages.length,
        cartons: (row.packageCount ?? packages.length) - (row.palletCount ?? pallets),
        pallets: row.palletCount ?? pallets,
        weightGrams: row.weightGrams,
      },
    };
  }

  // ── the device snapshot (A23, A56) ────────────────────────────────────

  async freightLoadsForDeviceInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<{ loads: DeviceFreightLoad[]; truncated: boolean }> {
    const loads = await tx
      .select()
      .from(freightLoads)
      .where(and(eq(freightLoads.tenantId, tenantId), eq(freightLoads.warehouseId, warehouseId), eq(freightLoads.status, 'open')))
      .orderBy(desc(freightLoads.createdAt), desc(freightLoads.id))
      .limit(DEVICE_FREIGHT_LOADS_MAX + 1);
    let truncated = loads.length > DEVICE_FREIGHT_LOADS_MAX;
    const page = loads.slice(0, DEVICE_FREIGHT_LOADS_MAX);
    if (page.length === 0) return { loads: [], truncated };
    const members = await tx
      .select()
      .from(freightConsignments)
      .where(and(eq(freightConsignments.tenantId, tenantId), inArray(freightConsignments.loadId, page.map((load) => load.id)), eq(freightConsignments.status, 'planned')))
      .orderBy(asc(freightConsignments.stopSeq));
    const orderIds = members.map((row) => row.orderId);
    const orderRows = orderIds.length === 0 ? [] : await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), inArray(orders.id, orderIds)));
    const orderById = new Map(orderRows.map((row) => [row.id, row]));
    const sets = await packageSetsOfOrdersInTx(tx, tenantId, orderIds, this.measurements);
    const scans = await loadedScansOfConsignmentsInTx(tx, tenantId, members.map((row) => row.id));
    const gates = await parcelConsignmentsInTx(tx, tenantId, orderIds, consignmentTodayIst());
    let codes = 0;
    const out: DeviceFreightLoad[] = [];
    for (const load of page) {
      const own = members.filter((row) => row.loadId === load.id);
      const loaded = scans.filter((scan) => own.some((row) => row.id === scan.consignmentId)).map((scan) => scan.packageCode);
      if (codes + loaded.length > DEVICE_FREIGHT_CODES_MAX) {
        truncated = true;
        break;
      }
      codes += loaded.length;
      out.push({
        loadId: load.id,
        code: load.code,
        mode: load.mode,
        transporterName: load.transporterName,
        vehicleNumber: load.vehicleNumber,
        driverName: load.driverName,
        dockDoor: load.dockDoor,
        consignments: own.map((row) => {
          const order = orderById.get(row.orderId);
          const set = sets.get(row.orderId) ?? null;
          const gate = gates.get(row.orderId);
          return {
            consignmentId: row.id,
            orderId: row.orderId,
            clientId: row.clientId,
            orderLabel: order === undefined ? row.orderId : orderLabelOf(order),
            parcelTagCode: parcelTagCode(row.orderId),
            packSeq: set?.packSeq ?? null,
            packageCount: set?.packageCount ?? null,
            palletCount: set?.palletCount ?? 0,
            stopSeq: row.stopSeq,
            lrNumber: row.lrNumber,
            ...(gate === undefined ? {} : { consignment: gate }),
          };
        }),
        loadedCodes: loaded,
      });
    }
    return { loads: out, truncated };
  }

  /** The device snapshot's client ids (`snapshotClients`, A23). */
  static clientIdsOf(loads: readonly DeviceFreightLoad[]): string[] {
    return [...new Set(loads.flatMap((load) => load.consignments.map((c) => c.clientId)))];
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private async fileView(file: UnsignedFile): Promise<FileView> {
    const signed = file.row.status === 'attached' ? await this.attachments.presign(file.row, file.fileName) : null;
    return {
      id: file.row.id,
      purpose: file.row.purpose,
      docKind: file.row.docKind,
      fileName: file.fileName,
      contentType: file.row.contentType,
      byteSize: file.row.byteSize,
      pageCount: file.row.pageCount,
      source: file.row.source,
      uploadedAt: file.row.uploadedAt === null ? null : canonicalInstant(file.row.uploadedAt),
      uploadedBy: file.row.createdBy,
      url: signed?.url ?? null,
      urlExpiresAt: signed?.expiresAt ?? null,
    };
  }
}

function noteNotFound(): ProblemException {
  return new ProblemException('not-found', 404, 'Freight note not found', 'No dispatched freight consignment of this order exists here.');
}
