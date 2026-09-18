/**
 * Quantity primitive (AD-9, amended by story 10.1): every quantity in the
 * domain is a **scaled integer in milli-units** — the SKU's base unit of
 * measure × 10³. Nothing decimal exists inside the domain: conversion to and
 * from the operator-facing decimal happens at exactly two places, through
 * `toMilli`/`fromMilli` in this file.
 *
 * **Where the inbound conversion lives, and why it moved** (story 10.2). It
 * used to run in the controllers, while the facade argument was being built.
 * Once a too-fine value became a REFUSAL rather than a rounding, that position
 * put the refusal in front of the idempotency replay lookup — so a device op
 * that had already committed under looser rules would answer `400` on replay
 * instead of re-serving its original `201`. Conversion therefore happens
 * inside each command, behind its replay lookup and after it has read the
 * SKU's unit, through `assertRecordableQuantity` below. Outbound conversion
 * (`fromMilli`) is unchanged and still happens wherever a read model is built.
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

import { ProblemException } from '../problem-details/problem.exception';

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
// Story 10.2 changed what this sentence says, and it had to: the old wording
// ("is rounded to 3 decimal places") described the stopgap, and once the unit
// declares its own precision that sentence is a lie published to every
// external consumer. The description is prose, not an identifier — story
// numbers stay out of it, because the people who read it cannot resolve them.
export const QUANTITY_FIELD_DESCRIPTION =
  'A quantity in the SKU\'s base UoM, at the decimal precision that unit ' +
  'declares (each = 0 places, kg = 3). A value finer than its unit allows is ' +
  'refused, naming the unit and its precision — never silently rounded.';

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
 * the domain's milli-unit integer. This is ARITHMETIC only — the rule about
 * what a unit is allowed to express lives in `assertRecordableQuantity`, which
 * refuses a too-fine value rather than letting this function round it away
 * (story 10.2). Call it, not this, at a write edge.
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
 * Story 10.1 rounded a value that was merely too precise and refused only one
 * that would vanish; story 10.2 refuses both, so this predicate is now a
 * backstop inside `assertRecordableQuantity` rather than a gate of its own. It
 * is kept, and kept named, because the loss it describes is specific: a pick
 * of 0.0004 recorded as 0 is not a rounded pick, it is an empty-bin short pick
 * the operator never reported, and a stock adjustment of 0.0004 becomes a
 * zero-delta ledger event.
 */
function scalesToZero(value: number): boolean {
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

/**
 * How many decimal places a number actually carries, read from its canonical
 * decimal string rather than from arithmetic.
 *
 * **Why the string and not `value * 10 ** precision % 1`.** That product is
 * not exact, and the error falls on the honest side: `1.005 * 1000` is
 * `1004.9999999999999`, so a weight a scale prints every day would be refused
 * as "finer than kilograms allow" — and it is not a rare corner, it is
 * thousands of the values in any three-decimal range. A tolerance does not
 * rescue it either, because the absolute error scales with the magnitude: the
 * epsilon that forgives 1.005 is the wrong epsilon at 9 × 10¹¹.
 *
 * `String(n)` gives the SHORTEST decimal that round-trips to the same double —
 * which, for a value that arrived as JSON, is the literal the client wrote.
 * That is exactly the question being asked: how many decimal places did the
 * operator type?
 */
export function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.POSITIVE_INFINITY;
  }
  const text = String(Math.abs(value));
  const exponentAt = text.indexOf('e');
  if (exponentAt === -1) {
    const dot = text.indexOf('.');
    return dot === -1 ? 0 : text.length - dot - 1;
  }
  // Exponential form (`1e-7`, `1.5e-7`): the mantissa's own places, shifted.
  const mantissa = text.slice(0, exponentAt);
  const exponent = Number(text.slice(exponentAt + 1));
  const dot = mantissa.indexOf('.');
  const mantissaPlaces = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, mantissaPlaces - exponent);
}

/** True when `value` fits within a unit declaring `precision` decimal places. */
export function isAtPrecision(value: number, precision: number): boolean {
  return decimalPlaces(value) <= precision;
}

/**
 * **The one write-edge gate for a quantity** (story 10.2), and the reason the
 * two hand-copied `assertRecordable` helpers in `inventory.controller.ts` and
 * `outbound.controller.ts` no longer exist: a rule stated twice is a rule that
 * drifts, and this one now has nine call sites rather than two.
 *
 * It refuses, in this order, and returns the milli-unit integer otherwise:
 *
 *  1. a value beyond the exact-integer range (an overflow is a refusal at the
 *     boundary, never a silent wrap downstream);
 *  2. a value FINER than its unit declares — the story's rule. It names the
 *     field, the unit, the declared precision and the offending value, the
 *     house shape `serialTrackedFractionalUomDetail` established;
 *  3. a non-zero value that would scale to nothing. Story 10.1's refusal,
 *     kept as a backstop and now structurally unreachable: the finest unit in
 *     the vocabulary declares `QUANTITY_DECIMALS` places, and a value at that
 *     precision is at least one milli-unit. It stays because "unreachable"
 *     is a property of today's vocabulary, not of this function.
 *
 * **Where it must be called from.** Behind the command's idempotency replay
 * lookup, never at the controller edge. An op that committed once replays its
 * stored snapshot forever, whatever the rules say now — a device that queued a
 * scan under looser rules and replays it after they tighten must get its
 * original `201`, not a `400`. Converting at the edge (where `toMilli` used to
 * run) would have put this refusal in front of the replay.
 */
export function assertRecordableQuantity(
  value: number,
  field: string,
  uom: string,
  precision: number,
): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_QUANTITY_BASE) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${field} is outside the exact quantity range`,
      `${field} must be a finite quantity of at most ${MAX_QUANTITY_BASE} in the SKU's base UoM (got ${String(value)}).`,
    );
  }
  if (!isAtPrecision(value, precision)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${field} is finer than its unit allows`,
      precisionRefusalDetail(field, value, uom, precision),
    );
  }
  if (scalesToZero(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${field} is finer than the smallest recordable quantity`,
      `${field} must be at least ${MIN_QUANTITY_BASE} in the SKU's base UoM (got ${value}) — ` +
        'a smaller value would be recorded as zero, which means something else entirely.',
    );
  }
  return toMilli(value);
}

/**
 * The precision refusal's text. Two sentences, because the two cases are
 * genuinely different problems: a 0-dp unit cannot hold a fraction AT ALL
 * (2.5 `each` is not a rounding question, it is a category error), while a
 * 3-dp unit can hold fractions but not this one.
 */
export function precisionRefusalDetail(
  field: string,
  value: number,
  uom: string,
  precision: number,
): string {
  if (precision === 0) {
    return (
      `${field} must be a whole number: base UoM "${uom}" declares 0 decimal places, ` +
      `so ${value} is not a quantity it can express. Record whole units, or measure ` +
      'this SKU in a unit that allows fractions.'
    );
  }
  return (
    `${field} must have at most ${precision} decimal place(s): base UoM "${uom}" declares ` +
    `${precision}, and ${value} carries ${decimalPlaces(value)}. It is refused rather than ` +
    'rounded — a quantity the operator did not enter is a quantity nobody agreed to.'
  );
}
