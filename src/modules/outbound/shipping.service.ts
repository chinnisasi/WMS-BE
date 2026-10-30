import { orderFreightBlockInTx, portalFreightBlocksInTx, type OrderFreightBlock, type PortalFreightBlock } from './freight.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { orders, type AttachmentRow, type CourierHandover } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { parcelTagCode } from '../../shared/primitives/parcel-tag';
import { canonicalInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { renderParcelTagPdf, renderParcelTagZpl } from '../../shared/labels/parcel-tag';
import { getClientsInTx } from '../clients/clients.facade';
import { ROLE_CAPABILITIES } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { AttachmentsFacade } from '../attachments/attachments.facade';
import { fileOrdinalsInTx, liveRowsByRefsInTx } from '../attachments/attachment-records';
import { InventoryFacade } from '../inventory/inventory.facade';
import { ClientLabelCommand } from './client-label.command';
import { ShippingFilesCommand } from './shipping-files.command';
import { HandoverCommand, handoverViewOf, type HandOverCommand, type HandoverSnapshot, type HandoverView } from './handover.command';
import { DispatchCommandService } from './dispatch.command';
import { livePackFactsOfOrdersInTx, packRecordOfOrderInTx, skuFactsByIdInTx, uomTotalsOf } from './cartons.read';
import { fromMilli } from '../../shared/primitives/quantity';
import { AllocationCommandService } from './allocation.command';
import { clientShipmentViewOf, type ClientShipmentView } from './shipping-views';
import type { ConsignmentRecordRow } from '../invoicing/consignment-seam';
import { consignmentTodayIst, parcelConsignmentsInTx } from './consignment.read';
import { LABEL_OPEN_STATUSES, orderNotFound, orderNotOpen } from './shipping-support';
import {
  candidateOf,
  decodeKeyset,
  dispatchParcelsInTx,
  encodeKeyset,
  handoverCandidateRowsInTx,
  handoverDetailInTx,
  handoverWindow,
  HANDOVER_CANDIDATES_DEFAULT_LIMIT,
  HANDOVER_CANDIDATES_MAX_LIMIT,
  listHandoversInTx,
  maskedPhoneOf,
  orderShippingInTx,
  portalShippingStatus,
  shippingFileNames,
  type DispatchParcel,
  type HandoverCandidate,
  type HandoverCartonsRead,
  type HandoverListItem,
  type PortalShippingStatus,
  type UnsignedFile,
} from './shipping.read';

/**
 * Story 4-4a — the client-arranged shipping service the outbound facade
 * delegates to: the commands' after-commit work (a handover's counter
 * restores and follow-on allocations — never thrown), and the reads with
 * their presigned URLs (minted AFTER the read transaction; a read never fails
 * because a URL could not be signed).
 */

/** A16 — one stored file as the staff reads list it. */
export interface FileView {
  readonly id: string;
  readonly purpose: string;
  readonly docKind: string | null;
  readonly fileName: string;
  readonly contentType: string | null;
  readonly byteSize: number | null;
  readonly pageCount: number | null;
  readonly source: string;
  readonly uploadedAt: string | null;
  readonly uploadedBy: string | null;
  readonly url: string | null;
  readonly urlExpiresAt: string | null;
}

/** A17 — one stored file as the portal lists it (no user id). */
export interface PortalFile {
  readonly id: string;
  /** The document kind, `label` or `signed-sheet`. */
  readonly kind: string;
  readonly fileName: string;
  readonly contentType: string | null;
  readonly pageCount: number | null;
  readonly uploadedAt: string | null;
  readonly uploadedByYou: boolean;
  readonly url: string | null;
  readonly urlExpiresAt: string | null;
}

export interface OrderShippingView {
  readonly shipment: ClientShipmentView | null;
  readonly history: readonly ClientShipmentView[];
  readonly label: FileView | null;
  readonly documents: readonly FileView[];
  readonly handover: {
    readonly id: string;
    readonly code: string;
    readonly courierName: string;
    readonly handedOverAt: string;
    readonly pickupPersonName: string;
    readonly pickupPersonPhoneMasked: string | null;
    readonly vehicleNumber: string | null;
    readonly sheet: readonly FileView[];
  } | null;
  readonly parcelTagCode: string;
  readonly storageEnabled: boolean;
  /** Story 4-9a (A20, A52) — the order's live freight consignment; null when none. Optional on read. */
  readonly freight?: OrderFreightBlock | null;
}

export interface PortalOrderShippingView {
  /** FB9 — the client may record a label or AWB now (Upload / Replace / Send AWB). */
  readonly canRecord: boolean;
  readonly status: PortalShippingStatus;
  readonly courierName: string | null;
  readonly awb: string | null;
  readonly packageCount: number | null;
  readonly handedOverAt: string | null;
  readonly vehicleNumber: string | null;
  readonly handoverCode: string | null;
  readonly pickupPersonName: string | null;
  readonly label: PortalFile | null;
  readonly documents: readonly PortalFile[];
  readonly handoverSheet: readonly PortalFile[];
  /** Story 4-5a (A19, A36) — the pack's cartons (no code, no handling unit, no packer); null before packing. */
  readonly cartons: readonly { readonly seq: number; readonly weightGrams: number | null; readonly totals: readonly { readonly uom: string; readonly qty: number }[] }[] | null;
  /** Story 4-5a (A19) — packed or dispatched: the slip downloads. */
  readonly packingSlipAvailable: boolean;
  /** Story 4-9a (A22) — the truck block (an exact allowlist; only `status` while planned); null when none. Optional on read. */
  readonly freight?: PortalFreightBlock | null;
}

export interface PortalShippingRead {
  readonly shipping: NonNullable<Awaited<ReturnType<typeof orderShippingInTx>>>;
  readonly hasDispatchRecord: boolean;
  readonly dispatchRecord: { readonly carrierName: string | null; readonly trackingNumber: string | null } | null;
  /** Story 4-5a — the pack's cartons with their per-UoM totals (base units); null when never packed. */
  readonly cartons: PortalOrderShippingView['cartons'];
  /** Story 4-9a (A22) — the client's freight block and the facts the status judges first. */
  readonly freight: PortalFreightBlock | null;
}

export interface HandoverDetailView extends HandoverView {
  readonly pickupPersonPhone: string | null;
  readonly note: string | null;
  readonly clientSnapshot: unknown;
  readonly warehouseSnapshot: unknown;
  readonly courierSnapshot: unknown;
  readonly createdBy: string;
  readonly parcels: readonly {
    readonly orderId: string;
    readonly orderLabel: string;
    readonly shipmentId: string;
    readonly kind: string;
    readonly awb: string;
    readonly packageCount: number | null;
    readonly weightGrams: number | null;
    readonly codAmountPaise: number | null;
    readonly destinationCity: string | null;
    readonly cartons: HandoverCartonsRead;
    /** Story 4-6a (A19) — the brand's document the parcel LEFT under (the stamped version), or null. */
    readonly taxDocument?: { readonly type: string; readonly number: string; readonly date: string } | null;
    readonly ewayBillNumber?: string | null;
    readonly ewayValidUntil?: string | null;
    /** Story 4-6a (A14) — a device parcel that left without its documents. */
    readonly complianceException?: string | null;
    /** Story 4-6a (A39) — the live version recorded after the dispatch (clears an exception), or null. */
    readonly lateRecord?: {
      readonly seq: number;
      readonly brandDocument: { readonly type: string; readonly number: string; readonly date: string };
      readonly ewayBillNumber: string | null;
      readonly recordedAt: string;
    } | null;
  }[];
  readonly sheet: readonly FileView[];
}

/** Story 4-6a (A19, A39) — a handover parcel's consignment keys: the stamped version, the flag, a late record. */
function consignmentOfParcel(stamped: ConsignmentRecordRow | null, live: ConsignmentRecordRow | null, complianceException: string | null) {
  const late =
    live !== null && live.recordedAfterDispatch && (stamped === null || live.id !== stamped.id)
      ? {
          seq: live.seq,
          brandDocument: { type: live.brandDocumentType, number: live.brandDocumentNumber, date: live.brandDocumentDate },
          ewayBillNumber: live.ewayBillNumber,
          recordedAt: canonicalInstant(live.recordedAt),
        }
      : null;
  return {
    taxDocument: stamped === null ? null : { type: stamped.brandDocumentType, number: stamped.brandDocumentNumber, date: stamped.brandDocumentDate },
    ewayBillNumber: stamped?.ewayBillNumber ?? null,
    ewayValidUntil: stamped?.ewayValidUntil ?? null,
    complianceException,
    lateRecord: late,
  };
}

@Injectable()
export class ShippingService {
  private readonly logger = new Logger('ShippingService');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AttachmentsFacade) private readonly attachments: AttachmentsFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(ClientLabelCommand) readonly labels: ClientLabelCommand,
    @Inject(ShippingFilesCommand) readonly files: ShippingFilesCommand,
    @Inject(HandoverCommand) private readonly handovers: HandoverCommand,
    @Inject(DispatchCommandService) private readonly dispatch: DispatchCommandService,
    @Inject(AllocationCommandService) private readonly allocation: AllocationCommandService,
  ) {}

  /** A12 — the handover, then (after its commit) each order's counter restores and follow-on allocation; nothing thrown. */
  async handOver(command: HandOverCommand, key: string): Promise<HandoverSnapshot> {
    const outcome = await this.handovers.handOver(command, key);
    for (const entry of outcome.after) {
      await this.dispatch.applyCounterRestores(command.tenantId, entry.warehouseId, entry.orderId, entry.restores);
      if (entry.followOnOrderId !== null) {
        try {
          await this.allocation.allocateOrderCore(command.tenantId, entry.followOnOrderId, { entry: 'dispatch' });
        } catch (err) {
          this.logger.error(
            `After-handover allocation of follow-on ${entry.followOnOrderId} failed — the sweep retries it: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return outcome.snapshot;
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async orderShipping(tenantId: string, orderId: string): Promise<OrderShippingView | null> {
    const both = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const shipping = await orderShippingInTx(tx, tenantId, orderId);
      return shipping === null ? null : { shipping, freight: await orderFreightBlockInTx(tx, tenantId, shipping.order.id) };
    });
    if (both === null) return null;
    const read = both.shipping;
    const [label, documents, sheet] = await Promise.all([
      read.label === null ? Promise.resolve(null) : this.fileView(read.label),
      Promise.all(read.documents.map((file) => this.fileView(file))),
      Promise.all(read.sheet.map((file) => this.fileView(file))),
    ]);
    return {
      shipment: read.live === null ? null : clientShipmentViewOf(read.live),
      history: read.history.map(clientShipmentViewOf),
      label,
      documents,
      handover:
        read.handover === null
          ? null
          : {
              id: read.handover.id,
              code: read.handover.code,
              courierName: read.handover.courierName,
              handedOverAt: canonicalInstant(read.handover.handedOverAt),
              pickupPersonName: read.handover.pickupPersonName,
              pickupPersonPhoneMasked: maskedPhoneOf(read.handover, false),
              vehicleNumber: read.handover.vehicleNumber,
              sheet,
            },
      parcelTagCode: parcelTagCode(read.order.id),
      storageEnabled: this.attachments.storageEnabled,
      freight: both.freight,
    };
  }

  /**
   * A17 — the portal read's transaction body (the facade opens it, stamped
   * with the session's client): two layers — the stamp and every query's
   * explicit `client_id = $client`.
   */
  async portalOrderShippingReadInTx(tx: TenantTx, tenantId: string, clientId: string, orderId: string): Promise<PortalShippingRead | null> {
    const shipping = await orderShippingInTx(tx, tenantId, orderId, clientId);
    if (shipping === null) return null;
    const dispatched = shipping.order.status === 'dispatched' ? await this.inventory.firstDispatchByOrderInTx(tx, tenantId, [shipping.order.id]) : new Map();
    const first = dispatched.get(shipping.order.id) ?? null;
    const dispatchRecord = first === null ? null : { carrierName: first.carrierName ?? null, trackingNumber: first.trackingNumber ?? null };
    // Story 4-5a (A19) — the pack (live, latest or virtual), reached through
    // the client-filtered order read above (and the stamp on every row).
    const record = await packRecordOfOrderInTx(tx, tenantId, shipping.order, (t, tenant, warehouse, id) =>
      this.inventory.ledgerEventsByOrderRefInTx(t, tenant, warehouse, id),
    );
    let cartons: PortalOrderShippingView['cartons'] = null;
    if (record !== null) {
      const skus = await skuFactsByIdInTx(tx, tenantId, record.cartons.flatMap((carton) => carton.lines.map((line) => line.skuId)));
      cartons = record.cartons.map((carton) => ({
        seq: carton.seq,
        weightGrams: carton.weightGrams,
        totals: uomTotalsOf(carton.lines.map((line) => ({ uom: skus.get(line.skuId)?.uom ?? '', qty: fromMilli(line.qty) }))),
      }));
    }
    const freight = (await portalFreightBlocksInTx(tx, tenantId, clientId, [shipping.order.id])).get(shipping.order.id) ?? null;
    return {
      shipping,
      cartons,
      freight,
      // E2 — "the dispatch record names a carrier or a tracking number".
      hasDispatchRecord: dispatchRecord !== null && (dispatchRecord.carrierName !== null || dispatchRecord.trackingNumber !== null),
      dispatchRecord,
    };
  }

  /** A17, A44, A45 — the portal's Shipping section: an exact key allowlist, presigned after the read. */
  async portalOrderShippingView(read: PortalShippingRead): Promise<PortalOrderShippingView> {
    const { shipping } = read;
    const live = shipping.live;
    const handover = shipping.handover;
    const portalFile = async (file: UnsignedFile, kind: string): Promise<PortalFile> => {
      const signed = await this.attachments.presign(file.row, file.fileName);
      return {
        id: file.row.id,
        kind,
        fileName: file.fileName,
        contentType: file.row.contentType,
        pageCount: file.row.pageCount,
        uploadedAt: file.row.uploadedAt === null ? null : canonicalInstant(file.row.uploadedAt),
        uploadedByYou: file.row.source === 'portal',
        url: signed?.url ?? null,
        urlExpiresAt: signed?.expiresAt ?? null,
      };
    };
    const [label, documents, handoverSheet] = await Promise.all([
      shipping.label === null ? Promise.resolve(null) : portalFile(shipping.label, 'label'),
      Promise.all(shipping.documents.map((file) => portalFile(file, file.row.docKind ?? 'other'))),
      Promise.all(shipping.sheet.map((file) => portalFile(file, 'signed-sheet'))),
    ]);
    const openOrder = shipping.order.status === 'accepted' || shipping.order.status === 'ready_to_dispatch';
    return {
      // FB9 — what `assertLabellable` admits for the portal (with or without
      // replace): an open order with no live shipment, or a client-arranged one still `labelled`.
      canRecord: openOrder && (live === null || (live.kind !== 'carrier' && live.status === 'labelled')),
      status: portalShippingStatus(
        shipping.order.status,
        live === null ? null : { kind: live.kind, status: live.status, labelVerified: live.labelVerifiedAt !== null },
        read.hasDispatchRecord,
        read.freight === null ? null : { status: read.freight.status === 'planned' ? 'planned' : 'dispatched', deliveryOutcome: read.freight.status === 'delivered' || read.freight.status === 'delivered-with-exceptions' || read.freight.status === 'refused' ? read.freight.status : null },
      ),
      // E2 — with no live shipment, the dispatch record's courier and AWB.
      courierName: live?.carrierName ?? read.dispatchRecord?.carrierName ?? null,
      awb: live?.trackingNumber ?? read.dispatchRecord?.trackingNumber ?? null,
      packageCount: live?.packageCount ?? null,
      handedOverAt: handover === null ? null : canonicalInstant(handover.handedOverAt),
      vehicleNumber: handover?.vehicleNumber ?? null,
      handoverCode: handover?.code ?? null,
      // A45 — the pickup person is on the signed sheet the client receives; the phone never is.
      pickupPersonName: handover?.pickupPersonName ?? null,
      label,
      documents,
      handoverSheet,
      cartons: read.cartons === null ? null : read.cartons.map((carton) => ({ seq: carton.seq, weightGrams: carton.weightGrams, totals: carton.totals.map((total) => ({ uom: total.uom, qty: total.qty })) })),
      packingSlipAvailable: read.cartons !== null && (shipping.order.status === 'ready_to_dispatch' || shipping.order.status === 'dispatched'),
      freight: read.freight,
    };
  }

  async handoverCandidates(
    tenantId: string,
    warehouseId: string,
    clientId: string,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<{ items: HandoverCandidate[]; nextCursor: string | null }> {
    if (!UUID_RE.test(clientId)) throw new ProblemException('validation-failed', 400, 'Invalid client', 'clientId must be a uuid.');
    const limit = Math.min(Math.max(query.limit ?? HANDOVER_CANDIDATES_DEFAULT_LIMIT, 1), HANDOVER_CANDIDATES_MAX_LIMIT);
    const after = decodeKeyset(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const { rows } = await handoverCandidateRowsInTx(tx, tenantId, warehouseId, clientId, after, limit);
      const page = rows.slice(0, limit);
      const packs = await this.inventory.packMeasurementsOfOrdersInTx(tx, tenantId, page.map((row) => row.order.id));
      // Story 4-5a (A21, A33, A39, D4) — the stored live pack's facts merge over the ledger's.
      const live = await livePackFactsOfOrdersInTx(tx, tenantId, page.map((row) => row.order.id));
      // Story 4-6a (A16) — each candidate's consignment gate today.
      const consignments = await parcelConsignmentsInTx(tx, tenantId, page.map((row) => row.order.id), consignmentTodayIst());
      const last = page.at(-1);
      return {
        items: page.map((row) => {
          const ledger = packs.get(row.order.id) ?? null;
          const facts = live.get(row.order.id) ?? null;
          const candidate = candidateOf(
            row.order,
            row.shipment,
            ledger?.packedAt ?? null,
            facts === null ? null : { packSeq: facts.packSeq, cartonCount: facts.cartonCount },
            facts !== null ? facts.weightGrams : (ledger?.weightGrams ?? null),
          );
          const consignment = consignments.get(row.order.id);
          return consignment === undefined ? candidate : { ...candidate, consignment };
        }),
        nextCursor: rows.length > limit && last !== undefined ? encodeKeyset(last.cursorAt, last.order.id) : null,
      };
    });
  }

  async listHandovers(
    tenantId: string,
    warehouseId: string,
    query: { clientId?: string | undefined; from?: string | undefined; to?: string | undefined; cursor?: string | undefined; limit?: number | undefined },
  ): Promise<{ items: HandoverListItem[]; nextCursor: string | null }> {
    const window = handoverWindow(query.from, query.to);
    const after = decodeKeyset(query.cursor);
    const clientId = query.clientId === undefined || query.clientId === '' ? null : query.clientId;
    if (clientId !== null && !UUID_RE.test(clientId)) throw new ProblemException('validation-failed', 400, 'Invalid client', 'clientId must be a uuid.');
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      return listHandoversInTx(tx, tenantId, warehouseId, { clientId, from: window.from, to: window.to, after, limit });
    });
  }

  /** The handover detail; the phone unmasked for a `dispatch.execute` holder only. */
  async handoverDetail(tenantId: string, handoverId: string, actorUserId: string): Promise<HandoverDetailView | null> {
    const read = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const detail = await handoverDetailInTx(tx, tenantId, handoverId);
      if (detail === null) return null;
      const role = await getMemberRoleIn(tx, tenantId, actorUserId);
      return { detail, unmask: ROLE_CAPABILITIES[role].has('dispatch.execute') };
    });
    if (read === null) return null;
    const { detail } = read;
    const sheet = await Promise.all(detail.sheet.map((file) => this.fileView(file)));
    const handover: CourierHandover = detail.handover;
    return {
      ...handoverViewOf(handover),
      pickupPersonPhone: maskedPhoneOf(handover, read.unmask),
      note: handover.note,
      clientSnapshot: handover.clientSnapshot,
      warehouseSnapshot: handover.warehouseSnapshot,
      courierSnapshot: handover.courierSnapshot,
      createdBy: handover.createdBy,
      parcels: detail.parcels.map(({ shipment, order }) => ({
        orderId: order.id,
        orderLabel: orderLabelOf(order),
        shipmentId: shipment.id,
        kind: shipment.kind,
        awb: shipment.trackingNumber,
        packageCount: shipment.packageCount,
        weightGrams: shipment.weightGrams,
        codAmountPaise: order.codAmountPaise,
        destinationCity: order.destinationCity,
        cartons: detail.cartons.get(order.id) ?? { cartonCount: 1, scanned: 0, legacy: true, codCartonScanned: null, staleCartonLabels: false },
        ...consignmentOfParcel(detail.stamped.get(order.id) ?? null, detail.live.get(order.id) ?? null, shipment.complianceException),
      })),
      sheet,
    };
  }

  /** A16, D32 — the parcel tag, 4×2 only; a file read (no key, no audit). */
  async parcelTag(tenantId: string, orderId: string, format: 'zpl' | 'pdf'): Promise<{ body: Buffer; contentType: string; fileName: string }> {
    const facts = await withTenantTransaction(this.db, tenantId, async (tx) => {
      if (!UUID_RE.test(orderId)) throw orderNotFound(orderId);
      const rows = await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId))).limit(1);
      const order = rows[0];
      if (order === undefined) throw orderNotFound(orderId);
      const label = orderLabelOf(order);
      if (!(LABEL_OPEN_STATUSES as readonly string[]).includes(order.status)) throw orderNotOpen(order, label);
      const client = (await getClientsInTx(tx, tenantId, [order.clientId])).get(order.clientId);
      const shipping = await orderShippingInTx(tx, tenantId, order.id);
      return { order, label, clientCode: client?.code ?? '', packageCount: shipping?.live?.packageCount ?? 1 };
    });
    const tag = {
      orderId: facts.order.id,
      orderLabel: facts.label,
      clientCode: facts.clientCode,
      destinationCity: facts.order.destinationCity,
      destinationPincode: facts.order.destinationPincode,
      codAmountPaise: facts.order.codAmountPaise,
      packageCount: facts.packageCount,
    };
    const base = `${facts.label.replace(/[^A-Za-z0-9._-]+/g, '_')}-parcel-tag`;
    return format === 'zpl'
      ? { body: Buffer.from(renderParcelTagZpl(tag), 'utf8'), contentType: 'text/plain; charset=utf-8', fileName: `${base}.zpl` }
      : { body: await renderParcelTagPdf(tag), contentType: 'application/pdf', fileName: `${base}.pdf` };
  }

  /**
   * FA29 (spec A29) — presigned links to a review row's sheet photos still
   * `staged` / `attached`; a null URL when unsigned (never a failure).
   */
  async photoLinksByRefs(tenantId: string, refs: readonly string[]): Promise<{ ref: string; url: string | null; urlExpiresAt: string | null }[]> {
    const valid = refs.filter((ref) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(ref));
    if (valid.length === 0) return [];
    const rows = await withTenantTransaction(this.db, tenantId, (tx) => liveRowsByRefsInTx(tx, tenantId, valid));
    const byRef = new Map(rows.map((row) => [row.clientRef!, row]));
    const out: { ref: string; url: string | null; urlExpiresAt: string | null }[] = [];
    for (const ref of valid) {
      const row = byRef.get(ref);
      if (row === undefined) continue;
      const signed = await this.attachments.presign(row, `sheet-photo-${ref}.${row.contentType === 'image/png' ? 'png' : row.contentType === 'image/webp' ? 'webp' : 'jpg'}`);
      out.push({ ref, url: signed?.url ?? null, urlExpiresAt: signed?.expiresAt ?? null });
    }
    return out;
  }

  async dispatchParcelsInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<{ parcels: DispatchParcel[]; truncated: boolean }> {
    return dispatchParcelsInTx(tx, tenantId, warehouseId);
  }

  /**
   * A23 / D8 — the derived file name of one shipping file, for the mail
   * renderer (inside the registry's client-stamped transaction). Null when it
   * is not a shareable file of that client.
   */
  async shippingFileNameInTx(tx: TenantTx, tenantId: string, clientId: string, row: AttachmentRow): Promise<string | null> {
    if (row.clientId !== clientId || row.ownerId === null) return null;
    if (row.ownerType === 'order') {
      const order = (await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.id, row.ownerId), eq(orders.clientId, clientId))).limit(1))[0];
      if (order === undefined) return null;
      const ordinals = await fileOrdinalsInTx(tx, { tenantId, ownerType: 'order', ownerIds: [order.id], purposes: ['shipping-label', 'shipping-document'] });
      return shippingFileNames(orderLabelOf(order), [row], ordinals).get(row.id) ?? null;
    }
    if (row.ownerType === 'courier_handover') {
      const detail = await handoverDetailInTx(tx, tenantId, row.ownerId);
      if (detail === null || detail.handover.clientId !== clientId) return null;
      const ordinals = await fileOrdinalsInTx(tx, { tenantId, ownerType: 'courier_handover', ownerIds: [row.ownerId], purposes: ['handover-sheet'] });
      return shippingFileNames(detail.handover.code, [row], ordinals).get(row.id) ?? null;
    }
    return null;
  }

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
