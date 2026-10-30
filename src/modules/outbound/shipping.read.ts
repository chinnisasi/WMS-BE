// Story 4-6a (A12) — the record's seam (guide §7h): never the invoicing module.
import { consignmentTodayIst, parcelConsignmentsInTx, type ParcelConsignment } from './consignment.read';
import { dispatchedConsignmentRecordsOfOrdersInTx, liveConsignmentRecordsOfOrdersInTx, type ConsignmentRecordRow } from '../invoicing/consignment-seam';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AttachmentRow, CourierHandover, Order, Shipment } from '../../shared/db/schema';
import { auditEvents, courierHandovers, orderCartons, orderPacks, orders, shipments } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { parcelTagCode } from '../../shared/primitives/parcel-tag';
import { maskPhone } from '../../shared/primitives/phone';
import { addIsoDays, canonicalInstant, fullPrecisionInstant, isIsoDate, istMidnightOf } from '../../shared/primitives/time';
import { decodeCursor, encodeCursor } from '../../shared/primitives/pagination';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { fileOrdinalsInTx, listByOwnerInTx } from '../attachments/attachment-records';
import { extensionOf, fileNamePart } from './shipping-support';
import type { ShipmentKind, ShipmentStatus } from './shipment.command';

/**
 * Story 4-4a (A16–A18, A39, A44, A45, A50) — the client-arranged shipping
 * reads, as free functions over the caller's transaction (the facade opens
 * the transaction — stamped for the portal — and presigns AFTER it). Never
 * capability-gated, except the handover phone (unmasked for a
 * `dispatch.execute` holder only — the gate-in DPDP rule).
 */

// ── the portal status (A44) ─────────────────────────────────────────────────

export const PORTAL_SHIPPING_STATUSES = [
  'cancelled',
  'no-label-yet',
  'label-received',
  'awb-received',
  'ready-for-pickup',
  'handed-over',
  'shipped',
  'shipped-no-courier-record',
  // Story 4-9a (A22, D18) — an order on a truck, judged first.
  'freight-planned',
  'freight-dispatched',
  'delivered',
  'delivered-with-exceptions',
  'delivery-refused',
] as const;
export type PortalShippingStatus = (typeof PORTAL_SHIPPING_STATUSES)[number];

/**
 * A44 — the ONE derivation of the portal's shipping status, shared by the
 * allowlist builder and mirrored in wms-fe `lib/portal.ts`. Pure.
 */
export function portalShippingStatus(
  orderStatus: string,
  live: { readonly kind: string; readonly status: string; readonly labelVerified: boolean } | null,
  /** E2 — the order's dispatch record names a carrier or a tracking number (its first `dispatch.dispatched` reference doc). */
  hasDispatchRecord: boolean,
  /** Story 4-9a (D18) — the order's live freight consignment, judged first; absent or null when none. */
  freight: { readonly status: string; readonly deliveryOutcome: string | null } | null = null,
): PortalShippingStatus {
  if (orderStatus === 'cancelled') return 'cancelled';
  if (freight !== null && freight.status === 'planned' && (orderStatus === 'accepted' || orderStatus === 'ready_to_dispatch')) return 'freight-planned';
  if (freight !== null && freight.status === 'dispatched' && orderStatus === 'dispatched') {
    if (freight.deliveryOutcome === 'delivered') return 'delivered';
    if (freight.deliveryOutcome === 'delivered-with-exceptions') return 'delivered-with-exceptions';
    if (freight.deliveryOutcome === 'refused') return 'delivery-refused';
    return 'freight-dispatched';
  }
  if (orderStatus === 'dispatched') {
    if (live === null) return hasDispatchRecord ? 'shipped' : 'shipped-no-courier-record';
    if (live.status === 'handed_over') return 'handed-over';
    return 'shipped';
  }
  if (live === null) return 'no-label-yet';
  // E3 — a carrier label (the warehouse's) is not a label the client sent: its AWB is known.
  if (live.kind === 'courier-label' || live.kind === 'carrier') return 'awb-received';
  if (live.kind === 'client-label' && live.labelVerified && orderStatus === 'ready_to_dispatch') return 'ready-for-pickup';
  return 'label-received';
}

// ── files (A50 D33: derived names) ──────────────────────────────────────────

/** A file view before its URL is minted (the facade presigns after the transaction). */
export interface UnsignedFile {
  readonly row: AttachmentRow;
  readonly fileName: string;
}

export const DOC_KIND_FILE_WORD: Readonly<Record<string, string>> = {
  invoice: 'invoice',
  challan: 'challan',
  'eway-bill': 'eway-bill',
  pod: 'pod',
  other: 'document',
};

/**
 * `{order}-label.pdf`, `{order}-{kind}-{n}.{ext}`, `{HO}-sheet-{n}.{ext}` —
 * n is the file's ordinal (`fileOrdinalsInTx`: its rank among every row of
 * its owner, purpose and kind, any status), so a name never changes.
 */
export function shippingFileNames(ownerLabel: string, rows: readonly AttachmentRow[], ordinals: ReadonlyMap<string, number>): Map<string, string> {
  const out = new Map<string, string>();
  const base = fileNamePart(ownerLabel);
  for (const row of rows) {
    if (row.purpose === 'shipping-label') {
      out.set(row.id, `${base}-label.pdf`);
      continue;
    }
    const word = row.purpose === 'handover-sheet' ? 'sheet' : (DOC_KIND_FILE_WORD[row.docKind ?? 'other'] ?? 'document');
    out.set(row.id, `${base}-${word}-${ordinals.get(row.id) ?? 1}.${extensionOf(row.contentType)}`);
  }
  return out;
}

// ── the staff order read (A16) ──────────────────────────────────────────────

export interface OrderShippingRead {
  readonly order: Order;
  readonly live: Shipment | null;
  readonly history: readonly Shipment[];
  readonly label: UnsignedFile | null;
  readonly documents: readonly UnsignedFile[];
  readonly handover: CourierHandover | null;
  readonly sheet: readonly UnsignedFile[];
}

/** The order's shipments (live first, then voided newest first), files and handover. Null for an unknown order. */
export async function orderShippingInTx(tx: TenantTx, tenantId: string, orderId: string, clientId?: string): Promise<OrderShippingRead | null> {
  if (!UUID_RE.test(orderId)) return null;
  const orderRows = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId), ...(clientId === undefined ? [] : [eq(orders.clientId, clientId)])))
    .limit(1);
  const order = orderRows[0];
  if (order === undefined) return null;
  const rows = await tx
    .select()
    .from(shipments)
    .where(and(eq(shipments.tenantId, tenantId), eq(shipments.orderId, order.id), ...(clientId === undefined ? [] : [eq(shipments.clientId, clientId)])))
    .orderBy(desc(shipments.createdAt), desc(shipments.id));
  const live = rows.find((row) => row.status !== 'voided') ?? null;
  const history = rows.filter((row) => row.status === 'voided');
  const files = await listByOwnerInTx(tx, {
    tenantId,
    ownerType: 'order',
    ownerIds: [order.id],
    purposes: ['shipping-label', 'shipping-document'],
    ...(clientId === undefined ? {} : { clientId }),
  });
  const label = orderLabelOf(order);
  const names = shippingFileNames(label, files, await fileOrdinalsInTx(tx, { tenantId, ownerType: 'order', ownerIds: [order.id], purposes: ['shipping-label', 'shipping-document'] }));
  const labelRow = live?.labelAttachmentId == null ? null : (files.find((row) => row.id === live.labelAttachmentId) ?? null);
  const documents = files.filter((row) => row.purpose === 'shipping-document' && row.status === 'attached');
  let handover: CourierHandover | null = null;
  let sheet: UnsignedFile[] = [];
  if (live?.handoverId != null) {
    const handoverRows = await tx
      .select()
      .from(courierHandovers)
      .where(and(eq(courierHandovers.tenantId, tenantId), eq(courierHandovers.id, live.handoverId), ...(clientId === undefined ? [] : [eq(courierHandovers.clientId, clientId)])))
      .limit(1);
    handover = handoverRows[0] ?? null;
    if (handover !== null) {
      const pages = (
        await listByOwnerInTx(tx, {
          tenantId,
          ownerType: 'courier_handover',
          ownerIds: [handover.id],
          purposes: ['handover-sheet'],
          ...(clientId === undefined ? {} : { clientId }),
        })
      ).filter((row) => row.status === 'attached');
      const sheetNames = shippingFileNames(handover.code, pages, await fileOrdinalsInTx(tx, { tenantId, ownerType: 'courier_handover', ownerIds: [handover.id], purposes: ['handover-sheet'] }));
      sheet = pages.map((row) => ({ row, fileName: sheetNames.get(row.id)! }));
    }
  }
  return {
    order,
    live,
    history,
    label: labelRow === null || labelRow.status !== 'attached' ? null : { row: labelRow, fileName: names.get(labelRow.id)! },
    documents: documents.map((row) => ({ row, fileName: names.get(row.id)! })),
    handover,
    sheet,
  };
}

// ── the handover candidates (A16, A49) ─────────────────────────────────────

export interface HandoverCandidate {
  readonly orderId: string;
  readonly orderLabel: string;
  readonly clientOrderRef: string | null;
  readonly externalEventId: string | null;
  readonly followOnSeq: number | null;
  readonly parcelTagCode: string;
  readonly destinationCity: string | null;
  readonly codAmountPaise: number | null;
  readonly packedAt: string | null;
  readonly shipment: {
    readonly kind: ShipmentKind;
    readonly awb: string;
    readonly courierName: string;
    readonly packageCount: number | null;
    readonly labelVerified: boolean;
  } | null;
  /** Story 4-5a (A21) — the stored live pack; absent for a virtual pack. */
  readonly packSeq?: number;
  readonly cartonCount?: number;
  /** Story 4-5a (A33, A39) — what the handover defaults the weight to. */
  readonly defaultWeightGrams?: number | null;
  /** Story 4-6a (A16) — the consignment gate today; a blocking parcel cannot be ticked on the web. */
  readonly consignment?: ParcelConsignment;
}

export const HANDOVER_CANDIDATES_DEFAULT_LIMIT = 100;
export const HANDOVER_CANDIDATES_MAX_LIMIT = 200;

/** A warehouse's packed orders of one client, oldest first (`orders_ready_to_dispatch_idx`), keyset on `(updated_at, id)`. */
export async function handoverCandidateRowsInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  clientId: string,
  after: { readonly at: string; readonly id: string } | null,
  limit: number,
): Promise<{ rows: { order: Order; shipment: Shipment | null; cursorAt: string }[] }> {
  const rows = await tx
    .select({ order: orders, cursorAt: sql<string>`${orders.updatedAt}::text` })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.warehouseId, warehouseId),
        eq(orders.status, 'ready_to_dispatch'),
        eq(orders.clientId, clientId),
        // Story 4-9a (A19, A52) — an order on a truck leaves with it.
        sql`not exists (select 1 from freight_consignments fc where fc.tenant_id = "orders"."tenant_id" and fc.order_id = "orders"."id" and fc.status = 'planned')`,
        after === null ? undefined : sql`(${orders.updatedAt}, ${orders.id}) > (${after.at}::timestamptz, ${after.id}::uuid)`,
      ),
    )
    .orderBy(asc(orders.updatedAt), asc(orders.id))
    .limit(limit + 1);
  const ids = rows.map((row) => row.order.id);
  const shipmentRows =
    ids.length === 0
      ? []
      : await tx
          .select()
          .from(shipments)
          .where(and(eq(shipments.tenantId, tenantId), inArray(shipments.orderId, ids), ne(shipments.status, 'voided')));
  const byOrder = new Map(shipmentRows.map((row) => [row.orderId, row]));
  return { rows: rows.map((row) => ({ order: row.order, shipment: byOrder.get(row.order.id) ?? null, cursorAt: fullPrecisionInstant(row.cursorAt) })) };
}

export function candidateOf(
  order: Order,
  shipment: Shipment | null,
  packedAt: string | null,
  pack?: { readonly packSeq: number; readonly cartonCount: number } | null,
  defaultWeightGrams?: number | null,
): HandoverCandidate {
  return {
    orderId: order.id,
    orderLabel: orderLabelOf(order),
    clientOrderRef: order.clientOrderRef,
    externalEventId: order.externalEventId,
    followOnSeq: order.followOnSeq,
    parcelTagCode: parcelTagCode(order.id),
    destinationCity: order.destinationCity,
    codAmountPaise: order.codAmountPaise,
    packedAt,
    shipment:
      shipment === null
        ? null
        : {
            kind: shipment.kind as ShipmentKind,
            awb: shipment.trackingNumber,
            courierName: shipment.carrierName,
            packageCount: shipment.packageCount,
            labelVerified: shipment.labelVerifiedAt !== null,
          },
    // Story 4-5a (A21, A33) — optional: absent for a virtual pack / before packing.
    ...(pack === null || pack === undefined ? {} : { packSeq: pack.packSeq, cartonCount: pack.cartonCount }),
    ...(defaultWeightGrams === undefined ? {} : { defaultWeightGrams }),
  };
}

export function encodeKeyset(at: string, id: string): string {
  return encodeCursor({ createdAt: at, id });
}

export function decodeKeyset(cursor: string | undefined): { at: string; id: string } | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const parsed = decodeCursor(cursor);
    if (!UUID_RE.test(parsed.id) || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error('bad');
    return { at: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ProblemException('invalid-cursor', 400, 'Malformed pagination cursor', 'The cursor parameter is not a valid opaque page cursor.');
  }
}

// ── the handovers list and detail (A16, A40) ────────────────────────────────

export interface HandoverListItem {
  readonly id: string;
  readonly code: string;
  readonly clientId: string;
  readonly clientCode: string | null;
  readonly courierName: string;
  readonly shipmentCount: number;
  readonly packageCount: number;
  readonly handedOverAt: string;
  readonly sheetPageCount: number;
  readonly source: string;
}

/** A40 — `from` / `to` are IST dates, half-open `[istMidnightOf(from), istMidnightOf(to + 1))` over `handed_over_at`. */
export function handoverWindow(from: string | undefined, to: string | undefined): { from: string | null; to: string | null } {
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (value !== undefined && value !== '' && !isIsoDate(value)) {
      throw new ProblemException('validation-failed', 400, 'Invalid date', `${name} must be a YYYY-MM-DD date (IST).`);
    }
  }
  return {
    from: from === undefined || from === '' ? null : istMidnightOf(from),
    to: to === undefined || to === '' ? null : istMidnightOf(addIsoDays(to, 1)),
  };
}

export async function listHandoversInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  query: { readonly clientId: string | null; readonly from: string | null; readonly to: string | null; readonly after: { at: string; id: string } | null; readonly limit: number },
): Promise<{ items: HandoverListItem[]; nextCursor: string | null }> {
  const rows = await tx
    .select({
      handover: courierHandovers,
      cursorAt: sql<string>`${courierHandovers.handedOverAt}::text`,
      sheetPageCount: sql<number>`(select count(*)::int from attachments a
        where a.tenant_id = ${courierHandovers.tenantId} and a.owner_type = 'courier_handover'
          and a.owner_id = "courier_handovers"."id" and a.purpose = 'handover-sheet' and a.status = 'attached')`,
    })
    .from(courierHandovers)
    .where(
      and(
        eq(courierHandovers.tenantId, tenantId),
        eq(courierHandovers.warehouseId, warehouseId),
        query.clientId === null ? undefined : eq(courierHandovers.clientId, query.clientId),
        query.from === null ? undefined : sql`${courierHandovers.handedOverAt} >= ${query.from}::timestamptz`,
        query.to === null ? undefined : sql`${courierHandovers.handedOverAt} < ${query.to}::timestamptz`,
        query.after === null ? undefined : sql`(${courierHandovers.handedOverAt}, ${courierHandovers.id}) < (${query.after.at}::timestamptz, ${query.after.id}::uuid)`,
      ),
    )
    .orderBy(desc(courierHandovers.handedOverAt), desc(courierHandovers.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(({ handover, sheetPageCount }) => ({
      id: handover.id,
      code: handover.code,
      clientId: handover.clientId,
      clientCode: typeof (handover.clientSnapshot as { code?: unknown } | null)?.code === 'string' ? (handover.clientSnapshot as { code: string }).code : null,
      courierName: handover.courierName,
      shipmentCount: handover.shipmentCount,
      packageCount: handover.packageCount,
      handedOverAt: canonicalInstant(handover.handedOverAt),
      sheetPageCount: Number(sheetPageCount),
      source: handover.source,
    })),
    nextCursor: rows.length > query.limit && last !== undefined ? encodeKeyset(fullPrecisionInstant(last.cursorAt), last.handover.id) : null,
  };
}

/** Story 4-5a (A21, A34, A37, A44) — one order's cartons at a handover. */
export interface HandoverCartonsRead {
  readonly cartonCount: number;
  readonly scanned: number;
  readonly legacy: boolean;
  readonly codCartonScanned: boolean | null;
  readonly staleCartonLabels: boolean;
}

export interface HandoverDetailRead {
  readonly handover: CourierHandover;
  readonly parcels: readonly { shipment: Shipment; order: Order }[];
  readonly sheet: readonly UnsignedFile[];
  /** Story 4-5a — by order id. */
  readonly cartons: ReadonlyMap<string, HandoverCartonsRead>;
  /** Story 4-6a (A19, A39) — the consignment version each order LEFT under (stamped; immutable), by order id. */
  readonly stamped: ReadonlyMap<string, ConsignmentRecordRow>;
  /** Story 4-6a (A39) — the live version, by order id (a late record after the dispatch). */
  readonly live: ReadonlyMap<string, ConsignmentRecordRow>;
}

/**
 * Story 4-5a — the cartons of a handover's orders: the live pack's count
 * (an order packed before 4-5a has no row: "1 carton (packed before cartons
 * were recorded)", A34), the cartons this handover scanned, and the two
 * facts the command recorded in its audit `changes` (A37's stale labels,
 * A44's COD carton).
 */
async function handoverCartonsInTx(tx: TenantTx, tenantId: string, handoverId: string, orderIds: readonly string[]): Promise<Map<string, HandoverCartonsRead>> {
  const result = new Map<string, HandoverCartonsRead>();
  if (orderIds.length === 0) return result;
  const packs = await tx
    .select({ orderId: orderPacks.orderId, cartonCount: orderPacks.cartonCount })
    .from(orderPacks)
    .where(and(eq(orderPacks.tenantId, tenantId), inArray(orderPacks.orderId, [...orderIds]), eq(orderPacks.status, 'live')));
  const packByOrder = new Map(packs.map((row) => [row.orderId, row.cartonCount]));
  const scans = await tx
    .select({ orderId: orderCartons.orderId, n: sql<number>`count(*)::int` })
    .from(orderCartons)
    .where(and(eq(orderCartons.tenantId, tenantId), eq(orderCartons.handoverId, handoverId)))
    .groupBy(orderCartons.orderId);
  const scannedByOrder = new Map(scans.map((row) => [row.orderId, Number(row.n)]));
  const audit = await tx
    .select({ changes: auditEvents.changes })
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, 'handover.created'), eq(auditEvents.targetId, handoverId)))
    .limit(1);
  const recorded = new Map<string, { codCartonScanned?: boolean; staleCartonLabels?: boolean }>();
  const changes = audit[0]?.changes as { cartons?: unknown } | null | undefined;
  if (changes !== null && changes !== undefined && Array.isArray(changes.cartons)) {
    for (const entry of changes.cartons as { orderId?: unknown; codCartonScanned?: unknown; staleCartonLabels?: unknown }[]) {
      if (typeof entry?.orderId !== 'string') continue;
      recorded.set(entry.orderId, {
        ...(typeof entry.codCartonScanned === 'boolean' ? { codCartonScanned: entry.codCartonScanned } : {}),
        ...(entry.staleCartonLabels === true ? { staleCartonLabels: true } : {}),
      });
    }
  }
  for (const orderId of orderIds) {
    const count = packByOrder.get(orderId);
    const facts = recorded.get(orderId);
    result.set(orderId, {
      cartonCount: count ?? 1,
      scanned: scannedByOrder.get(orderId) ?? 0,
      legacy: count === undefined,
      codCartonScanned: facts?.codCartonScanned ?? null,
      staleCartonLabels: facts?.staleCartonLabels === true,
    });
  }
  return result;
}

export async function handoverDetailInTx(tx: TenantTx, tenantId: string, handoverId: string): Promise<HandoverDetailRead | null> {
  if (!UUID_RE.test(handoverId)) return null;
  const rows = await tx
    .select()
    .from(courierHandovers)
    .where(and(eq(courierHandovers.tenantId, tenantId), eq(courierHandovers.id, handoverId)))
    .limit(1);
  const handover = rows[0];
  if (handover === undefined) return null;
  const parcels = await tx
    .select({ shipment: shipments, order: orders })
    .from(shipments)
    .innerJoin(orders, and(eq(orders.tenantId, shipments.tenantId), eq(orders.id, shipments.orderId)))
    .where(and(eq(shipments.tenantId, tenantId), eq(shipments.handoverId, handover.id)))
    .orderBy(asc(shipments.id));
  const pages = (
    await listByOwnerInTx(tx, { tenantId, ownerType: 'courier_handover', ownerIds: [handover.id], purposes: ['handover-sheet'] })
  ).filter((row) => row.status === 'attached');
  const names = shippingFileNames(handover.code, pages, await fileOrdinalsInTx(tx, { tenantId, ownerType: 'courier_handover', ownerIds: [handover.id], purposes: ['handover-sheet'] }));
  const cartons = await handoverCartonsInTx(tx, tenantId, handover.id, parcels.map((parcel) => parcel.order.id));
  // Story 4-6a (A19, A39, A45 D16) — the stamped version (the sheet reprints
  // it identically), falling back for an unstamped rollout dispatch to the
  // version live at the handover's commit; and the live one (a late record).
  const orderIds = parcels.map((parcel) => parcel.order.id);
  const stamped = await dispatchedConsignmentRecordsOfOrdersInTx(tx, tenantId, orderIds, new Map(orderIds.map((id) => [id, handover.createdAt])));
  const live = await liveConsignmentRecordsOfOrdersInTx(tx, tenantId, orderIds);
  return { handover, parcels, sheet: pages.map((row) => ({ row, fileName: names.get(row.id)! })), cartons, stamped, live };
}

export function maskedPhoneOf(handover: CourierHandover, unmasked: boolean): string | null {
  return unmasked ? handover.pickupPersonPhone : maskPhone(handover.pickupPersonPhone);
}

// ── the device snapshot's parcels (A18, A39) ────────────────────────────────

export const DISPATCH_PARCELS_MAX = 2000;

export interface DispatchParcel {
  readonly orderId: string;
  readonly clientId: string;
  readonly orderLabel: string;
  readonly parcelTagCode: string;
  readonly status: string;
  /** Story 4-5a (D6) — the stored live pack; absent for a virtual pack (pack 1, one carton). */
  readonly packSeq?: number;
  readonly cartonCount?: number;
  /** Story 4-5a (A44) — the COD amount (carton 1 carries its label); absent when prepaid. */
  readonly codAmountPaise?: number;
  readonly shipment: {
    readonly shipmentId: string;
    readonly kind: ShipmentKind;
    readonly awb: string;
    readonly courierName: string;
    readonly labelVerified: boolean;
  } | null;
  /** Story 4-6a (A23, D15) — the consignment gate today; the handheld refuses a blocking parcel locally. */
  readonly consignment?: ParcelConsignment;
}

/**
 * The warehouse's packed orders, plus its accepted orders holding a live
 * client-arranged shipment (a label verified right after a pack that has not
 * refreshed the snapshot), never one with a carrier shipment; at most 2000,
 * oldest first, with `truncated`.
 */
export async function dispatchParcelsInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<{ parcels: DispatchParcel[]; truncated: boolean }> {
  const rows = (await tx.execute(sql`
    select o.id as "orderId", o.client_id as "clientId", o.status as "status",
           o.client_order_ref as "clientOrderRef", o.external_event_id as "externalEventId",
           o.follow_on_seq as "followOnSeq", o.follow_on_root_order_id as "followOnRootOrderId",
           s.id as "shipmentId", s.kind as "kind", s.tracking_number as "awb", s.carrier_name as "courierName",
           (s.label_verified_at is not null) as "labelVerified",
           o.cod_amount_paise as "codAmountPaise", p.seq as "packSeq", p.carton_count as "cartonCount"
    from orders o
    left join shipments s on s.tenant_id = o.tenant_id and s.order_id = o.id and s.status <> 'voided'
    left join order_packs p on p.tenant_id = o.tenant_id and p.order_id = o.id and p.status = 'live'
    where o.tenant_id = ${tenantId}::uuid and o.warehouse_id = ${warehouseId}::uuid
      and (
        o.status = 'ready_to_dispatch'
        or (o.status = 'accepted' and s.id is not null and s.kind <> 'carrier' and s.status = 'labelled')
      )
      and (s.id is null or s.kind <> 'carrier')
      -- Story 4-9a (A19, A52) — an order on a truck is loaded, not handed over.
      and not exists (select 1 from freight_consignments fc where fc.tenant_id = o.tenant_id and fc.order_id = o.id and fc.status = 'planned')
    order by o.updated_at, o.id
    limit ${DISPATCH_PARCELS_MAX + 1}
  `)) as unknown as {
    orderId: string;
    clientId: string;
    status: string;
    clientOrderRef: string | null;
    externalEventId: string | null;
    followOnSeq: number | null;
    followOnRootOrderId: string | null;
    shipmentId: string | null;
    kind: string | null;
    awb: string | null;
    courierName: string | null;
    labelVerified: boolean | null;
    codAmountPaise: string | number | null;
    packSeq: number | null;
    cartonCount: number | null;
  }[];
  const truncated = rows.length > DISPATCH_PARCELS_MAX;
  // Story 4-6a (D15) — each parcel's consignment, in batches (one threshold read).
  const consignments = await parcelConsignmentsInTx(tx, tenantId, rows.slice(0, DISPATCH_PARCELS_MAX).map((row) => row.orderId), consignmentTodayIst());
  return {
    truncated,
    parcels: rows.slice(0, DISPATCH_PARCELS_MAX).map((row) => ({
      orderId: row.orderId,
      clientId: row.clientId,
      orderLabel: orderLabelOf({
        id: row.orderId,
        clientOrderRef: row.clientOrderRef,
        externalEventId: row.externalEventId,
        followOnSeq: row.followOnSeq,
        followOnRootOrderId: row.followOnRootOrderId,
      }),
      parcelTagCode: parcelTagCode(row.orderId),
      status: row.status,
      ...(row.packSeq === null || row.cartonCount === null ? {} : { packSeq: Number(row.packSeq), cartonCount: Number(row.cartonCount) }),
      ...(row.codAmountPaise === null ? {} : { codAmountPaise: Number(row.codAmountPaise) }),
      shipment:
        row.shipmentId === null
          ? null
          : { shipmentId: row.shipmentId, kind: row.kind as ShipmentKind, awb: row.awb!, courierName: row.courierName!, labelVerified: row.labelVerified === true },
      ...(consignments.has(row.orderId) ? { consignment: consignments.get(row.orderId)! } : {}),
    })),
  };
}

export type { ShipmentStatus };
