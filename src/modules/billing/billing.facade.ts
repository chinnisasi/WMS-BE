import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { rateCardLines, rateCards, type RateCard } from '../../shared/db/schema';
import { assertUtcIso, istDateOf } from '../../shared/primitives/time';
import { assertClientInTenantInTx } from '../clients/clients.facade';
import { MAX_DRAFT_LIST, sortLines, type ChargeCode, type RateBasis, type RateCardStatus } from './rate-cards';

/** One priced line as every read returns it. */
export interface RateCardLineSnapshot {
  readonly chargeCode: ChargeCode;
  readonly basis: RateBasis;
  /** Integer paise per unit of the basis, GST-exclusive. */
  readonly amountPaise: number;
}

/**
 * One rate card as every read (and every mutation's idempotency snapshot)
 * returns it. Effective boundaries are on the wire as IST dates
 * (`YYYY-MM-DD`); the stored value is the IST-midnight instant the date
 * begins (`effectiveFromAt` / `effectiveToAt` carry it for facade callers).
 */
export interface RateCardSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly status: RateCardStatus;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly effectiveFromAt: string | null;
  readonly effectiveToAt: string | null;
  readonly lines: readonly RateCardLineSnapshot[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedBy: string | null;
  readonly activatedAt: string | null;
  readonly cancelledBy: string | null;
  readonly cancelledAt: string | null;
}

/** One stretch of a period priced by one card: `[from, to)` clipped to the period. */
export interface RateCardSegment {
  readonly card: RateCardSnapshot;
  readonly lines: readonly RateCardLineSnapshot[];
  /** ISO-8601 UTC instant, inclusive. */
  readonly from: string;
  /** ISO-8601 UTC instant, exclusive. */
  readonly to: string;
}

const iso = (value: string | null): string | null => (value === null ? null : new Date(value).toISOString());

export function toRateCardSnapshot(
  row: RateCard,
  lines: readonly { chargeCode: string; basis: string; amountPaise: number }[],
): RateCardSnapshot {
  const effectiveFromAt = iso(row.effectiveFrom);
  const effectiveToAt = iso(row.effectiveTo);
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    status: row.status as RateCardStatus,
    effectiveFrom: effectiveFromAt === null ? null : istDateOf(effectiveFromAt),
    effectiveTo: effectiveToAt === null ? null : istDateOf(effectiveToAt),
    effectiveFromAt,
    effectiveToAt,
    lines: sortLines(lines).map((line) => ({
      chargeCode: line.chargeCode as ChargeCode,
      basis: line.basis as RateBasis,
      amountPaise: Number(line.amountPaise),
    })),
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    activatedBy: row.activatedBy,
    activatedAt: iso(row.activatedAt),
    cancelledBy: row.cancelledBy,
    cancelledAt: iso(row.cancelledAt),
  };
}

/** The lines of several cards, one query, grouped by card id. */
export async function linesByCardInTx(
  tx: TenantTx,
  tenantId: string,
  cardIds: readonly string[],
): Promise<Map<string, { chargeCode: string; basis: string; amountPaise: number }[]>> {
  const grouped = new Map<string, { chargeCode: string; basis: string; amountPaise: number }[]>();
  if (cardIds.length === 0) return grouped;
  const rows = await tx
    .select({
      rateCardId: rateCardLines.rateCardId,
      chargeCode: rateCardLines.chargeCode,
      basis: rateCardLines.basis,
      amountPaise: rateCardLines.amountPaise,
    })
    .from(rateCardLines)
    .where(and(eq(rateCardLines.tenantId, tenantId), inArray(rateCardLines.rateCardId, [...new Set(cardIds)])));
  for (const row of rows) {
    const list = grouped.get(row.rateCardId) ?? [];
    list.push(row);
    grouped.set(row.rateCardId, list);
  }
  return grouped;
}

async function snapshotsOf(tx: TenantTx, tenantId: string, rows: readonly RateCard[]): Promise<RateCardSnapshot[]> {
  const lines = await linesByCardInTx(
    tx,
    tenantId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toRateCardSnapshot(row, lines.get(row.id) ?? []));
}

/**
 * The billing module's read seam (story 21-3, AD-6). Sibling modules — 21-4
 * metering, 21-5 client invoices — reach rate cards ONLY through this file:
 * the file-level `…InTx` functions on the caller's transaction, the
 * injectable facade on its own.
 */
@Injectable()
export class BillingFacade {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * A client's cards: drafts first (the newest `MAX_DRAFT_LIST`, newest
   * first), then EVERY dated card by `effective_from` descending — a dated
   * card is never dropped by the bound. Member-open. 404 for an unknown or
   * foreign client.
   */
  async listRateCards(tenantId: string, clientId: string): Promise<RateCardSnapshot[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertClientInTenantInTx(tx, tenantId, clientId);
      const scope = and(eq(rateCards.tenantId, tenantId), eq(rateCards.clientId, clientId));
      const drafts = await tx
        .select()
        .from(rateCards)
        .where(and(scope, eq(rateCards.status, 'draft')))
        .orderBy(desc(rateCards.createdAt), desc(rateCards.id))
        .limit(MAX_DRAFT_LIST);
      const dated = await tx
        .select()
        .from(rateCards)
        .where(and(scope, isNotNull(rateCards.effectiveFrom)))
        .orderBy(sql`${rateCards.effectiveFrom} desc`, desc(rateCards.createdAt), desc(rateCards.id));
      return snapshotsOf(tx, tenantId, [...drafts, ...dated]);
    });
  }

  /** One card, 404 for an unknown or foreign id. */
  async getRateCard(tenantId: string, rateCardId: string): Promise<RateCardSnapshot> {
    return withTenantTransaction(this.db, tenantId, (tx) => getRateCardInTx(tx, tenantId, rateCardId));
  }

  /** The card in force for a client at an instant (null = none), 404 for an unknown client. */
  async rateCardInForce(tenantId: string, clientId: string, instant: string): Promise<RateCardSnapshot | null> {
    return withTenantTransaction(this.db, tenantId, (tx) => rateCardInForceInTx(tx, tenantId, clientId, instant));
  }
}

export async function getRateCardInTx(tx: TenantTx, tenantId: string, rateCardId: string): Promise<RateCardSnapshot> {
  const rows = await tx
    .select()
    .from(rateCards)
    .where(and(eq(rateCards.tenantId, tenantId), eq(rateCards.id, rateCardId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw rateCardNotFound(rateCardId);
  return (await snapshotsOf(tx, tenantId, [row]))[0]!;
}

/** Cards that have ever been dated and not withdrawn: the in-force candidates. */
const IN_FORCE_STATUSES = ['active', 'superseded'] as const;

/**
 * The card in force for `clientId` at `instant`: the `active` or
 * `superseded` card with `effective_from ≤ instant < coalesce(effective_to,
 * ∞)` — at most one by construction (activation orders the dates strictly
 * and closes the predecessor at the successor's date). A `cancelled` card is
 * never in force; a draft has no date. Null when none applies.
 */
export async function rateCardInForceInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  instant: string,
): Promise<RateCardSnapshot | null> {
  // A silent null for an unknown client would read as "not billed" to 21-4.
  await assertClientInTenantInTx(tx, tenantId, clientId);
  const at = strictInstant(instant);
  const rows = await tx
    .select()
    .from(rateCards)
    .where(
      and(
        eq(rateCards.tenantId, tenantId),
        eq(rateCards.clientId, clientId),
        inArray(rateCards.status, [...IN_FORCE_STATUSES]),
        lte(rateCards.effectiveFrom, at),
        or(isNull(rateCards.effectiveTo), gt(rateCards.effectiveTo, at)),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    // The invariant the triggers and the activation lock keep — a loud
    // internal failure, never a silent pick of one of two prices.
    throw new Error(`rate cards: ${rows.length} cards in force for client ${clientId} at ${instant}`);
  }
  const row = rows[0];
  return row === undefined ? null : (await snapshotsOf(tx, tenantId, [row]))[0]!;
}

/**
 * Story 21-3 — the cards covering `[from, to)` for a client, each clipped to
 * the period and ordered by time: `[{card, lines, from, to}]`. A period that
 * spans a rate change yields one segment per card (decision 5: 21-5 records
 * the card on each invoice line, so a mid-period change splits the line).
 * Gaps (no card in force) yield no segment — that stretch is not billed.
 */
export async function rateCardSegmentsInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  from: string,
  to: string,
): Promise<RateCardSegment[]> {
  await assertClientInTenantInTx(tx, tenantId, clientId);
  const fromIso = strictInstant(from);
  const toIso = strictInstant(to);
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (fromMs >= toMs) {
    throw new Error(`rateCardSegmentsInTx: [${from}, ${to}) is not a period`);
  }
  const rows = await tx
    .select()
    .from(rateCards)
    .where(
      and(
        eq(rateCards.tenantId, tenantId),
        eq(rateCards.clientId, clientId),
        inArray(rateCards.status, [...IN_FORCE_STATUSES]),
        lt(rateCards.effectiveFrom, toIso),
        or(isNull(rateCards.effectiveTo), gt(rateCards.effectiveTo, fromIso)),
      ),
    )
    .orderBy(asc(rateCards.effectiveFrom));
  const cards = await snapshotsOf(tx, tenantId, rows);
  return cards.map((card) => {
    const cardFrom = Date.parse(card.effectiveFromAt!);
    const cardTo = card.effectiveToAt === null ? Number.POSITIVE_INFINITY : Date.parse(card.effectiveToAt);
    return {
      card,
      lines: card.lines,
      from: new Date(Math.max(cardFrom, fromMs)).toISOString(),
      to: new Date(Math.min(cardTo, toMs)).toISOString(),
    };
  });
}

/**
 * The strict UTC parser (`assertUtcIso` — a `Z`-suffixed instant whose parts
 * exist) and the normalised ISO form that is bound into the query, so an
 * offset or a local time can never shift a billing boundary.
 */
function strictInstant(value: string): string {
  return new Date(assertUtcIso(value)).toISOString();
}

export function rateCardNotFound(rateCardId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Rate card not found',
    `No rate card with id "${rateCardId}" exists in this tenant.`,
  );
}
