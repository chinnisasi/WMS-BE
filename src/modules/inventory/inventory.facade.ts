import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { batchOnHand, bins, ledgerEvents, skus, stockOnHand } from '../../shared/db/schema';
import type { LedgerEvent, UserRole } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { fromMilli, QUANTITY_DECIMALS, QUANTITY_SCALE } from '../../shared/primitives/quantity';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
// Story 5-1 — the destination placement gates' shared predicates. The SYNC
// HAZARD rule: one predicate behind every arm (storage class, hazard
// co-location, bulk-asset occupancy), imported — never copied. The
// `binOccupancyInTx`-shaped load read lives BELOW as this facade's own (the
// putaway command cannot be imported: it imports THIS facade — a module
// evaluation cycle), reusing the same primitives so the rules stay single-
// sourced even where the read is duplicated.
import { hazardClassesCompatible } from '../../shared/primitives/hazard';
import {
  bulkAssetOccupancyHolds,
  isBulkAssetType,
} from '../../shared/primitives/location-type';
import { storageClassSatisfies } from '../../shared/primitives/storage-class';
import { fullPrecisionInstant } from '../../shared/primitives/time';
import { assertSecureBinAuthority } from '../tenancy/permissions';
import {
  canonicalInstant,
  LedgerService,
  readBinStateEpochsInTx,
  warehouseAdvisoryLock,
} from './ledger.service';
import type { LedgerMovement } from './ledger.service';
import {
  clientOnHandAtInTx as clientOnHandAtInTxImpl,
  clientOnHandFoldByDayInTx as clientOnHandFoldByDayInTxImpl,
  clientWarehousesWithEventsInTx as clientWarehousesWithEventsInTxImpl,
  countDispatchedOrdersInTx as countDispatchedOrdersInTxImpl,
  firstEventInstantInTx as firstEventInstantInTxImpl,
  type ClientDayDelta,
  type ClientScope,
  type ClientWarehouseScope,
} from './client-metering';
// Story 21-4 — the metering scope shapes and the shared dispatched-order
// predicate (21-5's dispute drill-down reuses it) cross the seam here.
export type { ClientDayDelta, ClientScope, ClientWarehouseScope } from './client-metering';
export { dispatchedOrderEventsPredicate } from './client-metering';
import type { LedgerReferenceDoc } from './ledger-registry';
import type { TenantTx } from '../../shared/db/tenant-scope';

// The facade is the only sibling-facing seam (architecture test): the
// movement shape rides along so cross-module producers import the type here,
// never from the ledger service internals. Story 4.1 adds the reservation
// shapes the same way — the order module reads grant/ATP/snapshot types here.
export type { LedgerMovement, AppendedMovement } from './ledger.service';
// AD-6: siblings may import ONLY this facade, so the reference-doc grammar
// they must satisfy to append an event is re-exported here rather than
// reached for in `ledger-registry` directly.
export type { LedgerReferenceDoc } from './ledger-registry';
export type {
  AtpSnapshot,
  GrantReservationCommand,
  ReservationSnapshot,
} from './reservation.service';
// Story 7.1: the standing-buffer + per-channel-visible-quantity shapes are
// part of the inventory core's public seam — the channels module consumes
// them ONLY through this facade (never the reservation service internals).
export type {
  ChannelBufferCommand,
  ChannelVisibleSnapshot,
  StandingBufferResult,
} from './reservation.service';
/** Story 7.1 — the reservations owner type a channel's Safety Buffer rows carry. */
export { BUFFER_OWNER_TYPE } from './reservation.service';
// Story 5-4: the variance-resolution approve arm rebuilds an adjustment
// command from the variance row and runs it through the in-transaction seams
// below — cross-module callers import the command/event types here, never
// from `inventory.command` internals (the same rule as the ledger shapes
// above).
export type { AdjustStockCommand, StockAdjustmentSnapshot } from './inventory.command';
import type {
  ChainAnchor,
  ChainBreakReport,
  ChainVerifyReport,
  DigestExport,
  RebuildReport,
  ReplayReport,
} from './ledger.service';
import { StockAdjustmentCommand } from './inventory.command';
import type { AdjustStockCommand, StockAdjustmentResult, StockAdjustmentSnapshot, StockAdjustmentPendingSnapshot } from './inventory.command';
import type { SignedQuantity } from '../../shared/primitives/quantity';
import { AdjustmentApprovalCommand } from './adjustment-approval.command';
import type {
  AdjustmentDecisionSnapshot,
  AdjustmentPendingEntry,
  AdjustmentPolicySnapshot,
  DecideAdjustmentCommand,
  ListAdjustmentPendingsQuery,
  SetAdjustmentPolicyCommand,
} from './adjustment-approval.command';
import { ReconciliationService } from './reconcile';
import type { ReconcileReport } from './reconcile';
import { ReservationService } from './reservation.service';
import type {
  AtpSnapshot,
  ChannelBufferCommand,
  ChannelVisibleSnapshot,
  GrantReservationCommand,
  ReservationRebuildReport,
  ReservationSnapshot,
  StandingBufferResult,
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
  /**
   * Story 5-4 — narrow the timeline to one bin: fromBin = bin OR toBin = bin
   * (an event moved stock either through it). The approve-adjust resolver's
   * "pull the bin's history" read (the resolution's consulted-seqs list
   * quotes seq(s) from this timeline).
   */
  readonly binId?: string | undefined;
  /** Story 9-1 — only these registered types (validated at the DTO). */
  readonly types?: readonly string[] | undefined;
  /** Story 9-1 — `recorded_at >= from` (the server stamp; inclusive). */
  readonly from?: string | undefined;
  /** Story 9-1 — `recorded_at < to` (exclusive). */
  readonly to?: string | undefined;
  /** Story 9-1 — `reference_doc ->> 'orderId'` equals this order. */
  readonly orderId?: string | undefined;
  /** Story 9-1 — the reference doc's `shortPick` flag is (not) set. */
  readonly shortPick?: boolean | undefined;
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
 * One per-(sku, batch) warehouse-scope on-hand SUM (Story 6.2 — the expiry
 * scan's enumeration and the batch-alert queue's freshness stitch). The
 * projection's stored milli, summed across bins; a scope absent from the
 * result carries NO positive on-hand anywhere in the warehouse.
 */
export interface BatchScopeSumEntry {
  readonly warehouseId: string;
  readonly skuId: string;
  readonly batchId: string;
  readonly quantityMilli: number;
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
    // Story 5-2 — the approval-threshold commands behind the same seam.
    @Inject(AdjustmentApprovalCommand)
    private readonly adjustmentApproval: AdjustmentApprovalCommand,
    // Continuous reconciliation (Story 2.2) — background work; the jobs shell
    // drives it through this facade. No HTTP route.
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    // Atomic reservations (Story 2.3) — the ONE atomic decision point for
    // sellable stock; consumed here (reads become HTTP in 2.5, order wiring
    // in Epic 4).
    @Inject(ReservationService) private readonly reservations: ReservationService,
  ) {}

  /** `stock.adjustment` — the first movement producer (Story 2.1); Story 5-2 adds the `pending` outcome (the over-threshold 202). */
  async adjustStock(command: AdjustStockCommand, idempotencyKey: string): Promise<StockAdjustmentResult> {
    return this.stockAdjustment.adjust(command, idempotencyKey);
  }

  // ── Story 5-2: the approval-threshold surface ─────────────────────────────

  /** PUT …/inventory/adjustment-policies — the tenant's threshold row (adjustments.approve). */
  async setAdjustmentPolicy(
    command: SetAdjustmentPolicyCommand,
    idempotencyKey: string,
  ): Promise<AdjustmentPolicySnapshot> {
    return this.adjustmentApproval.setAdjustmentPolicy(command, idempotencyKey);
  }

  /** GET …/inventory/adjustment-policies — null when no row exists (flow disabled). */
  async getAdjustmentPolicy(tenantId: string): Promise<AdjustmentPolicySnapshot | null> {
    return this.adjustmentApproval.getAdjustmentPolicy(tenantId);
  }

  /** GET …/inventory/adjustment-pendings — the pending queue (a read). */
  async listAdjustmentPendings(
    tenantId: string,
    query: ListAdjustmentPendingsQuery = {},
  ): Promise<Page<AdjustmentPendingEntry>> {
    return this.adjustmentApproval.listAdjustmentPendings(tenantId, query);
  }

  /** POST …/adjustment-pendings/:pendingId/approve | /reject — the terminal decision. */
  async decideAdjustment(
    command: DecideAdjustmentCommand,
    idempotencyKey: string,
  ): Promise<AdjustmentDecisionSnapshot> {
    return this.adjustmentApproval.decideAdjustment(command, idempotencyKey);
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
   * The serial-set pre-lock passthrough (Story 3.5): a serial-tracked
   * placement locks its whole serial set tenant-wide, in sorted order,
   * BEFORE the first append (the stock.adjustment deadlock rule) — the
   * caller composes it inside its own transaction through this facade.
   */
  async lockSerialsInTx(
    tx: TenantTx,
    tenantId: string,
    serialRefs: readonly string[],
  ): Promise<void> {
    return this.ledger.lockSerialsInTx(tx, tenantId, serialRefs);
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
   * The adjustment GUARD SET, in-transaction (Story 5-4): the guard set and
   * the conversion behind the replay lookup a cross-module command runs
   * before its own apply — the variance-resolution approve arm executes the
   * bin's stock correction through THIS seam (AD-6: movements reach
   * inventory's writes only via the facade), inside the caller's transaction,
   * after the caller's own locks. Same contract as `adjust`'s internal step:
   * refuses 400/404 verbatim.
   */
  async assertAdjustableInTx(
    tx: TenantTx,
    command: AdjustStockCommand,
  ): Promise<{ delta: SignedQuantity; handlingUnitIds: readonly string[] }> {
    return this.stockAdjustment.assertAdjustableInTx(tx, command);
  }

  /**
   * The adjustment APPLY, in-transaction (Story 5-4): the ledger append +
   * on-hand projection fold a cross-module command writes through —
   * approve-adjust's stock correction lands as `stock.adjusted` events via
   * this passthrough, inside the caller's transaction. The write-side
   * refusals (insufficient on-hand, serial-elsewhere) roll back the
   * caller's whole transaction with their 4xx verbatim.
   */
  async applyAdjustmentInTx(
    tx: TenantTx,
    command: AdjustStockCommand,
    delta: SignedQuantity,
    handlingUnitIds: readonly string[],
    occurredAt: string,
  ): Promise<{ snapshot: StockAdjustmentSnapshot; firstEventId: string }> {
    return this.stockAdjustment.applyAdjustmentInTx(tx, command, delta, handlingUnitIds, occurredAt);
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
  ): Promise<StockAdjustmentSnapshot | StockAdjustmentPendingSnapshot | null> {
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
          // Story 5-2: the CURSOR needs the raw `::text` instant — the
          // driver's own parse (and `canonicalInstant`) truncates to
          // milliseconds, and a multi-serial adjustment appends its per-serial
          // events in ONE transaction, so they share one `now()` to the
          // microsecond. A truncated cursor's strict `<` would skip the tail
          // of that tie group on the next page. See `fullPrecisionInstant`.
          createdAtText: sql<string>`${ledgerEvents.createdAt}::text`,
        })
        .from(ledgerEvents)
        .where(
          and(
            eq(ledgerEvents.tenantId, tenantId),
            eq(ledgerEvents.warehouseId, warehouseId),
            query.skuId === undefined ? undefined : eq(ledgerEvents.skuId, query.skuId),
            // Story 5-4 — the bin filter: an event touches the bin when it is
            // either the movement's source or its destination (the timeline's
            // fromBin = bin OR toBin = bin arm).
            query.binId === undefined
              ? undefined
              : sql`(${ledgerEvents.fromBinId} = ${query.binId}::uuid OR ${ledgerEvents.toBinId} = ${query.binId}::uuid)`,
            // Story 9-1 — the dashboard drill filters. The window is on
            // `recorded_at` (server-stamped), so a replayed offline op never
            // revises "today"; `(tenant, warehouse, type, recorded_at)` is
            // 0058's index for exactly this shape.
            query.types === undefined || query.types.length === 0
              ? undefined
              : inArray(ledgerEvents.type, [...query.types]),
            query.from === undefined ? undefined : sql`${ledgerEvents.recordedAt} >= ${query.from}::timestamptz`,
            query.to === undefined ? undefined : sql`${ledgerEvents.recordedAt} < ${query.to}::timestamptz`,
            // Compared as TEXT against the lowercased uuid: the reference
            // doc stores canonical lowercase ids, and an uppercase query must
            // still match (a `::uuid` cast of the stored text would 500 on a
            // malformed legacy value).
            query.orderId === undefined
              ? undefined
              : sql`${ledgerEvents.referenceDoc} ->> 'orderId' = ${query.orderId.toLowerCase()}`,
            // Text comparison, never a `::boolean` cast — a non-boolean stored
            // value must read as "not a short pick", not 500 the read.
            query.shortPick === undefined
              ? undefined
              : query.shortPick
                ? sql`(${ledgerEvents.referenceDoc} ->> 'shortPick') = 'true'`
                : sql`(${ledgerEvents.referenceDoc} ->> 'shortPick') is distinct from 'true'`,
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
      const items = rows.map(({ createdAtText, ...row }) => {
        // `createdAtText` is the cursor-only projection (below) — it must
        // never leak into the response body.
        void createdAtText;
        return {
        ...row,
        // jsonb selects as `unknown` — the timeline's typed passthrough (the
        // verifier's own cast pattern, ledger.service).
        referenceDoc: row.referenceDoc as LedgerReferenceDoc,
        // Story 10.1: this is a READ MODEL — a quantity crossing it is on its
        // way to an HTTP body, so it converts from the domain's milli-units
        // back to the operator-facing base UoM here. The in-transaction
        // helpers further down this file (`stockByBinsInTx`,
        // `batchOnHandForBinInTx`, `atp`, `qcHeldArmsInTx`) feed COMMANDS,
        // not responses, and deliberately stay in milli-units.
        quantityDelta: fromMilli(row.quantityDelta),
        occurredAt: canonicalInstant(row.occurredAt),
        recordedAt: canonicalInstant(row.recordedAt),
        createdAt: canonicalInstant(row.createdAt),
        };
      });
      // buildPage encodes the cursor from the items' `createdAt` — feed it
      // the FULL-precision instants (microseconds), then canonicalize the
      // surfaced items back to the body's ms shape.
      const page = buildPage(
        rows.map((row, index) => ({
          createdAt: fullPrecisionInstant(row.createdAtText),
          id: row.id,
          entry: items[index]!,
        })),
        pageSize,
      );
      return {
        items: page.items.map((wrapped) => wrapped.entry),
        nextCursor: page.nextCursor,
      };
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
        // Read model — base units at the edge (see `listEvents`).
        quantity: fromMilli(row.quantity),
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

  /**
   * `held → committed` inside the CALLER's transaction (story 4.3): the
   * pick command draws the reserved units through the ledger and settles
   * their hold in ONE transaction — `commitReservation` above opens its own
   * and cannot nest. The `reservationsByIdsInTx` passthrough shape. Settling
   * moves no stock and leaves the Valkey reserved counter untouched
   * (committed units stay deducted from ATP); a reservation that is not
   * `held` throws inside the caller's transaction and rolls the whole pick
   * back.
   */
  async commitReservationInTx(
    tx: TenantTx,
    tenantId: string,
    reservationId: string,
  ): Promise<ReservationSnapshot> {
    return this.reservations.commitInTx(tx, tenantId, reservationId);
  }

  /** `held → released` — restores the reserved counter. */
  async releaseReservation(tenantId: string, reservationId: string): Promise<ReservationSnapshot> {
    return this.reservations.release(tenantId, reservationId);
  }

  /**
   * `held → released` inside the CALLER's transaction (story 4.4) — the
   * journal half only, for a short pick whose draw, hold release, re-grant,
   * line flip and new slice must all land together. The Valkey mirror is NOT
   * applied here: the caller applies one net `restoreReservedUnits` AFTER its
   * commit, so a rolled-back transaction can never leave the counter low
   * (ATP high — the overselling direction) against a journal that still holds
   * the units.
   */
  async releaseReservationInTx(
    tx: TenantTx,
    tenantId: string,
    reservationId: string,
  ): Promise<ReservationSnapshot> {
    return this.reservations.releaseInTx(tx, tenantId, reservationId);
  }

  /**
   * `committed → released` inside the CALLER's transaction (story 4.6) — the
   * retirement a dispatch performs on every hold its order still owns. This
   * is the transition `schema.ts` always promised at "the consuming ledger
   * movement": until it runs, a picked order's units are deducted from ATP
   * twice (once as on-hand the draw removed, once as reserved nobody
   * restored).
   *
   * Conditional on `state = 'committed'` (AD-12), so exactly one dispatch
   * retires a hold and a second is a deterministic conflict. Journal half
   * only, like `releaseReservationInTx`: the caller applies one net
   * `restoreReservedUnits` AFTER its commit.
   */
  async retireCommittedReservationInTx(
    tx: TenantTx,
    tenantId: string,
    reservationId: string,
  ): Promise<ReservationSnapshot> {
    return this.reservations.retireCommittedInTx(tx, tenantId, reservationId);
  }

  /**
   * The RE-GRANT half of that pair (story 4.4), in the caller's transaction:
   * a fresh hold for the remainder of `releasedFrom` — a hold this SAME
   * transaction released for the SAME owner scope. It creates no ATP (the
   * quantity is never more than what was just released), which is why it
   * needs no Valkey grant-vs-grant arbitration and why the precondition
   * rides the signature: see `ReservationService.grantInTx` for the full
   * argument and for what would break without it. Callers must also hold the
   * per-warehouse advisory lock.
   *
   * `null` (never a throw) when the remainder cannot be held: that is FR-15's
   * partial-order path, not a fault. A violated precondition DOES throw.
   */
  async grantReservationInTx(
    tx: TenantTx,
    command: GrantReservationCommand,
    releasedFrom: ReservationSnapshot,
  ): Promise<ReservationSnapshot | null> {
    return this.reservations.grantInTx(tx, command, releasedFrom);
  }

  /**
   * The post-commit counter mirror for that pair (story 4.4): one net restore
   * of `units` to the scope's reserved counter. Journal first, mirror second
   * — a mirror that never lands leaves ATP understated and is repaired by the
   * next rebuild.
   */
  async restoreReservedUnits(
    tenantId: string,
    warehouseId: string,
    skuId: string,
    units: number,
  ): Promise<void> {
    return this.reservations.restoreReservedUnits(tenantId, warehouseId, skuId, units);
  }

  /**
   * Applies (sets / adjusts / clears) one channel's standing Safety Buffer
   * for one (warehouse, sku) scope — story 7.1, AD-13. THIS is the only arm
   * by which the channels module touches the reservation core (never a
   * Valkey counter, never a reservations SQL write; AD-6 and the epic
   * decision "the adapter never writes stock directly"). Refusals throw the
   * deterministic 409 `unavailable` (the old buffer standing — the caller,
   * never this method, maps that to its per-item verdict); store failures
   * throw 503 `reservation-store-unavailable` (fail closed).
   */
  async applyChannelBuffer(command: ChannelBufferCommand): Promise<StandingBufferResult> {
    return this.reservations.applyStandingBuffer(command);
  }

  /**
   * The sync's per-channel visible quantity (RN-6) — the pool ATP fail-closed
   * read plus THIS channel's own standing buffer, clamped. The buffer math
   * lives in the inventory core (the sync delivers arithmetic results it
   * never performs itself).
   */
  async channelVisibleQuantity(
    tenantId: string,
    warehouseId: string,
    skuId: string,
    bufferOwnerId: string,
  ): Promise<ChannelVisibleSnapshot> {
    return this.reservations.channelVisibleQuantity(tenantId, warehouseId, skuId, bufferOwnerId);
  }

  /**
   * Every still-held standing buffer of one owner (an integration's
   * disconnect release set) in the CALLER's transaction — the channels
   * command releases them beside its own writes and mirrors the net
   * per-scope restores after the commit through `restoreReservedUnits`.
   */
  async standingBuffersByOwnerInTx(
    tx: TenantTx,
    tenantId: string,
    ownerId: string,
  ): Promise<ReservationSnapshot[]> {
    return this.reservations.standingBuffersByOwnerInTx(tx, tenantId, ownerId);
  }

  /**
   * EVERY standing buffer still `held` in one tenant (arm 4's bucketed
   * editor rows), in the CALLER's transaction — the channels facade's list
   * read consumes it; the channels module never reads `reservations` raw.
   */
  async standingBuffersForTenantInTx(
    tx: TenantTx,
    tenantId: string,
  ): Promise<ReservationSnapshot[]> {
    return this.reservations.standingBuffersForTenantInTx(tx, tenantId);
  }

  /**
   * The live journal rows for a set of reservation ids (story 4.1): the
   * outbound module's per-line reservation-state read rides this passthrough
   * — AD-6 keeps `reservations` inventory-owned, and cross-module state
   * reads go through the facade like every other stock-state read. Missing
   * ids simply come back absent; the caller renders its own nulls.
   */
  async reservationsByIds(tenantId: string, ids: readonly string[]): Promise<ReservationSnapshot[]> {
    return this.reservations.reservationsByIds(tenantId, ids);
  }

  /**
   * One hold's liveness inside the caller's transaction (story 4.3b): its
   * state, and whether it has already expired **by the database's clock**.
   * The pick command's AD-14 case 4 needs both, and needs the expiry judged
   * in SQL — `expires_at` is written and reaped Postgres-side, so comparing
   * it against the app node's clock lets skew refuse a live hold or settle a
   * dead one. Null when the id names no row.
   */
  async holdLivenessInTx(
    tx: TenantTx,
    tenantId: string,
    reservationId: string,
  ): Promise<{ state: string; expiresAt: string | null; expired: boolean } | null> {
    return this.reservations.holdLivenessInTx(tx, tenantId, reservationId);
  }

  /**
   * The still-`held` holds owned by a set of owner ids in one warehouse
   * (story 4.5) — the pack command's read before it releases the holds a
   * packed order can no longer reach. Owner-keyed because a short pick's
   * re-granted remainder may be referenced by no outbound column at all; see
   * `ReservationService.heldReservationsByOwnerInTx`. The
   * `reservationsByIdsInTx` passthrough shape (AD-6: `reservations` stays
   * inventory-owned and cross-module reads go through the facade).
   */
  async heldReservationsByOwnerInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    ownerType: string,
    ownerIds: readonly string[],
  ): Promise<ReservationSnapshot[]> {
    return this.reservations.heldReservationsByOwnerInTx(
      tx,
      tenantId,
      warehouseId,
      ownerType,
      ownerIds,
    );
  }

  /**
   * The `committed` holds owned by a set of owner ids in one warehouse
   * (story 4.6) — the dispatch command's read of everything it must retire.
   * Owner-keyed for the same reason as the `held` sibling above. A
   * partially short-picked order simply returns fewer rows: a hold already
   * `released` has nothing left to retire.
   */
  async committedReservationsByOwnerInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    ownerType: string,
    ownerIds: readonly string[],
  ): Promise<ReservationSnapshot[]> {
    return this.reservations.committedReservationsByOwnerInTx(
      tx,
      tenantId,
      warehouseId,
      ownerType,
      ownerIds,
    );
  }

  /**
   * The same read inside the caller's transaction (story 4.1): a sibling
   * command that composes the reservation-state read with its own writes in
   * ONE tenant transaction (the order snapshot) rides this in-tx passthrough
   * — the `appendLedgerEventInTx` shape. Missing ids come back absent.
   */
  async reservationsByIdsInTx(
    tx: TenantTx,
    tenantId: string,
    ids: readonly string[],
  ): Promise<ReservationSnapshot[]> {
    return this.reservations.reservationsByIdsInTx(tx, tenantId, ids);
  }

  /**
   * Per-bin on-hand for a SET of SKUs, inside the caller's transaction
   * (story 4.2 — the wave planner's bin walk). The `reservationsByIdsInTx`
   * shape: the outbound module composes this read with its own writes in ONE
   * tenant transaction, so the plan it commits is the stock it saw. Only
   * positive rows come back (a zeroed projection row is not a pick stop).
   *
   * This is a READ of the projection, never an allocation: nothing in the
   * system allocates stock to a bin (a reservation binds to (tenant,
   * warehouse, sku, owner) and carries no bin), so what the caller does with
   * these rows is a suggestion re-derived at execution time.
   */
  async stockByBinsInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    skuIds: readonly string[],
  ): Promise<ReadonlyArray<{ skuId: string; binId: string; quantity: number }>> {
    if (skuIds.length === 0) {
      return [];
    }
    return tx
      .select({
        skuId: stockOnHand.skuId,
        binId: stockOnHand.binId,
        quantity: stockOnHand.quantity,
      })
      .from(stockOnHand)
      .where(
        and(
          eq(stockOnHand.tenantId, tenantId),
          eq(stockOnHand.warehouseId, warehouseId),
          inArray(stockOnHand.skuId, [...new Set(skuIds)]),
          sql`${stockOnHand.quantity} > 0`,
        ),
      );
  }

  /**
   * Story 5-3 (the review's seam fix): the DISTINCT bin ids of THIS
   * warehouse holding a POSITIVE quantity of any SKU whose ABC class equals
   * the argument, in the caller's transaction — the count scheduler's
   * candidate scan. The stockOnHand→skus join lives HERE because inventory
   * is the projection's owner: movements never projects stock tables
   * directly (movements.md's module boundary), so every stock read a
   * movements command makes goes through this facade (the
   * `stockByBinsInTx`/`onHandInBinInTx` precedent). This is a READ of the
   * projection, never an allocation (the `stockByBinsInTx` note).
   */
  async stockedBinIdsForAbcClassInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    abcClass: string,
  ): Promise<ReadonlyArray<string>> {
    const rows = await tx
      .selectDistinct({ binId: stockOnHand.binId })
      .from(stockOnHand)
      .innerJoin(skus, and(eq(skus.id, stockOnHand.skuId), eq(skus.tenantId, tenantId)))
      .where(
        and(
          eq(stockOnHand.tenantId, tenantId),
          eq(stockOnHand.warehouseId, warehouseId),
          eq(skus.abcClass, abcClass),
          sql`${stockOnHand.quantity} > 0`,
        ),
      );
    return rows.map((row) => row.binId);
  }

  /**
   * Story 5-3 (the review's seam fix): the per-bin on-hand arms for a set
   * of bins — the `stockByBinsInTx` shape keyed by BINS (whose callers key
   * by SKUs) — per (bin, sku) on-hand > 0 in the caller's transaction,
   * ordered binId then skuId (the count scheduler's expected-quantity
   * fan-out composes in that stable order). This is a READ of the
   * projection, never an allocation.
   */
  async stockArmsInBinsInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    binIds: readonly string[],
  ): Promise<ReadonlyArray<{ binId: string; skuId: string; quantity: number }>> {
    if (binIds.length === 0) {
      return [];
    }
    return tx
      .select({
        binId: stockOnHand.binId,
        skuId: stockOnHand.skuId,
        quantity: stockOnHand.quantity,
      })
      .from(stockOnHand)
      .where(
        and(
          eq(stockOnHand.tenantId, tenantId),
          eq(stockOnHand.warehouseId, warehouseId),
          inArray(stockOnHand.binId, [...new Set(binIds)]),
          sql`${stockOnHand.quantity} > 0`,
        ),
      )
      .orderBy(asc(stockOnHand.binId), asc(stockOnHand.skuId));
  }

  /**
   * The ledger rows whose reference doc names one order (story 12-6, FR-45):
   * the `dispatch.dispatched` events that say the order shipped and the
   * `pick.picked` events that served it, seq-ordered, in the CALLER's
   * transaction. The join key is `reference_doc->>'orderId'` — the hash-chained
   * doc was built (story 4.3) precisely so the ledger could answer "which
   * picks served this order" without an outbound-table join; migration 0039's
   * PARTIAL expression index serves the match only because the WHERE clause
   * carries the index's own `reference_doc ? 'orderId'` qual — Postgres cannot
   * prove that predicate implied by the `->>'orderId'` match alone, and
   * without the qual the plan degrades to a seq scan.
   *
   * This is an in-transaction feed, NOT a read model: rows come back raw —
   * milli-unit quantities, Postgres text instants, the typed reference doc
   * verbatim — and the caller converts at its own HTTP edge (`fromMilli` +
   * `canonicalInstant`, the `listEvents` pattern). Warehouse-scoped like every
   * timeline read here.
   */
  async ledgerEventsByOrderRefInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    orderId: string,
  ): Promise<readonly LedgerEvent[]> {
    return tx
      .select()
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.tenantId, tenantId),
          eq(ledgerEvents.warehouseId, warehouseId),
          // A deliberate choice of the two types whose docs name this
          // order's pick/dispatch facts — NOT the set of orderId-carrying
          // types (`pack.packed`'s doc carries orderId too; the trace reads
          // neither its facts nor its line linkage).
          inArray(ledgerEvents.type, ['pick.picked', 'dispatch.dispatched']),
          // The 0039 partial index's own predicate — repeated here so the
          // planner can use the index (see the doc comment above).
          sql`${ledgerEvents.referenceDoc} ? 'orderId'`,
          sql`${ledgerEvents.referenceDoc}->>'orderId' = ${orderId}`,
        ),
      )
      .orderBy(asc(ledgerEvents.seq));
  }

  /**
   * The full ledger history of a set of batch/serial scopes (story 12-6,
   * FR-45): every event whose `batch_ref` or `serial_ref` matches, seq-ordered,
   * in the CALLER's transaction — the `(tenant,batch_ref,seq)` /
   * `(tenant,serial_ref,seq)` trace indexes (schema.ts) at work. A scope's
   * chain is its COMPLETE history within the warehouse — other orders' picks
   * included — because the batch's history is the batch's history.
   *
   * In-transaction feed like `ledgerEventsByOrderRefInTx` (raw rows; the
   * caller converts at its edge). Empty ref lists short-circuit to `[]` —
   * a behavior-preserving cheap path (drizzle would render the empty
   * `inArray` as `sql`false``; skipping the query costs nothing and
   * touches the DB not at all).
   */
  async ledgerEventsByScopeRefsInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    refs: { readonly batchRefs: readonly string[]; readonly serialRefs: readonly string[] },
  ): Promise<readonly LedgerEvent[]> {
    const batchRefs = [...new Set(refs.batchRefs)];
    const serialRefs = [...new Set(refs.serialRefs)];
    if (batchRefs.length === 0 && serialRefs.length === 0) {
      return [];
    }
    return tx
      .select()
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.tenantId, tenantId),
          eq(ledgerEvents.warehouseId, warehouseId),
          or(
            batchRefs.length === 0
              ? undefined
              : inArray(ledgerEvents.batchRef, batchRefs),
            serialRefs.length === 0
              ? undefined
              : inArray(ledgerEvents.serialRef, serialRefs),
          ),
        ),
      )
      .orderBy(asc(ledgerEvents.seq));
  }

  /**
   * A warehouse's `excursion.recorded` events for a set of SKUs (story 12-6,
   * FR-45), seq-ordered, in the CALLER's transaction — the raw material for
   * dwell-window correlation. A separate read by SKU (not folded into the
   * scope-ref read) because the excursion arm carries no batch/serial: one
   * event is written per affected (sku, bin) scope, so the scope link is
   * `skuId` + dwell window, never a ref match.
   *
   * In-transaction feed like its siblings — raw rows, caller converts.
   */
  async ledgerExcursionEventsBySkuInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    skuIds: readonly string[],
  ): Promise<readonly LedgerEvent[]> {
    if (skuIds.length === 0) {
      return [];
    }
    return tx
      .select()
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.tenantId, tenantId),
          eq(ledgerEvents.warehouseId, warehouseId),
          eq(ledgerEvents.type, 'excursion.recorded'),
          inArray(ledgerEvents.skuId, [...new Set(skuIds)]),
        ),
      )
      .orderBy(asc(ledgerEvents.seq));
  }

  // ── Story 21-4 — the client metering reads (billing's only view of the
  // ledger, AD-25 + AD-6). The SQL and the fold rule live in
  // `client-metering.ts`; these are the seam.

  /**
   * The storage fold for one (client, warehouse), bucketed per (IST day, base
   * UoM) over `[fromInstant, toInstant)` (`fromInstant` null = genesis): the
   * net on-hand movement under the ledger's own replay rule — `+|δ|` for a
   * destination-only event, `−|δ|` for a source-only one, 0 otherwise.
   */
  async clientOnHandFoldByDayInTx(
    tx: TenantTx,
    scope: ClientWarehouseScope,
    fromInstant: string | null,
    toInstant: string,
  ): Promise<ClientDayDelta[]> {
    return clientOnHandFoldByDayInTxImpl(tx, scope, fromInstant, toInstant);
  }

  /** One client's on-hand per base UoM in one warehouse at an instant — the fold from genesis (the drift check's genesis-sum). */
  async clientOnHandAtInTx(tx: TenantTx, scope: ClientWarehouseScope, toInstant: string): Promise<Map<string, bigint>> {
    return clientOnHandAtInTxImpl(tx, scope, toInstant);
  }

  /** Which warehouses each client has any ledger event in (an EXISTS probe per pair). */
  async clientWarehousesWithEventsInTx(
    tx: TenantTx,
    tenantId: string,
    clientIds: readonly string[],
  ): Promise<{ clientId: string; warehouseId: string }[]> {
    return clientWarehousesWithEventsInTxImpl(tx, tenantId, clientIds);
  }

  /** The earliest `recorded_at` of one client's events in one warehouse, or null. */
  async firstEventInstantInTx(tx: TenantTx, scope: ClientWarehouseScope): Promise<string | null> {
    return firstEventInstantInTxImpl(tx, scope);
  }

  /**
   * Distinct orders FIRST dispatched for a client in `[from, to)` across its
   * warehouses (an order counts once, in the window of its first dispatch
   * event) — on this facade because outbound reads no ledger.
   */
  async countDispatchedOrdersInTx(tx: TenantTx, scope: ClientScope, from: string, to: string): Promise<number> {
    return countDispatchedOrdersInTxImpl(tx, scope, from, to);
  }

  /**
   * One bin's state epoch inside the caller's transaction (story 4.3b,
   * AD-14) — the pick command's classification read. `null` means the bin has
   * no epoch row at all: no movement has ever touched it, so there is nothing
   * an op could be stale against and the caller treats it as a match.
   *
   * The value is OPAQUE — compare it for equality and nothing else. It is not
   * a quantity, a timestamp or a sequence, and the only guarantee is that it
   * differs from every value the bin carried before its contents changed.
   * Callers hold the bin's row lock before reading it, so the classification
   * cannot race the state it classifies.
   */
  async binStateEpochInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    binId: string,
  ): Promise<number | null> {
    const epochs = await readBinStateEpochsInTx(tx, tenantId, warehouseId, [binId]);
    return epochs.get(binId) ?? null;
  }

  /**
   * The same read for a SET of bins (story 4.3b): the device snapshot's
   * pick-task projection stitches an epoch onto every walk stop, so the task
   * and the epoch the device will quote back come from ONE consistent read.
   * Bins with no epoch row are absent from the map.
   */
  async binStateEpochsInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    binIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    return readBinStateEpochsInTx(tx, tenantId, warehouseId, binIds);
  }

  /**
   * The per-warehouse advisory xact lock, taken inside the CALLER's
   * transaction (story 4.3b) — the same key `appendMovement` takes, so a
   * caller that must READ stock state and then act on what it read holds the
   * writers off for the whole decision rather than for the append alone.
   *
   * The pick command's AD-14 classification is the first such caller: the
   * epoch and the on-hand it compares are bumped by adjustments, putaway,
   * receiving and the reconciliation rebuild, none of which touch the `bins`
   * row a pick locks. Callers own the lock ORDER (putaway's documented
   * acyclic bins-row → serial → warehouse); this seam only takes the lock.
   */
  async lockWarehouseInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<void> {
    await tx.execute(warehouseAdvisoryLock(tenantId, warehouseId));
  }

  /**
   * The consulted-seqs probe (Story 5-4): which of the given ledger seqs
   * exist in ONE warehouse's ledger, inside the caller's transaction — the
   * variance-resolution command refuses a resolution whose stated
   * `consideredEventSeqs` name ledger events this warehouse never wrote
   * (400 `validation-failed` BEFORE any write), and the read rides the
   * facade because the ledger table is inventory-module-owned.
   */
  async ledgerSeqsExistInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    seqs: readonly number[],
  ): Promise<Set<number>> {
    if (seqs.length === 0) {
      return new Set();
    }
    const rows = await tx
      .select({ seq: ledgerEvents.seq })
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.tenantId, tenantId),
          eq(ledgerEvents.warehouseId, warehouseId),
          inArray(ledgerEvents.seq, [...seqs]),
        ),
      );
    return new Set(rows.map((row) => row.seq));
  }

  /**
   * The batch-arm sibling of `stockByBinsInTx` (story 4.2): per (sku, bin,
   * batch) on-hand for a set of SKUs, in the caller's transaction — the
   * FEFO half of a pick suggestion. A SKU with no batch rows simply comes
   * back absent (an untracked SKU's pick line names no batch).
   */
  async batchOnHandByBinsInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    skuIds: readonly string[],
  ): Promise<readonly BatchOnHandEntry[]> {
    if (skuIds.length === 0) {
      return [];
    }
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
          inArray(batchOnHand.skuId, [...new Set(skuIds)]),
          sql`${batchOnHand.quantity} > 0`,
        ),
      );
  }

  /**
   * Per-batch on-hand for ONE (sku, bin), inside the caller's transaction
   * (story 4.3 — the pick's FEFO re-derivation). The bin filter belongs in
   * the query: `batchOnHandByBinsInTx` returns every bin holding the SKU,
   * and the pick path runs while holding a bin row lock inside the command
   * transaction, so fetching the warehouse and discarding it in JS is work
   * done under a lock for nothing. Only positive rows come back.
   */
  async batchOnHandForBinInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    skuId: string,
    binId: string,
  ): Promise<readonly BatchOnHandEntry[]> {
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
          eq(batchOnHand.skuId, skuId),
          eq(batchOnHand.binId, binId),
          sql`${batchOnHand.quantity} > 0`,
        ),
      );
  }

  /**
   * Story 6.2 — the expiry scan's enumeration read: per (sku, batch) SUMMED
   * on-hand for ONE warehouse, positive rows only, in the CALLER's
   * transaction (the `batchOnHandByBinsInTx` seam-fix shape — the projection
   * join lives in inventory because inventory owns it). The replenishment
   * scan composes it beside its policy row inside one tx, so a nested second
   * transaction — the documented pool-deadlock shape — never happens. Sums
   * come back in STORED milli; a scope with no positive row is simply
   * absent (consuming its last unit removes the key, not zeroes it — the
   * scan's auto-resolve reads an absent key as on-hand 0).
   */
  async batchScopeSumsInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
  ): Promise<readonly BatchScopeSumEntry[]> {
    const rows = await tx
      .select({
        warehouseId: batchOnHand.warehouseId,
        skuId: batchOnHand.skuId,
        batchId: batchOnHand.batchId,
        // The stored bigint sum crosses as a string (the repo's bigint-trap
        // convention) — `Number()` at this boundary, the projection's own.
        quantityMilli: sql<string>`coalesce(sum(${batchOnHand.quantity}), 0)::bigint`,
      })
      .from(batchOnHand)
      .where(
        and(
          eq(batchOnHand.tenantId, tenantId),
          eq(batchOnHand.warehouseId, warehouseId),
          sql`${batchOnHand.quantity} > 0`,
        ),
      )
      .groupBy(batchOnHand.warehouseId, batchOnHand.skuId, batchOnHand.batchId);
    return rows.map((row) => ({ ...row, quantityMilli: Number(row.quantityMilli) }));
  }

  /**
   * Story 6.2 — the batch-alert QUEUE read's freshness stitch: per-scope
   * summed on-hand for exactly the scopes the caller names (one alert page's
   * rows), in the caller's transaction. Same projection, positive rows only,
   * stored milli — an alert whose last unit was consumed comes back ABSENT
   * (the queue renders its live on-hand as 0).
   */
  async batchScopeSumsForScopesInTx(
    tx: TenantTx,
    tenantId: string,
    scopes: readonly { warehouseId: string; skuId: string; batchId: string }[],
  ): Promise<readonly BatchScopeSumEntry[]> {
    if (scopes.length === 0) {
      return [];
    }
    const unique = [...new Set(scopes.map((s) => `${s.warehouseId}|${s.skuId}|${s.batchId}`))]
      .map((key) => key.split('|'))
      .map((parts) => ({
        warehouseId: parts[0]!,
        skuId: parts[1]!,
        batchId: parts[2]!,
      }));
    const rows = await tx
      .select({
        warehouseId: batchOnHand.warehouseId,
        skuId: batchOnHand.skuId,
        batchId: batchOnHand.batchId,
        quantityMilli: sql<string>`coalesce(sum(${batchOnHand.quantity}), 0)::bigint`,
      })
      .from(batchOnHand)
      .where(
        and(
          eq(batchOnHand.tenantId, tenantId),
          sql`${batchOnHand.quantity} > 0`,
          or(
            ...unique.map((scope) =>
              and(
                eq(batchOnHand.warehouseId, scope.warehouseId),
                eq(batchOnHand.skuId, scope.skuId),
                eq(batchOnHand.batchId, scope.batchId),
              ),
            ),
          ),
        ),
      )
      .groupBy(batchOnHand.warehouseId, batchOnHand.skuId, batchOnHand.batchId);
    return rows.map((row) => ({ ...row, quantityMilli: Number(row.quantityMilli) }));
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
      // Read model — the rows are mapped to base units below (story 10.1).
      const rows = await tx
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
      return rows.map((row) => ({ ...row, quantity: fromMilli(row.quantity) }));
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
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          warehouseId: batchOnHand.warehouseId,
          skuId: batchOnHand.skuId,
          binId: batchOnHand.binId,
          quantity: batchOnHand.quantity,
        })
        .from(batchOnHand)
        .where(and(eq(batchOnHand.tenantId, tenantId), eq(batchOnHand.batchId, batchId)))
        .orderBy(asc(batchOnHand.warehouseId), asc(batchOnHand.binId));
      // Read model — base units at the edge (story 10.1).
      return rows.map((row) => ({ ...row, quantity: fromMilli(row.quantity) }));
    });
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
        // Read model — base units at the edge (story 10.1).
        quantityDelta: fromMilli(row.quantityDelta),
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
        // Read model — base units at the edge (story 10.1).
        quantityDelta: fromMilli(row.quantityDelta),
        occurredAt: canonicalInstant(row.occurredAt),
        recordedAt: canonicalInstant(row.recordedAt),
      }));
    });
  }

  // ── Story 3.4: the QC-hold command's stock reads (read-only passthroughs —
  // the hold/release movements still append only through the ledger) ───────

  /**
   * One (sku, bin) scope's on-hand snapshot (Story 3.4): the plain
   * `stock_on_hand` row's quantity plus its per-batch breakdown (the batch
   * rows sum to it on a batch-tracked SKU; an untracked SKU carries none —
   * its single hold/release movement rides `batchRef: null`). The caller's
   * in-transaction passthrough shape (`appendLedgerEventInTx` precedent) —
   * the hold command composes this read with its movements in ONE tx.
   */
  async qcScopeOnHandInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    skuId: string,
    binId: string,
  ): Promise<QcScopeOnHand> {
    const plain = await tx
      .select({ quantity: stockOnHand.quantity })
      .from(stockOnHand)
      .where(
        and(
          eq(stockOnHand.tenantId, tenantId),
          eq(stockOnHand.warehouseId, warehouseId),
          eq(stockOnHand.skuId, skuId),
          eq(stockOnHand.binId, binId),
        ),
      )
      .limit(1);
    if (plain[0] === undefined) {
      return { quantity: 0, batches: [] };
    }
    const batches = await tx
      .select({ batchId: batchOnHand.batchId, quantity: batchOnHand.quantity })
      .from(batchOnHand)
      .where(
        and(
          eq(batchOnHand.tenantId, tenantId),
          eq(batchOnHand.warehouseId, warehouseId),
          eq(batchOnHand.skuId, skuId),
          eq(batchOnHand.binId, binId),
        ),
      )
      .orderBy(asc(batchOnHand.batchId));
    return { quantity: plain[0].quantity, batches };
  }

  /**
   * Every (sku, quantity) on-hand row of ONE bin with a positive quantity
   * (Story 12-5, the excursion sweep): the bin's affected scopes — every
   * distinct SKU with on-hand quantity > 0 — in skuId order for a
   * deterministic command. The caller's in-transaction passthrough shape
   * (`qcScopeOnHandInTx` precedent); a read of the projection, never an
   * allocation, and never a write path.
   */
  async onHandInBinInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    binId: string,
  ): Promise<ReadonlyArray<{ skuId: string; quantity: number }>> {
    const rows = await tx
      .select({ skuId: stockOnHand.skuId, quantity: stockOnHand.quantity })
      .from(stockOnHand)
      .where(
        and(
          eq(stockOnHand.tenantId, tenantId),
          eq(stockOnHand.warehouseId, warehouseId),
          eq(stockOnHand.binId, binId),
          sql`${stockOnHand.quantity} > 0`,
        ),
      )
      .orderBy(asc(stockOnHand.skuId));
    return rows;
  }

  /**
   * A hold's own `qc.held` arms (Story 3.4): the events the hold placed,
   * oldest first — the release replays exactly these (same batch refs, same
   * magnitudes) so a concurrent hold of the same SKU from another origin bin
   * never returns with the wrong release. One query over the ledger (the
   * hash chain is the hold's movement record — no second source of truth);
   * the caller's in-transaction passthrough shape.
   */
  async qcHeldArmsInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    holdId: string,
  ): Promise<QcHeldArm[]> {
    const rows = await tx
      .select({
        seq: ledgerEvents.seq,
        batchRef: ledgerEvents.batchRef,
        quantityDelta: ledgerEvents.quantityDelta,
      })
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.tenantId, tenantId),
          eq(ledgerEvents.warehouseId, warehouseId),
          eq(ledgerEvents.type, 'qc.held'),
          sql`${ledgerEvents.referenceDoc}->>'holdId' = ${holdId}`,
        ),
      )
      .orderBy(asc(ledgerEvents.seq));
    return rows.map((row) => ({
      seq: row.seq,
      batchRef: row.batchRef,
      quantity: Math.abs(row.quantityDelta),
    }));
  }

  /**
   * The serials of ONE SKU currently located in ONE bin (Story 3.6, the
   * bin-merge's enumeration): the ledger-derived latest event per serial —
   * an intake (or relocation) whose `to_bin_id` is the queried bin means the
   * serial is there. Tenant-wide truth (a serial's location can cross
   * warehouses), read-only over `ledger_events` — AD-6: the ledger is the
   * only source of serial location; there is no serial projection to query.
   * The caller's in-transaction passthrough shape (`qcHeldArmsInTx`
   * precedent); each row carries the serial identity and the batch ref its
   * latest movement carried (a batch+serial merge event carries it onward).
   */
  async serialsLocatedInBinInTx(
    tx: TenantTx,
    tenantId: string,
    skuId: string,
    binId: string,
  ): Promise<SerialLocationEntry[]> {
    const rows = await tx
      .select({
        serialRef: sql<string>`latest.serial_ref`,
        batchRef: sql<string | null>`latest.batch_ref`,
      })
      .from(
        sql`(
          select serial_ref, batch_ref, to_bin_id,
                 row_number() over (partition by serial_ref order by seq desc) as rn
          from ledger_events
          where tenant_id = ${tenantId} and sku_id = ${skuId} and serial_ref is not null
        ) as latest`,
      )
      .where(sql`latest.rn = 1 and latest.to_bin_id = ${binId}`)
      .orderBy(sql`latest.serial_ref`);
    return rows.map((row) => ({
      serialRef: row.serialRef,
      batchRef: row.batchRef,
    }));
  }

  // ── Story 5-1: the destination placement gates (the movements module's
  // inbound confirm) ────────────────────────────────────────────────────────

  /**
   * The destination placement gates, as ONE additive arm (Story 5-1): a
   * transfer's inbound confirm is a new stock writer of the adjustment shape,
   * and the spec's Boundaries forbid it from bypassing the gates
   * `stock.adjust` bypasses. The gate set and its ORDER are the
   * `putaway.place` composition's (the SYNC HAZARD rule — one arm list per
   * gate family, one predicate behind every arm), run here so the movements
   * module reuses, not re-implements, the 12-1/12-2/12-3/12-4 + 11-5 gates:
   *
   *   bin-row `.for('update')` (the capacity mutex) → system-owned → retired
   *   → blocked → storage class (12-1) → secure authority (12-3) → bulk-asset
   *   occupancy (12-4) → hazard co-location (12-2) → the load gates —
   *   capacity → weight → volume → per-axis dim fit (11-5).
   *
   * The `intakes` are AGGREGATED by the caller: one call per destination bin,
   * one intake per (skuId) landing in it with the SUM of that SKU's line
   * quantities, so two lines of one SKU into one bin are one gate answer and
   * the capacity read carries the whole planned intake. The refusal arms
   * carry the gate's OWN machine codes — the transfer surface answers 409 for
   * the gate family (the spec's matrix fixes the status; putaway's own
   * refusals of the same codes answer 400), while `assertSecureBinAuthority`
   * keeps its own 403 `role-denied` shape — a (role, bin) authority answer,
   * not a gate-status one.
   *
   * The caller's in-transaction passthrough shape (`qcScopeOnHandInTx`
   * precedent); a gate runner, never a write path.
   */
  async assertPlacementGatesInTx(
    tx: TenantTx,
    args: {
      readonly tenantId: string;
      readonly warehouseId: string;
      readonly binId: string;
      readonly intakes: readonly { readonly skuId: string; readonly qtyMilli: number }[];
      readonly role: UserRole;
    },
  ): Promise<{ readonly binId: string; readonly binCode: string }> {
    // The bin row, `.for('update')` — the same mutex the placement command
    // takes (two concurrent intakes would otherwise both pass capacity and
    // then append serially — over capacity). The putaway order — bin-row →
    // serial-lock → warehouse-lock — stays acyclic; the movements command
    // acquires its warehouse advisory locks BEFORE calling here, and the
    // advisory lock is re-entrant inside the same transaction, so the fold's
    // own acquisition never self-deadlocks.
    const binRows = await tx
      .select({
        id: bins.id,
        code: bins.code,
        capacity: bins.capacity,
        blocked: bins.blocked,
        systemOwned: bins.systemOwned,
        retiredAt: bins.retiredAt,
        // Story 11-5: the bin's physical limits (null = unconstrained).
        lengthMm: bins.lengthMm,
        widthMm: bins.widthMm,
        heightMm: bins.heightMm,
        maxWeightGrams: bins.maxWeightGrams,
        // Story 12-1 — the class the placement gate rules on.
        storageClass: bins.storageClass,
        // Story 12-4 — the location type: the bulk-asset occupancy arm's key.
        type: bins.type,
      })
      .from(bins)
      .where(
        and(
          eq(bins.id, args.binId),
          eq(bins.tenantId, args.tenantId),
          eq(bins.warehouseId, args.warehouseId),
        ),
      )
      .for('update')
      .limit(1);
    const bin = binRows[0];
    if (bin === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'Bin not found',
        `No bin with id "${args.binId}" exists in this warehouse.`,
      );
    }
    // The structural arms. A SYSTEM bin is never an intake target (the
    // in-transit/receiving/QC-hold bins are system-internal staging) — an
    // invalid request, not a state conflict. Retired/blocked are state
    // conflicts (409, the gate family's own machine codes; putaway's
    // refusals of the same codes answer 400 for its surface, the transfer
    // matrix fixes 409 for this one).
    if (bin.systemOwned) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Bin is a system bin',
        `Bin "${bin.code}" is a system bin (Receiving/QC-hold/In-Transit) — transfer intake lands in storage bins only.`,
      );
    }
    if (bin.retiredAt !== null) {
      throw new ProblemException(
        'bin-retired',
        409,
        'Target bin is retired',
        `Bin "${bin.code}" is retired — transfer intake into it is refused; retirement is terminal.`,
      );
    }
    if (bin.blocked) {
      throw new ProblemException(
        'bin-blocked',
        409,
        'Target bin is blocked',
        `Bin "${bin.code}" is blocked — transfer intake into it is refused until it is unblocked.`,
      );
    }

    // Aggregate the intake per SKU (the caller may land two lines of one SKU
    // in this bin) and read the SKU rows once.
    const bySku = new Map<string, number>();
    for (const intake of args.intakes) {
      bySku.set(intake.skuId, (bySku.get(intake.skuId) ?? 0) + intake.qtyMilli);
    }
    const skuIds = [...bySku.keys()].sort();
    const skuRows = await tx
      .select({
        id: skus.id,
        code: skus.code,
        storageClass: skus.storageClass,
        hazardClass: skus.hazardClass,
        weightGrams: skus.weightGrams,
        lengthMm: skus.lengthMm,
        widthMm: skus.widthMm,
        heightMm: skus.heightMm,
      })
      .from(skus)
      .where(and(eq(skus.tenantId, args.tenantId), inArray(skus.id, skuIds)));
    const skuById = new Map(skuRows.map((row) => [row.id, row]));
    for (const skuId of skuIds) {
      if (!skuById.has(skuId)) {
        throw new ProblemException(
          'not-found',
          404,
          'SKU not found',
          `No SKU with id "${skuId}" exists in this tenant.`,
        );
      }
    }

    // The class gate (12-1) per moving SKU, then the secure authority
    // (12-3) — ONE assert over the involved bin, the placement arm's
    // position (immediately after the class gate).
    for (const skuId of skuIds) {
      const sku = skuById.get(skuId)!;
      if (!storageClassSatisfies(sku.storageClass, bin.storageClass)) {
        throw new ProblemException(
          'bin-storage-mismatch',
          409,
          'Bin does not satisfy the SKU’s storage class',
          `Bin "${bin.code}" is ${bin.storageClass}; SKU "${sku.code}" requires ${sku.storageClass} storage — a non-conforming intake is refused by rule (FR-40).`,
        );
      }
    }
    assertSecureBinAuthority(args.role, [bin]);
    // The bulk-asset occupancy gate (12-4): a tank/silo holds exactly ONE
    // SKU — the predicate over the moving set and the bin's occupants, the
    // same one `mergeBin` and `candidateFitsSku` import.
    if (isBulkAssetType(bin.type)) {
      const occupants = await tx
        .select({ skuId: stockOnHand.skuId, skuCode: skus.code })
        .from(stockOnHand)
        .innerJoin(skus, eq(skus.id, stockOnHand.skuId))
        .where(
          and(
            eq(stockOnHand.tenantId, args.tenantId),
            eq(stockOnHand.warehouseId, args.warehouseId),
            eq(stockOnHand.binId, args.binId),
            sql`${stockOnHand.quantity} > 0`,
          ),
        )
        .groupBy(stockOnHand.skuId, skus.code);
      if (
        !bulkAssetOccupancyHolds(
          bin.type,
          skuIds,
          occupants.map((o) => o.skuId),
        )
      ) {
        const holding = [...new Set(occupants.map((o) => o.skuCode))];
        const moving = skuIds.map((id) => skuById.get(id)!.code);
        throw new ProblemException(
          'bin-occupancy-conflict',
          409,
          'Bulk asset cannot hold two SKUs',
          `Bin "${bin.code}" is a ${bin.type} (a bulk asset holds exactly ONE SKU): ` +
            `it holds ${holding.map((code) => `"${code}"`).join(', ')} and the transfer would land ` +
            `${moving.map((code) => `"${code}"`).join(', ')} — land it in another bulk asset, or ` +
            'top up the holding SKU.',
        );
      }
    }
    // The hazard co-location gate (12-2): the bin's classed occupants, the
    // moving SKUs' own pairs skipped (the same-SKU-consolidation rule).
    const hazardOccupants = await tx
      .select({ skuId: stockOnHand.skuId, skuCode: skus.code, hazardClass: skus.hazardClass })
      .from(stockOnHand)
      .innerJoin(skus, eq(skus.id, stockOnHand.skuId))
      .where(
        and(
          eq(stockOnHand.tenantId, args.tenantId),
          eq(stockOnHand.warehouseId, args.warehouseId),
          eq(stockOnHand.binId, args.binId),
          sql`${stockOnHand.quantity} > 0`,
          sql`${skus.hazardClass} is not null`,
        ),
      );
    for (const occupant of hazardOccupants) {
      if (skuIds.includes(occupant.skuId)) {
        continue;
      }
      for (const skuId of skuIds) {
        const sku = skuById.get(skuId)!;
        if (!hazardClassesCompatible(sku.hazardClass, occupant.hazardClass)) {
          throw new ProblemException(
            'bin-segregation-conflict',
            409,
            'Target bin holds a segregated hazard class',
            `Bin "${bin.code}" holds SKU "${occupant.skuCode}" (${occupant.hazardClass}) — SKU "${sku.code}" ` +
              `(${sku.hazardClass ?? 'no hazard class'}) is segregated from it (FR-41).`,
          );
        }
      }
    }
    // The moving SKUs against EACH OTHER (story 5-1 review): the occupants
    // loop skips a moving SKU's own rows, so two mutually segregated SKUs
    // landing in one bin within a single confirm would pass against empty
    // occupants — and the transfer inbound confirm is the FIRST writer that
    // can create such a pair in one transaction (no prior writer lands two
    // SKUs at once).
    for (let i = 0; i < skuIds.length; i++) {
      for (let j = i + 1; j < skuIds.length; j++) {
        const a = skuById.get(skuIds[i]!)!;
        const b = skuById.get(skuIds[j]!)!;
        if (!hazardClassesCompatible(a.hazardClass, b.hazardClass)) {
          throw new ProblemException(
            'bin-segregation-conflict',
            409,
            'Landing SKUs are segregated from each other',
            `SKUs "${a.code}" (${a.hazardClass ?? 'no hazard class'}) and "${b.code}" ` +
              `(${b.hazardClass ?? 'no hazard class'}) are segregated from each other and cannot ` +
              `land in bin "${bin.code}" together (FR-41).`,
          );
        }
      }
    }

    // The load read (the gates' shared input — one query, the
    // `binOccupancyInTx` shape: LEFT join so the units sum stays
    // join-independent, `::numeric` sums so an adversarial
    // (huge-qty × max-attr) product cannot overflow an int8).
    const loadRows = await tx
      .select({
        units: sql<string>`coalesce(sum(${stockOnHand.quantity}), 0)::bigint`,
        weightLoad: sql<string>`coalesce(sum(${stockOnHand.quantity}::numeric * coalesce(${skus.weightGrams}, 0)), 0)::numeric`,
        volumeLoad: sql<string>`coalesce(sum(${stockOnHand.quantity}::numeric * (coalesce(${skus.lengthMm}, 0) * coalesce(${skus.widthMm}, 0) * coalesce(${skus.heightMm}, 0))), 0)::numeric`,
      })
      .from(stockOnHand)
      .leftJoin(skus, eq(skus.id, stockOnHand.skuId))
      .where(
        and(
          eq(stockOnHand.tenantId, args.tenantId),
          eq(stockOnHand.warehouseId, args.warehouseId),
          eq(stockOnHand.binId, args.binId),
        ),
      );
    const units = Number(loadRows[0]?.units ?? 0);
    const weightLoad = BigInt(loadRows[0]?.weightLoad ?? 0);
    const volumeLoad = BigInt(loadRows[0]?.volumeLoad ?? 0);

    const totalIntakeMilli = [...bySku.values()].reduce((sum, qty) => sum + qty, 0);
    if (units + totalIntakeMilli > bin.capacity) {
      throw new ProblemException(
        'bin-full',
        409,
        'Target bin is full',
        `Bin "${bin.code}" holds ${fromMilli(units)} of ${fromMilli(bin.capacity)} — ` +
          `intaking ${fromMilli(totalIntakeMilli)} more would exceed its capacity.`,
      );
    }
    // The 11-5 family, in the placement's own order: weight → volume → dim
    // fit, per moving SKU's attributes against the whole planned intake's
    // contribution (the conservative coexistence — a dimmed SKU counts toward
    // both). A bin without the matching limit skips the gate (fail-open on
    // missing attributes); a SKU without the attribute contributes zero.
    if (bin.maxWeightGrams !== null) {
      const weightLimit = BigInt(bin.maxWeightGrams) * BigInt(QUANTITY_SCALE);
      let weightAfter = weightLoad;
      for (const skuId of skuIds) {
        const sku = skuById.get(skuId)!;
        weightAfter += BigInt(bySku.get(skuId)!) * BigInt(sku.weightGrams ?? 0);
      }
      if (weightAfter > weightLimit) {
        throw new ProblemException(
          'bin-overweight',
          409,
          'Target bin would exceed its weight capacity',
          `Bin "${bin.code}" would carry ${fromMilliTextFacade(weightAfter)} g of its ${bin.maxWeightGrams} g ` +
            'max weight — the transfer would exceed its weight capacity.',
        );
      }
    }
    if (bin.lengthMm !== null && bin.widthMm !== null && bin.heightMm !== null) {
      const binVolume = BigInt(bin.lengthMm * bin.widthMm * bin.heightMm);
      let volumeAfter = volumeLoad;
      for (const skuId of skuIds) {
        const sku = skuById.get(skuId)!;
        const perUnitVolume = (sku.lengthMm ?? 0) * (sku.widthMm ?? 0) * (sku.heightMm ?? 0);
        volumeAfter += BigInt(bySku.get(skuId)!) * BigInt(perUnitVolume);
      }
      if (volumeAfter > binVolume * BigInt(QUANTITY_SCALE)) {
        throw new ProblemException(
          'bin-volume-exceeded',
          409,
          'Target bin would exceed its volumetric capacity',
          `Bin "${bin.code}" would hold ${fromMilliTextFacade(volumeAfter)} mm³ of its ` +
            `${bin.lengthMm * bin.widthMm * bin.heightMm} mm³ — the transfer would exceed its volumetric capacity.`,
        );
      }
    }
    for (const skuId of skuIds) {
      const sku = skuById.get(skuId)!;
      if (sku.lengthMm !== null && bin.lengthMm !== null && sku.lengthMm > bin.lengthMm) {
        throw binItemOversizeFacade(bin.code, 'length', sku.lengthMm, bin.lengthMm, sku.code);
      }
      if (sku.widthMm !== null && bin.widthMm !== null && sku.widthMm > bin.widthMm) {
        throw binItemOversizeFacade(bin.code, 'width', sku.widthMm, bin.widthMm, sku.code);
      }
      if (sku.heightMm !== null && bin.heightMm !== null && sku.heightMm > bin.heightMm) {
        throw binItemOversizeFacade(bin.code, 'height', sku.heightMm, bin.heightMm, sku.code);
      }
    }
    return { binId: bin.id, binCode: bin.code };
  }
}

/**
 * Milli-units to operator-facing text for loads that are BigInt — the
 * putaway command's `fromMilliText` (the 11-5 pattern), re-homed here rather
 * than imported from `putaway.command` (that file imports THIS facade — the
 * cycle rule). Kept byte-equivalent in wording so the two gates' messages
 * read the same.
 */
function fromMilliTextFacade(milli: bigint): string {
  const negative = milli < 0n;
  const abs = negative ? -milli : milli;
  const whole = (abs / BigInt(QUANTITY_SCALE)).toString();
  const frac = (abs % BigInt(QUANTITY_SCALE))
    .toString()
    .padStart(QUANTITY_DECIMALS, '0')
    .replace(/0+$/, '');
  const text = frac.length === 0 ? whole : `${whole}.${frac}`;
  return negative ? `-${text}` : text;
}

/** The per-axis oversize refusal (the 11-5 gate's own machine code). */
function binItemOversizeFacade(
  binCode: string,
  dimension: 'length' | 'width' | 'height',
  skuMm: number,
  binMm: number,
  skuCode: string,
): ProblemException {
  return new ProblemException(
    'bin-item-oversize',
    409,
    'SKU does not fit the bin',
    `Bin "${binCode}" is too small for SKU "${skuCode}": the bin's ${dimension} is ${binMm} mm but the SKU's ${dimension} is ${skuMm} mm.`,
  );
}

interface QcScopeBatch {
  readonly batchId: string | null;
  readonly quantity: number;
}

/**
 * One (sku, bin) scope's on-hand snapshot: the plain `stock_on_hand` row's
 * quantity plus its per-batch breakdown (the batch rows sum to it on a
 * batch-tracked SKU; an untracked SKU carries none — its single movement
 * rides `batchRef: null`). The Story 3.4 hold command's input truth.
 */
export interface QcScopeOnHand {
  readonly quantity: number;
  readonly batches: readonly QcScopeBatch[];
}

/** One of a hold's `qc.held` events, as the release replays it. */
export interface QcHeldArm {
  readonly seq: number;
  /** The catalog batch the held units belong to (null on an untracked SKU). */
  readonly batchRef: string | null;
  /** The held magnitude (positive) — exactly what release must return. */
  readonly quantity: number;
}

/**
 * One serial of a SKU currently located in a bin (Story 3.6's merge
 * enumeration): the serial identity plus the batch ref its latest ledger
 * movement carried (null on a non-batch-tracked SKU).
 */
export interface SerialLocationEntry {
  readonly serialRef: string;
  readonly batchRef: string | null;
}
