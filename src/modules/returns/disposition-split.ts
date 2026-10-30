import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  clientReturnLines,
  clientReturns,
  returnAuthorizations,
  returnDispositions,
  returnHoldSettlements,
  returnReceiptLines,
  returnReceipts,
} from '../../shared/db/schema';
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
 *
 * Story 4-7c (decision 5, D6) — the return to client is the FOURTH
 * outcome, read from the module's own `client_return_lines`:
 * - `returningToClient` — Σ the line's claims on `draft` (`qty`) and
 *   `picked` (`picked_qty`) RTCs: units on a return shipment not yet gone;
 * - `returnedToClient` — Σ `picked_qty` of its lines on `dispatched` RTCs.
 * A cancelled RTC claims nothing. `rtcClaimed = returningToClient +
 * returnedToClient` joins the equation:
 * `open_qty = basis − restocked − scrapped − quarantined + returned − rtcClaimed`.
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
  /** Story 4-7c — on a draft or picked return to client (milli). */
  readonly returningToClient: number;
  /** Story 4-7c — shipped back to the client (milli). */
  readonly returnedToClient: number;
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
  returningToClient: 0,
  returnedToClient: 0,
};

/** Story 4-7c — the RTC statuses whose lines still claim their receipt line's units (dispatched stays claimed, as shipped). */
export const RTC_CLAIMING_STATUSES = ['draft', 'picked', 'dispatched'] as const;

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
  // Story 4-7c — the return-to-client claims of each line (own tables).
  const rtc = await tx
    .select({
      lineId: clientReturnLines.returnReceiptLineId,
      returning: sql<string>`coalesce(sum(case when ${clientReturns.status} = 'draft' then ${clientReturnLines.qty} else ${clientReturnLines.pickedQty} end) filter (where ${clientReturns.status} in ('draft', 'picked')), 0)::bigint`,
      returned: sql<string>`coalesce(sum(${clientReturnLines.pickedQty}) filter (where ${clientReturns.status} = 'dispatched'), 0)::bigint`,
    })
    .from(clientReturnLines)
    .innerJoin(clientReturns, and(eq(clientReturns.tenantId, clientReturnLines.tenantId), eq(clientReturns.id, clientReturnLines.clientReturnId)))
    .where(
      and(
        eq(clientReturnLines.tenantId, tenantId),
        inArray(clientReturnLines.returnReceiptLineId, ids),
        inArray(clientReturns.status, [...RTC_CLAIMING_STATUSES]),
      ),
    )
    .groupBy(clientReturnLines.returnReceiptLineId);
  const rtcByLine = new Map(rtc.map((row) => [row.lineId!, { returning: Number(row.returning), returned: Number(row.returned) }]));
  for (const row of sums) {
    const quarantined = Number(row.quarantined);
    const settledHeld = Number(row.settledHeld);
    const claim = rtcByLine.get(row.lineId);
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
      returningToClient: claim?.returning ?? 0,
      returnedToClient: claim?.returned ?? 0,
    });
  }
  // A line with RTC claims and no disposition row.
  for (const [lineId, claim] of rtcByLine) {
    if (out.has(lineId)) continue;
    out.set(lineId, { ...EMPTY_SPLIT, returningToClient: claim.returning, returnedToClient: claim.returned });
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
 * equal `basis − restocked − scrapped − quarantined + returned` over its own
 * rows. A mismatch is a typed 500 `data-fault` and the transaction rolls back
 * — nothing half-booked commits.
 *
 * Story 4-7b (A1, D1) — the BASIS is the line's `qty` when its RMA's review
 * is null (an authorized RMA) or `accepted`, and 0 while a blind RMA's
 * review is `pending` or once it is `rejected` (`open_qty` stays 0: nothing
 * can be dispositioned). The blind receipt, accept and reject assert it on
 * their lines, so the equation holds in every review state.
 */
export function dispositionBasis(qty: number, reviewStatus: string | null): number {
  return reviewStatus === null || reviewStatus === 'accepted' ? qty : 0;
}

export async function assertLinesConservedInTx(tx: TenantTx, tenantId: string, lineIds: readonly string[]): Promise<void> {
  const ids = [...new Set(lineIds)];
  if (ids.length === 0) return;
  const lines = await tx
    .select({
      id: returnReceiptLines.id,
      qty: returnReceiptLines.qty,
      openQty: returnReceiptLines.openQty,
      reviewStatus: returnAuthorizations.reviewStatus,
    })
    .from(returnReceiptLines)
    .innerJoin(
      returnReceipts,
      and(eq(returnReceipts.tenantId, returnReceiptLines.tenantId), eq(returnReceipts.id, returnReceiptLines.returnReceiptId)),
    )
    .innerJoin(
      returnAuthorizations,
      and(eq(returnAuthorizations.tenantId, returnReceipts.tenantId), eq(returnAuthorizations.id, returnReceipts.rmaId)),
    )
    .where(and(eq(returnReceiptLines.tenantId, tenantId), inArray(returnReceiptLines.id, ids)));
  const splits = await lineSplitsInTx(tx, tenantId, ids);
  for (const line of lines) {
    const split = splits.get(line.id) ?? EMPTY_SPLIT;
    const basis = dispositionBasis(Number(line.qty), line.reviewStatus);
    // Story 4-7c (D6) — the fourth outcome: the return-to-client claims.
    const rtcClaimed = split.returningToClient + split.returnedToClient;
    const expected = basis - split.restocked - split.scrapped - split.quarantined + split.returned - rtcClaimed;
    if (Number(line.openQty) !== expected || split.onHold < 0) {
      throw dispositionDataFault(
        `Return receipt line "${line.id}" does not conserve: open ${Number(line.openQty)} milli-units, but basis ${basis} (received ${Number(line.qty)}, review ${line.reviewStatus ?? 'none'}) − restocked ${split.restocked} − scrapped ${split.scrapped} − quarantined ${split.quarantined} + returned ${split.returned} − to client ${rtcClaimed} = ${expected}.`,
      );
    }
  }
  if (lines.length !== ids.length) {
    throw dispositionDataFault('A dispositioned return receipt line vanished inside its own transaction.');
  }
}
