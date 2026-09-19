/**
 * Handling units — the catch-weight vocabulary and its one weight gate
 * (Story 10.3).
 *
 * A catch-weight SKU is handled BY UNIT and priced BY WEIGHT: a case of beef
 * is **one** case weighing 18.4 kg, and the next weighs 18.6 kg. The weight is
 * captured once, at receipt, and carried unchanged to pack and invoice.
 *
 * **Catch weight is never a quantity.** Nothing in this file imports the
 * milli-unit quantity primitive, and no value it produces ever reaches
 * `quantity_delta`, a projection, or the Valkey ATP path — an architecture
 * test pins both. A case of beef is quantity `1`, weight `18400 g`, and the
 * two numbers never meet. Weight is plain **integer grams**:
 * it has no reservation, so the 2⁵³ Lua/JS exact-integer ceiling that forced
 * quantity into scaled integers does not bind it, and a scale reports whole
 * grams anyway.
 *
 * One resolution point, deliberately: the status tuple, the weight ceiling and
 * the weight refusal all live here, so inbound, outbound, inventory and the
 * migration are reading one list rather than four copies of one.
 */

import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * The handling unit's lifecycle, as a controlled vocabulary (the repo's
 * uniform three-layer pattern: this tuple + a DB CHECK in the migration + an
 * e2e test pinning the two together).
 *
 * - `active` — live stock, the only status pack admits
 * - `pending_approval` — received beyond the PO's open quantity; the row
 *   EXISTS (the physical case is on the dock) but is not yet live stock
 * - `rejected` — the over-receipt was refused, or the unit was named in a
 *   write-off adjustment. Terminal
 * - `packed` — consumed into an order line at the bench. Terminal
 *
 * The set is an ALLOW-LIST everywhere it is read: a status arm nobody thought
 * about must be refused, never fall through to "close enough to active".
 */
export const HANDLING_UNIT_STATUSES = [
  'active',
  'pending_approval',
  'rejected',
  'packed',
] as const;

export type HandlingUnitStatus = (typeof HANDLING_UNIT_STATUSES)[number];

/**
 * The upper bound on one handling unit's captured weight, in grams — 1,000 kg.
 *
 * It is the same number `pack.command.ts`'s `MAX_WEIGHT_GRAMS` uses for a
 * parcel, and for the same reason: past it the bench is reporting grams as
 * milligrams, or the scale is unplugged. A palletised handling unit genuinely
 * reaches several hundred kilograms, so the bound is a fat-finger guard, not a
 * domain limit. The two constants are deliberately NOT shared — a parcel's
 * gross shipping weight and a handling unit's captured net weight are
 * different concepts at different granularities, and coupling their ceilings
 * would make a change to one silently move the other.
 */
export const MAX_HANDLING_UNIT_WEIGHT_GRAMS = 1_000_000;

/**
 * The ceiling on how many handling units ONE request may name, across every
 * line of it.
 *
 * Each id costs a locked row, a conditional write and a place in a hashed
 * reference doc, so an unbounded list is unbounded work an ordinary caller
 * chooses. The bound is request-WIDE rather than per line: a cap that only
 * watched one line would be defeated by five hundred lines naming five
 * hundred units each, which is the shape `MAX_SCAN_QUANTITY`'s aggregate cap
 * was added for in the same command.
 *
 * A thousand cases is a full truck. The refusal is a typed 400 at the command
 * tier — the DTO caps publish the same number, so the two gates cannot
 * disagree, and a non-HTTP caller meets the rule too.
 */
export const MAX_HANDLING_UNITS_PER_REQUEST = 1_000;

/**
 * The one write-edge gate for a captured weight — the `assertWeight`
 * (`pack.command.ts`) shape, mirrored.
 *
 * A weight is a positive INTEGER number of grams within the ceiling. A
 * fraction is refused rather than rounded, for the same reason a too-precise
 * quantity is: a gram the operator did not enter is a gram nobody agreed to,
 * and this value decides what a customer is invoiced.
 *
 * It is a pure SHAPE check — it needs no database row — so it belongs ABOVE
 * the transaction in every command that calls it (the three tiers,
 * `IMPLEMENTATION-GUIDE.md` §1).
 */
export function assertCatchWeightGrams(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_HANDLING_UNIT_WEIGHT_GRAMS
  ) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${field} is not a recordable catch weight`,
      `${field} must be a positive whole number of grams, at most ${MAX_HANDLING_UNIT_WEIGHT_GRAMS} ` +
        `(1,000 kg) — got ${String(value)}. A catch weight is grams, never a quantity and never a fraction of one.`,
    );
  }
  return value;
}
