/**
 * Drug and FSSAI licences (story 1-6c): the statutory licences that make
 * holding scheduled drugs and food legal. The ONE rule set the licence
 * command, the coverage read and the expiry sweep call; the CHECKs in
 * `drizzle/0084_licences.sql` are the backstop and the DTOs' `@IsIn` the
 * mirror (the three-layer vocabulary pattern, IMPLEMENTATION-GUIDE §4).
 *
 * **Kinds are statutory forms (decision 1).** A SKU has one NEED per
 * schedule it carries — an `H` + `NDPS` SKU needs both `drug-20b` and
 * `ndps`:
 *
 * | Need       | Covered by kind                                        | For                    |
 * |------------|--------------------------------------------------------|------------------------|
 * | `drug-20b` | `drug-20b`                                             | schedules G, H, H1     |
 * | `drug-21b` | `drug-21b`                                             | schedules C, C1        |
 * | `drug-20g` | `drug-20g`                                             | schedule X             |
 * | `ndps`     | `ndps`                                                 | schedule NDPS          |
 * | `fssai`    | `fssai-registration`, `fssai-state`, `fssai-central`   | food (1-6b `isFood`)   |
 *
 * **Both holders, where the goods are (decision 2).** For a (client C, site
 * W) pair, each need requires a CLIENT licence of a covering kind held by C
 * that is either for W or names no site, AND a SITE licence of a covering
 * kind held by W — each valid on the IST date asked about. The `self` client
 * needs only the site licence (decision 4).
 *
 * **Warnings from 60 days (decision 3)**, IST dates, through `addIsoDays`
 * only: `upcoming` when `validUntil − 60 ≤ today ≤ validUntil`, `expired`
 * when `today > validUntil`.
 */

import { addIsoDays } from './time';
import type { DrugSchedule } from './goods-type';
import { EMPTY_PROFILE, isFood } from './segregation';

/** The licence kinds — statutory forms. */
export const LICENCE_KINDS = [
  'drug-20b',
  'drug-21b',
  'drug-20g',
  'ndps',
  'fssai-registration',
  'fssai-state',
  'fssai-central',
] as const;
export type LicenceKind = (typeof LICENCE_KINDS)[number];

/** What a SKU's goods need — one per drug-schedule family, plus food. */
export const LICENCE_NEEDS = ['drug-20b', 'drug-21b', 'drug-20g', 'ndps', 'fssai'] as const;
export type LicenceNeed = (typeof LICENCE_NEEDS)[number];

/** Which kinds cover each need (any FSSAI tier covers food). */
export const NEED_COVERED_BY: Readonly<Record<LicenceNeed, readonly LicenceKind[]>> = {
  'drug-20b': ['drug-20b'],
  'drug-21b': ['drug-21b'],
  'drug-20g': ['drug-20g'],
  ndps: ['ndps'],
  fssai: ['fssai-registration', 'fssai-state', 'fssai-central'],
};

/** Drug schedule → the need it raises — a `Record` over 1-6a's `DRUG_SCHEDULES`, so a new schedule is a compile error here. */
export const SCHEDULE_NEED: Readonly<Record<DrugSchedule, LicenceNeed>> = {
  G: 'drug-20b',
  H: 'drug-20b',
  H1: 'drug-20b',
  C: 'drug-21b',
  C1: 'drug-21b',
  X: 'drug-20g',
  NDPS: 'ndps',
};

export const LICENCE_STATUSES = ['active', 'withdrawn'] as const;
export type LicenceStatus = (typeof LICENCE_STATUSES)[number];

/** The FSSAI tiers — one number family. */
export const FSSAI_KINDS: readonly LicenceKind[] = ['fssai-registration', 'fssai-state', 'fssai-central'];

/** Kinds with a fixed term — `validUntil` required (decision 6). A drug form's date is the optional retention due date. */
export const KINDS_REQUIRING_VALID_UNTIL: readonly LicenceKind[] = ['ndps', ...FSSAI_KINDS];

/** A note names the context in one sentence (the excursion note's cap). */
export const LICENCE_NOTE_MAX = 200;

/** Warnings start this many days before `validUntil` (decision 3 — fixed, no per-licence lead). */
export const LICENCE_WARNING_LEAD_DAYS = 60;

/** FSSAI: 14 digits; a registration starts with 2, a state or central licence with 1. */
export const FSSAI_NUMBER_RE = /^[0-9]{14}$/;
/** Drug forms and NDPS: 1–50 of A–Z 0–9 space / . - (after normalisation). */
export const DRUG_NUMBER_RE = /^[A-Z0-9 /.-]{1,50}$/;

export function isLicenceKind(value: unknown): value is LicenceKind {
  return typeof value === 'string' && (LICENCE_KINDS as readonly string[]).includes(value);
}

export function isFssaiKind(kind: LicenceKind): boolean {
  return FSSAI_KINDS.includes(kind);
}

/** The number family (decision 7): all FSSAI tiers are one; each drug kind is its own. */
export function licenceFamily(kind: LicenceKind): string {
  return isFssaiKind(kind) ? 'fssai' : kind;
}

/** Trimmed, runs of whitespace collapsed to one space, upper-cased (decision 7). */
export function normalizeLicenceNumber(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Why a (normalised) number is not a valid number of its kind, as one
 * sentence — or null when it is. The command answers it as a 400; the
 * `licences_*_number_check` CHECKs are the backstop.
 */
export function licenceNumberProblem(kind: LicenceKind, number: string): string | null {
  if (isFssaiKind(kind)) {
    if (!FSSAI_NUMBER_RE.test(number)) {
      return `An FSSAI number is 14 digits (got "${number}").`;
    }
    const prefix = kind === 'fssai-registration' ? '2' : '1';
    if (!number.startsWith(prefix)) {
      return kind === 'fssai-registration'
        ? `An FSSAI registration number starts with 2 (got "${number}") — a number starting with 1 is a state or central licence.`
        : `An FSSAI ${kind === 'fssai-state' ? 'state' : 'central'} licence number starts with 1 (got "${number}") — a number starting with 2 is a registration.`;
    }
    return null;
  }
  if (!DRUG_NUMBER_RE.test(number)) {
    return `A licence number is 1–50 characters of A–Z, 0–9, space, "/", "." and "-" (got "${number}").`;
  }
  return null;
}

/** The goods facts a SKU's needs come from (1-6a's columns). */
export interface LicenceGoodsProfile {
  readonly foodCategory: string | null;
  readonly drugSchedules: readonly string[];
}

/**
 * A SKU's needs, in `LICENCE_NEEDS` order, each once. Food is 1-6b's
 * `isFood` — a category that is set and is not `non-food`.
 */
export function needsOf(profile: LicenceGoodsProfile): LicenceNeed[] {
  const needs = new Set<LicenceNeed>();
  for (const schedule of profile.drugSchedules) {
    const need = (SCHEDULE_NEED as Readonly<Record<string, LicenceNeed | undefined>>)[schedule];
    if (need !== undefined) needs.add(need);
  }
  if (isFood({ ...EMPTY_PROFILE, foodCategory: profile.foodCategory })) {
    needs.add('fssai');
  }
  return LICENCE_NEEDS.filter((need) => needs.has(need));
}

/** What the validity and coverage predicates read of a licence. */
export interface LicenceFacts {
  readonly clientId: string | null;
  readonly warehouseId: string | null;
  readonly kind: LicenceKind;
  readonly status: LicenceStatus;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

/** Valid on date D (decision 6): active, `validFrom` null or ≤ D, `validUntil` null or ≥ D. */
export function licenceValidOn(licence: Pick<LicenceFacts, 'status' | 'validFrom' | 'validUntil'>, date: string): boolean {
  return (
    licence.status === 'active' &&
    (licence.validFrom === null || licence.validFrom <= date) &&
    (licence.validUntil === null || licence.validUntil >= date)
  );
}

/**
 * A CLIENT licence covers (C, W, need) on a date: held by C, for W or for
 * no site (a head-office or central licence), of a covering kind, valid.
 */
export function clientLicenceCovers(
  licence: LicenceFacts,
  clientId: string,
  warehouseId: string,
  need: LicenceNeed,
  date: string,
): boolean {
  return (
    licence.clientId === clientId &&
    (licence.warehouseId === null || licence.warehouseId === warehouseId) &&
    NEED_COVERED_BY[need].includes(licence.kind) &&
    licenceValidOn(licence, date)
  );
}

/** A SITE licence covers (W, need) on a date: no client, held by W, of a covering kind, valid. */
export function siteLicenceCovers(licence: LicenceFacts, warehouseId: string, need: LicenceNeed, date: string): boolean {
  return (
    licence.clientId === null &&
    licence.warehouseId === warehouseId &&
    NEED_COVERED_BY[need].includes(licence.kind) &&
    licenceValidOn(licence, date)
  );
}

/** The warning a `validUntil` implies on an IST date (decision 3). */
export type LicenceWarningState = 'none' | 'upcoming' | 'expired';

export function warningState(validUntil: string | null, istToday: string): LicenceWarningState {
  if (validUntil === null) return 'none';
  if (istToday > validUntil) return 'expired';
  if (addIsoDays(validUntil, -LICENCE_WARNING_LEAD_DAYS) <= istToday) return 'upcoming';
  return 'none';
}

/** The list read's badge (decision 19 of the review: the server's clock, never the browser's). */
export type LicenceExpiryState = 'valid' | 'upcoming' | 'expired' | 'withdrawn';
export const LICENCE_EXPIRY_STATES = ['valid', 'upcoming', 'expired', 'withdrawn'] as const;

export function expiryStateOf(
  licence: Pick<LicenceFacts, 'status' | 'validUntil'>,
  istToday: string,
): LicenceExpiryState {
  if (licence.status === 'withdrawn') return 'withdrawn';
  const state = warningState(licence.validUntil, istToday);
  return state === 'none' ? 'valid' : state;
}

/** Whole IST days from `istToday` to `validUntil` (negative once expired); null without a date. */
export function daysLeftOf(validUntil: string | null, istToday: string): number | null {
  if (validUntil === null) return null;
  return Math.round((Date.parse(`${validUntil}T00:00:00Z`) - Date.parse(`${istToday}T00:00:00Z`)) / 86_400_000);
}
