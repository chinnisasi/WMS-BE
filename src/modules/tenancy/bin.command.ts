import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  batches,
  batchOnHand,
  bins,
  idempotencyKeys,
  skus,
  stockOnHand,
  zones,
} from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { signedQuantity } from '../../shared/primitives/quantity';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from './idempotency-guard';
import { idempotencyKeyReuse } from './registration.command';
import { assertPermission } from './permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from './tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { SerialLocationEntry } from '../inventory/inventory.facade';
import { openQcHoldsForBinsInTx } from '../inbound/qc.command';
import {
  binBlocked,
  binFull,
  binOccupancyInTx,
  binRetiredAsSource,
  binRetiredAsTarget,
} from '../putaway/putaway.command';
import { IDEMPOTENCY_TENANT_KEY, binHoldOpen, binNotFound, binRetired409 } from './bin.errors';

export interface CreateBinCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly zoneId: string;
  readonly code: string;
  readonly capacity: number;
  readonly type: string;
}

export interface GenerateBinsCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly zoneId: string;
  /** Single aisle letters, inclusive — `A`..`C` spans A, B, C. */
  readonly aisleFrom: string;
  readonly aisleTo: string;
  readonly baysPerAisle: number;
  readonly levelsPerBay: number;
  readonly capacity: number;
  readonly type: string;
}

export interface MergeBinCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  /** The bin whose on-hand moves (and which retires in the same commit). */
  readonly sourceBinId: string;
  /** The bin the stock consolidates into — same warehouse, not retired/blocked. */
  readonly targetBinId: string;
}

export interface RetireBinCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly binId: string;
}

/** The API response body for a bin (the idempotency snapshot). */
export interface BinSnapshot {
  readonly bin: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly zoneId: string;
    readonly code: string;
    readonly capacity: number;
    readonly type: string;
    readonly blocked: boolean;
    /** The Receiving/QC-hold system bins (never blockable/mergeable/retirable). */
    readonly systemOwned: boolean;
    /** Story 3.6 — the retirement pair (null while the bin is live). */
    readonly retiredAt: string | null;
    readonly retiredBy: string | null;
    readonly createdAt: string;
  };
}

/** The merge response body (the idempotency snapshot): both bins + the moved summary. */
export interface BinMergeSnapshot {
  readonly source: BinSnapshot['bin'];
  readonly target: BinSnapshot['bin'];
  readonly moved: {
    /** Distinct SKUs whose arms moved. */
    readonly skus: number;
    /** Total base-UoM units moved. */
    readonly units: number;
  };
}

/** The grid-generate response (one idempotency record for the whole run). */
export interface BinGridSnapshot {
  readonly warehouseId: string;
  readonly zoneId: string;
  readonly generatedCount: number;
  readonly firstCode: string;
  readonly lastCode: string;
}

/** Grid generator bound (spec 1.3): ≤ 500 bins per run. */
export const MAX_BINS_PER_GRID_RUN = 500;

const BINS_WAREHOUSE_CODE = 'bins_warehouse_id_code_unique';

/** `A-01-01` — aisle letter, zero-padded bay, zero-padded level. */
function gridCode(aisle: string, bay: number, level: number): string {
  return `${aisle}-${String(bay).padStart(2, '0')}-${String(level).padStart(2, '0')}`;
}

/**
 * Aisle count for an inclusive letter range — a descending or out-of-range
 * aisle span is a bad request, not an empty grid.
 */
function aisleRangeCount(aisleFrom: string, aisleTo: string): number {
  if (aisleFrom < 'A' || aisleTo > 'Z' || aisleFrom > aisleTo) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Invalid aisle range',
      `aisleFrom..aisleTo must be an ascending A–Z range (got "${aisleFrom}".."${aisleTo}").`,
    );
  }
  return aisleTo.charCodeAt(0) - aisleFrom.charCodeAt(0) + 1;
}

/** The generated code set; callers bound the total before calling this. */
function buildGridCodes(aisleFrom: string, aisleTo: string, bays: number, levels: number): string[] {
  const codes: string[] = [];
  for (let a = aisleFrom.charCodeAt(0); a <= aisleTo.charCodeAt(0); a += 1) {
    const aisle = String.fromCharCode(a);
    for (let bay = 1; bay <= bays; bay += 1) {
      for (let level = 1; level <= levels; level += 1) {
        codes.push(gridCode(aisle, bay, level));
      }
    }
  }
  return codes;
}

/**
 * Bin commands: manual create + the ≤500-bin grid generator (Story 1.3) and
 * the Story 3.6 administration pair — `mergeBin` (per-arm `bin.merged` ledger
 * movements + source retirement, ONE transaction) and `retireBin` (the
 * one-way, empty-only state change). The `blocked` toggle re-homed to the
 * putaway module in 3.6 (putaway owns bin OPERATIONAL state; the controller
 * URL and FE contract are unchanged). Every write asserts the parent
 * warehouse belongs to the tenant inside the transaction (404 `not-found`)
 * and the parent zone belongs to that warehouse (also 404 — foreign zones
 * never leak). Bin codes are unique per warehouse — the duplicate rejection
 * names the conflicting code. Idempotency de-dupe in the same transaction
 * (AD-5); the grid generator is one transaction + one idempotency record
 * (all-or-nothing).
 */
@Injectable()
export class BinCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // The ledger passthrough (the 3.5 composition convention): a merge moves
    // stock through REAL per-arm ledger movements inside its own transaction
    // — this module never touches inventory tables directly (AD-6).
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  async createBin(command: CreateBinCommand, idempotencyKey: string): Promise<BinSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      zoneId: command.zoneId,
      code: command.code,
      capacity: command.capacity,
      type: command.type,
    });

    // A manual bin carries no event of its own in this story — the spec names
    // zone.created / bins.generated / bin.blocked only — so `replayed` is not
    // consulted here.
    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry (Story 1.5) — DB read, same tx.
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'bin.create',
        );

        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, command.tenantId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as BinSnapshot,
            replayed: true,
          };
        }

        // Warehouse ownership inside the write transaction — before any bin
        // write (same gate as generateGrid / setBlocked).
        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

        const bin = await insertBin(tx, command);

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: { bin },
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
        return { snapshot: { bin }, replayed: false };
      },
    );

    return snapshot;
  }

  async generateGrid(command: GenerateBinsCommand, idempotencyKey: string): Promise<BinGridSnapshot> {
    const from = command.aisleFrom.toUpperCase();
    const to = command.aisleTo.toUpperCase();
    // Count arithmetically first — a Z×99×99 request must not materialize a
    // 255k-code array just to reject it.
    const total = aisleRangeCount(from, to) * command.baysPerAisle * command.levelsPerBay;
    if (total > MAX_BINS_PER_GRID_RUN) {
      throw new ProblemException(
        'grid-too-large',
        422,
        'Grid generation exceeds the bin cap',
        `This grid would create ${total} bins — the cap is ${MAX_BINS_PER_GRID_RUN} per run. Narrow the aisle range, bays, or levels.`,
      );
    }
    const codes = buildGridCodes(from, to, command.baysPerAisle, command.levelsPerBay);

    // Hash the normalized aisle letters: the codes come from the uppercased
    // values, so a case-variant replay of the same request must replay too.
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      zoneId: command.zoneId,
      aisleFrom: from,
      aisleTo: to,
      baysPerAisle: command.baysPerAisle,
      levelsPerBay: command.levelsPerBay,
      capacity: command.capacity,
      type: command.type,
    });

    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry (Story 1.5) — DB read, same tx.
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'bin.create',
        );

        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, command.tenantId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as BinGridSnapshot,
            replayed: true,
          };
        }

        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
        await assertZoneInWarehouse(tx, command.zoneId, command.warehouseId);

        // Collision pre-check in the same transaction: any generated code that
        // already exists in this warehouse (any zone — codes are unique per
        // warehouse) fails the run naming the first conflicting code, with
        // nothing committed.
        const conflicts = await tx
          .select({ code: bins.code })
          .from(bins)
          .where(and(eq(bins.warehouseId, command.warehouseId), inArray(bins.code, codes)));
        if (conflicts.length > 0) {
          const first = codes.find((code) => conflicts.some((c) => c.code === code));
          throw duplicateBinCode(first ?? conflicts[0]!.code);
        }

        const rows = codes.map((code) => ({
          id: uuidv7(),
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          zoneId: command.zoneId,
          code,
          capacity: command.capacity,
          type: command.type,
        }));
        try {
          await tx.insert(bins).values(rows);
        } catch (err) {
          if (isUniqueViolationOn(err, BINS_WAREHOUSE_CODE)) {
            // Concurrent writer won the race between the pre-check and the
            // insert; the transaction is aborted — retry replays cleanly.
            throw duplicateBinCode(codes[0]!);
          }
          throw err;
        }

        const snapshot: BinGridSnapshot = {
          warehouseId: command.warehouseId,
          zoneId: command.zoneId,
          generatedCount: rows.length,
          firstCode: codes[0]!,
          lastCode: codes[codes.length - 1]!,
        };
        // In-transaction outbox append (AD-7, story outbox-relay) — replaces
        // the old post-commit publish. The `!replayed` gate of the old
        // post-commit publish is structural here: the idempotent replay
        // returned above (and a concurrent duplicate's transaction rolls
        // back whole), so a replayed grid run appends nothing.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'bins.generated',
          occurredAt: nowIso(),
          payload: {
            warehouseId: command.warehouseId,
            zoneId: command.zoneId,
            count: rows.length,
            firstCode: codes[0]!,
            lastCode: codes[codes.length - 1]!,
          },
        });

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

    return snapshot;
  }

  /**
   * Story 3.6 — merge a source bin into a target bin: EVERY on-hand arm of
   * the source moves through REAL per-arm ledger `bin.merged` movements (the
   * putaway relocation convention: one two-arm event per (sku, batch) arm,
   * one two-arm event per serial unit for serial-tracked stock), and the
   * source auto-retires in the SAME commit (a merged bin is empty by
   * construction; retiring it reserves the code and ends its life — the
   * spec's "merge is retire-with-stock"). All-or-nothing: a target overflow
   * (`400 bin-full`) writes nothing.
   *
   * Guards (the matrix order): capability `bin.retire` (Owner + Ops Manager),
   * idempotency replay, warehouse assertion (404), BOTH bin rows locked
   * `.for('update')` id-sorted BEFORE any arm is read (serializes against
   * concurrent placements — the same row-lock the placement takes on its
   * target), same-bin / system-bin / retired / blocked guards, the open
   * QC-hold guard (`409 bin-merge-hold-open`, naming bin + hold), then the
   * capacity gate. Merging FROM a blocked source is allowed by design — it is
   * the only way to empty a blocked bin; only the TARGET must be live.
   * Serial sets pre-lock sorted before the first append (the
   * stock.adjustment deadlock rule); the lock order stays acyclic —
   * bin rows → serial locks → the warehouse advisory lock inside the appends.
   */
  async mergeBin(command: MergeBinCommand, idempotencyKey: string): Promise<BinMergeSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      sourceBinId: command.sourceBinId,
      targetBinId: command.targetBinId,
    });

    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry (Story 1.5) — DB read, same tx.
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'bin.retire',
        );

        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, command.tenantId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as BinMergeSnapshot,
            replayed: true,
          };
        }

        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

        // ── both bin rows, locked id-sorted BEFORE the arms are read ───────
        // `.for('update')` serializes merges against placements (which lock
        // their target bin too) and against each other; the id sort fixes
        // the two-row lock order (no deadlocks between concurrent merges).
        // The warehouseId scope IS the cross-warehouse gate: a foreign-
        // warehouse id simply never resolves here → 404.
        const lockedBins = await tx
          .select()
          .from(bins)
          .where(
            and(
              eq(bins.tenantId, command.tenantId),
              eq(bins.warehouseId, command.warehouseId),
              inArray(bins.id, [command.sourceBinId, command.targetBinId]),
            ),
          )
          .orderBy(asc(bins.id))
          .for('update');
        const source = lockedBins.find((row) => row.id === command.sourceBinId);
        const target = lockedBins.find((row) => row.id === command.targetBinId);
        if (source === undefined || target === undefined) {
          throw binNotFound();
        }

        // ── the structural guards ───────────────────────────────────────────
        if (source.id === target.id) {
          throw mergeValidation(
            `Bin "${source.code}" cannot merge into itself — pick a different target bin.`,
          );
        }
        if (source.systemOwned) {
          throw mergeValidation(
            `Bin "${source.code}" is a system bin (Receiving/QC-hold) — system bins never merge.`,
          );
        }
        if (target.systemOwned) {
          throw mergeValidation(
            `Bin "${target.code}" is a system bin (Receiving/QC-hold) — system bins never merge.`,
          );
        }
        if (source.retiredAt !== null) {
          throw binRetiredAsSource(source.code);
        }
        if (target.retiredAt !== null) {
          throw binRetiredAsTarget(target.code);
        }
        if (target.blocked) {
          throw binBlocked(target.code);
        }

        // ── the open QC-hold guard (409, naming bin + hold) ─────────────────
        const openHolds = await openQcHoldsForBinsInTx(tx, command.tenantId, command.warehouseId, [
          source.id,
          target.id,
        ]);
        if (openHolds.length > 0) {
          const hold = openHolds[0]!;
          const binCode = hold.binId === source.id ? source.code : target.code;
          throw binHoldOpen(binCode, hold.holdId, 'merging');
        }

        // ── the source's arms (every non-zero on-hand piece) ────────────────
        // Three arm shapes, exactly the projections the ledger folds: plain
        // (sku) rows, batch rows (with their batch identity), and serial-
        // tracked SKUs (the ledger is the only serial-location source — one
        // two-arm event per serial unit).
        const onHandRows = await tx
          .select({
            skuId: stockOnHand.skuId,
            quantity: stockOnHand.quantity,
            skuCode: skus.code,
            batchTracked: skus.batchTracked,
            serialTracked: skus.serialTracked,
          })
          .from(stockOnHand)
          .innerJoin(skus, eq(skus.id, stockOnHand.skuId))
          .where(
            and(
              eq(stockOnHand.tenantId, command.tenantId),
              eq(stockOnHand.warehouseId, command.warehouseId),
              eq(stockOnHand.binId, source.id),
              gt(stockOnHand.quantity, 0),
            ),
          )
          .orderBy(asc(stockOnHand.skuId));

        interface MergeArm {
          readonly skuId: string;
          readonly batchRef: string | null;
          readonly serialRef: string | null;
          readonly qty: number;
        }
        const arms: MergeArm[] = [];
        for (const row of onHandRows) {
          if (row.serialTracked) {
            // The ledger is the serial-location source (AD-6) — enumerate the
            // units through the facade; the aggregate must equal the serial
            // count or the projections and the ledger disagree (never merge
            // over a disagreeing source).
            const serialEntries: readonly SerialLocationEntry[] = await this.inventory
              .serialsLocatedInBinInTx(tx, command.tenantId, row.skuId, source.id);
            if (serialEntries.length !== row.quantity) {
              throw mergeValidation(
                `Bin "${source.code}" serial state disagrees with its on-hand projection for SKU "${row.skuCode}" (${serialEntries.length} serials vs ${row.quantity} units) — resolve before merging.`,
              );
            }
            for (const entry of serialEntries) {
              arms.push({
                skuId: row.skuId,
                batchRef: entry.batchRef,
                serialRef: entry.serialRef,
                qty: 1,
              });
            }
          } else if (row.batchTracked) {
            const batchRows = await tx
              .select({ batchId: batchOnHand.batchId, quantity: batchOnHand.quantity })
              .from(batchOnHand)
              .where(
                and(
                  eq(batchOnHand.tenantId, command.tenantId),
                  eq(batchOnHand.warehouseId, command.warehouseId),
                  eq(batchOnHand.skuId, row.skuId),
                  eq(batchOnHand.binId, source.id),
                  gt(batchOnHand.quantity, 0),
                ),
              )
              .orderBy(asc(batchOnHand.batchId));
            for (const batchRow of batchRows) {
              arms.push({
                skuId: row.skuId,
                batchRef: batchRow.batchId,
                serialRef: null,
                qty: batchRow.quantity,
              });
            }
          } else {
            arms.push({
              skuId: row.skuId,
              batchRef: null,
              serialRef: null,
              qty: row.quantity,
            });
          }
        }

        // The all-or-nothing capacity gate BEFORE any append: the whole merge
        // must fit, or nothing moves.
        const movedUnits = arms.reduce((sum, arm) => sum + arm.qty, 0);
        const targetOccupancy = await binOccupancyInTx(
          tx,
          command.tenantId,
          command.warehouseId,
          target.id,
        );
        if (targetOccupancy + movedUnits > target.capacity) {
          throw binFull(target.code, target.capacity, targetOccupancy);
        }

        // ── the movements (one `bin.merged` event per arm) ──────────────────
        const mergeId = uuidv7();
        const at = nowIso();
        const referenceDoc = { kind: 'bin-merge' as const, mergeId };
        // Serial sets pre-lock tenant-wide, sorted, BEFORE the first append
        // (the stock.adjustment deadlock rule) — all arms' serials together.
        const serialRefs = arms
          .map((arm) => arm.serialRef)
          .filter((ref): ref is string => ref !== null)
          .sort();
        if (serialRefs.length > 0) {
          await this.inventory.lockSerialsInTx(tx, command.tenantId, serialRefs);
        }
        for (const arm of arms) {
          await this.inventory.appendLedgerEventInTx(tx, {
            tenantId: command.tenantId,
            warehouseId: command.warehouseId,
            type: 'bin.merged',
            skuId: arm.skuId,
            quantityDelta: signedQuantity(arm.qty),
            fromBinId: source.id,
            toBinId: target.id,
            batchRef: arm.batchRef,
            serialRef: arm.serialRef,
            actorUserId: command.actorUserId,
            occurredAt: at,
            recordedAt: at,
            referenceDoc,
          });
        }

        // ── the source's retirement (the same commit) ───────────────────────
        const retiredRows = await tx
          .update(bins)
          .set({ retiredAt: at, retiredBy: command.actorUserId, updatedAt: at })
          .where(eq(bins.id, source.id))
          .returning();
        const sourceBin = binFromRow(retiredRows[0]!);
        const targetBin = binFromRow(target);

        const snapshot: BinMergeSnapshot = {
          source: sourceBin,
          target: targetBin,
          moved: {
            skus: new Set(arms.map((arm) => arm.skuId)).size,
            units: movedUnits,
          },
        };

        // ── in-transaction outbox append (AD-7) — one event per operation ───
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'bin.merged',
          occurredAt: at,
          payload: {
            mergeId,
            tenantId: command.tenantId,
            warehouseId: command.warehouseId,
            sourceBinId: source.id,
            sourceBinCode: source.code,
            targetBinId: target.id,
            targetBinCode: target.code,
            moved: snapshot.moved,
            retiredAt: at,
            retiredBy: command.actorUserId,
          },
        });

        // The audit row — same transaction, after the outbox, before the
        // idempotency key (the 3.4/3.5 invariant order).
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'bin.merged',
          targetType: 'bin',
          targetId: source.id,
          reference: idempotencyKey,
          occurredAt: at,
        });

        await writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return { snapshot, replayed: false };
      },
    );

    return snapshot;
  }

  /**
   * Story 3.6 — retire a bin: a ONE-WAY, idempotency-keyed state change that
   * only an EMPTY bin can take (`400 bin-not-empty` names the offending
   * (sku, batch, qty) rows). Retirement keeps the row (no bin deletion; the
   * `(warehouse_id, code)` unique key reserves the code forever) and is
   * terminal — a re-retire under a different key is `409 bin-retired`.
   */
  async retireBin(command: RetireBinCommand, idempotencyKey: string): Promise<BinSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      binId: command.binId,
    });

    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry (Story 1.5) — DB read, same tx.
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'bin.retire',
        );

        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, command.tenantId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as BinSnapshot,
            replayed: true,
          };
        }

        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

        const lockedRows = await tx
          .select()
          .from(bins)
          .where(
            and(
              eq(bins.id, command.binId),
              eq(bins.tenantId, command.tenantId),
              eq(bins.warehouseId, command.warehouseId),
            ),
          )
          .limit(1)
          .for('update');
        const row = lockedRows[0];
        if (row === undefined) {
          throw binNotFound();
        }
        if (row.systemOwned) {
          throw mergeValidation(
            `Bin "${row.code}" is a system bin (Receiving/QC-hold) — system bins never retire.`,
          );
        }
        if (row.retiredAt !== null) {
          throw binRetired409(row.code);
        }

        // The open-QC-hold gate (the mergeBin rejection, the retiring arm):
        // the hold has already moved this bin's stock to the QC bin, so the
        // bin is empty and the empty gate alone would let it retire — then
        // the release could never return the held stock to the origin bin it
        // recorded, stranding the hold with no resolution path.
        const openHolds = await openQcHoldsForBinsInTx(tx, command.tenantId, command.warehouseId, [
          row.id,
        ]);
        if (openHolds.length > 0) {
          const hold = openHolds[0]!;
          throw binHoldOpen(row.code, hold.holdId, 'retiring');
        }

        // The empty gate: every non-zero on-hand arm (plain + batch) names
        // itself in the rejection.
        const plainRows = await tx
          .select({
            skuCode: skus.code,
            quantity: stockOnHand.quantity,
          })
          .from(stockOnHand)
          .innerJoin(skus, eq(skus.id, stockOnHand.skuId))
          .where(
            and(
              eq(stockOnHand.tenantId, command.tenantId),
              eq(stockOnHand.warehouseId, command.warehouseId),
              eq(stockOnHand.binId, row.id),
              gt(stockOnHand.quantity, 0),
            ),
          )
          .orderBy(asc(skus.code));
        const batchRows = await tx
          .select({
            skuCode: skus.code,
            batchCode: batches.code,
            quantity: batchOnHand.quantity,
          })
          .from(batchOnHand)
          .innerJoin(skus, eq(skus.id, batchOnHand.skuId))
          .innerJoin(batches, eq(batches.id, batchOnHand.batchId))
          .where(
            and(
              eq(batchOnHand.tenantId, command.tenantId),
              eq(batchOnHand.warehouseId, command.warehouseId),
              eq(batchOnHand.binId, row.id),
              gt(batchOnHand.quantity, 0),
            ),
          )
          .orderBy(asc(skus.code), asc(batches.code));
        if (plainRows.length > 0 || batchRows.length > 0) {
          const parts = [
            ...plainRows.map((r) => `${r.skuCode} ×${r.quantity}`),
            ...batchRows.map((r) => `${r.skuCode} (batch ${r.batchCode}) ×${r.quantity}`),
          ];
          throw new ProblemException(
            'bin-not-empty',
            400,
            'Bin still holds stock',
            `Bin "${row.code}" cannot retire while it holds stock: ${parts.join(', ')}.`,
          );
        }

        const at = nowIso();
        const retiredRows = await tx
          .update(bins)
          .set({ retiredAt: at, retiredBy: command.actorUserId, updatedAt: at })
          .where(eq(bins.id, row.id))
          .returning();
        const bin = binFromRow(retiredRows[0]!);

        // In-transaction outbox append (AD-7) — a replay appends nothing.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'bin.retired',
          occurredAt: at,
          payload: {
            binId: bin.id,
            binCode: bin.code,
            warehouseId: bin.warehouseId,
            retiredAt: at,
            retiredBy: command.actorUserId,
          },
        });

        // The audit row — same transaction, after the outbox, before the
        // idempotency key (the 3.4/3.5 invariant order).
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'bin.retired',
          targetType: 'bin',
          targetId: bin.id,
          reference: idempotencyKey,
          occurredAt: at,
        });

        await writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, { bin });
        return { snapshot: { bin }, replayed: false };
      },
    );

    return snapshot;
  }
}

/**
 * The bin's parent zone must exist and belong to the warehouse — validated in
 * the command transaction (no FK constraints; repo convention is uuid columns
 * + app-layer integrity). A foreign/nonexistent zone is 404 `not-found`.
 */
async function assertZoneInWarehouse(
  tx: TenantTx,
  zoneId: string,
  warehouseId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: zones.id })
    .from(zones)
    .where(and(eq(zones.id, zoneId), eq(zones.warehouseId, warehouseId)))
    .limit(1);
  if (rows.length === 0) {
    throw new ProblemException(
      'not-found',
      404,
      'Zone not found',
      'No zone with this id exists in this warehouse.',
    );
  }
}

/** Shared insert path for manually-created bins (same duplicate mapping). */
async function insertBin(
  tx: TenantTx,
  command: CreateBinCommand,
): Promise<BinSnapshot['bin']> {
  // Zone must exist and belong to the warehouse before any bin write.
  await assertZoneInWarehouse(tx, command.zoneId, command.warehouseId);
  try {
    const rows = await tx
      .insert(bins)
      .values({
        id: uuidv7(),
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        zoneId: command.zoneId,
        code: command.code,
        capacity: command.capacity,
        type: command.type,
      })
      .returning();
    const row = rows[0]!;
    return binFromRow(row);
  } catch (err) {
    if (isUniqueViolationOn(err, BINS_WAREHOUSE_CODE)) {
      throw duplicateBinCode(command.code);
    }
    throw err;
  }
}

export function duplicateBinCode(code: string): ProblemException {
  return new ProblemException(
    'duplicate-bin-code',
    409,
    'Bin code already in use',
    `Bin code "${code}" already exists in this warehouse.`,
  );
}

/** The snapshot's bin body from a `bins` row (the Story 3.6 fields included). */
function binFromRow(row: typeof bins.$inferSelect): BinSnapshot['bin'] {
  return {
    id: row.id,
    tenantId: row.tenantId,
    warehouseId: row.warehouseId,
    zoneId: row.zoneId,
    code: row.code,
    capacity: row.capacity,
    type: row.type,
    blocked: row.blocked,
    systemOwned: row.systemOwned,
    retiredAt: row.retiredAt,
    retiredBy: row.retiredBy,
    createdAt: row.createdAt,
  };
}

/** The merge/retire structural rejections (400, naming the offending bin). */
function mergeValidation(detail: string): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    'Invalid bin administration request',
    detail,
  );
}

/**
 * The idempotency-key write shared by the bin administration commands: the
 * LAST write of the invariant order; a concurrent duplicate's unique
 * violation maps to 409 `conflict`.
 */
async function writeIdempotencyKey(
  tx: TenantTx,
  tenantId: string,
  key: string,
  payloadHash: string,
  responseSnapshot: unknown,
): Promise<void> {
  try {
    await tx.insert(idempotencyKeys).values({
      id: uuidv7(),
      tenantId,
      key,
      payloadHash,
      responseSnapshot,
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
}