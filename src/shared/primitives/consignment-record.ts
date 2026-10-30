/**
 * Story 4-6a (A8) — the consignment record of a CLIENT ORDER: the brand's tax
 * document (invoice, delivery challan or bill of supply), the consignor GSTIN,
 * the declared consignment value and the e-way bill or its exemption. The WMS
 * records the brand's numbers and never issues them (D4). A pure file (it
 * imports only `shared/`), mirrored on the web (`wms-fe/src/lib/consignment.ts`).
 *
 * The house split (`consignment-capture.ts`):
 * - `normalizeConsignmentRecordInput` — LENIENT, never throws: the capture's
 *   trim and GSTIN rules, the nested `ewayBill` flattened onto the capture's
 *   keys (D7), absent as null. Its result is what the idempotency hash
 *   fingerprints.
 * - `assertConsignmentRecordShape` — the named 400s (`validation-failed`,
 *   naming the field), above the transaction, reusing the capture's extracted
 *   rules with the same messages (A6).
 */
import { ProblemException } from '../problem-details/problem.exception';
import {
  CONSIGNMENT_CAPTURE_LIMITS,
  assertBrandDocumentShape,
  assertConsignorGstinShape,
  assertEwayShape,
  normalizeBrandDocument,
  normalizeConsignorGstin,
  normalizeEway,
  type EwayFieldLabels,
} from './consignment-capture';

/** A8 — the brand's tax document for an order: a superset of `RTV_BRAND_DOCUMENT_TYPES`. */
export const ORDER_BRAND_DOCUMENT_TYPES = ['invoice', 'challan', 'bill-of-supply'] as const;
export type OrderBrandDocumentType = (typeof ORDER_BRAND_DOCUMENT_TYPES)[number];

/** A8 — why a consignment above the threshold travels without an e-way bill. */
export const EWAY_EXEMPTION_REASONS = ['exempt-goods', 'non-motorised', 'customs', 'other'] as const;
export type EwayExemptionReason = (typeof EWAY_EXEMPTION_REASONS)[number];

/** A1 — a version's lifecycle (`order_consignment_records_status_check`). */
export const CONSIGNMENT_RECORD_STATUSES = ['live', 'superseded', 'withdrawn'] as const;
export type ConsignmentRecordStatus = (typeof CONSIGNMENT_RECORD_STATUSES)[number];

/** A1 — who recorded it (`order_consignment_records_source_check`). */
export const CONSIGNMENT_RECORD_SOURCES = ['web', 'portal'] as const;
export type ConsignmentRecordSource = (typeof CONSIGNMENT_RECORD_SOURCES)[number];

/** A1 — the e-way verdict stored on a version (`order_consignment_records_eway_status_check`). */
export const CONSIGNMENT_EWAY_STATUSES = ['recorded', 'pending', 'not-required', 'exempt'] as const;
export type ConsignmentEwayStatus = (typeof CONSIGNMENT_EWAY_STATUSES)[number];

/** A8 — the limits the record answers as named 400s (the 0118 CHECKs are the backstop). */
export const CONSIGNMENT_RECORD_LIMITS = {
  declaredValueMaxPaise: CONSIGNMENT_CAPTURE_LIMITS.declaredValueMaxPaise,
  exemptionNote: 200,
  reason: 200,
  /** A35 — at most this many versions per order (`order_consignment_records_seq_range`). */
  maxVersions: 99,
} as const;

/** The order record's nested e-way field names (D7). */
export const ORDER_EWAY_LABELS: EwayFieldLabels = { number: 'ewayBill.number', date: 'ewayBill.date', validUntil: 'ewayBill.validUntil' };

/** The body as a caller sends it (every field optional on the wire). */
export interface ConsignmentRecordInput {
  readonly brandDocument?: {
    readonly type?: string | null | undefined;
    readonly number?: string | null | undefined;
    readonly date?: string | null | undefined;
  } | null | undefined;
  readonly consignorGstin?: string | null | undefined;
  readonly declaredValuePaise?: number | null | undefined;
  readonly ewayBill?: {
    readonly number?: string | null | undefined;
    readonly date?: string | null | undefined;
    readonly validUntil?: string | null | undefined;
  } | null | undefined;
  readonly ewayExemption?: {
    readonly reason?: string | null | undefined;
    readonly note?: string | null | undefined;
  } | null | undefined;
  readonly reason?: string | null | undefined;
}

/** The body normalised: every key present, absent as null (the hash input). */
export interface NormalizedConsignmentRecord {
  readonly brandDocumentType: string | null;
  readonly brandDocumentNumber: string | null;
  readonly brandDocumentDate: string | null;
  readonly consignorGstin: string | null;
  readonly declaredValuePaise: number | null;
  readonly ewayBillNumber: string | null;
  readonly ewayBillDate: string | null;
  readonly ewayValidUntil: string | null;
  readonly ewayExemptionReason: string | null;
  readonly ewayExemptionNote: string | null;
  readonly reason: string | null;
}

/** The body once the shape check passed. */
export interface ValidConsignmentRecord extends NormalizedConsignmentRecord {
  readonly brandDocumentType: OrderBrandDocumentType;
  readonly brandDocumentNumber: string;
  readonly brandDocumentDate: string;
  readonly declaredValuePaise: number;
  readonly ewayExemptionReason: EwayExemptionReason | null;
}

function trimmed(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value as string;
  const out = value.trim();
  return out === '' ? null : out;
}

/** The lenient normalize (hashed; never throws). A non-string passes through for the shape check to refuse. */
export function normalizeConsignmentRecordInput(input: ConsignmentRecordInput): NormalizedConsignmentRecord {
  const eway = input.ewayBill ?? null;
  const exemption = input.ewayExemption ?? null;
  return {
    ...normalizeBrandDocument(input.brandDocument),
    consignorGstin: normalizeConsignorGstin(input.consignorGstin),
    declaredValuePaise: (input.declaredValuePaise ?? null) as number | null,
    ...normalizeEway(eway === null ? {} : { ewayBillNumber: eway.number, ewayBillDate: eway.date, ewayValidUntil: eway.validUntil }),
    ewayExemptionReason: exemption === null ? null : trimmed(exemption.reason),
    ewayExemptionNote: exemption === null ? null : trimmed(exemption.note),
    reason: trimmed(input.reason),
  };
}

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid consignment record', detail);
}

function codePoints(value: string): number {
  return [...value].length;
}

/**
 * The shape rules, in order (A8), each a 400 `validation-failed` naming the
 * field: the brand document (the order's types), the declared value, the
 * consignor GSTIN, the e-way bill (with its validity — A34 — and never dated
 * before the document — A33), the exemption, the reason.
 */
export function assertConsignmentRecordShape(n: NormalizedConsignmentRecord): ValidConsignmentRecord {
  const L = CONSIGNMENT_RECORD_LIMITS;
  // 1. the brand document.
  assertBrandDocumentShape(n, ORDER_BRAND_DOCUMENT_TYPES);
  // 2. the declared value — required on every record (decision 3).
  const value = n.declaredValuePaise;
  if (value === null || typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > L.declaredValueMaxPaise) {
    throw invalid(
      `declaredValuePaise is required — the consignment value on the brand's document (including tax, excluding exempt goods), a whole number of paise, 0–${L.declaredValueMaxPaise}.`,
    );
  }
  // 3. the consignor (optional: the command defaults it to the client's GSTIN).
  assertConsignorGstinShape(n.consignorGstin);
  // 4. the e-way bill.
  assertEwayShape(n, ORDER_EWAY_LABELS);
  if (n.ewayBillNumber !== null && n.ewayValidUntil === null) {
    throw invalid('ewayBill.validUntil is required — the goods move, so Part B is filled and the bill has a validity.');
  }
  if (n.ewayBillDate !== null && n.ewayBillDate < (n.brandDocumentDate as string)) {
    throw invalid('ewayBill.date is before brandDocument.date — an e-way bill is generated for an issued document.');
  }
  // 5. the exemption.
  assertEwayExemptionShape(n.ewayExemptionReason, n.ewayExemptionNote, n.ewayBillNumber !== null);
  // 6. the reason (an amendment's; required after dispatch, behind the replay).
  if (n.reason !== null && (typeof n.reason !== 'string' || codePoints(n.reason) > L.reason)) {
    throw invalid(`reason is 1–${L.reason} characters.`);
  }
  return n as ValidConsignmentRecord;
}

/**
 * A8, A41 — an e-way exemption's shape (shared with the RTV and RTC
 * dispatches): never beside an e-way bill, a reason from the vocabulary, a
 * 1–200 character note, required for `other`. Absent (both null) passes.
 */
export function assertEwayExemptionShape(reason: string | null, note: string | null, hasEwayBill: boolean): void {
  if (reason === null && note === null) return;
  if (hasEwayBill) {
    throw invalid('Send the e-way bill or an exemption, not both.');
  }
  if (reason === null || !(EWAY_EXEMPTION_REASONS as readonly string[]).includes(reason)) {
    throw invalid(`ewayExemption.reason must be one of ${JSON.stringify(EWAY_EXEMPTION_REASONS)} (got ${JSON.stringify(reason)}).`);
  }
  if (note !== null && (typeof note !== 'string' || codePoints(note) > CONSIGNMENT_RECORD_LIMITS.exemptionNote)) {
    throw invalid(`ewayExemption.note is 1–${CONSIGNMENT_RECORD_LIMITS.exemptionNote} characters.`);
  }
  if (reason === 'other' && note === null) {
    throw invalid('ewayExemption.note is required for the reason "other" — say why no e-way bill is needed.');
  }
}

/** A41 — an exemption as a dispatch body carries it, trimmed (blank as null). */
export function normalizeEwayExemption(input: { readonly reason?: string | null | undefined; readonly note?: string | null | undefined } | null | undefined): {
  readonly reason: string | null;
  readonly note: string | null;
} {
  const e = input ?? null;
  return { reason: e === null ? null : trimmed(e.reason), note: e === null ? null : trimmed(e.note) };
}

/** A8 — an e-way bill number as printed: `1234 5678 9012`. Anything else is returned as given. */
export function formatEwayBillNumber(value: string): string {
  return /^[0-9]{12}$/.test(value) ? `${value.slice(0, 4)} ${value.slice(4, 8)} ${value.slice(8)}` : value;
}

/** A19 — the short tag a label prints for the document type. */
export function brandDocumentTag(type: string): string {
  return type === 'challan' ? 'DC' : type === 'bill-of-supply' ? 'BOS' : 'INV';
}

/** A19 — the document type in words (the slip, the sheet, the dispatch email). */
export function brandDocumentWords(type: string): string {
  return type === 'challan' ? 'Delivery challan' : type === 'bill-of-supply' ? 'Bill of supply' : 'Invoice';
}

/** A19 — an exemption reason in words. */
export function ewayExemptionWords(reason: string): string {
  switch (reason) {
    case 'exempt-goods':
      return 'exempt goods';
    case 'non-motorised':
      return 'non-motorised conveyance';
    case 'customs':
      return 'under customs supervision';
    default:
      return 'exempt';
  }
}

/** `11800000` paise → `₹1,18,000`; `5000050` → `₹50,000.50` — Indian digit grouping, integer arithmetic (A45's copy). */
export function formatRupees(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const whole = String(Math.trunc(abs / 100));
  const fraction = abs % 100;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `${negative ? '-' : ''}₹${grouped}${fraction === 0 ? '' : `.${String(fraction).padStart(2, '0')}`}`;
}
