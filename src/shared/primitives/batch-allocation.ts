import { isBatchExpiredAt } from './batch-expiry';
import { addIsoDays, istDateOf, istDaysBetween } from './time';

/**
 * Story 4-3a — THE client allocation rule and THE allocatability predicate,
 * shared by every draw-side user: the wave planner's and the short-pick
 * re-plan's `buildStockPool` (`outbound/replan.ts`), the pick's batch
 * re-derivation (`outbound/pick.command.ts` `deriveBatchArms`), and — the
 * predicate only — the promise side's ATP hook (`inventory`'s
 * `unpromisableBatchUnits`). One copy, so what a grant promises, what a wave
 * plans and what a pick draws cannot drift (`test/architecture.spec.ts` pins
 * the imports, A6).
 */

/**
 * The client allocation rules, mirrored by the `clients_allocation_rule_check`
 * and `picklist_lines_allocation_rule_check` CHECKs (migration 0094) and the
 * DTOs' `@IsIn` / `@ApiProperty({enum})`. Re-exported by
 * `modules/clients/clients.schema.ts`, the vocabulary's owner.
 *   - `fefo`: earliest expiry first; undated batches by lot first received;
 *   - `fifo`: lot first received first (`batches.created_at`).
 */
export const ALLOCATION_RULES = ['fefo', 'fifo'] as const;
export type AllocationRule = (typeof ALLOCATION_RULES)[number];

export function isAllocationRule(value: unknown): value is AllocationRule {
  return typeof value === 'string' && (ALLOCATION_RULES as readonly string[]).includes(value);
}

/** The minimum remaining shelf life at dispatch, in IST calendar days (0094's range CHECKs). */
export const MIN_OUTBOUND_SHELF_LIFE_DAYS_MIN = 1;
export const MIN_OUTBOUND_SHELF_LIFE_DAYS_MAX = 3650;

/** What the allocatability predicate needs of a batch. */
export interface AllocatableBatch {
  readonly status: string;
  /** The stored expiry instant (IST midnight of the label date), or null. */
  readonly expiryDate: string | null;
}

/**
 * Is a batch allocatable to a customer order (decision 5, A3)? All of:
 *   - its status is `active` (a blocked batch is never drawn);
 *   - it is not expired at `opAtMs` (`isBatchExpiredAt`, 3-3a's boundary);
 *   - `minDays` is null, or its expiry is null (an undated batch is never
 *     limited by the minimum), or the IST days from the judgement date to the
 *     expiry's IST date are `≥ minDays`.
 *
 * The minimum is judged on `minJudgedOn` (an IST `YYYY-MM-DD`) when given —
 * the pick's and the re-plan's one-day grace, `minimumJudgementDate` — and
 * otherwise on `opAtMs`'s own IST date. Expiry itself is ALWAYS judged at
 * `opAtMs`: an expired batch is never drawn, grace or not.
 *
 * Example (A22): minimum 90, expiry 31 Mar 2027 → allocatable through
 * 31 Dec 2026 (90 days), refused from 1 Jan 2027 (89).
 */
export function isBatchAllocatableAt(
  batch: AllocatableBatch,
  opAtMs: number,
  minDays: number | null,
  minJudgedOn?: string,
): boolean {
  if (batch.status !== 'active') return false;
  if (isBatchExpiredAt(batch.expiryDate, opAtMs)) return false;
  return meetsMinimumShelfLife(batch.expiryDate, opAtMs, minDays, minJudgedOn);
}

/**
 * The minimum arm alone (no status, no expiry): true when there is no minimum,
 * no expiry, or at least `minDays` IST days left on the judgement date. The
 * pick uses it to tell a shelf-life exclusion from a blocked or expired one
 * (the A16 refusal suffix).
 */
export function meetsMinimumShelfLife(
  expiryDate: string | null,
  opAtMs: number,
  minDays: number | null,
  minJudgedOn?: string,
): boolean {
  if (minDays === null || expiryDate === null) return true;
  const ms = Date.parse(expiryDate);
  // An expiry that does not parse fails CLOSED (the 3-3a rule).
  if (Number.isNaN(ms)) return false;
  const judgedOn = minJudgedOn ?? istDateOf(new Date(opAtMs).toISOString());
  return istDaysBetween(judgedOn, istDateOf(new Date(ms).toISOString())) >= minDays;
}

/**
 * A3 — the IST date the pick and the re-plan judge the MINIMUM on:
 * `max(planIstDate, pickIstDate − 1 day)`. It absorbs a wave planned at
 * 23:50 and picked at 00:10 (judged on the plan date) and caps a stale wave
 * at one day's slip (planned Monday, picked Thursday → judged Wednesday).
 */
export function minimumJudgementDate(planIstDate: string, pickIstDate: string): string {
  const pickMinusOne = addIsoDays(pickIstDate, -1);
  return planIstDate > pickMinusOne ? planIstDate : pickMinusOne;
}

/** What the ranking needs of a batch: the expiry and the lot's first receipt. */
export interface RankedBatchFacts {
  readonly expiryDate: string | null;
  /** `batches.created_at` — when the lot first appeared in the tenant (A5). */
  readonly createdAt: string;
}

/** One rankable slot: its bin's walk rank and the batch it names (null = batch-less). */
export interface RankableSlot {
  readonly walkRank: number;
  readonly batchId: string | null;
}

/**
 * Decision 4 — order a SKU's slots by the client's rule (stable, pure).
 *   - `fefo`: dated batch slots by expiry ascending → undated batch slots by
 *     lot first received ascending → batch-less slots.
 *   - `fifo`: batch slots by lot first received ascending → batch-less slots.
 * Ties go to the bin's walk rank, then the batch id. A batch the facts map
 * does not know ranks as undated with no receipt (after every known one in
 * its class) — callers only rank allocatable batches, so it does not arise.
 * Untracked SKUs (every slot batch-less) come back in walk order exactly.
 */
export function rankSlots<T extends RankableSlot>(
  slots: readonly T[],
  rule: AllocationRule,
  factsOf: (batchId: string) => RankedBatchFacts | undefined,
): T[] {
  // An instant that does not parse ranks LAST in its class (never NaN — a
  // NaN key would make the comparator inconsistent and the order undefined).
  const instant = (value: string): number => {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
  };
  const key = (slot: T): [number, number] => {
    if (slot.batchId === null) return [2, 0];
    const facts = factsOf(slot.batchId);
    const received = facts === undefined ? Number.POSITIVE_INFINITY : instant(facts.createdAt);
    if (rule === 'fifo') return [0, received];
    if (facts !== undefined && facts.expiryDate !== null) return [0, instant(facts.expiryDate)];
    return [1, received];
  };
  return [...slots]
    .map((slot) => ({ slot, k: key(slot) }))
    .sort((a, b) => {
      for (let i = 0; i < 2; i += 1) {
        const left = a.k[i]!;
        const right = b.k[i]!;
        if (left !== right) return left < right ? -1 : 1;
      }
      if (a.slot.walkRank !== b.slot.walkRank) return a.slot.walkRank - b.slot.walkRank;
      const la = a.slot.batchId ?? '';
      const lb = b.slot.batchId ?? '';
      return la < lb ? -1 : la > lb ? 1 : 0;
    })
    .map((entry) => entry.slot);
}

/** The policy a pre-4-3a (legacy) picklist line is drawn under: today's in-bin FEFO, no minimum. */
export function effectiveLineRule(rule: string | null): AllocationRule {
  return rule === 'fifo' ? 'fifo' : 'fefo';
}

// ── Story 4-3b — a consignee's own minimum remaining shelf life ───────────────

/**
 * Story 4-3b — the bounds of a consignee link's shelf-life rule, mirrored by
 * migration 0111's `partner_client_links_min_shelf_life_days_range` /
 * `…_percent_range` and the `picklist_lines_consignee_min_shelf_life_*`
 * CHECKs, and by the PUT's DTO; pinned against the CHECKs by
 * `test/consignee-shelf-life.spec.ts`.
 */
export const CONSIGNEE_MIN_SHELF_LIFE_DAYS_MIN = 1;
export const CONSIGNEE_MIN_SHELF_LIFE_DAYS_MAX = 3650;
export const CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MIN = 1;
export const CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MAX = 100;

/**
 * Story 4-3b (A6) — why the planner left part of a line `unfulfillable`,
 * frozen on the line (`picklist_lines.shortfall_cause`, mirrored by
 * `picklist_lines_shortfall_cause_check`, NOT VALID). Null = no stock at all
 * (the pre-4-3b meaning).
 *   - `consignee-shelf-life`: client-allocatable stock existed, but not
 *     enough of it met the consignee's minimum;
 *   - `consignee-unjudgeable`: a percent rule on a SKU with no total shelf
 *     life — no dated batch can be shown to meet it.
 */
export const SHORTFALL_CAUSES = ['consignee-shelf-life', 'consignee-unjudgeable'] as const;
export type ShortfallCause = (typeof SHORTFALL_CAUSES)[number];

/** A consignee link's rule as stored: each minimum optional, every one set must hold. */
export interface ConsigneeShelfLifeRule {
  readonly minShelfLifeDays: number | null;
  readonly minShelfLifePercent: number | null;
}

/**
 * The consignee arm one order line is judged with:
 *   - `days`: the consignee's EFFECTIVE minimum in IST days —
 *     `max(minShelfLifeDays, ceil(percent × skuShelfLifeDays / 100))` over
 *     whichever are set; null exactly when the line is unjudgeable;
 *   - `judgeable`: false when a percent rule meets a SKU with no total shelf
 *     life (decision 3) — then no dated batch qualifies (fail closed).
 */
export interface ConsigneeArm {
  readonly days: number | null;
  readonly judgeable: boolean;
}

/**
 * Decision 3 — the consignee's effective minimum for one SKU. Percent is of
 * the SKU's TOTAL shelf life (`skus.shelf_life_days`), converted at plan:
 * `ceil(percent × shelfLifeDays / 100)` (33 % of 7 → 3; 1 % of 1 → 1).
 * A percent rule over a SKU with no shelf life cannot be converted: the arm
 * is unjudgeable (`days: null`), whatever the days rule says.
 */
export function consigneeMinimumDays(rule: ConsigneeShelfLifeRule, skuShelfLifeDays: number | null): ConsigneeArm {
  if (rule.minShelfLifePercent !== null) {
    if (skuShelfLifeDays === null) return { days: null, judgeable: false };
    // Integer arithmetic: percent × days is exact, and the ceiling of an
    // integer quotient needs no float.
    const converted = Math.floor((rule.minShelfLifePercent * skuShelfLifeDays + 99) / 100);
    return { days: Math.max(rule.minShelfLifeDays ?? 0, converted), judgeable: true };
  }
  return { days: rule.minShelfLifeDays, judgeable: true };
}

/** The unit of stock the consignee arm judges: a pool slot's or a bin row's batch. */
export interface ConsigneeJudgedUnit {
  /** Null = batch-less (unattributed) units. */
  readonly batchId: string | null;
  /** The batch's stored expiry instant; null = an undated batch (or no batch). */
  readonly expiryDate: string | null;
}

/**
 * Story 4-3b (decision 4, A1) — does one unit of stock meet the consignee's
 * rule for a line? `consignee` null = no rule: always true. Otherwise:
 *   - an UNTRACKED SKU (no lot identity, nothing to judge) is never limited;
 *   - for a batch-tracked SKU, what cannot be proven is refused: batch-less
 *     (unattributed) units, an undated batch, and — on an unjudgeable line —
 *     any dated batch;
 *   - a dated batch meets it when `meetsMinimumShelfLife` holds with the
 *     arm's days on the same judgement date as the client minimum
 *     (`minJudgedOn` — the pick's and the re-plan's one-day grace; absent →
 *     `opAtMs`'s IST date, the wave plan).
 * The client minimum (4-3a) keeps its own posture (dated only); this arm is
 * judged IN ADDITION to `isBatchAllocatableAt` — all must hold.
 */
export function meetsConsigneeShelfLife(
  unit: ConsigneeJudgedUnit,
  batchTracked: boolean,
  opAtMs: number,
  consignee: ConsigneeArm | null,
  minJudgedOn?: string,
): boolean {
  if (consignee === null || !batchTracked) return true;
  if (unit.batchId === null || unit.expiryDate === null) return false;
  if (!consignee.judgeable || consignee.days === null) return false;
  return meetsMinimumShelfLife(unit.expiryDate, opAtMs, consignee.days, minJudgedOn);
}

/** The frozen consignee columns of a picklist line (`picklist_lines`, migration 0111). */
export interface ConsigneeLineColumns {
  readonly consigneePartnerId: string | null;
  readonly consigneeMinShelfLifeDays: number | null;
  readonly consigneeMinShelfLifePercent: number | null;
}

/** A line's frozen consignee arm, with the partner it was planned for. */
export interface FrozenConsigneeArm extends ConsigneeArm {
  readonly partnerId: string;
  readonly percent: number | null;
}

/**
 * Story 4-3b (A3) — THE reading of a picklist line's frozen consignee columns,
 * used by the pick, the re-plan and the order read. Null when the line was
 * planned with no consignee rule (every pre-4-3b line). A line is
 * UNJUDGEABLE exactly when the partner and the percent are set and the days
 * are null; otherwise a consignee line always carries its days. "Days null
 * means no minimum" is never read off a consignee line.
 */
export function consigneeArmOf(line: ConsigneeLineColumns): FrozenConsigneeArm | null {
  if (line.consigneePartnerId === null) return null;
  const judgeable = !(line.consigneeMinShelfLifePercent !== null && line.consigneeMinShelfLifeDays === null);
  return {
    partnerId: line.consigneePartnerId,
    days: judgeable ? line.consigneeMinShelfLifeDays : null,
    percent: line.consigneeMinShelfLifePercent,
    judgeable,
  };
}
