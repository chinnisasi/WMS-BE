import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AUTH_DATABASE, DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { inventoryQuarantines, ledgerEvents, reconciliationCheckpoints } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { nowIso } from '../../shared/primitives/time';
import { uuidv7 } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { replayInTx, reconcileScanInTx, rebuildProjectionsInTx, warehouseAdvisoryLock } from './ledger.service';
import type { ReplayDivergence, RebuiltScope } from './ledger.service';

/**
 * The outbox event types Story 2.2 alerts through (ride the transactional
 * outbox like every other domain event — NOT ledger movements; the event
 * registry is untouched).
 */
export const RECONCILIATION_DIVERGENCE_EVENT = 'reconciliation.divergence';
export const RECONCILIATION_CHECKPOINT_INVALID_EVENT = 'reconciliation.checkpoint_invalid';

/** Consecutive checkpoint-validation failures before the checkpoint is discarded. */
export const CHECKPOINT_INVALID_LIMIT = 2;

/**
 * The default full-pass cadence (story 10.4): after this many BOUNDED passes
 * a partition runs one FULL pass (`replayInTx`), closing the bounded scan's
 * blind spot (a divergence on a scope untouched since the checkpoint). The
 * semantics are "N bounded passes between full passes", so 1 alternates — a
 * bounded pass increments the counter, a full pass resets it.
 */
export const DEFAULT_RECONCILE_FULL_PASS_EVERY = 20;

/**
 * The full-pass knob, `RECONCILE_FULL_PASS_EVERY` — parsed like the poll
 * intervals beside it (`parseReconcilePollMs`), except that UNSET means the
 * default cadence, not OFF: the scheduled full pass is part of the engine's
 * guarantee, so it is on unless a deployment tunes it. A non-positive value
 * or anything that is not an integer fails the boot loudly.
 *
 * **Why this helper lives here and not beside `parseReconcilePollMs` in
 * `src/jobs/jobs.module.ts`.** That file imports `InventoryModule`, which
 * imports this one — a back-import of the jobs shell from here is a module
 * cycle, and under this repo's CJS output it breaks the NestJS boot outright
 * (`Cannot access 'InvModule' before initialization`, verified). The knob is
 * still re-exported FROM the jobs shell beside `parseReconcilePollMs`, so the
 * worker's env-parse surface stays in one place; the service reads it in its
 * constructor — never module scope, so e2e suites can set the env per suite.
 */
export function parseReconcileFullPassEvery(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_RECONCILE_FULL_PASS_EVERY;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `RECONCILE_FULL_PASS_EVERY must be a positive integer — bounded passes per full pass (got "${raw}")`,
    );
  }
  return parsed;
}

/** A divergent scope flagged by the cycle, with its repeat classification. */
export interface FlaggedDivergence extends ReplayDivergence {
  readonly repeat: boolean;
}

/** One cycle's outcome, per the I/O matrix. */
export interface ReconcileReport {
  readonly tenantId: string;
  readonly warehouseId: string;
  /**
   * The ledger head read at cycle start, INSIDE the same consistent snapshot
   * the fold and compare run in — a movement committing mid-cycle has
   * seq > watermark, is not folded, and is never flagged (the next cycle's
   * problem).
   */
  readonly watermark: number;
  /** The checkpoint's `last_seq` at cycle start (null: no checkpoint yet). */
  readonly previousSeq: number | null;
  /** True on a clean pass: the checkpoint advanced to the watermark. */
  readonly advanced: boolean;
  /** True when the cycle skipped the pass: first consecutive invalid checkpoint. */
  readonly skipped: boolean;
  /** True when a twice-invalid checkpoint was discarded (full replay follows). */
  readonly checkpointDiscarded: boolean;
  readonly divergences: readonly FlaggedDivergence[];
  readonly repaired: readonly RebuiltScope[];
  /** Scopes newly quarantined by this cycle (repeated divergence). */
  readonly quarantined: readonly { skuId: string; binId: string }[];
}

interface CycleDetection {
  readonly watermark: number;
  readonly previousSeq: number | null;
  /** The window's lower bound this cycle compares across (0 = full pass). */
  readonly lastSeq: number;
  /** Story 10.4: the pass kind this cycle ran — the counter's write arm. */
  readonly fullPass: boolean;
  /** Story 10.4: the counter as the cycle STARTED with (bounded passes so far). */
  readonly incrementalCount: number;
  /** Story 10.4: the memory's entries may carry the batch arm's identity. */
  readonly lastDivergences: readonly { skuId: string; binId: string; batchRef?: string }[];
  readonly skipped: boolean;
  readonly checkpointDiscarded: boolean;
  readonly clean: boolean;
  readonly divergences: readonly ReplayDivergence[];
}

/**
 * The repeat-classification key (story 10.4, unchanged): `skuId:binId` ONLY.
 * `batchRef` never joins the key — a batch-arm divergence and a plain one on
 * the same (sku, bin) are the same scope's repeat, the (sku, bin) quarantine
 * fires exactly as it did before the batch identity was carried, and
 * pre-upgrade memory rows (no `batchRef`) classify exactly as they did.
 */
function divergenceScopeKey(divergence: { skuId: string; binId: string }): string {
  return `${divergence.skuId}:${divergence.binId}`;
}

function parseLastDivergences(
  raw: Record<string, unknown>[] | null,
): { skuId: string; binId: string; batchRef?: string }[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: { skuId: string; binId: string; batchRef?: string }[] = [];
  let dropped = 0;
  for (const entry of raw) {
    // The column is corruption-prone by definition (the checkpoint row is
    // the thing corruption probes target) — a null or primitive entry must
    // be skipped, never crashed on, and a dropped entry is itself a warning
    // (parity with the last_seq-corruption alert story).
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const skuId = typeof record['skuId'] === 'string' ? record['skuId'] : undefined;
    const binId = typeof record['binId'] === 'string' ? record['binId'] : undefined;
    if (skuId === undefined || binId === undefined) {
      dropped += 1;
      continue;
    }
    // Story 10.4: the batch arm's identity rides the memory as an OPTIONAL
    // key — pre-upgrade rows have none, and absence must classify (and
    // re-emit) exactly as it did before. (`exactOptionalPropertyTypes`: a
    // present `batchRef` is spread in, an absent one stays absent.)
    const batchRef = typeof record['batchRef'] === 'string' ? record['batchRef'] : undefined;
    entries.push(batchRef === undefined ? { skuId, binId } : { skuId, binId, batchRef });
  }
  if (dropped > 0) {
    new Logger('ReconciliationService').warn(
      `Reconciliation checkpoint last_divergences had ${dropped} malformed entr(y/ies) — dropped, not crashed on`,
    );
  }
  return entries;
}

/**
 * Continuous replay-reconciliation (Story 2.2): drives one (tenant, warehouse)
 * partition per cycle — validate the checkpoint, read the ledger head as the
 * watermark, replay-fold via `replayInTx`/`reconcileScanInTx`, handle
 * divergence (first offense: rebuild + alert; repeat within the window:
 * quarantine + re-alert), and advance the checkpoint only on a clean pass.
 *
 * Cycle shape (one shape, no alternatives):
 * - **Detection** — one tenant transaction pinned to `repeatable read` (the
 *   IN-08 consistent-snapshot read): checkpoint → watermark → fold → compare,
 *   all in one MVCC snapshot. The compare read takes no lock; a movement
   * committing mid-cycle is invisible to the whole snapshot (its projection
   * write and its event commit together), so it is the next cycle's problem —
 *   never a false positive. Clean → checkpoint advances (same transaction).
 * - **Repair** — a second transaction under the per-warehouse advisory xact
 *   lock the append path uses: re-folds fresh (read-committed, so anything
 *   that committed between the snapshot and this lock is included rather
 *   than clobbered), writes the replayed quantities, quarantines repeats,
   * and appends the `reconciliation.divergence` alert in the SAME transaction
 *   (alert + rebuild together; silence is never an outcome).
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger('ReconciliationService');

  /**
   * The full-pass cadence (bounded passes per full pass), read in the
   * constructor — never module scope, so a suite (or a deployment) can set
   * `RECONCILE_FULL_PASS_EVERY` per process.
   */
  private readonly fullPassEvery: number;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // The one cross-tenant read (partition discovery) runs on the BYPASSRLS
    // connection — the sanctioned second use, read-only, exactly like the
    // outbox relay's tenant discovery.
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {
    this.fullPassEvery = parseReconcileFullPassEvery(process.env.RECONCILE_FULL_PASS_EVERY);
  }

  /**
   * One reconciliation cycle for one (tenant, warehouse) partition.
   */
  async reconcile(tenantId: string, warehouseId: string): Promise<ReconcileReport> {
    const detection = await this.detect(tenantId, warehouseId);

    if (detection.skipped) {
      return {
        tenantId,
        warehouseId,
        watermark: detection.watermark,
        previousSeq: detection.previousSeq,
        advanced: false,
        skipped: true,
        checkpointDiscarded: false,
        divergences: [],
        repaired: [],
        quarantined: [],
      };
    }
    if (detection.clean) {
      return {
        tenantId,
        warehouseId,
        watermark: detection.watermark,
        previousSeq: detection.previousSeq,
        advanced: true,
        skipped: false,
        checkpointDiscarded: detection.checkpointDiscarded,
        divergences: [],
        repaired: [],
        quarantined: [],
      };
    }

    // Divergence handling. A scope flagged in the previous non-advanced pass
    // (the checkpoint still carries its flags) is a REPEAT within the window.
    const previous = new Set(detection.lastDivergences.map(divergenceScopeKey));
    const flagged: FlaggedDivergence[] = detection.divergences.map((divergence) => ({
      ...divergence,
      repeat: previous.has(divergenceScopeKey(divergence)),
    }));

    const repair = await withTenantTransaction(this.db, tenantId, async (tx) => {
      // Same lock as the append path: the rebuild's absolute write must not
      // clobber a concurrent increment — an append either committed before
      // this lock (and the fresh fold below includes it) or blocks until
      // after it.
      await tx.execute(warehouseAdvisoryLock(tenantId, warehouseId));

      // Repeated divergence: quarantine the scope (durable, one open row per
      // scope) before it is rebuilt again — 2.3's reservation path consumes
      // the flag.
      const quarantined: { skuId: string; binId: string }[] = [];
      for (const divergence of flagged.filter((entry) => entry.repeat)) {
        const inserted = await tx
          .insert(inventoryQuarantines)
          .values({
            id: uuidv7(),
            tenantId,
            warehouseId,
            skuId: divergence.skuId,
            binId: divergence.binId,
            fromSeq: divergence.fromSeq ?? 1,
            toSeq: divergence.toSeq ?? detection.watermark,
            reason: 'repeated-divergence',
            status: 'open',
          })
          // The partial unique index is the backstop: an open quarantine for
          // the scope already exists → this insert is a no-op.
          .onConflictDoNothing({
            target: [
              inventoryQuarantines.tenantId,
              inventoryQuarantines.warehouseId,
              inventoryQuarantines.skuId,
              inventoryQuarantines.binId,
            ],
            where: sql`status = 'open'`,
          })
          .returning({ skuId: inventoryQuarantines.skuId, binId: inventoryQuarantines.binId });
        if (inserted.length > 0) {
          quarantined.push({ skuId: divergence.skuId, binId: divergence.binId });
          this.logger.warn(
            `Reconciliation quarantined scope (repeated divergence): ` +
              `tenant=${tenantId} warehouse=${warehouseId} sku=${divergence.skuId} bin=${divergence.binId} ` +
              `seq=${divergence.fromSeq ?? 1}..${divergence.toSeq ?? detection.watermark}`,
          );
        }
      }

      // The rebuild: replay-proven scopes rewritten to the replayed
      // quantities under the lock (first offense AND repeat — the repeat is
      // additionally quarantined and the alert names it).
      const repaired = await rebuildProjectionsInTx(
        tx,
        tenantId,
        warehouseId,
        flagged.map((divergence) => ({ skuId: divergence.skuId, binId: divergence.binId })),
      );

      // ONE alert per cycle, naming the warehouse, every divergent scope
      // (projected vs replayed), its event range, and whether it is a repeat.
      // Story 10.4: a batch-arm divergence names its batch — optional key
      // (additive on the 10.1 payload contract; no consumer branches on
      // absence), so a (sku, bin, batch) imbalance is nameable without a
      // jsonb scan. The quarantine below stays (sku, bin)-keyed on purpose:
      // ATP fail-closure lives at the granularity ATP is granted, and
      // over-restricting a batch imbalance to the whole bin never
      // under-protects.
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId,
        type: RECONCILIATION_DIVERGENCE_EVENT,
        occurredAt: nowIso(),
        payload: {
          warehouseId,
          watermark: detection.watermark,
          divergences: flagged.map((divergence) => ({
            skuId: divergence.skuId,
            binId: divergence.binId,
            ...(divergence.batchRef !== undefined ? { batchRef: divergence.batchRef } : {}),
            // Story 10.1: base units on the way out (the outbox contract).
            projected:
              divergence.projectedQuantity === null ? null : fromMilli(divergence.projectedQuantity),
            replayed: fromMilli(divergence.replayedQuantity),
            fromSeq: divergence.fromSeq ?? 1,
            toSeq: divergence.toSeq ?? detection.watermark,
            repeat: divergence.repeat,
          })),
        },
      });

      // The window did NOT advance (only a clean pass advances): the flagged
      // scopes are recorded on the checkpoint so the NEXT cycle classifies a
      // still-divergent scope as a repeat. On conflict, only the divergence
      // memory (and the validation-failure streak, broken by this cycle's
      // VALID checkpoint validation) is written — never last_seq.
      //
      // Story 10.4: the memory may carry the batch arm's identity, and the
      // `incremental_count` follows the PASS KIND, regardless of which arm of
      // this upsert the write lands in — the same bounded/full rule the clean
      // advance applies (a bounded pass increments, a full pass resets).
      const lastDivergences = flagged.map((divergence) => ({
        skuId: divergence.skuId,
        binId: divergence.binId,
        ...(divergence.batchRef !== undefined ? { batchRef: divergence.batchRef } : {}),
      }));
      const incrementalCount = detection.fullPass ? 0 : detection.incrementalCount + 1;
      await tx
        .insert(reconciliationCheckpoints)
        .values({
          id: uuidv7(),
          tenantId,
          warehouseId,
          // The window base THIS cycle compared across — after a discard that
          // is 0 (the corrupt last_seq must not be written back); otherwise the
          // pre-cycle last_seq, unchanged.
          lastSeq: detection.lastSeq,
          invalidAttempts: 0,
          incrementalCount,
          lastDivergences,
        })
        .onConflictDoUpdate({
          target: [reconciliationCheckpoints.tenantId, reconciliationCheckpoints.warehouseId],
          set: { lastDivergences, invalidAttempts: 0, incrementalCount, updatedAt: nowIso() },
        });

      return { quarantined, repaired };
    });

    return {
      tenantId,
      warehouseId,
      watermark: detection.watermark,
      previousSeq: detection.previousSeq,
      advanced: false,
      skipped: false,
      checkpointDiscarded: detection.checkpointDiscarded,
      divergences: flagged,
      repaired: repair.repaired,
      quarantined: repair.quarantined,
    };
  }

  /**
   * The worker's entry: pick ONE partition oldest-checkpoint-first (among
   * partitions with pending work) and run one cycle. Returns null when every
   * partition is reconciled through its head (idle tick).
   */
  async reconcileNext(): Promise<ReconcileReport | null> {
    const partition = await this.pickPartition();
    if (partition === null) {
      return null;
    }
    try {
      return await this.reconcile(partition.tenantId, partition.warehouseId);
    } catch (error) {
      // A persistently failing cycle must not wedge its partition at the head
      // of the queue forever. Before story 10.4 the comment here treated "no
      // checkpoint row → nulls-first re-pick" as fairness — it is the
      // opposite: with ONE partition picked per tick, a persistently failing
      // never-checkpointed partition is picked EVERY tick, its failure stamp
      // (an UPDATE) matches no row, and the worker serves nothing else — the
      // bounded-scan escape hatch was unreachable behind it. So the failure
      // path first INSERTS an empty checkpoint row (`last_seq 0`,
      // `invalid_attempts 0`, `last_divergences null`) with ON CONFLICT DO
      // NOTHING — never an upsert: an upsert would wipe an EXISTING
      // checkpoint's `last_seq`/`last_divergences` (destroying the repeat
      // memory and silently curing a corrupt checkpoint, bypassing the ×2
      // discard and its `reconciliation.checkpoint_invalid` alert) — and then
      // stamps `updated_at`, converting the partition into an ordinary queue
      // member (oldest-`updated_at` first). `last_seq: 0` is detect's "no
      // checkpoint" state exactly (`lastSeq === 0 → full replay`), so the
      // row changes no cycle semantics; the stamp still touches only
      // `updated_at` — `last_seq`, `invalid_attempts` and `last_divergences`
      // remain cycle-written state, written only by a cycle.
      //
      // For failure classes that kill the tenant-scoped seam itself (RLS
      // role, connection loss) this insert and stamp fail too — logged and
      // retried next rotation; the wedge is then bounded by the same outage.
      try {
        await withTenantTransaction(this.db, partition.tenantId, async (tx) => {
          await tx
            .insert(reconciliationCheckpoints)
            .values({
              id: uuidv7(),
              tenantId: partition.tenantId,
              warehouseId: partition.warehouseId,
              lastSeq: 0,
              invalidAttempts: 0,
              incrementalCount: 0,
              lastDivergences: null,
            })
            .onConflictDoNothing({
              target: [
                reconciliationCheckpoints.tenantId,
                reconciliationCheckpoints.warehouseId,
              ],
            });
          await tx
            .update(reconciliationCheckpoints)
            .set({ updatedAt: nowIso() })
            .where(
              and(
                eq(reconciliationCheckpoints.tenantId, partition.tenantId),
                eq(reconciliationCheckpoints.warehouseId, partition.warehouseId),
              ),
            );
        });
      } catch (stampError) {
        this.logger.warn(
          `Reconciliation failure-requeue stamp failed: tenant=${partition.tenantId} ` +
            `warehouse=${partition.warehouseId} — ${stampError instanceof Error ? stampError.message : String(stampError)}`,
        );
      }
      throw error;
    }
  }

  /**
   * Partition discovery — the one deliberately cross-tenant read (BYPASSRLS
   * connection, read-only; the relay's tenant-discovery precedent): warehouses
   * with ledger events their checkpoint has not verified through, oldest
   * checkpoint first (a never-checkpointed partition sorts first), so no
   * partition starves. A checkpoint whose `last_seq` is BEYOND the ledger head
   * is equally pending — it has pending validation work (the ×2 discard path
   * is reachable via `reconcileNext`, not only via a direct `reconcile`).
   * One partition per tick.
   */
  private async pickPartition(): Promise<{ tenantId: string; warehouseId: string } | null> {
    const rows = (await this.authDb.execute(sql`
      with heads as (
        select tenant_id, warehouse_id, max(seq) as head_seq
        from ledger_events
        group by tenant_id, warehouse_id
      )
      select h.tenant_id as "tenantId", h.warehouse_id as "warehouseId"
      from heads h
      left join reconciliation_checkpoints c
        on c.tenant_id = h.tenant_id and c.warehouse_id = h.warehouse_id
      where h.head_seq > coalesce(c.last_seq, 0)
         or c.last_seq > h.head_seq
      order by c.updated_at asc nulls first, h.tenant_id, h.warehouse_id
      limit 1
    `)) as unknown as { tenantId: string; warehouseId: string }[];
    return rows[0] ?? null;
  }

  /**
   * Phase A — detection under ONE consistent snapshot (repeatable read):
   * checkpoint validation, watermark, fold, compare, and (on a clean pass)
   * the checkpoint advance — all in the transaction that read them.
   */
  private async detect(tenantId: string, warehouseId: string): Promise<CycleDetection> {
    return withTenantTransaction(
      this.db,
      tenantId,
      async (tx) => {
        const checkpointRows = await tx
          .select()
          .from(reconciliationCheckpoints)
          .where(
            and(
              eq(reconciliationCheckpoints.tenantId, tenantId),
              eq(reconciliationCheckpoints.warehouseId, warehouseId),
            ),
          )
          .limit(1);
        const checkpoint = checkpointRows[0];

        const headRows = await tx
          .select({ seq: ledgerEvents.seq })
          .from(ledgerEvents)
          .where(
            and(
              eq(ledgerEvents.tenantId, tenantId),
              eq(ledgerEvents.warehouseId, warehouseId),
            ),
          )
          .orderBy(desc(ledgerEvents.seq))
          .limit(1);
        const watermark = headRows[0]?.seq ?? 0;

        const base = {
          watermark,
          previousSeq: checkpoint?.lastSeq ?? null,
          // The counter as this cycle STARTED with (0: no checkpoint row).
          incrementalCount: checkpoint?.incrementalCount ?? 0,
          // Story 10.4: the pass kind. `lastSeq === 0` is a full pass exactly
          // as before (no checkpoint, or a discarded one — an uncheckpointed
          // window); the scheduled full pass adds the SECOND trigger: a
          // partition whose bounded passes have accumulated past the knob's
          // cadence. The counter rule is per PASS KIND, regardless of which
          // upsert arm the cycle's write lands in: a bounded pass increments,
          // a full pass resets to 0.
          fullPass: (checkpoint?.lastSeq ?? 0) === 0 || (checkpoint?.incrementalCount ?? 0) >= this.fullPassEvery,
        };

        // Checkpoint validation (IN-08): the stored watermark must agree with
        // the ledger — `last_seq <= head`. A checkpoint that fails twice in a
        // row is discarded (full replay from seq 1) and the corruption is
        // itself an alert.
        if (checkpoint !== undefined && checkpoint.lastSeq > watermark) {
          const attempts = checkpoint.invalidAttempts + 1;
          if (attempts >= CHECKPOINT_INVALID_LIMIT) {
            await tx
              .delete(reconciliationCheckpoints)
              .where(
                and(
                  eq(reconciliationCheckpoints.tenantId, tenantId),
                  eq(reconciliationCheckpoints.warehouseId, warehouseId),
                ),
              );
            await this.outbox.append(tx, {
              messageId: uuidv7(),
              tenantId,
              type: RECONCILIATION_CHECKPOINT_INVALID_EVENT,
              occurredAt: nowIso(),
              payload: {
                warehouseId,
                lastSeq: checkpoint.lastSeq,
                watermark,
                reason: 'stored checkpoint disagrees with the ledger (last_seq beyond head)',
              },
            });
            this.logger.warn(
              `Reconciliation checkpoint discarded (invalid ${attempts}×): ` +
                `tenant=${tenantId} warehouse=${warehouseId} lastSeq=${checkpoint.lastSeq} head=${watermark}`,
            );
            // Full replay from seq 1: an uncheckpointed window.
            const report = await replayInTx(tx, tenantId, warehouseId);
            if (report.matches) {
              // The discarding cycle's full replay verified the projections —
              // the checkpoint is re-earned to the watermark HERE (the same
              // upsert as the normal clean advance), so `advanced: true` is
              // truthful and the next cycle is bounded again. Story 10.4: the
              // re-earned checkpoint starts BOUNDED — this was a full pass,
              // so the counter is reset in both arms (a freshly re-earned
              // checkpoint must not inherit the corrupt row's count — and the
              // row was deleted, so the insert arm is the one that normally
              // lands; the conflict set covers a concurrent re-creation).
              await tx
                .insert(reconciliationCheckpoints)
                .values({
                  id: uuidv7(),
                  tenantId,
                  warehouseId,
                  lastSeq: watermark,
                  invalidAttempts: 0,
                  incrementalCount: 0,
                  lastDivergences: null,
                })
                .onConflictDoUpdate({
                  target: [reconciliationCheckpoints.tenantId, reconciliationCheckpoints.warehouseId],
                  set: {
                    lastSeq: watermark,
                    invalidAttempts: 0,
                    incrementalCount: 0,
                    lastDivergences: null,
                    updatedAt: nowIso(),
                  },
                });
            }
            return {
              ...base,
              previousSeq: checkpoint.lastSeq,
              lastSeq: 0,
              // The discard path's pass is full BY CONSTRUCTION — the corrupt
              // base's counter/kind are meaningless here.
              fullPass: true,
              incrementalCount: 0,
              lastDivergences: [],
              skipped: false,
              checkpointDiscarded: true,
              clean: report.matches,
              divergences: report.divergences,
            } satisfies CycleDetection;
          }
          // First consecutive invalid checkpoint: record the failure and skip
          // the pass — the next cycle re-validates and discards on a second
          // consecutive failure. (No pass ran, so the counter is untouched.)
          await tx
            .update(reconciliationCheckpoints)
            .set({ invalidAttempts: attempts, updatedAt: nowIso() })
            .where(
              and(
                eq(reconciliationCheckpoints.tenantId, tenantId),
                eq(reconciliationCheckpoints.warehouseId, warehouseId),
              ),
            );
          return {
            ...base,
            lastSeq: checkpoint.lastSeq,
            lastDivergences: [],
            skipped: true,
            checkpointDiscarded: false,
            clean: false,
            divergences: [],
          } satisfies CycleDetection;
        }

        const lastSeq = checkpoint?.lastSeq ?? 0;
        // No checkpoint (first cycle, or discarded) = a FULL pass: the whole
        // ledger compared exactly (every scope with events and every stored
        // projection row). Story 10.4 adds the second trigger: a partition
        // whose bounded passes have accumulated to the knob's cadence. The
        // cost of the full pass is small next to the bounded scan (the fold
        // is whole either way — only the compare is windowed), so the full
        // pass reuses `replayInTx` as-is; a second fold implementation would
        // be a new correctness surface in the one component whose
        // correctness is the point.
        const report = base.fullPass
          ? await replayInTx(tx, tenantId, warehouseId)
          : await reconcileScanInTx(tx, tenantId, warehouseId, lastSeq, watermark);

        if (report.matches) {
          // Clean pass: advance the checkpoint to the window head in the
          // same snapshot that verified it. Story 10.4: the counter follows
          // the pass kind — a bounded pass increments, a full pass resets.
          const incrementalCount = base.fullPass ? 0 : base.incrementalCount + 1;
          await tx
            .insert(reconciliationCheckpoints)
            .values({
              id: uuidv7(),
              tenantId,
              warehouseId,
              lastSeq: watermark,
              invalidAttempts: 0,
              incrementalCount,
              lastDivergences: null,
            })
            .onConflictDoUpdate({
              target: [reconciliationCheckpoints.tenantId, reconciliationCheckpoints.warehouseId],
              set: {
                lastSeq: watermark,
                invalidAttempts: 0,
                incrementalCount,
                lastDivergences: null,
                updatedAt: nowIso(),
              },
            });
          return {
            ...base,
            lastSeq,
            incrementalCount,
            lastDivergences: [],
            skipped: false,
            checkpointDiscarded: false,
            clean: true,
            divergences: [],
          } satisfies CycleDetection;
        }

        return {
          ...base,
          lastSeq,
          lastDivergences: parseLastDivergences(checkpoint?.lastDivergences ?? null),
          skipped: false,
          checkpointDiscarded: false,
          clean: false,
          divergences: report.divergences,
        } satisfies CycleDetection;
      },
      { isolationLevel: 'repeatable read' },
    );
  }
}
