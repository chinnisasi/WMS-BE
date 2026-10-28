import { assertExactQuantity, QUANTITY_SCALE } from '../../shared/primitives/quantity';

/**
 * Story 4-2c — the backorder follow-on's pure rules: what a short dispatch
 * still owes (the remainder), a kit parent's live shortfall, and the order
 * label with its `-BO{seq}` suffix. Imports nothing but `drizzle-orm` and
 * `shared/` (the dispatch command, the facade reads and the allocation
 * command all use it).
 *
 * Quantities are milli-units throughout (`QUANTITY_SCALE` = 1000 per base
 * unit). The kit arithmetic runs in BigInt and is checked back into the exact
 * range with `assertExactQuantity`.
 */

/** One stored order line as the remainder rule needs it (milli-units). */
export interface RemainderLine {
  readonly id: string;
  readonly skuId: string;
  readonly qty: number;
  readonly parentLineId: string | null;
  readonly ratePaise: number | null;
}

/** One line of the follow-on to insert. `parentSourceLineId` names the SOURCE kit parent line. */
export interface FollowOnLinePlan {
  readonly sourceLineId: string;
  readonly skuId: string;
  /** Milli-units — what is still owed. */
  readonly qty: number;
  readonly ratePaise: number | null;
  /** On a kit component: the source kit parent line it belongs to; null otherwise. */
  readonly parentSourceLineId: string | null;
}

/**
 * A9 — the smallest plain-line remainder that opens a follow-on line: one
 * base unit. A sub-unit remainder (a weighed SKU picked 0.998 of 1 kg) stays
 * on the dispatch record's `shortfallQty` only.
 */
export const MIN_FOLLOW_ON_REMAINDER_MILLI = QUANTITY_SCALE;

/**
 * Decision 2 / A9 — the whole kits a kit line's components cover.
 * `complete = minᵢ floor(pᵢ × Q / qᵢ / 1000) × 1000` (milli-units, whole kits),
 * where `Q` is the kit line's quantity, `qᵢ` each component line's and `pᵢ`
 * what it covers (picked, or reserved for the live shortfall). When EVERY
 * component is covered in full the kit is complete whatever `Q` is (a
 * fractional kit quantity is never floored below itself).
 */
export function completeKits(kitQty: number, components: readonly { readonly qty: number; readonly covered: number }[]): number {
  if (components.length === 0) return 0;
  if (components.every((component) => component.covered >= component.qty)) return kitQty;
  const scale = BigInt(QUANTITY_SCALE);
  const q = BigInt(kitQty);
  let complete: bigint | null = null;
  for (const component of components) {
    const covered = BigInt(Math.max(0, Math.min(component.covered, component.qty)));
    const kits = ((covered * q) / BigInt(component.qty) / scale) * scale;
    complete = complete === null || kits < complete ? kits : complete;
  }
  const result = complete === null ? 0n : complete;
  return assertExactQuantity(Number(result < q ? result : q), 'kit complete count');
}

/**
 * The follow-on's lines for a dispatch, from the order's lines and the picked
 * milli-units per line (`Σ picks.qty`). Plain lines: `qty − picked` when it is
 * at least one base unit. Kits: when `complete < Q`, a parent line of
 * `Q − complete` and, per component, `qᵢ − pᵢ` where that is at least one
 * milli — exactly what is still owed, so the customer receives `qᵢ` in total.
 * Empty when nothing is owed. Order: the source lines' order.
 */
export function followOnRemainder(lines: readonly RemainderLine[], pickedByLine: ReadonlyMap<string, number>): FollowOnLinePlan[] {
  const childrenOf = new Map<string, RemainderLine[]>();
  for (const line of lines) {
    if (line.parentLineId === null) continue;
    const list = childrenOf.get(line.parentLineId) ?? [];
    list.push(line);
    childrenOf.set(line.parentLineId, list);
  }
  const picked = (id: string): number => pickedByLine.get(id) ?? 0;
  const out: FollowOnLinePlan[] = [];
  for (const line of lines) {
    if (line.parentLineId !== null) continue; // a component rides its parent below
    const children = childrenOf.get(line.id);
    if (children === undefined) {
      const remainder = line.qty - picked(line.id);
      if (remainder >= MIN_FOLLOW_ON_REMAINDER_MILLI) {
        out.push({ sourceLineId: line.id, skuId: line.skuId, qty: remainder, ratePaise: line.ratePaise, parentSourceLineId: null });
      }
      continue;
    }
    const complete = completeKits(
      line.qty,
      children.map((child) => ({ qty: child.qty, covered: picked(child.id) })),
    );
    if (complete >= line.qty) continue;
    const owed = children
      .map((child) => ({ child, remainder: child.qty - Math.min(picked(child.id), child.qty) }))
      .filter((entry) => entry.remainder >= 1);
    if (owed.length === 0) continue; // a fractional kit whose components all shipped in full
    out.push({ sourceLineId: line.id, skuId: line.skuId, qty: line.qty - complete, ratePaise: line.ratePaise, parentSourceLineId: null });
    for (const { child, remainder } of owed) {
      out.push({ sourceLineId: child.id, skuId: child.skuId, qty: remainder, ratePaise: null, parentSourceLineId: line.id });
    }
  }
  return out;
}

// The order label (A10) lives in `shared/primitives/order-label.ts` — the
// client wind-down file may import only `shared/` — and is re-exported here.
export { followOnLabelSuffix, orderLabelOf, orderLabelSql, stripFollowOnSuffix, type OrderLabelFields } from '../../shared/primitives/order-label';
