/**
 * The invoicing module's event vocabulary (story 8-1). Two constants, both
 * written out HERE rather than inlined as string literals at their call
 * sites — the sibling module constant file convention (channels.events.ts,
 * the writeback delivery's literal is its own module's pre-invoicing
 * legacy).
 */

/** What the generate/regenerate command + delivery handler emit on a flip to `issued`. */
export const INVOICE_ISSUED_EVENT = 'invoice.issued';

/** What the delivery handler subscribes to (payload written by dispatch.command). */
export const ORDER_DISPATCHED_EVENT = 'order.dispatched';

/** The `invoice.issued` payload — flat, client-agnostic (21-5 reads this too). */
export interface InvoiceIssuedPayload {
  readonly invoiceId: string;
  readonly orderId: string;
  readonly warehouseId: string;
  readonly invoiceNo: string;
  readonly fyLabel: string;
  readonly revision: number;
  readonly subtotalPaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
}
