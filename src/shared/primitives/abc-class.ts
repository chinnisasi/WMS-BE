/**
 * ABC class primitive (FR-cycle-count, story 5-3): the controlled vocabulary
 * carried by a SKU's nullable `abc_class`, and the whole of the class rule —
 * there is no matrix, no predicate, no ordering: the class only feeds the
 * cycle-count scheduler's per-warehouse interval policies (`count_policies`,
 * one row per (tenant, warehouse, class) → `interval_days`), and a SKU
 * without a class is simply excluded from SCHEDULED generation (OQ-1) — it
 * stays countable on demand, and its bin is still countable because another
 * classed SKU in it is due. The 12-2 three-layer vocabulary pattern (TS
 * tuple / DB CHECK / DTO `@IsIn`); the DB CHECK is declared ONLY in
 * `drizzle/0045_cycle_counts.sql` (the 0031/0035/0036 precedent — CHECKs
 * live only in migration SQL).
 *
 * Nullable with NO default (the `hazard_class` precedent): null = "not yet
 * classified", which must stay distinguishable from a classed SKU — there is
 * no sensible class to backfill (guessing 'c' would silently schedule every
 * legacy SKU for counts), and the class is set through the catalog import's
 * optional `abc_class` column and the SKU edit PATCH.
 *
 * **Scheduling is advisory** (AD-14 reading of the matrix rows): a due class
 * never blocks anything — the generated task is observational, and counting
 * never locks a bin's stock.
 */

import { ProblemException } from '../problem-details/problem.exception';

/** The controlled vocabulary — one tuple, the single source for DB and DTO. */
export const ABC_CLASSES = ['a', 'b', 'c'] as const;

export type AbcClass = (typeof ABC_CLASSES)[number];

/**
 * The shared vocabulary validator — the `assertHazardClass` shape
 * (`src/shared/primitives/hazard.ts`): iterates the fields, skips
 * `undefined`/`null` (PATCH semantics — the column is nullable, so null is
 * the legitimate clear verb, not an out-of-vocabulary value), and refuses
 * anything outside `ABC_CLASSES` with a 400 naming the field. Both
 * validators (the SKU edit command, the import row parser) call THIS — the
 * DTO's `@IsIn` mirrors it but is not the boundary.
 */
export function assertAbcClass(
  fields: Readonly<Record<string, string | null | undefined>>,
): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (!(ABC_CLASSES as readonly string[]).includes(value)) {
      throw new ProblemException(
        'validation-failed',
        400,
        `${key} is not a recordable abc class`,
        `${key} must be one of ${ABC_CLASSES.join(', ')} (got "${value}").`,
      );
    }
  }
}
