/**
 * Hazard class primitive (FR-41, story 12-2): the controlled vocabulary
 * carried by a SKU's nullable `hazard_class`, and the ONE segregation
 * predicate every co-location gate imports. The 12-1 three-layer vocabulary
 * pattern (TS tuple / DB CHECK / DTO `@IsIn`); the DB CHECK is declared ONLY
 * in `drizzle/0036_hazard_class.sql` (the 0031/0035 precedent — CHECKs live
 * only in migration SQL).
 *
 * **The matching rule — the default segregation matrix** (decided
 * 2026-09-23): `explosive` segregates from EVERY CLASSED SKU; `oxidizer`
 * ↔ `flammable` (FR-41's oxidiser/fuel example), `oxidizer` ↔ `gas`,
 * `corrosive-acid` ↔ `corrosive-base`, `corrosive-acid` ↔ `toxic`. Covers
 * the stated industries (chemicals → acids/bases/toxic, LPG → gas, ammonium
 * nitrate → oxidizer, ammunition → explosive); 12-7's admin surface can
 * widen it.
 *
 * **Null carries no rule, in BOTH directions** (the recorded FR-41
 * narrowing): a null class is not a class — a non-hazardous SKU may share a
 * bin with hazardous stock, and even an explosive may co-locate with
 * null-class stock. The null check runs BEFORE the explosive universal rule,
 * in `hazardClassesCompatible` — the decided narrowing, pinned by test.
 *
 * **Segregation is a co-location rule** (SKU × SKU-in-bin), unlike storage
 * class's (SKU × bin) rule: the gate reads the TARGET bin's occupants'
 * hazard classes, so a hazard-capable SKU may still enter an empty bin of
 * the right storage class. The matrix is encoded ONCE — in this TS
 * predicate, not copied into SQL; every gate (`candidateFitsSku`, the
 * placement guard, `mergeBin`, the SKU hazard-edit guard) imports
 * `hazardClassesCompatible`. The candidate list the suggestion walks is
 * shared and SKU-agnostic, so the per-(SKU, occupants) rule can only live
 * here.
 *
 * **Conformance is a command-layer rule** (AD-18): nothing in this file runs
 * outside a command transaction. The gated writers are putaway placement,
 * suggestion/task derivation and bin merge; `stock.adjust` is a NAMED
 * bypass (the 12-1 precedent, recorded in PENDING beside the
 * adjustment-bypasses-capacity gap), and `qc.released` stays class-free —
 * pinned indirectly by the edit guard's QC-hold origin-bin attribution.
 */

import { ProblemException } from '../problem-details/problem.exception';

/** The controlled vocabulary — one tuple, the single source for DB and DTO. */
export const HAZARD_CLASSES = [
  'explosive',
  'oxidizer',
  'flammable',
  'corrosive-acid',
  'corrosive-base',
  'toxic',
  'gas',
] as const;

export type HazardClass = (typeof HAZARD_CLASSES)[number];

/**
 * The incompatible pairs, encoded under SORTED keys so a lookup is
 * deterministic in one direction: `incompatible(a, b)` sorts its arguments
 * and asks the set. `explosive` is NOT here — it is the universal rule in
 * the predicate (segregates from every classed SKU, whatever the pair set
 * grows to).
 */
const INCOMPATIBLE_PAIRS: ReadonlySet<string> = new Set([
  'flammable|oxidizer',
  'gas|oxidizer',
  'corrosive-acid|corrosive-base',
  'corrosive-acid|toxic',
]);

/**
 * The shared predicate — may a SKU of class `a` co-locate with stock of
 * class `b`? Symmetric. Null (no class) is compatible with EVERYTHING —
 * checked before the explosive universal check, because null is not a class
 * and carries no rule in either direction (an explosive beside null-class
 * stock is the decided narrowing). An explosive beside any CLASSED SKU —
 * including its own class, so two explosive SKUs never share a bin — is
 * incompatible; same-SKU consolidation is NOT the predicate's job (the
 * gates skip the moving SKU's own pairs by id).
 */
export function hazardClassesCompatible(
  a: string | null,
  b: string | null,
): boolean {
  if (a === null || b === null) {
    return true;
  }
  if (a === 'explosive' || b === 'explosive') {
    return false;
  }
  const [x, y] = a < b ? [a, b] : [b, a];
  return !INCOMPATIBLE_PAIRS.has(`${x}|${y}`);
}

/**
 * The shared vocabulary validator — the `assertStorageClass` shape
 * (`src/shared/primitives/storage-class.ts`): iterates the fields, skips
 * `undefined`/`null` (PATCH semantics — the column is nullable, so null is
 * the legitimate clear verb, not an out-of-vocabulary value), and refuses
 * anything outside `HAZARD_CLASSES` with a 400 naming the field. Both
 * validators (the SKU edit command, the import row parser) call THIS — the
 * DTO's `@IsIn` mirrors it but is not the boundary.
 */
export function assertHazardClass(
  fields: Readonly<Record<string, string | null | undefined>>,
): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (!(HAZARD_CLASSES as readonly string[]).includes(value)) {
      throw new ProblemException(
        'validation-failed',
        400,
        `${key} is not a recordable hazard class`,
        `${key} must be one of ${HAZARD_CLASSES.join(', ')} (got "${value}").`,
      );
    }
  }
}

/** 400 `bin-segregation-conflict` — a placement/merge refusal naming both parties and both classes. */
export function segregationConflict(detail: string): ProblemException {
  return new ProblemException(
    'bin-segregation-conflict',
    400,
    'Target bin holds a segregated hazard class',
    detail,
  );
}

/**
 * 409 `hazard-segregation-conflict` — a hazard-class edit that would strand
 * existing stock co-located with an incompatible class. Names the conflicting
 * parties (SKUs, bins and the pinning hold, where one exists) so the operator
 * can relocate or release first.
 */
export function segregationStateConflict(detail: string): ProblemException {
  return new ProblemException(
    'hazard-segregation-conflict',
    409,
    'Hazard class conflicts with co-located stock',
    detail,
  );
}