/**
 * Storage class primitive (FR-40 / AD-18, story 12-1): the controlled
 * vocabulary carried by every SKU and every bin, and the ONE matching
 * predicate every conformance gate imports. `bins.type` was free text with no
 * constraint — exactly the pattern AD-18 replaces; `storage_class` is
 * CHECK-backed in the DB and closed here in TS, the three-layer vocabulary
 * pattern (TS tuple / DB CHECK / DTO `@IsIn`) the implementation guide
 * mandates.
 *
 * **The matching rule — the temperature hierarchy** (decided 2026-09-23): a
 * colder bin satisfies a warmer SKU, never the reverse. `frozen` bins hold
 * `frozen`, `chilled` and `ambient` SKUs; `chilled` bins hold `chilled` and
 * `ambient`; `ambient` bins hold only `ambient`. `controlled`, `hazardous`
 * and `secure` exact-match ALWAYS — and the converse is deliberately
 * excluded too: an ordinary ambient SKU cannot live in a secure cage or a
 * hazmat bin (FR-40/42 demand only that those stock classes be held there;
 * stories 12-2/12-3 refine this). "Colder satisfies" is deliberate cold-chain
 * practice; the quality edge (dairy frozen solid) is shelf-life/excursion
 * territory (FR-50, 12-5), not conformance.
 *
 * The hierarchy is encoded ONCE — in this TS predicate, not copied into SQL.
 * The candidate list the putaway suggestion walks is shared and SKU-agnostic
 * (`binCandidatesInTx` takes no WHERE arm), so the per-(SKU, bin) rule can
 * only live here; every gate (`candidateFitsSku`, the placement guard, the
 * pick draw guard, the wave/replan pool filter, `mergeBin`) imports
 * `storageClassSatisfies`.
 *
 * **Conformance is a command-layer rule** (AD-18): nothing in this file runs
 * outside a command transaction. The gated writers are putaway placement,
 * suggestion/task derivation, pick draw, wave allocation/replan and bin
 * merge; `stock.adjust` is a NAMED bypass (recorded in PENDING beside the
 * adjustment-bypasses-capacity gap), and `qc.released` stays class-free —
 * pinned indirectly by the bin/SKU class-edit guards, which attribute
 * open-QC-hold quantities to their origin bins.
 */

import { ProblemException } from '../problem-details/problem.exception';

/** The controlled vocabulary — one tuple, the single source for DB and DTO. */
export const STORAGE_CLASSES = [
  'ambient',
  'chilled',
  'frozen',
  'controlled',
  'hazardous',
  'secure',
] as const;

export type StorageClass = (typeof STORAGE_CLASSES)[number];

/**
 * The temperature rank: a bin satisfies a SKU iff both are in the temperature
 * family and the bin's rank ≥ the SKU's rank, or the two classes are equal.
 * Non-temperature classes carry no rank — they exact-match only (rank `0`
 * would wrongly admit a warmer-family SKU).
 */
const TEMPERATURE_RANK: Partial<Record<StorageClass, number>> = {
  ambient: 1,
  chilled: 2,
  frozen: 3,
};

/**
 * The shared predicate — does this BIN's class satisfy this SKU's class for
 * storage? The one function behind every conformance gate (the 11-5 pattern:
 * one gate predicate behind every arm). Arguments are (skuClass, binClass) —
 * reads as "SKU s fits in bin b".
 */
export function storageClassSatisfies(
  skuClass: string,
  binClass: string,
): boolean {
  if (skuClass === binClass) {
    return true;
  }
  const skuRank = TEMPERATURE_RANK[skuClass as StorageClass];
  const binRank = TEMPERATURE_RANK[binClass as StorageClass];
  // A mismatched pair conforms only inside the temperature family, colder
  // bin over warmer SKU. Anything else (either side non-temperature, or the
  // warmer bin) is a mismatch.
  return skuRank !== undefined && binRank !== undefined && binRank > skuRank;
}

/**
 * The shared vocabulary validator — the `assertSkuAttributes` shape
 * (`src/modules/catalog/sku-attributes.ts`): iterates the fields, skips
 * `undefined`/`null` (PATCH semantics), and refuses anything outside
 * `STORAGE_CLASSES` with a 400 naming the field. Both validators (the SKU
 * edit command, the bin create/grid/edit commands) and the import row parser
 * call THIS — the DTO's `@IsIn` mirrors it but is not the boundary.
 */
export function assertStorageClass(
  fields: Readonly<Record<string, string | null | undefined>>,
): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (!(STORAGE_CLASSES as readonly string[]).includes(value)) {
      throw new ProblemException(
        'validation-failed',
        400,
        `${key} is not a recordable storage class`,
        `${key} must be one of ${STORAGE_CLASSES.join(', ')} (got "${value}").`,
      );
    }
  }
}

/** 400 `bin-storage-mismatch` — a placement/pick refusal naming the parties. */
export function binStorageMismatch(
  binCode: string,
  skuCode: string,
  binClass: string,
  skuClass: string,
): ProblemException {
  return new ProblemException(
    'bin-storage-mismatch',
    400,
    'Bin does not satisfy the SKU’s storage class',
    `Bin "${binCode}" is ${binClass}; SKU "${skuCode}" requires ${skuClass} storage — a non-conforming placement is refused by rule (FR-40).`,
  );
}

/**
 * 409 `storage-class-conflict` — a class edit that would strand existing
 * stock non-conforming. Names the conflicting parties (SKUs and bins) so the
 * operator can relocate or release first.
 */
export function storageClassConflict(detail: string): ProblemException {
  return new ProblemException(
    'storage-class-conflict',
    409,
    'Storage class conflicts with existing stock',
    detail,
  );
}

/** 400 — a merge whose source holds SKUs the target bin cannot satisfy. */
export function mergeClassConflict(
  targetBinCode: string,
  targetClass: string,
  offending: readonly { readonly skuCode: string; readonly skuClass: string }[],
): ProblemException {
  const parties = offending
    .map((row) => `"${row.skuCode}" (requires ${row.skuClass})`)
    .join(', ');
  return new ProblemException(
    'bin-storage-mismatch',
    400,
    'Merge refused — the target bin cannot satisfy the source’s SKUs',
    `Bin "${targetBinCode}" is ${targetClass} storage and cannot satisfy: ${parties}. ` +
      'Move them to conforming bins first.',
  );
}
