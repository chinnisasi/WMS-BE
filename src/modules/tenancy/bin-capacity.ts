/**
 * Story 11-5 — the bin capacity caps, in their own file after the 11.2
 * precedent (`catalog/sku-attributes.ts`): both the command (`bin.command`)
 * and the DTO mirror (`tenancy.dto`) import them, and a standalone module
 * keeps the DTO's import graph free of the command's (the review triage's
 * finding — importing `bin.command` from a DTO pulls its whole module graph
 * in at load time for two constants).
 */

/** Bins are BIGGER than SKUs (a floor location is an area): 100 m axes. */
export const MAX_BIN_DIMENSION_MM = 100_000;

/** Bins are BIGGER than SKUs: 100 tonnes (vs the SKU side's 1 tonne cap). */
export const MAX_BIN_WEIGHT_GRAMS = 100_000_000;

/**
 * The volume gate's headroom, pinned by a test: the gates compute a bin's
 * `L×W×H` in JS doubles before `BigInt()` takes over, which is exact only
 * while the product stays under `Number.MAX_SAFE_INTEGER` (2⁵³ ≈ 9.007e15).
 * At this cap the product is 1e15 — about 9× headroom; widening the cap past
 * ~208,000 mm would silently lose precision in the gate's comparison.
 * If a future story must widen it, the product must move inside BigInt first.
 */