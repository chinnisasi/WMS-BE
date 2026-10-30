import { and, asc, eq, ne } from 'drizzle-orm';
import { courierHandovers, orders, shipments } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { canonicalInstant } from '../../shared/primitives/time';
import { listByOwnerInTx } from '../attachments/attachment-records';
import { shippingFileNames } from './shipping.read';

/**
 * Story 4-4a (A23, D6, D12) — what a `client-shipment-document` email names,
 * read ONCE at enqueue by the `client-emails` subscriber through
 * `OutboundFacade.shipmentDocumentEmailFactsInTx` (the outbox payload carries
 * ids only). Null when the file, its order or its handover is gone, or is not
 * the event's client's — the subscriber then queues nothing.
 */

/** The `shipment.document-shared` payload's fields the read needs. */
export interface ShipmentDocumentFactInput {
  readonly attachmentId: string;
  readonly clientId: string;
  readonly orderId: string | null;
  readonly handoverId: string | null;
  readonly purpose: 'shipping-document' | 'handover-sheet';
  readonly docKind: string | null;
}

export interface ShipmentDocumentEmailFacts {
  /** The order label (a document) or `HO-0007 (page 2)` (a sheet page) — the log's subject label. */
  readonly subjectLabel: string;
  readonly orderId: string | null;
  readonly orderRef: string | null;
  readonly handoverCode: string | null;
  readonly handedOverAt: string | null;
  readonly courierName: string | null;
  readonly awb: string | null;
  readonly fileName: string;
  /** 1-based, sheet pages only (D12). */
  readonly page: number | null;
  /** A sheet's parcels (≤ 100 — the handover's own cap). */
  readonly parcels: readonly { readonly orderRef: string; readonly awb: string }[];
}

export async function shipmentDocumentEmailFactsInTx(tx: TenantTx, tenantId: string, fact: ShipmentDocumentFactInput): Promise<ShipmentDocumentEmailFacts | null> {
  if (!UUID_RE.test(fact.attachmentId) || !UUID_RE.test(fact.clientId)) return null;
  if (fact.purpose === 'shipping-document') {
    if (fact.orderId === null || !UUID_RE.test(fact.orderId)) return null;
    const order = (
      await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.id, fact.orderId), eq(orders.clientId, fact.clientId))).limit(1)
    )[0];
    if (order === undefined) return null;
    const files = await listByOwnerInTx(tx, {
      tenantId,
      ownerType: 'order',
      ownerIds: [order.id],
      purposes: ['shipping-label', 'shipping-document'],
      clientId: fact.clientId,
      includeHistory: true,
    });
    const label = orderLabelOf(order);
    const fileName = shippingFileNames(label, files).get(fact.attachmentId);
    if (fileName === undefined) return null;
    const live = (
      await tx
        .select()
        .from(shipments)
        .where(and(eq(shipments.tenantId, tenantId), eq(shipments.orderId, order.id), ne(shipments.status, 'voided')))
        .limit(1)
    )[0];
    let handover: { code: string; handedOverAt: string } | null = null;
    if (live?.handoverId != null) {
      const row = (await tx.select().from(courierHandovers).where(and(eq(courierHandovers.tenantId, tenantId), eq(courierHandovers.id, live.handoverId))).limit(1))[0];
      handover = row === undefined ? null : { code: row.code, handedOverAt: canonicalInstant(row.handedOverAt) };
    }
    return {
      subjectLabel: label,
      orderId: order.id,
      orderRef: label,
      handoverCode: handover?.code ?? null,
      handedOverAt: handover?.handedOverAt ?? null,
      courierName: live?.carrierName ?? null,
      awb: live?.trackingNumber ?? null,
      fileName,
      page: null,
      parcels: [],
    };
  }
  if (fact.handoverId === null || !UUID_RE.test(fact.handoverId)) return null;
  const handover = (
    await tx
      .select()
      .from(courierHandovers)
      .where(and(eq(courierHandovers.tenantId, tenantId), eq(courierHandovers.id, fact.handoverId), eq(courierHandovers.clientId, fact.clientId)))
      .limit(1)
  )[0];
  if (handover === undefined) return null;
  const pages = await listByOwnerInTx(tx, {
    tenantId,
    ownerType: 'courier_handover',
    ownerIds: [handover.id],
    purposes: ['handover-sheet'],
    clientId: fact.clientId,
    includeHistory: true,
  });
  const fileName = shippingFileNames(handover.code, pages).get(fact.attachmentId);
  if (fileName === undefined) return null;
  const ordered = [...pages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  const page = ordered.findIndex((row) => row.id === fact.attachmentId) + 1;
  const parcels = await tx
    .select({ shipment: shipments, order: orders })
    .from(shipments)
    .innerJoin(orders, and(eq(orders.tenantId, shipments.tenantId), eq(orders.id, shipments.orderId)))
    .where(and(eq(shipments.tenantId, tenantId), eq(shipments.handoverId, handover.id)))
    .orderBy(asc(shipments.id));
  return {
    subjectLabel: `${handover.code} (page ${page})`,
    orderId: null,
    orderRef: null,
    handoverCode: handover.code,
    handedOverAt: canonicalInstant(handover.handedOverAt),
    courierName: handover.courierName,
    awb: null,
    fileName,
    page,
    parcels: parcels.map(({ shipment, order }) => ({ orderRef: orderLabelOf(order), awb: shipment.trackingNumber })),
  };
}
