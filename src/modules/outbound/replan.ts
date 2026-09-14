import { and, asc, eq, isNull } from 'drizzle-orm';
import { bins } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { InventoryFacade } from '../inventory/inventory.facade';
import type { CatalogFacade } from '../catalog/catalog.facade';

/**
 * Story 4.4 — "where else is this SKU?".
 *
 * `wave.command`'s `planSlices` has always answered that question, but it is
 * `private`, it answers it for a whole wave at once, and it consumes its pool
 * DESTRUCTIVELY (two order lines of the same SKU must not both claim the
 * same units). Calling it from the pick command would mean planning a wave to
 * re-plan one stop. So the part that is genuinely shared — how a SKU's
 * drawable units are laid out across pickable bins, in walk order, FEFO
 * within each bin — is extracted here as a PURE function over rows the
 * caller has already read, and both sides use it:
 *
 *   - `planSlices` builds the pool for every SKU on the wave, then consumes
 *     it line by line;
 *   - `findReplanSlices` below builds it for ONE SKU, drops the bin that just
 *     came up short, and takes the remainder off the front.
 *
 * Keeping one implementation is the point: the filter set that decides what
 * is pickable (not blocked, not system-owned, not retired, batch drawable,
 * per-bin budget) is a correctness rule, and a re-plan that used a second,
 * drifting copy of it would eventually route an operator to a bin the wave
 * planner would never have named.
 */

/** One drawable unit-bucket of the walk: a (bin, batch) slot in walk order. */
export interface StockSlot {
  readonly binId: string;
  readonly binCode: string;
  readonly batchId: string | null;
  remaining: number;
}

/** The identity facts the pool needs about a batch (catalog-owned). */
export interface PoolBatchIdentity {
  readonly id: string;
  readonly status: string;
  readonly expiryDate: string | null;
}

export interface StockPoolInput {
  readonly skuIds: readonly string[];
  /** The pickable bins in WALK order (`bins.code` ascending) — the rank. */
  readonly binOrder: readonly { readonly id: string; readonly code: string }[];
  readonly stock: readonly { skuId: string; binId: string; quantity: number }[];
  readonly batchStock: readonly { skuId: string; binId: string; batchId: string; quantity: number }[];
  readonly batchIdentities: readonly PoolBatchIdentity[];
  /**
   * The instant expiry is judged at. The wave planner uses its injected
   * clock; the pick command uses the op's own `occurredAt`, so a queued pick
   * replayed later is not re-judged against the replay instant.
   */
  readonly at: number;
}

/**
 * The per-SKU walk: (bin in code order) × (batch in FEFO order), with the
 * per-bin budget that keeps a divergent batch projection from over-planning.
 *
 * Pure — no I/O, no clock, no `this`. Every rule it encodes was 4.2's:
 * a blocked or expired batch is never drawn (epic-2 retro a13, draw side);
 * FEFO is expiry ascending with no-expiry LAST; the plain projection row is
 * the ceiling for the WHOLE bin, not for each batch in it; and units the
 * batch fold cannot attribute are still pickable, with no batch suggestion.
 */
export function buildStockPool(input: StockPoolInput): Map<string, StockSlot[]> {
  const binCodes = new Map(input.binOrder.map((bin) => [bin.id, bin.code]));
  const binRank = new Map(input.binOrder.map((bin, index) => [bin.id, index]));
  const batchById = new Map(input.batchIdentities.map((batch) => [batch.id, batch]));
  const drawableBatch = (batchId: string): boolean => {
    const batch = batchById.get(batchId);
    if (batch === undefined || batch.status !== 'active') {
      // A blocked batch is never drawn (epic-2 retro a13, draw side); an
      // identity the catalog does not know is not suggestible either.
      return false;
    }
    return batch.expiryDate === null || Date.parse(batch.expiryDate) >= input.at;
  };
  const expiryOf = (batchId: string): string | null => batchById.get(batchId)?.expiryDate ?? null;

  const pool = new Map<string, StockSlot[]>();
  for (const skuId of new Set(input.skuIds)) {
    const slots: StockSlot[] = [];
    const plainRows = input.stock
      .filter((row) => row.skuId === skuId && binRank.has(row.binId))
      .sort((a, b) => binRank.get(a.binId)! - binRank.get(b.binId)!);
    for (const row of plainRows) {
      const binCode = binCodes.get(row.binId)!;
      const batchRows = input.batchStock.filter(
        (batch) => batch.skuId === skuId && batch.binId === row.binId,
      );
      if (batchRows.length === 0) {
        // An untracked SKU (or a bin whose batch projection is empty): the
        // plain projection row IS the drawable quantity.
        slots.push({ binId: row.binId, binCode, batchId: null, remaining: row.quantity });
        continue;
      }
      const drawable = batchRows
        .filter((batch) => drawableBatch(batch.batchId))
        // FEFO: expiry ASC, nulls LAST (a batch without expiry draws last).
        .sort((a, b) => {
          const left = expiryOf(a.batchId);
          const right = expiryOf(b.batchId);
          if (left === right) return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
          if (left === null) return 1;
          if (right === null) return -1;
          return left < right ? -1 : 1;
        });
      // What the batch projection accounts for in this bin — drawable or
      // not. Anything ABOVE it is batch-less stock the batch fold has not
      // (or cannot) attribute: it exists, it is pickable, and stranding it
      // would plan a shortfall against stock that is right there. Units held
      // by a blocked or expired batch are accounted for here and therefore
      // never resurface in this remainder — they stay undrawable.
      const accounted = batchRows.reduce((sum, batch) => sum + batch.quantity, 0);
      const uncovered = Math.max(0, row.quantity - accounted);
      let binBudget = row.quantity - uncovered;
      for (const batch of drawable) {
        if (binBudget <= 0) break;
        const remaining = Math.min(batch.quantity, binBudget);
        binBudget -= remaining;
        slots.push({ binId: row.binId, binCode, batchId: batch.batchId, remaining });
      }
      if (uncovered > 0) {
        slots.push({ binId: row.binId, binCode, batchId: null, remaining: uncovered });
      }
    }
    pool.set(skuId, slots);
  }
  return pool;
}

/**
 * The warehouse's pickable bins in walk order — putaway's filter set, which
 * is also why QC-held stock never plans: a hold MOVES it into the
 * system-owned QC bin.
 */
export async function pickableBinsInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
): Promise<{ id: string; code: string }[]> {
  return tx
    .select({ id: bins.id, code: bins.code })
    .from(bins)
    .where(
      and(
        eq(bins.tenantId, tenantId),
        eq(bins.warehouseId, warehouseId),
        eq(bins.blocked, false),
        eq(bins.systemOwned, false),
        isNull(bins.retiredAt),
      ),
    )
    .orderBy(asc(bins.code), asc(bins.id));
}

/** One re-planned stop: a bin, a batch suggestion and the units to draw. */
export interface ReplanSlice {
  readonly binId: string;
  readonly binCode: string;
  readonly batchId: string | null;
  readonly qty: number;
}

/**
 * Where the remainder of a short-picked stop can be drawn instead (FR-15's
 * "within the same Picklist"): the SKU's drawable units in every OTHER
 * pickable bin of the warehouse, in walk order, FEFO within each bin, taken
 * until `need` is covered.
 *
 * The short bin itself is excluded by id — it is the bin that just failed to
 * cover the draw, and re-planning the remainder back onto it would hand the
 * operator the same empty shelf a second time. (Its projection may well still
 * read positive: a partly-drawn bin covers SOMETHING, just not this line.)
 *
 * An empty result is not an error — it is the partial-order path: the line
 * stays short with its shortfall recorded and the order is under-fulfilled
 * honestly. A result that covers only PART of `need` is the same answer for
 * the uncovered part: what can be re-planned is, what cannot stays short.
 *
 * Read-only. Nothing here allocates: the slices it returns are a SUGGESTION
 * the pick command re-derives against live stock when the operator gets
 * there, exactly like every other pick stop.
 */
export async function findReplanSlices(
  tx: TenantTx,
  deps: { readonly inventory: InventoryFacade; readonly catalog: CatalogFacade },
  scope: {
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly skuId: string;
    /** The bin that came up short — never re-planned onto. */
    readonly excludeBinId: string;
    readonly need: number;
    /** The pick's own business time: expiry is judged against it, not now. */
    readonly at: number;
  },
): Promise<ReplanSlice[]> {
  if (scope.need <= 0) {
    return [];
  }
  const binOrder = (await pickableBinsInTx(tx, scope.tenantId, scope.warehouseId)).filter(
    (bin) => bin.id !== scope.excludeBinId,
  );
  if (binOrder.length === 0) {
    return [];
  }
  const [stock, batchStock, batchIdentities] = await Promise.all([
    deps.inventory.stockByBinsInTx(tx, scope.tenantId, scope.warehouseId, [scope.skuId]),
    deps.inventory.batchOnHandByBinsInTx(tx, scope.tenantId, scope.warehouseId, [scope.skuId]),
    deps.catalog.getBatchesForSkusInTx(tx, scope.tenantId, [scope.skuId]),
  ]);
  const pool = buildStockPool({
    skuIds: [scope.skuId],
    binOrder,
    stock,
    batchStock,
    batchIdentities,
    at: scope.at,
  });

  const slices: ReplanSlice[] = [];
  let need = scope.need;
  for (const slot of pool.get(scope.skuId) ?? []) {
    if (need === 0) break;
    if (slot.remaining <= 0) continue;
    const take = Math.min(need, slot.remaining);
    need -= take;
    slices.push({ binId: slot.binId, binCode: slot.binCode, batchId: slot.batchId, qty: take });
  }
  return slices;
}
