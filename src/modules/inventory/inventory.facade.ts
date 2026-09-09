import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { ledgerEvents } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { canonicalInstant, LedgerService } from './ledger.service';
import type {
  ChainAnchor,
  ChainBreakReport,
  ChainVerifyReport,
  DigestExport,
  RebuildReport,
  ReplayReport,
} from './ledger.service';
import { StockAdjustmentCommand } from './inventory.command';
import type { AdjustStockCommand, StockAdjustmentSnapshot } from './inventory.command';
import { ReconciliationService } from './reconcile';
import type { ReconcileReport } from './reconcile';
import { ReservationService } from './reservation.service';
import type {
  AtpSnapshot,
  GrantReservationCommand,
  ReservationRebuildReport,
  ReservationSnapshot,
} from './reservation.service';

/** One event-timeline row (the read model of the ledger). */
export interface LedgerTimelineEntry {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly skuId: string;
  readonly fromBinId: string | null;
  readonly toBinId: string | null;
  readonly quantityDelta: number;
  readonly actorUserId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly eventHash: string;
  readonly createdAt: string;
}

export interface LedgerTimelineQuery {
  readonly skuId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const DEFAULT_TIMELINE_PAGE_SIZE = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The cursor is opaque to clients but crafted input is still possible — a
 * base64-valid payload with a non-uuid `id` would otherwise reach the
 * `::uuid` cast in SQL and surface as a 500 instead of a 400 (the same
 * `decodeCursorSafe` pattern as the tenancy reads).
 */
/**
 * The cursor's `createdAt` is an instant the writer normalized through
 * `canonicalInstant` — accept exactly that ISO-8601 UTC shape (`Date.parse`
 * alone accepts far looser input, and the value reaches a `::timestamptz`
 * cast in SQL).
 */
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    const malformedCursor =
      !UUID_RE.test(decoded.id) || !CURSOR_INSTANT_RE.test(decoded.createdAt);
    if (malformedCursor) {
      throw new Error('malformed cursor payload');
    }
    return decoded;
  } catch {
    throw new ProblemException(
      'invalid-cursor',
      400,
      'Malformed pagination cursor',
      'The cursor parameter is not a valid opaque page cursor.',
    );
  }
}

/**
 * The inventory module's public surface (Story 2.1): the ONLY way any other
 * module — or the api shell — consumes stock state. The stock/ledger tables
 * are module-exclusive; the architecture test fails any write from outside
 * this module.
 */
@Injectable()
export class InventoryFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // No cycle: the command/facade layer consumes the ledger one-way.
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(StockAdjustmentCommand) private readonly stockAdjustment: StockAdjustmentCommand,
    // Continuous reconciliation (Story 2.2) — background work; the jobs shell
    // drives it through this facade. No HTTP route.
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    // Atomic reservations (Story 2.3) — the ONE atomic decision point for
    // sellable stock; consumed here (reads become HTTP in 2.5, order wiring
    // in Epic 4).
    @Inject(ReservationService) private readonly reservations: ReservationService,
  ) {}

  /** `stock.adjustment` — the first movement producer (Story 2.1). */
  async adjustStock(
    command: AdjustStockCommand,
    idempotencyKey: string,
  ): Promise<StockAdjustmentSnapshot> {
    return this.stockAdjustment.adjust(command, idempotencyKey).then((result) => result.snapshot);
  }

  /**
   * Event-timeline read (Story 2.1): one warehouse's ledger, newest first,
   * keyset cursor pagination (offset pagination is banned — UX-DR25),
   * optionally narrowed to one SKU. A read — never capability-gated; the
   * warehouse must belong to the tenant (404 otherwise).
   */
  async listEvents(
    tenantId: string,
    warehouseId: string,
    query: LedgerTimelineQuery = {},
  ): Promise<Page<LedgerTimelineEntry>> {
    // The route-level DTO already bounds `limit` (1..200) — pass it
    // straight through; clamping here would silently rewrite a bad
    // request instead of rejecting it.
    const pageSize = query.limit ?? DEFAULT_TIMELINE_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await tx
        .select({
          id: ledgerEvents.id,
          seq: ledgerEvents.seq,
          type: ledgerEvents.type,
          skuId: ledgerEvents.skuId,
          fromBinId: ledgerEvents.fromBinId,
          toBinId: ledgerEvents.toBinId,
          quantityDelta: ledgerEvents.quantityDelta,
          actorUserId: ledgerEvents.actorUserId,
          occurredAt: ledgerEvents.occurredAt,
          recordedAt: ledgerEvents.recordedAt,
          eventHash: ledgerEvents.eventHash,
          createdAt: ledgerEvents.createdAt,
        })
        .from(ledgerEvents)
        .where(
          and(
            eq(ledgerEvents.tenantId, tenantId),
            eq(ledgerEvents.warehouseId, warehouseId),
            query.skuId === undefined ? undefined : eq(ledgerEvents.skuId, query.skuId),
            before === undefined
              ? undefined
              : sql`(${ledgerEvents.createdAt}, ${ledgerEvents.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(ledgerEvents.createdAt), desc(ledgerEvents.id))
        .limit(pageSize + 1);
      // The rows carry `timestamptz` in Postgres's own text shape —
      // normalize every instant to the canonical ISO-8601 UTC form the
      // verifier and cursors rely on (one shared normalizer, no dup).
      const items = rows.map((row) => ({
        ...row,
        occurredAt: canonicalInstant(row.occurredAt),
        recordedAt: canonicalInstant(row.recordedAt),
        createdAt: canonicalInstant(row.createdAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * Replay (`replay(sku, bin)` — or the whole warehouse when the SKU is
   * omitted): events recomputed against the stored projection, exactly
   * equal or it fails loudly naming the divergent scope. Never auto-heals
   * — Story 2.2's continuous job consumes this.
   */
  async replay(
    tenantId: string,
    warehouseId: string,
    skuId?: string,
    binId?: string,
  ): Promise<ReplayReport> {
    return this.ledger.replay(tenantId, warehouseId, skuId, binId);
  }

  /** Chain verification — a break surfaces as a severity-1 alert. */
  async verifyChain(
    tenantId: string,
    warehouseId: string,
    fromSeq = 1,
    toSeq?: number,
  ): Promise<ChainVerifyReport | ChainBreakReport> {
    return this.ledger.verifyChain(tenantId, warehouseId, fromSeq, toSeq);
  }

  /**
   * Anchors the chain head (or the tail since the last anchor) — after
   * verify-before-anchor: a tampered range returns the `ChainBreakReport`
   * and commits no anchor row.
   */
  async anchorChain(
    tenantId: string,
    warehouseId: string,
    uptoSeq?: number,
  ): Promise<ChainAnchor | ChainBreakReport> {
    return this.ledger.anchorChain(tenantId, warehouseId, uptoSeq);
  }

  /** Verifiable digest export over an event range (on-demand artifact). */
  async exportDigest(
    tenantId: string,
    warehouseId: string,
    fromSeq: number,
    toSeq: number,
  ): Promise<DigestExport> {
    return this.ledger.exportDigest(tenantId, warehouseId, fromSeq, toSeq);
  }

  /**
   * Continuous replay-reconciliation (Story 2.2): one (tenant, warehouse)
   * cycle — validate the checkpoint, replay-fold to the watermark, handle
   * divergence (rebuild + alert; repeat → quarantine + re-alert), advance
   * the checkpoint only on a clean pass. Background work: no HTTP route.
   */
  async reconcile(tenantId: string, warehouseId: string): Promise<ReconcileReport> {
    return this.reconciliation.reconcile(tenantId, warehouseId);
  }

  /**
   * The jobs-shell worker's entry: one partition per tick,
   * oldest-checkpoint-first — or null when every partition is reconciled
   * through its head.
   */
  async reconcileNext(): Promise<ReconcileReport | null> {
    return this.reconciliation.reconcileNext();
  }

  /**
   * Derived-state repair (Story 2.2, for tests/operator use): rewrites
   * `stock_on_hand` to the replayed quantities for the requested scope (or
   * every divergent scope when omitted) — alert + rebuild in one commit.
   */
  async rebuildProjections(
    tenantId: string,
    warehouseId: string,
    scope?: { skuId?: string; binId?: string },
  ): Promise<RebuildReport> {
    return this.ledger.rebuildProjections(tenantId, warehouseId, scope);
  }

  /**
   * Grants one reservation hold (Story 2.3): the atomic decision point —
   * idempotent per owner scope; the race loser gets the deterministic 409
   * `unavailable`. No HTTP route in this story (reads become HTTP in 2.5).
   */
  async grantReservation(command: GrantReservationCommand): Promise<ReservationSnapshot> {
    return this.reservations.grant(command);
  }

  /** `held → committed` — serialized, exactly one terminal winner. */
  async commitReservation(tenantId: string, reservationId: string): Promise<ReservationSnapshot> {
    return this.reservations.commit(tenantId, reservationId);
  }

  /** `held → released` — restores the reserved counter. */
  async releaseReservation(tenantId: string, reservationId: string): Promise<ReservationSnapshot> {
    return this.reservations.release(tenantId, reservationId);
  }

  /** Real-time ATP: on-hand (quarantine-excluded) − reserved − hooks. */
  async atp(tenantId: string, warehouseId: string, skuId: string): Promise<AtpSnapshot> {
    return this.reservations.atp(tenantId, warehouseId, skuId);
  }

  /** Rebuilds the Valkey reserved counters from the journal (Postgres wins). */
  async rebuildReservationCounters(
    tenantId: string,
    warehouseId?: string,
  ): Promise<ReservationRebuildReport[]> {
    return this.reservations.rebuildCounters(tenantId, warehouseId);
  }

  /**
   * The reaper's entry: expires every held row past its TTL (serialized
   * terminal transitions) and restores the counters. Returns the count.
   */
  async expireDueReservations(): Promise<number> {
    return this.reservations.expireDue();
  }
}
