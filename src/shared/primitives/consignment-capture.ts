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
 * The WMS never generates an e-way bill (D4): it records the brand's
 * numbers. Story 4-6a extracted the brand-document, consignor and e-way rules
 * (`assertBrandDocumentShape`, `assertConsignorGstinShape`, `assertEwayShape`)
 * so the order consignment record (`consignment-record.ts`) reuses them with
 * the same messages; a sent declared value is judged against the e-way
 * threshold by the RTV and RTC dispatches.
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
  /** Story 4-6a (A8) — a declared consignment value's ceiling, paise (4-7c's `MAX_DECLARED_VALUE_PAISE`). */
  declaredValueMaxPaise: 1_000_000_000_000,
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

/** The brand document as normalized (story 4-6a — extracted, shared with the order record). */
export interface NormalizedBrandDocument {
  readonly brandDocumentType: string | null;
  readonly brandDocumentNumber: string | null;
  readonly brandDocumentDate: string | null;
}

/** The e-way bill as normalized (story 4-6a — extracted, shared with the order record). */
export interface NormalizedEway {
  readonly ewayBillNumber: string | null;
  readonly ewayBillDate: string | null;
  readonly ewayValidUntil: string | null;
}

/** Story 4-6a (A8) — the brand document's lenient normalize: trimmed, blank as null. */
export function normalizeBrandDocument(
  doc: { readonly type?: string | null | undefined; readonly number?: string | null | undefined; readonly date?: string | null | undefined } | null | undefined,
): NormalizedBrandDocument {
  const d = doc ?? null;
  return {
    brandDocumentType: d === null ? null : trimmed(d.type),
    brandDocumentNumber: d === null ? null : trimmed(d.number),
    brandDocumentDate: d === null ? null : trimmed(d.date),
  };
}

/** Story 4-6a (A8) — the e-way bill's lenient normalize: trimmed, blank as null. */
export function normalizeEway(input: {
  readonly ewayBillNumber?: string | null | undefined;
  readonly ewayBillDate?: string | null | undefined;
  readonly ewayValidUntil?: string | null | undefined;
}): NormalizedEway {
  return {
    ewayBillNumber: trimmed(input.ewayBillNumber),
    ewayBillDate: trimmed(input.ewayBillDate),
    ewayValidUntil: trimmed(input.ewayValidUntil),
  };
}

/** Story 4-6a (A8) — the consignor GSTIN's lenient normalize (upper-cased, blank as null). */
export function normalizeConsignorGstin(value: string | null | undefined): string | null {
  return typeof value === 'string' ? normalizeGstinInput(value) : (value ?? null);
}

/** The lenient normalize (hashed; never throws). A non-string is passed through for the shape check to refuse. */
export function normalizeConsignmentCapture(input: ConsignmentCaptureInput): NormalizedConsignmentCapture {
  const vehicle = typeof input.vehicleNumber === 'string' ? normalizeVehicleNo(input.vehicleNumber) : (input.vehicleNumber ?? null);
  return {
    ...normalizeBrandDocument(input.brandDocument),
    consignorGstin: normalizeConsignorGstin(input.consignorGstin),
    debitNoteNumber: trimmed(input.debitNoteNumber),
    ...normalizeEway(input),
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
 * Story 4-6a (A8) — the brand document's shape rules, extracted from
 * `assertConsignmentCaptureShape` with the same messages and order: required,
 * a type from `allowedTypes`, a 1–40 character number, a calendar date.
 */
export function assertBrandDocumentShape(capture: NormalizedBrandDocument, allowedTypes: readonly string[]): void {
  const L = CONSIGNMENT_CAPTURE_LIMITS;
  if (capture.brandDocumentType === null || capture.brandDocumentNumber === null || capture.brandDocumentDate === null) {
    throw invalid("brandDocument is required — the brand's challan or invoice the goods travel under (type, number and date).");
  }
  if (!allowedTypes.includes(capture.brandDocumentType)) {
    throw invalid(`brandDocument.type must be one of ${JSON.stringify(allowedTypes)} (got ${JSON.stringify(capture.brandDocumentType)}).`);
  }
  if (typeof capture.brandDocumentNumber !== 'string' || codePoints(capture.brandDocumentNumber) > L.documentNumber) {
    throw invalid(`brandDocument.number is 1–${L.documentNumber} characters.`);
  }
  if (typeof capture.brandDocumentDate !== 'string' || !isIsoDate(capture.brandDocumentDate)) {
    throw invalid('brandDocument.date must be a calendar date (YYYY-MM-DD).');
  }
}

/** Story 4-6a (A8) — the consignor GSTIN's shape (optional), extracted with its messages. */
export function assertConsignorGstinShape(consignorGstin: string | null): void {
  if (consignorGstin !== null) {
    if (typeof consignorGstin !== 'string' || !GSTIN_RE.test(consignorGstin)) {
      throw invalid('consignorGstin must be a GSTIN — 2 digits and 13 letters or digits.');
    }
    const prefix = gstinPrefixProblem(consignorGstin);
    if (prefix !== null) throw invalid(`consignorGstin: ${prefix}.`);
  }
}

/** Story 4-6a (D7) — the names the e-way messages call the three fields. */
export interface EwayFieldLabels {
  readonly number: string;
  readonly date: string;
  readonly validUntil: string;
}

/** The RTV / RTC capture's flat field names — its messages stay byte-identical. */
export const FLAT_EWAY_LABELS: EwayFieldLabels = { number: 'ewayBillNumber', date: 'ewayBillDate', validUntil: 'ewayValidUntil' };

/**
 * Story 4-6a (A8, D7) — the e-way bill's shape rules, extracted from
 * `assertConsignmentCaptureShape` with the same order; the messages name the
 * fields through `labels` (the capture's flat names, or the order record's
 * `ewayBill.number` …). Optional; a number carries its date.
 */
export function assertEwayShape(capture: NormalizedEway, labels: EwayFieldLabels): void {
  if (capture.ewayBillNumber !== null) {
    if (typeof capture.ewayBillNumber !== 'string' || !EWB_NO_RE.test(capture.ewayBillNumber)) {
      throw invalid(`${labels.number} must be 12 digits.`);
    }
    if (capture.ewayBillDate === null) {
      throw invalid(`${labels.date} is required with an ${labels.number}.`);
    }
  } else if (capture.ewayBillDate !== null || capture.ewayValidUntil !== null) {
    throw invalid(`${labels.date} and ${labels.validUntil} go with an ${labels.number} — send the number too, or neither.`);
  }
  if (capture.ewayBillDate !== null && (typeof capture.ewayBillDate !== 'string' || !isIsoDate(capture.ewayBillDate))) {
    throw invalid(`${labels.date} must be a calendar date (YYYY-MM-DD).`);
  }
  if (capture.ewayValidUntil !== null) {
    if (typeof capture.ewayValidUntil !== 'string' || !isIsoDate(capture.ewayValidUntil)) {
      throw invalid(`${labels.validUntil} must be a calendar date (YYYY-MM-DD).`);
    }
    if (capture.ewayBillDate !== null && capture.ewayValidUntil < capture.ewayBillDate) {
      throw invalid(`${labels.validUntil} (${capture.ewayValidUntil}) is before ${labels.date} (${capture.ewayBillDate}).`);
    }
  }
}

/**
 * The shape rules, in field order, each a 400 `validation-failed` naming the
 * field. Returns the capture typed as valid.
 */
export function assertConsignmentCaptureShape(capture: NormalizedConsignmentCapture): ValidConsignmentCapture {
  const L = CONSIGNMENT_CAPTURE_LIMITS;
  // The brand's movement document — required: goods cannot legally travel without one.
  assertBrandDocumentShape(capture, RTV_BRAND_DOCUMENT_TYPES);
  assertConsignorGstinShape(capture.consignorGstin);
  if (capture.debitNoteNumber !== null && (typeof capture.debitNoteNumber !== 'string' || codePoints(capture.debitNoteNumber) > L.debitNoteNumber)) {
    throw invalid(`debitNoteNumber is 1–${L.debitNoteNumber} characters.`);
  }
  // The e-way bill — optional, recorded only; a number carries its date.
  assertEwayShape(capture, FLAT_EWAY_LABELS);
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
