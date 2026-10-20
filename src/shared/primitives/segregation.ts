/**
 * Goods-type segregation (story 1-6b): the ONE predicate every co-location
 * gate calls — the putaway suggestion and placement, bin merge, transfer
 * receive and the SKU edit guard. It widens 12-2's two-class rule
 * (`hazardClassesCompatible`, unchanged in `hazard.ts`) to a SKU's whole
 * **segregation profile**: its hazard class, its DG class and subsidiary
 * classes, its drug schedules, its food category and its allergens.
 *
 * **The rules** (user, 2026-10-20), checked in this order — two SKUs in one
 * bin conflict when any fires; only the first is named:
 *
 * 1. `hazard-pair` — any pair across the two HAZARD SETS is incompatible
 *    under `hazardClassesCompatible`. A hazard set is the hazard class plus
 *    each DG subsidiary mapped through `DG_HAZARD_MAP` (1.x explosive, 2.x
 *    gas, 3 flammable, 5.1 oxidizer, 6.1 toxic; the rest — 8 included, which
 *    records no acid/base choice — add nothing).
 * 2. `explosive-dg` — one hazard set holds `explosive` and the other SKU has
 *    any DG class.
 * 3. `food-chemical` — one is food, the other a chemical.
 * 4. `drug-chemical` — one is a scheduled drug, the other a chemical.
 * 5. `allergen-mismatch` — both are food and their allergen sets differ (no
 *    allergens entered means allergen-free; the rule is strict).
 * 6. `raw-ready-to-eat` — one is `meat-poultry-seafood`, the other dairy,
 *    ready-to-eat, fresh produce, bakery and cereals, or infant food.
 *
 * **Food** is a category that is set and is not `non-food`; a **drug** has a
 * schedule; a **chemical** has a hazard class or a DG class and is neither
 * food nor a drug (decision 8 — spirits, UN3065 DG 3, are food: they obey
 * rules 1 and 2 and the food rules, never rule 3).
 *
 * **An empty profile carries no rule** — no hazard class, no DG class, no
 * subsidiaries, no schedules, and a category that is null or `non-food` (the
 * allergens need a food category, so they are ignored for emptiness). An
 * empty profile never conflicts with anything, which is why every occupant
 * read filters with `EMPTY_PROFILE_SQL` (the 12-2 `hazard_class is not null`
 * filter, widened) — and why a gate skips an empty incoming SKU wherever a
 * null class skipped before.
 *
 * The rules exist ONCE, here, in TypeScript — no SQL copy (the 12-2
 * precedent). `scripts/segregation-conflicts.ts` lists already-mixed bins by
 * calling this predicate, and the matrix read serves `GOODS_SEGREGATION_RULES`.
 */

import { sql, type SQL } from 'drizzle-orm';
import { skus } from '../db/schema';
import { ProblemException } from '../problem-details/problem.exception';
import { DG_HAZARD_MAP, NON_FOOD_CATEGORY, type DgClass } from './goods-type';
import { HAZARD_CLASSES, hazardClassesCompatible, type HazardClass } from './hazard';

/** What segregation reads of a SKU — six columns of `skus`. */
export interface SegregationProfile {
  readonly hazardClass: string | null;
  readonly dgClass: string | null;
  readonly dgSubsidiaryClasses: readonly string[];
  readonly drugSchedules: readonly string[];
  readonly foodCategory: string | null;
  readonly allergens: readonly string[];
}

/** The profile of a SKU with none of the six set (every pre-1-6a, non-hazardous SKU). */
export const EMPTY_PROFILE: SegregationProfile = {
  hazardClass: null,
  dgClass: null,
  dgSubsidiaryClasses: [],
  drugSchedules: [],
  foodCategory: null,
  allergens: [],
};

/** The rule codes, in the order they are checked (and served by the matrix read). */
export const GOODS_SEGREGATION_RULE_CODES = [
  'hazard-pair',
  'explosive-dg',
  'food-chemical',
  'drug-chemical',
  'allergen-mismatch',
  'raw-ready-to-eat',
] as const;
export type GoodsSegregationRule = (typeof GOODS_SEGREGATION_RULE_CODES)[number];

/** The rules as the segregation-matrix read serves them — `description` verbatim, table order. */
export const GOODS_SEGREGATION_RULES: readonly { readonly code: GoodsSegregationRule; readonly description: string }[] = [
  {
    code: 'hazard-pair',
    description:
      'Hazard classes that react — the grid above — never share a bin. A DG subsidiary risk counts like its primary class.',
  },
  {
    code: 'explosive-dg',
    description:
      'An explosive never shares a bin with any dangerous good, including DG classes with no hazard class (4, 5.2, 6.2, 7, 9, 8 none).',
  },
  {
    code: 'food-chemical',
    description:
      'Food never shares a bin with a chemical — any SKU with a hazard class or a DG class that is not itself a food or drug.',
  },
  {
    code: 'drug-chemical',
    description: 'A scheduled drug never shares a bin with a chemical.',
  },
  {
    code: 'allergen-mismatch',
    description:
      'Two foods share a bin only when they declare the same allergens. No allergens entered counts as allergen-free.',
  },
  {
    code: 'raw-ready-to-eat',
    description:
      'Raw meat, poultry and seafood never share a bin with dairy, ready-to-eat food, fresh produce, bakery and cereals, or infant food.',
  },
];

/** Rule 6's two sides. */
export const RAW_FOOD_CATEGORY = 'meat-poultry-seafood';
export const READY_TO_EAT_CATEGORIES: readonly string[] = [
  'dairy',
  'ready-to-eat',
  'fresh-produce',
  'bakery-cereals',
  'infant-food',
];

// Load-time guard: the served rules and the code tuple agree, in order.
if (GOODS_SEGREGATION_RULES.map((rule) => rule.code).join() !== GOODS_SEGREGATION_RULE_CODES.join()) {
  throw new Error('segregation: GOODS_SEGREGATION_RULES is out of step with GOODS_SEGREGATION_RULE_CODES');
}

/** True when the profile carries no rule (see the file header). */
export function isEmptyProfile(profile: SegregationProfile): boolean {
  return (
    profile.hazardClass === null &&
    profile.dgClass === null &&
    profile.dgSubsidiaryClasses.length === 0 &&
    profile.drugSchedules.length === 0 &&
    (profile.foodCategory === null || profile.foodCategory === NON_FOOD_CATEGORY)
  );
}

/**
 * The SQL condition for a **non-empty** profile over the `skus` columns —
 * `isEmptyProfile`, negated, in SQL. Every occupant read filters with it in
 * place of 12-2's `hazard_class is not null`. The three arrays are NOT NULL
 * DEFAULT '{}', so "set" is `cardinality(…) > 0`, never `is not null` (which
 * admits every row). Pinned against `isEmptyProfile` by an e2e
 * (`test/sku-goods-type.spec.ts`).
 */
export const EMPTY_PROFILE_SQL: SQL = sql`(${skus.hazardClass} is not null or ${skus.dgClass} is not null or cardinality(${skus.dgSubsidiaryClasses}) > 0 or cardinality(${skus.drugSchedules}) > 0 or (${skus.foodCategory} is not null and ${skus.foodCategory} <> ${NON_FOOD_CATEGORY}))`;

/** The six profile columns, for a select — spread them, then `profileOf(row)`. */
export const SEGREGATION_PROFILE_COLUMNS = {
  hazardClass: skus.hazardClass,
  dgClass: skus.dgClass,
  dgSubsidiaryClasses: skus.dgSubsidiaryClasses,
  drugSchedules: skus.drugSchedules,
  foodCategory: skus.foodCategory,
  allergens: skus.allergens,
} as const;

/** A row carrying the six columns → its profile (arrays defensively defaulted). */
export function profileOf(row: {
  readonly hazardClass: string | null;
  readonly dgClass: string | null;
  readonly dgSubsidiaryClasses: readonly string[] | null;
  readonly drugSchedules: readonly string[] | null;
  readonly foodCategory: string | null;
  readonly allergens: readonly string[] | null;
}): SegregationProfile {
  return {
    hazardClass: row.hazardClass,
    dgClass: row.dgClass,
    dgSubsidiaryClasses: row.dgSubsidiaryClasses ?? [],
    drugSchedules: row.drugSchedules ?? [],
    foodCategory: row.foodCategory,
    allergens: row.allergens ?? [],
  };
}

function sortedSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = sortedSet(a);
  const y = sortedSet(b);
  return x.length === y.length && x.every((value, i) => value === y[i]);
}

/** Two profiles are the same profile — arrays compared as sorted sets (decision 3). */
export function sameProfile(a: SegregationProfile, b: SegregationProfile): boolean {
  return (
    a.hazardClass === b.hazardClass &&
    a.dgClass === b.dgClass &&
    a.foodCategory === b.foodCategory &&
    sameSet(a.dgSubsidiaryClasses, b.dgSubsidiaryClasses) &&
    sameSet(a.drugSchedules, b.drugSchedules) &&
    sameSet(a.allergens, b.allergens)
  );
}

/** One hazard-set member: the class, and the subsidiary DG class it came from (null = the hazard class itself). */
export interface HazardSetEntry {
  readonly hazardClass: HazardClass;
  readonly viaSubsidiary: string | null;
}

/**
 * The hazard set (decision 1): the hazard class plus each subsidiary mapped
 * through `DG_HAZARD_MAP`, in `HAZARD_CLASSES` order, one entry per class
 * (the hazard class itself wins over a subsidiary naming the same class).
 * An out-of-vocabulary hazard class is kept as-is (fail-open like the
 * predicate — no write path can store one).
 */
export function hazardSet(profile: SegregationProfile): HazardSetEntry[] {
  const byClass = new Map<string, string | null>();
  if (profile.hazardClass !== null) {
    byClass.set(profile.hazardClass, null);
  }
  for (const subsidiary of sortedSet(profile.dgSubsidiaryClasses)) {
    const mapped = DG_HAZARD_MAP[subsidiary as DgClass];
    if (mapped !== undefined && !byClass.has(mapped)) {
      byClass.set(mapped, subsidiary);
    }
  }
  const rank = (cls: string): number => {
    const index = (HAZARD_CLASSES as readonly string[]).indexOf(cls);
    return index === -1 ? HAZARD_CLASSES.length : index;
  };
  return [...byClass.entries()]
    .sort(([x], [y]) => rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0))
    .map(([hazardClass, viaSubsidiary]) => ({ hazardClass: hazardClass as HazardClass, viaSubsidiary }));
}

/** Food: a category that is set and is not `non-food`. */
export function isFood(profile: SegregationProfile): boolean {
  return profile.foodCategory !== null && profile.foodCategory !== NON_FOOD_CATEGORY;
}

/** A scheduled drug: at least one schedule. */
export function isDrug(profile: SegregationProfile): boolean {
  return profile.drugSchedules.length > 0;
}

/** A chemical: a hazard class or a DG class, and neither food nor a drug (decision 8). */
export function isChemical(profile: SegregationProfile): boolean {
  return (profile.hazardClass !== null || profile.dgClass !== null) && !isFood(profile) && !isDrug(profile);
}

/** Which argument a one-sided fact belongs to: `a` (incoming / edited) or `b` (occupant / binmate). */
export type ConflictSide = 'a' | 'b';

/**
 * A fired rule with the facts that fired it, oriented to the arguments:
 * `a` is the incoming (or edited) SKU, `b` the occupant (or binmate).
 */
export type GoodsConflict =
  | { readonly rule: 'hazard-pair'; readonly a: HazardSetEntry; readonly b: HazardSetEntry }
  | { readonly rule: 'explosive-dg'; readonly explosive: ConflictSide; readonly dgClass: string }
  | { readonly rule: 'food-chemical'; readonly food: ConflictSide }
  | { readonly rule: 'drug-chemical'; readonly drug: ConflictSide }
  | { readonly rule: 'allergen-mismatch' }
  | { readonly rule: 'raw-ready-to-eat'; readonly raw: ConflictSide };

function firstHazardPair(a: SegregationProfile, b: SegregationProfile): { a: HazardSetEntry; b: HazardSetEntry } | null {
  const setB = hazardSet(b);
  for (const x of hazardSet(a)) {
    for (const y of setB) {
      if (!hazardClassesCompatible(x.hazardClass, y.hazardClass)) {
        return { a: x, b: y };
      }
    }
  }
  return null;
}

function holdsExplosive(profile: SegregationProfile): boolean {
  return hazardSet(profile).some((entry) => entry.hazardClass === 'explosive');
}

function isRaw(profile: SegregationProfile): boolean {
  return profile.foodCategory === RAW_FOOD_CATEGORY;
}

function isReadyToEat(profile: SegregationProfile): boolean {
  return profile.foodCategory !== null && READY_TO_EAT_CATEGORIES.includes(profile.foodCategory);
}

/** Does rule `rule` fire between `a` and `b`? (Symmetric; the hazard pair is asked separately.) */
function fires(rule: Exclude<GoodsSegregationRule, 'hazard-pair'>, a: SegregationProfile, b: SegregationProfile): GoodsConflict | null {
  switch (rule) {
    case 'explosive-dg':
      if (holdsExplosive(a) && b.dgClass !== null) return { rule, explosive: 'a', dgClass: b.dgClass };
      if (holdsExplosive(b) && a.dgClass !== null) return { rule, explosive: 'b', dgClass: a.dgClass };
      return null;
    case 'food-chemical':
      if (isFood(a) && isChemical(b)) return { rule, food: 'a' };
      if (isFood(b) && isChemical(a)) return { rule, food: 'b' };
      return null;
    case 'drug-chemical':
      if (isDrug(a) && isChemical(b)) return { rule, drug: 'a' };
      if (isDrug(b) && isChemical(a)) return { rule, drug: 'b' };
      return null;
    case 'allergen-mismatch':
      return isFood(a) && isFood(b) && !sameSet(a.allergens, b.allergens) ? { rule } : null;
    case 'raw-ready-to-eat':
      if (isRaw(a) && isReadyToEat(b)) return { rule, raw: 'a' };
      if (isRaw(b) && isReadyToEat(a)) return { rule, raw: 'b' };
      return null;
  }
}

const NON_HAZARD_RULES = GOODS_SEGREGATION_RULE_CODES.filter(
  (code): code is Exclude<GoodsSegregationRule, 'hazard-pair'> => code !== 'hazard-pair',
);

/**
 * THE predicate: the first rule (in table order) that fires between `a`
 * (incoming / edited) and `b` (occupant / binmate), with its facts — or
 * null when the two may share a bin. Symmetric: the same rule fires in
 * either argument order (the facts are oriented). Own-SKU pairs are not this
 * function's job — the gates skip them by id.
 */
export function goodsConflict(a: SegregationProfile, b: SegregationProfile): GoodsConflict | null {
  if (isEmptyProfile(a) || isEmptyProfile(b)) {
    return null;
  }
  const pair = firstHazardPair(a, b);
  if (pair !== null) {
    return { rule: 'hazard-pair', a: pair.a, b: pair.b };
  }
  for (const rule of NON_HAZARD_RULES) {
    const conflict = fires(rule, a, b);
    if (conflict !== null) {
      return conflict;
    }
  }
  return null;
}

/**
 * Every conflict between `a` and `b` as a sorted key list (decision 3):
 * `hazard-pair:<x>|<y>` per incompatible sorted class pair across the two
 * hazard sets, plus each other rule's code that fires. The edit guard
 * refuses an edit whose new keys against a binmate are not a subset of the
 * stored keys — so a change from one conflict to another is refused, and an
 * edit that leaves an already-mixed bin no worse passes.
 */
export function conflictKeys(a: SegregationProfile, b: SegregationProfile): string[] {
  if (isEmptyProfile(a) || isEmptyProfile(b)) {
    return [];
  }
  const keys = new Set<string>();
  const setB = hazardSet(b);
  for (const x of hazardSet(a)) {
    for (const y of setB) {
      if (!hazardClassesCompatible(x.hazardClass, y.hazardClass)) {
        const [p, q] = x.hazardClass < y.hazardClass ? [x.hazardClass, y.hazardClass] : [y.hazardClass, x.hazardClass];
        keys.add(`hazard-pair:${p}|${q}`);
      }
    }
  }
  for (const rule of NON_HAZARD_RULES) {
    if (fires(rule, a, b) !== null) {
      keys.add(rule);
    }
  }
  return [...keys].sort();
}

/**
 * The edit guard's naming helper: the first conflict (in rule order, the
 * hazard pairs walked as `goodsConflict` walks them) between `next` and `b`
 * whose key is NOT among `conflictKeys(stored, b)` — the conflict the edit
 * newly creates — or null when `conflictKeys(next, b)` is a subset of the
 * stored keys (the edit makes nothing worse against `b`). Null exactly when
 * every key of `conflictKeys(next, b)` is in `conflictKeys(stored, b)`
 * (pinned over every fixture pair in `segregation.spec.ts`).
 */
export function newGoodsConflict(
  next: SegregationProfile,
  stored: SegregationProfile,
  b: SegregationProfile,
): GoodsConflict | null {
  if (isEmptyProfile(next) || isEmptyProfile(b)) {
    return null;
  }
  const had = new Set(conflictKeys(stored, b));
  const setB = hazardSet(b);
  for (const x of hazardSet(next)) {
    for (const y of setB) {
      if (!hazardClassesCompatible(x.hazardClass, y.hazardClass)) {
        const [p, q] = x.hazardClass < y.hazardClass ? [x.hazardClass, y.hazardClass] : [y.hazardClass, x.hazardClass];
        if (!had.has(`hazard-pair:${p}|${q}`)) {
          return { rule: 'hazard-pair', a: x, b: y };
        }
      }
    }
  }
  for (const rule of NON_HAZARD_RULES) {
    const conflict = fires(rule, next, b);
    if (conflict !== null && !had.has(rule)) {
      return conflict;
    }
  }
  return null;
}

// ── detail templates (decision 9) ────────────────────────────────────────────

function hazardEntryLabel(entry: HazardSetEntry): string {
  return entry.viaSubsidiary === null ? entry.hazardClass : `${entry.hazardClass}, DG subsidiary ${entry.viaSubsidiary}`;
}

function chemicalLabel(profile: SegregationProfile): string {
  const parts: string[] = [];
  if (profile.hazardClass !== null) parts.push(profile.hazardClass);
  if (profile.dgClass !== null) parts.push(`DG ${profile.dgClass}`);
  return `chemical: ${parts.join(', ')}`;
}

function foodLabel(profile: SegregationProfile): string {
  return `food: ${profile.foodCategory ?? 'unknown'}`;
}

function drugLabel(profile: SegregationProfile): string {
  return `drug: schedule ${sortedSet(profile.drugSchedules).join(', ')}`;
}

function allergenLabel(profile: SegregationProfile): string {
  const allergens = sortedSet(profile.allergens);
  return `${profile.foodCategory ?? 'food'}, ${allergens.length === 0 ? 'no allergens' : `allergens: ${allergens.join(', ')}`}`;
}

/**
 * The facts of a conflict as each side's parenthetical and the verdict
 * sentence — the parts every gate's own frame composes. `a` is the incoming
 * (or edited) SKU's label, `b` the occupant's (or binmate's); `verdict`
 * follows "SKU … " on the incoming side and refers to the occupant as "it";
 * `pairVerdict` is the same rule stated of two SKUs together.
 */
export function conflictFacts(
  conflict: GoodsConflict,
  a: SegregationProfile,
  b: SegregationProfile,
): { readonly a: string; readonly b: string; readonly verdict: string; readonly pairVerdict: string } {
  const pick = (side: ConflictSide): SegregationProfile => (side === 'a' ? a : b);
  const other = (side: ConflictSide): ConflictSide => (side === 'a' ? 'b' : 'a');
  const labels = (side: ConflictSide, mine: string, theirs: string): { a: string; b: string } =>
    side === 'a' ? { a: mine, b: theirs } : { a: theirs, b: mine };
  switch (conflict.rule) {
    case 'hazard-pair':
      return {
        a: hazardEntryLabel(conflict.a),
        b: hazardEntryLabel(conflict.b),
        verdict: 'is segregated from it (FR-41)',
        pairVerdict: 'are segregated from each other (FR-41)',
      };
    case 'explosive-dg': {
      const dgSide = other(conflict.explosive);
      return {
        ...labels(conflict.explosive, 'explosive', `DG ${conflict.dgClass}`),
        verdict:
          dgSide === 'b'
            ? 'is an explosive, and an explosive never shares a bin with a dangerous good'
            : 'is a dangerous good, and an explosive never shares a bin with one',
        pairVerdict: 'must be kept apart: an explosive never shares a bin with a dangerous good',
      };
    }
    case 'food-chemical': {
      const chem = other(conflict.food);
      return {
        ...labels(conflict.food, foodLabel(pick(conflict.food)), chemicalLabel(pick(chem))),
        verdict: 'must be kept apart from it: food never shares a bin with a chemical',
        pairVerdict: 'must be kept apart: food never shares a bin with a chemical',
      };
    }
    case 'drug-chemical': {
      const chem = other(conflict.drug);
      return {
        ...labels(conflict.drug, drugLabel(pick(conflict.drug)), chemicalLabel(pick(chem))),
        verdict: 'must be kept apart from it: a scheduled drug never shares a bin with a chemical',
        pairVerdict: 'must be kept apart: a scheduled drug never shares a bin with a chemical',
      };
    }
    case 'allergen-mismatch':
      return {
        a: allergenLabel(a),
        b: allergenLabel(b),
        verdict: 'must be kept apart from it: two foods share a bin only when they declare the same allergens',
        pairVerdict: 'must be kept apart: two foods share a bin only when they declare the same allergens',
      };
    case 'raw-ready-to-eat': {
      const rte = other(conflict.raw);
      return {
        ...labels(conflict.raw, RAW_FOOD_CATEGORY, pick(rte).foodCategory ?? 'food'),
        verdict:
          'must be kept apart from it: raw meat, poultry and seafood never share a bin with dairy, ready-to-eat food, fresh produce, bakery and cereals, or infant food',
        pairVerdict:
          'must be kept apart: raw meat, poultry and seafood never share a bin with dairy, ready-to-eat food, fresh produce, bakery and cereals, or infant food',
      };
    }
  }
}

/**
 * The placement-framed detail (the default template): names the bin, both
 * SKU codes, the facts that fired and the rule. For `hazard-pair` with no
 * subsidiary involved it is byte-identical to 12-2's placement detail.
 */
export function goodsConflictDetail(
  conflict: GoodsConflict,
  parties: {
    readonly binCode: string;
    readonly incomingCode: string;
    readonly incoming: SegregationProfile;
    readonly occupantCode: string;
    readonly occupant: SegregationProfile;
  },
): string {
  const facts = conflictFacts(conflict, parties.incoming, parties.occupant);
  return (
    `Bin "${parties.binCode}" holds SKU "${parties.occupantCode}" (${facts.b}) — SKU "${parties.incomingCode}" ` +
    `(${facts.a}) ${facts.verdict}.`
  );
}

/** Decision 2 — the title stays 12-2's for the two hazard rules; the four goods rules share one. */
export function goodsConflictTitle(rule: GoodsSegregationRule): string {
  return rule === 'hazard-pair' || rule === 'explosive-dg'
    ? 'Target bin holds a segregated hazard class'
    : 'Target bin holds goods that must be kept apart';
}

/**
 * `bin-segregation-conflict` for a gate refusal — 400 on placement and
 * merge, 409 on transfer receive (decision 2: the code is shared, the status
 * is per surface).
 */
export function binGoodsConflict(rule: GoodsSegregationRule, detail: string, status: 400 | 409 = 400): ProblemException {
  return new ProblemException('bin-segregation-conflict', status, goodsConflictTitle(rule), detail);
}

/** 409 `hazard-segregation-conflict` — an edit that makes co-located stock conflict where it did not. */
export function goodsStateConflict(rule: GoodsSegregationRule, detail: string): ProblemException {
  return new ProblemException(
    'hazard-segregation-conflict',
    409,
    rule === 'hazard-pair' || rule === 'explosive-dg'
      ? 'Hazard class conflicts with co-located stock'
      : goodsConflictTitle(rule),
    detail,
  );
}
