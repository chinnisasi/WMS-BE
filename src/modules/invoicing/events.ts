import type { InvoiceGenerationOutcome } from './generator';

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

/**
 * The `invoice.issued` payload — flat, client-agnostic (21-5 reads this too).
 * Story 8-1b added `originGstin`, `payablePaise` and `roundOffPaise`
 * (additive). Numbering is per supplier GSTIN, so two same-state GSTINs
 * issue identical `invoiceNo`s: consumers key on (originGstin, invoiceNo),
 * never on `invoiceNo` alone.
 */
export interface InvoiceIssuedPayload {
  readonly invoiceId: string;
  readonly orderId: string;
  readonly warehouseId: string;
  readonly originGstin: string;
  readonly invoiceNo: string;
  readonly fyLabel: string;
  readonly revision: number;
  readonly subtotalPaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
  readonly payablePaise: number;
  readonly roundOffPaise: number;
}

/**
 * The ONE builder both emitters (the manual command and the delivery
 * handler) use — two hand-built copies are how a field lands on one path and
 * not the other. Called only on a first issuance, where the number, FY and
 * supplier GSTIN are all stamped; a missing one is a programming error and
 * fails loudly rather than emitting a payload with a hole in it.
 */
export function invoiceIssuedPayload(outcome: InvoiceGenerationOutcome): InvoiceIssuedPayload {
  if (!outcome.firstIssuance || outcome.invoiceNo === null || outcome.fyLabel === null || outcome.originGstin === null) {
    throw new Error(`invoice.issued for order ${outcome.orderId} built from an outcome that did not first-issue a stamped invoice`);
  }
  return {
    invoiceId: outcome.invoiceId,
    orderId: outcome.orderId,
    warehouseId: outcome.warehouseId,
    originGstin: outcome.originGstin,
    invoiceNo: outcome.invoiceNo,
    fyLabel: outcome.fyLabel,
    revision: outcome.revision,
    subtotalPaise: outcome.subtotalPaise,
    gstPaise: outcome.gstPaise,
    totalPaise: outcome.totalPaise,
    payablePaise: outcome.payablePaise,
    roundOffPaise: outcome.roundOffPaise,
  };
}
