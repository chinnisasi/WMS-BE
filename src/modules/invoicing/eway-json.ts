import { PINCODE_RE } from '../../shared/primitives/address';
import type { AddressSnapshot } from '../../shared/primitives/address';
import { nicText } from '../../shared/primitives/nic-text';
import type { SupplyType } from './arith';
import { resolveStateCode } from './generator';
import type { InvoiceDocument, StateCodeEntry } from './generator';
import { isValidHsn, normalizeHsn } from './hsn';
import { uqcFor } from './uqc';
import { istDateOf } from './eway-threshold';
import { isIsoDate } from '../../shared/primitives/time';

/**
 * The NIC e-way bill object (story 8-2b) — PURE functions only. ONE builder
 * (`ewbBillObject`) turns the frozen invoice document, its lines and the
 * bill's Part B into the bulk-upload bill object; both the manual export
 * (`bulkFile`) and the gateway port consume it. `ewbBlockers` lists, per
 * bill, why it cannot be exported or generated — computed at read time,
 * never stored.
 *
 * Keys are NIC's BULK-upload keys (`transType`, `actualFromStateCode`,
 * `OthValue`, `TotNonAdvolVal`), not the API's — a live adapter renames them.
 * Amounts are numbers rounded to 0.01 from integer paise; text has every
 * character outside NIC's set removed, then is truncated to NIC's length.
 * Sources: NIC `EWB_Attributes_new.xlsx` (Schema, Validations, Master Codes)
 * and the bulk preparation tool.
 */

/** The bulk-upload schema version (a schema version, not a regulatory value). */
export const NIC_BULK_VERSION = '1.0.0621';

/**
 * NIC's IGST rate table (Validations, Table 1, "as on 1st October", workbook
 * 1.0.0621) in basis points, plus 4000 for GST 2.0's 40% rate (22 Sep 2025;
 * not in the 1.0.0621 workbook). A line outside it is `rate-not-standard`.
 */
export const NIC_RATE_BPS: readonly number[] = [0, 10, 25, 300, 500, 1200, 1800, 2800, 4000];

/** NIC refuses more than 250 items in one bill (no grouping is done here). */
export const MAX_EWB_ITEMS = 250;

/** NIC's document-age limit, in IST calendar days (NIC 2025 advisory). */
export const MAX_DOC_AGE_DAYS = 180;

/** Transport modes: 1 Road, 2 Rail, 3 Air, 4 Ship (NIC Master Codes). */
export const TRANS_MODES = [1, 2, 3, 4] as const;
export type TransMode = (typeof TRANS_MODES)[number];

export const VEHICLE_TYPES = ['R', 'O'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const VEHICLE_NO_RE = /^[A-Z0-9]{4,15}$/;
export const TRANSPORTER_ID_RE = /^[0-9]{2}[A-Z0-9]{13}$/;
export const TRANSPORTER_NAME_MAX = 25;
export const TRANS_DOC_NO_MAX = 15;
export const DISTANCE_MAX_KM = 4000;
/** NIC caps the distance when both pincodes are equal. */
export const SAME_PINCODE_DISTANCE_MAX_KM = 100;

/** The blockers, in display order. */
export const EWAY_BLOCKERS = [
  'invoice-unavailable',
  'hsn-issue',
  'doc-too-old',
  'too-many-lines',
  'address-incomplete',
  'state-unresolved',
  'ship-to-differs',
  'unsupported-supply',
  'rate-not-standard',
  'needs-irn',
  'transport-incomplete',
] as const;
export type EwayBlockerCode = (typeof EWAY_BLOCKERS)[number];

/**
 * TERMINAL blockers: the invoice is frozen, so nothing here can clear them —
 * the bill must be generated on the portal by hand and its number recorded.
 * The other two (`needs-irn`, `transport-incomplete`) are fixable.
 */
export const TERMINAL_BLOCKERS: ReadonlySet<EwayBlockerCode> = new Set<EwayBlockerCode>([
  // The bill's invoice is missing or no longer issued (e.g. a future void).
  'invoice-unavailable',
  'hsn-issue',
  'doc-too-old',
  'too-many-lines',
  'address-incomplete',
  'state-unresolved',
  'ship-to-differs',
  'unsupported-supply',
  'rate-not-standard',
]);

export interface EwayBlocker {
  readonly code: EwayBlockerCode;
  readonly terminal: boolean;
}

/** The bill's Part B as stored (every field null until entered). */
export interface EwayPartB {
  readonly transMode: number | null;
  readonly vehicleNo: string | null;
  readonly vehicleType: string | null;
  readonly transporterId: string | null;
  readonly transporterName: string | null;
  readonly transDocNo: string | null;
  /** `YYYY-MM-DD`. */
  readonly transDocDate: string | null;
  readonly distanceKm: number | null;
}

export const EMPTY_PART_B: EwayPartB = {
  transMode: null,
  vehicleNo: null,
  vehicleType: null,
  transporterId: null,
  transporterName: null,
  transDocNo: null,
  transDocDate: null,
  distanceKm: null,
};

/** The frozen invoice facts the builder reads (the stored row + its document). */
export interface EwayInvoiceFacts {
  readonly invoiceNo: string;
  readonly issuedAt: string;
  readonly originGstin: string;
  readonly consigneeGstin: string | null;
  readonly placeOfSupply: string | null;
  readonly supplyType: SupplyType | null;
  readonly payablePaise: number;
  readonly roundOffPaise: number;
  readonly document: InvoiceDocument;
}

/** The CBIC state list, keyed both ways (the generator's resolution input). */
export interface StateCodeMaps {
  readonly byPrefix: ReadonlyMap<string, StateCodeEntry>;
  readonly byName: ReadonlyMap<string, StateCodeEntry>;
}

export interface EwbItem {
  itemNo: number;
  productName: string;
  productDesc: string;
  hsnCode: string;
  quantity: number;
  qtyUnit: string;
  taxableAmount: number;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  cessRate: number;
  cessNonAdvol: number;
}

/** One NIC bulk bill object — every key, in NIC's spelling. */
export interface EwbBillObject {
  userGstin: string;
  supplyType: string;
  subSupplyType: number;
  subSupplyDesc: string;
  docType: string;
  docNo: string;
  docDate: string;
  transType: number;
  fromGstin: string;
  fromTrdName: string;
  fromAddr1: string;
  fromAddr2: string;
  fromPlace: string;
  fromPincode: number;
  fromStateCode: number;
  actualFromStateCode: number;
  toGstin: string;
  toTrdName: string;
  toAddr1: string;
  toAddr2: string;
  toPlace: string;
  toPincode: number;
  toStateCode: number;
  actualToStateCode: number;
  totalValue: number;
  cgstValue: number;
  sgstValue: number;
  igstValue: number;
  cessValue: number;
  TotNonAdvolVal: number;
  OthValue: number;
  totInvValue: number;
  transMode: number;
  transDistance: number;
  transporterId: string;
  transporterName: string;
  transDocNo: string;
  transDocDate: string;
  vehicleNo: string;
  vehicleType: string;
  mainHsnCode: string;
  itemList: EwbItem[];
}

export interface EwbBulkFile {
  version: string;
  billLists: EwbBillObject[];
}

// ── text, amounts, dates ────────────────────────────────────────────────────

/** NIC's text rule — the shared primitive (8-1d moved it so outbound can apply it at entry). */
export { nicText };

/** Integer paise → a number rounded to 0.01 (the integer division is exact to the cent). */
export function paiseToAmount(paise: number): number {
  return paise / 100;
}

/** `YYYY-MM-DD` → NIC's `dd/mm/yyyy`. */
export function nicDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

/** Whole IST calendar days from `fromDate` to `toDate` (both `YYYY-MM-DD`). */
export function istDaysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

/** An address state resolved from its TEXT alone (`gstin = null` — the actual state). */
function actualStateOf(maps: StateCodeMaps, address: AddressSnapshot | null): string | null {
  if (address === null) return null;
  return resolveStateCode(maps.byPrefix, maps.byName, null, address.state)?.code ?? null;
}

// ── Part B ──────────────────────────────────────────────────────────────────

/**
 * The lenient normal form of a Part B input — never throws (the idempotency
 * hash fingerprints it). Text is trimmed (blank → null), the vehicle and the
 * transporter id uppercased, and the vehicle's spaces removed.
 */
export function normalizePartB(input: Partial<Record<keyof EwayPartB, unknown>> | null | undefined): EwayPartB {
  const text = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  const source = input ?? {};
  const vehicle = text(source.vehicleNo);
  return {
    transMode: num(source.transMode),
    vehicleNo: vehicle === null ? null : vehicle.replace(/\s+/g, '').toUpperCase(),
    vehicleType: text(source.vehicleType)?.toUpperCase() ?? null,
    transporterId: text(source.transporterId)?.toUpperCase() ?? null,
    transporterName: text(source.transporterName),
    transDocNo: text(source.transDocNo),
    transDocDate: text(source.transDocDate),
    distanceKm: num(source.distanceKm),
  };
}

function partBEmpty(partB: EwayPartB): boolean {
  return Object.values(partB).every((value) => value === null);
}

/** Part B proper: a vehicle (Road) or a transport document (Rail/Air/Ship). */
function partBPresent(partB: EwayPartB): boolean {
  if (partB.transMode === 1) return partB.vehicleNo !== null;
  if (partB.transMode === 2 || partB.transMode === 3 || partB.transMode === 4) return partB.transDocNo !== null;
  return false;
}

export interface PartBContext {
  /** The invoice's IST issue date (`YYYY-MM-DD`). */
  readonly invoiceDate: string;
  readonly fromPincode: string | null;
  readonly toPincode: string | null;
}

/**
 * Every NIC Part B rule the stored values break (empty = valid). ONE list,
 * used by the transport command (a 400 naming each) and by the
 * `transport-incomplete` blocker (a stored Part B re-checked at read time).
 */
export function partBProblems(partB: EwayPartB, ctx: PartBContext): string[] {
  const problems: string[] = [];
  if (partBEmpty(partB)) return problems;
  const mode = partB.transMode;
  // A transporter (id/name) and a distance are Part A: a bill with no mode
  // is valid and exports as Road (`transMode ?? 1`). A vehicle or a transport
  // document is Part B and needs its mode.
  const partBFieldSet =
    partB.vehicleNo !== null || partB.vehicleType !== null || partB.transDocNo !== null || partB.transDocDate !== null;
  if (mode === null) {
    if (partBFieldSet) problems.push('transMode is required when a vehicle or transport document is set');
  } else if (!(TRANS_MODES as readonly number[]).includes(mode)) {
    problems.push(`transMode must be 1 (Road), 2 (Rail), 3 (Air) or 4 (Ship) (got ${String(mode)})`);
  }
  if (mode === 1) {
    if (partB.vehicleNo !== null && !VEHICLE_NO_RE.test(partB.vehicleNo)) {
      problems.push(`vehicleNo must be 4–15 letters or digits (got "${partB.vehicleNo}")`);
    }
    if (partB.vehicleNo !== null && partB.vehicleType === null) {
      problems.push('vehicleType (R regular, O over-dimensional) is required with a vehicle');
    }
    if (partB.vehicleNo === null && partB.vehicleType !== null) {
      problems.push('vehicleType is set without a vehicleNo');
    }
  } else if (mode === 2 || mode === 3 || mode === 4) {
    if (partB.transDocNo === null) problems.push('transDocNo is required for Rail, Air and Ship');
    if (partB.transDocDate === null) problems.push('transDocDate is required for Rail, Air and Ship');
    if (partB.vehicleNo !== null || partB.vehicleType !== null) {
      problems.push('vehicleNo and vehicleType must be empty for Rail, Air and Ship');
    }
  }
  if (partB.vehicleType !== null && !(VEHICLE_TYPES as readonly string[]).includes(partB.vehicleType)) {
    problems.push(`vehicleType must be R or O (got "${partB.vehicleType}")`);
  }
  if (partB.transporterId !== null && !TRANSPORTER_ID_RE.test(partB.transporterId)) {
    problems.push(`transporterId must be two digits then thirteen letters or digits (got "${partB.transporterId}")`);
  }
  if (partB.transporterName !== null && partB.transporterName.length > TRANSPORTER_NAME_MAX) {
    problems.push(`transporterName must be at most ${TRANSPORTER_NAME_MAX} characters`);
  }
  if (partB.transDocNo !== null && partB.transDocNo.length > TRANS_DOC_NO_MAX) {
    problems.push(`transDocNo must be at most ${TRANS_DOC_NO_MAX} characters`);
  }
  if (partB.transDocDate !== null) {
    if (!isIsoDate(partB.transDocDate)) {
      problems.push(`transDocDate must be a date YYYY-MM-DD (got "${partB.transDocDate}")`);
    } else if (partB.transDocDate < ctx.invoiceDate) {
      problems.push(`transDocDate ${partB.transDocDate} is before the invoice date ${ctx.invoiceDate}`);
    }
  }
  if (partB.distanceKm !== null) {
    if (!Number.isInteger(partB.distanceKm) || partB.distanceKm < 0 || partB.distanceKm > DISTANCE_MAX_KM) {
      problems.push(`distanceKm must be a whole number 0–${DISTANCE_MAX_KM} (got ${String(partB.distanceKm)})`);
    } else if (
      ctx.fromPincode !== null &&
      ctx.fromPincode === ctx.toPincode &&
      partB.distanceKm > SAME_PINCODE_DISTANCE_MAX_KM
    ) {
      problems.push(`distanceKm must be at most ${SAME_PINCODE_DISTANCE_MAX_KM} when both pincodes are equal`);
    }
  }
  return problems;
}

/** A real calendar date in `YYYY-MM-DD` — moved to `shared/primitives/time.ts` (story 21-3), re-exported. */
export { isIsoDate };

/** The pincode pair a Part B is checked against (null when an address is missing). */
export function partBContext(facts: EwayInvoiceFacts): PartBContext {
  return {
    invoiceDate: istDateOf(facts.issuedAt),
    fromPincode: facts.document.header.originAddress?.pincode ?? null,
    toPincode: facts.document.header.consigneeAddress?.pincode ?? null,
  };
}

// ── blockers ────────────────────────────────────────────────────────────────

export interface BlockerContext {
  readonly maps: StateCodeMaps;
  /** The GSTIN's "e-invoicing applies" flag. */
  readonly eInvoiceApplies: boolean;
  /** Today's IST date (`YYYY-MM-DD`). */
  readonly todayIst: string;
}

/**
 * Why this bill cannot be exported or generated — computed, never stored.
 * Export and generate enforce the list; record and dismiss ignore it.
 */
export function ewbBlockers(facts: EwayInvoiceFacts, partB: EwayPartB, ctx: BlockerContext): EwayBlocker[] {
  const codes = new Set<EwayBlockerCode>();
  const lines = facts.document.lines;
  const header = facts.document.header;

  if (lines.some((line) => !isValidHsn(normalizeHsn(line.hsn)))) codes.add('hsn-issue');
  if (istDaysBetween(istDateOf(facts.issuedAt), ctx.todayIst) > MAX_DOC_AGE_DAYS) codes.add('doc-too-old');
  if (lines.length > MAX_EWB_ITEMS) codes.add('too-many-lines');

  const origin = header.originAddress;
  const consignee = header.consigneeAddress;
  // Checked on the NIC-CLEANED text: a value made only of characters outside
  // NIC's set would otherwise export as "".
  const present = (value: string | null | undefined): boolean => nicText(value, 120) !== '';
  const addressComplete =
    origin !== null &&
    consignee !== null &&
    PINCODE_RE.test(origin.pincode ?? '') &&
    PINCODE_RE.test(consignee.pincode ?? '') &&
    present(facts.document.seller.name) &&
    present(facts.document.buyer.name) &&
    present(origin.line1) &&
    present(origin.city) &&
    present(consignee.line1) &&
    present(consignee.city);
  if (!addressComplete) codes.add('address-incomplete');

  const actualFrom = actualStateOf(ctx.maps, origin);
  const actualTo = actualStateOf(ctx.maps, consignee);
  if ((origin !== null && actualFrom === null) || (consignee !== null && actualTo === null)) {
    codes.add('state-unresolved');
  }
  if (
    (actualTo !== null && actualTo !== facts.placeOfSupply) ||
    (actualFrom !== null && actualFrom !== facts.originGstin.slice(0, 2))
  ) {
    codes.add('ship-to-differs');
  }
  if (facts.placeOfSupply === null || facts.placeOfSupply === '97' || facts.placeOfSupply === '99') {
    codes.add('unsupported-supply');
  }
  if (lines.some((line) => !NIC_RATE_BPS.includes(line.gstBps))) codes.add('rate-not-standard');
  if (facts.consigneeGstin !== null && ctx.eInvoiceApplies) codes.add('needs-irn');
  if (partBProblems(partB, partBContext(facts)).length > 0 || (!partBPresent(partB) && partB.transporterId === null)) {
    codes.add('transport-incomplete');
  }

  return EWAY_BLOCKERS.filter((code) => codes.has(code)).map((code) => ({ code, terminal: TERMINAL_BLOCKERS.has(code) }));
}

// ── the builder ─────────────────────────────────────────────────────────────

function stateInt(code: string): number {
  return Number.parseInt(code, 10);
}

/**
 * The ONE NIC bill object of an invoice + its Part B. Precondition: no
 * terminal blocker (the callers gate on `ewbBlockers`); an address the
 * blockers would have flagged throws here rather than emitting a hole.
 */
export function ewbBillObject(facts: EwayInvoiceFacts, partB: EwayPartB, maps: StateCodeMaps): EwbBillObject {
  const doc = facts.document;
  const origin = doc.header.originAddress;
  const consignee = doc.header.consigneeAddress;
  if (origin === null || consignee === null || doc.buyer.name === null || facts.placeOfSupply === null) {
    throw new Error(`e-way bill for ${facts.invoiceNo}: built over an incomplete invoice (blockers not enforced)`);
  }
  const actualFrom = actualStateOf(maps, origin);
  const actualTo = actualStateOf(maps, consignee);
  if (actualFrom === null || actualTo === null) {
    throw new Error(`e-way bill for ${facts.invoiceNo}: an actual state does not resolve (blockers not enforced)`);
  }
  const intra = facts.supplyType === 'intra';

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  let taxable = 0;
  const itemList: EwbItem[] = doc.lines.map((line, index) => {
    cgst += line.cgstPaise;
    sgst += line.sgstPaise;
    igst += line.igstPaise;
    taxable += line.taxablePaise;
    return {
      itemNo: index + 1,
      productName: nicText(line.skuName, 100),
      productDesc: '',
      hsnCode: normalizeHsn(line.hsn) ?? '',
      quantity: line.qtyMilli / 1000,
      qtyUnit: uqcFor(line.uom).uqc,
      taxableAmount: paiseToAmount(line.taxablePaise),
      cgstRate: intra ? line.gstBps / 200 : 0,
      sgstRate: intra ? line.gstBps / 200 : 0,
      igstRate: intra ? 0 : line.gstBps / 100,
      cessRate: 0,
      cessNonAdvol: 0,
    };
  });

  // Transport: Road carries the vehicle as entered; Rail/Air/Ship carry the
  // document and an empty vehicle; a Part-A-only bill (no mode) is Road.
  const mode = partB.transMode ?? 1;
  const road = mode === 1;
  const samePincode = origin.pincode === consignee.pincode;
  const distance = partB.distanceKm ?? 0;

  return {
    userGstin: facts.originGstin,
    supplyType: 'O',
    subSupplyType: 1,
    subSupplyDesc: '',
    docType: 'INV',
    docNo: facts.invoiceNo,
    docDate: nicDate(istDateOf(facts.issuedAt)),
    transType: 1,
    fromGstin: facts.originGstin,
    fromTrdName: nicText(doc.seller.name, 100),
    fromAddr1: nicText(origin.line1, 120),
    fromAddr2: nicText(origin.line2, 120),
    fromPlace: nicText(origin.city, 50),
    fromPincode: Number.parseInt(origin.pincode, 10),
    fromStateCode: stateInt(facts.originGstin.slice(0, 2)),
    actualFromStateCode: stateInt(actualFrom),
    toGstin: facts.consigneeGstin ?? 'URP',
    toTrdName: nicText(doc.buyer.name, 100),
    toAddr1: nicText(consignee.line1, 120),
    toAddr2: nicText(consignee.line2, 120),
    toPlace: nicText(consignee.city, 50),
    toPincode: Number.parseInt(consignee.pincode, 10),
    toStateCode: stateInt(facts.placeOfSupply),
    actualToStateCode: stateInt(actualTo),
    totalValue: paiseToAmount(taxable),
    cgstValue: paiseToAmount(cgst),
    sgstValue: paiseToAmount(sgst),
    igstValue: paiseToAmount(igst),
    cessValue: 0,
    TotNonAdvolVal: 0,
    OthValue: paiseToAmount(facts.roundOffPaise),
    totInvValue: paiseToAmount(facts.payablePaise),
    transMode: mode,
    transDistance: distance === 0 && samePincode ? 1 : distance,
    transporterId: partB.transporterId ?? '',
    transporterName: nicText(partB.transporterName, TRANSPORTER_NAME_MAX),
    transDocNo: nicText(partB.transDocNo, TRANS_DOC_NO_MAX),
    transDocDate: partB.transDocDate === null ? '' : nicDate(partB.transDocDate),
    vehicleNo: road ? (partB.vehicleNo ?? '') : '',
    vehicleType: road ? (partB.vehicleType ?? 'R') : 'R',
    mainHsnCode: itemList[0]?.hsnCode ?? '',
    itemList,
  };
}

/** One NIC bulk-upload file over bills of ONE supplier GSTIN. */
export function bulkFile(bills: readonly EwbBillObject[]): EwbBulkFile {
  return { version: NIC_BULK_VERSION, billLists: [...bills] };
}
