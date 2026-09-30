import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  bins,
  countPolicies,
  countTaskLines,
  countTasks,
  countVariances,
  countVariancePolicies,
  idempotencyKeys,
  skus,
  type CountTask,
} from '../../shared/db/schema';
// Type-only: the status tuple's element type rides `typeof` — no runtime use.
import type { COUNT_VARIANCE_STATUSES } from '../../shared/db/schema';
import { assertRecordableQuantity, fromMilli } from '../../shared/primitives/quantity';
import type { SignedQuantity } from '../../shared/primitives/quantity';
import { uuidv7 } from '../../shared/primitives/ids';
import { assertUtcIso, canonicalInstant, nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { uomPrecision } from '../catalog/uom';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { AdjustStockCommand } from '../inventory/inventory.facade';

/**
 * Cycle counts (Story 5-3, FR-cycle-count): the movements module's second
 * occupant and its FIRST STORED TASK TABLE — a count task must FREEZE its
 * expected quantities and the bin's state epoch at task start (a derived
 * task recomputes them, breaking "expected = bin state at count start").
 *
 * Three commands, in the transfer.command order (each step load-bearing):
 * - **create** (on demand, `counts.manage`) — one task per bin, `pending`,
 *   with the per-SKU expected quantities (the bin's on-hand, frozen) and the
 *   bin's epoch captured in-transaction UNDER the locks; outbox
 *   `count.created`.
 * - **submit** (the floor verb, `counts.execute` — either session family):
 *   every task line must be counted (a line the request does not name is a
 *   400 `count-incomplete` — 0 is a valid count only when EXPLICITLY
 *   entered); counted ≠ expected appends one `open` variance row per
 *   differing SKU, stamped with the tenant's variance-threshold policy
 *   FROZEN at submit (story 5-4); the epoch compare runs UNDER the locks
 *   and is an EQUALITY against the live epoch (`null` matches) — a mismatch
 *   flags every variance `epochConflict` AND auto-creates a fresh recount
 *   task for the bin in the same transaction (OQ-2, AD-14 case-3 shape).
 *   Counts NEVER write stock: no ledger event, no on-hand change, no epoch
 *   bump. (The 5-4 approve-adjust resolution is the story's ONLY count-side
 *   stock write, and it runs through the adjustment vocabulary.)
 * - **resolve** (story 5-4, `variances.resolve` — owner + Ops Manager): one
 *   open variance per resolution. approve_adjust moves the bin by the
 *   counted−expected delta as `stock.adjusted` events (epoch must still
 *   equal the task's frozen one) or recount re-plans the bin and re-bases
 *   the variance; the resolution carries its consulted ledger seqs, is
 *   audit-logged and outboxed (`count.variance.resolved`). An over-threshold
 *   variance (its frozen submit stamp) resolves by owner only.
 * - **upsert policies** (`counts.manage`): one row per (tenant, warehouse,
 *   ABC class) naming the scheduled interval in days — a policy IS the
 *   schedule, so the policy write rides `counts.manage` (the `waves.manage`
 *   rationale).
 *
 * Locks (the canonical acyclic order — the inbound confirm's mirror): the
 * task row first at submit (the state machine's mutex), then the bin row
 * `.for('update')`, then the warehouse advisory LAST — any epoch compare
 * runs UNDER the locks (movements gotcha 2: read → lock → compare; a
 * staleness gate that read a pre-lock epoch would slip a genuinely moved bin
 * past the refusal).
 *
 * Authorization (the command-entry pattern): the capability is asserted at
 * command-service entry — a DB role read in the command's own transaction,
 * BEFORE the idempotency replay lookup. The scheduler worker generates
 * scheduled tasks through `generateScheduledTasksInTx` directly (the reaper
 * precedent — a job, not a client request: no HTTP command layer, no
 * idempotency key, `createdBy` null).
 *
 * Idempotency (AD-5): the client-generated ULID key de-dupes in the same
 * transaction as the write; same key + same payload replays the original
 * snapshot, same key + different payload is a 422 `idempotency-key-reuse`.
 * The mobile op's ULID IS the key.
 */
export interface CreateCountCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly occurredAt?: string | undefined;
}

/** One counted line of a submit, in the client's own order. */
export interface SubmitCountLineInput {
  readonly skuId: string;
  /** Base UoM (story 10.1 — base on the wire); 0 is a valid explicit count. */
  readonly countedQuantity: number;
}

export interface SubmitCountCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly taskId: string;
  /** Every task line MUST appear here (completeness); extra SKUs append. */
  readonly lines: readonly SubmitCountLineInput[];
  readonly occurredAt?: string | undefined;
}

export interface CountPolicyInput {
  readonly abcClass: string;
  readonly intervalDays: number;
}

export interface UpsertCountPoliciesCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  /** The warehouse's named policy rows; each upserts in place. */
  readonly policies: readonly CountPolicyInput[];
  readonly occurredAt?: string | undefined;
}

/** The API response body (and the idempotency snapshot), create shape. */
export interface CreateCountSnapshot {
  readonly countTask: {
    readonly id: string;
    readonly status: string;
    readonly warehouseId: string;
    readonly binId: string;
    readonly binCode: string;
    readonly origin: string;
    /** The bin state frozen at task start (the counter's raw value). */
    readonly binStateEpoch: number | null;
    readonly createdAt: string;
  };
  readonly lines: readonly {
    readonly skuId: string;
    /** Base units at the edge (story 10.1) — the frozen expectation. */
    readonly expectedQuantity: number;
  }[];
}

/** One variance of the submit snapshot, in base units. */
export interface CountVarianceSnapshot {
  readonly skuId: string;
  readonly expectedQuantity: number;
  readonly countedQuantity: number;
  /** counted − expected, base units. */
  readonly delta: number;
  readonly epochConflict: boolean;
}

/** The API response body (and the idempotent replay's stored copy), submit. */
export interface SubmitCountSnapshot {
  readonly countTask: {
    readonly id: string;
    readonly status: string;
    readonly warehouseId: string;
    readonly binId: string;
    readonly completedAt: string;
    /** A movement moved the bin between task start and submit (OQ-2). */
    readonly epochConflict: boolean;
  };
  readonly variances: readonly CountVarianceSnapshot[];
  /** The auto-created recount task when the epoch conflicted; null otherwise. */
  readonly recountTaskId: string | null;
}

/** The API response body, policy upsert. */
export interface CountPoliciesSnapshot {
  readonly policies: readonly {
    readonly abcClass: string;
    readonly intervalDays: number;
  }[];
}

/**
 * The variance-threshold policy PUT body (story 5-4): the threshold in BASE
 * units on the wire (the codebase's units rule — conversion sits inside the
 * command, behind the replay lookup); stored as `quantity_threshold_milli`
 * so the submit freezes it straight onto the variance rows. `0` is valid
 * (every variance over-threshold); `null`/absent disables the routing — the
 * same semantics as a missing row, and the only way back off an enabled
 * threshold (there is no delete verb: PUT is upsert).
 */
export interface SetVariancePolicyCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly quantityThreshold: number | null;
}

/** GET …/movements/variance-policies response — null when unset (flow disabled). */
export interface VariancePolicySnapshot {
  readonly id: string;
  readonly tenantId: string;
  /** Base units at the edge; null when the policy is disabled. */
  readonly quantityThreshold: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The resolve command (story 5-4): the per-variance resolution. `decision`
 * carries the ARM — not a stored state; the arm's STATUS is what the row
 * carries (`adjusted` | `recounted`).
 */
export interface ResolveCountVarianceCommand {
  readonly tenantId: string;
  /** The resolver's session user — authority is re-read from the DB at entry. */
  readonly actorUserId: string;
  readonly varianceId: string;
  /** The arm: the approve-adjust correction, or the recount re-plan. */
  readonly decision: 'approve_adjust' | 'recount';
  /**
   * The ledger seqs this resolution STATES it consulted (the bin's history
   * the approver pulled from the ledger timeline). REQUIRED, non-empty, on
   * the approve arm — an explicit stock correction that consulted no
   * history is exactly the silent write-off the epic forbids; optional on
   * the recount arm (the recount task's snapshot is its new basis, made
   * after the resolution runs). The per-seq shape checks (whole numbers ≥ 1)
   * live in the wire DTO; this command checks the set's SIZE (at most
   * `CONSIDERED_SEQS_MAX`) and the approve arm's non-empty requirement only.
   */
  readonly consideredEventSeqs?: readonly number[] | undefined;
  readonly occurredAt?: string | undefined;
}

/** One row of the variance queue read (and the resolve response's core). */
export interface CountVarianceEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly skuId: string;
  /** Base units at the edge (story 10.1) — the frozen expectation. */
  readonly expectedQuantity: number;
  /** Base units — what the operator counted. */
  readonly countedQuantity: number;
  /** counted − expected, base units. */
  readonly delta: number;
  /** A movement moved the bin between task start and submit (OQ-2). */
  readonly epochConflict: boolean;
  /** The DB CHECK's vocabulary — the mirrored tuple, not a bare string. */
  readonly status: (typeof COUNT_VARIANCE_STATUSES)[number];
  /** The submit-frozen threshold in BASE units; null = no policy (disabled). */
  readonly thresholdQuantity: number | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  /** The recount arm's minted task; null on the approve arm and while open. */
  readonly recountTaskId: string | null;
  /** The ledger seqs the resolution stated it consulted; null when none stated. */
  readonly consideredEventSeqs: number[] | null;
  readonly createdAt: string;
}

/** The API response body (and the idempotent replay's stored copy), resolve. */
export interface ResolveCountVarianceSnapshot {
  readonly variance: CountVarianceEntry;
  /**
   * The approve arm's correction: the applied `stock.adjusted` event (id +
   * seq — the single-event shape is the only reachable one here: a variance
   * has no serial arms) and the settled on-hand. Null on the recount arm.
   */
  readonly stockCorrection: {
    readonly eventId: string;
    readonly seq: number | null;
    readonly onHand: {
      readonly skuId: string;
      readonly binId: string;
      /** Base units — the on-hand after the correction. */
      readonly quantity: number;
    };
  } | null;
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

// ── machine-code helpers (the spec's matrix fixes these) ─────────────────────

/** Any submit meeting a task that is no longer `pending`. */
function countWrongState(status: string): ProblemException {
  return new ProblemException(
    'count-task-completed',
    409,
    'Count task is already completed',
    `A count task in status "${status}" cannot be submitted — the task settled on its first submit; a replay with the original key re-serves the stored snapshot.`,
  );
}

/** An open task already on the bin (the on-demand create's 409). */
function countTaskOpen(binCode: string): ProblemException {
  return new ProblemException(
    'count-task-open',
    409,
    'A count task is already open on this bin',
    `Bin "${binCode}" already has a pending count task — one open task per bin; submit it (or wait for the epoch-mismatch recount) before pointing a second task at it.`,
  );
}

/** The submit with a task line the request never counted (the 400 arm). */
function countIncomplete(skuIds: readonly string[]): ProblemException {
  return new ProblemException(
    'count-incomplete',
    400,
    'The count leaves task lines uncounted',
    `Every line of the task must be counted before it can submit — these SKUs have no counted quantity: ${skuIds.join(', ')}. A zero count is valid, but only when explicitly entered.`,
  );
}

/** A resolve meeting a variance that is no longer `open` (story 5-4's 409). */
function varianceResolved(status: string, varianceId: string): ProblemException {
  return new ProblemException(
    'variance-resolved',
    409,
    'Count variance already resolved',
    `Variance "${varianceId}" is already ${status} — resolutions are terminal.`,
  );
}

/** An over-threshold variance resolved by a role below owner — 403. */
function varianceOwnerRequired(varianceId: string): ProblemException {
  return new ProblemException(
    'variance-owner-required',
    403,
    'Over-threshold variance resolves by owner only',
    `Variance "${varianceId}" exceeded the tenant's threshold when it was submitted — |delta| > the frozen threshold stamps it owner-only. Owner resolves this one; the frozen threshold decides, the resolver's role is read at command entry.`,
  );
}

/** The task's frozen bin epoch no longer matches the live state — approve-adjust refuses. */
function varianceBasisMoved(varianceId: string, frozenEpoch: number | null): ProblemException {
  return new ProblemException(
    'variance-basis-moved',
    409,
    'The variance counting basis has moved',
    `Variance "${varianceId}" was counted against bin state frozen at epoch ${frozenEpoch === null ? 'none' : frozenEpoch} — the bin has moved since (the live epoch no longer matches the frozen value), so the counted expectation is not the correction's basis. A moved basis means recount, not adjust; the recount arm is the remedy.`,
  );
}

/** The consulted-seqs statement's ceiling (a timeline pull, not a bulk export). */
const CONSIDERED_SEQS_MAX = 200;

/**
 * Normalise the consulted seqs for hashing AND storage: deduped, ascending —
 * the statement names a SET of ledger events, so client order is not part
 * of the resolution's identity (a retried request listing the same events
 * in another order still replays).
 */
function normalizeConsideredSeqs(seqs: readonly number[]): number[] {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

/**
 * The variance row's read-model shape (base units at the edge; the resolve
 * snapshot and the 5-5-destined queue read share this ONE mapper — a copy
 * drifts the moment a column moves).
 */
export function varianceEntry(row: typeof countVariances.$inferSelect): CountVarianceEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    taskId: row.taskId,
    warehouseId: row.warehouseId,
    binId: row.binId,
    skuId: row.skuId,
    expectedQuantity: fromMilli(row.expectedQuantity),
    countedQuantity: fromMilli(row.countedQuantity),
    delta: fromMilli(row.deltaMilli),
    epochConflict: row.epochConflict,
    // The DB CHECK's vocabulary, mirrored (the row's column is the raw text
    // type; the wire shape narrows to the same tuple the schema comment
    // names — one vocabulary, two layers).
    status: row.status as (typeof COUNT_VARIANCE_STATUSES)[number],
    thresholdQuantity: row.thresholdQuantityMilli === null ? null : fromMilli(row.thresholdQuantityMilli),
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt === null ? null : canonicalInstant(row.resolvedAt),
    recountTaskId: row.recountTaskId,
    consideredEventSeqs: row.consideredEventSeqs ?? null,
    // The queue read keys its cursor on the FULL-precision instant beside
    // this; the body keeps the canonical (ms) shape.
    createdAt: canonicalInstant(row.createdAt),
  };
}

@Injectable()
export class CountService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition through the facade only (AD-6): the bin-row /
    // warehouse locks, the epoch read and the expected-capture on-hand read
    // all ride the inventory facade's in-transaction passthroughs.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  // ── createCount (on demand, counts.manage) ──────────────────────────────

  /**
   * The create fingerprint over the command's business fields (fixed key
   * order — see `hashCommandPayload`). A retry must replay on the same body.
   */
  createFingerprint(command: CreateCountCommand): string {
    return hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      binId: command.binId,
      occurredAt: command.occurredAt,
    });
  }

  async createCount(
    command: CreateCountCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: CreateCountSnapshot; replayed: boolean }> {
    // Shape check above the transaction: business time validation (the
    // primitive throws a plain error — mapped to 400 here so it never
    // renders as 500).
    let occurredAt: string;
    if (command.occurredAt === undefined) {
      occurredAt = nowIso();
    } else {
      try {
        occurredAt = assertUtcIso(command.occurredAt);
      } catch {
        throw new ProblemException(
          'validation-failed',
          400,
          'occurredAt must be a valid ISO-8601 UTC instant',
          `occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${command.occurredAt}").`,
        );
      }
    }

    const payloadHash = this.createFingerprint(command);

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry — DB read, same tx, BEFORE the
        // replay lookup (the deliberate fail-closed carve-out).
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'counts.manage',
        );

        const existing = await this.lookupIdempotencyKey(tx, command.tenantId, idempotencyKey);
        if (existing !== undefined) {
          if (existing.payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing.responseSnapshot as CreateCountSnapshot,
            replayed: true,
          };
        }

        // Master-data integrity (no-FK convention): the warehouse and its
        // bin exist in this tenant — a foreign or nonexistent scope is 404
        // before any write.
        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
        const binRows = await tx
          .select({ id: bins.id, code: bins.code, systemOwned: bins.systemOwned })
          .from(bins)
          .where(
            and(
              eq(bins.tenantId, command.tenantId),
              eq(bins.warehouseId, command.warehouseId),
              eq(bins.id, command.binId),
            ),
          )
          // The bin row lock is first in the canonical acyclic order (the
          // warehouse advisory is taken last) — the same bin row a movement
          // takes, so creation serializes against a concurrent movement's
          // epoch fold instead of racing its read.
          .limit(1)
          .for('update');
        const bin = binRows[0];
        if (bin === undefined) {
          throw new ProblemException(
            'not-found',
            404,
            'Bin not found',
            `No bin with id "${command.binId}" exists in this warehouse.`,
          );
        }
        // FROZEN AMENDMENT (story 5-3, user-ratified 2026-09-28): a
        // system-owned bin is not countable. Receiving/QC-hold/In-Transit
        // bins are moved by their own commands — counting them would freeze
        // a stock projection the movement commands are mid-way through
        // writing, so the count targets storage bins only (the transfer
        // command's source-bin gate, mirrored).
        if (bin.systemOwned) {
          throw new ProblemException(
            'validation-failed',
            400,
            'Bin is a system bin',
            `Bin "${bin.code}" is a system bin (Receiving/QC-hold/In-Transit) — counts target storage bins only; the system bins are moved by their own commands.`,
          );
        }

        // The warehouse advisory lock LAST (the canonical order's tail); the
        // epoch + expected reads below sit UNDER the locks.
        await this.inventory.lockWarehouseInTx(tx, command.tenantId, command.warehouseId);

        // One open task per bin — re-checked UNDER the locks so a concurrent
        // create or scheduler tick on the same bin cannot double-open it.
        const openRows = await tx
          .select({ id: countTasks.id })
          .from(countTasks)
          .where(
            and(
              eq(countTasks.tenantId, command.tenantId),
              eq(countTasks.warehouseId, command.warehouseId),
              eq(countTasks.binId, command.binId),
              eq(countTasks.status, 'pending'),
            ),
          )
          .limit(1);
        if (openRows[0] !== undefined) {
          throw countTaskOpen(bin.code);
        }

        // Expected-at-start: the bin's on-hand AT TASK START (frozen — never
        // recomputed at submit), and the bin's state epoch — both read under
        // the locks.
        const expected = await this.inventory.onHandInBinInTx(
          tx,
          command.tenantId,
          command.warehouseId,
          command.binId,
        );
        const epoch = await this.inventory.binStateEpochInTx(
          tx,
          command.tenantId,
          command.warehouseId,
          command.binId,
        );

        // ── writes ────────────────────────────────────────────────────────
        const taskId = uuidv7();
        await tx.insert(countTasks).values({
          id: taskId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          binId: command.binId,
          status: 'pending',
          origin: 'on_demand',
          binStateEpoch: epoch,
          createdBy: command.actorUserId,
        });
        const lineValues = expected
          .filter((arm) => arm.quantity !== 0)
          .map((arm) => ({
            id: uuidv7(),
            tenantId: command.tenantId,
            taskId,
            skuId: arm.skuId,
            expectedQuantity: arm.quantity,
          }));
        if (lineValues.length > 0) {
          await tx.insert(countTaskLines).values(lineValues);
        }

        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'count.created',
          occurredAt,
          payload: {
            taskId,
            binId: command.binId,
            warehouseId: command.warehouseId,
            origin: 'on_demand',
          },
        });

        // The snapshot reads the task row BACK (the orderSnapshotInTx
        // pattern): the response body is the row's own state, not a
        // re-derivation.
        const taskRowRows = await tx
          .select({ createdAt: countTasks.createdAt })
          .from(countTasks)
          .where(and(eq(countTasks.tenantId, command.tenantId), eq(countTasks.id, taskId)))
          .limit(1);
        if (taskRowRows[0] === undefined) {
          throw new Error(`count task ${taskId} disappeared mid-command`);
        }

        const snapshot: CreateCountSnapshot = {
          countTask: {
            id: taskId,
            status: 'pending',
            warehouseId: command.warehouseId,
            binId: command.binId,
            binCode: bin.code,
            origin: 'on_demand',
            binStateEpoch: epoch,
            createdAt: taskRowRows[0].createdAt,
          },
          lines: lineValues.map((line) => ({
            skuId: line.skuId,
            expectedQuantity: fromMilli(line.expectedQuantity),
          })),
        };

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snapshot,
          });
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
        return { snapshot, replayed: false };
      },
    );

    return { snapshot, replayed };
  }

  // ── submitCount (the floor verb, counts.execute) ────────────────────────

  /**
   * The submit fingerprint. The lines fingerprint the RAW request body in
   * the client's own order — a retry must replay on the same body.
   */
  submitFingerprint(command: SubmitCountCommand): string {
    return hashCommandPayload({
      taskId: command.taskId,
      occurredAt: command.occurredAt,
      lines: command.lines.map((line) => ({
        skuId: line.skuId,
        countedQuantity: line.countedQuantity,
      })),
    });
  }

  async submitCount(
    command: SubmitCountCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: SubmitCountSnapshot; replayed: boolean }> {
    // Shape checks above the transaction: business time, the duplicate-line
    // refusal (one counted entry per SKU — two entries naming one SKU is a
    // client bug, not a state) and the per-line sign backstop (the DTO's
    // `@Min(0)` twin — a guard the command owns, not the transport).
    let occurredAt: string;
    if (command.occurredAt === undefined) {
      occurredAt = nowIso();
    } else {
      try {
        occurredAt = assertUtcIso(command.occurredAt);
      } catch {
        throw new ProblemException(
          'validation-failed',
          400,
          'occurredAt must be a valid ISO-8601 UTC instant',
          `occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${command.occurredAt}").`,
        );
      }
    }
    const seenSkus = new Set<string>();
    for (const line of command.lines) {
      if (seenSkus.has(line.skuId)) {
        throw new ProblemException(
          'validation-failed',
          400,
          'A SKU is counted twice',
          `The submit names SKU "${line.skuId}" on two lines — one counted entry per SKU; merge the entries.`,
        );
      }
      seenSkus.add(line.skuId);
      if (!(line.countedQuantity >= 0)) {
        throw new ProblemException(
          'validation-failed',
          400,
          'Counted quantity must not be negative',
          `The line for SKU "${line.skuId}" carries ${line.countedQuantity} — a count records what is on the shelf, never a negative.`,
        );
      }
    }

    const payloadHash = this.submitFingerprint(command);

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // The floor verb — the actor's role is re-read per AD-10, BEFORE the
        // replay lookup.
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'counts.execute',
        );

        const existing = await this.lookupIdempotencyKey(tx, command.tenantId, idempotencyKey);
        if (existing !== undefined) {
          if (existing.payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing.responseSnapshot as SubmitCountSnapshot,
            replayed: true,
          };
        }

        // The task row, LOCKED — the state machine's mutex (404 when
        // foreign). First in the canonical acyclic order, before the bin
        // row and the warehouse advisory.
        const task = await this.lockTaskInTx(tx, command.tenantId, command.taskId);
        if (task.status !== 'pending') {
          throw countWrongState(task.status);
        }

        // The task's stored lines — the completeness probe's subject. A
        // line the request does not name is UNCOUNTED: 0 is a valid count
        // only when explicitly entered (the matrix's 400 `count-incomplete`;
        // a line already carrying a stored count — a beyond-task SKU's
        // append — never re-opens).
        const taskLines = await tx
          .select()
          .from(countTaskLines)
          .where(
            and(
              eq(countTaskLines.tenantId, command.tenantId),
              eq(countTaskLines.taskId, command.taskId),
            ),
          )
          .orderBy(asc(countTaskLines.skuId));
        const namedBySku = new Map(command.lines.map((line) => [line.skuId, line.countedQuantity]));
        const uncounted = taskLines.filter(
          (line) => !namedBySku.has(line.skuId) && line.countedQuantity === null,
        );
        if (uncounted.length > 0) {
          throw countIncomplete(uncounted.map((line) => line.skuId));
        }

        // Locks, in the codebase's canonical acyclic order (the inbound
        // confirm's shape): the task's bin row first, then the warehouse
        // advisory LAST. The epoch compare runs UNDER the locks — an epoch
        // read taken before them would race a concurrent epoch-bumping
        // write between read and lock.
        const binRows = await tx
          .select({ id: bins.id, code: bins.code })
          .from(bins)
          .where(
            and(
              eq(bins.tenantId, command.tenantId),
              eq(bins.warehouseId, task.warehouseId),
              eq(bins.id, task.binId),
            ),
          )
          .limit(1)
          .for('update');
        const bin = binRows[0];
        if (bin === undefined) {
          throw new ProblemException(
            'not-found',
            404,
            'Bin not found',
            'The count task\'s bin no longer exists in this tenant.',
          );
        }
        await this.inventory.lockWarehouseInTx(tx, command.tenantId, task.warehouseId);

        // The epoch compare — an EQUALITY against the live epoch, read
        // UNDER the locks (the inbound confirm's mechanism, deliberately
        // softer: counting is observational, the operator's numbers are
        // still valid observations, only the expected baseline moved — so a
        // mismatch FLAGS the variances and re-plans a recount rather than
        // refusing the submit). `null` matches `null`.
        const epochs = await this.inventory.binStateEpochsInTx(
          tx,
          command.tenantId,
          task.warehouseId,
          [task.binId],
        );
        const liveEpoch = epochs.get(task.binId) ?? null;
        const epochConflict = liveEpoch !== task.binStateEpoch;

        // The counted quantities, converted BEHIND the replay lookup (story
        // 10.2's placement rule): only the precision rule can tighten, so
        // only it sits here, after the SKU's declared precision is read.
        const skuIds = [...new Set(command.lines.map((line) => line.skuId))];
        const skuRows = await tx
          .select({ id: skus.id, code: skus.code, uom: skus.uom })
          .from(skus)
          .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.id, skuIds)));
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
        const countedMilliBySku = new Map<string, number>();
        for (const line of command.lines) {
          const sku = skuById.get(line.skuId)!;
          countedMilliBySku.set(
            line.skuId,
            assertRecordableQuantity(
              line.countedQuantity,
              'countedQuantity',
              sku.uom,
              uomPrecision(sku.uom),
            ),
          );
        }

        // ── writes ────────────────────────────────────────────────────────
        // 1. Every named task line records its counted quantity (0 when the
        // operator explicitly entered 0).
        for (const [skuId, milli] of countedMilliBySku) {
          await tx
            .update(countTaskLines)
            .set({ countedQuantity: milli, updatedAt: nowIso() })
            .where(
              and(
                eq(countTaskLines.tenantId, command.tenantId),
                eq(countTaskLines.taskId, command.taskId),
                eq(countTaskLines.skuId, skuId),
              ),
            );
        }
        // 2. A SKU found in the bin beyond the task's lines: the line is
        // APPENDED with expectedQuantity 0 (the matrix's beyond-task arm);
        // counted == 0 records the line with no variance, counted > 0
        // variances against an expected of 0.
        const knownSkus = new Set(taskLines.map((line) => line.skuId));
        const beyondTask = command.lines.filter((line) => !knownSkus.has(line.skuId));
        if (beyondTask.length > 0) {
          await tx.insert(countTaskLines).values(
            beyondTask.map((line) => ({
              id: uuidv7(),
              tenantId: command.tenantId,
              taskId: command.taskId,
              skuId: line.skuId,
              expectedQuantity: 0,
              countedQuantity: countedMilliBySku.get(line.skuId) ?? 0,
            })),
          );
        }

        // 3. The variance rows — one `open` row per DIFFERING SKU, written
        // at submit; never a stock write, never a ledger event (5-3 inserts
        // and never touches a variance row afterwards). Story 5-4: the
        // tenant's variance-threshold policy is read ONCE and the threshold
        // is FROZEN onto every variance row the policy covers (the
        // `threshold_quantity_at_request` precedent — a later policy PUT
        // cannot re-write what the submit compared against), and a variance
        // whose |delta| is strictly over the frozen threshold appends the
        // owner-notification outbox event. No policy row (or a null
        // threshold on one) = disabled: no stamp, no event.
        const expectedBySku = new Map(taskLines.map((line) => [line.skuId, line.expectedQuantity]));
        const varianceInputs = command.lines
          .map((line) => {
            const counted = countedMilliBySku.get(line.skuId)!;
            const expected = expectedBySku.get(line.skuId) ?? 0;
            return { skuId: line.skuId, counted, expected, delta: counted - expected };
          })
          .filter((input) => input.counted !== input.expected);
        const policyRows =
          varianceInputs.length > 0
            ? await tx
                .select()
                .from(countVariancePolicies)
                .where(eq(countVariancePolicies.tenantId, command.tenantId))
                .limit(1)
            : [];
        const thresholdMilli = policyRows[0]?.quantityThresholdMilli ?? null;
        const varianceRows = varianceInputs.map((input) => ({
          id: uuidv7(),
          tenantId: command.tenantId,
          taskId: command.taskId,
          warehouseId: task.warehouseId,
          binId: task.binId,
          skuId: input.skuId,
          expectedQuantity: input.expected,
          countedQuantity: input.counted,
          deltaMilli: input.counted - input.expected,
          epochConflict,
          status: 'open',
          thresholdQuantityMilli: thresholdMilli,
        }));
        if (varianceRows.length > 0) {
          await tx.insert(countVariances).values(varianceRows);
          // One owner-notification event per OVER-THRESHOLD variance — the
          // 5-2 per-pend event shape (notifyRole owner; Epic 9 owns delivery).
          if (thresholdMilli !== null) {
            for (const row of varianceRows) {
              if (Math.abs(row.deltaMilli) > thresholdMilli) {
                await this.outbox.append(tx, {
                  messageId: uuidv7(),
                  tenantId: command.tenantId,
                  type: 'count.variance.threshold_exceeded',
                  occurredAt,
                  payload: {
                    varianceId: row.id,
                    taskId: command.taskId,
                    warehouseId: task.warehouseId,
                    binId: task.binId,
                    skuId: row.skuId,
                    delta: fromMilli(row.deltaMilli),
                    thresholdQuantity: fromMilli(thresholdMilli),
                    notifyRole: 'owner',
                  },
                });
              }
            }
          }
        }

        // 4. The task settles — the row is locked, so the conditional
        // UPDATE's rowcount guard is a belt-and-braces backstop.
        const completedAt = nowIso();
        const settled = await tx
          .update(countTasks)
          .set({
            status: 'completed',
            completedBy: command.actorUserId,
            completedAt,
            updatedAt: completedAt,
          })
          .where(
            and(
              eq(countTasks.tenantId, command.tenantId),
              eq(countTasks.id, command.taskId),
              eq(countTasks.status, 'pending'),
            ),
          )
          .returning();
        if (settled[0] === undefined) {
          throw countWrongState('completed');
        }

        // 5. The OQ-2 recount: on an epoch mismatch, a FRESH task for the
        // same bin in the same transaction (AD-14 case-3 re-plan shape),
        // bounded by the same open-task-per-bin rule — the old task settled
        // in step 4, so none is pending. Its expectations are the bin's
        // CURRENT on-hand and its epoch the LIVE one, both read under the
        // locks.
        let recountTaskId: string | null = null;
        if (epochConflict) {
          recountTaskId = await this.createRecountTaskInTx(
            tx,
            command.tenantId,
            task,
            occurredAt,
          );
        }

        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'count.completed',
          occurredAt,
          payload: {
            taskId: command.taskId,
            binId: task.binId,
            warehouseId: task.warehouseId,
            epochConflict,
            varianceCount: varianceInputs.length,
            recountTaskId,
          },
        });

        const snapshot: SubmitCountSnapshot = {
          countTask: {
            id: command.taskId,
            status: 'completed',
            warehouseId: task.warehouseId,
            binId: task.binId,
            completedAt,
            epochConflict,
          },
          variances: varianceInputs.map((input) => ({
            skuId: input.skuId,
            expectedQuantity: fromMilli(input.expected),
            countedQuantity: fromMilli(input.counted),
            delta: fromMilli(input.counted - input.expected),
            epochConflict,
          })),
          recountTaskId,
        };

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snapshot,
          });
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
        return { snapshot, replayed: false };
      },
    );

    return { snapshot, replayed };
  }

  // ── resolveCountVariance (story 5-4, variances.resolve) ─────────────────

  /**
   * The resolve fingerprint. The consulted seqs normalise (deduped, sorted)
   * before hashing — a retry that lists the same events in a different
   * order replays rather than 422s (the fingerprint must not make a retry
   * look different).
   */
  resolveCountVarianceFingerprint(command: ResolveCountVarianceCommand): string {
    return hashCommandPayload({
      varianceId: command.varianceId,
      decision: command.decision,
      occurredAt: command.occurredAt,
      consideredEventSeqs: normalizeConsideredSeqs(command.consideredEventSeqs ?? []),
    });
  }

  /**
   * Resolve one open count variance (story 5-4, `variances.resolve` — owner
   * + Ops Manager; over-threshold resolves owner-only via the
   * frozen-threshold guard, not the capability).
   *
   * Two arms:
   * - **approve_adjust** — the explicit stock correction: the variance's
   *   counted−expected delta applies to the bin as `stock.adjusted` ledger
   *   events, executed through `assertAdjustableInTx` + `applyAdjustmentInTx`
   *   (the 5-2 approve-arm shape, riding the inventory facade). Requires the
   *   task's FROZEN `binStateEpoch` to still EQUAL the bin's live epoch
   *   (null matches null) — a moved basis means recount, not adjust (409
   *   `variance-basis-moved`).
   * - **recount** — the remedy: a fresh recount task (5-3's
   *   `createRecountTaskInTx`) whose snapshot becomes the variance's new
   *   expected basis; the delta is recomputed in the same terminal UPDATE
   *   (0 when the bin's on-hand is empty and the task's line is absent).
   *
   * Command order (the 5-2 decide shape, order-for-order): capability →
   * idempotency → variance lock `.for('update')` → 404 → 409
   * `variance-resolved` → owner check → the consulted-seqs probe (a stale
   * seq refuses BEFORE any write) → locks (bin row → warehouse advisory
   * LAST) → the epoch-equality guard (approve arm) → the arm → conditional
   * terminal UPDATE `.where(status = 'open')` → audit row + outbox
   * `count.variance.resolved` → idempotency LAST.
   *
   * The approve arm's refusals (bin retired, insufficient on-hand inside the
   * apply, a kit SKU) roll the whole transaction back — the variance STAYS
   * open, the caller gets the guard's 4xx verbatim (the recount arm is the
   * remedy for each, mirroring 5-2's "the Owner may reject instead").
   */
  async resolveCountVariance(
    command: ResolveCountVarianceCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: ResolveCountVarianceSnapshot; replayed: boolean }> {
    // Shape checks above the transaction: business time, the decision
    // vocabulary, and the consulted seqs' set shape (the per-seq checks live
    // in the wire DTO; the command checks max-count + the approve arm's
    // non-empty requirement — an explicit stock correction that consulted no
    // history is exactly the silent write-off the epic forbids).
    let occurredAt: string;
    if (command.occurredAt === undefined) {
      occurredAt = nowIso();
    } else {
      try {
        occurredAt = assertUtcIso(command.occurredAt);
      } catch {
        throw new ProblemException(
          'validation-failed',
          400,
          'occurredAt must be a valid ISO-8601 UTC instant',
          `occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${command.occurredAt}").`,
        );
      }
    }
    if (command.decision !== 'approve_adjust' && command.decision !== 'recount') {
      throw new ProblemException(
        'validation-failed',
        400,
        'Unknown resolution decision',
        `decision must be "approve_adjust" or "recount" (got "${String(command.decision)}").`,
      );
    }
    const statedSeqs = normalizeConsideredSeqs(command.consideredEventSeqs ?? []);
    if (statedSeqs.length > CONSIDERED_SEQS_MAX) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Too many considered ledger seqs',
        `consideredEventSeqs carries ${statedSeqs.length} seqs — at most ${CONSIDERED_SEQS_MAX} per resolution.`,
      );
    }
    if (command.decision === 'approve_adjust' && statedSeqs.length === 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'The resolution must state the ledger events it consulted',
        'An approve_adjust resolution must carry at least one consideredEventSeq — the bin ledger seq the approver considered before signing the correction. The recount arm may state none.',
      );
    }

    const payloadHash = this.resolveCountVarianceFingerprint(command);

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry — DB role read, same tx, BEFORE
        // the replay lookup (the deliberate fail-closed carve-out).
        const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
        assertPermission(role, 'variances.resolve');

        const existing = await this.lookupIdempotencyKey(tx, command.tenantId, idempotencyKey);
        if (existing !== undefined) {
          if (existing.payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing.responseSnapshot as ResolveCountVarianceSnapshot,
            replayed: true,
          };
        }

        // The variance row, LOCKED — the state machine's mutex (404 when
        // foreign). First lock of this command; the bin row and the
        // warehouse advisory follow.
        const varianceRows = await tx
          .select()
          .from(countVariances)
          .where(
            and(eq(countVariances.tenantId, command.tenantId), eq(countVariances.id, command.varianceId)),
          )
          .limit(1)
          .for('update');
        const variance = varianceRows[0];
        if (variance === undefined) {
          throw new ProblemException(
            'not-found',
            404,
            'Count variance not found',
            `No count variance with id "${command.varianceId}" exists in this tenant.`,
          );
        }
        if (variance.status !== 'open') {
          throw varianceResolved(variance.status, variance.id);
        }

        // The frozen-threshold guard: the variance's OWN submit-time stamp
        // decides, not today's policy — a later policy PUT cannot un-stamp
        // (or re-threshold) the variance.
        if (
          variance.thresholdQuantityMilli !== null &&
          Math.abs(variance.deltaMilli) > variance.thresholdQuantityMilli &&
          role !== 'owner'
        ) {
          throw varianceOwnerRequired(variance.id);
        }

        // The consulted-seqs probe: every stated seq must be ledger events
        // this warehouse actually wrote — refused BEFORE any write (the
        // matrix's stale-seqs arm; warehouse-scoped because the resolution
        // consults the bin's history, and the bin lives in this warehouse).
        if (statedSeqs.length > 0) {
          await assertWarehouseInTenant(tx, command.tenantId, variance.warehouseId);
          const found = await this.inventory.ledgerSeqsExistInTx(
            tx,
            command.tenantId,
            variance.warehouseId,
            statedSeqs,
          );
          const missing = statedSeqs.filter((seq) => !found.has(seq));
          if (missing.length > 0) {
            throw new ProblemException(
              'validation-failed',
              400,
              'The consulted ledger seqs are not in the warehouse ledger',
              `consideredEventSeqs names seq(s) ${missing.join(', ')} that this warehouse's ledger never wrote — state only seqs from the (tenant, warehouse) ledger timeline.`,
            );
          }
        }

        // The task row — the approve arm's frozen epoch rides it. NO lock:
        // the task is terminal (settled at submit) and immutable; the epoch
        // compare below runs under the bin locks.
        const taskRows = await tx
          .select()
          .from(countTasks)
          .where(and(eq(countTasks.tenantId, command.tenantId), eq(countTasks.id, variance.taskId)))
          .limit(1);
        const task = taskRows[0];
        if (task === undefined) {
          throw new ProblemException(
            'not-found',
            404,
            'Count task not found',
            'The variance\'s count task no longer exists in this tenant.',
          );
        }

        // Locks, in the codebase's canonical acyclic order: the bin row,
        // then the warehouse advisory LAST. Both arms run under them — the
        // approve arm's epoch compare must not race an epoch-bumping write,
        // and the recount arm's expectation capture (inside
        // `createRecountTaskInTx`) reads under the locks like every other
        // onHandInBinInTx call.
        const binRows = await tx
          .select({ id: bins.id, code: bins.code })
          .from(bins)
          .where(
            and(
              eq(bins.tenantId, command.tenantId),
              eq(bins.warehouseId, variance.warehouseId),
              eq(bins.id, variance.binId),
            ),
          )
          .limit(1)
          .for('update');
        const bin = binRows[0];
        if (bin === undefined) {
          throw new ProblemException(
            'not-found',
            404,
            'Bin not found',
            "The count variance's bin no longer exists in this tenant.",
          );
        }
        await this.inventory.lockWarehouseInTx(tx, command.tenantId, variance.warehouseId);

        const resolvedAt = nowIso();
        let stockCorrection: ResolveCountVarianceSnapshot['stockCorrection'] = null;
        let recountTaskId: string | null = null;
        let finalExpected = variance.expectedQuantity;
        let finalDelta = variance.deltaMilli;

        if (command.decision === 'approve_adjust') {
          // The epoch-equality guard: the task's FROZEN bin state must still
          // EQUAL the live epoch read UNDER the locks — `null` matches null
          // (movements gotcha 2: read → lock → compare; the submit's
          // EQUALITY discipline, re-asked at resolution time). `epochConflict`
          // variances resolve approve-adjust only after the epochs
          // re-equalize.
          const epochs = await this.inventory.binStateEpochsInTx(
            tx,
            command.tenantId,
            variance.warehouseId,
            [variance.binId],
          );
          const liveEpoch = epochs.get(variance.binId) ?? null;
          if (liveEpoch !== task.binStateEpoch) {
            throw varianceBasisMoved(variance.id, task.binStateEpoch);
          }
          // The correction: the same internals the immediate adjustment and
          // the 5-2 approval re-execution run — the guard set first (refuses
          // BIN 404 / kit / catch-weight / batch-parity 400s BEFORE any
          // write), then the apply (whose write-side refusals roll the whole
          // transaction back). A variance carries no batch/serial identity —
          // a batch- or serial-tracked SKU's variance cannot build a legal
          // correction and answers those refusals (recount is the remedy).
          const rebuilt: AdjustStockCommand = {
            tenantId: command.tenantId,
            actorUserId: command.actorUserId,
            warehouseId: variance.warehouseId,
            skuId: variance.skuId,
            binId: variance.binId,
            // `fromMilli` of the stored delta round-trips exactly (AD-9).
            quantityDelta: fromMilli(variance.deltaMilli),
            reasonCode: 'stock-count',
            note: `count variance ${variance.id} resolution — count task ${variance.taskId}`,
            // The correction's business time is the DECISION time (the
            // 5-2 approved-events discipline).
            occurredAt: resolvedAt,
          };
          await this.inventory.assertAdjustableInTx(tx, rebuilt);
          const applied = await this.inventory.applyAdjustmentInTx(
            tx,
            rebuilt,
            variance.deltaMilli as SignedQuantity,
            [],
            resolvedAt,
          );
          stockCorrection = {
            eventId: applied.firstEventId,
            seq: applied.snapshot.event.seq,
            onHand: {
              skuId: applied.snapshot.onHand.skuId,
              binId: applied.snapshot.onHand.binId,
              quantity: applied.snapshot.onHand.quantity,
            },
          };
        } else {
          // The recount arm — the remedy. One open task per bin STILL
          // bounds the re-plan: a bin whose open task exists (the
          // epoch-mismatch's auto-recount, or any other pending count)
          // refuses until that task settles (the create's 409 arm, under
          // the locks).
          const openRows = await tx
            .select({ id: countTasks.id })
            .from(countTasks)
            .where(
              and(
                eq(countTasks.tenantId, command.tenantId),
                eq(countTasks.warehouseId, variance.warehouseId),
                eq(countTasks.binId, variance.binId),
                eq(countTasks.status, 'pending'),
              ),
            )
            .limit(1);
          if (openRows[0] !== undefined) {
            throw countTaskOpen(bin.code);
          }
          const mintedTaskId = await this.createRecountTaskInTx(
            tx,
            command.tenantId,
            task,
            occurredAt,
          );
          recountTaskId = mintedTaskId;
          // The recounted variance's expected basis becomes the recount
          // snapshot's line expectation — 0 when the bin's on-hand is empty
          // and the line is absent. The delta is recomputed in the same
          // UPDATE below (the 0045 `delta_milli` CHECK re-holds).
          const lineRows = await tx
            .select({ expectedQuantity: countTaskLines.expectedQuantity })
            .from(countTaskLines)
            .where(
              and(
                eq(countTaskLines.tenantId, command.tenantId),
                eq(countTaskLines.taskId, mintedTaskId),
                eq(countTaskLines.skuId, variance.skuId),
              ),
            )
            .limit(1);
          finalExpected = lineRows[0]?.expectedQuantity ?? 0;
          finalDelta = variance.countedQuantity - finalExpected;
        }

        const status = command.decision === 'approve_adjust' ? 'adjusted' : 'recounted';
        // The terminal transition is CONDITIONAL (the 5-2 decide shape's
        // belt to the locked read's braces).
        const resolved = await tx
          .update(countVariances)
          .set({
            status,
            // The recount arm rewrites the basis in the SAME UPDATE — the
            // row's counted value never changes, only what it was counted
            // against.
            expectedQuantity: finalExpected,
            deltaMilli: finalDelta,
            resolvedBy: command.actorUserId,
            resolvedAt,
            recountTaskId,
            consideredEventSeqs: statedSeqs.length > 0 ? statedSeqs : null,
            updatedAt: resolvedAt,
          })
          .where(
            and(
              eq(countVariances.tenantId, command.tenantId),
              eq(countVariances.id, variance.id),
              eq(countVariances.status, 'open'),
            ),
          )
          .returning();
        if (resolved[0] === undefined) {
          throw varianceResolved(status, variance.id);
        }

        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'count.variance.resolved',
          targetType: 'count_variance',
          targetId: variance.id,
          reference: idempotencyKey,
          occurredAt: resolvedAt,
        });

        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'count.variance.resolved',
          occurredAt: resolvedAt,
          payload: {
            varianceId: variance.id,
            taskId: variance.taskId,
            warehouseId: variance.warehouseId,
            binId: variance.binId,
            skuId: variance.skuId,
            decision: command.decision,
            status,
            expectedQuantity: fromMilli(finalExpected),
            countedQuantity: fromMilli(variance.countedQuantity),
            delta: fromMilli(finalDelta),
            thresholdQuantity:
              variance.thresholdQuantityMilli === null
                ? null
                : fromMilli(variance.thresholdQuantityMilli),
            // The row's contract, echoed: null when the resolution stated
            // nothing (no-statement recount), not an empty array.
            consideredEventSeqs: statedSeqs.length > 0 ? statedSeqs : null,
            resolvedBy: command.actorUserId,
            resolvedAt,
            recountTaskId,
          },
        });

        const snapshot: ResolveCountVarianceSnapshot = {
          variance: varianceEntry(resolved[0]),
          stockCorrection,
        };

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snapshot,
          });
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
        return { snapshot, replayed: false };
      },
    );

    return { snapshot, replayed };
  }

  // ── upsertCountPolicies (counts.manage) ─────────────────────────────────

  /** The policy fingerprint (fixed key order). */
  policiesFingerprint(command: UpsertCountPoliciesCommand): string {
    return hashCommandPayload({
      warehouseId: command.warehouseId,
      occurredAt: command.occurredAt,
      policies: command.policies.map((policy) => ({
        abcClass: policy.abcClass,
        intervalDays: policy.intervalDays,
      })),
    });
  }

  /**
   * PUT the warehouse's policy rows: one row per (tenant, warehouse, class),
   * upserting each named row in place. NOT a single `ON CONFLICT DO
   * UPDATE` — the matrix pins a 409 on the unique-violation race loser (a
   * concurrent first write of the same key), so the write is
   * select-then-update / insert, with the loser answering 409 `conflict`
   * to retry.
   */
  async upsertCountPolicies(
    command: UpsertCountPoliciesCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: CountPoliciesSnapshot; replayed: boolean }> {
    let occurredAt: string;
    if (command.occurredAt === undefined) {
      occurredAt = nowIso();
    } else {
      try {
        occurredAt = assertUtcIso(command.occurredAt);
      } catch {
        throw new ProblemException(
          'validation-failed',
          400,
          'occurredAt must be a valid ISO-8601 UTC instant',
          `occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${command.occurredAt}").`,
        );
      }
    }

    const payloadHash = this.policiesFingerprint(command);

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'counts.manage',
        );

        const existing = await this.lookupIdempotencyKey(tx, command.tenantId, idempotencyKey);
        if (existing !== undefined) {
          if (existing.payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing.responseSnapshot as CountPoliciesSnapshot,
            replayed: true,
          };
        }

        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

        // The same tenant-scoped warehouse advisory lock the count commands
        // take: a policy write serializes against in-flight count commands
        // and scheduler ticks for this warehouse, so the schedule a tick
        // just read cannot flip underneath it while it runs (the interval
        // facts a tick's write acts on are the ones it read).
        await this.inventory.lockWarehouseInTx(tx, command.tenantId, command.warehouseId);

        for (const policy of command.policies) {
          const updatedRows = await tx
            .update(countPolicies)
            .set({ intervalDays: policy.intervalDays, updatedAt: nowIso() })
            .where(
              and(
                eq(countPolicies.tenantId, command.tenantId),
                eq(countPolicies.warehouseId, command.warehouseId),
                eq(countPolicies.abcClass, policy.abcClass),
              ),
            )
            .returning();
          if (updatedRows[0] !== undefined) {
            continue;
          }
          try {
            await tx.insert(countPolicies).values({
              id: uuidv7(),
              tenantId: command.tenantId,
              warehouseId: command.warehouseId,
              abcClass: policy.abcClass,
              intervalDays: policy.intervalDays,
            });
          } catch (err) {
            if (isUniqueViolationOn(err, 'count_policies_tenant_wh_class_unique')) {
              // The race loser of two concurrent first writes — retry to
              // land on the winner's row (the matrix's 409 arm).
              throw new ProblemException(
                'conflict',
                409,
                'Concurrent policy write',
                'A concurrent request is writing this policy; retry to read the settled result.',
              );
            }
            throw err;
          }
        }

        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'count.policy_updated',
          occurredAt,
          payload: {
            warehouseId: command.warehouseId,
            policyCount: command.policies.length,
          },
        });

        const rows = await tx
          .select({ abcClass: countPolicies.abcClass, intervalDays: countPolicies.intervalDays })
          .from(countPolicies)
          .where(
            and(
              eq(countPolicies.tenantId, command.tenantId),
              eq(countPolicies.warehouseId, command.warehouseId),
            ),
          )
          .orderBy(asc(countPolicies.abcClass));
        const snapshot: CountPoliciesSnapshot = {
          policies: rows.map((row) => ({ abcClass: row.abcClass, intervalDays: row.intervalDays })),
        };

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snapshot,
          });
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
        return { snapshot, replayed: false };
      },
    );

    return { snapshot, replayed };
  }

  // ── scheduled generation (the CountSchedulerWorker's entry) ─────────────

  /**
   * Generate the due count tasks for ONE warehouse in one tenant
   * transaction — all-or-nothing per warehouse (the matrix's "partial
   * failure → whole tick rolls back, retried next interval": a cross-tenant
   * single transaction cannot exist under the RLS spine, so the tick's
   * atomicity unit is the warehouse batch). Direct domain writes + outbox
   * events (the reaper precedent — no HTTP command layer, no idempotency
   * key: the tick is not a client request). The bins-row locks are taken in
   * sorted-uuid order and the warehouse advisory lock AFTER them (the
   * canonical order); the per-bin expected + epoch captures sit UNDER the
   * locks.
   *
   * DUE means: the bin holds at least one SKU of a policy's class (an EMPTY
   * bin is never scheduled — nothing to count; on-demand still covers it),
   * no `pending` task exists, and the latest completed count for the bin is
   * older than the interval (never-counted bins are due immediately; a bin
   * counted within ANY of its classes' intervals is skipped). A bin whose
   * SKUs are all class-less never matches a policy (`null` `abc_class` is
   * excluded from scheduled generation, OQ-1 — on-demand still covers it).
   *
   * Returns the minted task ids.
   */
  async generateScheduledTasksInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    maxTasks: number,
  ): Promise<string[]> {
    // The per-class candidate scan — a PRE-LOCK read: the policy rows are
    // NOT re-checked under the locks. Policy writes serialize on the same
    // warehouse advisory lock this tick takes below (the upsert takes it
    // too), so a flip mid-cycle lands before or after the whole tick, never
    // inside it. What the write RE-CHECKS under the locks is the due-bin
    // facts: the open-task fact, the last-counted fact, and a bin emptied
    // between the scan and the locks is skipped at its arms read. One query
    // per policy class — the class filter cannot ride one join for several
    // classes without a class→bin fan-out map.
    const policyRows = await tx
      .select({ abcClass: countPolicies.abcClass, intervalDays: countPolicies.intervalDays })
      .from(countPolicies)
      .where(and(eq(countPolicies.tenantId, tenantId), eq(countPolicies.warehouseId, warehouseId)))
      .orderBy(asc(countPolicies.abcClass));
    if (policyRows.length === 0) {
      return [];
    }

    // The per-bin EFFECTIVE interval: the shortest interval among the
    // classes the bin's stock matches (a bin is counted once, so the
    // tightest policy governs it). The stock read goes through the
    // inventory facade — inventory owns the projection; movements never
    // projects stock tables directly (the review's seam fix).
    const candidateBins = new Map<string, number>();
    for (const policy of policyRows) {
      const holderBinIds = await this.inventory.stockedBinIdsForAbcClassInTx(
        tx,
        tenantId,
        warehouseId,
        policy.abcClass,
      );
      for (const binId of holderBinIds) {
        const current = candidateBins.get(binId);
        if (current === undefined || policy.intervalDays < current) {
          candidateBins.set(binId, policy.intervalDays);
        }
      }
    }
    if (candidateBins.size === 0) {
      return [];
    }

    // Bins with an OPEN task are never due (the one-open-task-per-bin
    // rule); bins whose latest completed count landed within their
    // effective interval are not due yet.
    const openRows = await tx
      .select({ binId: countTasks.binId })
      .from(countTasks)
      .where(
        and(
          eq(countTasks.tenantId, tenantId),
          eq(countTasks.warehouseId, warehouseId),
          eq(countTasks.status, 'pending'),
        ),
      );
    const openBins = new Set(openRows.map((row) => row.binId));
    const lastRows = await tx
      .select({
        binId: countTasks.binId,
        completedAt: sql<string | null>`max(${countTasks.completedAt})`,
      })
      .from(countTasks)
      .where(
        and(
          eq(countTasks.tenantId, tenantId),
          eq(countTasks.warehouseId, warehouseId),
          eq(countTasks.status, 'completed'),
        ),
      )
      .groupBy(countTasks.binId);
    const lastCounted = new Map(lastRows.map((row) => [row.binId, row.completedAt]));

    const now = Date.now();
    const dueBinIds = [...candidateBins.keys()]
      .filter((binId) => {
        if (openBins.has(binId)) {
          return false;
        }
        const last = lastCounted.get(binId);
        if (last === null || last === undefined) {
          return true; // never counted — due
        }
        const intervalMs = (candidateBins.get(binId) ?? 0) * 86_400_000;
        return new Date(last).getTime() < now - intervalMs;
      })
      .sort()
      .slice(0, maxTasks);
    if (dueBinIds.length === 0) {
      return [];
    }

    // The bin rows, LOCKED in sorted-uuid order (the canonical chain's
    // head), then the warehouse advisory LAST. Everything below runs UNDER
    // the locks — including the open-task and last-counted re-checks (a
    // task a concurrent on-demand create minted, or a count a concurrent
    // submit completed, between the due query and the locks would otherwise
    // double-open or re-count a bin inside its interval).
    const binRows = await tx
      .select({ id: bins.id, systemOwned: bins.systemOwned })
      .from(bins)
      .where(
        and(eq(bins.tenantId, tenantId), eq(bins.warehouseId, warehouseId), inArray(bins.id, dueBinIds)),
      )
      .orderBy(asc(bins.id))
      .for('update');
    // FROZEN AMENDMENT (story 5-3, user-ratified 2026-09-28): a system-owned
    // bin never receives a scheduled task. The candidate scan reads the
    // stock projection, and system bins (Receiving/QC-hold/In-Transit) HOLD
    // classed SKUs' on-hand rows — without this filter every tick would
    // mint a recurring count task for a bin whose own commands are mid-way
    // through moving that stock. Post-filtered on the rows already read.
    const storageBinRows = binRows.filter((binRow) => !binRow.systemOwned);
    await this.inventory.lockWarehouseInTx(tx, tenantId, warehouseId);

    const recheckOpen = await tx
      .select({ binId: countTasks.binId })
      .from(countTasks)
      .where(
        and(
          eq(countTasks.tenantId, tenantId),
          eq(countTasks.warehouseId, warehouseId),
          eq(countTasks.status, 'pending'),
        ),
      );
    const openUnderLock = new Set(recheckOpen.map((row) => row.binId));
    const recheckLast = await tx
      .select({
        binId: countTasks.binId,
        completedAt: sql<string | null>`max(${countTasks.completedAt})`,
      })
      .from(countTasks)
      .where(
        and(
          eq(countTasks.tenantId, tenantId),
          eq(countTasks.warehouseId, warehouseId),
          eq(countTasks.status, 'completed'),
        ),
      )
      .groupBy(countTasks.binId);
    const lastUnderLock = new Map(recheckLast.map((row) => [row.binId, row.completedAt]));

    // The candidates' per-bin on-hand, one batched read through the
    // inventory facade (inventory owns the projection; the same facade read
    // a per-bin query inside the loop would turn into N round-trips) — the
    // per-bin fan-out composes below. The facade returns POSITIVE rows
    // only, binId-then-skuId ordered.
    const onHandRows = await this.inventory.stockArmsInBinsInTx(tx, tenantId, warehouseId, dueBinIds);
    const onHandByBin = new Map<string, { skuId: string; quantity: number }[]>();
    for (const row of onHandRows) {
      const list = onHandByBin.get(row.binId) ?? [];
      list.push({ skuId: row.skuId, quantity: row.quantity });
      onHandByBin.set(row.binId, list);
    }
    // The batch's epochs, read UNDER the locks (the pick precedent — the
    // epoch the task freezes is the one consistent read with its expected
    // quantities).
    const epochs =
      dueBinIds.length === 0
        ? new Map<string, number>()
        : await this.inventory.binStateEpochsInTx(tx, tenantId, warehouseId, dueBinIds);

    const createdIds: string[] = [];
    for (const binRow of storageBinRows) {
      const binId = binRow.id;
      if (openUnderLock.has(binId)) {
        continue; // a concurrent create got here first — the rule holds
      }
      const last = lastUnderLock.get(binId);
      if (last !== null && last !== undefined) {
        const intervalMs = (candidateBins.get(binId) ?? 0) * 86_400_000;
        if (new Date(last).getTime() >= now - intervalMs) {
          continue; // counted within its interval during our own lock wait
        }
      }
      const arms = onHandByBin.get(binId) ?? [];
      if (arms.length === 0) {
        continue; // emptied between the candidate scan and the locks
      }

      const taskId = uuidv7();
      await tx.insert(countTasks).values({
        id: taskId,
        tenantId,
        warehouseId,
        binId,
        status: 'pending',
        origin: 'scheduled',
        binStateEpoch: epochs.get(binId) ?? null,
        createdBy: null, // the scheduler — no system-actor uuid exists (AD-5 note in the schema)
      });
      const lineValues = arms.map((arm) => ({
        id: uuidv7(),
        tenantId,
        taskId,
        skuId: arm.skuId,
        expectedQuantity: arm.quantity,
      }));
      await tx.insert(countTaskLines).values(lineValues);

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId,
        type: 'count.created',
        occurredAt: nowIso(),
        payload: {
          taskId,
          binId,
          warehouseId,
          origin: 'scheduled',
        },
      });
      createdIds.push(taskId);
    }
    return createdIds;
  }

  // ── shared in-tx helpers ─────────────────────────────────────────────────

  private async lookupIdempotencyKey(tx: TenantTx, tenantId: string, key: string) {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
      .limit(1);
    return rows[0];
  }

  /** The task row, LOCKED — the state machine's mutex (404 when foreign). */
  private async lockTaskInTx(tx: TenantTx, tenantId: string, taskId: string): Promise<CountTask> {
    const rows = await tx
      .select()
      .from(countTasks)
      .where(and(eq(countTasks.tenantId, tenantId), eq(countTasks.id, taskId)))
      .limit(1)
      .for('update');
    const task = rows[0];
    if (task === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'Count task not found',
        'No count task with this id exists in this tenant.',
      );
    }
    return task;
  }

  /**
   * The OQ-2 recount: a fresh task for the same bin (origin `recount`), its
   * expectations the bin's CURRENT on-hand and its epoch the LIVE one —
   * both read under the locks the caller holds. `createdBy` is null (the
   * system re-planned; the submit's actor is recorded on the completed task
   * and in the variance rows). Bounded by the open-task-per-bin rule: the
   * caller settles the old task BEFORE calling, in the same transaction.
   */
  private async createRecountTaskInTx(
    tx: TenantTx,
    tenantId: string,
    completedTask: CountTask,
    occurredAt: string,
  ): Promise<string> {
    const expected = await this.inventory.onHandInBinInTx(
      tx,
      tenantId,
      completedTask.warehouseId,
      completedTask.binId,
    );
    const epochs = await this.inventory.binStateEpochsInTx(
      tx,
      tenantId,
      completedTask.warehouseId,
      [completedTask.binId],
    );
    const epoch = epochs.get(completedTask.binId) ?? null;

    const taskId = uuidv7();
    await tx.insert(countTasks).values({
      id: taskId,
      tenantId,
      warehouseId: completedTask.warehouseId,
      binId: completedTask.binId,
      status: 'pending',
      origin: 'recount',
      binStateEpoch: epoch,
      createdBy: null,
    });
    const lineValues = expected
      .filter((arm) => arm.quantity !== 0)
      .map((arm) => ({
        id: uuidv7(),
        tenantId,
        taskId,
        skuId: arm.skuId,
        expectedQuantity: arm.quantity,
      }));
    if (lineValues.length > 0) {
      await tx.insert(countTaskLines).values(lineValues);
    }

    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type: 'count.created',
      occurredAt,
      payload: {
        taskId,
        binId: completedTask.binId,
        warehouseId: completedTask.warehouseId,
        origin: 'recount',
        supersededTaskId: completedTask.id,
      },
    });
    return taskId;
  }

  /**
   * Story 5-6 — the AD-14 recount arm without a superseded task: the
   * `createRecountTaskInTx` core against a plain bin (the human-review
   * surface never had a prior count task; it re-plans from the bin's CURRENT
   * on-hand and live epoch — both read UNDER the locks the caller holds, the
   * OQ-2 capture's discipline). `createdBy` is null exactly as the OQ-2
   * arm's.
   *
   * The per-bin open-task rule re-holds here (the create's 409 arm, under
   * the caller's locks): a bin with a pending count task refuses the mint —
   * the caller surfaces `count-task-open` verbatim and its row stays open.
   * The caller holds the locks (bin row `.for('update')` → warehouse
   * advisory LAST — the canonical order) and its own transaction; this
   * method only mints.
   */
  async mintRecountTaskForBinInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    binId: string,
    binCode: string,
    occurredAt: string,
  ): Promise<string> {
    const openRows = await tx
      .select({ id: countTasks.id })
      .from(countTasks)
      .where(
        and(
          eq(countTasks.tenantId, tenantId),
          eq(countTasks.warehouseId, warehouseId),
          eq(countTasks.binId, binId),
          eq(countTasks.status, 'pending'),
        ),
      )
      .limit(1);
    if (openRows[0] !== undefined) {
      throw countTaskOpen(binCode);
    }

    const expected = await this.inventory.onHandInBinInTx(tx, tenantId, warehouseId, binId);
    const epochs = await this.inventory.binStateEpochsInTx(tx, tenantId, warehouseId, [binId]);
    const epoch = epochs.get(binId) ?? null;

    const taskId = uuidv7();
    await tx.insert(countTasks).values({
      id: taskId,
      tenantId,
      warehouseId,
      binId,
      status: 'pending',
      origin: 'recount',
      binStateEpoch: epoch,
      createdBy: null,
    });
    const lineValues = expected
      .filter((arm) => arm.quantity !== 0)
      .map((arm) => ({
        id: uuidv7(),
        tenantId,
        taskId,
        skuId: arm.skuId,
        expectedQuantity: arm.quantity,
      }));
    if (lineValues.length > 0) {
      await tx.insert(countTaskLines).values(lineValues);
    }

    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type: 'count.created',
      occurredAt,
      payload: { taskId, binId, warehouseId, origin: 'recount' },
    });
    return taskId;
  }
}
