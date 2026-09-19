/**
 * The handling-unit write seam (Story 10.3) — **the one place `handling_units`
 * is written.**
 *
 * `serials` has exactly one writer, `CatalogFacade.ensureSerials`, and every
 * other module reads it or goes through the facade. This table copies that
 * seam rather than its shape. The difference is that a handling unit has FOUR
 * transitions reached from THREE different sibling modules — create at
 * receipt, settle an over-receipt intake, pack, adjust away — so the seam is
 * written out as in-transaction functions here and `CatalogFacade` delegates
 * to them. One implementation, two access shapes, both catalog-owned;
 * `test/architecture.spec.ts` fails the build for a write anywhere else.
 *
 * **Why file-level functions and not facade methods alone.** The inventory
 * module cannot import `CatalogModule`: catalog reaches tenancy, tenancy
 * reaches putaway, and putaway reaches inventory, so the module edge is a
 * module-evaluation cycle rather than merely a DI one, and `forwardRef` does
 * not help with a cycle the `import` statement itself creates. This repo
 * already has the escape and uses it in both directions — `ensureReceivingBinInTx`
 * (tenancy's, imported by inbound) and `openQcHoldsForBinsInTx` (inbound's,
 * imported by tenancy) are file-level in-tx helpers for exactly this reason.
 *
 * **Every function runs on the CALLER's transaction and opens none of its
 * own.** A unit row is created in the same commit as the GRN that produced
 * it and flipped in the same commit as the pack or adjustment that consumed
 * it; split apart, a crash either ships a case the system still calls live or
 * consumes one the order never shipped. (A nested pool-opening read from
 * catalog is also the exact shape that deadlocked the device catalog snapshot
 * once already — see `catalog.facade.ts`.)
 *
 * Nothing here converts, scales or compares a quantity: a captured weight is
 * integer grams and stays integer grams.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { handlingUnits } from '../../shared/db/schema';
import type { HandlingUnit } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import type { HandlingUnitStatus } from './handling-unit';

/**
 * Rows per INSERT statement. Postgres binds at most 65,535 parameters per
 * statement and each unit tuple carries nine columns, so a single-statement
 * insert dies with an untyped 500 somewhere past ~7,280 units. Chunked at the
 * catalog import's own 2,000, which leaves the same headroom it does.
 */
const INSERT_CHUNK_ROWS = 2_000;

/**
 * One physical handling unit of a catch-weight SKU. Unlike a serial, this
 * shape answers from its OWN columns — nothing in the ledger names it between
 * receipt and pack, and it does not pretend otherwise.
 */
export interface HandlingUnitIdentity {
  readonly id: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly batchId: string | null;
  readonly grnLineId: string;
  /** Integer grams, captured at receipt — immutable. Never a quantity. */
  readonly weightGrams: number;
  readonly status: HandlingUnitStatus;
  readonly packedOrderLineId: string | null;
}

/** One unit to create at receipt — the only moment a weight is ever captured. */
export interface CreateHandlingUnitInput {
  readonly warehouseId: string;
  readonly skuId: string;
  readonly batchId: string | null;
  readonly grnLineId: string;
  readonly weightGrams: number;
  /**
   * `active` for the slice of the receipt the PO's open quantity covers;
   * `pending_approval` for the excess, which becomes `active` or `rejected`
   * when the over-receipt is decided. Never anything else — a unit is not
   * born packed or rejected.
   */
  readonly status: Extract<HandlingUnitStatus, 'active' | 'pending_approval'>;
}

/** One unit consumed into an order line at the bench (the set-once link). */
export interface HandlingUnitPackAssignment {
  readonly id: string;
  readonly orderLineId: string;
}

/**
 * Create one row per physical unit received — the ONLY moment a catch weight
 * is ever captured (decision 1: capture once at receipt, carry, never
 * re-weigh).
 *
 * Deliberately NOT idempotent by construction the way `ensureBatches` is:
 * there is no natural key to conflict on, because two cases of beef at the
 * same weight really are two cases. The receipt command's own idempotency
 * replay lookup is what makes a re-submitted GRN create no second row — which
 * is why this must be called from BEHIND that lookup, never in front of it.
 *
 * The ids are minted here and the result is built from them, aligned to the
 * caller's input order — never read back out of `.returning()`. The receipt's
 * unit *i* IS weight *i*, and the GRN snapshot (and the printed unit label)
 * depends on that alignment; leaning on a statement's row-return order for it
 * would be a silent, untested assumption about the driver.
 */
export async function createHandlingUnitsInTx(
  tx: TenantTx,
  tenantId: string,
  inputs: readonly CreateHandlingUnitInput[],
): Promise<HandlingUnitIdentity[]> {
  if (inputs.length === 0) {
    return [];
  }
  const values = inputs.map((input) => ({
    id: uuidv7(),
    tenantId,
    warehouseId: input.warehouseId,
    skuId: input.skuId,
    batchId: input.batchId,
    grnLineId: input.grnLineId,
    weightGrams: input.weightGrams,
    status: input.status,
    packedOrderLineId: null,
  }));
  for (let at = 0; at < values.length; at += INSERT_CHUNK_ROWS) {
    await tx.insert(handlingUnits).values(values.slice(at, at + INSERT_CHUNK_ROWS));
  }
  return values.map((row) => ({
    id: row.id,
    warehouseId: row.warehouseId,
    skuId: row.skuId,
    batchId: row.batchId,
    grnLineId: row.grnLineId,
    weightGrams: row.weightGrams,
    status: row.status as HandlingUnitStatus,
    packedOrderLineId: null,
  }));
}

/**
 * The over-receipt decision, applied to the units that pended with it:
 * `pending_approval → active` on approve, `→ rejected` on reject.
 *
 * Neither arm creates or destroys a row. The physical case arrived either
 * way, and a receipt that pretended otherwise would leave the warehouse with a
 * case nothing in the system can name. Scoped to the GRN LINE, because that is
 * what an `over_receipts` row is scoped to.
 *
 * Conditional on `pending_approval`, so a second decision (which the
 * over-receipt command already refuses with a 409) could not re-flip a unit
 * that has since been packed or written off.
 */
export async function settleHandlingUnitIntakeInTx(
  tx: TenantTx,
  tenantId: string,
  grnLineId: string,
  decision: 'approve' | 'reject',
): Promise<HandlingUnitIdentity[]> {
  const rows = await tx
    .update(handlingUnits)
    .set({
      status: decision === 'approve' ? 'active' : 'rejected',
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(handlingUnits.tenantId, tenantId),
        eq(handlingUnits.grnLineId, grnLineId),
        eq(handlingUnits.status, 'pending_approval'),
      ),
    )
    .returning();
  return rows.map(toHandlingUnitIdentity);
}

/**
 * The units named in a write-off adjustment leave `active`.
 *
 * Without this, pack FAILS OPEN: a case written off as damaged would still
 * pass pack's unknown/duplicate/already-packed checks and ship. `rejected` is
 * the terminal arm it lands in — the four-value vocabulary has no separate
 * "adjusted" state, and inventing one would mean a fifth arm every allow-list
 * in the system would have to learn.
 *
 * Conditional on `active`; the caller has already locked and guarded the rows,
 * so a short return is the backstop rather than the gate.
 */
export async function markHandlingUnitsAdjustedInTx(
  tx: TenantTx,
  tenantId: string,
  ids: readonly string[],
): Promise<HandlingUnitIdentity[]> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) {
    return [];
  }
  const rows = await tx
    .update(handlingUnits)
    .set({ status: 'rejected', updatedAt: nowIso() })
    .where(
      and(
        eq(handlingUnits.tenantId, tenantId),
        inArray(handlingUnits.id, distinct),
        eq(handlingUnits.status, 'active'),
      ),
    )
    .returning();
  return rows.map(toHandlingUnitIdentity);
}

/**
 * `active → packed`, stamping the order line the unit was consumed into — the
 * one written-later column in this schema, and the one transition that decides
 * what a customer is invoiced.
 *
 * It is a SET-ONCE link with no precedent here to lean on (`serials.status`
 * exists but nothing updates it), so it stands on its merits: a case ships
 * exactly once, so a link table would add a join for nothing, and the single
 * `active → packed` transition is exactly the conditional terminal write the
 * command skeleton already prescribes — `.where(status = 'active')`, an empty
 * result being the caller's 409.
 *
 * One statement per ORDER LINE, not per unit: every unit on a line takes the
 * same `packed_order_line_id`, so they batch into one `inArray` update. A
 * statement per unit made the cost of a pack linear in the number of cases in
 * the parcel, for no benefit — the conditional predicate is per row either
 * way, and a short return still names exactly which ids were refused.
 */
export async function markHandlingUnitsPackedInTx(
  tx: TenantTx,
  tenantId: string,
  assignments: readonly HandlingUnitPackAssignment[],
): Promise<HandlingUnitIdentity[]> {
  const byOrderLine = new Map<string, string[]>();
  for (const assignment of assignments) {
    const list = byOrderLine.get(assignment.orderLineId) ?? [];
    list.push(assignment.id);
    byOrderLine.set(assignment.orderLineId, list);
  }
  const packed: HandlingUnitIdentity[] = [];
  const at = nowIso();
  for (const [orderLineId, ids] of byOrderLine) {
    const rows = await tx
      .update(handlingUnits)
      .set({ status: 'packed', packedOrderLineId: orderLineId, updatedAt: at })
      .where(
        and(
          eq(handlingUnits.tenantId, tenantId),
          inArray(handlingUnits.id, ids),
          // The conditional terminal write: a unit already packed, rejected or
          // still pending approval matches nothing and comes back empty.
          eq(handlingUnits.status, 'active'),
        ),
      )
      .returning();
    for (const row of rows) {
      packed.push(toHandlingUnitIdentity(row));
    }
  }
  return packed;
}

/**
 * The read every consuming path guards against, with the rows LOCKED.
 *
 * `for('update')` is what makes the guards above it real: the caller decides
 * 404 / 422 / 409 from these rows and then writes conditionally, and without
 * the lock a concurrent pack of the same case could settle in between. Only
 * rows of THIS tenant come back — an unknown id and another tenant's id are
 * the same answer (absent), so existence never leaks. Id-sorted, so two
 * commands naming overlapping sets queue instead of deadlocking (the
 * `lockSerialsInTx` rule).
 */
export async function lockHandlingUnitsInTx(
  tx: TenantTx,
  tenantId: string,
  ids: readonly string[],
): Promise<HandlingUnitIdentity[]> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) {
    return [];
  }
  const rows = await tx
    .select()
    .from(handlingUnits)
    .where(and(eq(handlingUnits.tenantId, tenantId), inArray(handlingUnits.id, distinct)))
    .orderBy(handlingUnits.id)
    .for('update');
  return rows.map(toHandlingUnitIdentity);
}

/**
 * How many units of this SKU are still LIVE — `active` or `pending_approval`.
 *
 * The one question `SkuCommand.edit` has to ask before it lets
 * `catch_weight_tracked` move: turning it OFF strands live units, whose stock
 * then ships uncounted by any case; turning it ON leaves existing on-hand
 * backed by no unit at all, which wedges pack forever. A SKU with no live
 * units has no such history to contradict.
 */
export async function countLiveHandlingUnitsInTx(
  tx: TenantTx,
  tenantId: string,
  skuId: string,
): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(handlingUnits)
    .where(
      and(
        eq(handlingUnits.tenantId, tenantId),
        eq(handlingUnits.skuId, skuId),
        inArray(handlingUnits.status, ['active', 'pending_approval']),
      ),
    );
  return rows[0]?.n ?? 0;
}

/** One `handling_units` row as the seam hands it across the module boundary. */
function toHandlingUnitIdentity(row: HandlingUnit): HandlingUnitIdentity {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    skuId: row.skuId,
    batchId: row.batchId,
    grnLineId: row.grnLineId,
    weightGrams: row.weightGrams,
    status: row.status as HandlingUnitStatus,
    packedOrderLineId: row.packedOrderLineId,
  };
}
