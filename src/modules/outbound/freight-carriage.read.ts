import { and, desc, eq } from 'drizzle-orm';
import { freightConsignments, orders } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { orderLabelOf } from '../../shared/primitives/order-label';

/**
 * Story 4-9a (A27, A69) — the freight facts the client notices read at
 * delivery: a free-function seam (guide §7h) that imports only drizzle-orm and
 * `shared/`, so `client-emails` can call it without a module import. It reads
 * `freight_consignments` (the 0041 client clause) and `orders` only — never
 * the staff-only load or scan tables (a client never reads those).
 *
 * The carriage snapshot is written once, at departure, and no command updates
 * it after (A69), so reading it at delivery keeps 5-2b A1's rule: the fact is
 * frozen.
 */

export interface DispatchedFreightCarriage {
  /** `LD-0007/03`. */
  readonly consignmentRef: string;
  readonly vehicleNumber: string;
  readonly packageCount: number;
}

/** The order's DISPATCHED freight consignment's truck line facts, or null when it left by no truck. */
export async function dispatchedFreightCarriageOfOrderInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<DispatchedFreightCarriage | null> {
  const rows = await tx
    .select({ carriage: freightConsignments.carriageSnapshot, packageCount: freightConsignments.packageCount })
    .from(freightConsignments)
    .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.orderId, orderId), eq(freightConsignments.status, 'dispatched')))
    .orderBy(desc(freightConsignments.dispatchedAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.packageCount === null) return null;
  const carriage = row.carriage as { consignmentRef?: unknown; vehicleNumber?: unknown } | null;
  if (carriage === null || typeof carriage.consignmentRef !== 'string' || typeof carriage.vehicleNumber !== 'string') return null;
  return { consignmentRef: carriage.consignmentRef, vehicleNumber: carriage.vehicleNumber, packageCount: Number(row.packageCount) };
}

/** The order's label (the one order label rule) and its consignee city — what the delivery notice names. */
export async function deliveryOrderFactsInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<{ readonly orderRef: string; readonly consigneeCity: string | null } | null> {
  const rows = await tx
    .select({
      id: orders.id,
      clientOrderRef: orders.clientOrderRef,
      externalEventId: orders.externalEventId,
      followOnSeq: orders.followOnSeq,
      followOnRootOrderId: orders.followOnRootOrderId,
      city: orders.destinationCity,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return { orderRef: orderLabelOf(row), consigneeCity: row.city === null || row.city.trim() === '' ? null : row.city.trim() };
}
