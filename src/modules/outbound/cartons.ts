/**
 * Story 4-5a — the pure carton rules: the vocabularies `order_packs` carries,
 * the shape of a pack's `cartons[]` (A6, A32), its normal form for the
 * idempotency hash, the per-carton quantity rules (A31) and the per-SKU
 * contents comparison a re-carton runs (A8 step 8).
 *
 * Pure: no schema, no service, no `@Injectable` (guide §4 — a vocabulary file
 * every command can import by value without a cycle). `pack.command.ts` and
 * `carton.command.ts` both import it; it imports only `shared/` and types.
 *
 * Quantities here are MILLI-units (story 10.2), exactly as `aggregateScan`
 * produces them; a raw line's `qty` arrives in BASE units and is scaled here.
 */

import { UUID_RE } from '../../shared/primitives/ids';
import {
  MAX_QUANTITY_MILLI,
  QUANTITY_SCALE,
  assertRecordableQuantity,
  fromMilli,
  toMilli,
} from '../../shared/primitives/quantity';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { MAX_HANDLING_UNITS_PER_REQUEST } from '../catalog/handling-unit';
import { uomPrecision } from '../catalog/uom';

/** `order_packs.status` — mirrored by `order_packs_status_check` (0117). */
export const ORDER_PACK_STATUSES = ['live', 'superseded', 'cancelled'] as const;
export type OrderPackStatus = (typeof ORDER_PACK_STATUSES)[number];

/** `order_packs.source` — mirrored by `order_packs_source_check` (0117). */
export const ORDER_PACK_SOURCES = ['web', 'handheld', 'sync', 'recarton'] as const;
export type OrderPackSource = (typeof ORDER_PACK_SOURCES)[number];

/** A pack holds 1–200 cartons (`order_packs_carton_count_range`). */
export const MAX_CARTONS_PER_PACK = 200;
/** One carton carries at most this many scan lines (the pack's `MAX_SCAN_LINES`). */
export const MAX_SCAN_LINES_PER_CARTON = 500;
/** Every carton's lines together, per pack (A6). */
export const MAX_CARTON_LINES_PER_PACK = 2_000;
/** `order_packs_seq_range` — a re-carton of pack 99 is `recarton-limit` (A48). */
export const MAX_PACK_SEQ = 99;
/** `order_packs_gross_weight_range` — the true Σ, never defaulted into a shipment above `MAX_WEIGHT_GRAMS` (A33). */
export const MAX_GROSS_WEIGHT_GRAMS = 200_000_000;
/** One carton's weight and dimensions — the pack's bounds (`pack.command.ts`). */
export const MAX_CARTON_WEIGHT_GRAMS = 1_000_000;
export const MAX_CARTON_DIMENSION_MM = 100_000;

export interface CartonScanLine {
  readonly skuId: string;
  /** Base units. */
  readonly qty: number;
  readonly handlingUnitIds?: readonly string[] | null | undefined;
}

export interface CartonDimensions {
  readonly lengthMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}

/** One carton as the body sends it (`PackCartonDto`). */
export interface PackCartonInput {
  readonly scanned: readonly CartonScanLine[];
  readonly weightGrams?: number | null | undefined;
  readonly dimensionsMm?: CartonDimensions | null | undefined;
}

/** One carton after `aggregateCartons`: its raw lines, its per-SKU totals and its measurements. */
export interface AggregatedCarton {
  /** 1-based, body order. */
  readonly seq: number;
  /** The raw lines (base units) — what `assertCartonQuantities` judges. */
  readonly scanned: readonly CartonScanLine[];
  /** Per SKU, milli-units. */
  readonly totals: ReadonlyMap<string, number>;
  /** Per catch-weight SKU, the sorted handling-unit ids. */
  readonly handlingUnitIdsBySku: ReadonlyMap<string, readonly string[]>;
  readonly weightGrams: number | null;
  readonly dimensionsMm: CartonDimensions | null;
}

/** The scan the cartons must add up to (the pack's top-level aggregate). */
export interface CartonTotalsTarget {
  readonly totals: ReadonlyMap<string, number>;
  readonly handlingUnitIdsBySku: ReadonlyMap<string, readonly string[]>;
}

export function cartonValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Pack validation failed', detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Absent and `null` are the same (A32: sync-report passes `?? null`). */
function optionalInteger(value: unknown, what: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw cartonValidation(`${what} must be a whole number or absent.`);
  }
  return value;
}

function optionalDimensions(value: unknown, carton: number): CartonDimensions | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw cartonValidation(`Carton ${carton}: dimensionsMm must be an object of lengthMm, widthMm and heightMm.`);
  }
  const lengthMm = optionalInteger(value.lengthMm, `Carton ${carton}: dimensionsMm.lengthMm`);
  const widthMm = optionalInteger(value.widthMm, `Carton ${carton}: dimensionsMm.widthMm`);
  const heightMm = optionalInteger(value.heightMm, `Carton ${carton}: dimensionsMm.heightMm`);
  if (lengthMm === null || widthMm === null || heightMm === null) {
    throw cartonValidation(`Carton ${carton}: dimensionsMm needs all three of lengthMm, widthMm and heightMm.`);
  }
  // Key order fixed here, whatever order the body sent (the hash reads it).
  return { lengthMm, widthMm, heightMm };
}

/**
 * The shape of `cartons[]`, judged above the transaction (A6, A32): it
 * type-checks before it reads, so a payload no DTO validated (the sync-report
 * apply) is a 400, never a TypeError. With `target`, the cartons must add up
 * to the top-level scan per SKU exactly, and their handling-unit ids must
 * partition the top-level ids exactly. Without it (a re-carton), the totals
 * come from the live pack and are compared in the transaction
 * (`compareCartonContents`).
 *
 * Every refusal is 400 `validation-failed` naming the carton.
 */
export function aggregateCartons(raw: unknown, target?: CartonTotalsTarget): AggregatedCarton[] {
  if (!Array.isArray(raw)) {
    throw cartonValidation('cartons must be an array of cartons.');
  }
  if (raw.length < 1 || raw.length > MAX_CARTONS_PER_PACK) {
    throw cartonValidation(`A pack holds 1 to ${MAX_CARTONS_PER_PACK} cartons (got ${raw.length}).`);
  }
  let lineCount = 0;
  const seenUnits = new Map<string, number>();
  const cartons: AggregatedCarton[] = [];
  raw.forEach((entry: unknown, index) => {
    const seq = index + 1;
    if (!isPlainObject(entry)) {
      throw cartonValidation(`Carton ${seq} must be an object with its scanned lines.`);
    }
    const scanned = entry.scanned;
    if (!Array.isArray(scanned)) {
      throw cartonValidation(`Carton ${seq} must carry its scanned lines as an array.`);
    }
    if (scanned.length < 1) {
      throw cartonValidation(`Carton ${seq} is empty — every carton holds at least one item.`);
    }
    if (scanned.length > MAX_SCAN_LINES_PER_CARTON) {
      throw cartonValidation(`Carton ${seq} carries at most ${MAX_SCAN_LINES_PER_CARTON} scan lines (got ${scanned.length}).`);
    }
    lineCount += scanned.length;
    if (lineCount > MAX_CARTON_LINES_PER_PACK) {
      throw cartonValidation(`A pack's cartons carry at most ${MAX_CARTON_LINES_PER_PACK} scan lines in all.`);
    }
    const totals = new Map<string, number>();
    const units = new Map<string, string[]>();
    const lines: CartonScanLine[] = [];
    for (const line of scanned as unknown[]) {
      if (!isPlainObject(line) || typeof line.skuId !== 'string' || !UUID_RE.test(line.skuId)) {
        throw cartonValidation(`Carton ${seq}: every scanned line names a well-formed skuId.`);
      }
      const skuId = line.skuId;
      if (typeof line.qty !== 'number' || !Number.isFinite(line.qty)) {
        throw cartonValidation(`Carton ${seq}: every scanned line carries a numeric qty.`);
      }
      if (!(line.qty > 0) || line.qty > fromMilli(MAX_QUANTITY_MILLI)) {
        throw cartonValidation(
          `Carton ${seq}: scanned quantity must be a positive quantity in base UoM, at most ${fromMilli(MAX_QUANTITY_MILLI)} (got ${String(line.qty)}).`,
        );
      }
      const ids = line.handlingUnitIds;
      if (ids !== undefined && ids !== null && !Array.isArray(ids)) {
        throw cartonValidation(`Carton ${seq}: handlingUnitIds must be an array of ids.`);
      }
      for (const unitId of (ids ?? []) as unknown[]) {
        if (typeof unitId !== 'string' || !UUID_RE.test(unitId)) {
          throw cartonValidation(`Carton ${seq}: every handling unit names a well-formed id.`);
        }
        const earlier = seenUnits.get(unitId);
        if (earlier !== undefined) {
          throw cartonValidation(
            earlier === seq
              ? `Carton ${seq}: handling unit "${unitId}" was scanned twice — a case ships exactly once.`
              : `Handling unit "${unitId}" is in carton ${earlier} and carton ${seq} — a case is in exactly one carton.`,
          );
        }
        if (seenUnits.size >= MAX_HANDLING_UNITS_PER_REQUEST) {
          throw cartonValidation(`A pack's cartons scan at most ${MAX_HANDLING_UNITS_PER_REQUEST} handling units in all.`);
        }
        seenUnits.set(unitId, seq);
        const list = units.get(skuId) ?? [];
        list.push(unitId);
        units.set(skuId, list);
      }
      const running = (totals.get(skuId) ?? 0) + toMilli(line.qty);
      if (running > MAX_QUANTITY_MILLI) {
        throw cartonValidation(
          `Carton ${seq}: scanned quantity for a SKU must total at most ${fromMilli(MAX_QUANTITY_MILLI)} in base UoM.`,
        );
      }
      totals.set(skuId, running);
      lines.push({
        skuId,
        qty: line.qty,
        ...(ids === undefined || ids === null ? {} : { handlingUnitIds: ids as string[] }),
      });
    }
    const handlingUnitIdsBySku = new Map<string, readonly string[]>();
    for (const [skuId, ids] of units) handlingUnitIdsBySku.set(skuId, [...ids].sort());
    cartons.push({
      seq,
      scanned: lines,
      totals,
      handlingUnitIdsBySku,
      weightGrams: optionalInteger(entry.weightGrams, `Carton ${seq}: weightGrams`),
      dimensionsMm: optionalDimensions(entry.dimensionsMm, seq),
    });
  });

  if (target !== undefined) {
    const summed = sumCartons(cartons);
    const skus = new Set([...target.totals.keys(), ...summed.keys()]);
    for (const skuId of [...skus].sort()) {
      const scannedQty = target.totals.get(skuId) ?? 0;
      const cartoned = summed.get(skuId) ?? 0;
      if (scannedQty !== cartoned) {
        throw cartonValidation(
          `The carton contents do not add up to the scanned parcel: SKU ${skuId} was scanned ${fromMilli(scannedQty)} and the cartons hold ${fromMilli(cartoned)}.`,
        );
      }
    }
    const targetIds = new Set<string>();
    for (const ids of target.handlingUnitIdsBySku.values()) for (const id of ids) targetIds.add(id);
    for (const id of seenUnits.keys()) {
      if (!targetIds.has(id)) {
        throw cartonValidation(`Handling unit "${id}" is in carton ${seenUnits.get(id)} but not in the scanned parcel.`);
      }
    }
    for (const id of targetIds) {
      if (!seenUnits.has(id)) {
        throw cartonValidation(`Handling unit "${id}" was scanned but is in no carton — every case is in exactly one carton.`);
      }
    }
  }
  return cartons;
}

/** Per SKU, the milli-units of every carton together. */
export function sumCartons(cartons: readonly AggregatedCarton[]): Map<string, number> {
  const summed = new Map<string, number>();
  for (const carton of cartons) {
    for (const [skuId, qty] of carton.totals) summed.set(skuId, (summed.get(skuId) ?? 0) + qty);
  }
  return summed;
}

/** The hash's per-carton entry (A6): the carton's aggregate in the `scanned` shape of the pack hash, then its measurements. */
export interface CartonHashEntry {
  readonly scanned: readonly { readonly skuId: string; readonly qty: number; readonly handlingUnitIds: readonly string[] | undefined }[];
  readonly weightGrams: number | undefined;
  readonly dimensionsMm: CartonDimensions | undefined;
}

/**
 * The normal form of the cartons for a payload hash: body order (carton 1 is
 * carton 1), each carton's SKUs sorted with their sorted ids — the shape the
 * pack hash already gives the top-level scan — and absent measurements as
 * `undefined`, which `JSON.stringify` drops.
 */
export function cartonsHashForm(cartons: readonly AggregatedCarton[]): CartonHashEntry[] {
  return cartons.map((carton) => ({
    scanned: [...carton.totals.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([skuId, qty]) => ({ skuId, qty, handlingUnitIds: carton.handlingUnitIdsBySku.get(skuId) })),
    weightGrams: carton.weightGrams ?? undefined,
    dimensionsMm: carton.dimensionsMm ?? undefined,
  }));
}

/** Two splits are the same split: the same cartons, contents, ids, weights and dimensions, in order (A8 step 9). */
export function sameSplit(left: readonly AggregatedCarton[], right: readonly AggregatedCarton[]): boolean {
  return JSON.stringify(cartonsHashForm(left)) === JSON.stringify(cartonsHashForm(right));
}

/** Each carton's measurements under the pack bounds (A6 — after the replay). */
export function assertCartonMeasurements(cartons: readonly AggregatedCarton[], options: { readonly device: boolean }): void {
  for (const carton of cartons) {
    if (carton.weightGrams !== null && (carton.weightGrams < 1 || carton.weightGrams > MAX_CARTON_WEIGHT_GRAMS)) {
      throw cartonValidation(
        `Carton ${carton.seq}: weightGrams must be a positive whole number of grams, at most ${MAX_CARTON_WEIGHT_GRAMS} (got ${carton.weightGrams}).`,
      );
    }
    if (carton.dimensionsMm !== null) {
      if (options.device) {
        // The device route never measures boxes (D2): `DevicePackDto` omits
        // the field at the edge, and the sync-report apply builds its command
        // from a payload no DTO validated, so the command refuses it too.
        throw cartonValidation(`Carton ${carton.seq}: a handheld pack does not record carton dimensions.`);
      }
      for (const [key, value] of Object.entries(carton.dimensionsMm)) {
        if (value < 1 || value > MAX_CARTON_DIMENSION_MM) {
          throw cartonValidation(
            `Carton ${carton.seq}: dimensionsMm.${key} must be a positive whole number of millimetres, at most ${MAX_CARTON_DIMENSION_MM} (got ${value}).`,
          );
        }
      }
    }
  }
}

/** The SKU facts the per-carton quantity rules need. */
export interface CartonSkuFacts {
  readonly code: string;
  readonly uom: string;
  readonly catchWeight: boolean;
}

/**
 * A31 — every carton holds a quantity its SKU can express: each RAW line
 * passes the SKU's UoM precision (so an each-counted SKU split 6.5 + 3.5 is
 * refused although the total is 10); a catch-weight SKU's quantity in a carton
 * equals its id count × `QUANTITY_SCALE`; ids on a non-catch-weight SKU are
 * refused. 400 `validation-failed` naming the carton.
 */
export function assertCartonQuantities(
  cartons: readonly AggregatedCarton[],
  skuFacts: ReadonlyMap<string, CartonSkuFacts>,
): void {
  for (const carton of cartons) {
    for (const line of carton.scanned) {
      const facts = skuFacts.get(line.skuId);
      if (facts === undefined) continue; // an unknown SKU is the pack's own 404/422
      try {
        void assertRecordableQuantity(line.qty, 'qty', facts.uom, uomPrecision(facts.uom));
      } catch (err) {
        if (err instanceof ProblemException) {
          throw cartonValidation(`Carton ${carton.seq}: ${err.message}`);
        }
        throw err;
      }
    }
    for (const [skuId, qty] of carton.totals) {
      const facts = skuFacts.get(skuId);
      if (facts === undefined) continue;
      const ids = carton.handlingUnitIdsBySku.get(skuId) ?? [];
      if (!facts.catchWeight) {
        if (ids.length > 0) {
          throw cartonValidation(`Carton ${carton.seq}: SKU ${facts.code} is not catch-weight tracked, so it carries no handling units.`);
        }
        continue;
      }
      if (qty !== ids.length * QUANTITY_SCALE) {
        throw cartonValidation(
          `Carton ${carton.seq}: SKU ${facts.code} is catch-weight tracked — its quantity (${fromMilli(qty)}) must equal the cases scanned into the carton (${ids.length}).`,
        );
      }
    }
  }
}

/** One SKU whose re-carton differs from what was packed (base units in the problem's extensions). */
export interface CartonContentsMismatch {
  readonly skuId: string;
  /** Milli-units. */
  readonly packed: number;
  /** Milli-units. */
  readonly cartoned: number;
}

/**
 * A8 step 8 — per SKU, the new cartons hold exactly what the live pack holds,
 * and per catch-weight SKU the same case ids. Zero-quantity entries are
 * dropped on both sides (A36). Returns the SKUs that differ (empty when equal),
 * sorted by SKU id.
 */
export function compareCartonContents(
  packed: CartonTotalsTarget,
  cartons: readonly AggregatedCarton[],
): CartonContentsMismatch[] {
  const summed = sumCartons(cartons);
  const ids = new Map<string, string[]>();
  for (const carton of cartons) {
    for (const [skuId, list] of carton.handlingUnitIdsBySku) ids.set(skuId, [...(ids.get(skuId) ?? []), ...list]);
  }
  const skus = new Set<string>();
  for (const [skuId, qty] of packed.totals) if (qty !== 0) skus.add(skuId);
  for (const [skuId, qty] of summed) if (qty !== 0) skus.add(skuId);
  const mismatches: CartonContentsMismatch[] = [];
  for (const skuId of [...skus].sort()) {
    const packedQty = packed.totals.get(skuId) ?? 0;
    const cartoned = summed.get(skuId) ?? 0;
    const packedIds = [...(packed.handlingUnitIdsBySku.get(skuId) ?? [])].sort().join(',');
    const cartonedIds = [...(ids.get(skuId) ?? [])].sort().join(',');
    if (packedQty !== cartoned || packedIds !== cartonedIds) {
      mismatches.push({ skuId, packed: packedQty, cartoned });
    }
  }
  return mismatches;
}

/** Σ carton weights when every carton is weighed, else null (A1). */
export function grossWeightOf(cartons: readonly { readonly weightGrams: number | null }[]): number | null {
  if (cartons.length === 0 || cartons.some((carton) => carton.weightGrams === null)) return null;
  return cartons.reduce((sum, carton) => sum + (carton.weightGrams ?? 0), 0);
}

/**
 * A33 — the gross weight that may flow into a shipment (the `pack.packed`
 * doc, the snapshot's top-level weight, the handover default): only when it
 * is ≤ the shipment bound (`shipments_weight_grams_range`, 1,000,000 g).
 */
export function shipmentWeightOf(gross: number | null, shipmentBound: number): number | null {
  return gross !== null && gross <= shipmentBound ? gross : null;
}

/**
 * A6 / A39 — the dimension keys a `pack.packed` doc carries: only when there
 * is exactly one carton and it has dimensions.
 */
export function packDimensionsOf(cartons: readonly { readonly dimensionsMm: CartonDimensions | null }[]): CartonDimensions | null {
  return cartons.length === 1 ? cartons[0]!.dimensionsMm : null;
}
