/**
 * Story 21-3 — the rate-card vocabularies (FR-77, CAP-4). Each is a TS tuple
 * mirrored by a CHECK in `drizzle/0060_rate_cards.sql` and pinned against it
 * by `test/rate-cards.spec.ts` (the house three-layer pattern,
 * IMPLEMENTATION-GUIDE §4). Deliberately does NOT re-export the tables: this
 * file is public (siblings may import the vocabularies), and a re-exported
 * table would let them read rate cards past `billing.facade.ts`
 * (`test/architecture.spec.ts` pins that only billing touches the tables).
 */

/**
 * A card's lifecycle: `draft` (editable, undated) → `active` (dated, frozen)
 * → `superseded` (a later card took over from its own date). An `active`
 * card whose date has not arrived may be `cancelled` instead — never in
 * force — which reopens the card it superseded.
 */
export const RATE_CARD_STATUSES = ['draft', 'active', 'superseded', 'cancelled'] as const;
export type RateCardStatus = (typeof RATE_CARD_STATUSES)[number];

/** The four charges every 3PL contract carries (billing-model.md). */
export const CHARGE_CODES = ['storage', 'inbound_handling', 'pick', 'outbound_handling'] as const;
export type ChargeCode = (typeof CHARGE_CODES)[number];

/** The closed basis each charge is priced on. */
export const RATE_BASES = ['per_thousand_units_per_day', 'per_receipt_line', 'per_pick', 'per_order'] as const;
export type RateBasis = (typeof RATE_BASES)[number];

/**
 * The pair map — each charge is priced on exactly ONE basis (the
 * `rate_card_lines_charge_basis_pair` CHECK). Storage is priced per 1,000
 * SKU base units per day only (decision 1): a whole-paise rate on that unit
 * means no fraction of a paisa exists anywhere. Pallet/bin storage waits for
 * a real pallet concept (PENDING).
 */
export const CHARGE_BASIS: Readonly<Record<ChargeCode, RateBasis>> = {
  storage: 'per_thousand_units_per_day',
  inbound_handling: 'per_receipt_line',
  pick: 'per_pick',
  outbound_handling: 'per_order',
};

/**
 * What ONE unit of each basis counts — stated here for metering (21-4), which
 * owns the counting and the rounding. Nothing in 21-3 counts anything.
 *
 * - `per_thousand_units_per_day`: the daily on-hand of the client's SKUs in
 *   base milli-units ÷ 1,000,000 (milli → base is ÷1,000, then per 1,000
 *   units). Fractional thousands are 21-4's rounding decision (BigInt
 *   arithmetic — `amount × milli-units` can pass 2⁵³).
 * - `per_receipt_line`: distinct GRN lines received — NOT ledger
 *   `grn.received` events, which are emitted again on an over-receipt
 *   approval; the re-emit is excluded.
 * - `per_pick`: distinct picklist lines picked — NOT `pick.picked` events,
 *   which the ledger emits once per batch arm or serial.
 * - `per_order`: distinct orders dispatched — NOT `dispatch.dispatched`
 *   events, which the ledger emits once per order line.
 */
export const BASIS_COUNTING_UNIT: Readonly<Record<RateBasis, string>> = {
  per_thousand_units_per_day: 'daily on-hand base milli-units ÷ 1,000,000 (per 1,000 base units per day)',
  per_receipt_line: 'distinct GRN lines received (over-receipt approval re-emits excluded)',
  per_pick: 'distinct picklist lines picked',
  per_order: 'distinct orders dispatched',
};

/** Integer paise per unit of basis, GST-exclusive: ₹0 .. ₹1 lakh. */
export const MIN_RATE_AMOUNT_PAISE = 0;
export const MAX_RATE_AMOUNT_PAISE = 10_000_000;

/**
 * Story 5-5a — the codes a rate-card LINE may carry: the four metered
 * charges (`CHARGE_CODES`, which metering prices and nothing else) plus
 * `minimum_monthly`, the contract's minimum monthly charge (one per card —
 * the existing `UNIQUE (rate_card_id, charge_code)`). Metering never reads
 * the minimum: `rateOf` looks up only the four metered codes.
 */
export const RATE_CARD_LINE_CODES = [...CHARGE_CODES, 'minimum_monthly'] as const;
export type RateCardLineCode = (typeof RATE_CARD_LINE_CODES)[number];

/** The card-line bases: the four metered bases plus `per_month` (the minimum's). */
export const RATE_CARD_LINE_BASES = [...RATE_BASES, 'per_month'] as const;
export type RateCardLineBasis = (typeof RATE_CARD_LINE_BASES)[number];

/** The pair map over every card-line code (the widened 0099 `rate_card_lines_charge_basis_pair`). */
export const RATE_CARD_LINE_BASIS: Readonly<Record<RateCardLineCode, RateCardLineBasis>> = {
  ...CHARGE_BASIS,
  minimum_monthly: 'per_month',
};

/**
 * A19 — what counts toward the minimum: `all` (metered + approved ad-hoc
 * lines, the default) or `metered` (metered lines only). Carried on the
 * `minimum_monthly` line only (the `rate_card_lines_minimum_counts` CHECK).
 */
export const MINIMUM_COUNTS = ['all', 'metered'] as const;
export type MinimumCounts = (typeof MINIMUM_COUNTS)[number];

/** A12 — the minimum monthly charge: ₹0.01 .. ₹1 crore (a metered rate stays ₹0 .. ₹1 lakh). */
export const MIN_MINIMUM_MONTHLY_PAISE = 1;
export const MAX_MINIMUM_MONTHLY_PAISE = 1_000_000_000;

/** The per-code amount bounds `lineProblems` enforces (mirrored by the widened `rate_card_lines_amount_range`). */
export function lineAmountBounds(code: RateCardLineCode): { min: number; max: number } {
  return code === 'minimum_monthly'
    ? { min: MIN_MINIMUM_MONTHLY_PAISE, max: MAX_MINIMUM_MONTHLY_PAISE }
    : { min: MIN_RATE_AMOUNT_PAISE, max: MAX_RATE_AMOUNT_PAISE };
}

/**
 * The per-client card list is unpaginated. Every DATED (non-draft) card is
 * always returned — a client's price history grows by a card per
 * renegotiation, and dropping one would hide a price that billed — while
 * drafts, which can pile up and bill nothing, are capped at the newest 100.
 */
export const MAX_DRAFT_LIST = 100;

/** One priced line as a command takes it and every read returns it. */
export interface RateCardLineInput {
  readonly chargeCode: string;
  readonly basis: string;
  readonly amountPaise: number;
  /** Story 5-5a (A19) — on a `minimum_monthly` line only; absent elsewhere. */
  readonly minimumCounts?: string | undefined;
}

/**
 * Lines in the canonical order — the `RATE_CARD_LINE_CODES` order (the hash
 * and every read): the four metered codes keep their 21-3 rank, the minimum
 * comes after them.
 */
export function sortLines<T extends { readonly chargeCode: string }>(lines: readonly T[]): T[] {
  const rank = (code: string) => {
    const index = (RATE_CARD_LINE_CODES as readonly string[]).indexOf(code);
    return index === -1 ? RATE_CARD_LINE_CODES.length : index;
  };
  return [...lines].sort((a, b) => rank(a.chargeCode) - rank(b.chargeCode) || a.chargeCode.localeCompare(b.chargeCode));
}

/**
 * Every rule a line set must satisfy, as named problems (empty = valid): the
 * vocabularies, the pair, the range, and each charge at most once. A card
 * may have ZERO lines while it is a draft — activation refuses an empty card
 * (`rate-card-no-lines`).
 */
export function lineProblems(lines: readonly RateCardLineInput[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const at = `lines[${index}]`;
    if (!(RATE_CARD_LINE_CODES as readonly string[]).includes(line.chargeCode)) {
      problems.push(`${at}.chargeCode must be one of ${JSON.stringify(RATE_CARD_LINE_CODES)} (got ${JSON.stringify(line.chargeCode)})`);
      return;
    }
    const code = line.chargeCode as RateCardLineCode;
    const expected = RATE_CARD_LINE_BASIS[code];
    if (line.basis !== expected) {
      problems.push(`${at}: ${line.chargeCode} is priced ${expected} (got ${JSON.stringify(line.basis)})`);
    }
    const { min, max } = lineAmountBounds(code);
    if (typeof line.amountPaise !== 'number' || !Number.isInteger(line.amountPaise) || line.amountPaise < min || line.amountPaise > max) {
      problems.push(`${at}.amountPaise must be whole paise ${min}..${max} (got ${String(line.amountPaise)})`);
    }
    // A19 — the counting rule rides the minimum line only.
    if (code === 'minimum_monthly') {
      if (line.minimumCounts !== undefined && !(MINIMUM_COUNTS as readonly string[]).includes(line.minimumCounts)) {
        problems.push(`${at}.minimumCounts must be one of ${JSON.stringify(MINIMUM_COUNTS)} (got ${JSON.stringify(line.minimumCounts)})`);
      }
    } else if (line.minimumCounts !== undefined) {
      problems.push(`${at}.minimumCounts is for the minimum_monthly line only`);
    }
    if (seen.has(line.chargeCode)) {
      problems.push(`${at}: ${line.chargeCode} is priced more than once — each charge appears at most once per card`);
    }
    seen.add(line.chargeCode);
  });
  return problems;
}
