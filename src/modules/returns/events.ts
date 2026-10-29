/**
 * The returns module's event vocabulary (story 13-1) — the `<document>.<verb>`
 * pattern, written out here rather than inlined at the call sites (the
 * `invoicing/events.ts` convention). Both are appended to the outbox in the
 * command's own transaction; nothing subscribes in 13-1 (no notification
 * source — the spec's Never list). The action strings double as the audit
 * actions (`AUDIT_NEW_ACTIONS`).
 */

/** An operator authorized part of a dispatched order for return. */
export const RETURN_AUTHORIZATION_CREATED_EVENT = 'return_authorization.created';

/** An open authorization was cancelled; its units are returnable again. */
export const RETURN_AUTHORIZATION_CANCELLED_EVENT = 'return_authorization.cancelled';

/** Both events' payload — flat ids only; a consumer re-reads the authorization. */
export interface ReturnAuthorizationEventPayload {
  readonly rmaId: string;
  readonly code: string;
  readonly orderId: string;
  readonly warehouseId: string;
  readonly clientId: string;
}

/**
 * Story 13-2 — a `return.receive` op was recorded: the authorized units it
 * carried were booked into RETURNS (awaiting disposition) and any others were
 * sent to the review queue. Appended in the command's own transaction even
 * when nothing applied (`returnReceiptId: null`). Nothing subscribes in 13-2
 * (the refused part raises its own `device.rejected_op.raised`). The action
 * string doubles as the audit action (`AUDIT_NEW_ACTIONS`).
 */
export const RETURN_RECEIPT_RECORDED_EVENT = 'return_receipt.recorded';

/** `return_receipt.recorded`'s payload — flat ids and counts only. */
export interface ReturnReceiptRecordedPayload {
  /** Null when every entry was refused (no receipt row is written). */
  readonly returnReceiptId: string | null;
  /** The receipt's code (`RRN-0001`); null when nothing applied. */
  readonly code: string | null;
  readonly rmaId: string;
  readonly rmaCode: string;
  /** The RMA's client (a 3PL consumer filters by brand). */
  readonly clientId: string;
  readonly warehouseId: string;
  readonly appliedCount: number;
  readonly refusedCount: number;
}

/**
 * Story 4-7a — a disposition command committed (a web dispose or a handheld
 * restock): one event per command, flat ids and counts only (A18, the
 * `return_receipt.recorded` precedent). Nothing consumes it yet. The action
 * string doubles as the audit action (`AUDIT_NEW_ACTIONS`).
 */
export const RETURN_DISPOSITION_RECORDED_EVENT = 'return_disposition.recorded';

/** `return_disposition.recorded`'s payload. */
export interface ReturnDispositionRecordedPayload {
  readonly warehouseId: string;
  readonly clientId: string;
  readonly skuId: string;
  readonly outcome: 'restock' | 'quarantine' | 'scrap';
  /** The command's total, base units as a decimal string (the outbox's exact-quantity convention). */
  readonly qty: string;
  readonly dispositionCount: number;
  readonly firstDispositionId: string;
}

/**
 * Story 4-7a (A3) — a returned unit was scrapped: the client-facing signal
 * (one per scrap disposition). Nothing consumes it yet; roadmap 5.2's client
 * notifications will.
 */
export const RETURN_SCRAP_RECORDED_EVENT = 'return_scrap.recorded';

/** `return_scrap.recorded`'s payload. */
export interface ReturnScrapRecordedPayload {
  readonly rmaId: string;
  readonly rmaCode: string;
  readonly clientId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  /** Base units as a decimal string. */
  readonly qty: string;
  readonly reasonCode: string;
  readonly dispositionId: string;
}

/**
 * Story 4-7b (A10) — a `return.receive_blind` op was recorded: an unannounced
 * parcel's matching units were booked into RETURNS under an auto-created
 * blind RMA awaiting review, and any others were sent to the review queue.
 * Appended even when nothing applied (no RMA). Nothing subscribes (13-5 owns
 * returns notification sources). The string doubles as the audit action.
 */
export const RETURN_BLIND_RECORDED_EVENT = 'return_receipt.blind_recorded';

/** `return_receipt.blind_recorded`'s payload — flat ids and counts only. */
export interface ReturnBlindRecordedPayload {
  /** Null when every entry was refused (no RMA, no receipt). */
  readonly rmaId: string | null;
  readonly rmaCode: string | null;
  readonly returnReceiptId: string | null;
  readonly code: string | null;
  readonly clientId: string;
  readonly warehouseId: string;
  readonly suggestedOrderId: string | null;
  readonly appliedCount: number;
  readonly refusedCount: number;
}

/** Story 4-7b (A10) — a blind RMA was accepted at review (optionally linked to an order). */
export const RETURN_BLIND_ACCEPTED_EVENT = 'return_authorization.blind_accepted';

/** Story 4-7b (A10) — a blind RMA was rejected at review; its booking was reversed. */
export const RETURN_BLIND_REJECTED_EVENT = 'return_authorization.blind_rejected';

/** Both review events' payload — flat ids and counts only. */
export interface ReturnBlindReviewedPayload {
  readonly rmaId: string;
  readonly code: string;
  readonly clientId: string;
  readonly warehouseId: string;
  /** Accept: the linked order, or null ("No order"); reject: always null. */
  readonly orderId: string | null;
  readonly lineCount: number;
}
