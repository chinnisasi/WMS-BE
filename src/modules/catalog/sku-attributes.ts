import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * Story 11.2 — the SKU's static physical attributes (FR-36): the caps, the
 * origin shape and the ONE validator both write edges call.
 *
 * **Integer storage, WYSIWYG everywhere.** Weight is GRAMS, dimensions are
 * MILLIMETRES — the `handling_units.weightGrams` precedent (integer grams +
 * named cap, `assertCatchWeightGrams` shape), extended to millimetres. No
 * decimals, no milli-unit scaling, no conversion layer anywhere: the CSV
 * columns, the API fields and the web inputs all speak grams and
 * millimetres, and carrier adapters (4-6d) convert at their own edge.
 * Physical attributes are read-only facts consumed by rating and capacity,
 * not quantities that accumulate in the ledger — which is why they do not
 * follow the milli-unit representation.
 *
 * **One validator, two callers.** `SkuCommand.edit` calls it behind its
 * replay lookup (the 10.2 rule — a rule that can tighten must not answer 400
 * to an op that already committed) and the import row parser calls it per
 * row. The DTOs mirror the same bounds, but a mirror is not a boundary:
 * these are the numbers the command tier actually enforces.
 */
export const MAX_SKU_WEIGHT_GRAMS = 1_000_000;

export const MAX_SKU_DIMENSION_MM = 10_000;

/** ISO 3166-1 alpha-2, uppercase — `IN`, `CN`. India-only system ≠ India-only origin. */
export const ORIGIN_RE = /^[A-Z]{2}$/;

/**
 * The five optional attribute fields an edit or an import row may carry.
 * Absent (`undefined`) and cleared (`null`) are both legal and skip the
 * value rules; `undefined` is spelled out because the repo compiles with
 * `exactOptionalPropertyTypes` — an explicitly-passed undefined must type.
 */
export interface SkuAttributeFields {
  readonly weightGrams?: number | null | undefined;
  readonly lengthMm?: number | null | undefined;
  readonly widthMm?: number | null | undefined;
  readonly heightMm?: number | null | undefined;
  readonly countryOfOrigin?: string | null | undefined;
}

/** One numeric attribute: its field name, its ceiling, the unit its messages name. */
interface NumericAttributeSpec {
  readonly key: 'weightGrams' | 'lengthMm' | 'widthMm' | 'heightMm';
  readonly cap: number;
  readonly unit: string;
}

const NUMERIC_ATTRIBUTES: readonly NumericAttributeSpec[] = [
  { key: 'weightGrams', cap: MAX_SKU_WEIGHT_GRAMS, unit: 'grams' },
  { key: 'lengthMm', cap: MAX_SKU_DIMENSION_MM, unit: 'millimetres' },
  { key: 'widthMm', cap: MAX_SKU_DIMENSION_MM, unit: 'millimetres' },
  { key: 'heightMm', cap: MAX_SKU_DIMENSION_MM, unit: 'millimetres' },
];

/**
 * The one write-edge gate for the SKU's physical attributes.
 *
 * `undefined` (absent) and `null` (cleared) are both legal and skip the
 * check — PATCH semantics follow the `hsn` precedent, so a clearing field
 * never trips a value rule. Anything present must be a positive WHOLE number
 * within the cap (a fraction is refused, never rounded — a gram or a
 * millimetre the operator did not enter is one nobody agreed to), and a
 * present country must be two uppercase letters.
 *
 * Pure SHAPE check — it needs no database row. Where it RUNS is decided by
 * the 10.2 rule, not by this function: the edit command invokes it behind
 * its replay lookup so a committed op re-serves its snapshot whatever
 * today's bounds say.
 */
export function assertSkuAttributes(fields: SkuAttributeFields): void {
  for (const { key, cap, unit } of NUMERIC_ATTRIBUTES) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > cap) {
      throw new ProblemException(
        'validation-failed',
        400,
        `${key} is not a recordable physical attribute`,
        `${key} must be a positive whole number of ${unit}, at most ${cap} — got ${String(value)}. ` +
          `A SKU's physical attributes are whole ${unit}, never a fraction and never a quantity.`,
      );
    }
  }
  const country = fields.countryOfOrigin;
  if (country !== undefined && country !== null && !ORIGIN_RE.test(country)) {
    throw new ProblemException(
      'validation-failed',
      400,
      'countryOfOrigin is not a country code',
      `countryOfOrigin must be two uppercase ISO 3166-1 alpha-2 letters (e.g. "IN", "CN") — got "${String(country)}".`,
    );
  }
}
