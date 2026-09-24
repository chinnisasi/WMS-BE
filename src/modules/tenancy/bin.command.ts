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
import {
  MAX_QUANTITY_BASE,
  QUANTITY_SCALE,
  assertExactQuantity,
  fromMilli,
  signedQuantity,
  toMilli,
} from '../../shared/primitives/quantity';
import { nowIso } from '../../shared/primitives/time';
// Story 12-1 — the vocabulary validator + the class-edit/merge refusal
// factories, shared with catalog and the putaway/pick gates. The matching
// rule itself is imported where it gates (`storageClassSatisfies` in the
// merge loop below).
import {
  assertStorageClass,
  mergeClassConflict,
  storageClassConflict,
  storageClassSatisfies,
} from '../../shared/primitives/storage-class';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from './idempotency-guard';
import { idempotencyKeyReuse } from './registration.command';
import { assertPermission, assertSecureBinAuthority } from './permissions';
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
  binItemOversize,
  binOccupancyInTx,
  binOverweight,
  binRetiredAsSource,
  binRetiredAsTarget,
  binVolumeExceeded,
  occupantHazardClassesInTx,
} from '../putaway/putaway.command';
// Story 12-2 — the ONE segregation predicate + the co-location refusal
// factory (shared with the placement gate; the detail is merge-worded).
import {
  hazardClassesCompatible,
  segregationConflict,
} from '../../shared/primitives/hazard';
import { IDEMPOTENCY_TENANT_KEY, binHoldOpen, binNotFound, binRetired409 } from './bin.errors';

export interface CreateBinCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly zoneId: string;
  readonly code: string;
  /**
   * Story 10.2: WHOLE units on the way in (the controller no longer scales).
   * `assertWholeUnitCapacity` converts it inside the command, behind the
   * replay lookup — see that function for why capacity has no unit of its own.
   */
  readonly capacity: number;
  // ── story 11-5: the bin's optional physical capacity (FR-39) ─────────────
  // Absent = unconstrained (pre-11.5 behavior); null = explicitly cleared
  // (same verb semantics the SKU-attribute edit uses). `undefined` is spelled
  // out because the repo compiles with `exactOptionalPropertyTypes`.
  readonly lengthMm?: number | null | undefined;
  readonly widthMm?: number | null | undefined;
  readonly heightMm?: number | null | undefined;
  readonly maxWeightGrams?: number | null | undefined;
  /**
   * Story 12-1 — the bin's storage class (FR-40). Optional on create: absent
   * stores `ambient` (the column default — never an explicit null; the
   * NOT NULL column has no clear verb). Validated by `assertStorageClass`
   * behind the replay lookup.
   */
  readonly storageClass?: string | undefined;
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
  /** Whole units, per bin (story 10.2 — see `CreateBinCommand.capacity`). */
  readonly capacity: number;
  /** Story 11-5: the optional physical capacity, per bin (see `CreateBinCommand`). */
  readonly lengthMm?: number | null | undefined;
  readonly widthMm?: number | null | undefined;
  readonly heightMm?: number | null | undefined;
  readonly maxWeightGrams?: number | null | undefined;
  /** Story 12-1: the storage class, per bin (see `CreateBinCommand.storageClass`). */
  readonly storageClass?: string | undefined;
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

/**
 * Story 11-5 — the bin's capacity attributes (FR-39), the PATCH dispatch arm:
 * tenancy owns bin STRUCTURE, so the attribute write is tenancy's command even
 * though it rides the same PATCH route as putaway's `blocked` state command
 * (the re-homing precedent in reverse). Absent = unchanged; null = cleared;
 * a present value must be a positive whole integer within the caps
 * (`assertBinCapacityAttributes`, behind the replay lookup — the 10.2 rule).
 */
export interface EditBinCapacityCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly lengthMm?: number | null | undefined;
  readonly widthMm?: number | null | undefined;
  readonly heightMm?: number | null | undefined;
  readonly maxWeightGrams?: number | null | undefined;
  /**
   * Story 12-1 — the bin's storage class, PATCH semantics: absent =
   * unchanged. There is NO null/clear verb — the column is NOT NULL (a bin
   * always carries a class), so clearing is not an operation. A class CHANGE
   * runs the stock-conformance guard behind the replay (409
   * `storage-class-conflict`): the bin's on-hand stock and its open-QC-hold
   * quantities (attributed to this origin bin) must all satisfy the new
   * class, or the edit strands non-conforming stock.
   */
  readonly storageClass?: string | undefined;
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
    /** Story 11-5 — the optional physical capacity (null = unconstrained). */
    readonly lengthMm: number | null;
    readonly widthMm: number | null;
    readonly heightMm: number | null;
    readonly maxWeightGrams: number | null;
    /** Story 12-1 — the controlled-vocabulary storage class (FR-40). */
    readonly storageClass: string;
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
    // ── story 10.2: this fingerprint is over BASE units ────────────────────
    // `capacity` is scaled inside the command now (behind the replay lookup),
    // so the hashed value changed: a key written by a pre-10.2 build hashed
    // MILLI-units and now answers 422 `idempotency-key-reuse` rather than
    // replaying. Accepted deliberately under the pre-launch premise — the same
    // call story 10.1 made about the ledger hash chain — and pinned as
    // EXPECTED by the cross-version replay guard in `test/picking.spec.ts`.
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      zoneId: command.zoneId,
      code: command.code,
      capacity: command.capacity,
      // Story 11-5: the capacity attributes ride the hash with the 11-2
      // spread precedent — `JSON.stringify` drops `undefined` keys, so an
      // attrs-less request fingerprints byte-identically to a pre-11.5 one
      // and existing replay keys keep replaying.
      lengthMm: command.lengthMm,
      widthMm: command.widthMm,
      heightMm: command.heightMm,
      maxWeightGrams: command.maxWeightGrams,
      // Story 12-1: the class rides the hash — an absent key drops out of the
      // JSON (the 11-2 spread precedent), so a pre-12.1 request fingerprints
      // byte-identically and its replay key keeps replaying.
      storageClass: command.storageClass,
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

        // Story 10.2: capacity is scaled HERE, behind the replay lookup, for
        // the same reason every other quantity is (`assertWholeUnitCapacity`
        // refuses a fractional one, and a refusal in front of the replay
        // would answer 400 to an op that already committed). Story 11-5: the
        // capacity attributes take the same position — the one validator
        // (`assertBinCapacityAttributes`) runs behind the replay lookup too.
        // Story 12-1: the storage class joins the position — same validator
        // (`assertStorageClass`), same behind-the-replay rule.
        assertBinCapacityAttributes(command);
        assertStorageClass({ storageClass: command.storageClass });
        const bin = await insertBin(tx, {
          ...command,
          capacity: assertWholeUnitCapacity(command.capacity),
        });

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
      // Story 11-5: the capacity attributes (the createBin hash note).
      lengthMm: command.lengthMm,
      widthMm: command.widthMm,
      heightMm: command.heightMm,
      maxWeightGrams: command.maxWeightGrams,
      // Story 12-1: the class (the createBin hash note).
      storageClass: command.storageClass,
      type: command.type,
    });
    // Story 10.2: BASE units (see the note on `createBin`'s payload hash).

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

        // Story 11-5: the capacity attributes validate behind the replay
        // lookup (the createBin position — the 10.2 rule), once for the run.
        // Story 12-1: the storage class joins the position.
        assertBinCapacityAttributes(command);
        assertStorageClass({ storageClass: command.storageClass });

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
          // Story 10.2: whole units only, converted behind the replay lookup.
          capacity: assertWholeUnitCapacity(command.capacity),
          // Story 11-5: the same attributes on every generated bin.
          lengthMm: command.lengthMm ?? null,
          widthMm: command.widthMm ?? null,
          heightMm: command.heightMm ?? null,
          maxWeightGrams: command.maxWeightGrams ?? null,
          // Story 12-1: the same class on every generated bin (absent →
          // 'ambient', the column default spelled out).
          storageClass: command.storageClass ?? 'ambient',
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
        // The role stays in scope: story 12-3's secure-bin authority gate
        // re-uses it below, on the locked bin rows.
        const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
        assertPermission(role, 'bin.retire');

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
            // Story 11-5: the attributes the target's weight/volume gates and
            // the per-SKU dim-fit check consume (null = units only).
            weightGrams: skus.weightGrams,
            lengthMm: skus.lengthMm,
            widthMm: skus.widthMm,
            heightMm: skus.heightMm,
            // Story 12-1 — the class the target's class gate consumes (FR-40).
            storageClass: skus.storageClass,
            // Story 12-2 — the hazard class the target's co-location gate
            // consumes (FR-41; null = carries no rule).
            hazardClass: skus.hazardClass,
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

        // ── story 12-1: the class gate (FR-40) — immediately after the
        // on-hand read, BEFORE any arm moves or capacity gate: a merge that
        // would park a SKU the target cannot satisfy is refused whole, naming
        // every offending SKU. Same predicate as the placement gate (the SYNC
        // HAZARD rule — this is merge's copy of the arm list).
        const offendingClasses = onHandRows.filter(
          (row) => !storageClassSatisfies(row.storageClass, target.storageClass),
        );
        if (offendingClasses.length > 0) {
          throw mergeClassConflict(
            target.code,
            target.storageClass,
            offendingClasses.map((row) => ({
              skuCode: row.skuCode,
              skuClass: row.storageClass,
            })),
          );
        }

        // ── story 12-3: the secure-bin authority gate (FR-42) — immediately
        // after the class gate, BEFORE any arm moves, with both rows already
        // locked: a SECURE source or target additionally requires
        // `secure.move`, the (role, bin) authority decided on the rows
        // already in hand. `bin.retire` and `secure.move` are held by
        // exactly the same roles today, so this arm is dead code by the
        // matrix — the invariant test in `test/users.spec.ts` keeps that
        // subset enforced (a future grant must answer the cage question in
        // the open). Non-secure merges are byte-identical to the pre-12.3
        // build.
        assertSecureBinAuthority(role, [source, target]);

        // ── story 12-2: the hazard co-location gate (FR-41) — after the
        // class gate, BEFORE any arm moves: a merge that would park a SKU
        // beside an incompatible target occupant is refused whole, naming
        // both parties. The gate reads the TARGET bin's occupants via the
        // putaway helper (the `binBlocked` precedent for importing it); each
        // moved SKU's own pairs are SKIPPED (the same-SKU-consolidation rule
        // — merging stock into a bin already holding that SKU is legitimate,
        // explosive included), rows whose class is null skip (null carries
        // no rule), and moved-vs-moved is NOT re-checked (the source bin
        // already co-locates them) — a premise that holds while `stock.adjust`
        // is the named bypass: it is the only writer able to FORM incompatible
        // co-location in a source bin (recorded in PENDING). Same factory as
        // the placement gate (400 `bin-segregation-conflict`).
        const targetOccupants = await occupantHazardClassesInTx(
          tx,
          command.tenantId,
          command.warehouseId,
          target.id,
        );
        if (targetOccupants.length > 0) {
          for (const row of onHandRows) {
            if (row.hazardClass === null) {
              continue;
            }
            for (const occupant of targetOccupants) {
              if (occupant.skuId === row.skuId) {
                continue;
              }
              if (!hazardClassesCompatible(row.hazardClass, occupant.hazardClass)) {
                throw segregationConflict(
                  `Merge refused — target bin "${target.code}" holds SKU "${occupant.skuCode}" ` +
                    `(${occupant.hazardClass}); moved SKU "${row.skuCode}" (${row.hazardClass}) is segregated from it (FR-41).`,
                );
              }
            }
          }
        }

        interface MergeArm {
          readonly skuId: string;
          readonly skuCode: string;
          readonly batchRef: string | null;
          readonly serialRef: string | null;
          readonly qty: number;
          // Story 11-5: the SKU's static attributes ride every arm — the
          // moved-load sums and the per-SKU dim-fit check read them here.
          readonly weightGrams: number | null;
          readonly lengthMm: number | null;
          readonly widthMm: number | null;
          readonly heightMm: number | null;
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
            // Story 10.1: an array length is a UNIT count — `row.quantity` is
            // in milli-units, so the comparison is made in units.
            if (serialEntries.length !== fromMilli(row.quantity)) {
              throw mergeValidation(
                `Bin "${source.code}" serial state disagrees with its on-hand projection for SKU "${row.skuCode}" (${serialEntries.length} serials vs ${fromMilli(row.quantity)} units) — resolve before merging.`,
              );
            }
            for (const entry of serialEntries) {
              arms.push({
                skuId: row.skuId,
                batchRef: entry.batchRef,
                serialRef: entry.serialRef,
                // One serial is one whole unit — `QUANTITY_SCALE` milli-units.
                qty: QUANTITY_SCALE,
                skuCode: row.skuCode,
                weightGrams: row.weightGrams,
                lengthMm: row.lengthMm,
                widthMm: row.widthMm,
                heightMm: row.heightMm,
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
                skuCode: row.skuCode,
                weightGrams: row.weightGrams,
                lengthMm: row.lengthMm,
                widthMm: row.widthMm,
                heightMm: row.heightMm,
              });
            }
          } else {
            arms.push({
              skuId: row.skuId,
              batchRef: null,
              serialRef: null,
              qty: row.quantity,
              skuCode: row.skuCode,
              weightGrams: row.weightGrams,
              lengthMm: row.lengthMm,
              widthMm: row.widthMm,
              heightMm: row.heightMm,
            });
          }
        }

        // The all-or-nothing capacity gate BEFORE any append: the whole merge
        // must fit, or nothing moves. Story 11-5: the target's weight/volume
        // loads ride the same read (`binOccupancyInTx` is now the load-read)
        // and the moved loads are exact BigInt sums over the arms — a merge
        // cannot overflow what a placement cannot.
        const movedUnits = arms.reduce(
          (sum, arm) => assertExactQuantity(sum + arm.qty, 'bin merge moved units'),
          0,
        );
        const movedWeight = arms.reduce(
          (sum, arm) => sum + BigInt(arm.qty) * BigInt(arm.weightGrams ?? 0),
          0n,
        );
        const movedVolume = arms.reduce(
          (sum, arm) =>
            sum +
            BigInt(arm.qty) * BigInt((arm.lengthMm ?? 0) * (arm.widthMm ?? 0) * (arm.heightMm ?? 0)),
          0n,
        );
        const targetLoad = await binOccupancyInTx(
          tx,
          command.tenantId,
          command.warehouseId,
          target.id,
        );
        if (targetLoad.units + movedUnits > target.capacity) {
          throw binFull(target.code, target.capacity, targetLoad.units);
        }
        // ── story 11-5: the three new gates, AFTER the unit gate (the same
        // conservative coexistence as the placement), ordered weight → volume
        // → dim fit. The load figures are milli-scaled: qty is milli-units ×
        // grams (or mm³) is a milli-load, compared against limit × 1000.
        // SYNC HAZARD: the arm list must never diverge from the placement's
        // gates and `candidateFitsSku` (see the placement copy's note) — a
        // fourth arm lands in all three, in the same order.
        if (target.maxWeightGrams !== null) {
          const weightAfter = targetLoad.weightLoad + movedWeight;
          if (weightAfter > BigInt(target.maxWeightGrams) * BigInt(QUANTITY_SCALE)) {
            throw binOverweight(target.code, target.maxWeightGrams, weightAfter);
          }
        }
        if (target.lengthMm !== null && target.widthMm !== null && target.heightMm !== null) {
          const binVolume = BigInt(target.lengthMm * target.widthMm * target.heightMm);
          const volumeAfter = targetLoad.volumeLoad + movedVolume;
          if (volumeAfter > binVolume * BigInt(QUANTITY_SCALE)) {
            throw binVolumeExceeded(
              target.code,
              target.lengthMm * target.widthMm * target.heightMm,
              volumeAfter,
            );
          }
        }
        // The dim-fit check is per moved SKU (each arm's SKU must physically
        // fit the target's dimension, both sides present — the placement arm's
        // semantics).
        const movedSkus = new Map(arms.map((arm) => [arm.skuId, arm]));
        for (const arm of movedSkus.values()) {
          if (arm.lengthMm !== null && target.lengthMm !== null && arm.lengthMm > target.lengthMm) {
            throw binItemOversize(target.code, 'length', arm.lengthMm, target.lengthMm, arm.skuCode);
          }
          if (arm.widthMm !== null && target.widthMm !== null && arm.widthMm > target.widthMm) {
            throw binItemOversize(target.code, 'width', arm.widthMm, target.widthMm, arm.skuCode);
          }
          if (arm.heightMm !== null && target.heightMm !== null && arm.heightMm > target.heightMm) {
            throw binItemOversize(target.code, 'height', arm.heightMm, target.heightMm, arm.skuCode);
          }
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
            // Story 10.1: base units at the response/outbox edge.
            units: fromMilli(movedUnits),
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
            ...plainRows.map((r) => `${r.skuCode} ×${fromMilli(r.quantity)}`),
            ...batchRows.map((r) => `${r.skuCode} (batch ${r.batchCode}) ×${fromMilli(r.quantity)}`),
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

  /**
   * Story 11-5 — edit a bin's capacity attributes (FR-39): tenancy owns bin
   * STRUCTURE, so the attribute write is this module's command even though it
   * rides the same PATCH route as putaway's `blocked` state command (the
   * 3.6 re-homing precedent in reverse — one URL, per-body dispatch). Gated
   * by `bin.create` (the bin master-data capability — no new capability).
   *
   * Semantics (the 11.2 SKU-attribute edit's): an absent field is UNCHANGED,
   * a null field CLEARS the limit, a present value must pass
   * `assertBinCapacityAttributes`. Dimensions survive a warehouse retrofit —
   * a bin keeps its row, only the limits change. The system bins are
   * editable (their limits are real); a retired bin is not (retirement is
   * terminal — 409 `bin-retired`).
   *
   * Guards (the invariant order): capability `bin.create`, idempotency
   * replay, warehouse assertion (404), the bin row locked `.for('update')`,
   * the retired guard, the attribute validator (behind the replay), the
   * write, the outbox append, the audit row, the idempotency key LAST.
   */
  async editBinCapacity(
    command: EditBinCapacityCommand,
    idempotencyKey: string,
  ): Promise<BinSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      binId: command.binId,
      // Absent attributes drop out of the JSON (`undefined` keys vanish), so
      // the fingerprint carries exactly the fields the request names.
      lengthMm: command.lengthMm,
      widthMm: command.widthMm,
      heightMm: command.heightMm,
      maxWeightGrams: command.maxWeightGrams,
      // Story 12-1: the class rides the hash (same drop-absent precedent).
      storageClass: command.storageClass,
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
        // A retired bin is operationally gone — its structure is settled
        // (the block command's rejection, sibling for the same URL's state
        // arm). A SYSTEM bin stays editable: its limits are real.
        if (row.retiredAt !== null) {
          throw binRetired409(row.code);
        }

        // The one validator, behind the replay lookup (the 10.2 rule — see
        // `assertBinCapacityAttributes`). Story 12-1: the storage class joins
        // the position.
        assertBinCapacityAttributes(command);
        assertStorageClass({ storageClass: command.storageClass });

        // ── story 12-1: the class-edit guard, behind the replay (the 10.2
        // rule for a 409 rule: a replayed edit re-serves its snapshot above
        // and never reaches this). Only a class CHANGE pays the guard — an
        // absent or identical class touches no stock. The bin row is already
        // locked `.for('update')`, so a concurrent placement cannot slip a
        // unit in between the scans and the write.
        //
        // The rule: the bin's existing stock, PLUS its open-QC-hold
        // quantities (attributed to this origin bin — the held units sit in
        // the QC-HOLD system bin, which the on-hand scan cannot see), must all
        // satisfy the NEW class — one conformance rule over the bin's
        // attributed stock, whatever holds it. Otherwise the edit strands
        // non-conforming stock (409 `storage-class-conflict`, naming the
        // SKUs) — and, for the hold arm, a later release could return stock
        // to a re-classed bin (`qc.released` is deliberately class-free; THIS
        // guard is what pins it). System bins are exempt by the same
        // exclusion the SKU-side guard applies to stock in system bins:
        // Receiving staging and the QC-HOLD bin are staging, visible to no
        // gate.
        if (command.storageClass !== undefined && command.storageClass !== row.storageClass) {
          const newClass = command.storageClass;
          if (!row.systemOwned) {
            const conflicting = await tx
              .select({ skuCode: skus.code, skuClass: skus.storageClass })
              .from(stockOnHand)
              .innerJoin(skus, eq(skus.id, stockOnHand.skuId))
              .where(
                and(
                  eq(stockOnHand.tenantId, command.tenantId),
                  eq(stockOnHand.binId, row.id),
                  gt(stockOnHand.quantity, 0),
                ),
              )
              .orderBy(asc(skus.code));
            const bad = conflicting.filter(
              (entry) => !storageClassSatisfies(entry.skuClass, newClass),
            );
            if (bad.length > 0) {
              throw storageClassConflict(
                `Bin "${row.code}" would become ${newClass}, but it holds stock of ` +
                  bad
                    .map((entry) => `"${entry.skuCode}" (requires ${entry.skuClass})`)
                    .join(', ') +
                  ' — relocate it first.',
              );
            }
            // The open-QC-hold arm: held stock is attributed to ITS ORIGIN
            // bin, so a bin with held units is not empty even though its
            // on-hand scan reads zero. A class change while the hold is open
            // would let release return the units to a bin that no longer
            // satisfies them.
            const openHolds = await openQcHoldsForBinsInTx(tx, command.tenantId, command.warehouseId, [
              row.id,
            ]);
            if (openHolds.length > 0) {
              const heldClasses = await tx
                .select({ id: skus.id, code: skus.code, storageClass: skus.storageClass })
                .from(skus)
                .where(
                  and(
                    eq(skus.tenantId, command.tenantId),
                    inArray(
                      skus.id,
                      [...new Set(openHolds.map((hold) => hold.skuId))],
                    ),
                  ),
                );
              const classById = new Map(heldClasses.map((held) => [held.id, held]));
              const badHolds = openHolds.filter((hold) => {
                const held = classById.get(hold.skuId);
                return held === undefined || !storageClassSatisfies(held.storageClass, newClass);
              });
              if (badHolds.length > 0) {
                const first = badHolds[0]!;
                throw storageClassConflict(
                  `Bin "${row.code}" would become ${newClass}, but ${badHolds.length} open QC hold(s) attribute their units to it — ` +
                    `hold "${first.holdId}" holds SKU "${classById.get(first.skuId)?.code ?? first.skuId}" — release the hold(s) first.`,
                );
              }
            }
          }
        }

        const updatedRows = await tx
          .update(bins)
          .set({
            // Absent = leave the stored value; null = clear it.
            lengthMm: command.lengthMm === undefined ? row.lengthMm : command.lengthMm,
            widthMm: command.widthMm === undefined ? row.widthMm : command.widthMm,
            heightMm: command.heightMm === undefined ? row.heightMm : command.heightMm,
            maxWeightGrams:
              command.maxWeightGrams === undefined ? row.maxWeightGrams : command.maxWeightGrams,
            // Story 12-1: absent = unchanged (no clear verb — NOT NULL).
            storageClass: command.storageClass === undefined ? row.storageClass : command.storageClass,
            updatedAt: nowIso(),
          })
          .where(eq(bins.id, row.id))
          .returning();
        const bin = binFromRow(updatedRows[0]!);

        // In-transaction outbox append (AD-7) — a replay appends nothing.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'bin.capacity_changed',
          occurredAt: nowIso(),
          payload: {
            binId: bin.id,
            warehouseId: bin.warehouseId,
            lengthMm: bin.lengthMm,
            widthMm: bin.widthMm,
            heightMm: bin.heightMm,
            maxWeightGrams: bin.maxWeightGrams,
            // Story 12-1: the (possibly changed) class rides the event.
            storageClass: bin.storageClass,
          },
        });

        // The audit row — same transaction, after the outbox, before the
        // idempotency key (the 3.4/3.5 invariant order).
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'bin.capacity_changed',
          targetType: 'bin',
          targetId: bin.id,
          reference: idempotencyKey,
          occurredAt: nowIso(),
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
/**
 * Bin capacity, from the operator-facing number into milli-units — **whole
 * units only** (story 10.2).
 *
 * It is the one quantity in the system with no unit at all: a bin holds many
 * SKUs measured many different ways, and `suggestBin` calls its capacity
 * "shared base-UoM space". A capacity of 2.5 therefore means nothing an
 * operator can act on — 2.5 of WHAT? — so the fractional case is refused
 * rather than given a unit it does not have. Comparing a whole-unit capacity
 * against a fractional on-hand still works exactly as before: both are
 * milli-units, and the comparison never needed them to share a precision.
 */
function assertWholeUnitCapacity(capacity: number): number {
  // ONE rule, at all three gates: the DTO documents `minimum: 1`, this refuses
  // anything else, and `bins_capacity_whole_units` backstops it in the
  // database. Zero is refused here too — a bin with no capacity accepts no
  // putaway, ever, and the API contract has never advertised one; accepting it
  // from a non-HTTP caller would create a bin the contract says cannot exist.
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_QUANTITY_BASE) {
    throw new ProblemException(
      'validation-failed',
      400,
      'capacity must be a whole number of units',
      `capacity is the bin's shared space across every SKU it holds, which have no single unit between them — ` +
        `so it counts WHOLE units (got ${String(capacity)}). Give it a whole number between 1 and ${MAX_QUANTITY_BASE}.`,
    );
  }
  return toMilli(capacity);
}

// ── story 11-5: the bin's capacity attributes (FR-39) ────────────────────────
// The caps live in `bin-capacity.ts` (the 11.2 `sku-attributes.ts` precedent —
// the DTO mirror imports them without pulling this command's module graph).
import { MAX_BIN_DIMENSION_MM, MAX_BIN_WEIGHT_GRAMS } from './bin-capacity';

/**
 * The bin's optional capacity attribute fields a write edge may carry.
 * Absent (`undefined`) and cleared (`null`) are both legal and skip the value
 * rules — the create/grid verbs treat both as "unconstrained" (nothing to
 * leave unchanged on a fresh row), the PATCH verb reads absent as
 * "leave unchanged" and null as "clear". `undefined` is spelled out because
 * the repo compiles with `exactOptionalPropertyTypes`.
 */
export interface BinCapacityAttributeFields {
  readonly lengthMm?: number | null | undefined;
  readonly widthMm?: number | null | undefined;
  readonly heightMm?: number | null | undefined;
  readonly maxWeightGrams?: number | null | undefined;
}

/** One numeric attribute: its field name, its ceiling, the unit its messages name. */
interface BinAttributeSpec {
  readonly key: 'lengthMm' | 'widthMm' | 'heightMm' | 'maxWeightGrams';
  readonly cap: number;
  readonly unit: string;
}

const BIN_CAPACITY_ATTRIBUTES: readonly BinAttributeSpec[] = [
  { key: 'lengthMm', cap: MAX_BIN_DIMENSION_MM, unit: 'millimetres' },
  { key: 'widthMm', cap: MAX_BIN_DIMENSION_MM, unit: 'millimetres' },
  { key: 'heightMm', cap: MAX_BIN_DIMENSION_MM, unit: 'millimetres' },
  { key: 'maxWeightGrams', cap: MAX_BIN_WEIGHT_GRAMS, unit: 'grams' },
];

/**
 * The one write-edge gate for the bin's capacity attributes —
 * `assertWholeUnitCapacity`'s sibling and `assertSkuAttributes`' mirror
 * (story 11.2's one-validator pattern). Every create/grid/PATCH write path
 * calls it, behind the replay lookup (the 10.2 rule — a refusal in front of
 * the replay would answer 400 to an op that already committed). Absent and
 * null skip the check; anything present must be a positive WHOLE number
 * within the cap (a fraction is refused, never rounded), and the DTO mirrors
 * the same bounds — a mirror, not a boundary.
 *
 * Pure SHAPE check — it needs no database row. Where it RUNS is decided by
 * the 10.2 rule, not by this function.
 */
export function assertBinCapacityAttributes(fields: BinCapacityAttributeFields): void {
  for (const { key, cap, unit } of BIN_CAPACITY_ATTRIBUTES) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > cap) {
      throw new ProblemException(
        'validation-failed',
        400,
        `${key} is not a recordable bin capacity`,
        `${key} must be a positive whole number of ${unit}, at most ${cap} — got ${String(value)}. ` +
          `A bin's physical capacity is whole ${unit}, never a fraction and never negative.`,
      );
    }
  }
}

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
        // Story 11-5: an absent attribute stores as null (unconstrained) —
        // creation has no "leave unchanged" reading, so absent and null agree.
        lengthMm: command.lengthMm ?? null,
        widthMm: command.widthMm ?? null,
        heightMm: command.heightMm ?? null,
        maxWeightGrams: command.maxWeightGrams ?? null,
        // Story 12-1: absent stores 'ambient' (the column default, spelled
        // out — never an explicit null; the NOT NULL column has no clear verb).
        storageClass: command.storageClass ?? 'ambient',
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
    // Story 10.1: `binFromRow` is the module's only bin read shape — base
    // units leave here, milli-units stay below.
    capacity: fromMilli(row.capacity),
    // Story 11-5: the physical capacity echoes as raw integers (the 11.2
    // SKU-attribute precedent — attributes are facts, not quantities).
    lengthMm: row.lengthMm,
    widthMm: row.widthMm,
    heightMm: row.heightMm,
    maxWeightGrams: row.maxWeightGrams,
    // Story 12-1: the controlled-vocabulary class (required in the snapshot).
    storageClass: row.storageClass,
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