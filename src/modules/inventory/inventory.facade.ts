import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { batchOnHand, ledgerEvents, stockOnHand } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { canonicalInstant, LedgerService } from './ledger.service';
import type { LedgerMovement } from './ledger.service';
import type { LedgerReferenceDoc } from './ledger-registry';
import type { TenantTx } from '../../shared/db/tenant-scope';

// The facade is the only sibling-facing seam (architecture test): the
// movement shape rides along so cross-module producers import the type here,
// never from the ledger service internals.
export type { LedgerMovement, AppendedMovement } from './ledger.service';
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

/**
 * One event-timeline row (the read model of the ledger). Story 2.5 adds the
 * additive traceability passthroughs: `batchRef` / `serialRef` (the 2.4 arms
 * — null on every arm-less event, so legacy items serialize identically
 * apart from the new null fields) and `referenceDoc` (the typed reference
 * union arm itself — `{kind, reasonCode, note, overrideReason?}` today,
 * extended additively by future event kinds).
 */
export interface LedgerTimelineEntry {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly skuId: string;
  readonly fromBinId: string | null;
  readonly toBinId: string | null;
  readonly quantityDelta: number;
  readonly batchRef: string | null;
  readonly serialRef: string | null;
  readonly referenceDoc: LedgerReferenceDoc;
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

/** One per-batch on-hand row (Story 2.4 — the batch-arm sibling of on-hand). */
export interface BatchOnHandEntry {
  readonly warehouseId: string;
  readonly skuId: string;
  readonly binId: string;
  readonly batchId: string;
  readonly quantity: number;
}

/**
 * One per-bin on-hand row of a tenant-wide batch read (Story 2.5) — the
 * batch detail's "where the stock lives" rows. `batchId` is the query key
 * (implied); the skuId rides along for parity/diagnostics only — the api
 * layer performs no cross-check against it.
 */
export interface BatchBinOnHandEntry {
  readonly warehouseId: string;
  readonly skuId: string;
  readonly binId: string;
  readonly quantity: number;
}

/**
 * One on-hand projection row of the Story 2.5 stock list — plain
 * `stock_on_hand` truth for any SKU (tracked or not; no batch fields — the
 * untracked passthrough is the row itself).
 */
export interface StockOnHandEntry {
  readonly id: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly binId: string;
  readonly quantity: number;
  readonly createdAt: string;
}

/** Query of the Story 2.5 stock-list read (keyset cursor pagination). */
export interface StockListQuery {
  readonly skuId?: string | undefined;
  readonly binId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** One ledger event of a serial's movement history (oldest first). */
export interface SerialLedgerEntry {
  readonly warehouseId: string;
  readonly seq: number;
  readonly type: string;
  readonly skuId: string;
  readonly quantityDelta: number;
  readonly fromBinId: string | null;
  readonly toBinId: string | null;
  readonly batchRef: string | null;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly eventHash: string;
}

/** One ledger event of a batch's movement history (oldest first). */
export interface BatchLedgerEntry {
  readonly warehouseId: string;
  readonly seq: number;
  readonly type: string;
  readonly skuId: string;
  readonly quantityDelta: number;
  readonly fromBinId: string | null;
  readonly toBinId: string | null;
  readonly serialRef: string | null;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly eventHash: string;
}

/** A serial's derived current location (the ledger's latest event's bin). */
export interface SerialLocation {
  readonly warehouseId: string;
  readonly binId: string;
}

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
   * The in-transaction ledger passthrough (Story 3.3): a caller that composes
   * a ledger event into a larger write in ONE transaction (the GRN command —
   * GRN rows + batch identity + ledger events + relational state) appends
   * through here inside its own tenant transaction. Same contract as
   * `LedgerService.appendMovement` — registry-gated type, hash chain, the
   * caller's advisory locks; the caller owns the warehouse lock ordering.
   */
  async appendLedgerEventInTx(tx: TenantTx, movement: LedgerMovement) {
    return this.ledger.appendMovement(tx, movement);
  }

  /**
   * The adjustment's idempotency fingerprint (Story 2.4, review loop 1):
   * command-owned hashing exposed for the api layer's replay pre-check —
   * the api layer never hashes payload bytes itself.
   */
  adjustmentFingerprint(command: AdjustStockCommand): string {
    return this.stockAdjustment.fingerprint(command);
  }

  /**
   * The replay pre-check (review loop 1 — "replay beats composition"):
   * returns the stored snapshot for (tenant, key) when the payload hash
   * matches — BEFORE the api layer runs any composition (identity ensure,
   * tracked-SKU validation, FEFO resolution), so a retry of a succeeded
   * draw replays even when the FEFO batch has since been exhausted. A hash
   * mismatch throws the command-owned 422 `idempotency-key-reuse`; no row
   * returns null and the caller proceeds to composition.
   */
  async replayAdjustment(
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<StockAdjustmentSnapshot | null> {
    return this.stockAdjustment.replayPriorSnapshot(tenantId, idempotencyKey, payloadHash);
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
          // Story 2.5's additive traceability passthroughs — null arms on
          // arm-less (legacy) events, the reference doc verbatim (jsonb).
          batchRef: ledgerEvents.batchRef,
          serialRef: ledgerEvents.serialRef,
          referenceDoc: ledgerEvents.referenceDoc,
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
        // jsonb selects as `unknown` — the timeline's typed passthrough (the
        // verifier's own cast pattern, ledger.service).
        referenceDoc: row.referenceDoc as LedgerReferenceDoc,
        occurredAt: canonicalInstant(row.occurredAt),
        recordedAt: canonicalInstant(row.recordedAt),
        createdAt: canonicalInstant(row.createdAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * Stock-list read (Story 2.5): one warehouse's on-hand projection, keyset
   * cursor pagination exactly like `listEvents` (the table carries both
   * `created_at` and `id`), optionally narrowed to one SKU and/or one bin.
   * Plain `stock_on_hand` rows — tracked and untracked SKUs alike, no batch
   * fields (the untracked passthrough is the row itself). A read — never
   * capability-gated; the warehouse must belong to the tenant (404
   * otherwise).
   */
  async listStock(
    tenantId: string,
    warehouseId: string,
    query: StockListQuery = {},
  ): Promise<Page<StockOnHandEntry>> {
    // The route-level DTO already bounds `limit` (1..200) — pass it
    // straight through; clamping here would silently rewrite a bad
    // request instead of rejecting it.
    const pageSize = query.limit ?? DEFAULT_TIMELINE_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await tx
        .select({
          id: stockOnHand.id,
          warehouseId: stockOnHand.warehouseId,
          skuId: stockOnHand.skuId,
          binId: stockOnHand.binId,
          quantity: stockOnHand.quantity,
          createdAt: stockOnHand.createdAt,
        })
        .from(stockOnHand)
        .where(
          and(
            eq(stockOnHand.tenantId, tenantId),
            eq(stockOnHand.warehouseId, warehouseId),
            query.skuId === undefined ? undefined : eq(stockOnHand.skuId, query.skuId),
            query.binId === undefined ? undefined : eq(stockOnHand.binId, query.binId),
            before === undefined
              ? undefined
              : sql`(${stockOnHand.createdAt}, ${stockOnHand.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(stockOnHand.createdAt), desc(stockOnHand.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        ...row,
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

  // ── Story 2.4 traceability reads (facade-only; HTTP surfaces in 2.5) ────

  /**
   * Per-batch on-hand (Story 2.4): the `batch_on_hand` projection read —
   * inventory's half of the api layer's FEFO join (catalog owns expiry).
   * Scoped to the warehouse, optionally to one SKU and/or one bin (the FEFO
   * composition reads one bin's batches; pick-order composition in Epic 4
   * consumes the same rows). A read — never capability-gated; the warehouse
   * must belong to the tenant (404 otherwise).
   */
  async batchOnHand(
    tenantId: string,
    warehouseId: string,
    query: { skuId?: string | undefined; binId?: string | undefined } = {},
  ): Promise<BatchOnHandEntry[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      return tx
        .select({
          warehouseId: batchOnHand.warehouseId,
          skuId: batchOnHand.skuId,
          binId: batchOnHand.binId,
          batchId: batchOnHand.batchId,
          quantity: batchOnHand.quantity,
        })
        .from(batchOnHand)
        .where(
          and(
            eq(batchOnHand.tenantId, tenantId),
            eq(batchOnHand.warehouseId, warehouseId),
            query.skuId === undefined ? undefined : eq(batchOnHand.skuId, query.skuId),
            query.binId === undefined ? undefined : eq(batchOnHand.binId, query.binId),
          ),
        )
        .orderBy(asc(batchOnHand.batchId));
    });
  }

  /**
   * Tenant-wide per-bin on-hand of ONE batch (Story 2.5): the batch detail
   * route's "where the stock lives" rows — the `batch_on_hand` projection
   * read by batch identity across every warehouse of the tenant (a batch's
   * identity is tenant-scoped; its stock can sit in any bin). A read —
   * never capability-gated; no warehouse assert (the rows name their
   * warehouse).
   */
  async batchBinsOnHand(tenantId: string, batchId: string): Promise<BatchBinOnHandEntry[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) =>
      tx
        .select({
          warehouseId: batchOnHand.warehouseId,
          skuId: batchOnHand.skuId,
          binId: batchOnHand.binId,
          quantity: batchOnHand.quantity,
        })
        .from(batchOnHand)
        .where(and(eq(batchOnHand.tenantId, tenantId), eq(batchOnHand.batchId, batchId)))
        .orderBy(asc(batchOnHand.warehouseId), asc(batchOnHand.binId)),
    );
  }

  /**
   * A serial's full movement history (Story 2.4): one query over the
   * `(tenant_id, serial_ref, seq)` index — the ledger is the only source of
   * serial history (AD-6).
   */
  async serialHistory(tenantId: string, serialId: string): Promise<SerialLedgerEntry[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          warehouseId: ledgerEvents.warehouseId,
          seq: ledgerEvents.seq,
          type: ledgerEvents.type,
          skuId: ledgerEvents.skuId,
          quantityDelta: ledgerEvents.quantityDelta,
          fromBinId: ledgerEvents.fromBinId,
          toBinId: ledgerEvents.toBinId,
          batchRef: ledgerEvents.batchRef,
          occurredAt: ledgerEvents.occurredAt,
          recordedAt: ledgerEvents.recordedAt,
          eventHash: ledgerEvents.eventHash,
        })
        .from(ledgerEvents)
        .where(and(eq(ledgerEvents.tenantId, tenantId), eq(ledgerEvents.serialRef, serialId)))
        .orderBy(asc(ledgerEvents.seq));
      return rows.map((row) => ({
        ...row,
        occurredAt: canonicalInstant(row.occurredAt),
        recordedAt: canonicalInstant(row.recordedAt),
      }));
    });
  }

  /**
   * A serial's current location (Story 2.4): derived from its latest ledger
   * event — the from/to bin of the highest-seq row, tenant-wide (a serial's
   * location can cross warehouses). One query; null when never moved. For a
   * serial in stock this is its bin; for a serial drawn out of stock it is
   * the last-known bin (the derived state, never a projection).
   */
  async serialLocation(tenantId: string, serialId: string): Promise<SerialLocation | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          warehouseId: ledgerEvents.warehouseId,
          fromBinId: ledgerEvents.fromBinId,
          toBinId: ledgerEvents.toBinId,
        })
        .from(ledgerEvents)
        .where(and(eq(ledgerEvents.tenantId, tenantId), eq(ledgerEvents.serialRef, serialId)))
        .orderBy(desc(ledgerEvents.seq))
        .limit(1);
      const latest = rows[0];
      if (latest === undefined) {
        return null;
      }
      const binId = latest.toBinId ?? latest.fromBinId;
      return binId === null ? null : { warehouseId: latest.warehouseId, binId };
    });
  }

  /**
   * A batch's full movement history (Story 2.4): one query over the
   * `(tenant_id, batch_ref, seq)` index — the hash-chained ledger is the
   * batch's audit log.
   */
  async batchHistory(tenantId: string, batchId: string): Promise<BatchLedgerEntry[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          warehouseId: ledgerEvents.warehouseId,
          seq: ledgerEvents.seq,
          type: ledgerEvents.type,
          skuId: ledgerEvents.skuId,
          quantityDelta: ledgerEvents.quantityDelta,
          fromBinId: ledgerEvents.fromBinId,
          toBinId: ledgerEvents.toBinId,
          serialRef: ledgerEvents.serialRef,
          occurredAt: ledgerEvents.occurredAt,
          recordedAt: ledgerEvents.recordedAt,
          eventHash: ledgerEvents.eventHash,
        })
        .from(ledgerEvents)
        .where(and(eq(ledgerEvents.tenantId, tenantId), eq(ledgerEvents.batchRef, batchId)))
        .orderBy(asc(ledgerEvents.seq));
      return rows.map((row) => ({
        ...row,
        occurredAt: canonicalInstant(row.occurredAt),
        recordedAt: canonicalInstant(row.recordedAt),
      }));
    });
  }
}
