/**
 * The unit-of-measure vocabulary (story 10.2).
 *
 * `skus.uom` used to be free `text`: `pcs`, `PCS` and `pieces` could coexist
 * as three different units, and story 10.1 had nothing to ask how precise a
 * given unit may be — so it rounded a too-fine value at the edge and guarded
 * the serial rule with a hand-maintained allowlist of "discrete" spellings.
 * This file replaces both. A UoM is now a **closed vocabulary**, and each
 * canonical unit declares the decimal precision it is allowed to express.
 *
 * **Two lists, not one.** CANONICAL units are what the system stores and what
 * declares a precision; ALIASES are what an import file may say. `kgs`,
 * `kilogram`, `kilo` and `"Kg."` all resolve to `kg`; `pcs`, `pc`, `piece`,
 * `pieces`, `nos`, `unit` and `item` all resolve to `each`. A closed
 * vocabulary exists to stop three spellings becoming three units, and an alias
 * map solves that without listing every spelling as its own unit — generous
 * spelling surface, narrow storage surface. This is what preserves story
 * 10.1's normalization tolerance by design rather than by accident.
 *
 * **Precision is a property of the UNIT, not of the SKU.** A kilogram is
 * three-decimal everywhere; it does not depend on what is measured in it.
 * That is what lets the device validate a scan offline from the unit its
 * cached catalog snapshot already carries.
 *
 * **No imperial units, deliberately.** `lb`, `oz`, `gallon`, `ft` and `inch`
 * are only useful to a tenant who also CONVERTS (stocks in kg, quotes in lb),
 * and conversions do not exist yet. Shipping them now would deliver the half
 * that does not work; they arrive with fractional conversions as one later
 * story. The asymmetry favours breadth otherwise — a missing unit is a
 * blocked onboarding needing a migration and a deploy, an extra unit is one
 * line here and a declared precision.
 *
 * **The repo's own enum precedent, followed exactly** (ten of them: `ORDER_STATUSES`,
 * `SHORT_PICK_REASON_CODES`, `BLIND_REASON_CODES`, `BIN_TYPES`, …): an
 * `as const` tuple beside the command that owns it, a hand-written
 * `CHECK ("uom" IN (…))` in a migration, `@IsIn` + `@ApiProperty({ enum })`
 * over the same tuple, and an e2e test pinning the TS list and the DB
 * constraint together.
 *
 * **Why a CHECK and not a `pgEnum`.** This schema does have one Postgres enum
 * (`user_role`, `schema.ts:57`) — but a vocabulary that is expected to GROW is
 * the wrong thing to put in a type. Extending an enum means `ALTER TYPE …  ADD
 * VALUE`, which carries its own transaction rules and cannot be reordered or
 * removed; a CHECK is dropped and re-added with a widened set, which is what
 * the other ten vocabularies in this repo already do (0019, 0022, 0023, 0024).
 * The four coarse roles are a closed set by design; units are not. And there
 * is no lookup table anywhere in this schema — a row with no columns but its
 * own name, plus an FK, plus a join on every read, to express a constant.
 */

import { QUANTITY_DECIMALS } from '../../shared/primitives/quantity';

/**
 * The canonical units, in family order. **This tuple and the
 * `skus_uom_check` / `uom_conversions_uom_check` CHECK constraints in
 * `drizzle/0027_uom_vocabulary.sql` are one list**; the vocabulary e2e suite
 * fails if they drift apart. A new unit is added by a migration that drops and
 * re-adds the CHECK (the 0023/0024 precedent) and a line here.
 */
export const UOMS = [
  // Count and packaging — whole, indivisible things. 0 decimal places.
  'each',
  'box',
  'case',
  'carton',
  'pack',
  'pallet',
  'bag',
  'drum',
  'roll',
  'crate',
  'bundle',
  'pair',
  'dozen',
  // Containers that are themselves counted whole. A keg of beer is ONE keg;
  // what is inside it is a separate concept (catch weight, story 10-3) and is
  // never modelled as a quantity.
  'bottle',
  'can',
  'tin',
  'jar',
  'tube',
  'tray',
  'sheet',
  'bar',
  'cylinder',
  'keg',
  'set',
  // Mass.
  'g',
  'kg',
  'tonne',
  // Volume.
  'ml',
  'litre',
  'kl',
  // Length.
  'mm',
  'cm',
  'm',
  // Area.
  'sqm',
  'sqft',
] as const;

export type Uom = (typeof UOMS)[number];

/**
 * The decimal places each unit may express. A quantity finer than this is a
 * typed refusal naming the unit, the precision and the value — never a silent
 * rounding (that was 10.1's stopgap, and this story is what removes it).
 *
 * Nothing here may exceed `QUANTITY_DECIMALS`: the representation is milli-
 * units, so a 4-decimal unit would declare a precision the column cannot hold.
 * `assertVocabularyIsRepresentable` below makes that a load error, not a
 * mystery at the edge.
 */
export const UOM_PRECISION: Readonly<Record<Uom, number>> = {
  each: 0,
  box: 0,
  case: 0,
  carton: 0,
  pack: 0,
  pallet: 0,
  bag: 0,
  drum: 0,
  roll: 0,
  crate: 0,
  bundle: 0,
  pair: 0,
  dozen: 0,
  bottle: 0,
  can: 0,
  tin: 0,
  jar: 0,
  tube: 0,
  tray: 0,
  sheet: 0,
  bar: 0,
  cylinder: 0,
  keg: 0,
  set: 0,
  g: 3,
  kg: 3,
  tonne: 3,
  ml: 3,
  litre: 3,
  kl: 3,
  mm: 3,
  cm: 3,
  m: 3,
  sqm: 3,
  sqft: 3,
};

/**
 * What an import file is allowed to SAY for each canonical unit — plurals,
 * abbreviations, and the full spellings a spreadsheet actually contains.
 * Compared after normalization (trimmed, lower-cased, internal whitespace
 * collapsed, trailing spreadsheet punctuation removed), so `"Kg."`, `" KG "`
 * and `kgs` all land on the same key.
 *
 * Only genuine synonyms belong here. A `bottle` is not a `box`, and mapping it
 * to one would quietly mis-file stock; an unrecognized unit is a readable
 * row-level refusal naming it, which an operator can act on.
 */
export const UOM_ALIASES: Readonly<Record<string, Uom>> = Object.assign(
  // `Object.create(null)`, NOT `{}`. A `uom` cell is attacker- (or
  // spreadsheet-) controlled text, and on an ordinary object literal
  // `aliases['constructor']` answers a Function, `aliases['toString']` a
  // method and `aliases['__proto__']` an object — every one of them truthy, so
  // `?? null` never fires, the unknown-unit refusal is skipped, and the
  // importer writes a "unit" that is a function. Only own keys may resolve.
  Object.create(null) as Record<string, Uom>,
  {
  // each
  ea: 'each',
  eaches: 'each',
  unit: 'each',
  units: 'each',
  pc: 'each',
  pcs: 'each',
  piece: 'each',
  pieces: 'each',
  no: 'each',
  nos: 'each',
  number: 'each',
  numbers: 'each',
  item: 'each',
  items: 'each',
  qty: 'each',
  // packaging
  boxes: 'box',
  bx: 'box',
  cases: 'case',
  cs: 'case',
  cartons: 'carton',
  ctn: 'carton',
  ctns: 'carton',
  packs: 'pack',
  packet: 'pack',
  packets: 'pack',
  pkt: 'pack',
  pkts: 'pack',
  pk: 'pack',
  pallets: 'pallet',
  plt: 'pallet',
  plts: 'pallet',
  bags: 'bag',
  sack: 'bag',
  sacks: 'bag',
  drums: 'drum',
  rolls: 'roll',
  crates: 'crate',
  bundles: 'bundle',
  bdl: 'bundle',
  bdls: 'bundle',
  pairs: 'pair',
  pr: 'pair',
  prs: 'pair',
  dozens: 'dozen',
  dz: 'dozen',
  doz: 'dozen',
  // mass
  gram: 'g',
  grams: 'g',
  gm: 'g',
  gms: 'g',
  gramme: 'g',
  grammes: 'g',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  kilogramme: 'kg',
  kilogrammes: 'kg',
  tonnes: 'tonne',
  ton: 'tonne',
  tons: 'tonne',
  mt: 'tonne',
  t: 'tonne',
  'metric ton': 'tonne',
  'metric tonne': 'tonne',
  // volume
  milliliter: 'ml',
  millilitre: 'ml',
  milliliters: 'ml',
  millilitres: 'ml',
  mls: 'ml',
  cc: 'ml',
  l: 'litre',
  lt: 'litre',
  ltr: 'litre',
  ltrs: 'litre',
  liter: 'litre',
  liters: 'litre',
  litres: 'litre',
  kilolitre: 'kl',
  kilolitres: 'kl',
  kiloliter: 'kl',
  kiloliters: 'kl',
  kls: 'kl',
  // length
  millimeter: 'mm',
  millimeters: 'mm',
  millimetre: 'mm',
  millimetres: 'mm',
  mms: 'mm',
  centimeter: 'cm',
  centimeters: 'cm',
  centimetre: 'cm',
  centimetres: 'cm',
  cms: 'cm',
  meter: 'm',
  meters: 'm',
  metre: 'm',
  metres: 'm',
  mtr: 'm',
  mtrs: 'm',
  // area
  'sq m': 'sqm',
  'sq.m': 'sqm',
  sqmt: 'sqm',
  sqmtr: 'sqm',
  m2: 'sqm',
  'square meter': 'sqm',
  'square metre': 'sqm',
  'sq ft': 'sqft',
  'sq.ft': 'sqft',
  sqfeet: 'sqft',
  ft2: 'sqft',
  'square foot': 'sqft',
  'square feet': 'sqft',
  // the counted containers
  bottles: 'bottle',
  cans: 'can',
  tins: 'tin',
  jars: 'jar',
  tubes: 'tube',
  trays: 'tray',
  sheets: 'sheet',
  bars: 'bar',
  cylinders: 'cylinder',
  kegs: 'keg',
  sets: 'set',
  },
);

const CANONICAL: ReadonlySet<string> = new Set<string>(UOMS);

/**
 * The 0-decimal units, DERIVED from the precision table rather than listed a
 * second time. `drizzle/0027_uom_vocabulary.sql` needs the same set to align
 * stored quantities, and SQL cannot import TypeScript — so the migration
 * declares it once in a temp table and the vocabulary e2e suite pins that
 * declaration against this. Adding a 0-dp unit therefore cannot silently miss
 * the migration's rounding statements.
 */
export const WHOLE_UNIT_UOMS: readonly Uom[] = UOMS.filter((uom) => UOM_PRECISION[uom] === 0);

/**
 * Spreadsheet noise is ordinary: `"Kg."`, `"pcs,"`, `"each;"`, `" KG "`,
 * `"sq  ft"`. A unit that fails to normalize is a unit that silently misses
 * its rule, so the tolerance is part of the vocabulary rather than a caller's
 * responsibility.
 */
function normalizeUomInput(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/[.,;:\s]+$/u, '');
}

/**
 * The raw spelling → the canonical unit, or `null` when the vocabulary does
 * not know it. This is the ONE resolution point: catalog import, the DB
 * migration's alias map and the e2e vocabulary pin all describe the same
 * mapping.
 */
export function resolveUom(raw: string): Uom | null {
  const normalized = normalizeUomInput(raw);
  if (CANONICAL.has(normalized)) {
    return normalized as Uom;
  }
  return UOM_ALIASES[normalized] ?? null;
}

/**
 * The declared precision of a STORED unit.
 *
 * **Fail closed, as the allowlist it replaces did.** Every stored `uom` is
 * canonical — the `skus_uom_check` CHECK is the backstop and the import is the
 * only creator — so the fallback is unreachable in practice. If it is ever
 * reached, the unit is treated as measured to the finest precision the
 * representation allows, which refuses a serial-tracked SKU on it rather than
 * waving a unit nobody enumerated past the rule.
 */
export function uomPrecision(uom: string): number {
  const resolved = resolveUom(uom);
  return resolved === null ? QUANTITY_DECIMALS : UOM_PRECISION[resolved];
}

/**
 * True when the unit counts WHOLE items and can therefore carry serials.
 *
 * This is story 10.1's `isDiscreteUom` re-expressed as a lookup against the
 * vocabulary rather than a hand-maintained list of spellings — which is the
 * whole point: a legitimate discrete unit nobody remembered to enumerate no
 * longer gets a false refusal, because the vocabulary is the list.
 */
function isWholeUnitUom(uom: string): boolean {
  return uomPrecision(uom) === 0;
}

/** The complement, kept under its 10.1 name for the two refusal sites. */
export function isFractionalUom(uom: string): boolean {
  return !isWholeUnitUom(uom);
}

const PRECISION_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'] as const;

/** `3` → `three`, so a refusal reads as a sentence rather than a field dump. */
function spellPrecision(precision: number): string {
  return PRECISION_WORDS[precision] ?? String(precision);
}

/**
 * The serial-tracking × fractional-UoM refusal (story 10.1, kept verbatim in
 * shape): it names BOTH the UoM and the rule, so an operator who reads it can
 * act on it without reading the code. The precision is now looked up rather
 * than assumed.
 */
export function serialTrackedFractionalUomDetail(uom: string): string {
  return (
    `Base UoM "${uom}" is measured to ${spellPrecision(uomPrecision(uom))} decimal places, and a serial-tracked SKU ` +
    'moves exactly one whole unit per serial — a fraction of a serialized unit does not exist. ' +
    'Give the SKU a whole-unit UoM (for example "each"), or leave it untracked by serial.'
  );
}

/**
 * The sample an unknown-unit refusal names — one unit PER FAMILY, not the
 * first eight of the tuple. The tuple is grouped by family, so a prefix slice
 * lists eight kinds of packaging and tells an operator whose cell says
 * `pounds` nothing at all about how to spell a mass. This is the answer to
 * "what sort of thing goes here?", and the full list is in the OpenAPI
 * document's `uom` enum.
 */
const SAMPLED_UOMS: readonly Uom[] = ['each', 'box', 'pallet', 'g', 'kg', 'litre', 'm', 'sqm'];

/**
 * The unknown-unit refusal. It names the offending spelling and a sample of
 * the vocabulary — an operator fixing a CSV cell needs to know what to write,
 * and dumping every unit into a problem detail helps nobody.
 */
export function unknownUomDetail(field: string, raw: string): string {
  // Clamped: a vocabulary smaller than the sample would otherwise advertise a
  // negative number of further units.
  const remaining = Math.max(0, UOMS.length - SAMPLED_UOMS.length);
  return (
    `${field} "${raw}" is not a unit this system knows. Units come from a closed vocabulary — ` +
    `${SAMPLED_UOMS.join(', ')} and ${remaining} more, published in full as the "uom" enum of the ` +
    'OpenAPI document (common spellings such as "pcs", "kgs" and "Kg." resolve on their own). ' +
    'Correct the unit, or ask for it to be added to the vocabulary.'
  );
}

/**
 * A load-time guard, not a runtime one: a unit declaring more decimals than
 * the milli-unit representation can hold would accept a value the column
 * silently truncates. The vocabulary is a constant, so this is a constant
 * check — it fires in the first test that imports this module, never in
 * production traffic.
 */
/**
 * Every spelling story 10.1's `DISCRETE_UOMS` allowlist blessed, frozen here
 * as evidence rather than as a list to maintain.
 *
 * A closed vocabulary that cannot express a unit the previous story accepted
 * is not a tightening, it is a data loss: the stored row fails `skus_uom_check`
 * and takes the whole migration down with it. This set is asserted resolvable
 * at load, so dropping a unit from the canonical tuple — or an alias that was
 * the only route to one — fails in the first test that imports this module
 * rather than in a deploy.
 */
const STORY_10_1_DISCRETE_UOMS: readonly string[] = [
  'each', 'ea', 'unit', 'units', 'pc', 'pcs', 'piece', 'pieces', 'no', 'nos', 'number',
  'item', 'items', 'box', 'boxes', 'case', 'cases', 'carton', 'cartons', 'pack', 'packs',
  'packet', 'packets', 'pallet', 'pallets', 'bag', 'bags', 'bottle', 'bottles', 'can',
  'cans', 'drum', 'drums', 'roll', 'rolls', 'bundle', 'bundles', 'set', 'sets', 'pair',
  'pairs', 'dozen', 'tray', 'trays', 'crate', 'crates', 'sack', 'sacks', 'tin', 'tins',
  'jar', 'jars', 'tube', 'tubes', 'sheet', 'sheets', 'bar', 'bars', 'cylinder',
  'cylinders', 'keg', 'kegs',
];

function assertVocabularyIsRepresentable(): void {
  for (const uom of UOMS) {
    const precision = UOM_PRECISION[uom];
    if (!Number.isInteger(precision) || precision < 0 || precision > QUANTITY_DECIMALS) {
      throw new Error(
        `UoM "${uom}" declares ${precision} decimal places; the milli-unit representation holds at most ${QUANTITY_DECIMALS}.`,
      );
    }
  }
  for (const [alias, canonical] of Object.entries(UOM_ALIASES)) {
    if (CANONICAL.has(alias)) {
      throw new Error(`Alias "${alias}" is also a canonical unit — one spelling, two meanings.`);
    }
    if (!CANONICAL.has(canonical)) {
      throw new Error(`Alias "${alias}" resolves to "${canonical}", which is not a canonical unit.`);
    }
    if (normalizeUomInput(alias) !== alias) {
      throw new Error(`Alias "${alias}" is not in normalized form — it can never be matched.`);
    }
  }
  for (const uom of STORY_10_1_DISCRETE_UOMS) {
    const resolved = resolveUom(uom);
    if (resolved === null) {
      throw new Error(
        `Unit "${uom}" was a valid whole-unit UoM under story 10.1 and no longer resolves — ` +
          'any SKU stored with it would fail skus_uom_check and abort migration 0027.',
      );
    }
    if (UOM_PRECISION[resolved] !== 0) {
      throw new Error(
        `Unit "${uom}" counted whole units under story 10.1 but now resolves to "${resolved}", ` +
          `which declares ${UOM_PRECISION[resolved]} decimal places.`,
      );
    }
  }
}

assertVocabularyIsRepresentable();
