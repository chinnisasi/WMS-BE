import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { rateCardLines, rateCards, type RateCard } from '../../shared/db/schema';
import { assertUtcIso, istDateOf } from '../../shared/primitives/time';
import { assertClientInTenantInTx, listClientsInTx } from '../clients/clients.facade';
import { getMemberClientIdIn } from '../tenancy/tenancy.service';
import { InventoryFacade } from '../inventory/inventory.facade';
import { MeteringService, type MeteredPeriod } from './metering';
import { StorageSnapshotService, type SnapshotTickResult, type SnapshotVerifyResult } from './storage-snapshot';
import { MAX_DRAFT_LIST, sortLines, type ChargeCode, type RateBasis, type RateCardStatus } from './rate-cards';
import { decodeCursor, type Page } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { PORTAL_PAGE_DEFAULT_LIMIT } from '../../shared/primitives/portal-page';
import { portalInvoiceInTx, portalInvoicesInTx, type PortalInvoiceDetail, type PortalInvoiceRow } from './portal-invoices';

export type { PortalInvoiceDetail, PortalInvoiceLine, PortalInvoiceParty, PortalInvoiceRow } from './portal-invoices';

const PORTAL_CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Story 21-7 — this facade's `decodeCursorSafe` copy (the house pattern): a crafted cursor is a 400, never a 500. */
function decodePortalCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    if (!UUID_RE.test(decoded.id) || !PORTAL_CURSOR_INSTANT_RE.test(decoded.createdAt) || Number.isNaN(Date.parse(decoded.createdAt))) {
      throw new Error('malformed cursor payload');
    }
    return decoded;
  } catch {
    throw new ProblemException('invalid-cursor', 400, 'Malformed pagination cursor', 'The cursor parameter is not a valid opaque page cursor.');
  }
}

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
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // Story 21-4 — metering and the storage snapshots, behind the same seam.
    // `forwardRef`: metering.ts imports this file's `rateCardSegmentsInTx`,
    // so the two files form an import cycle; the lazy token keeps the
    // injection independent of which file loads first.
    @Inject(forwardRef(() => MeteringService)) private readonly metering: MeteringService,
    @Inject(StorageSnapshotService) private readonly snapshots: StorageSnapshotService,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  // ── story 21-7: the client portal's invoice reads ─────────────────────────
  // AD-6: the owning module's facade, never the operator route. Two layers,
  // both required: the transaction is stamped with the client
  // (`{ clientId }` — RLS hides other clients' invoices AND drafts) and the
  // query carries `client_id = $client` and `status <> 'draft'`
  // (`portal-invoices.ts`). Decision 3: the invoice and its lines only.

  async portalInvoices(
    tenantId: string,
    clientId: string,
    query: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<Page<PortalInvoiceRow>> {
    const limit = query.limit ?? PORTAL_PAGE_DEFAULT_LIMIT;
    const before = query.cursor === undefined ? null : decodePortalCursor(query.cursor);
    return withTenantTransaction(this.db, tenantId, (tx) => portalInvoicesInTx(tx, tenantId, clientId, { before, limit }), {
      clientId,
    });
  }

  /** One non-draft invoice of this client, or null (unknown, another client's, or a draft → 404). */
  async portalInvoice(tenantId: string, clientId: string, invoiceId: string): Promise<PortalInvoiceDetail | null> {
    return withTenantTransaction(this.db, tenantId, (tx) => portalInvoiceInTx(tx, tenantId, clientId, invoiceId), { clientId });
  }

  /**
   * Story 21-4 — meter one client over an inclusive IST date period: each
   * charge's quantity per rate-card segment, priced. Member-open (like the
   * cards); 400 for a bad period, 404 for an unknown or foreign client.
   */
  async meterPeriod(tenantId: string, actorUserId: string, clientId: string, fromDate: string, toDate: string): Promise<MeteredPeriod> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // An operator read of commercial terms: a client-portal user (a user
      // carrying a client, AD-23) is refused, whichever client it asks for.
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) {
        throw new ProblemException(
          'role-denied',
          403,
          'Client-portal sessions cannot read usage',
          'Metered usage is an operator read; a client-portal user cannot read it.',
        );
      }
      return this.metering.meterPeriodInTx(tx, tenantId, clientId, fromDate, toDate);
    });
  }

  /**
   * Story 21-4 — the snapshot job's scopes for one tenant: every non-`self`
   * client × every warehouse it has a ledger event in (decision 4: the
   * tenant's own client is never snapshotted; a tenant with no client brand
   * yields nothing). Through the clients and inventory facades.
   */
  async snapshotScopesOf(tenantId: string): Promise<{ tenantId: string; clientId: string; warehouseId: string }[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const brands = (await listClientsInTx(tx, tenantId)).filter((client) => !client.systemOwned);
      if (brands.length === 0) return [];
      const pairs = await this.inventory.clientWarehousesWithEventsInTx(
        tx,
        tenantId,
        brands.map((client) => client.id),
      );
      return pairs.map((pair) => ({ tenantId, clientId: pair.clientId, warehouseId: pair.warehouseId }));
    });
  }

  /** Story 21-4 — one snapshot tick for one scope, in its own tenant transaction. */
  async snapshotScope(tenantId: string, clientId: string, warehouseId: string, nowMs: number): Promise<SnapshotTickResult> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.snapshots.snapshotScopeInTx(tx, tenantId, clientId, warehouseId, nowMs),
    );
  }

  /** Story 21-4 — the dry-run re-fold of one scope against its stored snapshots (writes nothing). */
  async verifySnapshots(tenantId: string, clientId: string, warehouseId: string): Promise<SnapshotVerifyResult> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.snapshots.verifySnapshotsInTx(tx, tenantId, clientId, warehouseId),
    );
  }

  /** Story 21-4 — rebuild one scope's snapshots from genesis through its watermark (the operator's `--write`). */
  async rebuildSnapshots(tenantId: string, clientId: string, warehouseId: string): Promise<SnapshotVerifyResult> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.snapshots.rebuildScopeInTx(tx, tenantId, clientId, warehouseId),
    );
  }

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
