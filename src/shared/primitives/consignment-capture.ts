/**
 * Story 2-8b (decision 9, A7, A8) — the consignment capture of a goods-out
 * document the WMS records but does not issue: the brand's movement document
 * (its challan or invoice), the e-way bill, who carries the goods and the
 * packages. A pure file (it imports only `shared/`), so 4-7c's return to
 * client reuses exactly these rules — the RTV's dispatch is its first user.
 *
 * Two steps, the house split (`registered-address.ts`):
 * - `normalizeConsignmentCapture` — LENIENT, never throws: trims text, blank
 *   reads as absent (null), upper-cases the GSTIN, normalises the vehicle
 *   (`normalizeVehicleNo`). Its result is what the idempotency hash
 *   fingerprints, so a replayed key always hashes first.
 * - `assertConsignmentCaptureShape` — the named refusals (400
 *   `validation-failed`, naming the field), above the transaction: the brand
 *   document is required, the e-way number carries its date, at least one
 *   carrier identity, the package count, every length and format.
 *
 * The document-date WINDOW (no later than today, no earlier than 30 days
 * before the document's creation day) depends on the clock, so it is a
 * separate check the command runs behind its replay lookup
 * (`assertBrandDocumentDateWindow`).
 *
 * The WMS never generates an e-way bill and never judges its threshold: it
 * does not know the consignment value (D4; generation for client goods is
 * roadmap 4.6). It records the brand's numbers.
 */
import { ProblemException } from '../problem-details/problem.exception';
import { GSTIN_RE, gstinPrefixProblem, normalizeGstinInput } from './gstin';
import { UUID_RE } from './ids';
import { addIsoDays, isIsoDate } from './time';
import { EWB_NO_RE, VEHICLE_NO_RE, normalizeVehicleNo } from './vehicle';

/** The brand's movement document (A8 — a debit note is a claim, not a movement document). */
export const RTV_BRAND_DOCUMENT_TYPES = ['challan', 'invoice'] as const;
export type BrandDocumentType = (typeof RTV_BRAND_DOCUMENT_TYPES)[number];

/** The bounds the capture answers as named 400s (the 0105 CHECKs are the backstop). */
export const CONSIGNMENT_CAPTURE_LIMITS = {
  /** The gate-in document-number limit (`GATE_IN_LIMITS.documentNumber`). */
  documentNumber: 40,
  debitNoteNumber: 40,
  carrierName: 100,
  trackingRef: 50,
  packageCountMin: 1,
  packageCountMax: 9999,
  /** A8 — the brand document may be dated at most this many days before the document's creation day. */
  documentDateLookbackDays: 30,
} as const;

/** The capture as a caller sends it (every field optional on the wire). */
export interface ConsignmentCaptureInput {
  readonly brandDocument?: {
    readonly type?: string | null | undefined;
    readonly number?: string | null | undefined;
    readonly date?: string | null | undefined;
  } | null | undefined;
  readonly consignorGstin?: string | null | undefined;
  readonly debitNoteNumber?: string | null | undefined;
  readonly ewayBillNumber?: string | null | undefined;
  readonly ewayBillDate?: string | null | undefined;
  readonly ewayValidUntil?: string | null | undefined;
  readonly transporterId?: string | null | undefined;
  readonly carrierName?: string | null | undefined;
  readonly vehicleNumber?: string | null | undefined;
  readonly trackingRef?: string | null | undefined;
  readonly packageCount?: number | null | undefined;
}

/** The capture normalised: every key present, absent as null (the hash input). */
export interface NormalizedConsignmentCapture {
  readonly brandDocumentType: string | null;
  readonly brandDocumentNumber: string | null;
  readonly brandDocumentDate: string | null;
  readonly consignorGstin: string | null;
  readonly debitNoteNumber: string | null;
  readonly ewayBillNumber: string | null;
  readonly ewayBillDate: string | null;
  readonly ewayValidUntil: string | null;
  readonly transporterId: string | null;
  readonly carrierName: string | null;
  readonly vehicleNumber: string | null;
  readonly trackingRef: string | null;
  readonly packageCount: number | null;
}

/** The capture once the shape check passed: the required fields are known present. */
export interface ValidConsignmentCapture extends NormalizedConsignmentCapture {
  readonly brandDocumentType: BrandDocumentType;
  readonly brandDocumentNumber: string;
  readonly brandDocumentDate: string;
  readonly packageCount: number;
}

function trimmed(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value as string;
  const out = value.trim();
  return out === '' ? null : out;
}

/** The lenient normalize (hashed; never throws). A non-string is passed through for the shape check to refuse. */
export function normalizeConsignmentCapture(input: ConsignmentCaptureInput): NormalizedConsignmentCapture {
  const doc = input.brandDocument ?? null;
  const vehicle = typeof input.vehicleNumber === 'string' ? normalizeVehicleNo(input.vehicleNumber) : (input.vehicleNumber ?? null);
  const gstin = typeof input.consignorGstin === 'string' ? normalizeGstinInput(input.consignorGstin) : (input.consignorGstin ?? null);
  return {
    brandDocumentType: doc === null ? null : trimmed(doc.type),
    brandDocumentNumber: doc === null ? null : trimmed(doc.number),
    brandDocumentDate: doc === null ? null : trimmed(doc.date),
    consignorGstin: gstin,
    debitNoteNumber: trimmed(input.debitNoteNumber),
    ewayBillNumber: trimmed(input.ewayBillNumber),
    ewayBillDate: trimmed(input.ewayBillDate),
    ewayValidUntil: trimmed(input.ewayValidUntil),
    transporterId: trimmed(input.transporterId),
    carrierName: trimmed(input.carrierName),
    vehicleNumber: vehicle,
    trackingRef: trimmed(input.trackingRef),
    packageCount: input.packageCount ?? null,
  };
}

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid consignment details', detail);
}

function codePoints(value: string): number {
  return [...value].length;
}

/**
 * The shape rules, in field order, each a 400 `validation-failed` naming the
 * field. Returns the capture typed as valid.
 */
export function assertConsignmentCaptureShape(capture: NormalizedConsignmentCapture): ValidConsignmentCapture {
  const L = CONSIGNMENT_CAPTURE_LIMITS;
  // The brand's movement document — required: goods cannot legally travel without one.
  if (capture.brandDocumentType === null || capture.brandDocumentNumber === null || capture.brandDocumentDate === null) {
    throw invalid("brandDocument is required — the brand's challan or invoice the goods travel under (type, number and date).");
  }
  if (!(RTV_BRAND_DOCUMENT_TYPES as readonly string[]).includes(capture.brandDocumentType)) {
    throw invalid(`brandDocument.type must be one of ${JSON.stringify(RTV_BRAND_DOCUMENT_TYPES)} (got ${JSON.stringify(capture.brandDocumentType)}).`);
  }
  if (typeof capture.brandDocumentNumber !== 'string' || codePoints(capture.brandDocumentNumber) > L.documentNumber) {
    throw invalid(`brandDocument.number is 1–${L.documentNumber} characters.`);
  }
  if (typeof capture.brandDocumentDate !== 'string' || !isIsoDate(capture.brandDocumentDate)) {
    throw invalid('brandDocument.date must be a calendar date (YYYY-MM-DD).');
  }
  if (capture.consignorGstin !== null) {
    if (typeof capture.consignorGstin !== 'string' || !GSTIN_RE.test(capture.consignorGstin)) {
      throw invalid('consignorGstin must be a GSTIN — 2 digits and 13 letters or digits.');
    }
    const prefix = gstinPrefixProblem(capture.consignorGstin);
    if (prefix !== null) throw invalid(`consignorGstin: ${prefix}.`);
  }
  if (capture.debitNoteNumber !== null && (typeof capture.debitNoteNumber !== 'string' || codePoints(capture.debitNoteNumber) > L.debitNoteNumber)) {
    throw invalid(`debitNoteNumber is 1–${L.debitNoteNumber} characters.`);
  }
  // The e-way bill — optional, recorded only; a number carries its date.
  if (capture.ewayBillNumber !== null) {
    if (typeof capture.ewayBillNumber !== 'string' || !EWB_NO_RE.test(capture.ewayBillNumber)) {
      throw invalid('ewayBillNumber must be 12 digits.');
    }
    if (capture.ewayBillDate === null) {
      throw invalid('ewayBillDate is required with an ewayBillNumber.');
    }
  } else if (capture.ewayBillDate !== null || capture.ewayValidUntil !== null) {
    throw invalid('ewayBillDate and ewayValidUntil go with an ewayBillNumber — send the number too, or neither.');
  }
  if (capture.ewayBillDate !== null && (typeof capture.ewayBillDate !== 'string' || !isIsoDate(capture.ewayBillDate))) {
    throw invalid('ewayBillDate must be a calendar date (YYYY-MM-DD).');
  }
  if (capture.ewayValidUntil !== null) {
    if (typeof capture.ewayValidUntil !== 'string' || !isIsoDate(capture.ewayValidUntil)) {
      throw invalid('ewayValidUntil must be a calendar date (YYYY-MM-DD).');
    }
    if (capture.ewayBillDate !== null && capture.ewayValidUntil < capture.ewayBillDate) {
      throw invalid(`ewayValidUntil (${capture.ewayValidUntil}) is before ewayBillDate (${capture.ewayBillDate}).`);
    }
  }
  // Who carries the goods — at least one of a transporter, a carrier name or a vehicle.
  if (capture.transporterId !== null && (typeof capture.transporterId !== 'string' || !UUID_RE.test(capture.transporterId))) {
    throw invalid('transporterId must be a uuid.');
  }
  if (capture.carrierName !== null && (typeof capture.carrierName !== 'string' || codePoints(capture.carrierName) > L.carrierName)) {
    throw invalid(`carrierName is 1–${L.carrierName} characters.`);
  }
  if (capture.vehicleNumber !== null && (typeof capture.vehicleNumber !== 'string' || !VEHICLE_NO_RE.test(capture.vehicleNumber))) {
    throw invalid('vehicleNumber must be a registration number — 4–15 letters and digits (spaces, dots and hyphens are ignored).');
  }
  if (capture.transporterId === null && capture.carrierName === null && capture.vehicleNumber === null) {
    throw invalid('Name who carries the goods — a transporter, a carrier name or a vehicle number (at least one).');
  }
  if (capture.trackingRef !== null && (typeof capture.trackingRef !== 'string' || codePoints(capture.trackingRef) > L.trackingRef)) {
    throw invalid(`trackingRef (the AWB or LR number) is 1–${L.trackingRef} characters.`);
  }
  if (
    capture.packageCount === null ||
    typeof capture.packageCount !== 'number' ||
    !Number.isInteger(capture.packageCount) ||
    capture.packageCount < L.packageCountMin ||
    capture.packageCount > L.packageCountMax
  ) {
    throw invalid(`packageCount is required — a whole number of packages, ${L.packageCountMin}–${L.packageCountMax}.`);
  }
  return capture as ValidConsignmentCapture;
}

/**
 * A8 — the brand document's date, behind the replay lookup (it reads the
 * clock): no later than today (IST) and no earlier than the document's
 * creation IST date minus 30 days. 400 `validation-failed`.
 */
export function assertBrandDocumentDateWindow(documentDate: string, createdIstDate: string, todayIst: string): void {
  if (documentDate > todayIst) {
    throw invalid(`brandDocument.date (${documentDate}) is after today (${todayIst}, IST) — the brand's document is dated on or before the dispatch.`);
  }
  const earliest = addIsoDays(createdIstDate, -CONSIGNMENT_CAPTURE_LIMITS.documentDateLookbackDays);
  if (documentDate < earliest) {
    throw invalid(
      `brandDocument.date (${documentDate}) is more than ${CONSIGNMENT_CAPTURE_LIMITS.documentDateLookbackDays} days before the document was created — the earliest accepted date is ${earliest}.`,
    );
  }
}

/** A7 — the GSTIN's state code (its two-digit prefix), or null. */
export function gstinStateCode(gstin: string | null): string | null {
  return gstin === null || gstin.length < 2 ? null : gstin.slice(0, 2);
}
