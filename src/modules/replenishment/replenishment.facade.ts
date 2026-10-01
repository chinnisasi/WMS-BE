import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import type {
  BATCH_ALERT_KINDS,
  BATCH_ALERT_STATUSES,
  REPLENISHMENT_BREACH_STATUSES,
  SUGGESTED_PO_STATUSES} from '../../shared/db/schema';
import {
  batchAlerts,
  reorderBreaches,
  reorderPolicies,
  suggestedPos
} from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { fullPrecisionInstant } from '../../shared/primitives/time';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import type {
  BatchAlertEntry,
  BreachEntry,
  DeleteReorderPolicyCommand,
  DismissBatchAlertCommand,
  DismissBreachCommand,
  ExpiryPolicySnapshot,
  ReorderPolicySnapshot,
  SuggestedPoEntry,
  SubmitSuggestedPoCommand,
  SubmitSuggestedPoResult,
  UpsertExpiryPolicyCommand,
  UpsertReorderPolicyCommand,
} from './replenishment.command';
// The row→entry mappers are VALUES here (pageOf calls them) — the value
// import rides along the command class.
import {
  batchAlertEntry,
  breachEntry,
  policySnapshot,
  ReplenishmentCommand,
  suggestedPoEntry,
} from './replenishment.command';
import { ReplenishmentSweep } from './replenishment.sweep';
import type { SweepReport } from './replenishment.sweep';
import { ExpiryScan } from './replenishment.expiry.scan';
import type { BatchScanReport } from './replenishment.expiry.scan';
import { InventoryFacade } from '../inventory/inventory.facade';

export type {
  BatchAlertEntry,
  BreachEntry,
  ExpiryPolicySnapshot,
  ReorderPolicySnapshot,
  SuggestedPoEntry,
  SubmitSuggestedPoResult,
} from './replenishment.command';
export type { BatchScanReport } from './replenishment.expiry.scan';

/**
 * The worker tick's per-tick SCOPE cap (the count scheduler's
 * `MAX_SCHEDULED_TASKS_PER_TICK` precedent): one tick evaluates at most this
 * many (tenant, warehouse) scopes — anything beyond is logged at truncation
 * and carried by a rotating window (the worker's offset advances each
 * truncated tick), so scopes past the cap are delayed a few ticks, never
 * starved, and the frozen ≤5-min visibility bound stays
 * honest (bounded and KNOWN) at scope counts larger than one tick can carry,
 * instead of a serial sweep that silently eats its own poll interval.
 */
export const MAX_REPLENISHMENT_SCOPES_PER_TICK = 200;

/** The reads' page default (the sibling facades' shape). */
export const DEFAULT_REPLENISHMENT_PAGE_SIZE = 50;

export interface ListReorderPoliciesQuery {
  readonly warehouseId?: string | undefined;
  readonly skuId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListBreachesQuery {
  readonly status?: (typeof REPLENISHMENT_BREACH_STATUSES)[number] | undefined;
  readonly warehouseId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListSuggestedPosQuery {
  readonly status?: (typeof SUGGESTED_PO_STATUSES)[number] | undefined;
  readonly warehouseId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListBatchAlertsQuery {
  readonly kind?: (typeof BATCH_ALERT_KINDS)[number] | undefined;
  readonly status?: (typeof BATCH_ALERT_STATUSES)[number] | undefined;
  readonly warehouseId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * The cursor's instant shape (the other read facades' local const).
 */
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    const malformedCursor =
      !UUID_RE.test(decoded.id) ||
      !CURSOR_INSTANT_RE.test(decoded.createdAt) ||
      Number.isNaN(Date.parse(decoded.createdAt));
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
 * The replenishment module's public seam (story 6.1): the reorder-policy
 * writes, the breach dismissal, and the suggested-PO submit ride the module's
 * command service; the lists and the worker's per-scope sweep are the facade's
 * reads/entries. Every other module — and the api shell — talks to
 * replenishment through THIS facade and nothing else (the AD-6 rule the
 * architecture test pins).
 *
 * Reads are never capability-gated (the permissions module's rule); the
 * warehouse filter, when passed, must belong to the tenant (404 otherwise).
 */
@Injectable()
export class ReplenishmentFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // One-way: the facade consumes the commands, the sweep and the scan;
    // none of them sees the facade back.
    @Inject(ReplenishmentCommand) private readonly commands: ReplenishmentCommand,
    @Inject(ReplenishmentSweep) private readonly sweep: ReplenishmentSweep,
    @Inject(ExpiryScan) private readonly expiryScan: ExpiryScan,
    // The queue read's live on-hand stitch (inventory owns the projection).
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  // ── command passthroughs (the api layer's only replenishment mutations) ──

  /** PUT …/replenishment/policies — the per-warehouse override's upsert. */
  upsertReorderPolicy(
    command: UpsertReorderPolicyCommand,
    idempotencyKey: string,
  ): Promise<ReorderPolicySnapshot> {
    return this.commands.upsertReorderPolicy(command, idempotencyKey);
  }

  /** DELETE …/replenishment/policies/:policyId — the override's removal. */
  deleteReorderPolicy(
    command: DeleteReorderPolicyCommand,
    idempotencyKey: string,
  ): Promise<ReorderPolicySnapshot> {
    return this.commands.deleteReorderPolicy(command, idempotencyKey);
  }

  /** POST …/replenishment/breaches/:breachId/dismiss — the human arm. */
  dismissBreach(command: DismissBreachCommand, idempotencyKey: string): Promise<BreachEntry> {
    return this.commands.dismissBreach(command, idempotencyKey);
  }

  /**
   * POST …/replenishment/suggested-pos/:draftId/submit — the ONLY writer of
   * a real PO in this story; the response carries the FLAT PO snapshot.
   */
  submitSuggestedPo(
    command: SubmitSuggestedPoCommand,
    idempotencyKey: string,
  ): Promise<SubmitSuggestedPoResult> {
    return this.commands.submitSuggestedPo(command, idempotencyKey);
  }

  /**
   * PUT …/replenishment/expiry-policies — the tenant's expiry/aging config
   * (last-write-wins; the api layer's only write to it).
   */
  upsertExpiryPolicy(
    command: UpsertExpiryPolicyCommand,
    idempotencyKey: string,
  ): Promise<ExpiryPolicySnapshot> {
    return this.commands.upsertExpiryPolicy(command, idempotencyKey);
  }

  /** POST …/replenishment/batch-alerts/:alertId/dismiss — the human arm. */
  dismissBatchAlert(
    command: DismissBatchAlertCommand,
    idempotencyKey: string,
  ): Promise<BatchAlertEntry> {
    return this.commands.dismissBatchAlert(command, idempotencyKey);
  }

  // ── the worker's entries ──────────────────────────────────────────────────

  /**
   * The ReplenishmentSchedulerWorker's per-scope entry (the count scheduler's
   * `generateScheduledCountTasks` shape): one (tenant, warehouse) swept in
   * the three-phase structure the sweep owns — a poison or Valkey-down scope
   * is logged and skipped by the worker, never starves the tick.
   */
  sweepScope(tenantId: string, warehouseId: string): Promise<SweepReport> {
    return this.sweep.sweepScope(tenantId, warehouseId);
  }

  /**
   * The ReplenishmentSchedulerWorker's per-scope expiry/aging entry (the
   * sweep's sibling — the SAME tick, called beside it): one (tenant,
   * warehouse) scanned by the `ExpiryScan`; a poison scope is logged and
   * skipped by the worker, never starves the tick. The tenant's config row
   * absent → no-op (the "absent row = disabled" convention).
   */
  scanScope(tenantId: string, warehouseId: string): Promise<BatchScanReport> {
    return this.expiryScan.scanScope(tenantId, warehouseId);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** GET …/replenishment/policies — the override rows, keyset cursor, filters. */
  async listReorderPolicies(
    tenantId: string,
    query: ListReorderPoliciesQuery = {},
  ): Promise<Page<ReorderPolicySnapshot>> {
    const pageSize = query.limit ?? DEFAULT_REPLENISHMENT_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await this.assertWarehouseFilter(tx, tenantId, query.warehouseId);
      const rows = await tx
        .select({
          row: reorderPolicies,
          createdAtText: sql<string>`${reorderPolicies.createdAt}::text`,
        })
        .from(reorderPolicies)
        .where(
          and(
            eq(reorderPolicies.tenantId, tenantId),
            query.warehouseId === undefined
              ? undefined
              : eq(reorderPolicies.warehouseId, query.warehouseId),
            query.skuId === undefined ? undefined : eq(reorderPolicies.skuId, query.skuId),
            before === undefined
              ? undefined
              : sql`(${reorderPolicies.createdAt}, ${reorderPolicies.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(reorderPolicies.createdAt), desc(reorderPolicies.id))
        .limit(pageSize + 1);
      // buildPage encodes the cursor from the FULL-precision instants (the
      // countVariances list's rule); the surfaced entries keep the canonical
      // body shape.
      return this.pageOf(rows, pageSize, policySnapshot);
    });
  }

  /** GET …/replenishment/breaches — the alert rows, status-filterable (the tabs). */
  async listBreaches(
    tenantId: string,
    query: ListBreachesQuery = {},
  ): Promise<Page<BreachEntry>> {
    const pageSize = query.limit ?? DEFAULT_REPLENISHMENT_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await this.assertWarehouseFilter(tx, tenantId, query.warehouseId);
      const rows = await tx
        .select({
          row: reorderBreaches,
          createdAtText: sql<string>`${reorderBreaches.createdAt}::text`,
        })
        .from(reorderBreaches)
        .where(
          and(
            eq(reorderBreaches.tenantId, tenantId),
            query.status === undefined
              ? undefined
              : eq(reorderBreaches.status, query.status),
            query.warehouseId === undefined
              ? undefined
              : eq(reorderBreaches.warehouseId, query.warehouseId),
            before === undefined
              ? undefined
              : sql`(${reorderBreaches.createdAt}, ${reorderBreaches.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(reorderBreaches.createdAt), desc(reorderBreaches.id))
        .limit(pageSize + 1);
      return this.pageOf(rows, pageSize, breachEntry);
    });
  }

  /** GET …/replenishment/suggested-pos — the drafts queue, status-filterable. */
  async listSuggestedPos(
    tenantId: string,
    query: ListSuggestedPosQuery = {},
  ): Promise<Page<SuggestedPoEntry>> {
    const pageSize = query.limit ?? DEFAULT_REPLENISHMENT_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await this.assertWarehouseFilter(tx, tenantId, query.warehouseId);
      const rows = await tx
        .select({
          row: suggestedPos,
          createdAtText: sql<string>`${suggestedPos.createdAt}::text`,
        })
        .from(suggestedPos)
        .where(
          and(
            eq(suggestedPos.tenantId, tenantId),
            query.status === undefined
              ? undefined
              : eq(suggestedPos.status, query.status),
            query.warehouseId === undefined
              ? undefined
              : eq(suggestedPos.warehouseId, query.warehouseId),
            before === undefined
              ? undefined
              : sql`(${suggestedPos.createdAt}, ${suggestedPos.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(suggestedPos.createdAt), desc(suggestedPos.id))
        .limit(pageSize + 1);
      return this.pageOf(rows, pageSize, suggestedPoEntry);
    });
  }

  /**
   * GET …/replenishment/expiry-policies — the tenant's config row, or null
   * when ABSENT (the controller renders 404 — the "absent row = disabled"
   * convention's read shape; no default days hide behind a missing row).
   */
  async getExpiryPolicy(tenantId: string): Promise<ExpiryPolicySnapshot | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) =>
      this.expiryScan.readConfigInTx(tx, tenantId),
    );
  }

  /**
   * GET …/replenishment/batch-alerts — the expiry/aging queue, kind/status/
   * warehouse-filterable. Each page row's LIVE on-hand is stitched in (the
   * spec's queue-freshness rule — the alert rows freeze their detection
   * facts, the read re-reads the projection): the page's scopes go through
   * the inventory facade's in-tx sums read on the SAME transaction, so no
   * second connection opens while one is held.
   */
  async listBatchAlerts(
    tenantId: string,
    query: ListBatchAlertsQuery = {},
  ): Promise<Page<BatchAlertEntry & { readonly onHandMilli: number }>> {
    const pageSize = query.limit ?? DEFAULT_REPLENISHMENT_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await this.assertWarehouseFilter(tx, tenantId, query.warehouseId);
      const rows = await tx
        .select({
          row: batchAlerts,
          createdAtText: sql<string>`${batchAlerts.createdAt}::text`,
        })
        .from(batchAlerts)
        .where(
          and(
            eq(batchAlerts.tenantId, tenantId),
            query.kind === undefined ? undefined : eq(batchAlerts.kind, query.kind),
            query.status === undefined ? undefined : eq(batchAlerts.status, query.status),
            query.warehouseId === undefined
              ? undefined
              : eq(batchAlerts.warehouseId, query.warehouseId),
            before === undefined
              ? undefined
              : sql`(${batchAlerts.createdAt}, ${batchAlerts.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(batchAlerts.createdAt), desc(batchAlerts.id))
        .limit(pageSize + 1);
      // The freshness stitch: one in-tx sums read for the page's scopes,
      // keyed (w, sku, batch); an alert whose last unit was consumed renders
      // 0. RLS on `batch_on_hand` is already scoped by the tenant tx.
      const sums = await this.inventory.batchScopeSumsForScopesInTx(
        tx,
        tenantId,
        rows.map((wrapped) => ({
          warehouseId: wrapped.row.warehouseId,
          skuId: wrapped.row.skuId,
          batchId: wrapped.row.batchId,
        })),
      );
      const onHandByKey = new Map(
        sums.map((sum) => [`${sum.warehouseId}|${sum.skuId}|${sum.batchId}`, sum.quantityMilli]),
      );
      const page = this.pageOf(rows, pageSize, batchAlertEntry);
      return {
        items: page.items.map((entry) => ({
          ...entry,
          onHandMilli: onHandByKey.get(`${entry.warehouseId}|${entry.skuId}|${entry.batchId}`) ?? 0,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** The warehouse filter must name a warehouse of the tenant (404 otherwise). */
  private async assertWarehouseFilter(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string | undefined,
  ): Promise<void> {
    if (warehouseId !== undefined) {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
    }
  }

  /** The wrapped rows → page (cursor from full precision, body canonical). */
  private pageOf<Row, Entry>(
    rows: readonly { row: Row; createdAtText: string }[],
    pageSize: number,
    toEntry: (row: Row) => Entry,
  ): Page<Entry> {
    const wrapped = rows.map((wrapped) => ({
      createdAt: fullPrecisionInstant(wrapped.createdAtText),
      id: (wrapped.row as { id: string }).id,
      entry: toEntry(wrapped.row),
    }));
    const page = buildPage(wrapped, pageSize);
    return { items: page.items.map((item) => item.entry), nextCursor: page.nextCursor };
  }
}