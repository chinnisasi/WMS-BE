/**
 * Story 5-5a — contract billing: the ad-hoc charge vocabularies, the invoice
 * line vocabularies they widen, the canonical line order, and the PURE
 * builders (the printed descriptions, the en-IN rupee format, the quantity
 * parser, the record request's shape rules).
 *
 * This file is pure and imports nothing from the billing services: both
 * `client-invoices.ts` (the compute) and `client-charge.service.ts` (the
 * commands) import it, and `portal-invoices.ts` takes its line order from
 * here — a value import back from any of them would close an import cycle
 * whose load order decides whether a Nest `@Inject` token is defined.
 *
 * Each vocabulary is a TS tuple mirrored by a CHECK in
 * `drizzle/0099_contract_billing.sql` and pinned against it by
 * `test/client-charges.spec.ts` (IMPLEMENTATION-GUIDE §4).
 */
import { CHARGE_CODES, RATE_BASES } from './rate-cards';

// ── the invoice line vocabularies (widened by 5-5a) ─────────────────────────

/**
 * Every `client_invoice_lines.charge_code`: the four metered charges (in
 * their 21-5 order), then `adhoc` (an approved ad-hoc charge) and
 * `minimum_adjustment` (the top-up to the card's minimum monthly charge).
 */
export const INVOICE_LINE_CODES = [...CHARGE_CODES, 'adhoc', 'minimum_adjustment'] as const;
export type InvoiceLineCode = (typeof INVOICE_LINE_CODES)[number];

/** Every `client_invoice_lines.basis`: the four metered bases, then `per_unit` (ad-hoc) and `per_invoice` (the adjustment). */
export const INVOICE_LINE_BASES = [...RATE_BASES, 'per_unit', 'per_invoice'] as const;
export type InvoiceLineBasis = (typeof INVOICE_LINE_BASES)[number];

/** The kinds 5-5a adds — they carry a printed `description` and drill differently. */
export const EXTRA_LINE_CODES = ['adhoc', 'minimum_adjustment'] as const;

/** The adjustment's SAC: storage and warehousing services (a minimum is a warehousing commitment). */
export const MINIMUM_ADJUSTMENT_SAC = '996729';

const meteredRank = (code: string): number => (CHARGE_CODES as readonly string[]).indexOf(code);
const kindRank = (code: string): number => (code === 'adhoc' ? 1 : code === 'minimum_adjustment' ? 2 : 0);

/**
 * THE canonical line order (decision 11): metered lines first, in exactly
 * 21-5's order — `(segment_from, CHARGE_CODES rank, uom — null first)` —
 * then ad-hoc lines by `(segment_from, adhoc_charge_id)` (uuidv7, so
 * recording order), then the minimum adjustment. Two metered lines compare
 * exactly as before 5-5a, so every existing invoice keeps its order.
 */
export function compareLines(
  a: { segmentFrom: string; chargeCode: string; uom: string | null; adhocChargeId?: string | null | undefined },
  b: { segmentFrom: string; chargeCode: string; uom: string | null; adhocChargeId?: string | null | undefined },
): number {
  const kind = kindRank(a.chargeCode) - kindRank(b.chargeCode);
  if (kind !== 0) return kind;
  const from = Date.parse(a.segmentFrom) - Date.parse(b.segmentFrom);
  if (from !== 0) return from;
  if (kindRank(a.chargeCode) === 1) {
    const left = a.adhocChargeId ?? '';
    const right = b.adhocChargeId ?? '';
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const charge = meteredRank(a.chargeCode) - meteredRank(b.chargeCode);
  if (charge !== 0) return charge;
  if (a.uom === b.uom) return 0;
  if (a.uom === null) return -1;
  if (b.uom === null) return 1;
  return a.uom < b.uom ? -1 : 1;
}

// ── the charge vocabularies ─────────────────────────────────────────────────

/** Decision 3 — what an ad-hoc charge is for (a closed list; goods are refused by vocabulary). */
export const CLIENT_CHARGE_CATEGORIES = [
  'extra_labour',
  'special_handling',
  'returns_processing',
  'relabelling',
  'repacking',
  're_slotting',
  'extra_storage',
  'other',
] as const;
export type ClientChargeCategory = (typeof CLIENT_CHARGE_CATEGORIES)[number];

/**
 * Decision 4 — each category fixes its SAC, at 18 % (`CLIENT_INVOICE_GST_BPS`).
 * A product decision, not tax advice (the CA check is in PENDING).
 */
export const SAC_BY_CATEGORY: Readonly<Record<Exclude<ClientChargeCategory, 'other'>, string>> = {
  extra_labour: '996719',
  special_handling: '996719',
  returns_processing: '996719',
  relabelling: '998540',
  repacking: '998540',
  re_slotting: '996729',
  extra_storage: '996729',
};

/** `other` chooses its SAC from these four services codes (required). */
export const OTHER_SACS = ['996729', '996719', '998540', '998599'] as const;

/** A10 — the frozen printed labels (the web shows its own copy; the printed line uses these). */
export const CHARGE_CATEGORY_LABELS: Readonly<Record<ClientChargeCategory, string>> = {
  extra_labour: 'Extra labour',
  special_handling: 'Special handling',
  returns_processing: 'Returns processing',
  relabelling: 'Relabelling',
  repacking: 'Repacking',
  re_slotting: 'Re-slotting',
  extra_storage: 'Extra storage',
  other: 'Other service',
};

/** Decision 5 — the unit a charge's quantity counts. */
export const CLIENT_CHARGE_UNITS = ['each', 'hour', 'day', 'carton', 'pallet', 'order', 'shipment', 'container', 'kg', 'lot'] as const;
export type ClientChargeUnit = (typeof CLIENT_CHARGE_UNITS)[number];

/**
 * A10 — each unit's GST UQC, for the future services HSN summary (PENDING).
 * Not stored. Every value is one of `invoicing/uqc.ts`'s `UQCS` — pinned by
 * `test/client-charges.spec.ts` (billing reaches invoicing only through its
 * facade, so this file does not import the tuple).
 */
export const CHARGE_UNIT_UQC: Readonly<Record<ClientChargeUnit, string>> = {
  each: 'NOS',
  hour: 'OTH',
  day: 'OTH',
  carton: 'CTN',
  pallet: 'OTH',
  order: 'OTH',
  shipment: 'OTH',
  container: 'OTH',
  kg: 'KGS',
  lot: 'OTH',
};

export const CLIENT_CHARGE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type ClientChargeStatus = (typeof CLIENT_CHARGE_STATUSES)[number];

/** The bounds (A29 — mirrored by `client_charges_figures` / `client_charges_text`). */
export const CHARGE_DESCRIPTION_MAX = 200;
export const CHARGE_REFERENCE_MAX = 100;
export const CHARGE_NOTE_MAX = 500;
export const MAX_CHARGE_QUANTITY_MILLI = 10_000_000;
export const MAX_CHARGE_RATE_PAISE = 10_000_000;
export const MAX_CHARGE_AMOUNT_PAISE = 1_000_000_000;

/** A22 — a tenant with no policy row self-approves up to ₹10,000. */
export const DEFAULT_SELF_APPROVE_LIMIT_PAISE = 1_000_000;
export const MAX_SELF_APPROVE_LIMIT_PAISE = 1_000_000_000;

/** A10 — a charge dated more than this many days back answers 201 with `charge-late`. */
export const CHARGE_LATE_DAYS = 30;

/** The non-blocking warnings a record answers with. */
export const CLIENT_CHARGE_WARNING_CODES = ['charge-late', 'charge-billed-later', 'charge-may-bring-minimum', 'charge-disables-minimum'] as const;
export type ClientChargeWarningCode = (typeof CLIENT_CHARGE_WARNING_CODES)[number];

/** A28 — the outbox events (no consumer yet — the notification source is a deferred entry). */
export const CLIENT_CHARGE_EVENT_TYPES = ['client_charge.pending', 'client_charge.approved', 'client_charge.rejected', 'client_charge.cancelled'] as const;
export type ClientChargeEventType = (typeof CLIENT_CHARGE_EVENT_TYPES)[number];

/** The list page bounds. */
export const CLIENT_CHARGE_LIST_DEFAULT_LIMIT = 50;
export const CLIENT_CHARGE_LIST_MAX_LIMIT = 100;

// ── the pure builders ───────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * A10 — integer paise as rupees with two decimals, grouped en-IN BY HAND
 * (the last three digits, then pairs): 4548387 → `45,483.87`,
 * 1234567890 → `1,23,45,678.90`. Never `Intl` / `toLocaleString`, whose ICU
 * data varies by runtime — this text is frozen into a hashed, printed line.
 */
export function formatPaiseEnIn(paise: number | bigint): string {
  const value = typeof paise === 'bigint' ? paise : BigInt(paise);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rupees = (abs / 100n).toString();
  const fraction = (abs % 100n).toString().padStart(2, '0');
  let grouped = rupees;
  if (rupees.length > 3) {
    const head = rupees.slice(0, -3);
    const tail = rupees.slice(-3);
    const pairs: string[] = [];
    for (let end = head.length; end > 0; end -= 2) pairs.unshift(head.slice(Math.max(0, end - 2), end));
    grouped = `${pairs.join(',')},${tail}`;
  }
  return `${negative ? '-' : ''}${grouped}.${fraction}`;
}

/** `₹` + `formatPaiseEnIn`. */
export function rupeesEnIn(paise: number | bigint): string {
  return `₹${formatPaiseEnIn(paise)}`;
}

/**
 * A10 — an ad-hoc line's printed description, exactly:
 * `"<label> — <description>"` + `" · Ref <reference>"` + `" · Client auth <ref>"`.
 */
export function adhocLineDescription(charge: {
  readonly category: ClientChargeCategory;
  readonly description: string;
  readonly reference: string | null;
  readonly clientAuthorizationRef: string | null;
}): string {
  return (
    `${CHARGE_CATEGORY_LABELS[charge.category]} — ${charge.description}` +
    (charge.reference === null ? '' : ` · Ref ${charge.reference}`) +
    (charge.clientAuthorizationRef === null ? '' : ` · Client auth ${charge.clientAuthorizationRef}`)
  );
}

/** One card segment of the month as the minimum's description names it (IST dates, inclusive). */
export interface MinimumDescriptionSegment {
  readonly fromDate: string;
  readonly toDate: string;
  readonly minimumPaise: number;
}

function segmentLabel(segment: MinimumDescriptionSegment): string {
  const [y, m, from] = segment.fromDate.split('-') as [string, string, string];
  const to = segment.toDate.slice(8, 10);
  return `${from}–${to} ${MONTHS[Number(m) - 1]} ${y} at ${rupeesEnIn(segment.minimumPaise)}/month`;
}

/**
 * A10 — the minimum adjustment line's printed description, exactly:
 * `Minimum monthly charge ₹<F>[ (<seg>; <seg>)] less <all|metered> charges ₹<C>`,
 * the segments only when more than one card segment applied.
 */
export function minimumLineDescription(input: {
  readonly floorPaise: number | bigint;
  readonly chargesPaise: number | bigint;
  readonly counts: 'all' | 'metered';
  readonly segments: readonly MinimumDescriptionSegment[];
}): string {
  const proration = input.segments.length > 1 ? ` (${input.segments.map(segmentLabel).join('; ')})` : '';
  return `Minimum monthly charge ${rupeesEnIn(input.floorPaise)}${proration} less ${input.counts} charges ${rupeesEnIn(input.chargesPaise)}`;
}

/** `"2.5"` → 2500n milli; `null` when it is not a non-negative decimal of ≤ 3 places. */
export function parseChargeQuantity(text: unknown): bigint | null {
  if (typeof text !== 'string') return null;
  const match = /^(\d{1,8})(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (match === null) return null;
  return BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0'));
}

/** `round_half_up(quantity_milli × rate / 1000)` — the A29 CHECK's arithmetic, in BigInt. */
export function chargeAmountPaise(quantityMilli: bigint, unitRatePaise: number): bigint {
  return (quantityMilli * BigInt(unitRatePaise) + 500n) / 1000n;
}

/** The SAC a charge of `category` carries: the fixed one, or `other`'s choice. */
export function sacOfCategory(category: ClientChargeCategory, chosen: string | null): string | null {
  return category === 'other' ? chosen : SAC_BY_CATEGORY[category];
}

const codePoints = (value: string): number => [...value].length;

/** Trim; blank and absent alike → null. */
export function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** One bounded optional text: trimmed, blank = absent, 1..max code points (else the problem message). */
export function boundedText(value: unknown, field: string, max: number): { value: string | null; problem: string | null } {
  if (value !== undefined && value !== null && typeof value !== 'string') return { value: null, problem: `${field} must be text.` };
  const trimmed = trimmedOrNull(value);
  if (trimmed !== null && codePoints(trimmed) > max) return { value: null, problem: `${field} is at most ${max} characters (got ${codePoints(trimmed)}).` };
  return { value: trimmed, problem: null };
}

/** The months from `from` (a 1st) forward: `2026-10-01` → `2026-11-01`. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** The first of the month an IST date falls in. */
export function monthOf(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

/** `2026-10-01` → `Oct 2026` (the refusal copy). */
export function monthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}
