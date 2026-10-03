import type { Uom } from '../catalog/uom';

/**
 * The catalog UoM → GST Unit Quantity Code (UQC) mapping (story 8-2a), the
 * unit column of GSTR-1 Table 12 (the HSN summary).
 *
 * **No scaling, ever.** A UQC is chosen only where it means the SAME unit as
 * the catalog's; a quantity is never multiplied or divided to fit one
 * (`mm` → `OTH`, never `CMS` ÷ 10). Where no UQC means the same thing the
 * unit maps to `OTH` ("others") — the one lossy bucket, which is why the
 * HSN summary records an `OTH` row's distinct source units and the screen
 * flags a mix.
 *
 * Typed `Record<Uom, Uqc>`, so a unit added to `UOMS` (catalog/uom.ts)
 * without a line here is a COMPILE error; `test/invoicing-hsn.spec.ts` also
 * asserts the completeness over the runtime tuple. The add-a-unit checklist
 * in `uom.ts` names this file.
 *
 * The UQC spellings and their GSTN descriptions (`KGS-KILOGRAMS`) are the
 * CSV's concern and live on the web (`wms-fe/src/lib/hsn-summary.ts`).
 */

export const UQCS = [
  'NOS',
  'BOX',
  'CTN',
  'PAC',
  'BAG',
  'DRM',
  'ROL',
  'BDL',
  'PRS',
  'DOZ',
  'BTL',
  'CAN',
  'TUB',
  'SET',
  'GMS',
  'KGS',
  'TON',
  'MLT',
  'LTR',
  'KLR',
  'CMS',
  'MTR',
  'SQM',
  'SQF',
  'OTH',
] as const;

export type Uqc = (typeof UQCS)[number];

/** The 35-unit table (spec 8-2a, "UoM → UQC"). */
export const UOM_TO_UQC: Readonly<Record<Uom, Uqc>> = {
  // Count and packaging.
  each: 'NOS',
  box: 'BOX',
  case: 'OTH',
  carton: 'CTN',
  pack: 'PAC',
  pallet: 'OTH',
  bag: 'BAG',
  drum: 'DRM',
  roll: 'ROL',
  crate: 'OTH',
  bundle: 'BDL',
  pair: 'PRS',
  dozen: 'DOZ',
  // Counted containers.
  bottle: 'BTL',
  can: 'CAN',
  tin: 'OTH',
  jar: 'OTH',
  tube: 'TUB',
  tray: 'OTH',
  sheet: 'OTH',
  bar: 'OTH',
  cylinder: 'OTH',
  keg: 'OTH',
  set: 'SET',
  // Mass.
  g: 'GMS',
  kg: 'KGS',
  tonne: 'TON',
  // Volume.
  ml: 'MLT',
  litre: 'LTR',
  kl: 'KLR',
  // Length.
  mm: 'OTH',
  cm: 'CMS',
  m: 'MTR',
  // Area.
  sqm: 'SQM',
  sqft: 'SQF',
};

/**
 * A null-prototype lookup: `uom` is a stored snapshot string, and on an
 * ordinary object `'constructor'` would resolve to a Function (the
 * `UOM_ALIASES` gotcha in catalog.md).
 */
const LOOKUP: Readonly<Record<string, Uqc>> = Object.assign(Object.create(null) as Record<string, Uqc>, UOM_TO_UQC);

/**
 * The UQC for a stored line unit. `exact` is true when the UQC names the
 * same unit; an `OTH` mapping, and any unit outside today's vocabulary (a
 * frozen snapshot can outlive a vocabulary change), is `OTH` with
 * `exact: false`. Never scales a quantity — there is nothing to scale with.
 */
export function uqcFor(uom: string): { readonly uqc: Uqc; readonly exact: boolean } {
  const uqc = LOOKUP[uom] ?? 'OTH';
  return { uqc, exact: uqc !== 'OTH' };
}
