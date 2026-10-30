import type { AttachmentRow, Shipment } from '../../shared/db/schema';
import { canonicalInstant } from '../../shared/primitives/time';
import type { ShipmentKind, ShipmentStatus } from './shipment.command';

/**
 * Story 4-4a — the client-arranged shipping views: the staff `ShipmentView`
 * (every arm a desk needs) and the portal's allowlisted shape (rebuilt key
 * by key — never a spread). Both are what a command stores as its snapshot,
 * so nothing here expires (no presigned URL — the reads mint those).
 */

export interface ClientShipmentView {
  readonly id: string;
  readonly orderId: string;
  readonly kind: ShipmentKind;
  readonly status: ShipmentStatus;
  /** The courier (a transporter's trade name, or the typed name; the registry name on a carrier row). */
  readonly courierName: string;
  /** The AWB / LR number as stored (`normalizeAwb`). */
  readonly awb: string;
  readonly packageCount: number | null;
  readonly transporterId: string | null;
  readonly labelAttachmentId: string | null;
  readonly labelVerifiedAt: string | null;
  readonly labelVerifyMethod: string | null;
  readonly recordedSurface: string | null;
  readonly labelledAt: string;
  readonly labelledBy: string;
  readonly handoverId: string | null;
  readonly handedOverAt: string | null;
  readonly weightGrams: number | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
}

export function clientShipmentViewOf(row: Shipment): ClientShipmentView {
  return {
    id: row.id,
    orderId: row.orderId,
    kind: row.kind as ShipmentKind,
    status: row.status as ShipmentStatus,
    courierName: row.carrierName,
    awb: row.trackingNumber,
    packageCount: row.packageCount,
    transporterId: row.courierPartnerId,
    labelAttachmentId: row.labelAttachmentId,
    labelVerifiedAt: row.labelVerifiedAt === null ? null : canonicalInstant(row.labelVerifiedAt),
    labelVerifyMethod: row.labelVerifyMethod,
    recordedSurface: row.recordedSurface,
    labelledAt: canonicalInstant(row.labelledAt),
    labelledBy: row.labelledBy,
    handoverId: row.handoverId,
    handedOverAt: row.handedOverAt === null ? null : canonicalInstant(row.handedOverAt),
    weightGrams: row.weightGrams,
    voidedAt: row.voidedAt === null ? null : canonicalInstant(row.voidedAt),
    voidReason: row.voidReason,
  };
}

/** The portal's shipment: no user, no device, no void reason (A17). */
export interface PortalShipmentView {
  readonly id: string;
  readonly orderId: string;
  readonly kind: ShipmentKind;
  readonly status: ShipmentStatus;
  readonly courierName: string;
  readonly awb: string;
  readonly packageCount: number | null;
  readonly recordedAt: string;
}

export function portalShipmentViewOf(row: Shipment): PortalShipmentView {
  return {
    id: row.id,
    orderId: row.orderId,
    kind: row.kind as ShipmentKind,
    status: row.status as ShipmentStatus,
    courierName: row.carrierName,
    awb: row.trackingNumber,
    packageCount: row.packageCount,
    recordedAt: canonicalInstant(row.labelledAt),
  };
}

/** A stored shipping file as a command answers it (no URL — A14's rule). */
export interface ShippingFileSnapshot {
  readonly id: string;
  readonly purpose: string;
  readonly docKind: string | null;
  readonly contentType: string | null;
  readonly byteSize: number | null;
  readonly pageCount: number | null;
  readonly source: string;
  readonly status: string;
  readonly uploadedAt: string | null;
}

export function shippingFileSnapshotOf(row: AttachmentRow): ShippingFileSnapshot {
  return {
    id: row.id,
    purpose: row.purpose,
    docKind: row.docKind,
    contentType: row.contentType,
    byteSize: row.byteSize,
    pageCount: row.pageCount,
    source: row.source,
    status: row.status,
    uploadedAt: row.uploadedAt === null ? null : canonicalInstant(row.uploadedAt),
  };
}
