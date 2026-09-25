/**
 * Location type primitive (story 12-4): the controlled vocabulary carried by
 * `bins.type`, and the ONE bulk-asset rule every placement gate imports.
 * Before this story the column was free text validated only by a DTO
 * `@IsIn` — exactly the pattern AD-18 replaces; the vocabulary is CHECK-backed
 * in the DB and closed here in TS, the three-layer vocabulary pattern (TS
 * tuple / DB CHECK / DTO `@IsIn`) the implementation guide mandates. The
 * CHECK is declared ONLY in `drizzle/0037_location_type_check.sql` (the
 * 0035/0036 precedent — CHECKs live only in migration SQL).
 *
 * **One table, no fork** (the epic's non-bin decision): a yard, a floor-stack
 * area, a tank or a silo is a `bins` row with a new type — not a second
 * location table. `stock_on_hand`, `batch_on_hand`, `bin_state_epochs` and
 * `ledger_events.from_bin_id/to_bin_id` key on the same rows unchanged, which
 * is the substrate Epic 20's measured-stock reconciliation lands on. The four
 * original bin types (shelf, pallet, floor, staging) keep their exact meaning
 * and come first in the tuple — every pre-12.4 row conforms with zero data
 * mutation. `floor` (individual floor bins, spec 1.3) deliberately stays
 * alongside `floor-stack` (a bulk stacked AREA); renaming would be a
 * shipped-convention change with data mutation for no capability gain.
 *
 * **The bulk-asset rule — single-SKU occupancy** (decided 2026-09-24): a
 * tank or a silo is ONE SKU's asset — you cannot co-mix a tank. The rule is
 * encoded ONCE in `bulkAssetOccupancyHolds` and imported by every gate
 * (`candidateFitsSku`, the placement guard, `mergeBin` — the marked SYNC
 * HAZARD list). A bulk asset is also NEVER auto-suggested
 * (`binCandidatesInTx` excludes the type) and never gridded: its suitability
 * depends on measured fill (Epic 20), so until then it is an
 * operator-directed placement whose mismatch reason is `bulk-asset`.
 * Weight-defined: `maxWeightGrams` is REQUIRED at create (the 11-5 weight
 * gate skips a null limit, so a tank with no bound would hold unlimited
 * mass) and cannot be cleared by a later edit.
 *
 * Yard and floor-stack carry NO extra rule (the decided Design Note): the
 * standard gates — class, secure, hazard, the 11-5 capacity family — already
 * cover them; their dimensions serve as footprint and the per-axis oversize
 * applies as-is.
 *
 * **Conformance is a command-layer rule** (AD-18): nothing in this file runs
 * outside a command transaction. The gated writers are putaway placement,
 * suggestion/task derivation and bin merge; a pick draw from a non-shelf
 * location runs the same structural/class/secure/serial gates it always did
 * and no capacity check — a draw is not a placement rule.
 */

import { ProblemException } from '../problem-details/problem.exception';

/**
 * The controlled vocabulary — one tuple, the single source for DB and DTO.
 * The four pre-existing bin types keep their order (the vocabulary-replacement
 * rule: the new list must admit everything the old one did — the first four
 * are the old list, verbatim).
 */
export const LOCATION_TYPES = [
  'shelf',
  'pallet',
  'floor',
  'staging',
  'floor-stack',
  'yard',
  'tank',
  'silo',
] as const;

export type LocationType = (typeof LOCATION_TYPES)[number];

/**
 * The bulk assets (story 12-4): the two types whose placement rules differ
 * from every ordinary bin's — single-SKU occupancy, weight-defined capacity,
 * never auto-suggested, never gridded.
 */
export const BULK_ASSET_TYPES = ['tank', 'silo'] as const;

export type BulkAssetType = (typeof BULK_ASSET_TYPES)[number];

/**
 * The types the grid generator may mint (story 12-4): the full vocabulary
 * minus the bulk assets — a bulk asset is operator-directed, never gridded.
 * The DTO layer narrows its enum to this tuple; the command's runtime
 * refusal (`refuseBulkAssetGrid`) stays as the backstop.
 */
export const GRID_TYPES: readonly Exclude<LocationType, BulkAssetType>[] = LOCATION_TYPES.filter(
  (type): type is Exclude<LocationType, BulkAssetType> => !isBulkAssetType(type),
);

/** True when the type is a bulk asset — the arm key at every gate site. */
export function isBulkAssetType(value: string): boolean {
  return (BULK_ASSET_TYPES as readonly string[]).includes(value);
}

/**
 * The ONE bulk-asset occupancy predicate — the single-SKU rule behind every
 * gate arm (the `storageClassSatisfies` / `hazardClassesCompatible`
 * one-source pattern). True when the operation CONFORMS: a bulk asset holds
 * exactly ONE SKU — the moving SKU(s) may be (a top-up of) that SKU or land
 * in an empty asset; any second distinct SKU — a placement's different SKU,
 * a merge's second moved SKU, or a merge moving two SKUs into an empty
 * asset — refuses. Non-bulk types are unconstrained (the predicate's first
 * arm); the caller checks `isBulkAssetType` only when it needs to build the
 * refusal's wording.
 */
export function bulkAssetOccupancyHolds(
  binType: string,
  movingSkuIds: readonly string[],
  occupantSkuIds: readonly string[],
): boolean {
  if (!isBulkAssetType(binType)) {
    return true;
  }
  return new Set([...movingSkuIds, ...occupantSkuIds]).size <= 1;
}

/**
 * 400 `bin-occupancy-conflict` — a placement/merge refusal naming the SKUs
 * that would co-mix: a bulk asset cannot hold (or be asked to hold) more
 * than one SKU — either beside its current occupant or through two moved
 * SKUs landing in an empty asset. Device-fault, non-retryable — the
 * operator picks another asset or tops up the holding SKU.
 */
export function binOccupancyConflict(detail: string): ProblemException {
  return new ProblemException(
    'bin-occupancy-conflict',
    400,
    'Bulk asset cannot hold two SKUs',
    detail,
  );
}
