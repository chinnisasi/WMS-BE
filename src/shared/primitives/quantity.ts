/**
 * Quantity primitive (AD-9, amended by story 10.1): every quantity in the
 * domain is a **scaled integer in milli-units** — the SKU's base unit of
 * measure × 10³. Nothing decimal exists inside the domain: conversion to and
 * from the operator-facing decimal happens ONLY at the API edge, through
 * `toMilli`/`fromMilli` in this file.
 *
 * This file is the chokepoint. Scaling is enforced here and in the database
 * column types (`bigint`), not across the call sites — a call site that hands
 * a brand a value already in milli-units is the only contract it has to keep.
 *
 * **Why ×10³ and not ×10⁶.** The binding limit is not `bigint` but the 2⁵³
 * exact-integer ceiling of IEEE doubles, which quantities cross twice: Lua 5.1
 * inside the Valkey reservation scripts, and JavaScript itself. At ×10⁶ the
 * usable range collapses to ~9.0 × 10⁹ base units — a grams-based silo caps at
 * ~9,007 t, which is reachable. At ×10³ it is ~9.0 × 10¹² base units.
 *
 * **Why `number` and not `bigint`.** `quantityDelta` is JSON-serialized into
 * the ledger hash chain and `JSON.stringify` throws on a BigInt. At milli
 * scale `Number.isSafeInteger` covers the whole usable range, so the branded
 * guards keep working exactly as before.
 */

/**
 * Decimal places the representation can express — the cap on any declared
 * precision, and the ONE number the scale is defined by. `fromMilli`'s
 * `toFixed` round-trip is only correct while the two agree, so they are not
 * allowed to be two independent constants that could drift apart.
 */
export const QUANTITY_DECIMALS = 3;

/** Milli-units per base unit. Quantities are base UoM × this. */
export const QUANTITY_SCALE = 10 ** QUANTITY_DECIMALS;

/**
 * The largest quantity the system accepts, in the operator-facing base UoM
 * (~9.0 × 10¹²). It is the IEEE double safe-integer ceiling divided by the
 * scale — the point past which neither JavaScript nor Lua 5.1 inside the
 * Valkey scripts can hold a milli-unit value exactly.
 *
 * This is the ONE bound. The DTO `@Max` publishes it and the command-layer
 * backstops derive from it, so the two gates cannot drift apart and the
 * refusal text never prints a ragged fraction.
 */
export const MAX_QUANTITY_BASE = Math.floor(Number.MAX_SAFE_INTEGER / QUANTITY_SCALE);

/** The same bound in milli-units — what a command sees after the edge scales. */
export const MAX_QUANTITY_MILLI = MAX_QUANTITY_BASE * QUANTITY_SCALE;

/**
 * The one sentence every quantity-bearing request field says about itself, so
 * the OpenAPI document (and the generated clients) describe the contract the
 * same way everywhere.
 */
// The per-UoM precision refusal (a value finer than the unit's own declared
// precision is rejected rather than rounded) arrives with story 10.2. That
// identifier stays in this comment: the description below is published in the
// OpenAPI document and read by external consumers, who cannot resolve it.
export const QUANTITY_FIELD_DESCRIPTION =
  'A quantity in the SKU\'s base UoM, to at most 3 decimal places. A value ' +
  'with more precision than that is rounded to 3 decimal places.';

/**
 * A non-negative level (on-hand, reserved, capacity), in milli-units.
 * On-hand is a level, never signed — a movement gets `SignedQuantity`.
 *
 * Named for the unit it holds: story 10.1 moved the domain off base units, and
 * a brand called `BaseQuantity` would now assert the wrong one.
 */
export type MilliQuantity = number & { readonly __brand: 'milli-quantity' };

export function milliQuantity(value: number): MilliQuantity {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Quantity must be a non-negative integer in milli-units: ${value}`);
  }
  return value as MilliQuantity;
}

/** GST rate in basis points (e.g. 18% = 1800). Never a float, never a string. */
export type GstBps = number & { readonly __brand: 'gst-bps' };

export function gstBps(percent: number): GstBps {
  const bps = Math.round(percent * 100);
  if (!Number.isFinite(bps)) throw new Error(`Non-finite GST rate: ${percent}`);
  if (bps < 0 || bps > 10000) throw new Error(`GST out of range (0–100%): ${percent}`);
  return bps as GstBps;
}

/**
 * Signed quantity (Story 2.1): the ledger's movement delta — a **signed**
 * integer in milli-units. `MilliQuantity` stays non-negative (on-hand is a
 * level, never signed); a movement is a signed delta, so it gets this sibling
 * brand rather than loosening `MilliQuantity`.
 */
export type SignedQuantity = number & { readonly __brand: 'signed-quantity' };

export function signedQuantity(value: number): SignedQuantity {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Quantity delta must be an integer in milli-units: ${value}`);
  }
  return value as SignedQuantity;
}

/**
 * Edge converter, inbound: an operator-facing decimal in the base UoM becomes
 * the domain's milli-unit integer. Rounds to the nearest milli-unit — story
 * 10.2 is what teaches the system to REFUSE a value finer than its UoM's
 * declared precision; until then the edge rounds rather than refusing.
 *
 * Throws on a non-finite input or one beyond the exact range, so an overflow
 * is a typed refusal at the boundary and never a silent wrap downstream.
 */
export function toMilli(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Quantity must be a finite number: ${value}`);
  }
  const milli = Math.round(value * QUANTITY_SCALE);
  if (!Number.isSafeInteger(milli)) {
    throw new Error(
      `Quantity out of exact range (±${MAX_QUANTITY_BASE} base units): ${value}`,
    );
  }
  return milli;
}

/**
 * Edge converter, outbound: the domain's milli-unit integer becomes the
 * operator-facing decimal in the base UoM. An each-counted quantity comes back
 * as the same integer it went in as — 500 pcs stores 500000 and reads 500.
 */
export function fromMilli(milli: number): number {
  // `toMilli` validates everything and this validated nothing, which made the
  // pair asymmetric in the dangerous direction: a raw `int8` read that missed
  // its `Number(...)` coercion is a STRING, and `'18400' % 1000` is NaN — so a
  // missing coercion reached an HTTP body as null rather than failing where it
  // could still be traced.
  if (!Number.isSafeInteger(milli)) {
    throw new Error(`Quantity must be an exact integer in milli-units: ${String(milli)}`);
  }
  if (milli % QUANTITY_SCALE === 0) {
    return milli / QUANTITY_SCALE;
  }
  // Binary division of a non-multiple can land a hair off (18457/1000); the
  // fixed-precision round-trip pins it to the scale's own decimal places.
  return Number((milli / QUANTITY_SCALE).toFixed(QUANTITY_DECIMALS));
}

/**
 * True when a non-zero input would VANISH at the edge: finer than half a
 * milli-unit, so `toMilli` rounds it to nothing.
 *
 * Rounding a value that is merely too precise is the declared behaviour of
 * this story (18.4567 → 18.457). Rounding one away entirely is not the same
 * thing: a pick of 0.0004 recorded as 0 is not a rounded pick, it is an
 * empty-bin short pick the operator never reported, and a stock adjustment of
 * 0.0004 becomes a zero-delta ledger event. Both are silent losses, so the
 * edge refuses them by name instead.
 */
export function scalesToZero(value: number): boolean {
  return Number.isFinite(value) && value !== 0 && toMilli(value) === 0;
}

/** The smallest quantity the representation can express, in base units. */
export const MIN_QUANTITY_BASE = 1 / QUANTITY_SCALE;

/**
 * Accumulator guard for the replay fold and every other JS-side quantity sum.
 *
 * The replay fold is the migration's own oracle: `foldLedgerInTx` accumulates
 * magnitudes into a JS `Map<string, number>` and `replayInTx` compares the
 * total to the projected row with `!==`. Both sides scale together so the
 * comparison stays valid, but the accumulator's headroom shrinks by 1000×.
 * Past 2⁵³ the fold silently rounds, the compare fails, and reconciliation
 * quarantines stock that is perfectly fine — the oracle crying wolf. This
 * turns that into a loud, named failure instead.
 */
export function assertExactQuantity(value: number, context: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `Quantity arithmetic left the exact integer range (${context}): ${value}. ` +
        `Milli-unit quantities are exact only to ${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  return value;
}
