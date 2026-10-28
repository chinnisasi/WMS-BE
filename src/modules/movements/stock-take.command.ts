import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  bins,
  countTaskLines,
  countTasks,
  countVariances,
  idempotencyKeys,
  skus,
  stockTakes,
  zones,
  type StockTake,
  type StockTakeStatus,
} from '../../shared/db/schema';
import { fromMilli } from '../../shared/primitives/quantity';
import type { SignedQuantity } from '../../shared/primitives/quantity';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { AdjustStockCommand } from '../inventory/inventory.facade';
import { createRecountTaskInTx, supersedeVariancesInTx } from './count-tasks';

/**
 * Story 3-5b — the STOCK TAKE: every storage bin of a warehouse (or of the
 * named zones) frozen, counted blind on the handheld, and closed by one post
 * that applies the variances under the 5-4 approval rule and lifts the freeze.
 *
 * The freeze itself is inventory's (`stock_freeze_bins`, probed inside the
 * ledger append — the ONE place a frozen-bin refusal lives); this command
 * only writes it through the inventory facade. Counting reuses the 5-3/5-4
 * machinery: count tasks (stamped `stock_take_id`), the frozen epoch, the
 * variance rows and the approve-adjust internals.
 *
 * Lock orders (the canonical chain, bin row → serial → warehouse advisory;
 * design review A3):
 * - start: the pending in-scope task rows and open in-scope variance rows
 *   `FOR UPDATE` (sorted by id) → warehouse advisory → replay again. A
 *   pending task the locked set lacks is 409 `conflict` (retry) — start never
 *   waits on a task row while holding the advisory.
 * - recount: take → the take's open variance rows of the named bins → bin
 *   rows → advisory → replay → re-checks.
 * - close (approve): take → replay → advisory; each batch: take → variance
 *   rows → their SKUs → their bin rows → advisory (A2, K1).
 * - abandon: take → the take's pending task rows → advisory → replay.
 */

/** At most this many bins frozen per warehouse across its active takes (A8). */
export const MAX_FROZEN_BINS_PER_WAREHOUSE = 3000;
/** The close posts its variances in transactions of at most this many (A2). */
export const STOCK_TAKE_POST_BATCH = 200;
/** A requested recount names 1–500 bins. */
export const MAX_RECOUNT_BINS = 500;
/** A zone take names 1–50 zones. */
export const MAX_STOCK_TAKE_ZONES = 50;
/** The note's ceiling (code points). */
export const MAX_STOCK_TAKE_NOTE = 200;
/** How many bin codes a recount-required refusal lists before the total. */
const LISTED_BINS = 20;

export interface StartStockTakeCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  /** null/absent = the whole warehouse. */
  readonly zoneIds?: readonly string[] | null | undefined;
  readonly note?: string | null | undefined;
}

export interface RecountStockTakeBinsCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly stockTakeId: string;
  readonly binIds: readonly string[];
}

export interface CloseStockTakeCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly stockTakeId: string;
  /** sha256 over the take's open variances `(varianceId, deltaMilli)`, sorted — served by the detail read. */
  readonly openVarianceDigest: string;
}

export interface AbandonStockTakeCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly stockTakeId: string;
  readonly note?: string | null | undefined;
}

/** A take as every command answer and read carries it. */
export interface StockTakeSummary {
  readonly id: string;
  readonly warehouseId: string;
  /** Sorted; null = the whole warehouse. */
  readonly zoneIds: readonly string[] | null;
  readonly status: StockTakeStatus;
  readonly note: string | null;
  readonly binCount: number;
  readonly startedBy: string;
  readonly startedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly closedBy: string | null;
  readonly closedAt: string | null;
  readonly abandonedBy: string | null;
  readonly abandonedAt: string | null;
  readonly abandonNote: string | null;
  /** Handheld writes admitted after the freeze, on bins already released (the live rows add the rest). */
  readonly deviceWrites: number;
  readonly postedCount: number | null;
  readonly unpostedCount: number | null;
}

export interface StartStockTakeSnapshot {
  readonly stockTake: StockTakeSummary;
  /** Pending cycle tasks already on an in-scope bin, now the take's. */
  readonly adoptedTaskCount: number;
  readonly createdTaskCount: number;
  /** Older open variances on in-scope bins marked `recounted` against the take's task (A6). */
  readonly supersededVarianceCount: number;
}

export interface RecountStockTakeSnapshot {
  readonly stockTake: StockTakeSummary;
  readonly recounts: readonly { readonly binId: string; readonly binCode: string; readonly taskId: string }[];
  readonly recountedVarianceCount: number;
}

/** One variance the close could not post (it stays open on the variance queue). */
export interface UnpostedVariance {
  readonly varianceId: string;
  readonly binId: string;
  readonly binCode: string;
  readonly skuId: string;
  readonly skuCode: string;
  /** The adjustment guard's machine code, or `basis-moved`. */
  readonly code: string;
  readonly detail: string;
  /**
   * A7 — the SKU is batch-, serial- or catch-weight-tracked: its variance
   * needs a batch- or serial-level count (3-5d), which this take cannot post.
   */
  readonly needsLotCount: boolean;
}

export interface CloseStockTakeSnapshot {
  readonly stockTake: StockTakeSummary;
  readonly postedCount: number;
  readonly unposted: readonly UnpostedVariance[];
}

export interface AbandonStockTakeSnapshot {
  readonly stockTake: StockTakeSummary;
  readonly cancelledTaskCount: number;
  /** Pending tasks a variance names as its recount — released to the cycle queue, not cancelled. */
  readonly releasedTaskCount: number;
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

// ── refusals ─────────────────────────────────────────────────────────────

function validation(title: string, detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, title, detail);
}

function stockTakeNotFound(): ProblemException {
  return new ProblemException('not-found', 404, 'Stock take not found', 'No stock take with this id exists in this tenant.');
}

export function stockTakeNotCounting(status: string): ProblemException {
  return new ProblemException(
    'stock-take-not-counting',
    409,
    'The stock take is not counting',
    `The stock take is ${status} — only a counting take can be recounted, closed or abandoned.`,
    { stockTakeStatus: status },
  );
}

function stockTakeEmpty(): ProblemException {
  return new ProblemException(
    'stock-take-empty',
    422,
    'Nothing to count',
    'The scope holds no storage bins (system and retired bins are never counted) — pick another warehouse or other zones.',
  );
}

function tooManyBins(requested: number, alreadyFrozen: number): ProblemException {
  return new ProblemException(
    'too-many-bins',
    422,
    'Too many bins for one warehouse',
    alreadyFrozen === 0
      ? `The scope holds ${requested} storage bins — at most ${MAX_FROZEN_BINS_PER_WAREHOUSE} bins can be frozen in one warehouse; take it a few zones at a time.`
      : `The scope holds ${requested} storage bins and ${alreadyFrozen} are already frozen by other stock takes — at most ${MAX_FROZEN_BINS_PER_WAREHOUSE} bins can be frozen in one warehouse at once; close a take first or pick fewer zones.`,
    { requested, alreadyFrozen, limit: MAX_FROZEN_BINS_PER_WAREHOUSE },
  );
}

function stockTakeOverlap(activeTakeId: string, binCodes: readonly string[]): ProblemException {
  return new ProblemException(
    'stock-take-overlap',
    409,
    'The scope overlaps an active stock take',
    `Stock take ${activeTakeId} already freezes ${binCodes.length === 1 ? 'bin' : 'bins'} ${binCodes.slice(0, LISTED_BINS).join(', ')}${binCodes.length > LISTED_BINS ? ` and ${binCodes.length - LISTED_BINS} more` : ''} — takes in one warehouse must not share bins.`,
    { activeStockTakeId: activeTakeId },
  );
}

function concurrentConflict(detail: string): ProblemException {
  return new ProblemException('conflict', 409, 'A concurrent change touched the stock take', detail);
}

function stockTakeIncomplete(pending: number): ProblemException {
  return new ProblemException(
    'stock-take-incomplete',
    409,
    'The stock take still has bins to count',
    `${pending} count ${pending === 1 ? 'task is' : 'tasks are'} still pending — count every bin (recounts included) before posting.`,
    { pendingTasks: pending },
  );
}

function stockTakeRecountRequired(binCodes: readonly string[]): ProblemException {
  const listed = binCodes.slice(0, LISTED_BINS);
  return new ProblemException(
    'stock-take-recount-required',
    409,
    'Some bins moved after they were counted',
    `${binCodes.length} ${binCodes.length === 1 ? 'bin has' : 'bins have'} moved since ${binCodes.length === 1 ? 'its' : 'their'} last count (a quarantine or a handheld op synced late): ${listed.join(', ')}${binCodes.length > listed.length ? ` and ${binCodes.length - listed.length} more` : ''} — recount ${binCodes.length === 1 ? 'it' : 'them'}, then post.`,
    { binCodes: listed, total: binCodes.length },
  );
}

function stockTakeChanged(): ProblemException {
  return new ProblemException(
    'stock-take-changed',
    409,
    'The variances changed since you reviewed them',
    'The open variances of this stock take are not the ones you reviewed (a recount or a count landed since) — refresh and review them again before posting.',
  );
}

function varianceOwnerRequired(varianceIds: readonly string[]): ProblemException {
  return new ProblemException(
    'variance-owner-required',
    403,
    'Over-threshold variances post by owner only',
    `${varianceIds.length} open ${varianceIds.length === 1 ? 'variance exceeds' : 'variances exceed'} the threshold frozen when ${varianceIds.length === 1 ? 'it was' : 'they were'} counted (${varianceIds.slice(0, LISTED_BINS).join(', ')}${varianceIds.length > LISTED_BINS ? ` and ${varianceIds.length - LISTED_BINS} more` : ''}) — the owner posts this stock take.`,
    { varianceIds: varianceIds.slice(0, LISTED_BINS), total: varianceIds.length },
  );
}

/**
 * The close's approval token (A2): sha256 over the sorted `(varianceId,
 * deltaMilli)` pairs of the take's open variances. The detail read serves it;
 * the close re-derives it under the lock and refuses a mismatch.
 */
export function openVarianceDigestOf(rows: readonly { id: string; deltaMilli: number }[]): string {
  const pairs = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((row) => [row.id, row.deltaMilli]);
  return createHash('sha256').update(JSON.stringify(pairs), 'utf8').digest('hex');
}

/** The read-model shape of a take row. */
export function stockTakeSummary(row: StockTake): StockTakeSummary {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    zoneIds: row.zoneIds ?? null,
    status: row.status as StockTakeStatus,
    note: row.note,
    binCount: row.binCount,
    startedBy: row.startedBy,
    startedAt: canonicalInstant(row.startedAt),
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt === null ? null : canonicalInstant(row.approvedAt),
    closedBy: row.closedBy,
    closedAt: row.closedAt === null ? null : canonicalInstant(row.closedAt),
    abandonedBy: row.abandonedBy,
    abandonedAt: row.abandonedAt === null ? null : canonicalInstant(row.abandonedAt),
    abandonNote: row.abandonNote,
    deviceWrites: Number(row.deviceWrites),
    postedCount: row.postedCount,
    unpostedCount: row.unpostedCount,
  };
}

/** A note trimmed; blank is absent. */
function normaliseNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  if ([...trimmed].length > MAX_STOCK_TAKE_NOTE) {
    throw validation('Note too long', `note must be at most ${MAX_STOCK_TAKE_NOTE} characters.`);
  }
  return trimmed;
}

function assertUuids(ids: readonly string[], field: string): void {
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw validation(`${field} must be uuids`, `${field} must hold uuids (got "${String(id)}").`);
    }
  }
}

/** The (binId → latest completed task of the take) map, and every take bin. */
interface TakeBinState {
  readonly binId: string;
  readonly binCode: string;
  readonly latestTaskId: string | null;
  readonly latestEpoch: number | null;
}

@Injectable()
export class StockTakeCommand {
  private readonly logger = new Logger('StockTakeCommand');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  // ── fingerprints (A11 — each carries its `arm`; golden-pinned) ─────────

  startFingerprint(command: StartStockTakeCommand): string {
    const zoneIds = command.zoneIds === undefined || command.zoneIds === null ? null : [...command.zoneIds].sort();
    return hashCommandPayload({
      tenantId: command.tenantId,
      arm: 'stock-take.start',
      warehouseId: command.warehouseId,
      zoneIds,
      note: normaliseNote(command.note),
    });
  }

  recountFingerprint(command: RecountStockTakeBinsCommand): string {
    return hashCommandPayload({
      tenantId: command.tenantId,
      arm: 'stock-take.recount',
      stockTakeId: command.stockTakeId,
      binIds: [...command.binIds].sort(),
    });
  }

  closeFingerprint(command: CloseStockTakeCommand): string {
    return hashCommandPayload({
      tenantId: command.tenantId,
      arm: 'stock-take.close',
      stockTakeId: command.stockTakeId,
      openVarianceDigest: command.openVarianceDigest,
    });
  }

  abandonFingerprint(command: AbandonStockTakeCommand): string {
    return hashCommandPayload({
      tenantId: command.tenantId,
      arm: 'stock-take.abandon',
      stockTakeId: command.stockTakeId,
      note: normaliseNote(command.note),
    });
  }

  // ── start (counts.manage) ──────────────────────────────────────────────

  async startStockTake(command: StartStockTakeCommand, idempotencyKey: string): Promise<{ snapshot: StartStockTakeSnapshot; replayed: boolean }> {
    // Shape checks above the transaction.
    const zoneIds = command.zoneIds === undefined || command.zoneIds === null ? null : [...command.zoneIds];
    if (zoneIds !== null) {
      if (zoneIds.length === 0) throw validation('No zones named', 'zoneIds must name 1–50 zones, or be absent for the whole warehouse.');
      if (zoneIds.length > MAX_STOCK_TAKE_ZONES) {
        throw validation('Too many zones', `zoneIds names ${zoneIds.length} zones — at most ${MAX_STOCK_TAKE_ZONES}.`);
      }
      assertUuids(zoneIds, 'zoneIds');
      if (new Set(zoneIds).size !== zoneIds.length) throw validation('A zone is named twice', 'zoneIds must not repeat a zone.');
      zoneIds.sort();
    }
    const note = normaliseNote(command.note);
    const payloadHash = this.startFingerprint(command);

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'counts.manage');
      const replay = this.replayer<StartStockTakeSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      const first = await replay();
      if (first !== null) return { snapshot: first, replayed: true };

      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      if (zoneIds !== null) {
        const found = await tx
          .select({ id: zones.id })
          .from(zones)
          .where(and(eq(zones.tenantId, command.tenantId), eq(zones.warehouseId, command.warehouseId), inArray(zones.id, zoneIds)));
        if (found.length !== zoneIds.length) {
          const known = new Set(found.map((row) => row.id));
          throw new ProblemException(
            'not-found',
            404,
            'Zone not found',
            `No zone with id ${zoneIds.filter((id) => !known.has(id)).map((id) => `"${id}"`).join(', ')} exists in this warehouse.`,
          );
        }
      }

      // The in-scope bins (storage, not retired — blocked bins included).
      const scopeBins = async (): Promise<{ id: string; code: string; zoneId: string }[]> =>
        tx
          .select({ id: bins.id, code: bins.code, zoneId: bins.zoneId })
          .from(bins)
          .where(
            and(
              eq(bins.tenantId, command.tenantId),
              eq(bins.warehouseId, command.warehouseId),
              eq(bins.systemOwned, false),
              isNull(bins.retiredAt),
              zoneIds === null ? undefined : inArray(bins.zoneId, zoneIds),
            ),
          )
          .orderBy(asc(bins.id));
      const scopePending = async (binIds: readonly string[]): Promise<{ id: string; binId: string; stockTakeId: string | null }[]> =>
        binIds.length === 0
          ? []
          : tx
              .select({ id: countTasks.id, binId: countTasks.binId, stockTakeId: countTasks.stockTakeId })
              .from(countTasks)
              .where(
                and(
                  eq(countTasks.tenantId, command.tenantId),
                  eq(countTasks.warehouseId, command.warehouseId),
                  inArray(countTasks.binId, [...binIds]),
                  eq(countTasks.status, 'pending'),
                ),
              )
              .orderBy(asc(countTasks.id));

      const preBins = await scopeBins();
      if (preBins.length === 0) throw stockTakeEmpty();
      if (preBins.length > MAX_FROZEN_BINS_PER_WAREHOUSE) throw tooManyBins(preBins.length, 0);
      const preIds = preBins.map((bin) => bin.id);

      // Locks, before the advisory: the pending in-scope tasks, then the open
      // in-scope variances (a single resolve locks a variance before it waits
      // on the advisory — taking these under the advisory would deadlock).
      const lockedTasks =
        preIds.length === 0
          ? []
          : await tx
              .select({ id: countTasks.id })
              .from(countTasks)
              .where(
                and(
                  eq(countTasks.tenantId, command.tenantId),
                  eq(countTasks.warehouseId, command.warehouseId),
                  inArray(countTasks.binId, preIds),
                  eq(countTasks.status, 'pending'),
                ),
              )
              .orderBy(asc(countTasks.id))
              .for('update');
      const lockedTaskIds = new Set(lockedTasks.map((row) => row.id));
      const lockedVariances = await tx
        .select({ id: countVariances.id })
        .from(countVariances)
        .where(
          and(
            eq(countVariances.tenantId, command.tenantId),
            eq(countVariances.warehouseId, command.warehouseId),
            inArray(countVariances.binId, preIds),
            eq(countVariances.status, 'open'),
          ),
        )
        .orderBy(asc(countVariances.id))
        .for('update');

      await this.inventory.lockWarehouseInTx(tx, command.tenantId, command.warehouseId);
      const underLock = await replay();
      if (underLock !== null) return { snapshot: underLock, replayed: true };

      // Re-derive under the advisory (a bin created, retired or rezoned
      // meanwhile; a task minted meanwhile).
      const scope = await scopeBins();
      if (scope.length === 0) throw stockTakeEmpty();
      if (scope.length > MAX_FROZEN_BINS_PER_WAREHOUSE) throw tooManyBins(scope.length, 0);
      const scopeIds = scope.map((bin) => bin.id);
      const pending = await scopePending(scopeIds);
      const unlocked = pending.filter((task) => !lockedTaskIds.has(task.id));
      if (unlocked.length > 0) {
        throw concurrentConflict('A count task was created on one of these bins while the stock take was starting — retry.');
      }

      // Overlap, then the per-warehouse cap (A8).
      const frozen = await this.inventory.frozenBinsInTx(tx, command.tenantId, command.warehouseId);
      const overlapping = scope.filter((bin) => frozen.has(bin.id));
      if (overlapping.length > 0) {
        throw stockTakeOverlap(
          frozen.get(overlapping[0]!.id)!.stockTakeId,
          overlapping.map((bin) => bin.code).sort(),
        );
      }
      if (frozen.size + scope.length > MAX_FROZEN_BINS_PER_WAREHOUSE) throw tooManyBins(scope.length, frozen.size);

      // ── writes ────────────────────────────────────────────────────────
      const takeId = uuidv7();
      const startedAt = nowIso();
      await tx.insert(stockTakes).values({
        id: takeId,
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        zoneIds,
        status: 'counting',
        note,
        binCount: scope.length,
        startedBy: command.actorUserId,
        startedAt,
      });

      // Adopt the pending tasks already on in-scope bins (their frozen
      // expectation is still checked by their epoch at submit).
      const adoptIds = pending.map((task) => task.id);
      if (adoptIds.length > 0) {
        await tx
          .update(countTasks)
          .set({ stockTakeId: takeId, updatedAt: startedAt })
          .where(and(eq(countTasks.tenantId, command.tenantId), inArray(countTasks.id, adoptIds), eq(countTasks.status, 'pending')));
      }
      const taskOfBin = new Map(pending.map((task) => [task.binId, task.id]));

      // One task for every other bin, empty bins included (no lines).
      const toCreate = scope.filter((bin) => !taskOfBin.has(bin.id));
      const createIds = toCreate.map((bin) => bin.id);
      const onHand = await this.inventory.stockArmsInBinsInTx(tx, command.tenantId, command.warehouseId, createIds);
      const epochs = createIds.length === 0 ? new Map<string, number>() : await this.inventory.binStateEpochsInTx(tx, command.tenantId, command.warehouseId, createIds);
      const taskValues: (typeof countTasks.$inferInsert)[] = [];
      const lineValues: (typeof countTaskLines.$inferInsert)[] = [];
      for (const bin of toCreate) {
        const taskId = uuidv7();
        taskOfBin.set(bin.id, taskId);
        taskValues.push({
          id: taskId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          binId: bin.id,
          status: 'pending',
          origin: 'on_demand',
          binStateEpoch: epochs.get(bin.id) ?? null,
          createdBy: command.actorUserId,
          stockTakeId: takeId,
        });
      }
      for (const arm of onHand) {
        if (arm.quantity === 0) continue;
        lineValues.push({
          id: uuidv7(),
          tenantId: command.tenantId,
          taskId: taskOfBin.get(arm.binId)!,
          skuId: arm.skuId,
          expectedQuantity: arm.quantity,
        });
      }
      await insertChunked(tx, countTasks, taskValues);
      await insertChunked(tx, countTaskLines, lineValues);

      // A6 — older open variances on in-scope bins are superseded by the
      // take's task for their bin (each emits the full resolved event).
      const varianceBins = lockedVariances.length === 0
        ? []
        : await tx
            .select({ id: countVariances.id, binId: countVariances.binId })
            .from(countVariances)
            .where(and(eq(countVariances.tenantId, command.tenantId), inArray(countVariances.id, lockedVariances.map((row) => row.id))));
      const superseded = await supersedeVariancesInTx(tx, this.outbox, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        idempotencyKey,
        at: startedAt,
        entries: varianceBins
          .filter((row) => taskOfBin.has(row.binId))
          .map((row) => ({ varianceId: row.id, recountTaskId: taskOfBin.get(row.binId)! })),
      });

      // The freeze, under the advisory the append probes under.
      await this.inventory.freezeBinsInTx(tx, {
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        stockTakeId: takeId,
        frozenAt: startedAt,
        bins: scope.map((bin) => ({ id: bin.id, code: bin.code })),
      });

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'stock_take.started',
        occurredAt: startedAt,
        payload: {
          stockTakeId: takeId,
          warehouseId: command.warehouseId,
          zoneIds,
          binCount: scope.length,
          adoptedTaskCount: adoptIds.length,
          createdTaskCount: taskValues.length,
        },
      });
      for (const task of taskValues) {
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'count.created',
          occurredAt: startedAt,
          payload: {
            taskId: task.id,
            binId: task.binId,
            warehouseId: command.warehouseId,
            origin: 'on_demand',
            stockTakeId: takeId,
            // Never pushed (3-5a's bulk precedent).
            bulk: true,
          },
        });
      }

      const row = await this.readTake(tx, command.tenantId, takeId);
      const snapshot: StartStockTakeSnapshot = {
        stockTake: stockTakeSummary(row),
        adoptedTaskCount: adoptIds.length,
        createdTaskCount: taskValues.length,
        supersededVarianceCount: superseded,
      };
      await this.audit(tx, command.tenantId, command.actorUserId, 'stock_take.started', takeId, idempotencyKey, startedAt);
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return { snapshot, replayed: false };
    });
  }

  // ── recount selected bins (variances.resolve) ──────────────────────────

  async recountStockTakeBins(
    command: RecountStockTakeBinsCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: RecountStockTakeSnapshot; replayed: boolean }> {
    const binIds = [...command.binIds];
    if (binIds.length === 0) throw validation('No bins named', 'binIds must name 1–500 bins of the stock take.');
    if (binIds.length > MAX_RECOUNT_BINS) throw validation('Too many bins', `binIds names ${binIds.length} bins — at most ${MAX_RECOUNT_BINS}.`);
    assertUuids(binIds, 'binIds');
    if (new Set(binIds).size !== binIds.length) throw validation('A bin is named twice', 'binIds must not repeat a bin.');
    binIds.sort();
    const payloadHash = this.recountFingerprint(command);

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'variances.resolve');
      const replay = this.replayer<RecountStockTakeSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      const first = await replay();
      if (first !== null) return { snapshot: first, replayed: true };

      const take = await this.lockTake(tx, command.tenantId, command.stockTakeId);
      const afterTake = await replay();
      if (afterTake !== null) return { snapshot: afterTake, replayed: true };
      if (take.status !== 'counting') throw stockTakeNotCounting(take.status);

      // ⊆ the take's bins (its task bins).
      const takeBins = await this.takeBinStatesInTx(tx, command.tenantId, take.id);
      const byBin = new Map(takeBins.map((state) => [state.binId, state]));
      const outside = binIds.filter((id) => !byBin.has(id));
      if (outside.length > 0) {
        throw validation('Bins outside the stock take', `These bins are not in the stock take: ${outside.join(', ')}.`);
      }

      // Locks (A3): the take's open variance rows of these bins → the bin
      // rows → the warehouse advisory → the replay again.
      const variances = await tx
        .select({ id: countVariances.id, binId: countVariances.binId })
        .from(countVariances)
        .innerJoin(countTasks, and(eq(countTasks.tenantId, countVariances.tenantId), eq(countTasks.id, countVariances.taskId)))
        .where(
          and(
            eq(countVariances.tenantId, command.tenantId),
            eq(countTasks.stockTakeId, take.id),
            inArray(countVariances.binId, binIds),
            eq(countVariances.status, 'open'),
          ),
        )
        .orderBy(asc(countVariances.id))
        .for('update', { of: countVariances });
      await tx
        .select({ id: bins.id })
        .from(bins)
        .where(and(eq(bins.tenantId, command.tenantId), inArray(bins.id, binIds)))
        .orderBy(asc(bins.id))
        .for('update');
      await this.inventory.lockWarehouseInTx(tx, command.tenantId, take.warehouseId);
      const underLock = await replay();
      if (underLock !== null) return { snapshot: underLock, replayed: true };

      // No pending task on any named bin (the open-task rule).
      const pendingRows = await tx
        .select({ binId: countTasks.binId })
        .from(countTasks)
        .where(and(eq(countTasks.tenantId, command.tenantId), eq(countTasks.warehouseId, take.warehouseId), inArray(countTasks.binId, binIds), eq(countTasks.status, 'pending')));
      if (pendingRows.length > 0) {
        const codes = [...new Set(pendingRows.map((row) => byBin.get(row.binId)!.binCode))].sort();
        throw new ProblemException(
          'count-task-open',
          409,
          'A count task is already open on these bins',
          `${codes.length === 1 ? 'Bin' : 'Bins'} ${codes.join(', ')} already ${codes.length === 1 ? 'has' : 'have'} a pending count task — count ${codes.length === 1 ? 'it' : 'them'} first.`,
        );
      }

      const at = nowIso();
      const recounts: { binId: string; binCode: string; taskId: string }[] = [];
      for (const binId of binIds) {
        const state = byBin.get(binId)!;
        const minted = await createRecountTaskInTx(tx, this.inventory, this.outbox, {
          tenantId: command.tenantId,
          warehouseId: take.warehouseId,
          binId,
          supersededTaskId: state.latestTaskId,
          occurredAt: at,
        });
        recounts.push({ binId, binCode: state.binCode, taskId: minted.taskId });
      }
      const taskByBin = new Map(recounts.map((entry) => [entry.binId, entry.taskId]));
      const recounted = await supersedeVariancesInTx(tx, this.outbox, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        idempotencyKey,
        at,
        entries: variances.map((row) => ({ varianceId: row.id, recountTaskId: taskByBin.get(row.binId)! })),
      });

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'stock_take.recount_requested',
        occurredAt: at,
        payload: { stockTakeId: take.id, warehouseId: take.warehouseId, binIds, recountedVarianceCount: recounted },
      });
      recounts.sort((a, b) => (a.binCode < b.binCode ? -1 : a.binCode > b.binCode ? 1 : 0));
      const snapshot: RecountStockTakeSnapshot = {
        stockTake: stockTakeSummary(take),
        recounts,
        recountedVarianceCount: recounted,
      };
      await this.audit(tx, command.tenantId, command.actorUserId, 'stock_take.recount_requested', take.id, idempotencyKey, at);
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return { snapshot, replayed: false };
    });
  }

  // ── close: approve once, post in batches, close (variances.resolve, A2) ──

  async closeStockTake(
    command: CloseStockTakeCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: CloseStockTakeSnapshot; replayed: boolean; metrics?: { batches: number; longestBatchMs: number } }> {
    if (typeof command.openVarianceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(command.openVarianceDigest)) {
      throw validation('Malformed openVarianceDigest', 'openVarianceDigest must be the 64-character hex digest the stock take detail serves.');
    }
    const payloadHash = this.closeFingerprint(command);

    // Transaction 1 — approve (or resume a posting take).
    const approved = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'variances.resolve');
      const replay = this.replayer<CloseStockTakeSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      const first = await replay();
      if (first !== null) return { replayed: first };
      const take = await this.lockTake(tx, command.tenantId, command.stockTakeId);
      const afterTake = await replay();
      if (afterTake !== null) return { replayed: afterTake };
      if (take.status === 'posting') return { replayed: null, take };
      if (take.status !== 'counting') throw stockTakeNotCounting(take.status);

      await this.inventory.lockWarehouseInTx(tx, command.tenantId, take.warehouseId);
      const pendingCount = await this.pendingTaskCountInTx(tx, command.tenantId, take.id);
      if (pendingCount > 0) throw stockTakeIncomplete(pendingCount);
      const open = await this.openVariancesInTx(tx, command.tenantId, take.id);
      if (openVarianceDigestOf(open) !== command.openVarianceDigest) throw stockTakeChanged();
      const over = open.filter(
        (row) => row.thresholdQuantityMilli !== null && Math.abs(row.deltaMilli) > row.thresholdQuantityMilli,
      );
      if (over.length > 0 && role !== 'owner') throw varianceOwnerRequired(over.map((row) => row.id));
      // ONE epoch guard over all take bins: live vs the latest completed task's.
      const moved = await this.movedBinsInTx(tx, command.tenantId, take);
      if (moved.length > 0) throw stockTakeRecountRequired(moved.map((state) => state.binCode).sort());

      const at = nowIso();
      await tx
        .update(stockTakes)
        .set({ status: 'posting', approvedBy: command.actorUserId, approvedAt: at, updatedAt: at })
        .where(and(eq(stockTakes.tenantId, command.tenantId), eq(stockTakes.id, take.id), eq(stockTakes.status, 'counting')));
      return { replayed: null, take: { ...take, status: 'posting' } };
    });
    if (approved.replayed !== null) return { snapshot: approved.replayed, replayed: true };
    const take = approved.take!;

    // Transactions 2…n — batches of ≤ 200 open variances, whole bins, in
    // bin-code order, chosen from the bins STILL FROZEN for this take: a
    // processed bin's freeze row is gone, so a resumed close never revisits
    // one (posting a variance moves its bin's epoch, which a second visit
    // would misread as moved), and each batch's unposted entries are stored
    // on the take in the batch's own transaction.
    let batches = 0;
    let longestBatchMs = 0;
    for (;;) {
      const started = Date.now();
      const posted = await withTenantTransaction(this.db, command.tenantId, (tx) =>
        this.postBatchInTx(tx, command, idempotencyKey, take),
      );
      if (!posted) break;
      batches += 1;
      longestBatchMs = Math.max(longestBatchMs, Date.now() - started);
    }
    this.logger.log(
      `stock take ${take.id} posted in ${batches} batch(es); longest batch ${longestBatchMs} ms (tenant=${command.tenantId})`,
    );

    // Final transaction.
    const snapshot = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const replay = this.replayer<CloseStockTakeSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      const locked = await this.lockTake(tx, command.tenantId, take.id);
      const winner = await replay();
      if (winner !== null) return winner;
      if (locked.status !== 'posting') throw stockTakeNotCounting(locked.status);
      // The freeze is written under the warehouse advisory everywhere else
      // (an append reads it there) — the last release too.
      await this.inventory.lockWarehouseInTx(tx, command.tenantId, take.warehouseId);
      const released = await this.inventory.releaseFreezeInTx(tx, command.tenantId, take.id);

      const remaining = await this.openVariancesInTx(tx, command.tenantId, take.id);
      const stored = new Map((locked.unposted ?? []).map((entry) => [entry.varianceId, entry]));
      const unpostedList: UnpostedVariance[] = [];
      for (const row of remaining) {
        const known = stored.get(row.id);
        if (known !== undefined) {
          unpostedList.push(known);
          continue;
        }
        // A variance an earlier (interrupted) run left open: re-derive why.
        unpostedList.push(await this.unpostedReasonInTx(tx, command, take, row));
      }
      unpostedList.sort((a, b) => (a.binCode < b.binCode ? -1 : a.binCode > b.binCode ? 1 : a.skuCode < b.skuCode ? -1 : a.skuCode > b.skuCode ? 1 : 0));
      const postedRows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(countVariances)
        .innerJoin(countTasks, and(eq(countTasks.tenantId, countVariances.tenantId), eq(countTasks.id, countVariances.taskId)))
        .where(
          and(
            eq(countVariances.tenantId, command.tenantId),
            eq(countTasks.stockTakeId, take.id),
            eq(countVariances.status, 'adjusted'),
          ),
        );
      const postedCount = Number(postedRows[0]?.n ?? 0);
      const at = nowIso();
      const closed = await tx
        .update(stockTakes)
        .set({
          status: 'closed',
          closedBy: command.actorUserId,
          closedAt: at,
          postedCount,
          unpostedCount: unpostedList.length,
          unposted: unpostedList,
          deviceWrites: sql`${stockTakes.deviceWrites} + ${released.deviceWrites}`,
          updatedAt: at,
        })
        .where(and(eq(stockTakes.tenantId, command.tenantId), eq(stockTakes.id, take.id), eq(stockTakes.status, 'posting')))
        .returning();
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'stock_take.closed',
        occurredAt: at,
        payload: {
          stockTakeId: take.id,
          warehouseId: take.warehouseId,
          postedCount,
          unpostedCount: unpostedList.length,
          closedBy: command.actorUserId,
        },
      });
      const result: CloseStockTakeSnapshot = {
        stockTake: stockTakeSummary(closed[0]!),
        postedCount,
        unposted: unpostedList,
      };
      await this.audit(tx, command.tenantId, command.actorUserId, 'stock_take.closed', take.id, idempotencyKey, at);
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
    return { snapshot, replayed: false, metrics: { batches, longestBatchMs } };
  }

  /**
   * One posting batch (A2). Returns false when no frozen bin of the take is
   * left (the batches are done).
   */
  private async postBatchInTx(
    tx: TenantTx,
    command: CloseStockTakeCommand,
    idempotencyKey: string,
    takeAtApproval: StockTake,
  ): Promise<boolean> {
    // 1. the take, still posting.
    const take = await this.lockTake(tx, command.tenantId, takeAtApproval.id);
    if (take.status !== 'posting') return false;

    // Choose the batch, bounded: the next still-frozen bins of the take in
    // code order with their open-variance counts (one limited read), whole
    // bins added while the batch stays within STOCK_TAKE_POST_BATCH variances
    // (a single bin over it still posts whole).
    const nextBins = (await tx.execute(sql`
      select f.bin_id as "binId",
             (select count(*)::int from count_variances v
                join count_tasks t on t.tenant_id = v.tenant_id and t.id = v.task_id
               where v.tenant_id = f.tenant_id and t.stock_take_id = f.stock_take_id
                 and v.bin_id = f.bin_id and v.status = 'open') as "open"
        from stock_freeze_bins f
       where f.tenant_id = ${command.tenantId}::uuid and f.stock_take_id = ${take.id}::uuid
       order by f.bin_code collate "C", f.bin_id
       limit ${STOCK_TAKE_POST_BATCH}
    `)) as unknown as { binId: string; open: number }[];
    if (nextBins.length === 0) return false;
    const batchBins: string[] = [];
    let batchSize = 0;
    for (const row of nextBins) {
      const open = Number(row.open);
      if (batchBins.length > 0 && batchSize + open > STOCK_TAKE_POST_BATCH) break;
      batchBins.push(row.binId);
      batchSize += open;
    }
    const batchIds = (
      await tx
        .select({ id: countVariances.id })
        .from(countVariances)
        .innerJoin(countTasks, and(eq(countTasks.tenantId, countVariances.tenantId), eq(countTasks.id, countVariances.taskId)))
        .where(
          and(
            eq(countVariances.tenantId, command.tenantId),
            eq(countTasks.stockTakeId, take.id),
            inArray(countVariances.binId, batchBins),
            eq(countVariances.status, 'open'),
          ),
        )
    ).map((row) => row.id);
    const trimmedIds = new Set(batchIds);

    // 2. the variance rows, sorted by id.
    const variances =
      trimmedIds.size === 0
        ? []
        : await tx
            .select()
            .from(countVariances)
            .where(and(eq(countVariances.tenantId, command.tenantId), inArray(countVariances.id, [...trimmedIds]), eq(countVariances.status, 'open')))
            .orderBy(asc(countVariances.id))
            .for('update');
    // 3. their distinct SKUs, sorted (K1 — the adjustment guard locks the SKU).
    const skuIds = [...new Set(variances.map((row) => row.skuId))].sort();
    const skuRows =
      skuIds.length === 0
        ? []
        : await tx
            .select({
              id: skus.id,
              code: skus.code,
              tracked: sql<boolean>`(${skus.batchTracked} or ${skus.serialTracked} or ${skus.catchWeightTracked})`,
            })
            .from(skus)
            .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.id, skuIds)))
            .orderBy(asc(skus.id))
            .for('update');
    const skuCode = new Map(skuRows.map((row) => [row.id, row.code]));
    const skuTracked = new Map(skuRows.map((row) => [row.id, row.tracked === true]));
    // 4. their bin rows, sorted.
    const binRows = await tx
      .select({ id: bins.id, code: bins.code })
      .from(bins)
      .where(and(eq(bins.tenantId, command.tenantId), inArray(bins.id, [...batchBins].sort())))
      .orderBy(asc(bins.id))
      .for('update');
    const binCode = new Map(binRows.map((row) => [row.id, row.code]));
    // 5. the warehouse advisory.
    await this.inventory.lockWarehouseInTx(tx, command.tenantId, take.warehouseId);

    // 6. each bin's epoch vs its latest completed take task (only an
    // admitted device op can have moved it since approval).
    const states = await this.takeBinStatesInTx(tx, command.tenantId, take.id, batchBins);
    const live = await this.inventory.binStateEpochsInTx(tx, command.tenantId, take.warehouseId, batchBins);
    const movedBins = new Set(
      states.filter((state) => (live.get(state.binId) ?? null) !== state.latestEpoch).map((state) => state.binId),
    );

    // 7. this batch's bins leave the freeze (they are final); their admitted
    // handheld writes move onto the take.
    const released = await this.inventory.releaseFreezeInTx(tx, command.tenantId, take.id, batchBins);

    // 8–11. post each variance.
    const at = nowIso();
    const unposted: UnpostedVariance[] = [];
    const auditValues: (typeof auditEvents.$inferInsert)[] = [];
    for (const variance of variances) {
      const entryBase = {
        varianceId: variance.id,
        binId: variance.binId,
        binCode: binCode.get(variance.binId) ?? '',
        skuId: variance.skuId,
        skuCode: skuCode.get(variance.skuId) ?? '',
        needsLotCount: skuTracked.get(variance.skuId) ?? false,
      };
      if (movedBins.has(variance.binId)) {
        unposted.push({
          ...entryBase,
          code: 'basis-moved',
          detail: `Bin "${entryBase.binCode}" moved after it was counted (a handheld op synced late) — recount it, then resolve this variance from the variance queue.`,
        });
        continue;
      }
      const rebuilt: AdjustStockCommand = {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        warehouseId: variance.warehouseId,
        skuId: variance.skuId,
        binId: variance.binId,
        quantityDelta: fromMilli(variance.deltaMilli),
        reasonCode: 'stock-count',
        note: `stock take ${take.id} — count variance ${variance.id}, count task ${variance.taskId}`,
        occurredAt: at,
        countVarianceId: variance.id,
      };
      let eventId: string;
      try {
        // A savepoint per variance: a refusal (a guard or the fold) rolls
        // back that variance alone and leaves it open, listed unposted.
        eventId = await tx.transaction(async (sp) => {
          await this.inventory.assertAdjustableInTx(sp, rebuilt);
          const applied = await this.inventory.applyAdjustmentInTx(sp, rebuilt, variance.deltaMilli as SignedQuantity, [], at);
          return applied.firstEventId;
        });
      } catch (err) {
        if (!(err instanceof ProblemException)) throw err;
        unposted.push({ ...entryBase, ...problemCodeDetail(err) });
        continue;
      }
      const updated = await tx
        .update(countVariances)
        .set({ status: 'adjusted', resolvedBy: command.actorUserId, resolvedAt: at, ledgerEventId: eventId, updatedAt: at })
        .where(and(eq(countVariances.tenantId, command.tenantId), eq(countVariances.id, variance.id), eq(countVariances.status, 'open')))
        .returning({ id: countVariances.id });
      if (updated[0] === undefined) {
        throw new Error(`stock take ${take.id}: variance ${variance.id} left open under its own row lock`);
      }
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'count.variance.resolved',
        occurredAt: at,
        payload: {
          varianceId: variance.id,
          taskId: variance.taskId,
          warehouseId: variance.warehouseId,
          binId: variance.binId,
          skuId: variance.skuId,
          decision: 'approve_adjust',
          status: 'adjusted',
          expectedQuantity: fromMilli(variance.expectedQuantity),
          countedQuantity: fromMilli(variance.countedQuantity),
          delta: fromMilli(variance.deltaMilli),
          thresholdQuantity: variance.thresholdQuantityMilli === null ? null : fromMilli(variance.thresholdQuantityMilli),
          overThreshold:
            variance.thresholdQuantityMilli !== null && Math.abs(variance.deltaMilli) > variance.thresholdQuantityMilli,
          consideredEventSeqs: null,
          resolvedBy: command.actorUserId,
          resolvedAt: at,
          recountTaskId: null,
          stockTakeId: take.id,
        },
      });
      auditValues.push({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'count.variance.resolved',
        targetType: 'count_variance',
        targetId: variance.id,
        reference: idempotencyKey,
        occurredAt: at,
      });
    }
    if (auditValues.length > 0) await tx.insert(auditEvents).values(auditValues);
    // The batch's unposted entries and the released handheld writes, stored
    // on the take in this transaction — a resumed close reads them back.
    await tx
      .update(stockTakes)
      .set({
        unposted: sql`coalesce(${stockTakes.unposted}, '[]'::jsonb) || ${JSON.stringify(unposted)}::jsonb`,
        deviceWrites: sql`${stockTakes.deviceWrites} + ${released.deviceWrites}`,
        updatedAt: at,
      })
      .where(and(eq(stockTakes.tenantId, command.tenantId), eq(stockTakes.id, take.id)));
    return true;
  }

  /** Why a still-open variance cannot post (an interrupted run's leftovers). */
  private async unpostedReasonInTx(
    tx: TenantTx,
    command: CloseStockTakeCommand,
    take: StockTake,
    row: typeof countVariances.$inferSelect,
  ): Promise<UnpostedVariance> {
    const meta = await tx
      .select({
        binCode: bins.code,
        skuCode: skus.code,
        tracked: sql<boolean>`(${skus.batchTracked} or ${skus.serialTracked} or ${skus.catchWeightTracked})`,
      })
      .from(bins)
      .innerJoin(skus, and(eq(skus.tenantId, bins.tenantId), eq(skus.id, row.skuId)))
      .where(and(eq(bins.tenantId, command.tenantId), eq(bins.id, row.binId)))
      .limit(1);
    const base = {
      varianceId: row.id,
      binId: row.binId,
      binCode: meta[0]?.binCode ?? '',
      skuId: row.skuId,
      skuCode: meta[0]?.skuCode ?? '',
      needsLotCount: meta[0]?.tracked === true,
    };
    try {
      await tx.transaction(async (sp) => {
        await this.inventory.assertAdjustableInTx(sp, {
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          warehouseId: row.warehouseId,
          skuId: row.skuId,
          binId: row.binId,
          quantityDelta: fromMilli(row.deltaMilli),
          reasonCode: 'stock-count',
          note: `stock take ${take.id}`,
          countVarianceId: row.id,
        });
        throw new SavepointRollback();
      });
    } catch (err) {
      if (err instanceof ProblemException) return { ...base, ...problemCodeDetail(err) };
      if (!(err instanceof SavepointRollback)) throw err;
    }
    return {
      ...base,
      code: 'basis-moved',
      detail: `Bin "${base.binCode}" moved after it was counted — recount it, then resolve this variance from the variance queue.`,
    };
  }

  // ── abandon (counts.manage) ────────────────────────────────────────────

  async abandonStockTake(command: AbandonStockTakeCommand, idempotencyKey: string): Promise<{ snapshot: AbandonStockTakeSnapshot; replayed: boolean }> {
    const note = normaliseNote(command.note);
    const payloadHash = this.abandonFingerprint(command);
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'counts.manage');
      const replay = this.replayer<AbandonStockTakeSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      const first = await replay();
      if (first !== null) return { snapshot: first, replayed: true };
      const take = await this.lockTake(tx, command.tenantId, command.stockTakeId);
      const afterTake = await replay();
      if (afterTake !== null) return { snapshot: afterTake, replayed: true };
      if (take.status !== 'counting') throw stockTakeNotCounting(take.status);

      const locked = await tx
        .select({ id: countTasks.id })
        .from(countTasks)
        .where(and(eq(countTasks.tenantId, command.tenantId), eq(countTasks.stockTakeId, take.id), eq(countTasks.status, 'pending')))
        .orderBy(asc(countTasks.id))
        .for('update');
      await this.inventory.lockWarehouseInTx(tx, command.tenantId, take.warehouseId);
      const underLock = await replay();
      if (underLock !== null) return { snapshot: underLock, replayed: true };
      const lockedIds = new Set(locked.map((row) => row.id));
      const pending = await tx
        .select({ id: countTasks.id })
        .from(countTasks)
        .where(and(eq(countTasks.tenantId, command.tenantId), eq(countTasks.stockTakeId, take.id), eq(countTasks.status, 'pending')));
      if (pending.some((row) => !lockedIds.has(row.id))) {
        throw concurrentConflict('A recount was created for this stock take while it was being abandoned — retry.');
      }
      const at = nowIso();
      // A pending task some variance names as its recount (a variance
      // superseded at start, A6, or by a requested or conflict recount) is
      // RELEASED to the cycle queue, still pending — cancelling it would
      // leave that variance `recounted` against a dead task, gone from the
      // queue (decision 8: the variances stay on the queue). Only the rest
      // are cancelled.
      const pendingIds = pending.map((row) => row.id);
      const named =
        pendingIds.length === 0
          ? new Set<string>()
          : new Set(
              (
                await tx
                  .select({ id: countVariances.recountTaskId })
                  .from(countVariances)
                  .where(and(eq(countVariances.tenantId, command.tenantId), inArray(countVariances.recountTaskId, pendingIds)))
              ).map((row) => row.id!),
            );
      const releaseIds = pendingIds.filter((id) => named.has(id));
      const cancelIds = pendingIds.filter((id) => !named.has(id));
      const released =
        releaseIds.length === 0
          ? []
          : await tx
              .update(countTasks)
              .set({ stockTakeId: null, updatedAt: at })
              .where(and(eq(countTasks.tenantId, command.tenantId), inArray(countTasks.id, releaseIds), eq(countTasks.status, 'pending')))
              .returning({ id: countTasks.id });
      const cancelled =
        cancelIds.length === 0
          ? []
          : await tx
              .update(countTasks)
              .set({ status: 'cancelled', cancelledBy: command.actorUserId, cancelledAt: at, updatedAt: at })
              .where(
                and(
                  eq(countTasks.tenantId, command.tenantId),
                  inArray(countTasks.id, cancelIds),
                  eq(countTasks.status, 'pending'),
                ),
              )
              .returning({ id: countTasks.id });
      const freed = await this.inventory.releaseFreezeInTx(tx, command.tenantId, take.id);
      const abandoned = await tx
        .update(stockTakes)
        .set({
          status: 'abandoned',
          abandonedBy: command.actorUserId,
          abandonedAt: at,
          abandonNote: note,
          deviceWrites: sql`${stockTakes.deviceWrites} + ${freed.deviceWrites}`,
          updatedAt: at,
        })
        .where(and(eq(stockTakes.tenantId, command.tenantId), eq(stockTakes.id, take.id), eq(stockTakes.status, 'counting')))
        .returning();
      if (abandoned[0] === undefined) throw stockTakeNotCounting('changed');
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'stock_take.abandoned',
        occurredAt: at,
        payload: {
          stockTakeId: take.id,
          warehouseId: take.warehouseId,
          cancelledTaskCount: cancelled.length,
          releasedTaskCount: released.length,
          abandonedBy: command.actorUserId,
        },
      });
      const snapshot: AbandonStockTakeSnapshot = {
        stockTake: stockTakeSummary(abandoned[0]),
        cancelledTaskCount: cancelled.length,
        releasedTaskCount: released.length,
      };
      await this.audit(tx, command.tenantId, command.actorUserId, 'stock_take.abandoned', take.id, idempotencyKey, at);
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return { snapshot, replayed: false };
    });
  }

  // ── shared in-tx reads (also the facade's) ─────────────────────────────

  /** The take's pending task count. */
  async pendingTaskCountInTx(tx: TenantTx, tenantId: string, stockTakeId: string): Promise<number> {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(countTasks)
      .where(and(eq(countTasks.tenantId, tenantId), eq(countTasks.stockTakeId, stockTakeId), eq(countTasks.status, 'pending')));
    return Number(rows[0]?.n ?? 0);
  }

  /** The take's open variances (every one belongs to a bin's latest count — decision 6). */
  async openVariancesInTx(tx: TenantTx, tenantId: string, stockTakeId: string): Promise<(typeof countVariances.$inferSelect)[]> {
    const rows = await tx
      .select({ row: countVariances })
      .from(countVariances)
      .innerJoin(countTasks, and(eq(countTasks.tenantId, countVariances.tenantId), eq(countTasks.id, countVariances.taskId)))
      .where(and(eq(countVariances.tenantId, tenantId), eq(countTasks.stockTakeId, stockTakeId), eq(countVariances.status, 'open')))
      .orderBy(asc(countVariances.id));
    return rows.map((wrapped) => wrapped.row);
  }

  /**
   * Every bin of the take (its task bins) with its latest COMPLETED take
   * task and that task's frozen epoch (null task = never completed).
   */
  async takeBinStatesInTx(
    tx: TenantTx,
    tenantId: string,
    stockTakeId: string,
    binIds?: readonly string[],
  ): Promise<TakeBinState[]> {
    if (binIds !== undefined && binIds.length === 0) return [];
    const rows = await tx.execute(sql`
      select distinct on (t.bin_id)
             t.bin_id as "binId",
             b.code as "binCode",
             case when t.status = 'completed' then t.id end as "latestTaskId",
             case when t.status = 'completed' then t.bin_state_epoch end as "latestEpoch"
        from count_tasks t
        join bins b on b.tenant_id = t.tenant_id and b.id = t.bin_id
       where t.tenant_id = ${tenantId}::uuid
         and t.stock_take_id = ${stockTakeId}::uuid
         ${binIds === undefined ? sql`` : sql`and t.bin_id in (${sql.join(binIds.map((id) => sql`${id}::uuid`), sql`, `)})`}
       order by t.bin_id, (t.status = 'completed') desc, t.completed_at desc nulls last, t.id desc
    `);
    return (rows as unknown as { binId: string; binCode: string; latestTaskId: string | null; latestEpoch: string | number | null }[]).map((row) => ({
      binId: row.binId,
      binCode: row.binCode,
      latestTaskId: row.latestTaskId,
      latestEpoch: row.latestEpoch === null ? null : Number(row.latestEpoch),
    }));
  }

  /** The take bins whose live epoch differs from their latest completed task's (the close's guard). */
  async movedBinsInTx(tx: TenantTx, tenantId: string, take: StockTake): Promise<TakeBinState[]> {
    const states = await this.takeBinStatesInTx(tx, tenantId, take.id);
    if (states.length === 0) return [];
    const live = await this.inventory.binStateEpochsInTx(tx, tenantId, take.warehouseId, states.map((state) => state.binId));
    return states.filter((state) => state.latestTaskId !== null && (live.get(state.binId) ?? null) !== state.latestEpoch);
  }

  // ── plumbing ───────────────────────────────────────────────────────────

  private async readTake(tx: TenantTx, tenantId: string, id: string): Promise<StockTake> {
    const rows = await tx.select().from(stockTakes).where(and(eq(stockTakes.tenantId, tenantId), eq(stockTakes.id, id))).limit(1);
    if (rows[0] === undefined) throw stockTakeNotFound();
    return rows[0];
  }

  /** Lock, 404 when absent — no status check (the `loadOpenPo` lesson). */
  private async lockTake(tx: TenantTx, tenantId: string, id: string): Promise<StockTake> {
    const rows = await tx
      .select()
      .from(stockTakes)
      .where(and(eq(stockTakes.tenantId, tenantId), eq(stockTakes.id, id)))
      .limit(1)
      .for('update');
    if (rows[0] === undefined) throw stockTakeNotFound();
    return rows[0];
  }

  private replayer<T>(tx: TenantTx, tenantId: string, key: string, payloadHash: string): () => Promise<T | null> {
    return async () => {
      const rows = await tx
        .select({ payloadHash: idempotencyKeys.payloadHash, responseSnapshot: idempotencyKeys.responseSnapshot })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
        .limit(1);
      const existing = rows[0];
      if (existing === undefined) return null;
      if (existing.payloadHash !== payloadHash) throw idempotencyKeyReuse();
      return existing.responseSnapshot as T;
    };
  }

  private async audit(tx: TenantTx, tenantId: string, actorUserId: string, action: string, targetId: string, key: string, at: string): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId,
      action,
      targetType: 'stock_take',
      targetId,
      reference: key,
      occurredAt: at,
    });
  }

  private async writeKey(tx: TenantTx, tenantId: string, key: string, payloadHash: string, snapshot: unknown): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key, payloadHash, responseSnapshot: snapshot });
    } catch (err) {
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        throw new ProblemException(
          'conflict',
          409,
          'Concurrent idempotent request',
          'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
        );
      }
      throw err;
    }
  }
}

class SavepointRollback extends Error {}

function problemCodeDetail(err: ProblemException): { code: string; detail: string } {
  const response = err.getResponse() as { code?: unknown; detail?: unknown };
  return {
    code: typeof response.code === 'string' ? response.code : 'refused',
    detail: typeof response.detail === 'string' ? response.detail : err.message,
  };
}

/** A multi-row insert chunked under the 65,535 bind-parameter ceiling (guide §3). */
async function insertChunked<T extends Record<string, unknown>>(
  tx: TenantTx,
  table: typeof countTasks | typeof countTaskLines,
  rows: readonly T[],
): Promise<void> {
  if (rows.length === 0) return;
  const chunk = Math.floor(65_535 / Object.keys(rows[0]!).length);
  for (let at = 0; at < rows.length; at += chunk) {
    await tx.insert(table).values(rows.slice(at, at + chunk) as never);
  }
}
