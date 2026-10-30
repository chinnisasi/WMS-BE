import { and, eq, ne } from 'drizzle-orm';
import { shipments, type Order, type Shipment } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { listByOwnerInTx, removeAttachmentIfLiveInTx } from '../attachments/attachment-records';

/**
 * Story 4-4a — the pieces every client-arranged shipment writer shares: the
 * void reasons, the `shipment.voided` payload (the 4-2b shape, plus optional
 * `kind` and `voidReason` on a client-arranged row — D37) and the void itself
 * (row, label file, outbox) on the caller's transaction. Audit rows stay the
 * caller's (their reference is the caller's key).
 */

/** A27 / A24 — a cancel (plain, with restock, or a channel cancellation) voids the label. */
export const CANCELLED_VOID_REASON = 'Order cancelled';
/** A8 — a client (portal) replace. */
export const CLIENT_REPLACED_VOID_REASON = 'Replaced by the client';
/** A8 — a staff replace. */
export const STAFF_REPLACED_VOID_REASON = 'Replaced';

/** The 4-2b `shipment.voided` payload; the two keys are added only for a client-arranged row. */
export function shipmentVoidedPayload(row: Shipment, voidedAt: string, voidedBy: string): { shipment: Record<string, unknown> } {
  return {
    shipment: {
      id: row.id,
      orderId: row.orderId,
      warehouseId: row.warehouseId,
      status: 'voided',
      carrierConnectionId: row.carrierConnectionId,
      carrierCode: row.carrierCode,
      carrierName: row.carrierName,
      trackingNumber: row.trackingNumber,
      voidedAt: canonicalInstant(voidedAt),
      voidedBy,
      ...(row.kind === 'carrier' ? {} : { kind: row.kind, voidReason: row.voidReason }),
    },
  };
}

/**
 * Voids a client-arranged `labelled` shipment the caller holds `FOR UPDATE`:
 * `voided` with its stamps and reason (conditional on `labelled`), its label
 * file `removed` with the same reason and actor (D10), and the
 * `shipment.voided` outbox event. Returns the voided row.
 */
export async function voidClientArrangedShipmentInTx(
  tx: TenantTx,
  outbox: OutboxSink,
  input: { readonly tenantId: string; readonly shipment: Shipment; readonly actorUserId: string; readonly reason: string; readonly at: string },
): Promise<Shipment> {
  const [voided] = await tx
    .update(shipments)
    .set({ status: 'voided', voidedAt: input.at, voidedBy: input.actorUserId, voidReason: input.reason, updatedAt: input.at })
    .where(and(eq(shipments.id, input.shipment.id), eq(shipments.tenantId, input.tenantId), eq(shipments.status, 'labelled')))
    .returning();
  if (voided === undefined) {
    // Unreachable beneath the caller's row lock; the backstop rolls back.
    throw new ProblemException('conflict', 409, 'Shipment moved', 'The shipment changed while it was being voided — nothing was written; try again.');
  }
  if (voided.labelAttachmentId !== null) {
    await removeAttachmentIfLiveInTx(tx, {
      tenantId: input.tenantId,
      attachmentId: voided.labelAttachmentId,
      removedBy: input.actorUserId,
      reason: input.reason,
    });
  }
  await outbox.append(tx, {
    messageId: uuidv7(),
    tenantId: input.tenantId,
    type: 'shipment.voided',
    occurredAt: input.at,
    payload: shipmentVoidedPayload(voided, input.at, input.actorUserId),
  });
  return voided;
}

/**
 * The order's LIVE shipment (any kind, any status but `voided`), or null. One
 * row at most (`shipments_tenant_order_live_unique`). A plain read: every
 * writer of an order's shipment holds the order row `FOR UPDATE` first.
 */
export async function liveShipmentOfOrderInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<Shipment | null> {
  const rows = await tx
    .select()
    .from(shipments)
    .where(and(eq(shipments.tenantId, tenantId), eq(shipments.orderId, orderId), ne(shipments.status, 'voided')))
    .limit(1);
  return rows[0] ?? null;
}

/** The `shipment.document-shared` outbox payload (D6 — a staff-internal event; no webhook carries it). */
export interface ShipmentDocumentSharedPayload {
  readonly attachmentId: string;
  readonly clientId: string;
  readonly orderId: string | null;
  readonly handoverId: string | null;
  readonly purpose: 'shipping-document' | 'handover-sheet';
  readonly docKind: string | null;
}

export const SHIPMENT_DOCUMENT_SHARED_EVENT = 'shipment.document-shared';

/** Appends one `shipment.document-shared` for one stored file. */
export async function appendDocumentSharedInTx(
  tx: TenantTx,
  outbox: OutboxSink,
  input: { readonly tenantId: string; readonly at: string; readonly payload: ShipmentDocumentSharedPayload },
): Promise<void> {
  await outbox.append(tx, {
    messageId: uuidv7(),
    tenantId: input.tenantId,
    type: SHIPMENT_DOCUMENT_SHARED_EVENT,
    occurredAt: input.at,
    payload: { ...input.payload },
  });
}

/**
 * A47 — at dispatch (per-order or by a handover), every live, warehouse-
 * captured shipping document of the order (`attached`, source not `portal`)
 * is shared with the client: one event each.
 */
export async function shareOrderDocumentsInTx(
  tx: TenantTx,
  outbox: OutboxSink,
  input: { readonly tenantId: string; readonly order: Pick<Order, 'id' | 'clientId'>; readonly handoverId: string | null; readonly at: string },
): Promise<number> {
  const rows = (
    await listByOwnerInTx(tx, { tenantId: input.tenantId, ownerType: 'order', ownerIds: [input.order.id], purposes: ['shipping-document'] })
  ).filter((row) => row.status === 'attached' && row.source !== 'portal');
  for (const row of rows) {
    await appendDocumentSharedInTx(tx, outbox, {
      tenantId: input.tenantId,
      at: input.at,
      payload: {
        attachmentId: row.id,
        clientId: input.order.clientId,
        orderId: input.order.id,
        handoverId: input.handoverId,
        purpose: 'shipping-document',
        docKind: row.docKind,
      },
    });
  }
  return rows.length;
}
