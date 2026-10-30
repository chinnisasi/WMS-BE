/**
 * Story 4-9a (A8, D8, D9) — the freight load's pure vocabulary and rules: the
 * limits, the vehicle, mode, freight-terms and delivery vocabularies, the seal
 * and driver-licence normalisers, the LR rule (4-4a's AWB rule in LR words,
 * which also refuses a parcel tag and a carton code), the consignment ref
 * (`LD-0007/03`) and `parsePackageScan` (a scanned package label against the
 * load's consignments).
 *
 * Pure. Mirrored byte for byte in wms-fe `src/lib/freight-primitives.ts` and
 * wms-mobile `src/lib/freight.ts`, all three pinned by the shared
 * `freight.vectors.json` beside each copy (same sha256).
 *
 * The driver-licence helpers are `normalizeDriverLicence` / `DRIVER_LICENCE_RE`
 * (drift D8): `licence.ts` is 1-6c's drug and FSSAI licence module.
 */

import { AWB_RE, CARTON_CODE_RE, PARCEL_TAG_CODE_RE, normalizeAwb } from './awb';
import { MAX_CARTON_PACK_SEQ, MAX_CARTON_SEQ } from './carton-code';

export const FREIGHT_LIMITS = {
  /** Consignments per load (the 4-4a A37 bound — the same dispatch body per order). */
  consignments: 100,
  /** Packages per load (100 × 4-5a's 200). */
  packagesPerLoad: 20_000,
  seals: 5,
  sealLength: 30,
  driverName: 80,
  transporterName: 100,
  reason: 200,
  note: 500,
  receiverName: 100,
  /** A pallet's weight bound in grams (a carton's is 4-5a's 1,000,000). */
  palletMaxGrams: 3_000_000,
  cartonMaxGrams: 1_000_000,
  capacityKgMax: 60_000,
  /** A pallet's "said to contain" count. */
  innerCountMax: 9_999,
  /** A delivery may be amended until its sequence reaches this (A48). */
  deliverySeqMax: 99,
} as const;

export const FREIGHT_MODES = ['ftl', 'ltl'] as const;
export type FreightMode = (typeof FREIGHT_MODES)[number];

export const VEHICLE_TYPES = ['tempo', 'lcv', 'mcv', 'hcv', 'trailer', 'container-20', 'container-40', 'other'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/** Paid, to-pay, to-be-billed. */
export const FREIGHT_TERMS = ['paid', 'to-pay', 'tbb'] as const;
export type FreightTerms = (typeof FREIGHT_TERMS)[number];

export const DELIVERY_OUTCOMES = ['delivered', 'delivered-with-exceptions', 'refused'] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

export const PACKAGE_TYPES = ['carton', 'pallet'] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

/** A seal number as stored: trimmed, upper-cased. */
export const SEAL_RE = /^[A-Z0-9/-]{1,30}$/;

export function normalizeSeal(raw: string): string {
  return raw.trim().toUpperCase();
}

/** A driving-licence number as stored: upper-cased, spaces and hyphens stripped. */
export const DRIVER_LICENCE_RE = /^[A-Z0-9]{6,20}$/;

export function normalizeDriverLicence(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '');
}

/** An LR number as stored — 4-4a's AWB normaliser. */
export const normalizeLr = normalizeAwb;

/** A parcel tag at the start of a value (`freight_consignments_lr_shape` refuses the prefix too). */
const PARCEL_TAG_PREFIX_RE = /^O[0-9A-F]{16}/;

/** Why a NORMALISED value is not an LR number, in the words the surfaces show — null when it is one. */
export function lrProblem(value: string): string | null {
  if (value === '') return 'Enter the LR number (the transporter’s lorry receipt).';
  if (PARCEL_TAG_CODE_RE.test(value)) return 'This is the parcel tag — enter the transporter’s LR number.';
  if (CARTON_CODE_RE.test(value)) return 'This is a package label — enter the transporter’s LR number.';
  if (PARCEL_TAG_PREFIX_RE.test(value)) return 'This reads as a package label — enter the transporter’s LR number.';
  if (!AWB_RE.test(value)) return 'An LR number is 4–50 letters, digits or “/”, starting with a letter or digit.';
  return null;
}

/** The consignment's reference: the load code + `/` + the stop, two digits (`LD-0007/03`). */
export function consignmentRef(loadCode: string, stopSeq: number): string {
  return `${loadCode}/${String(stopSeq).padStart(2, '0')}`;
}

/** The load code (`LD-0001`), the RTV allocator shape. */
export function freightLoadCode(n: number): string {
  return `LD-${String(n).padStart(4, '0')}`;
}

export const FREIGHT_LOAD_CODE_RE = /^LD-[0-9]{4,9}$/;

/** What the scanner knows of one consignment's package set, by its parcel tag. */
export interface PackageSetOfTag {
  /** The live pack's number (1 for a virtual pack). */
  readonly packSeq: number;
  /** The live pack's package count (1 for a virtual pack). */
  readonly packageCount: number;
}

export type PackageScan =
  /** A package label (or a bare tag of a one-package order): parcel tag, pack and package numbers. */
  | { readonly kind: 'package'; readonly parcelTag: string; readonly packSeq: number; readonly seq: number; readonly code: string }
  /** A bare parcel tag of an order of several packages — scan each package label. */
  | { readonly kind: 'ambiguous'; readonly parcelTag: string; readonly packageCount: number }
  /** A bare parcel tag the lookup does not know. */
  | { readonly kind: 'unknown-tag'; readonly parcelTag: string }
  /** Not a package label nor a parcel tag. */
  | { readonly kind: 'invalid' };

/**
 * Read a scanned package code (trimmed and upper-cased first): a full package
 * code parses as 4-5a's carton code; a bare parcel tag resolves to
 * `.{packSeq}.1` only when that order's package count is 1, else `ambiguous`.
 * The returned `code` is the canonical package code (what a scan row stores).
 */
export function parsePackageScan(raw: string, lookup: (parcelTag: string) => PackageSetOfTag | undefined): PackageScan {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (CARTON_CODE_RE.test(value)) {
    const [parcelTag, pack, seqText] = value.split('.') as [string, string, string];
    const packSeq = Number(pack);
    const seq = Number(seqText);
    if (packSeq > MAX_CARTON_PACK_SEQ || seq > MAX_CARTON_SEQ) return { kind: 'invalid' };
    return { kind: 'package', parcelTag, packSeq, seq, code: value };
  }
  if (PARCEL_TAG_CODE_RE.test(value)) {
    const set = lookup(value);
    if (set === undefined) return { kind: 'unknown-tag', parcelTag: value };
    if (set.packageCount !== 1) return { kind: 'ambiguous', parcelTag: value, packageCount: set.packageCount };
    return { kind: 'package', parcelTag: value, packSeq: set.packSeq, seq: 1, code: `${value}.${set.packSeq}.1` };
  }
  return { kind: 'invalid' };
}
