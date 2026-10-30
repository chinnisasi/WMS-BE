import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  freightConsignments,
  freightLoads,
  freightLoadScans,
  orderCartons,
  orderPacks,
  orders,
  type AttachmentRow,
  type FreightConsignment,
  type FreightLoad,
  type FreightLoadScan,
  type Order,
} from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { maskPhone } from '../../shared/primitives/phone';
import { canonicalInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { consignmentRef, normalizeLr } from '../../shared/primitives/freight';
import type { PackMeasurement } from '../inventory/inventory.facade';
import { getClientsInTx, type ClientPartySnapshotV1 } from '../clients/clients.facade';
import { fileOrdinalsInTx, listByOwnerInTx } from '../attachments/attachment-records';
import { dispatchedConsignmentRecordsOfOrdersInTx, liveConsignmentRecordsOfOrdersInTx } from '../invoicing/consignment-seam';
import { parcelConsignmentsInTx, type ParcelConsignment } from './consignment.read';
import type { PackDocumentPartiesV1 } from './order-packs';
import type { UnsignedFile } from './shipping.read';
import type { FreightConsignmentStatus, FreightLoadStatus } from './freight-vocabulary';

/**
 * Story 4-9a (A20–A23) — the freight load's reads, as free functions over the
 * caller's transaction: the lock helpers (lock only, no status guard — guide
 * §1), the package sets of the member orders (a stored 4-5a pack, or the
 * virtual pack of an order packed before 4-5a), the live scans, and the
 * `FreightLoadView` every command answers and the detail read serves.
 */

/** A pack-measurement reader (the inventory facade's, passed in — AD-6). */
export type PackMeasurementsReader = (tx: TenantTx, tenantId: string, orderIds: readonly string[]) => Promise<Map<string, PackMeasurement>>;

// ── locks (lock only, 404 left to the caller) ──────────────────────────────

export async function lockLoadInTx(tx: TenantTx, tenantId: string, loadId: string, mode: 'update' | 'share'): Promise<FreightLoad | null> {
  if (!UUID_RE.test(loadId)) return null;
  const query = tx
    .select()
    .from(freightLoads)
    .where(and(eq(freightLoads.tenantId, tenantId), eq(freightLoads.id, loadId.toLowerCase())))
    .limit(1);
  const rows = mode === 'update' ? await query.for('update') : await query.for('share');
  return rows[0] ?? null;
}

export async function readLoadInTx(tx: TenantTx, tenantId: string, loadId: string): Promise<FreightLoad | null> {
  if (!UUID_RE.test(loadId)) return null;
  const rows = await tx
    .select()
    .from(freightLoads)
    .where(and(eq(freightLoads.tenantId, tenantId), eq(freightLoads.id, loadId.toLowerCase())))
    .limit(1);
  return rows[0] ?? null;
}

/** The load's consignments that are not removed (planned or dispatched), in stop order. */
export async function liveConsignmentsOfLoadInTx(tx: TenantTx, tenantId: string, loadId: string): Promise<FreightConsignment[]> {
  return tx
    .select()
    .from(freightConsignments)
    .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.loadId, loadId), ne(freightConsignments.status, 'removed')))
    .orderBy(asc(freightConsignments.stopSeq), asc(freightConsignments.id));
}

/** A52 — the order's live consignment (`status <> 'removed'`, newest first), any load; null when none. */
export async function liveConsignmentOfOrderInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<FreightConsignment | null> {
  const rows = await tx
    .select()
    .from(freightConsignments)
    .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.orderId, orderId), ne(freightConsignments.status, 'removed')))
    .orderBy(desc(freightConsignments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** A52 — the live consignments of several orders, by order id. */
export async function liveConsignmentsOfOrdersInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, FreightConsignment>> {
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(freightConsignments)
    .where(and(eq(freightConsignments.tenantId, tenantId), inArray(freightConsignments.orderId, ids), ne(freightConsignments.status, 'removed')));
  return new Map(rows.map((row) => [row.orderId, row]));
}

/** A19 — the order's PLANNED consignment and its load's code (the guards elsewhere), or null. */
export async function plannedConsignmentOfOrderInTx(
  tx: TenantTx,
  tenantId: string,
  orderId: string,
): Promise<{ readonly consignment: FreightConsignment; readonly loadCode: string } | null> {
  const rows = await tx
    .select({ consignment: freightConsignments, loadCode: freightLoads.code })
    .from(freightConsignments)
    .innerJoin(freightLoads, and(eq(freightLoads.tenantId, freightConsignments.tenantId), eq(freightLoads.id, freightConsignments.loadId)))
    .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.orderId, orderId), eq(freightConsignments.status, 'planned')))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A19 — the guard the label commands run under the order lock: a planned
 * consignment refuses 409 `order-on-freight-load`. It reads only
 * `freight_consignments` (a client-stamped portal write sees its own row
 * there); the load's code is added only on an unstamped (staff) read.
 */
export async function assertNotOnFreightLoadInTx(tx: TenantTx, tenantId: string, order: Pick<Order, 'id' | 'clientOrderRef' | 'externalEventId' | 'followOnSeq' | 'followOnRootOrderId'>): Promise<void> {
  const rows = await tx
    .select({ loadId: freightConsignments.loadId })
    .from(freightConsignments)
    .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.orderId, order.id), eq(freightConsignments.status, 'planned')))
    .limit(1);
  if (rows[0] === undefined) return;
  const load = await tx.select({ code: freightLoads.code }).from(freightLoads).where(and(eq(freightLoads.tenantId, tenantId), eq(freightLoads.id, rows[0].loadId))).limit(1);
  const code = load[0]?.code ?? null;
  throw new ProblemException(
    'order-on-freight-load',
    409,
    'Order is on a truck',
    `Order ${orderLabelOf(order)} is booked on a truck${code === null ? '' : ` (${code})`} — it leaves with the truck; remove it from the load first.`,
    code === null ? {} : { loadCode: code },
  );
}

/**
 * A61 — the dispatched consignments whose LR is the normalised reference, of
 * one client's orders in one warehouse (exported so the suite EXPLAINs the
 * REAL query; on `freight_consignments_lr_idx`).
 */
export function freightLrSearchQuery(tx: TenantTx, tenantId: string, clientId: string, warehouseId: string, reference: string) {
  return tx
    .selectDistinct({ orderId: orders.id })
    .from(freightConsignments)
    .innerJoin(orders, and(eq(orders.tenantId, freightConsignments.tenantId), eq(orders.id, freightConsignments.orderId)))
    .where(
      and(
        eq(freightConsignments.tenantId, tenantId),
        eq(freightConsignments.lrNumber, normalizeLr(reference)),
        eq(freightConsignments.status, 'dispatched'),
        eq(freightConsignments.clientId, clientId),
        eq(orders.clientId, clientId),
        eq(orders.warehouseId, warehouseId),
        eq(orders.status, 'dispatched'),
      ),
    )
    .orderBy(orders.id);
}

// ── package sets ───────────────────────────────────────────────────────────

/** One member order's packages: its live stored pack, or its virtual pack (one package, pack 1). */
export interface OrderPackageSet {
  readonly orderId: string;
  readonly kind: 'stored' | 'virtual';
  readonly packId: string | null;
  readonly packSeq: number;
  readonly packageCount: number;
  readonly palletCount: number;
  /** Σ the pallets' "said to contain" counts (0 when none is stated). */
  readonly innerCount: number;
  /** The pack's gross (NULL when any package is unweighed); a virtual pack's ledger weight. */
  readonly grossWeightGrams: number | null;
  /** A65 — the brand the pack froze (stored packs only). */
  readonly packClientParty: ClientPartySnapshotV1 | null;
  /** The packages of a stored pack (seq order); empty for a virtual pack. */
  readonly packages: readonly { readonly seq: number; readonly code: string; readonly type: 'carton' | 'pallet'; readonly innerCount: number | null; readonly weightGrams: number | null }[];
}

/**
 * The package sets of several orders. A stored live pack wins; else an order
 * with a `pack.packed` measurement (packed before 4-5a) has a virtual pack of
 * one package; else the order is not packed (absent from the map).
 */
export async function packageSetsOfOrdersInTx(
  tx: TenantTx,
  tenantId: string,
  orderIds: readonly string[],
  measurements: PackMeasurementsReader,
): Promise<Map<string, OrderPackageSet>> {
  const out = new Map<string, OrderPackageSet>();
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return out;
  const packs = await tx
    .select()
    .from(orderPacks)
    .where(and(eq(orderPacks.tenantId, tenantId), inArray(orderPacks.orderId, ids), eq(orderPacks.status, 'live')));
  const packIds = packs.map((pack) => pack.id);
  const cartons =
    packIds.length === 0
      ? []
      : await tx
          .select({
            packId: orderCartons.packId,
            seq: orderCartons.seq,
            code: orderCartons.code,
            packageType: orderCartons.packageType,
            innerCount: orderCartons.innerCount,
            weightGrams: orderCartons.weightGrams,
          })
          .from(orderCartons)
          .where(and(eq(orderCartons.tenantId, tenantId), inArray(orderCartons.packId, packIds)))
          .orderBy(asc(orderCartons.packId), asc(orderCartons.seq));
  const cartonsByPack = new Map<string, typeof cartons>();
  for (const carton of cartons) {
    const list = cartonsByPack.get(carton.packId) ?? [];
    list.push(carton);
    cartonsByPack.set(carton.packId, list);
  }
  for (const pack of packs) {
    const list = cartonsByPack.get(pack.id) ?? [];
    const pallets = list.filter((carton) => carton.packageType === 'pallet');
    const parties = pack.documentParties as PackDocumentPartiesV1 | null;
    out.set(pack.orderId, {
      orderId: pack.orderId,
      kind: 'stored',
      packId: pack.id,
      packSeq: pack.seq,
      packageCount: pack.cartonCount,
      palletCount: pallets.length,
      innerCount: pallets.reduce((sum, carton) => sum + (carton.innerCount ?? 0), 0),
      grossWeightGrams: pack.grossWeightGrams,
      packClientParty: parties?.client ?? null,
      packages: list.map((carton) => ({
        seq: carton.seq,
        code: carton.code,
        type: carton.packageType === 'pallet' ? 'pallet' : 'carton',
        innerCount: carton.innerCount,
        weightGrams: carton.weightGrams,
      })),
    });
  }
  const unstored = ids.filter((id) => !out.has(id));
  if (unstored.length > 0) {
    const measured = await measurements(tx, tenantId, unstored);
    for (const id of unstored) {
      const measure = measured.get(id);
      if (measure === undefined) continue;
      out.set(id, {
        orderId: id,
        kind: 'virtual',
        packId: null,
        packSeq: 1,
        packageCount: 1,
        palletCount: 0,
        innerCount: 0,
        grossWeightGrams: measure.weightGrams !== null && measure.weightGrams > 0 ? measure.weightGrams : null,
        packClientParty: null,
        packages: [],
      });
    }
  }
  return out;
}

// ── scans ──────────────────────────────────────────────────────────────────

/** The `loaded` scans of several consignments. */
export async function loadedScansOfConsignmentsInTx(tx: TenantTx, tenantId: string, consignmentIds: readonly string[]): Promise<FreightLoadScan[]> {
  const ids = [...new Set(consignmentIds)];
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(freightLoadScans)
    .where(and(eq(freightLoadScans.tenantId, tenantId), inArray(freightLoadScans.consignmentId, ids), eq(freightLoadScans.status, 'loaded')))
    .orderBy(asc(freightLoadScans.scannedAt), asc(freightLoadScans.id));
}

/** The live-pack progress of one consignment: scans of the live pack's packages count; others are stale. */
export function progressOf(scans: readonly FreightLoadScan[], set: OrderPackageSet | null): { loaded: number; stale: number; total: number } {
  if (set === null) return { loaded: 0, stale: scans.length, total: 0 };
  let loaded = 0;
  let stale = 0;
  for (const scan of scans) {
    if (scan.packSeq === set.packSeq && scan.packageSeq <= set.packageCount) loaded += 1;
    else stale += 1;
  }
  return { loaded, stale, total: set.packageCount };
}

// ── the view (A21) ─────────────────────────────────────────────────────────

/** CarriageSnapshotV1 — the only load facts a client ever reads (A2, A63). */
export interface CarriageSnapshotV1 {
  readonly v: 1;
  readonly loadCode: string;
  readonly consignmentRef: string;
  readonly mode: string;
  readonly transporterName: string;
  readonly transporterGstin: string | null;
  readonly transporter: { readonly name: string; readonly gstin: string | null; readonly address: unknown };
  readonly vehicleNumber: string;
  readonly vehicleType: string | null;
  readonly containerNumber: string | null;
  readonly driverName: string;
  readonly seals: readonly string[];
  readonly dispatchedAt: string;
  readonly warehouse: unknown;
}

export interface FreightDeliveryView {
  readonly outcome: string;
  readonly deliveredAt: string;
  readonly receiverName: string | null;
  readonly short: number | null;
  readonly damaged: number | null;
  readonly note: string | null;
  readonly deliverySeq: number;
  readonly recordedAt: string | null;
  readonly recordedBy: string | null;
}

export interface FreightConsignmentView {
  readonly id: string;
  readonly orderId: string;
  readonly orderLabel: string;
  readonly orderStatus: string;
  readonly clientId: string;
  readonly clientCode: string;
  readonly stopSeq: number;
  readonly consignmentRef: string;
  readonly status: FreightConsignmentStatus;
  readonly consignee: { readonly name: string | null; readonly city: string | null; readonly state: string | null; readonly pincode: string | null };
  readonly lr: { readonly number: string | null; readonly date: string | null; readonly terms: string | null };
  readonly packages: { readonly total: number; readonly pallets: number; readonly loaded: number; readonly staleScans: number; readonly packed: boolean };
  readonly weightGrams: number | null;
  /** 4-6a's gate (live before departure); absent when the national threshold is missing (an enrichment). */
  readonly gate?: { readonly state: string; readonly blocking: boolean } | null;
  readonly eway: { readonly number: string | null; readonly validUntil: string | null };
  readonly invoice: { readonly type: string; readonly number: string; readonly date: string } | null;
  readonly loadException: string | null;
  readonly complianceException: string | null;
  readonly dispatchedAt: string | null;
  readonly delivery: FreightDeliveryView | null;
}

export interface FreightLoadView {
  readonly id: string;
  readonly code: string;
  readonly status: FreightLoadStatus;
  readonly mode: string;
  readonly warehouseId: string;
  readonly transporter: { readonly partnerId: string | null; readonly name: string; readonly snapshot: unknown };
  readonly vehicle: { readonly type: string | null; readonly number: string | null; readonly containerNumber: string | null; readonly capacityKg: number | null; readonly reportedAt: string | null };
  readonly driver: { readonly name: string | null; readonly phone: string | null; readonly licenceNumber: string | null };
  readonly dockDoor: string | null;
  readonly seals: readonly string[];
  readonly note: string | null;
  readonly loadingStartedAt: string | null;
  readonly dispatchedAt: string | null;
  readonly dispatchedBy: string | null;
  readonly dispatchSource: string | null;
  readonly partB: { readonly required: boolean; readonly confirmedAt: string | null; readonly confirmedBy: string | null };
  readonly capacityExceeded: boolean;
  readonly totals: {
    readonly consignments: number;
    readonly packages: number;
    readonly loaded: number;
    readonly pallets: number;
    readonly grossWeightGrams: number | null;
    readonly weightKnown: boolean;
    readonly overCapacity: boolean;
  };
  readonly consignments: readonly FreightConsignmentView[];
  readonly removed: readonly { readonly orderId: string; readonly orderLabel: string; readonly reason: string; readonly removedAt: string }[];
  readonly sheet: readonly unknown[];
  readonly cancel: { readonly at: string; readonly by: string; readonly reason: string } | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

function instant(value: string | null): string | null {
  return value === null ? null : canonicalInstant(value);
}

export function deliveryViewOf(row: FreightConsignment): FreightDeliveryView | null {
  if (row.deliveryOutcome === null || row.deliveredAt === null) return null;
  return {
    outcome: row.deliveryOutcome,
    deliveredAt: canonicalInstant(row.deliveredAt),
    receiverName: row.receiverName,
    short: row.shortPackageCount,
    damaged: row.damagedPackageCount,
    note: row.deliveryNote,
    deliverySeq: row.deliverySeq,
    recordedAt: instant(row.deliveryRecordedAt),
    recordedBy: row.deliveryRecordedBy,
  };
}

/** The load's sheet pages (any live status), with their derived file names (guide §7r). */
export async function loadSheetFilesInTx(tx: TenantTx, tenantId: string, load: FreightLoad): Promise<UnsignedFile[]> {
  const pages: AttachmentRow[] = await listByOwnerInTx(tx, { tenantId, ownerType: 'freight_load', ownerIds: [load.id], purposes: ['loading-sheet'] });
  const ordinals = await fileOrdinalsInTx(tx, { tenantId, ownerType: 'freight_load', ownerIds: [load.id], purposes: ['loading-sheet'] });
  return pages.map((row) => {
    const n = ordinals.get(row.id) ?? 1;
    const ext = row.contentType === 'application/pdf' ? 'pdf' : row.contentType === 'image/png' ? 'png' : row.contentType === 'image/webp' ? 'webp' : 'jpg';
    return { row, fileName: `${load.code}-loading-sheet-${n}.${ext}` };
  });
}

/**
 * A21 — the load as every command answers it and the detail read serves it
 * (the read signs `sheet` after its transaction; a command's stored snapshot
 * carries the unsigned file facts — nothing that expires).
 */
export async function freightLoadViewInTx(
  tx: TenantTx,
  tenantId: string,
  load: FreightLoad,
  opts: { readonly unmask: boolean; readonly todayIst: string; readonly measurements: PackMeasurementsReader },
): Promise<{ view: FreightLoadView; sheet: UnsignedFile[] }> {
  const all = await tx
    .select()
    .from(freightConsignments)
    .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.loadId, load.id)))
    .orderBy(asc(freightConsignments.stopSeq), asc(freightConsignments.id));
  const live = all.filter((row) => row.status !== 'removed');
  const removedRows = all.filter((row) => row.status === 'removed');
  const orderIds = [...new Set(all.map((row) => row.orderId))];
  const orderRows = orderIds.length === 0 ? [] : await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), inArray(orders.id, orderIds)));
  const orderById = new Map(orderRows.map((row) => [row.id, row]));
  const clientsById = await getClientsInTx(tx, tenantId, live.map((row) => row.clientId));
  const planned = live.filter((row) => row.status === 'planned');
  const plannedOrderIds = planned.map((row) => row.orderId);
  const sets = await packageSetsOfOrdersInTx(tx, tenantId, plannedOrderIds, opts.measurements);
  const scans = await loadedScansOfConsignmentsInTx(tx, tenantId, planned.map((row) => row.id));
  const scansByConsignment = new Map<string, FreightLoadScan[]>();
  for (const scan of scans) {
    const list = scansByConsignment.get(scan.consignmentId) ?? [];
    list.push(scan);
    scansByConsignment.set(scan.consignmentId, list);
  }
  const gates: Map<string, ParcelConsignment> | null = plannedOrderIds.length === 0 ? new Map() : await parcelConsignmentsInTx(tx, tenantId, plannedOrderIds, opts.todayIst);
  const liveRecords = await liveConsignmentRecordsOfOrdersInTx(tx, tenantId, plannedOrderIds);
  const dispatchedIds = live.filter((row) => row.status === 'dispatched').map((row) => row.orderId);
  const stampedRecords = await dispatchedConsignmentRecordsOfOrdersInTx(tx, tenantId, dispatchedIds);

  const views: FreightConsignmentView[] = live.map((row) => {
    const order = orderById.get(row.orderId) as Order | undefined;
    const label = order === undefined ? row.orderId : orderLabelOf(order);
    const record = row.status === 'dispatched' ? (stampedRecords.get(row.orderId) ?? null) : (liveRecords.get(row.orderId) ?? null);
    let packages: FreightConsignmentView['packages'];
    let weightGrams: number | null;
    if (row.status === 'dispatched') {
      packages = { total: row.packageCount ?? 0, pallets: row.palletCount ?? 0, loaded: row.loadedPackageCount ?? 0, staleScans: 0, packed: true };
      weightGrams = row.weightGrams;
    } else {
      const set = sets.get(row.orderId) ?? null;
      const progress = progressOf(scansByConsignment.get(row.id) ?? [], set);
      packages = { total: progress.total, pallets: set?.palletCount ?? 0, loaded: progress.loaded, staleScans: progress.stale, packed: set !== null };
      weightGrams = set?.grossWeightGrams ?? null;
    }
    const gate = row.status === 'planned' ? gates?.get(row.orderId) : undefined;
    return {
      id: row.id,
      orderId: row.orderId,
      orderLabel: label,
      orderStatus: order?.status ?? 'unknown',
      clientId: row.clientId,
      clientCode: clientsById.get(row.clientId)?.code ?? '',
      stopSeq: row.stopSeq,
      consignmentRef: consignmentRef(load.code, row.stopSeq),
      status: row.status as FreightConsignmentStatus,
      consignee: {
        name: order?.consigneeLegalName ?? order?.destinationContactName ?? null,
        city: order?.destinationCity ?? null,
        state: order?.destinationState ?? null,
        pincode: order?.destinationPincode ?? null,
      },
      lr: { number: row.lrNumber, date: row.lrDate, terms: row.freightTerms },
      packages,
      weightGrams,
      ...(row.status === 'planned' && gate !== undefined ? { gate: { state: gate.state, blocking: gate.blocking } } : {}),
      eway: { number: record?.ewayBillNumber ?? null, validUntil: record?.ewayValidUntil ?? null },
      invoice: record === null ? null : { type: record.brandDocumentType, number: record.brandDocumentNumber, date: record.brandDocumentDate },
      loadException: row.loadException,
      complianceException: row.complianceException,
      dispatchedAt: instant(row.dispatchedAt),
      delivery: deliveryViewOf(row),
    };
  });

  const weights = views.map((view) => view.weightGrams);
  const weightKnown = views.length > 0 && weights.every((weight) => weight !== null);
  const gross = weightKnown ? weights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0) : null;
  const totalGross = load.status === 'dispatched' ? load.grossWeightGrams : gross;
  const partBRequired = views.some((view) => view.eway.number !== null);
  const sheet = await loadSheetFilesInTx(tx, tenantId, load);
  const view: FreightLoadView = {
    id: load.id,
    code: load.code,
    status: load.status as FreightLoadStatus,
    mode: load.mode,
    warehouseId: load.warehouseId,
    transporter: { partnerId: load.transporterPartnerId, name: load.transporterName, snapshot: load.transporterSnapshot },
    vehicle: {
      type: load.vehicleType,
      number: load.vehicleNumber,
      containerNumber: load.containerNumber,
      capacityKg: load.vehicleCapacityKg,
      reportedAt: instant(load.vehicleReportedAt),
    },
    driver: {
      name: load.driverName,
      phone: opts.unmask ? load.driverPhone : maskPhone(load.driverPhone),
      licenceNumber: opts.unmask || load.driverLicenceNumber === null ? load.driverLicenceNumber : `••••${load.driverLicenceNumber.slice(-4)}`,
    },
    dockDoor: load.dockDoor,
    seals: (load.seals as string[] | null) ?? [],
    note: load.note,
    loadingStartedAt: instant(load.loadingStartedAt) ?? (scans.length > 0 ? canonicalInstant(scans[0]!.scannedAt) : null),
    dispatchedAt: instant(load.dispatchedAt),
    dispatchedBy: load.dispatchedBy,
    dispatchSource: load.dispatchSource,
    partB: { required: partBRequired, confirmedAt: instant(load.ewayPartBConfirmedAt), confirmedBy: load.ewayPartBConfirmedBy },
    capacityExceeded: load.capacityExceeded,
    totals: {
      consignments: views.length,
      packages: views.reduce((sum, v) => sum + v.packages.total, 0),
      loaded: views.reduce((sum, v) => sum + v.packages.loaded, 0),
      pallets: views.reduce((sum, v) => sum + v.packages.pallets, 0),
      grossWeightGrams: totalGross,
      weightKnown: load.status === 'dispatched' ? load.grossWeightGrams !== null : weightKnown,
      overCapacity: totalGross !== null && load.vehicleCapacityKg !== null && totalGross > load.vehicleCapacityKg * 1000,
    },
    consignments: views,
    removed: removedRows.map((row) => {
      const order = orderById.get(row.orderId);
      return { orderId: row.orderId, orderLabel: order === undefined ? row.orderId : orderLabelOf(order), reason: row.removeReason ?? '', removedAt: canonicalInstant(row.removedAt!) };
    }),
    sheet: sheet.map((file) => ({
      id: file.row.id,
      purpose: file.row.purpose,
      docKind: file.row.docKind,
      fileName: file.fileName,
      contentType: file.row.contentType,
      byteSize: file.row.byteSize,
      pageCount: file.row.pageCount,
      source: file.row.source,
      uploadedAt: instant(file.row.uploadedAt),
      uploadedBy: file.row.createdBy,
      url: null,
      urlExpiresAt: null,
    })),
    cancel: load.status === 'cancelled' && load.cancelledAt !== null ? { at: canonicalInstant(load.cancelledAt), by: load.cancelledBy!, reason: load.cancelReason! } : null,
    createdBy: load.createdBy,
    createdAt: canonicalInstant(load.createdAt),
  };
  return { view, sheet };
}

/** The scan count of a load's live consignments (no row lock — evidence for the counts). */
export async function liveScanCountsInTx(tx: TenantTx, tenantId: string, loadId: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({ consignmentId: freightLoadScans.consignmentId, n: sql<number>`count(*)::int` })
    .from(freightLoadScans)
    .where(and(eq(freightLoadScans.tenantId, tenantId), eq(freightLoadScans.loadId, loadId), eq(freightLoadScans.status, 'loaded')))
    .groupBy(freightLoadScans.consignmentId);
  return new Map(rows.map((row) => [row.consignmentId, Number(row.n)]));
}
