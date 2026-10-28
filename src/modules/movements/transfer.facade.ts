import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import type {
  COUNT_TASK_ORIGINS,
  COUNT_TASK_STATUSES,
  COUNT_VARIANCE_STATUSES} from '../../shared/db/schema';
import {
  bins,
  countTaskLines,
  countTasks,
  countVariances,
  skus,
  transferOrderLines,
  transferOrders,
  warehouses,
  type TransferOrder,
  type TransferOrderLine,
} from '../../shared/db/schema';
import { fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import type { Page } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { skuOfClient } from '../../shared/db/client-filter';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { ROLE_CAPABILITIES } from '../tenancy/permissions';
import { InventoryFacade } from '../inventory/inventory.facade';
import {
  TransferService,
  transferLegEventsInTx,
  type TransferConfirmSnapshot,
  type TransferLegEventSnapshot,
  type TransferOrderSnapshot,
} from './transfer.command';
import {
  CountService,
  blindSubmitResponse,
  varianceEntry,
  type CountPoliciesSnapshot,
  type CountVarianceEntry,
  type CreateCountSnapshot,
  type CreateCountsBulkCommand,
  type CreateCountsBulkSnapshot,
  type DeleteCountPolicyCommand,
  type ResolveCountVarianceCommand,
  type ResolveCountVarianceSnapshot,
  type SetVariancePolicyCommand,
  type SubmitCountSnapshot,
  type VariancePolicySnapshot,
} from './count.command';
import { VariancePolicyCommand } from './variance-policy.command';
import { MoveCommand, type MoveStockCommand, type MoveStockSnapshot } from './move.command';
import { moveReasonEntries, type MoveReasonEntry } from './move-reason';

/**
 * The movements module's public seam (Story 5-1): every other module (and the
 * api shell) talks to transfers through THIS facade and nothing else — the
 * AD-6 rule the architecture test pins. The commands live on
 * `TransferService`; the facade adds the reads (detail, keyset list, the
 * device snapshot's derived Transfer inbox tasks) and the one-argument
 * passthroughs the controller calls.
 *
 * Reads are never capability-gated (the permissions module's rule); the
 * warehouse must belong to the tenant (404 otherwise).
 */

/** The api layer's list page defaults (the receiving facade's shape). */
export const DEFAULT_TRANSFER_PAGE_SIZE = 50;
/** The cap on the snapshot's Transfer inbox tasks (the pick/pack precedent). */
export const MAX_SNAPSHOT_TRANSFER_TASKS = 500;
/** The cap on the snapshot's Count inbox tasks (the same precedent). */
export const MAX_SNAPSHOT_COUNT_TASKS = 500;
/** The scheduler's per-warehouse-per-tick task bound (PENDING: tunable). */
export const MAX_SCHEDULED_TASKS_PER_TICK = 200;

/** The variance queue read's page default (the pendings queue's shape). */
export const DEFAULT_VARIANCE_PAGE_SIZE = 50;

export interface ListCountVariancesQuery {
  readonly status?: (typeof COUNT_VARIANCE_STATUSES)[number] | undefined;
  readonly warehouseId?: string | undefined;
  /** Story 1-5a — only variances of one client's SKUs. */
  readonly clientId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** Story 3-5a — the web count-task list's page default and ceiling. */
export const DEFAULT_COUNT_TASK_PAGE_SIZE = 50;

export interface ListCountTasksQuery {
  readonly warehouseId?: string | undefined;
  readonly status?: (typeof COUNT_TASK_STATUSES)[number] | undefined;
  readonly origin?: (typeof COUNT_TASK_ORIGINS)[number] | undefined;
  readonly binId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** One row of the web count-task list (story 3-5a) — no quantities. */
export interface CountTaskListEntry {
  readonly id: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly binCode: string;
  readonly status: (typeof COUNT_TASK_STATUSES)[number];
  readonly origin: (typeof COUNT_TASK_ORIGINS)[number];
  /** The planner; null = the system (the scheduler, or an epoch-mismatch / review recount). */
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly completedBy: string | null;
  readonly completedAt: string | null;
  readonly lineCount: number;
  readonly varianceCount: number;
  readonly openVarianceCount: number;
}

/**
 * The web count-task detail (story 3-5a) — the ONLY read that shows expected
 * beside counted. Staff web sessions only (`TenantSessionGuard`): a device
 * token is 401, a portal token 403.
 */
export interface CountTaskDetail {
  readonly task: {
    readonly id: string;
    readonly warehouseId: string;
    readonly binId: string;
    readonly binCode: string;
    readonly status: (typeof COUNT_TASK_STATUSES)[number];
    readonly origin: (typeof COUNT_TASK_ORIGINS)[number];
    readonly binStateEpoch: number | null;
    readonly createdBy: string | null;
    readonly createdAt: string;
    readonly completedBy: string | null;
    readonly completedAt: string | null;
    /** A movement moved the bin between task start and submit (OQ-2); false while pending. */
    readonly epochConflict: boolean;
  };
  readonly lines: readonly {
    readonly skuId: string;
    readonly skuCode: string;
    readonly skuName: string | null;
    /** Base units — frozen at task start (0 for a SKU found at submit). */
    readonly expectedQuantity: number;
    /** Base units; null while the task is pending. */
    readonly countedQuantity: number | null;
  }[];
  readonly variances: readonly {
    readonly id: string;
    readonly skuId: string;
    readonly expectedQuantity: number;
    readonly countedQuantity: number;
    readonly delta: number;
    readonly epochConflict: boolean;
    readonly status: (typeof COUNT_VARIANCE_STATUSES)[number];
    readonly recountTaskId: string | null;
  }[];
  /** The recount task a variance of this task names (the latest resolved); null when none. */
  readonly recountTaskId: string | null;
  /** The recount the submit minted on an epoch conflict (OQ-2); null when none. */
  readonly conflictRecountTaskId: string | null;
}

export interface ListTransfersQuery {
  readonly status?: string | undefined;
  readonly sourceWarehouseId?: string | undefined;
  readonly destWarehouseId?: string | undefined;
  /** Story 1-5a — only transfers with ANY line of one client's SKUs (a mixed transfer appears under each). */
  readonly clientId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface TransferListEntry {
  readonly id: string;
  readonly status: string;
  readonly sourceWarehouseId: string;
  readonly sourceWarehouseCode: string;
  readonly destWarehouseId: string;
  readonly destWarehouseCode: string;
  readonly lineCount: number;
  readonly totalUnits: number;
  readonly note: string | null;
  readonly createdAt: string;
}

/** One line of the device snapshot's Transfer inbox task card. */
export interface TransferTaskLine {
  readonly lineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string | null;
  /** Base units at the edge (story 10.1). */
  readonly qty: number;
  readonly batchRef: string | null;
  /** The PLANNED landing bin — the confirm's dest-bin scan pre-fills from it. */
  readonly destBinId: string;
  readonly destBinCode: string;
  /** The dest bin's state epoch, captured on the SAME transaction as the task (the pick precedent). */
  readonly binStateEpoch: number | null;
}

export interface TransferTask {
  readonly transferId: string;
  readonly sourceWarehouseId: string;
  readonly sourceWarehouseCode: string;
  readonly sourceWarehouseName: string;
  readonly destWarehouseId: string;
  readonly note: string | null;
  readonly outboundConfirmedAt: string;
  readonly lines: readonly TransferTaskLine[];
}

/**
 * One card of the device snapshot's Count inbox tasks (Story 5-3): a STORED
 * `pending` count task for this warehouse. Story 3-5a — BLIND: a line names
 * the SKU and nothing else. The per-SKU expectations frozen at task start
 * never reach a device (they are read on the web through the task detail);
 * the submit names every line with a counted quantity (0 explicitly is
 * valid) and may add SKUs found in the bin.
 */
export interface CountTaskLine {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string | null;
}

export interface CountTaskCard {
  readonly taskId: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly binCode: string;
  readonly origin: string;
  /**
   * The bin state frozen at task start — informational: the submit reads the
   * epoch from the task row, never from the device.
   */
  readonly binStateEpoch: number | null;
  readonly createdAt: string;
  readonly lines: readonly CountTaskLine[];
}

export interface TransferDetail {
  readonly transfer: {
    readonly id: string;
    readonly status: string;
    readonly sourceWarehouseId: string;
    readonly destWarehouseId: string;
    readonly note: string | null;
    readonly createdBy: string;
    readonly outboundConfirmedBy: string | null;
    readonly outboundConfirmedAt: string | null;
    readonly inboundConfirmedBy: string | null;
    readonly inboundConfirmedAt: string | null;
    readonly cancelledBy: string | null;
    readonly cancelledAt: string | null;
    readonly createdAt: string;
  };
  readonly lines: readonly {
    readonly id: string;
    readonly skuId: string;
    readonly skuCode: string;
    readonly quantity: number;
    readonly fromBinId: string;
    readonly fromBinCode: string;
    readonly toBinId: string;
    readonly toBinCode: string;
    readonly batchRef: string | null;
    readonly note: string | null;
  }[];
  readonly events: readonly TransferLegEventSnapshot[];
}

/** The cursor's instant shape (the other read facades' local const). */
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

@Injectable()
export class MovementsFacade {
  // The snapshot feed's truncation signal (story 5-3 review): the facade has
  // no logger of its own, so the standard Nest logger pattern carries it.
  private readonly logger = new Logger('MovementsFacade');
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // One-way: the facade consumes the commands; the commands never see it.
    @Inject(TransferService) private readonly commands: TransferService,
    @Inject(CountService) private readonly countCommands: CountService,
    @Inject(VariancePolicyCommand) private readonly variancePolicies: VariancePolicyCommand,
    // Story 3-1 — the bin-to-bin move.
    @Inject(MoveCommand) private readonly moves: MoveCommand,
    // The epoch read for the task cards (the same-tx capture the pick
    // command's task read established) and — nothing else; every stock write
    // already went through the command's facade passthroughs.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  /**
   * Story 3-3b (decision 11, A13) — the open count lines in one bin: the lines
   * of its `pending` count tasks. A blocked bin is still counted (counting
   * damaged stock is the point), so these stay open; the block impact preview
   * only reports them. A read on the caller's transaction.
   */
  async openCountLinesInBinInTx(tx: TenantTx, tenantId: string, warehouseId: string, binId: string): Promise<number> {
    const rows = await tx
      .select({ n: sql<string>`count(*)::bigint` })
      .from(countTaskLines)
      .innerJoin(countTasks, and(eq(countTasks.tenantId, countTaskLines.tenantId), eq(countTasks.id, countTaskLines.taskId)))
      .where(
        and(
          eq(countTaskLines.tenantId, tenantId),
          eq(countTasks.warehouseId, warehouseId),
          eq(countTasks.binId, binId),
          eq(countTasks.status, 'pending'),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  // ── command passthroughs (the api layer's only transfer mutations) ──────

  createTransfer(command: Parameters<TransferService['createTransfer']>[0], idempotencyKey: string) {
    return this.commands.createTransfer(command, idempotencyKey).then((result) => result.snapshot);
  }

  confirmOutbound(
    command: Parameters<TransferService['confirmOutbound']>[0],
    idempotencyKey: string,
  ): Promise<TransferConfirmSnapshot> {
    return this.commands.confirmOutbound(command, idempotencyKey).then((result) => result.snapshot);
  }

  confirmInbound(
    command: Parameters<TransferService['confirmInbound']>[0],
    idempotencyKey: string,
  ): Promise<TransferConfirmSnapshot> {
    return this.commands.confirmInbound(command, idempotencyKey).then((result) => result.snapshot);
  }

  cancelTransfer(command: Parameters<TransferService['cancelTransfer']>[0], idempotencyKey: string) {
    return this.commands.cancelTransfer(command, idempotencyKey).then((result) => result.snapshot);
  }

  // ── the bin-to-bin move (story 3-1) ─────────────────────────────────────

  /** POST …/warehouses/{w}/inventory/moves — the handheld's `stock.move` op and the web Moves page. */
  moveStock(command: MoveStockCommand, idempotencyKey: string): Promise<MoveStockSnapshot> {
    return this.moves.moveStock(command, idempotencyKey);
  }

  /**
   * The move reason vocabulary — the device snapshot's `moveReasons` arm,
   * composed by the api shell (inbound's snapshot never imports this module).
   */
  moveReasons(): MoveReasonEntry[] {
    return moveReasonEntries();
  }

  // ── count command passthroughs (story 5-3; the api layer's only count
  //    mutations) ──────────────────────────────────────────────────────────

  createCount(
    command: Parameters<CountService['createCount']>[0],
    idempotencyKey: string,
  ): Promise<CreateCountSnapshot> {
    return this.countCommands.createCount(command, idempotencyKey).then((result) => result.snapshot);
  }

  /** Story 3-5a — the bulk on-demand create (bins or a zone). */
  createCountsBulk(
    command: CreateCountsBulkCommand,
    idempotencyKey: string,
  ): Promise<CreateCountsBulkSnapshot> {
    return this.countCommands.createCountsBulk(command, idempotencyKey).then((result) => result.snapshot);
  }

  submitCount(
    command: Parameters<CountService['submitCount']>[0],
    idempotencyKey: string,
  ): Promise<SubmitCountSnapshot> {
    // Story 3-5a — blind for every caller (the HTTP route and the review
    // apply): the command already answers blind; projecting here too keeps
    // the seam's contract independent of the command's internals.
    return this.countCommands
      .submitCount(command, idempotencyKey)
      .then((result) => blindSubmitResponse(result.snapshot));
  }

  /** Story 3-5a — `DELETE …/count-policies/{abcClass}`: unschedule one class. */
  deleteCountPolicy(
    command: DeleteCountPolicyCommand,
    idempotencyKey: string,
  ): Promise<CountPoliciesSnapshot> {
    return this.countCommands.deleteCountPolicy(command, idempotencyKey).then((result) => result.snapshot);
  }

  /** Story 3-5a — `GET …/count-policies`: the warehouse's schedule (any staff). */
  getCountPolicies(tenantId: string, warehouseId: string): Promise<CountPoliciesSnapshot> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      return { policies: await this.countCommands.countPoliciesInTx(tx, tenantId, warehouseId) };
    });
  }

  /**
   * Story 3-5a — `GET …/movements/counts`: the web count-task list. Newest
   * first, keyset on `(created_at desc, id desc)`, filterable by warehouse,
   * status, origin and bin. EXEMPT from the client filter (a bin may hold
   * several clients' goods, and the list names no SKU). No quantities.
   */
  async listCountTasks(tenantId: string, query: ListCountTasksQuery = {}): Promise<Page<CountTaskListEntry>> {
    const pageSize = query.limit ?? DEFAULT_COUNT_TASK_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if (query.warehouseId !== undefined) {
        await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      }
      const rows = await tx
        .select({
          row: countTasks,
          binCode: bins.code,
          createdAtText: sql<string>`${countTasks.createdAt}::text`,
        })
        .from(countTasks)
        .innerJoin(bins, and(eq(bins.tenantId, countTasks.tenantId), eq(bins.id, countTasks.binId)))
        .where(
          and(
            eq(countTasks.tenantId, tenantId),
            query.warehouseId === undefined ? undefined : eq(countTasks.warehouseId, query.warehouseId),
            query.status === undefined ? undefined : eq(countTasks.status, query.status),
            query.origin === undefined ? undefined : eq(countTasks.origin, query.origin),
            query.binId === undefined ? undefined : eq(countTasks.binId, query.binId),
            before === undefined
              ? undefined
              : sql`(${countTasks.createdAt}, ${countTasks.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(countTasks.createdAt), desc(countTasks.id))
        .limit(pageSize + 1);
      const page = buildPage(
        rows.map((wrapped) => ({
          createdAt: fullPrecisionInstant(wrapped.createdAtText),
          id: wrapped.row.id,
          wrapped,
        })),
        pageSize,
      );
      const taskIds = page.items.map((item) => item.id);
      const lineCounts = new Map<string, number>();
      const varianceCounts = new Map<string, { all: number; open: number }>();
      if (taskIds.length > 0) {
        const lineRows = await tx
          .select({ taskId: countTaskLines.taskId, n: sql<number>`count(*)::int` })
          .from(countTaskLines)
          .where(and(eq(countTaskLines.tenantId, tenantId), inArray(countTaskLines.taskId, taskIds)))
          .groupBy(countTaskLines.taskId);
        for (const row of lineRows) lineCounts.set(row.taskId, Number(row.n));
        const varianceRows = await tx
          .select({
            taskId: countVariances.taskId,
            all: sql<number>`count(*)::int`,
            open: sql<number>`(count(*) filter (where ${countVariances.status} = 'open'))::int`,
          })
          .from(countVariances)
          .where(and(eq(countVariances.tenantId, tenantId), inArray(countVariances.taskId, taskIds)))
          .groupBy(countVariances.taskId);
        for (const row of varianceRows) varianceCounts.set(row.taskId, { all: Number(row.all), open: Number(row.open) });
      }
      return {
        items: page.items.map(({ wrapped }) => {
          const task = wrapped.row;
          return {
            id: task.id,
            warehouseId: task.warehouseId,
            binId: task.binId,
            binCode: wrapped.binCode,
            status: task.status as (typeof COUNT_TASK_STATUSES)[number],
            origin: task.origin as (typeof COUNT_TASK_ORIGINS)[number],
            createdBy: task.createdBy,
            createdAt: canonicalInstant(task.createdAt),
            completedBy: task.completedBy,
            completedAt: task.completedAt === null ? null : canonicalInstant(task.completedAt),
            lineCount: lineCounts.get(task.id) ?? 0,
            varianceCount: varianceCounts.get(task.id)?.all ?? 0,
            openVarianceCount: varianceCounts.get(task.id)?.open ?? 0,
          };
        }),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * Story 3-5a — `GET …/movements/counts/{taskId}`: expected beside counted,
   * the task's variances and the recount a variance names. The only read
   * that shows an expected quantity; web staff sessions only.
   */
  async getCountTask(tenantId: string, actorUserId: string, taskId: string): Promise<CountTaskDetail> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // A GATED read: expected quantities are for the count planners and the
      // variance resolvers only — an operator (who counts blind on the
      // handheld) must not read them on the web either. 403 role-denied
      // before anything is read.
      const role = await getMemberRoleIn(tx, tenantId, actorUserId);
      if (!ROLE_CAPABILITIES[role].has('counts.manage') && !ROLE_CAPABILITIES[role].has('variances.resolve')) {
        throw new ProblemException(
          'role-denied',
          403,
          'Role lacks the required capability',
          `Role "${role}" includes neither "counts.manage" nor "variances.resolve" — the count detail shows expected quantities, which the counter does not see.`,
        );
      }
      const taskRows = await tx
        .select({ row: countTasks, binCode: bins.code })
        .from(countTasks)
        .innerJoin(bins, and(eq(bins.tenantId, countTasks.tenantId), eq(bins.id, countTasks.binId)))
        .where(and(eq(countTasks.tenantId, tenantId), eq(countTasks.id, taskId)))
        .limit(1);
      const found = taskRows[0];
      if (found === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Count task not found',
          'No count task with this id exists in this tenant.',
        );
      }
      const task = found.row;
      const lineRows = await tx
        .select({
          skuId: countTaskLines.skuId,
          skuCode: skus.code,
          skuName: skus.name,
          expected: countTaskLines.expectedQuantity,
          counted: countTaskLines.countedQuantity,
        })
        .from(countTaskLines)
        .innerJoin(skus, and(eq(skus.tenantId, countTaskLines.tenantId), eq(skus.id, countTaskLines.skuId)))
        .where(and(eq(countTaskLines.tenantId, tenantId), eq(countTaskLines.taskId, taskId)))
        .orderBy(asc(skus.code), asc(countTaskLines.skuId));
      const varianceRows = await tx
        .select()
        .from(countVariances)
        .where(and(eq(countVariances.tenantId, tenantId), eq(countVariances.taskId, taskId)))
        .orderBy(asc(countVariances.createdAt), asc(countVariances.id));
      // The recount a variance names (the resolve's recount arm) — the
      // latest resolved one when several do, ties broken by variance id.
      const recountRow = [...varianceRows]
        .filter((row) => row.recountTaskId !== null)
        .sort((a, b) => {
          const at = a.resolvedAt ?? '';
          const bt = b.resolvedAt ?? '';
          if (at !== bt) return at < bt ? 1 : -1;
          return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        })[0];
      // The EPOCH-CONFLICT recount (OQ-2): the submit mints it in its own
      // transaction, stamped created_at = the source's completed_at. It is
      // the bin's first `recount` task created at/after that instant (ties
      // by id), accepted only when it carries exactly that stamp — a later
      // recount (a variance resolution) is not the conflict's. A conflict
      // with no variance rows is still found this way.
      let conflictRecountTaskId: string | null = null;
      if (task.completedAt !== null) {
        const candidates = await tx
          .select({ id: countTasks.id, exact: sql<boolean>`${countTasks.createdAt} = ${task.completedAt}::timestamptz` })
          .from(countTasks)
          .where(
            and(
              eq(countTasks.tenantId, tenantId),
              eq(countTasks.warehouseId, task.warehouseId),
              eq(countTasks.binId, task.binId),
              eq(countTasks.origin, 'recount'),
              sql`${countTasks.createdAt} >= ${task.completedAt}::timestamptz`,
            ),
          )
          .orderBy(asc(countTasks.createdAt), asc(countTasks.id))
          .limit(1);
        if (candidates[0]?.exact === true) {
          conflictRecountTaskId = candidates[0].id;
        }
      }
      const epochConflict = conflictRecountTaskId !== null || varianceRows.some((row) => row.epochConflict);
      return {
        task: {
          id: task.id,
          warehouseId: task.warehouseId,
          binId: task.binId,
          binCode: found.binCode,
          status: task.status as (typeof COUNT_TASK_STATUSES)[number],
          origin: task.origin as (typeof COUNT_TASK_ORIGINS)[number],
          binStateEpoch: task.binStateEpoch,
          createdBy: task.createdBy,
          createdAt: canonicalInstant(task.createdAt),
          completedBy: task.completedBy,
          completedAt: task.completedAt === null ? null : canonicalInstant(task.completedAt),
          epochConflict,
        },
        lines: lineRows.map((line) => ({
          skuId: line.skuId,
          skuCode: line.skuCode,
          skuName: line.skuName,
          expectedQuantity: fromMilli(line.expected),
          countedQuantity: line.counted === null ? null : fromMilli(line.counted),
        })),
        variances: varianceRows.map((row) => ({
          id: row.id,
          skuId: row.skuId,
          expectedQuantity: fromMilli(row.expectedQuantity),
          countedQuantity: fromMilli(row.countedQuantity),
          delta: fromMilli(row.deltaMilli),
          epochConflict: row.epochConflict,
          status: row.status as (typeof COUNT_VARIANCE_STATUSES)[number],
          recountTaskId: row.recountTaskId,
        })),
        recountTaskId: recountRow?.recountTaskId ?? null,
        conflictRecountTaskId,
      };
    });
  }

  upsertCountPolicies(
    command: Parameters<CountService['upsertCountPolicies']>[0],
    idempotencyKey: string,
  ): Promise<CountPoliciesSnapshot> {
    return this.countCommands
      .upsertCountPolicies(command, idempotencyKey)
      .then((result) => result.snapshot);
  }

  /**
   * The CountSchedulerWorker's entry (the reaper precedent — the worker
   * drives the facade, no HTTP command layer): one warehouse's due tasks,
   * generated in ONE tenant transaction the worker opens. All-or-nothing
   * per warehouse; the warehouse advisory lock is taken inside.
   */
  generateScheduledCountTasks(
    tenantId: string,
    warehouseId: string,
    maxTasks: number,
  ): Promise<readonly string[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.countCommands.generateScheduledTasksInTx(tx, tenantId, warehouseId, maxTasks),
    );
  }

  // ── variance command passthroughs (story 5-4; the api layer's only
  //    variance mutations) ─────────────────────────────────────────────────

  /** PUT …/movements/variance-policies — the tenant's threshold row. */
  setVariancePolicy(
    command: SetVariancePolicyCommand,
    idempotencyKey: string,
  ): Promise<VariancePolicySnapshot> {
    return this.variancePolicies.setVariancePolicy(command, idempotencyKey);
  }

  /** GET …/movements/variance-policies — null when no row exists (disabled). */
  getVariancePolicy(tenantId: string): Promise<VariancePolicySnapshot | null> {
    return this.variancePolicies.getVariancePolicy(tenantId);
  }

  /** POST …/movements/variances/:varianceId/resolve — the arm's execution. */
  resolveCountVariance(
    command: ResolveCountVarianceCommand,
    idempotencyKey: string,
  ): Promise<ResolveCountVarianceSnapshot> {
    return this.countCommands
      .resolveCountVariance(command, idempotencyKey)
      .then((result) => result.snapshot);
  }

  /**
   * Story 5-6 — the AD-14 recount arm's mint, in-transaction for the caller
   * that holds the locks (bin row `.for('update')` → warehouse advisory
   * LAST) and whose own resolve transaction closes the reported row. The
   * open-task rule and the capture live INSIDE the count core
   * (`mintRecountTaskForBinInTx`) — no ledger-write shortcut sits outside it.
   */
  mintRecountTaskInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    binId: string,
    binCode: string,
    occurredAt: string,
  ): Promise<string> {
    return this.countCommands.mintRecountTaskForBinInTx(
      tx,
      tenantId,
      warehouseId,
      binId,
      binCode,
      occurredAt,
    );
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** The transfer detail read: the order, its lines, and BOTH legs' events. */
  async getTransfer(tenantId: string, transferId: string): Promise<TransferDetail> {
    return withTenantTransaction(this.db, tenantId, (tx) => this.getTransferInTx(tx, tenantId, transferId));
  }

  async getTransferInTx(tx: TenantTx, tenantId: string, transferId: string): Promise<TransferDetail> {
    const orderRows = await tx
      .select()
      .from(transferOrders)
      .where(and(eq(transferOrders.tenantId, tenantId), eq(transferOrders.id, transferId)))
      .limit(1);
    const order = orderRows[0];
    if (order === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'Transfer order not found',
        'No transfer order with this id exists in this tenant.',
      );
    }
    const lineRows = await tx
      .select({
        id: transferOrderLines.id,
        skuId: transferOrderLines.skuId,
        skuCode: skus.code,
        quantity: transferOrderLines.quantity,
        fromBinId: transferOrderLines.fromBinId,
        toBinId: transferOrderLines.toBinId,
        batchRef: transferOrderLines.batchRef,
        note: transferOrderLines.note,
      })
      .from(transferOrderLines)
      .innerJoin(skus, eq(skus.id, transferOrderLines.skuId))
      .where(
        and(eq(transferOrderLines.tenantId, tenantId), eq(transferOrderLines.transferId, transferId)),
      )
      .orderBy(asc(transferOrderLines.id));
    // The legs' bin codes (both warehouses' bins join in by id — a bare
    // existence read; the line ids already scope them tenant-side).
    const binIds = [...new Set(lineRows.flatMap((line) => [line.fromBinId, line.toBinId]))];
    const binRows =
      binIds.length === 0
        ? []
        : await tx
            .select({ id: bins.id, code: bins.code })
            .from(bins)
            .where(and(eq(bins.tenantId, tenantId), inArray(bins.id, binIds)));
    const binCodeById = new Map(binRows.map((row) => [row.id, row.code]));
    // Both legs' events, ordered by `transferLegEventsInTx` as (warehouseId
    // uuid, seq) — deterministic, but NOT source-first: when the destination
    // warehouse's uuid sorts below the source's, its inbound chain reads
    // before the source's outbound chain. Each row carries
    // `referenceDoc {kind:'transfer', transferId}` — the epic AC's
    // "the ledger answers which movements served this transfer" read.
    const legRows = await transferLegEventsInTx(tx, tenantId, transferId);
    return {
      transfer: {
        id: order.id,
        status: order.status,
        sourceWarehouseId: order.sourceWarehouseId,
        destWarehouseId: order.destWarehouseId,
        note: order.note,
        createdBy: order.createdBy,
        outboundConfirmedBy: order.outboundConfirmedBy,
        outboundConfirmedAt: order.outboundConfirmedAt,
        inboundConfirmedBy: order.inboundConfirmedBy,
        inboundConfirmedAt: order.inboundConfirmedAt,
        cancelledBy: order.cancelledBy,
        cancelledAt: order.cancelledAt,
        createdAt: order.createdAt,
      },
      lines: lineRows.map((line) => ({
        id: line.id,
        skuId: line.skuId,
        skuCode: line.skuCode,
        quantity: fromMilli(line.quantity),
        fromBinId: line.fromBinId,
        fromBinCode: binCodeById.get(line.fromBinId) ?? '',
        toBinId: line.toBinId,
        toBinCode: binCodeById.get(line.toBinId) ?? '',
        batchRef: line.batchRef,
        note: line.note,
      })),
      events: legRows.map((row) => ({
        warehouseId: row.warehouseId,
        seq: row.seq,
        type: row.type,
        skuId: row.skuId,
        quantity: fromMilli(Math.abs(row.quantityDelta)),
        fromBinId: row.fromBinId,
        toBinId: row.toBinId,
        batchRef: row.batchRef,
        serialRef: row.serialRef,
        occurredAt: row.occurredAt,
      })),
    };
  }

  /** The transfer list (keyset cursor pagination — UX-DR25 bans offsets). */
  async listTransfers(
    tenantId: string,
    query: ListTransfersQuery = {},
  ): Promise<{ items: readonly TransferListEntry[]; nextCursor: string | null }> {
    const pageSize = query.limit ?? DEFAULT_TRANSFER_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      for (const warehouseId of [query.sourceWarehouseId, query.destWarehouseId]) {
        if (warehouseId !== undefined) {
          await assertWarehouseInTenant(tx, tenantId, warehouseId);
        }
      }
      const sourceWarehouse = alias(warehouses, 'src');
      const destWarehouse = alias(warehouses, 'dst');
      const rows = await tx
        .select({
          id: transferOrders.id,
          status: transferOrders.status,
          sourceWarehouseId: transferOrders.sourceWarehouseId,
          destWarehouseId: transferOrders.destWarehouseId,
          note: transferOrders.note,
          createdAt: transferOrders.createdAt,
          sourceWarehouseCode: sourceWarehouse.code,
          destWarehouseCode: destWarehouse.code,
        })
        .from(transferOrders)
        .innerJoin(sourceWarehouse, eq(sourceWarehouse.id, transferOrders.sourceWarehouseId))
        .innerJoin(destWarehouse, eq(destWarehouse.id, transferOrders.destWarehouseId))
        .where(
          and(
            eq(transferOrders.tenantId, tenantId),
            query.status === undefined ? undefined : eq(transferOrders.status, query.status),
            query.sourceWarehouseId === undefined
              ? undefined
              : eq(transferOrders.sourceWarehouseId, query.sourceWarehouseId),
            query.destWarehouseId === undefined
              ? undefined
              : eq(transferOrders.destWarehouseId, query.destWarehouseId),
            // Story 1-5a (decision 4): any line of the client's SKUs.
            query.clientId === undefined
              ? undefined
              : sql`exists (
                  select 1 from transfer_order_lines tol
                  where tol.tenant_id = ${transferOrders.tenantId}
                    and tol.transfer_id = ${transferOrders.id}
                    and ${skuOfClient(sql`tol.sku_id`, tenantId, query.clientId)}
                )`,
            before === undefined
              ? undefined
              : sql`(${transferOrders.createdAt}, ${transferOrders.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(transferOrders.createdAt), desc(transferOrders.id))
        .limit(pageSize + 1);
      // The page's per-transfer aggregates (the GRN list's second-query
      // shape): line counts + unit sums, keyed by transfer id. int8 sums
      // cross the boundary as strings — Number(...) at the edge.
      const pageIds = rows.slice(0, pageSize).map((row) => row.id);
      const aggregates =
        pageIds.length === 0
          ? new Map<string, { lineCount: number; totalUnits: number }>()
          : new Map(
              (
                await tx
                  .select({
                    transferId: transferOrderLines.transferId,
                    lineCount: sql<number>`count(*)::int`,
                    totalUnits: sql<string>`coalesce(sum(${transferOrderLines.quantity}), 0)::bigint`,
                  })
                  .from(transferOrderLines)
                  .where(inArray(transferOrderLines.transferId, pageIds))
                  .groupBy(transferOrderLines.transferId)
              ).map((row) => [
                row.transferId,
                { lineCount: row.lineCount, totalUnits: Number(row.totalUnits) },
              ]),
            );
      const items = rows.map((row) => ({
        id: row.id,
        status: row.status,
        sourceWarehouseId: row.sourceWarehouseId,
        sourceWarehouseCode: row.sourceWarehouseCode,
        destWarehouseId: row.destWarehouseId,
        destWarehouseCode: row.destWarehouseCode,
        lineCount: aggregates.get(row.id)?.lineCount ?? 0,
        totalUnits: fromMilli(aggregates.get(row.id)?.totalUnits ?? 0),
        note: row.note,
        // The cursor's payload — a canonical instant so the same string
        // round-trips through CURSOR_INSTANT_RE (the receiving list's rule).
        createdAt: canonicalInstant(row.createdAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * The device snapshot's Transfer inbox tasks (FR-29): one task per
   * IN-TRANSIT transfer whose DEST warehouse is this one — the operator
   * confirms the inbound leg. Derived on every read (no task table — the
   * putaway precedent): the order row is the only state.
   */
  async getTransferTasks(tenantId: string, warehouseId: string): Promise<readonly TransferTask[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getTransferTasksInTx(tx, tenantId, warehouseId),
    );
  }

  /**
   * The same derivation inside the CALLER's transaction (the
   * `getPutawayTasksInTx` / `getPickTasksInTx` shape): the device catalog
   * snapshot composes this beside its other reads in ONE tenant transaction
   * — never a nested transaction inside the snapshot's own.
   */
  async getTransferTasksInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
  ): Promise<readonly TransferTask[]> {
    await assertWarehouseInTenant(tx, tenantId, warehouseId);

    // In-transit transfers TO this warehouse, oldest confirm first. One row
    // over the ceiling: reading it is how we learn the result was truncated.
    const sourceWarehouse = alias(warehouses, 'src');
    const orderRows = await tx
      .select({
        id: transferOrders.id,
        sourceWarehouseId: transferOrders.sourceWarehouseId,
        note: transferOrders.note,
        outboundConfirmedAt: transferOrders.outboundConfirmedAt,
        sourceWarehouseCode: sourceWarehouse.code,
        sourceWarehouseName: sourceWarehouse.name,
      })
      .from(transferOrders)
      .innerJoin(sourceWarehouse, eq(sourceWarehouse.id, transferOrders.sourceWarehouseId))
      .where(
        and(
          eq(transferOrders.tenantId, tenantId),
          eq(transferOrders.destWarehouseId, warehouseId),
          eq(transferOrders.status, 'in_transit'),
        ),
      )
      .orderBy(asc(transferOrders.outboundConfirmedAt), asc(transferOrders.id))
      .limit(MAX_SNAPSHOT_TRANSFER_TASKS + 1);
    const orders = orderRows.slice(0, MAX_SNAPSHOT_TRANSFER_TASKS);
    if (orders.length === 0) {
      return [];
    }

    const transferIds = orders.map((order) => order.id);
    const lineRows = await tx
      .select({
        transferId: transferOrderLines.transferId,
        lineId: transferOrderLines.id,
        skuId: transferOrderLines.skuId,
        skuCode: skus.code,
        skuName: skus.name,
        quantity: transferOrderLines.quantity,
        batchRef: transferOrderLines.batchRef,
        destBinId: transferOrderLines.toBinId,
      })
      .from(transferOrderLines)
      .innerJoin(skus, eq(skus.id, transferOrderLines.skuId))
      .where(
        and(
          eq(transferOrderLines.tenantId, tenantId),
          inArray(transferOrderLines.transferId, transferIds),
        ),
      )
      .orderBy(asc(transferOrderLines.transferId), asc(transferOrderLines.id));

    // The planned landing bins' identities (code) and epochs — the epoch
    // read on THIS transaction so a task and the epoch the device will quote
    // back come from one consistent read (the pick command's precedent).
    const destBinIds = [...new Set(lineRows.map((line) => line.destBinId))];
    const binRows =
      destBinIds.length === 0
        ? []
        : await tx
            .select({ id: bins.id, code: bins.code })
            .from(bins)
            .where(and(eq(bins.tenantId, tenantId), inArray(bins.id, destBinIds)));
    const binCodeById = new Map(binRows.map((row) => [row.id, row.code]));
    const epochs =
      destBinIds.length === 0
        ? new Map<string, number>()
        : await this.inventory.binStateEpochsInTx(tx, tenantId, warehouseId, destBinIds);

    const linesByTransfer = new Map<string, TransferTaskLine[]>();
    for (const line of lineRows) {
      const list = linesByTransfer.get(line.transferId) ?? [];
      list.push({
        lineId: line.lineId,
        skuId: line.skuId,
        skuCode: line.skuCode,
        skuName: line.skuName,
        qty: fromMilli(line.quantity),
        batchRef: line.batchRef,
        destBinId: line.destBinId,
        // A planned landing bin always names its code: the shape CHECK pairs
        // to_bin_id with a real bin (validated at create), so an absent code
        // is a corrupt row, not a task (the pick card's requireBinCode
        // stance).
        destBinCode: binCodeById.get(line.destBinId) ?? '',
        binStateEpoch: epochs.get(line.destBinId) ?? null,
      });
      linesByTransfer.set(line.transferId, list);
    }

    return orders.map((order) => ({
      transferId: order.id,
      sourceWarehouseId: order.sourceWarehouseId,
      sourceWarehouseCode: order.sourceWarehouseCode,
      sourceWarehouseName: order.sourceWarehouseName,
      destWarehouseId: warehouseId,
      note: order.note,
      outboundConfirmedAt: order.outboundConfirmedAt ?? '',
      lines: linesByTransfer.get(order.id) ?? [],
    }));
  }

  /**
   * The device snapshot's Count inbox tasks (Story 5-3): one card per
   * STORED `pending` count task for this warehouse — the movements module's
   * first stored task feed (unlike the putaway/pick/transfer feeds, the
   * per-SKU expectations were frozen at task start and are READ here, never
   * recomputed). Oldest task first; the MAX+1 truncation shape (the
   * transfer feed's precedent).
   */
  async getCountTasks(tenantId: string, warehouseId: string): Promise<readonly CountTaskCard[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getCountTasksInTx(tx, tenantId, warehouseId),
    );
  }

  /**
   * The same read inside the CALLER'S transaction (the
   * `getTransferTasksInTx` shape): the device catalog snapshot composes this
   * beside its other reads in ONE tenant transaction.
   */
  /**
   * GET …/movements/variances — the variance RESOLUTION queue (story 5-4;
   * 5-5 owns the queue surface): the resolution cards' rows — delta,
   * threshold context, who/when resolved. Newest first, keyset cursor
   * pagination (offset pagination is banned — UX-DR25), status- and
   * warehouse-filterable. A read — never capability-gated (the resolving
   * mutation is); the route's tenant RLS keeps every row the tenant's own
   * (the status/warehouse filters narrow only within it).
   */
  async listCountVariances(
    tenantId: string,
    query: ListCountVariancesQuery = {},
  ): Promise<Page<CountVarianceEntry>> {
    const pageSize = query.limit ?? DEFAULT_VARIANCE_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          row: countVariances,
          // The CURSOR needs the raw `::text` instant — the driver's parse
          // (and `canonicalInstant`) truncates to milliseconds, and a
          // truncated cursor's strict `<` would skip the tail of a tie
          // group (rows sharing one transactional `now()`). See
          // `fullPrecisionInstant`.
          createdAtText: sql<string>`${countVariances.createdAt}::text`,
        })
        .from(countVariances)
        .where(
          and(
            eq(countVariances.tenantId, tenantId),
            query.status === undefined ? undefined : eq(countVariances.status, query.status),
            query.warehouseId === undefined
              ? undefined
              : eq(countVariances.warehouseId, query.warehouseId),
            // Story 1-5a: through the variance's SKU.
            query.clientId === undefined ? undefined : skuOfClient(countVariances.skuId, tenantId, query.clientId),
            before === undefined
              ? undefined
              : sql`(${countVariances.createdAt}, ${countVariances.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(countVariances.createdAt), desc(countVariances.id))
        .limit(pageSize + 1);
      // buildPage encodes the cursor from the FULL-precision instants; the
      // surfaced entries keep the canonical (ms) body shape.
      const page = buildPage(
        rows.map((wrapped) => ({
          createdAt: fullPrecisionInstant(wrapped.createdAtText),
          id: wrapped.row.id,
          entry: varianceEntry(wrapped.row),
        })),
        pageSize,
      );
      return {
        items: page.items.map((wrapped) => wrapped.entry),
        nextCursor: page.nextCursor,
      };
    });
  }

  async getCountTasksInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
  ): Promise<readonly CountTaskCard[]> {
    await assertWarehouseInTenant(tx, tenantId, warehouseId);

    // Pending tasks for this warehouse, oldest first. One row over the
    // ceiling: reading it is how we learn the result was truncated.
    const taskRows = await tx
      .select({
        id: countTasks.id,
        binId: countTasks.binId,
        origin: countTasks.origin,
        binStateEpoch: countTasks.binStateEpoch,
        createdAt: countTasks.createdAt,
      })
      .from(countTasks)
      .where(
        and(
          eq(countTasks.tenantId, tenantId),
          eq(countTasks.warehouseId, warehouseId),
          eq(countTasks.status, 'pending'),
        ),
      )
      .orderBy(asc(countTasks.createdAt), asc(countTasks.id))
      .limit(MAX_SNAPSHOT_COUNT_TASKS + 1);
    const tasks = taskRows.slice(0, MAX_SNAPSHOT_COUNT_TASKS);
    // Story 5-3 (review): the over-read row IS the truncation signal —
    // computed-then-dropped is exactly the shape the spec's Code Map says
    // not to repeat (5-1's PENDING note). The returned rows stay MAX-capped
    // (the device contract); the warning surfaces that this warehouse's
    // older pending counts are silently invisible so the breach is
    // actionable (refresh the seal after counting some) instead of silent.
    if (taskRows.length > tasks.length) {
      this.logger.warn(
        `Catalog snapshot count tasks truncated — tenant=${tenantId} warehouse=${warehouseId} ` +
          `holds more than ${MAX_SNAPSHOT_COUNT_TASKS} pending count task(s); older tasks are not shown`,
      );
    }
    if (tasks.length === 0) {
      return [];
    }

    const taskIds = tasks.map((task) => task.id);
    const lineRows = await tx
      .select({
        taskId: countTaskLines.taskId,
        skuId: countTaskLines.skuId,
        skuCode: skus.code,
        skuName: skus.name,
      })
      .from(countTaskLines)
      .innerJoin(skus, eq(skus.id, countTaskLines.skuId))
      .where(
        and(eq(countTaskLines.tenantId, tenantId), inArray(countTaskLines.taskId, taskIds)),
      )
      .orderBy(asc(countTaskLines.taskId), asc(countTaskLines.skuId));
    const linesByTask = new Map<string, CountTaskLine[]>();
    for (const line of lineRows) {
      const list = linesByTask.get(line.taskId) ?? [];
      // Story 3-5a — blind: the SKU and nothing else (an exact key set).
      list.push({
        skuId: line.skuId,
        skuCode: line.skuCode,
        skuName: line.skuName,
      });
      linesByTask.set(line.taskId, list);
    }

    // The tasks' bin codes (a bare identity read; the task ids already
    // scope them tenant-side).
    const binIds = tasks.map((task) => task.binId);
    const binRows = await tx
      .select({ id: bins.id, code: bins.code })
      .from(bins)
      .where(and(eq(bins.tenantId, tenantId), inArray(bins.id, binIds)));
    const binCodeById = new Map(binRows.map((row) => [row.id, row.code]));

    return tasks.map((task) => ({
      taskId: task.id,
      warehouseId,
      binId: task.binId,
      // A task's bin always names its code (the bin row exists — validated
      // at task creation and locked at submit), so an absent code is a
      // corrupt row, not a task (the pick card's requireBinCode stance).
      binCode: binCodeById.get(task.binId) ?? '',
      origin: task.origin,
      // The FROZEN epoch from the task row, not a live re-read —
      // informational on the device: the submit reads the epoch from the
      // task row itself (story 3-5a fixed the stale "quoted back" wording).
      binStateEpoch: task.binStateEpoch,
      createdAt: canonicalInstant(task.createdAt),
      lines: linesByTask.get(task.id) ?? [],
    }));
  }
}

export type { TransferOrderSnapshot, TransferConfirmSnapshot, TransferLegEventSnapshot };
export type {
  CreateCountSnapshot,
  CreateCountsBulkSnapshot,
  SubmitCountSnapshot,
  CountPoliciesSnapshot,
  CountVarianceSnapshot,
  CountVarianceEntry,
  ResolveCountVarianceCommand,
  ResolveCountVarianceSnapshot,
  SetVariancePolicyCommand,
  VariancePolicySnapshot,
} from './count.command';
export type { TransferOrder, TransferOrderLine };
