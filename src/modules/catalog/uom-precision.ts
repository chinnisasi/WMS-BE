/**
 * The serial-tracking × fractional-UoM rule (story 10.1).
 *
 * A serialized unit is discrete **by definition**: the system writes one
 * ledger event per serial and four separate call sites compare a movement's
 * unit count against `serials.length`, which is an array length and can never
 * be 18.4. Rather than teach those four sites to convert, the contradiction is
 * refused once, where it is created — at catalog entry.
 *
 * This is deliberately NOT the UoM vocabulary. Story 10.2 owns the closed
 * unit list, the per-UoM declared precision and the precision refusal on
 * entered values; when it lands, this set is replaced by a lookup against that
 * table and this file goes away.
 *
 * **Why an allowlist of DISCRETE units and not a denylist of measured ones.**
 * `skus.uom` is free text today, so any list over it is a list with a default,
 * and the only question is which way the default fails. A denylist fails OPEN:
 * `lb`, `oz`, `mg`, `quintal`, `gallon`, `sqft`, `cbm` and ordinary
 * spreadsheet spellings like `"Kg."` are all units nobody enumerated, so a
 * serial-tracked SKU measured in pounds would sail straight past the rule this
 * module exists to enforce — and land as four call sites that cannot convert
 * it. An allowlist fails CLOSED: an unrecognized unit is treated as measured,
 * and the worst case is a readable 400 naming the unit and the rule, which an
 * operator can act on by renaming the unit or dropping serial tracking. A
 * false refusal is a sentence; a false accept is corrupt stock.
 */

/**
 * Base UoMs that count WHOLE, indivisible items, and are therefore the only
 * ones a serial-tracked SKU may use. Compared after normalization (trimmed,
 * lower-cased, trailing punctuation and pluralizing dots removed).
 *
 * Everything not in this list — every mass, volume, length, area and weight
 * unit, and anything unrecognized — is treated as measured.
 */
const DISCRETE_UOMS: ReadonlySet<string> = new Set([
  'each',
  'ea',
  'unit',
  'units',
  'pc',
  'pcs',
  'piece',
  'pieces',
  'no',
  'nos',
  'number',
  'item',
  'items',
  // Packaging that is itself counted whole. A case of beef is ONE case; its
  // catch weight is a separate concept entirely (AD-22, story 10-3) and is
  // never modelled as a quantity.
  'box',
  'boxes',
  'case',
  'cases',
  'carton',
  'cartons',
  'pack',
  'packs',
  'packet',
  'packets',
  'pallet',
  'pallets',
  'bag',
  'bags',
  'bottle',
  'bottles',
  'can',
  'cans',
  'drum',
  'drums',
  'roll',
  'rolls',
  'bundle',
  'bundles',
  'set',
  'sets',
  'pair',
  'pairs',
  'dozen',
  'tray',
  'trays',
  'crate',
  'crates',
  'sack',
  'sacks',
  'tin',
  'tins',
  'jar',
  'jars',
  'tube',
  'tubes',
  'sheet',
  'sheets',
  'bar',
  'bars',
  'cylinder',
  'cylinders',
  'keg',
  'kegs',
]);

/**
 * Trailing punctuation is ordinary spreadsheet noise — `"Kg."`, `"pcs,"`,
 * `"each;"` — and a unit that fails to normalize is a unit that silently
 * misses its rule.
 */
function normalizeUom(uom: string): string {
  return uom.trim().toLowerCase().replace(/[.,;:\s]+$/u, '');
}

/** True when the UoM counts whole items and can therefore carry serials. */
export function isDiscreteUom(uom: string): boolean {
  return DISCRETE_UOMS.has(normalizeUom(uom));
}

/**
 * True when the UoM expresses fractions rather than whole units — which, by
 * the fail-closed rule above, is every unit not known to be discrete.
 */
export function isFractionalUom(uom: string): boolean {
  return !isDiscreteUom(uom);
}

/**
 * The refusal text, naming BOTH the UoM and the rule — an operator who reads
 * it must be able to act on it without reading the code.
 */
export function serialTrackedFractionalUomDetail(uom: string): string {
  return (
    `Base UoM "${uom}" is measured to three decimal places, and a serial-tracked SKU ` +
    'moves exactly one whole unit per serial — a fraction of a serialized unit does not exist. ' +
    'Give the SKU a whole-unit UoM (for example "each"), or leave it untracked by serial.'
  );
}
