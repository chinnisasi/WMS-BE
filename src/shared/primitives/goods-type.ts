/**
 * Goods-type attributes (story 1-6a): what kind of goods a SKU is — a
 * scheduled drug, a food (and with which allergens), a dangerous good, high
 * value, fragile, limited in how high it stacks. The ONE rule set every
 * write path (the single-SKU create, the edit PATCH, the catalog import)
 * calls; the DB CHECKs in `drizzle/0083_sku_goods_type.sql` are the backstop
 * and the DTOs' `@IsIn` the mirror (the three-layer vocabulary pattern).
 *
 * **Capture plus warnings, no enforcement.** Fragile, high value, DG and the
 * stack limit are shown as handling warnings where goods are handled; drug
 * schedule, food category and allergens are captured for 1-6b (segregation)
 * and 1-6c (licences). Nothing here gates a placement.
 *
 * **DG sets hazard (decision 3).** The primary DG class derives the SKU's
 * `hazardClass` — the one column the 12-2 segregation gates read — through
 * `DG_HAZARD_MAP`; class 8 makes the user choose acid, base or none;
 * 4.x, 5.2, 6.2, 7 and 9 derive nothing. `resolveHazardClass` is the one
 * predicate (decision 7) and `skus_dg_hazard_derived` its DB backstop.
 * Subsidiary DG classes are captured only (1-6b reads them).
 */

import { ProblemException } from '../problem-details/problem.exception';
import { HAZARD_CLASSES, type HazardClass } from './hazard';

/** Drug schedules (Drugs and Cosmetics Rules, plus NDPS). A drug can carry several. */
export const DRUG_SCHEDULES = ['G', 'H', 'H1', 'X', 'C', 'C1', 'NDPS'] as const;
export type DrugSchedule = (typeof DRUG_SCHEDULES)[number];

/** Allergens — the FSSAI (Labelling and Display) Regulations 2020 list. */
export const ALLERGENS = [
  'gluten-cereals',
  'crustaceans',
  'milk',
  'eggs',
  'fish',
  'peanuts',
  'tree-nuts',
  'soybean',
  'sulphite',
] as const;
export type Allergen = (typeof ALLERGENS)[number];

/**
 * Food categories. `non-food` means "declared not food"; null means "not
 * set". Allergens need a category that is set and is not `non-food`.
 */
export const FOOD_CATEGORIES = [
  'dairy',
  'meat-poultry-seafood',
  'fresh-produce',
  'bakery-cereals',
  'ready-to-eat',
  'beverages',
  'oils-fats',
  'spices-condiments',
  'confectionery',
  'packaged-dry-grocery',
  'infant-food',
  'other-food',
  'non-food',
] as const;
export type FoodCategory = (typeof FOOD_CATEGORIES)[number];

/** The food category that declares a SKU not food — it takes no allergens. */
export const NON_FOOD_CATEGORY: FoodCategory = 'non-food';

/** UN dangerous-goods classes and divisions. */
export const DG_CLASSES = [
  '1.1',
  '1.2',
  '1.3',
  '1.4',
  '1.5',
  '1.6',
  '2.1',
  '2.2',
  '2.3',
  '3',
  '4.1',
  '4.2',
  '4.3',
  '5.1',
  '5.2',
  '6.1',
  '6.2',
  '7',
  '8',
  '9',
] as const;
export type DgClass = (typeof DG_CLASSES)[number];

/** UN packing groups (I = great danger … III = minor). Optional — captured only in 1-6a. */
export const DG_PACKING_GROUPS = ['I', 'II', 'III'] as const;
export type DgPackingGroup = (typeof DG_PACKING_GROUPS)[number];

/** The classes the UN model regulations assign no packing group. */
export const DG_CLASSES_WITHOUT_PACKING_GROUP: readonly DgClass[] = [
  '1.1',
  '1.2',
  '1.3',
  '1.4',
  '1.5',
  '1.6',
  '2.1',
  '2.2',
  '2.3',
  '5.2',
  '6.2',
  '7',
];

/**
 * Decision 3 — the hazard class a primary DG class derives. Class 8 is not
 * here: it takes `corrosive-acid`, `corrosive-base` or explicit none
 * (`CORROSIVE_DG_CLASS`). Absent classes (4.x, 5.2, 6.2, 7, 9) derive
 * nothing; their `hazardClass` stays the user's choice.
 */
export const DG_HAZARD_MAP: Readonly<Partial<Record<DgClass, HazardClass>>> = {
  '1.1': 'explosive',
  '1.2': 'explosive',
  '1.3': 'explosive',
  '1.4': 'explosive',
  '1.5': 'explosive',
  '1.6': 'explosive',
  '2.1': 'gas',
  '2.2': 'gas',
  '2.3': 'gas',
  '3': 'flammable',
  '5.1': 'oxidizer',
  '6.1': 'toxic',
};

/** Class 8 — corrosives: the user chooses acid, base or none, explicitly. */
export const CORROSIVE_DG_CLASS: DgClass = '8';
export const CORROSIVE_HAZARD_CLASSES: readonly HazardClass[] = ['corrosive-acid', 'corrosive-base'];

export const MAX_DG_SUBSIDIARY_CLASSES = 2;
export const MIN_STACK_LAYERS = 1;
export const MAX_STACK_LAYERS = 100;
export const MIN_UN_NUMBER = 1;
export const MAX_UN_NUMBER = 3599;

/** The API's accepted UN-number shape: four digits, optionally prefixed `UN` (any case). */
export const UN_NUMBER_INPUT_RE = /^(UN)?\d{4}$/i;
/** The stored shape: four digits, no prefix. */
export const UN_NUMBER_RE = /^\d{4}$/;

// Load-time guard: every derived hazard value is in the hazard vocabulary,
// and the packing-group exclusions and the map name only real DG classes —
// a typo here would otherwise surface as a CHECK violation in production.
for (const [dgClass, hazard] of Object.entries(DG_HAZARD_MAP)) {
  if (!(DG_CLASSES as readonly string[]).includes(dgClass) || !(HAZARD_CLASSES as readonly string[]).includes(hazard)) {
    throw new Error(`goods-type: DG_HAZARD_MAP entry ${dgClass} → ${hazard} is outside the vocabularies`);
  }
}
for (const dgClass of DG_CLASSES_WITHOUT_PACKING_GROUP) {
  if (!(DG_CLASSES as readonly string[]).includes(dgClass)) {
    throw new Error(`goods-type: DG_CLASSES_WITHOUT_PACKING_GROUP names unknown class ${dgClass}`);
  }
}

/** The ten goods-type fields as a write path carries them (absent = not sent). */
export interface GoodsTypeInput {
  readonly drugSchedules?: readonly string[] | null | undefined;
  readonly foodCategory?: string | null | undefined;
  readonly allergens?: readonly string[] | null | undefined;
  readonly dgUnNumber?: string | null | undefined;
  readonly dgClass?: string | null | undefined;
  readonly dgSubsidiaryClasses?: readonly string[] | null | undefined;
  readonly dgPackingGroup?: string | null | undefined;
  readonly highValue?: boolean | null | undefined;
  readonly fragile?: boolean | null | undefined;
  readonly maxStackLayers?: number | null | undefined;
}

/** The resulting state of a SKU's goods-type fields — every field defined. */
export interface GoodsTypeFields {
  readonly drugSchedules: readonly string[];
  readonly foodCategory: string | null;
  readonly allergens: readonly string[];
  readonly dgUnNumber: string | null;
  readonly dgClass: string | null;
  readonly dgSubsidiaryClasses: readonly string[];
  readonly dgPackingGroup: string | null;
  readonly highValue: boolean;
  readonly fragile: boolean;
  readonly maxStackLayers: number | null;
}

/** The field names, in the fixed order every hash and response uses. */
export const GOODS_TYPE_FIELDS = [
  'drugSchedules',
  'foodCategory',
  'allergens',
  'dgUnNumber',
  'dgClass',
  'dgSubsidiaryClasses',
  'dgPackingGroup',
  'highValue',
  'fragile',
  'maxStackLayers',
] as const satisfies readonly (keyof GoodsTypeFields)[];

/** What a SKU with no goods-type data carries (every pre-1-6a row). */
export const DEFAULT_GOODS_TYPE: GoodsTypeFields = {
  drugSchedules: [],
  foodCategory: null,
  allergens: [],
  dgUnNumber: null,
  dgClass: null,
  dgSubsidiaryClasses: [],
  dgPackingGroup: null,
  highValue: false,
  fragile: false,
  maxStackLayers: null,
};

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** `UN1203` / `un1203` / `1203` → `1203`; anything else passes through for the assert to refuse. */
export function canonicalUnNumber(value: string): string {
  const trimmed = value.trim();
  return UN_NUMBER_INPUT_RE.test(trimmed) ? trimmed.slice(-4) : trimmed;
}

/**
 * Decision 10 — canonical before hashing: the `UN` prefix stripped, every
 * array sorted and de-duplicated. Keys absent from the input stay absent
 * (the hash spreads present keys only), and `null` stays `null` (the
 * controller has already refused null on the NOT NULL fields). A value of
 * the wrong type passes through untouched for `assertGoodsType` to refuse.
 */
export function canonicalGoodsType<T extends GoodsTypeInput>(input: T): T {
  const out = { ...input } as Record<string, unknown>;
  for (const key of ['drugSchedules', 'allergens', 'dgSubsidiaryClasses'] as const) {
    const value = input[key];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      out[key] = sortedUnique(value);
    }
  }
  if (typeof input.dgUnNumber === 'string') {
    out.dgUnNumber = canonicalUnNumber(input.dgUnNumber);
  }
  return out as T;
}

/** The present goods-type keys of an input, in the fixed field order — the hash spread. */
export function presentGoodsTypeKeys(input: GoodsTypeInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of GOODS_TYPE_FIELDS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

/**
 * Merge a request onto the stored state (decision 7 / the edit pipeline):
 * `fields.x !== undefined ? fields.x : current.x` — never `??`, which would
 * read an explicit clear as absent.
 */
export function mergeGoodsType(current: GoodsTypeFields, fields: GoodsTypeInput): GoodsTypeInput {
  const out: Record<string, unknown> = {};
  for (const key of GOODS_TYPE_FIELDS) {
    out[key] = fields[key] !== undefined ? fields[key] : current[key];
  }
  return out as GoodsTypeInput;
}

/** One refused goods-type field: the API field name and the sentence to show. */
export interface GoodsTypeProblem {
  readonly field: keyof GoodsTypeFields;
  readonly detail: string;
}

function inVocabulary(vocabulary: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && vocabulary.includes(value);
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * The rule set over the RESULTING state (the merged record on an edit; the
 * request itself on a create or an import row, with absent read as the
 * default). The first broken rule, or null. Pure — the import maps the field
 * to its column, the commands throw through `assertGoodsType`.
 */
export function goodsTypeProblem(merged: GoodsTypeInput): GoodsTypeProblem | null {
  const drugSchedules = merged.drugSchedules === undefined ? [] : merged.drugSchedules;
  if (!stringArray(drugSchedules)) {
    return { field: 'drugSchedules', detail: 'drugSchedules must be a list of drug schedules.' };
  }
  for (const value of drugSchedules) {
    if (!inVocabulary(DRUG_SCHEDULES, value)) {
      return { field: 'drugSchedules', detail: `drugSchedules must each be one of ${DRUG_SCHEDULES.join(', ')} (got "${value}").` };
    }
  }

  const foodCategory = merged.foodCategory ?? null;
  if (foodCategory !== null && !inVocabulary(FOOD_CATEGORIES, foodCategory)) {
    return { field: 'foodCategory', detail: `foodCategory must be one of ${FOOD_CATEGORIES.join(', ')} (got "${String(foodCategory)}").` };
  }

  const allergens = merged.allergens === undefined ? [] : merged.allergens;
  if (!stringArray(allergens)) {
    return { field: 'allergens', detail: 'allergens must be a list of allergens.' };
  }
  for (const value of allergens) {
    if (!inVocabulary(ALLERGENS, value)) {
      return { field: 'allergens', detail: `allergens must each be one of ${ALLERGENS.join(', ')} (got "${value}").` };
    }
  }
  if (allergens.length > 0 && (foodCategory === null || foodCategory === NON_FOOD_CATEGORY)) {
    return {
      field: 'allergens',
      detail:
        foodCategory === null
          ? 'allergens need a food category — set foodCategory, or send allergens: [].'
          : 'allergens cannot be declared on a non-food SKU — send allergens: [] with foodCategory "non-food".',
    };
  }

  const dgClass = merged.dgClass ?? null;
  if (dgClass !== null && !inVocabulary(DG_CLASSES, dgClass)) {
    return { field: 'dgClass', detail: `dgClass must be one of ${DG_CLASSES.join(', ')} (got "${String(dgClass)}").` };
  }

  const dgUnNumber = merged.dgUnNumber ?? null;
  if (dgUnNumber !== null) {
    const n = typeof dgUnNumber === 'string' && UN_NUMBER_RE.test(dgUnNumber) ? Number(dgUnNumber) : Number.NaN;
    if (!(n >= MIN_UN_NUMBER && n <= MAX_UN_NUMBER)) {
      return {
        field: 'dgUnNumber',
        detail: `dgUnNumber must be a UN number 0001–3599, four digits with or without the "UN" prefix (got "${String(dgUnNumber)}").`,
      };
    }
  }
  if ((dgUnNumber === null) !== (dgClass === null)) {
    return dgClass === null
      ? { field: 'dgClass', detail: 'A dangerous good needs both its UN number and its DG class — dgClass is missing.' }
      : { field: 'dgUnNumber', detail: 'A dangerous good needs both its UN number and its DG class — dgUnNumber is missing.' };
  }

  const subsidiaries = merged.dgSubsidiaryClasses === undefined ? [] : merged.dgSubsidiaryClasses;
  if (!stringArray(subsidiaries)) {
    return { field: 'dgSubsidiaryClasses', detail: 'dgSubsidiaryClasses must be a list of DG classes.' };
  }
  for (const value of subsidiaries) {
    if (!inVocabulary(DG_CLASSES, value)) {
      return { field: 'dgSubsidiaryClasses', detail: `dgSubsidiaryClasses must each be one of ${DG_CLASSES.join(', ')} (got "${value}").` };
    }
  }
  if (subsidiaries.length > MAX_DG_SUBSIDIARY_CLASSES) {
    return { field: 'dgSubsidiaryClasses', detail: `dgSubsidiaryClasses holds at most ${MAX_DG_SUBSIDIARY_CLASSES} subsidiary classes (got ${subsidiaries.length}).` };
  }
  if (subsidiaries.length > 0 && dgClass === null) {
    return { field: 'dgSubsidiaryClasses', detail: 'dgSubsidiaryClasses need a primary DG class (dgClass).' };
  }
  if (dgClass !== null && subsidiaries.includes(dgClass)) {
    return { field: 'dgSubsidiaryClasses', detail: `dgSubsidiaryClasses cannot include the primary class ${dgClass}.` };
  }

  const packingGroup = merged.dgPackingGroup ?? null;
  if (packingGroup !== null) {
    if (!inVocabulary(DG_PACKING_GROUPS, packingGroup)) {
      return { field: 'dgPackingGroup', detail: `dgPackingGroup must be one of ${DG_PACKING_GROUPS.join(', ')} (got "${String(packingGroup)}").` };
    }
    if (dgClass === null) {
      return { field: 'dgPackingGroup', detail: 'dgPackingGroup needs a DG class (dgClass).' };
    }
    if ((DG_CLASSES_WITHOUT_PACKING_GROUP as readonly string[]).includes(dgClass)) {
      return { field: 'dgPackingGroup', detail: `DG class ${dgClass} takes no packing group — send dgPackingGroup: null.` };
    }
  }

  for (const key of ['highValue', 'fragile'] as const) {
    const value = merged[key];
    if (value !== undefined && typeof value !== 'boolean') {
      return { field: key, detail: `${key} must be true or false.` };
    }
  }

  const stack = merged.maxStackLayers ?? null;
  if (stack !== null && (typeof stack !== 'number' || !Number.isInteger(stack) || stack < MIN_STACK_LAYERS || stack > MAX_STACK_LAYERS)) {
    return {
      field: 'maxStackLayers',
      detail: `maxStackLayers must be a whole number ${MIN_STACK_LAYERS}–${MAX_STACK_LAYERS} — how many of the SKU's outermost units may stand on one another; 1 means do not stack (got ${String(stack)}).`,
    };
  }
  return null;
}

/** `goodsTypeProblem` as a 400 `validation-failed` naming the field. */
export function assertGoodsType(merged: GoodsTypeInput): void {
  const problem = goodsTypeProblem(merged);
  if (problem !== null) {
    throw new ProblemException('validation-failed', 400, `${problem.field} is not a recordable goods-type value`, problem.detail);
  }
}

/** The stored DG class and hazard class a resolution is judged against; null on a create or an import row. */
export interface StoredHazardState {
  readonly dgClass: string | null;
  readonly hazardClass: string | null;
}

/** A refusal of `resolveHazardClass`: the code and the sentence. */
export interface HazardResolutionProblem {
  readonly code: 'dg-hazard-mismatch' | 'dg-hazard-required';
  readonly detail: string;
}

/**
 * Decision 7 — the ONE predicate deciding the hazard class a write leaves
 * behind. `dgClass` is the RESULTING primary DG class; `stored` is the row
 * before the write (null on a create / import row); `requested` is the
 * request's `hazardClass`: `undefined` (absent), `null` (explicit none) or a
 * value. Returns `{ hazardClass }` or a problem; never throws.
 *
 * - **Mapped class, not 8:** absent → the derived value (replacing any
 *   stored class); equal → it; anything else, `null` included → mismatch.
 * - **Class 8:** acid, base or explicit `null` → that; absent → the stored
 *   value when it is a corrosive or the DG class is unchanged (null
 *   included), else required; any other class → mismatch.
 * - **Unmapped class or no DG class:** as before 1-6a — absent keeps the
 *   stored value (null on a create), a value or `null` is taken.
 */
export function hazardResolution(
  dgClass: string | null,
  stored: StoredHazardState | null,
  requested: string | null | undefined,
): { readonly hazardClass: string | null } | HazardResolutionProblem {
  const storedHazard = stored === null ? null : stored.hazardClass;
  if (dgClass === CORROSIVE_DG_CLASS) {
    if (requested === null || (requested !== undefined && (CORROSIVE_HAZARD_CLASSES as readonly string[]).includes(requested))) {
      return { hazardClass: requested };
    }
    if (requested === undefined) {
      if (
        stored !== null &&
        ((storedHazard !== null && (CORROSIVE_HAZARD_CLASSES as readonly string[]).includes(storedHazard)) || stored.dgClass === dgClass)
      ) {
        return { hazardClass: storedHazard };
      }
      return {
        code: 'dg-hazard-required',
        detail:
          'DG class 8 (corrosives) needs its hazard class chosen explicitly — send hazardClass "corrosive-acid", "corrosive-base", or null for none.',
      };
    }
    return {
      code: 'dg-hazard-mismatch',
      detail: `DG class 8 (corrosives) takes hazardClass "corrosive-acid", "corrosive-base" or null — not "${requested}".`,
    };
  }
  const mapped = dgClass === null ? undefined : DG_HAZARD_MAP[dgClass as DgClass];
  if (mapped !== undefined) {
    if (requested === undefined || requested === mapped) {
      return { hazardClass: mapped };
    }
    return {
      code: 'dg-hazard-mismatch',
      detail: `DG class ${dgClass} sets the hazard class to "${mapped}" — got ${requested === null ? 'null' : `"${requested}"`}. Omit hazardClass, or send "${mapped}".`,
    };
  }
  return { hazardClass: requested === undefined ? storedHazard : requested };
}

/** `hazardResolution` as a value, or a 400 named by its code. */
export function resolveHazardClass(
  dgClass: string | null,
  stored: StoredHazardState | null,
  requested: string | null | undefined,
): string | null {
  const result = hazardResolution(dgClass, stored, requested);
  if ('code' in result) {
    throw new ProblemException(
      result.code,
      400,
      result.code === 'dg-hazard-mismatch' ? 'Hazard class does not match the DG class' : 'Hazard class required for DG class 8',
      result.detail,
    );
  }
  return result.hazardClass;
}
