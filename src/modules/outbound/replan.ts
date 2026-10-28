import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { bins, picklistLines } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { InventoryFacade } from '../inventory/inventory.facade';
import type { CatalogFacade } from '../catalog/catalog.facade';
// Story 12-1 — the ONE conformance predicate (the temperature hierarchy),
// shared with putaway, pick and the class-edit guards.
import { storageClassSatisfies } from '../../shared/primitives/storage-class';
// Story 4-3a — THE allocation rule and THE allocatability predicate, shared
// with the pick's batch re-derivation and the ATP hook (A6 pins the import).
import {
  isBatchAllocatableAt,
  meetsConsigneeShelfLife,
  rankSlots,
  type AllocationRule,
  type ConsigneeArm,
} from '../../shared/primitives/batch-allocation';

/**
 * Story 4.4 — "where else is this SKU?".
 *
 * `wave.command`'s `planSlices` has always answered that question, but it is
 * `private`, it answers it for a whole wave at once, and it consumes its pool
 * DESTRUCTIVELY (two order lines of the same SKU must not both claim the
 * same units). Calling it from the pick command would mean planning a wave to
 * re-plan one stop. So the part that is genuinely shared — how a SKU's
 * drawable units are laid out across pickable bins and RANKED by the SKU's
 * client allocation rule (story 4-3a: warehouse-wide, not per bin) — is
 * extracted here as a PURE function over rows the
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

/** One drawable unit-bucket: a (bin, batch) slot, in the client rule's RANK order (4-3a). */
export interface StockSlot {
  readonly binId: string;
  readonly binCode: string;
  readonly batchId: string | null;
  /** The bin's position in walk order (`bins.code` ascending) — the ranking's tie-break. */
  readonly walkRank: number;
  remaining: number;
}

/** The identity facts the pool needs about a batch (catalog-owned). */
export interface PoolBatchIdentity {
  readonly id: string;
  readonly status: string;
  readonly expiryDate: string | null;
  /** Story 4-3a — `batches.created_at`, the lot's first receipt: FIFO's anchor and FEFO's undated tie-break. */
  readonly createdAt: string;
}

/** Story 4-3a — the allocation policy one SKU's slots are ranked and filtered by. */
export interface PoolPolicy {
  readonly allocationRule: AllocationRule;
  readonly minDays: number | null;
}

export interface StockPoolInput {
  readonly skuIds: readonly string[];
  /**
   * The pickable bins in WALK order (`bins.code` ascending) — the rank.
   * Story 12-1: each entry carries its `storageClass`, the class the pool
   * filter rules per (SKU, bin) with `storageClassSatisfies`.
   */
  readonly binOrder: readonly { readonly id: string; readonly code: string; readonly storageClass: string }[];
  /** Story 12-1 — the lines' storage classes, keyed by SKU id. */
  readonly skuClassById: ReadonlyMap<string, string>;
  readonly stock: readonly { skuId: string; binId: string; quantity: number }[];
  readonly batchStock: readonly { skuId: string; binId: string; batchId: string; quantity: number }[];
  readonly batchIdentities: readonly PoolBatchIdentity[];
  /**
   * The instant expiry is judged at. The wave planner uses its injected
   * clock; the pick command uses the op's own `occurredAt`, so a queued pick
   * replayed later is not re-judged against the replay instant.
   */
  readonly at: number;
  /**
   * Story 4-3a — each SKU's allocation policy (the wave: the SKU's client's
   * live policy, read once; the re-plan: the short line's frozen values).
   */
  readonly policyOf: (skuId: string) => PoolPolicy;
  /**
   * Story 4-3a (A3) — the IST date the MINIMUM is judged on (the re-plan's
   * one-day grace); absent → `at`'s own IST date (the wave plan). Expiry is
   * always judged at `at`.
   */
  readonly minJudgedOn?: string;
}

/**
 * The per-SKU pool: every drawable (bin, batch) slot, RANKED by the SKU's
 * client allocation rule (story 4-3a, `rankSlots`), with the per-bin budget
 * that keeps a divergent batch projection from over-planning.
 *
 * Pure — no I/O, no clock, no `this`. The rules:
 *   - a batch that is not allocatable (`isBatchAllocatableAt`: blocked,
 *     expired at `at`, or below the policy's minimum) is never drawn;
 *   - the plain projection row is the ceiling for the WHOLE bin, not for each
 *     batch in it — the budget is spent in the rule's order inside the bin;
 *   - units the batch fold cannot attribute are still pickable, with no
 *     batch suggestion (a batch-less slot);
 *   - story 4-3a: the ranking is WAREHOUSE-WIDE (`fefo`: dated batches by
 *     expiry, then undated by lot first received, then batch-less; `fifo`:
 *     batches by lot first received, then batch-less; ties by walk rank,
 *     then batch id). An untracked SKU's slots stay in walk order.
 */
export function buildStockPool(input: StockPoolInput): Map<string, StockSlot[]> {
  const binCodes = new Map(input.binOrder.map((bin) => [bin.id, bin.code]));
  const binRank = new Map(input.binOrder.map((bin, index) => [bin.id, index]));
  // Story 12-1 — the classes the pool filter rules on. A bin the SKU's class
  // does not satisfy is not in the walk at all: a wave line whose only stock
  // sits in non-conforming bins plans a shortfall (`unfulfillable`), never a
  // pick that always refuses at the bin (FR-40). Fail-closed: an unknown
  // class on either side cannot be proven conforming. (Both are NOT NULL in
  // the schema — `undefined` here means a caller forgot the projection.)
  const binClassById = new Map(input.binOrder.map((bin) => [bin.id, bin.storageClass]));
  const batchById = new Map(input.batchIdentities.map((batch) => [batch.id, batch]));
  const factsOf = (batchId: string) => batchById.get(batchId);

  const pool = new Map<string, StockSlot[]>();
  for (const skuId of new Set(input.skuIds)) {
    const slots: StockSlot[] = [];
    const policy = input.policyOf(skuId);
    const drawableBatch = (batchId: string): boolean => {
      const batch = batchById.get(batchId);
      // An identity the catalog does not know is not suggestible.
      if (batch === undefined) return false;
      // Story 4-3a — the ONE shared predicate (status, 3-3a's expiry at `at`,
      // and the minimum on `minJudgedOn`); the promise side's
      // `unpromisableBatchUnits` reads it too, so promise and draw agree.
      return isBatchAllocatableAt(batch, input.at, policy.minDays, input.minJudgedOn);
    };
    const skuClass = input.skuClassById.get(skuId);
    const plainRows = input.stock
      .filter((row) => row.skuId === skuId && binRank.has(row.binId))
      // Story 12-1 — the class filter, at the bin-rank membership point: a
      // stock row in a bin that does not satisfy the SKU's class is not
      // drawable (fail-closed — an unknown class proves nothing).
      .filter((row) => {
        const binClass = binClassById.get(row.binId);
        return (
          skuClass !== undefined &&
          binClass !== undefined &&
          storageClassSatisfies(skuClass, binClass)
        );
      })
      .sort((a, b) => binRank.get(a.binId)! - binRank.get(b.binId)!);
    for (const row of plainRows) {
      const binCode = binCodes.get(row.binId)!;
      const walkRank = binRank.get(row.binId)!;
      const batchRows = input.batchStock.filter(
        (batch) => batch.skuId === skuId && batch.binId === row.binId,
      );
      if (batchRows.length === 0) {
        // An untracked SKU (or a bin whose batch projection is empty): the
        // plain projection row IS the drawable quantity.
        slots.push({ binId: row.binId, binCode, batchId: null, walkRank, remaining: row.quantity });
        continue;
      }
      // The bin's allocatable batches in the RULE's order — the order the
      // per-bin budget is spent in (story 4-3a; was in-bin FEFO).
      const drawable = rankSlots(
        batchRows
          .filter((batch) => drawableBatch(batch.batchId))
          .map((batch) => ({ ...batch, walkRank })),
        policy.allocationRule,
        factsOf,
      );
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
        slots.push({ binId: row.binId, binCode, batchId: batch.batchId, walkRank, remaining });
      }
      if (uncovered > 0) {
        slots.push({ binId: row.binId, binCode, batchId: null, walkRank, remaining: uncovered });
      }
    }
    // Story 4-3a — the warehouse-wide ranking (decision 4).
    pool.set(skuId, rankSlots(slots, policy.allocationRule, factsOf));
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
): Promise<{ id: string; code: string; storageClass: string }[]> {
  return tx
    .select({ id: bins.id, code: bins.code, storageClass: bins.storageClass })
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
  /** Story 4-3a (A1) — the slice's position in the rule's rank order (the walk sort's last tie-break). */
  readonly rankIndex: number;
}

/**
 * Where the remainder of a short-picked stop can be drawn instead (FR-15's
 * "within the same Picklist"): the SKU's drawable units in every OTHER
 * pickable bin of the warehouse, in the allocation rule's rank order (story
 * 4-3a: the short line's frozen rule and minimum, or the client's current
 * policy for a legacy line), taken until `need` is covered. The slices come
 * back in RANK order with their `rankIndex`; the caller re-sorts them into
 * walk order before numbering the stops (A1).
 *
 * The short bin itself is excluded by id — it is the bin that just failed to
 * cover the draw, and re-planning the remainder back onto it would hand the
 * operator the same empty shelf a second time. (Its projection may well still
 * read positive: a partly-drawn bin covers SOMETHING, just not this line.)
 *
 * Units that ANOTHER open `planned` pick line already plans to draw from a
 * bin are subtracted before anything is taken. `planSlices` gets this for
 * free by consuming its pool destructively within one wave; a re-plan runs
 * long after that wave committed, so it must read the outstanding claims back
 * out of `picklist_lines`. Without it a re-plan happily routes the operator
 * to units a sibling slice — or another order's stop on another picklist —
 * is already walking towards, and the second of the two picks fails at the
 * bin with nothing left to draw.
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
    /** Story 4-3a — the rule and minimum the new slices are planned (and stamped) with. */
    readonly allocationRule: AllocationRule;
    readonly minDays: number | null;
    /** Story 4-3a (A3) — the IST date the minimum is judged on (the one-day grace). */
    readonly minJudgedOn: string;
    /**
     * Story 4-3b — the short line's FROZEN consignee arm (null = none, every
     * pre-4-3b line) and whether the SKU is batch-tracked (an untracked SKU
     * is never limited by it). Judged on the same `minJudgedOn`.
     */
    readonly consignee?: ConsigneeArm | null;
    readonly batchTracked?: boolean;
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
  const [stock, batchStock, batchIdentities, claimed, skuClasses] = await Promise.all([
    deps.inventory.stockByBinsInTx(tx, scope.tenantId, scope.warehouseId, [scope.skuId]),
    deps.inventory.batchOnHandByBinsInTx(tx, scope.tenantId, scope.warehouseId, [scope.skuId]),
    // Story 4-3a — the intake facts carry `createdAt` (FIFO's anchor).
    deps.catalog.getBatchIntakesForSkusInTx(tx, scope.tenantId, [scope.skuId]),
    openClaimsInTx(
      tx,
      scope.tenantId,
      scope.skuId,
      binOrder.map((bin) => bin.id),
    ),
    // Story 12-1 — the SKU's class feeds the pool filter (fail-closed).
    deps.catalog.getSkuStorageClassesInTx(tx, scope.tenantId, [scope.skuId]),
  ]);
  const pool = buildStockPool({
    skuIds: [scope.skuId],
    binOrder,
    skuClassById: skuClasses,
    stock,
    batchStock,
    batchIdentities,
    at: scope.at,
    policyOf: () => ({ allocationRule: scope.allocationRule, minDays: scope.minDays }),
    minJudgedOn: scope.minJudgedOn,
  });
  const slots = pool.get(scope.skuId) ?? [];

  // Spend the outstanding claims against each bin's slots FIRST, in the same
  // rank order a pick would draw them: what is left is what is genuinely
  // unspoken for. Claims can exceed a bin's live stock (a bin drained after
  // its wave was planned), which simply zeroes it — never a negative slot.
  for (const [binId, units] of claimed) {
    let outstanding = units;
    for (const slot of slots) {
      if (outstanding === 0) break;
      if (slot.binId !== binId) continue;
      const spent = Math.min(outstanding, slot.remaining);
      slot.remaining -= spent;
      outstanding -= spent;
    }
  }

  // Story 4-3b (A12) — the consignee arm is applied AFTER the claim spend:
  // the claims are spent against every slot in rank order (what a pick would
  // draw), and only then is a non-qualifying slot skipped. Folding the arm
  // into `policyOf` instead would spend claims against qualifying slots only.
  const consignee = scope.consignee ?? null;
  const batchById = new Map(batchIdentities.map((batch) => [batch.id, batch]));
  const slices: ReplanSlice[] = [];
  let need = scope.need;
  for (const slot of slots) {
    if (need === 0) break;
    if (slot.remaining <= 0) continue;
    if (
      consignee !== null &&
      !meetsConsigneeShelfLife(
        { batchId: slot.batchId, expiryDate: slot.batchId === null ? null : (batchById.get(slot.batchId)?.expiryDate ?? null) },
        scope.batchTracked ?? true,
        scope.at,
        consignee,
        scope.minJudgedOn,
      )
    ) {
      continue;
    }
    const take = Math.min(need, slot.remaining);
    need -= take;
    slices.push({ binId: slot.binId, binCode: slot.binCode, batchId: slot.batchId, qty: take, rankIndex: slices.length });
  }
  return slices;
}

/**
 * Units of one SKU that still-open `planned` pick lines plan to draw, per bin
 * — the claims a re-plan must not plan a second time. Keyed on the bin alone
 * (the caller passes only this warehouse's pickable bins, and a bin belongs to
 * exactly one warehouse), and summed in SQL so a busy warehouse's whole
 * picklist history never crosses the wire.
 *
 * `planned` is the only status that claims anything: `picked` and `short`
 * lines are terminal records of draws that already happened, `unfulfillable`
 * names no bin, and `cancelled` lines were withdrawn.
 */
export async function openClaimsInTx(
  tx: TenantTx,
  tenantId: string,
  skuId: string,
  binIds: readonly string[],
  /** Story 4-3b (A8) — the order read leaves out its OWN order's claims. */
  excludeOrderId?: string,
): Promise<Map<string, number>> {
  if (binIds.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({
      binId: picklistLines.binId,
      // Story 10.1: `::bigint` (milli-units overflow int4 at ~2.1M base units).
      claimed: sql<string>`coalesce(sum(${picklistLines.qty}), 0)::bigint`,
    })
    .from(picklistLines)
    .where(
      and(
        eq(picklistLines.tenantId, tenantId),
        eq(picklistLines.skuId, skuId),
        eq(picklistLines.status, 'planned'),
        inArray(picklistLines.binId, [...binIds]),
        excludeOrderId === undefined ? undefined : ne(picklistLines.orderId, excludeOrderId),
      ),
    )
    .groupBy(picklistLines.binId);
  return new Map(
    rows.flatMap((row) => (row.binId === null ? [] : [[row.binId, Number(row.claimed)] as const])),
  );
}

/**
 * Story 3-3b (decision 11, A13) — the planned pick lines in ONE bin, per SKU:
 * how many lines a block would leave needing a Skip and a re-plan, and the
 * units (milli) they plan to draw. The `openClaimsInTx` shape — `planned` is
 * the only status that claims anything — keyed by the bin instead of a SKU.
 * Advisory (the block impact preview); never a lock.
 */
export async function plannedPickLinesInBinInTx(
  tx: TenantTx,
  tenantId: string,
  binId: string,
): Promise<ReadonlyArray<{ skuId: string; lines: number; units: number }>> {
  const rows = await tx
    .select({
      skuId: picklistLines.skuId,
      lines: sql<string>`count(*)::bigint`,
      // Story 10.1: `::bigint` (milli-units overflow int4 at ~2.1M base units).
      units: sql<string>`coalesce(sum(${picklistLines.qty}), 0)::bigint`,
    })
    .from(picklistLines)
    .where(and(eq(picklistLines.tenantId, tenantId), eq(picklistLines.binId, binId), eq(picklistLines.status, 'planned')))
    .groupBy(picklistLines.skuId)
    .orderBy(picklistLines.skuId);
  return rows.map((row) => ({ skuId: row.skuId, lines: Number(row.lines), units: Number(row.units) }));
}
