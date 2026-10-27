import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { returnDispositions, returnHoldSettlements, returnReceiptLines } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * Story 4-7a (A1) — one return-receipt line's disposition split, milli-units,
 * from the returns module's OWN rows (never a cross-module read):
 *
 * - `restocked` / `scrapped` / `quarantined` — Σ the line's dispositions per
 *   outcome;
 * - `settledHeld` / `returned` / `failed` — Σ the settlements of its CLOSED
 *   return holds (written by the hold-settlement subscriber);
 * - `onHold = quarantined − settledHeld` — still on an open hold;
 * - `priorQuarantines` / `lastReasonCode` — the queue card's history (A14).
 *
 * Conservation: `qty = open_qty + restocked + scrapped + onHold + failed`,
 * i.e. `open_qty = qty − restocked − scrapped − quarantined + returned`.
 */
export interface LineSplit {
  readonly restocked: number;
  readonly scrapped: number;
  readonly quarantined: number;
  readonly settledHeld: number;
  readonly returned: number;
  readonly failed: number;
  readonly onHold: number;
  readonly priorQuarantines: number;
  readonly lastReasonCode: string | null;
}

export const EMPTY_SPLIT: LineSplit = {
  restocked: 0,
  scrapped: 0,
  quarantined: 0,
  settledHeld: 0,
  returned: 0,
  failed: 0,
  onHold: 0,
  priorQuarantines: 0,
  lastReasonCode: null,
};

/** The split of each named receipt line (a line with no disposition is absent — read it as `EMPTY_SPLIT`). */
export async function lineSplitsInTx(tx: TenantTx, tenantId: string, lineIds: readonly string[]): Promise<Map<string, LineSplit>> {
  const ids = [...new Set(lineIds)];
  const out = new Map<string, LineSplit>();
  if (ids.length === 0) return out;
  const sums = await tx
    .select({
      lineId: returnDispositions.returnReceiptLineId,
      restocked: sql<string>`coalesce(sum(${returnDispositions.qty}) filter (where ${returnDispositions.outcome} = 'restock'), 0)::bigint`,
      scrapped: sql<string>`coalesce(sum(${returnDispositions.qty}) filter (where ${returnDispositions.outcome} = 'scrap'), 0)::bigint`,
      quarantined: sql<string>`coalesce(sum(${returnDispositions.qty}) filter (where ${returnDispositions.outcome} = 'quarantine'), 0)::bigint`,
      quarantines: sql<string>`count(*) filter (where ${returnDispositions.outcome} = 'quarantine')::bigint`,
      settledHeld: sql<string>`coalesce(sum(${returnHoldSettlements.heldQty}), 0)::bigint`,
      returned: sql<string>`coalesce(sum(${returnHoldSettlements.returnedQty}), 0)::bigint`,
      failed: sql<string>`coalesce(sum(${returnHoldSettlements.failedQty}), 0)::bigint`,
    })
    .from(returnDispositions)
    .leftJoin(
      returnHoldSettlements,
      and(eq(returnHoldSettlements.tenantId, returnDispositions.tenantId), eq(returnHoldSettlements.dispositionId, returnDispositions.id)),
    )
    .where(and(eq(returnDispositions.tenantId, tenantId), inArray(returnDispositions.returnReceiptLineId, ids)))
    .groupBy(returnDispositions.returnReceiptLineId);
  // The latest quarantine or scrap reason per line (the queue card's "last reason").
  const reasons = await tx
    .selectDistinctOn([returnDispositions.returnReceiptLineId], {
      lineId: returnDispositions.returnReceiptLineId,
      reasonCode: returnDispositions.reasonCode,
    })
    .from(returnDispositions)
    .where(
      and(
        eq(returnDispositions.tenantId, tenantId),
        inArray(returnDispositions.returnReceiptLineId, ids),
        sql`${returnDispositions.reasonCode} is not null`,
      ),
    )
    .orderBy(returnDispositions.returnReceiptLineId, desc(returnDispositions.createdAt), desc(returnDispositions.id));
  const reasonByLine = new Map(reasons.map((row) => [row.lineId, row.reasonCode]));
  for (const row of sums) {
    const quarantined = Number(row.quarantined);
    const settledHeld = Number(row.settledHeld);
    out.set(row.lineId, {
      restocked: Number(row.restocked),
      scrapped: Number(row.scrapped),
      quarantined,
      settledHeld,
      returned: Number(row.returned),
      failed: Number(row.failed),
      onHold: quarantined - settledHeld,
      priorQuarantines: Number(row.quarantines),
      lastReasonCode: reasonByLine.get(row.lineId) ?? null,
    });
  }
  return out;
}

/** A broken invariant between the module's own rows — typed, 500 (the 13-1 shape). */
export function dispositionDataFault(detail: string): ProblemException {
  return new ProblemException('data-fault', 500, 'Return data is inconsistent', detail);
}

/**
 * Story 4-7a (A20) — the conservation assertion, run inside the writing
 * transaction AFTER the writes: every touched line's stored `open_qty` must
 * equal `qty − restocked − scrapped − quarantined + returned` over its own
 * rows. A mismatch is a typed 500 `data-fault` and the transaction rolls back
 * — nothing half-booked commits.
 */
export async function assertLinesConservedInTx(tx: TenantTx, tenantId: string, lineIds: readonly string[]): Promise<void> {
  const ids = [...new Set(lineIds)];
  if (ids.length === 0) return;
  const lines = await tx
    .select({ id: returnReceiptLines.id, qty: returnReceiptLines.qty, openQty: returnReceiptLines.openQty })
    .from(returnReceiptLines)
    .where(and(eq(returnReceiptLines.tenantId, tenantId), inArray(returnReceiptLines.id, ids)));
  const splits = await lineSplitsInTx(tx, tenantId, ids);
  for (const line of lines) {
    const split = splits.get(line.id) ?? EMPTY_SPLIT;
    const expected = Number(line.qty) - split.restocked - split.scrapped - split.quarantined + split.returned;
    if (Number(line.openQty) !== expected || split.onHold < 0) {
      throw dispositionDataFault(
        `Return receipt line "${line.id}" does not conserve: open ${Number(line.openQty)} milli-units, but received ${Number(line.qty)} − restocked ${split.restocked} − scrapped ${split.scrapped} − quarantined ${split.quarantined} + returned ${split.returned} = ${expected}.`,
      );
    }
  }
  if (lines.length !== ids.length) {
    throw dispositionDataFault('A dispositioned return receipt line vanished inside its own transaction.');
  }
}
