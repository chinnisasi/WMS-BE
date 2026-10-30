import { and, eq } from 'drizzle-orm';
import { shipments, type Shipment } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { removeAttachmentIfLiveInTx } from '../attachments/attachment-records';

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
