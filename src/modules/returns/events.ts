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
