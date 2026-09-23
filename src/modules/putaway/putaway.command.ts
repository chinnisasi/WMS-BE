import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  batches,
  batchOnHand,
  bins,
  devices,
  goodsReceiptLines,
  goodsReceiptNotes,
  idempotencyKeys,
  putawayPlacements,
  serials,
  skus,
  stockOnHand,
} from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import {
  MAX_QUANTITY_MILLI,
  QUANTITY_DECIMALS,
  QUANTITY_SCALE,
  assertRecordableQuantity,
  fromMilli,
  signedQuantity,
} from '../../shared/primitives/quantity';
import { uomPrecision } from '../catalog/uom';
import { assertUtcIso, nowIso } from '../../shared/primitives/time';
// Story 12-1 — the ONE conformance predicate + the placement refusal factory.
// Shared with pick, the pool filter, merge and the class-edit guards by
// design: the matching rule is encoded exactly once.
import {
  binStorageMismatch,
  storageClassSatisfies,
} from '../../shared/primitives/storage-class';
// Story 12-2 — the ONE segregation predicate + the co-location refusal
// factory. Same one-source rule as the storage-class predicate: the matrix
// is encoded exactly once, in TS.
import {
  hazardClassesCompatible,
  segregationConflict,
} from '../../shared/primitives/hazard';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { deviceRevoked } from '../tenancy/enrollment.command';
import { ensureReceivingBinInTx } from '../tenancy/receiving-bin';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertPermission } from '../tenancy/permissions';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';

// ── command inputs ───────────────────────────────────────────────────────────

/**
 * The fixed mismatch-reason enum (the I/O matrix — 400 outside it): required
 * in the placement payload whenever the actual bin differs from the
 * server's re-derived suggestion. The `blindReasonCode` pattern — fixed,
 * required, report- and summary-labelable (SM-3).
 */
export const PUTAWAY_MISMATCH_REASON_CODES = [
  'pallet-too-heavy',
  'suggested-bin-occupied',
  'consolidation-with-existing-stock',
  'operator-preference',
  'other',
] as const;
export type PutawayMismatchReasonCode = (typeof PUTAWAY_MISMATCH_REASON_CODES)[number];

export interface PlacePutawayCommand {
  readonly tenantId: string;
  readonly deviceId: string;
  /** The badge-in operator — authority is re-read from the DB at command entry. */
  readonly operatorUserId: string;
  readonly warehouseId: string;
  /** The GRN (and line) whose applied stock this placement moves. */
  readonly grnId: string;
  readonly grnLineId: string;
  readonly skuId: string;
  /** The catalog batch identity — null on non-batch-tracked SKUs. */
  readonly batchId: string | null;
  /** The placed quantity in base UoM, at the unit's declared precision (partial placements allowed). */
  readonly qty: number;
  /** The target bin the operator scanned/entered. */
  readonly toBinId: string;
  /** The mismatch reason — required when the target differs from the suggestion. */
  readonly reasonCode: string | null;
  /** Device time (AD-1) — the ledger event's and placement's business time. */
  readonly occurredAt: string;
  /**
   * The raw serial numbers of a serial-tracked placement (one event per
   * unit, mirroring `stock.adjustment`'s serials pattern). Resolved to
   * catalog identities inside the command transaction.
   */
  readonly serials?: readonly string[] | undefined;
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** One placement as every surface returns it (the idempotency snapshot). */
export interface PutawayPlacementSnapshot {
  readonly placement: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly grnId: string;
    readonly grnCode: string;
    readonly grnLineId: string;
    readonly skuId: string;
    readonly skuCode: string;
    readonly batchId: string | null;
    readonly batchCode: string | null;
    readonly qty: number;
    readonly fromBinId: string;
    readonly toBinId: string;
    readonly toBinCode: string;
    readonly suggestedBinId: string | null;
    readonly suggestedBinCode: string | null;
    readonly reasonCode: string | null;
    readonly placedBy: string;
    readonly placedAt: string;
    readonly deviceId: string;
    readonly createdAt: string;
  };
}

/** One placement of the web placements-list read. */
export interface PutawayPlacementEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly grnId: string;
  readonly grnCode: string;
  readonly grnLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly batchId: string | null;
  readonly batchCode: string | null;
  readonly qty: number;
  readonly fromBinId: string;
  readonly toBinId: string;
  readonly toBinCode: string;
  readonly suggestedBinId: string | null;
  readonly suggestedBinCode: string | null;
  readonly reasonCode: string | null;
  readonly placedBy: string;
  readonly placedAt: string;
  readonly deviceId: string;
  readonly createdAt: string;
}

export interface ListPlacementsQuery {
  readonly warehouseId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * The line-quantity ceiling, in milli-units (story 10.1): the column is
 * `bigint`, but the binding limit is the 2⁵³ exact-integer ceiling every
 * quantity crosses in JavaScript and in the Valkey script's Lua. A larger
 * (but typable) quantity must be a 400, never an insert-time 500 — or worse,
 * a silent rounding.
 */
export const MAX_PLACEMENT_QTY = MAX_QUANTITY_MILLI;

/**
 * The directed-putaway command (Story 3.5): `putaway.place`, a
 * device-authenticated idempotent command (the `grn.submit` pattern —
 * DeviceSessionGuard at the shell, badge-in session, real authority re-read
 * inside the command tx). The placement is a REAL ledger movement: the stock
 * leaves the warehouse's system Receiving bin into the operator's target bin
 * (one `putaway.placed` event per batch arm, or per serial unit on a
 * serial-tracked SKU — never a direct `stock_on_hand` write), the placement
 * row records suggestion-vs-actual + reason for the SM-3 report, and the
 * in-tx outbox publishes `putaway.recorded`.
 *
 * Invariant order (the established command shape) inside
 * `withTenantTransaction`: device re-read fail-closed → role re-read →
 * `assertPermission('putaway.execute')` → idempotency replay → validation →
 * movement → placement row → in-tx outbox → audit → idempotency-key
 * snapshot.
 *
 * Guards are server-side truth (AD-4/AD-10): the suggestion is RE-DERIVED at
 * placement time (the snapshot's baked-in suggestion is advisory), and the
 * capacity/block/system-bin/remaining checks run here — a mismatched
 * placement (a diverged replay, a concurrently drained Receiving bin) fails
 * deterministically: over-place is a 400 naming the remaining quantity; a
 * losing ledger race is the 422 `insufficient-on-hand` quarantine, never a
 * corrupted projection.
 */
@Injectable()
export class PutawayCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition at the command layer through the facade only
    // (AD-6): the ledger movements (and their projections) via the inventory
    // facade's in-transaction passthrough.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  /**
   * `putaway.place` — one idempotent server command per placement. The
   * client-generated ULID (`Idempotency-Key` = the queued op's id) replays
   * exactly once: same key + payload re-serves the original snapshot, same
   * key + different payload is the deterministic 422.
   */
  async placePutaway(
    command: PlacePutawayCommand,
    idempotencyKey: string,
  ): Promise<PutawayPlacementSnapshot> {
    // ── story 10.2: this fingerprint is over BASE units ────────────────────
    // Conversion moved out of the controller and into the command, behind the
    // replay lookup, so the hashed value changed with it: a key written by a
    // pre-10.2 build hashed MILLI-units and now answers 422
    // `idempotency-key-reuse` rather than replaying. Accepted deliberately
    // under the pre-launch premise — the same call story 10.1 made about the
    // ledger hash chain — and pinned as EXPECTED by the cross-version replay
    // guard in `test/picking.spec.ts`, so it is a recorded break and not a
    // surprise. No compatibility branch exists; there is nothing to be
    // compatible with.
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      deviceId: command.deviceId,
      operatorUserId: command.operatorUserId,
      warehouseId: command.warehouseId,
      grnId: command.grnId,
      grnLineId: command.grnLineId,
      skuId: command.skuId,
      batchId: command.batchId,
      qty: command.qty,
      toBinId: command.toBinId,
      reasonCode: command.reasonCode,
      occurredAt: command.occurredAt,
      // The RAW serial numbers fingerprint (never the resolved ids) — a
      // retry of the same request body replays regardless of current state.
      serials: command.serials === undefined ? undefined : [...command.serials],
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── device re-authorization (fail-closed, the grn.submit mirror) ────
      const deviceRows = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.id, command.deviceId), eq(devices.tenantId, command.tenantId)))
        .for('update')
        .limit(1);
      const device = deviceRows[0];
      if (!device || device.status !== 'active' || device.pinHash === null) {
        throw deviceRevoked();
      }

      // Role re-read from the DB per command — the token is transport, never
      // authority (AD-10). `putaway.execute` is the first non-empty operator
      // capability: owner/ops_manager/operator pass, accountant is denied.
      const role = await getMemberRoleIn(tx, command.tenantId, command.operatorUserId);
      assertPermission(role, 'putaway.execute');

      // ── idempotency replay (before any write) ───────────────────────────
      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.tenantId, command.tenantId), eq(idempotencyKeys.key, idempotencyKey)),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].payloadHash !== payloadHash) {
          throw idempotencyKeyReuse();
        }
        return existing[0].responseSnapshot as PutawayPlacementSnapshot;
      }

      // ── input validation (400 before any write) ────────────────────────
      const occurredAt = assertUtc(command.occurredAt, 'occurredAt');
      // Story 10.2: `command.qty` is in BASE units here — shape and range
      // only. The unit's own precision is asked below, once the SKU row is
      // read, which keeps that refusal behind the replay lookup above.
      if (!(command.qty > 0)) {
        throw putawayValidation(
          `Placement quantity must be a positive quantity (got ${String(command.qty)}).`,
        );
      }
      if (command.qty > fromMilli(MAX_PLACEMENT_QTY)) {
        throw putawayValidation(
          `Placement quantity must be at most ${fromMilli(MAX_PLACEMENT_QTY)} (got ${String(command.qty)}).`,
        );
      }
      if (command.reasonCode !== null && !isMismatchReason(command.reasonCode)) {
        throw putawayValidation(
          `reasonCode must be one of ${JSON.stringify(PUTAWAY_MISMATCH_REASON_CODES)} (got "${command.reasonCode}").`,
        );
      }

      // Master-data integrity in the write transaction (404 before any
      // write): warehouse in tenant, the GRN line + its GRN + the SKU.
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      const lineRows = await tx
        .select({
          grnId: goodsReceiptLines.grnId,
          skuId: goodsReceiptLines.skuId,
          batchId: goodsReceiptLines.batchId,
          appliedQty: goodsReceiptLines.appliedQty,
          grnWarehouseId: goodsReceiptNotes.warehouseId,
          grnCode: goodsReceiptNotes.code,
        })
        .from(goodsReceiptLines)
        .innerJoin(goodsReceiptNotes, eq(goodsReceiptNotes.id, goodsReceiptLines.grnId))
        .where(
          and(
            eq(goodsReceiptLines.id, command.grnLineId),
            eq(goodsReceiptLines.tenantId, command.tenantId),
          ),
        )
        .limit(1);
      const line = lineRows[0];
      if (line === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'GRN line not found',
          `No goods receipt line with id "${command.grnLineId}" exists in this tenant.`,
        );
      }
      if (line.grnId !== command.grnId) {
        throw putawayValidation(`GRN line "${command.grnLineId}" does not belong to goods receipt "${command.grnId}".`);
      }
      if (line.grnWarehouseId !== command.warehouseId) {
        throw putawayValidation(
          `Goods receipt "${line.grnCode}" was recorded in warehouse "${line.grnWarehouseId}", not "${command.warehouseId}".`,
        );
      }
      if (line.skuId !== command.skuId) {
        throw putawayValidation(
          `GRN line "${command.grnLineId}" is for SKU "${line.skuId}", not "${command.skuId}" — the wrong item cannot be placed.`,
        );
      }
      if (line.appliedQty <= 0) {
        throw putawayValidation(
          `GRN line "${command.grnLineId}" applied 0 units — nothing was put into the Receiving bin to place.`,
        );
      }
      const skuRows = await tx
        .select({
          id: skus.id,
          code: skus.code,
          uom: skus.uom,
          batchTracked: skus.batchTracked,
          serialTracked: skus.serialTracked,
          // Story 11-5: the static attributes the weight/volume/dim-fit gates
          // consume (null = contributes units only).
          weightGrams: skus.weightGrams,
          lengthMm: skus.lengthMm,
          widthMm: skus.widthMm,
          heightMm: skus.heightMm,
          // Story 12-1 — the class the placement gate and the re-derived
          // suggestion both consume.
          storageClass: skus.storageClass,
          // Story 12-2 — the hazard class the co-location gate and the
          // re-derived suggestion consume (null = carries no rule).
          hazardClass: skus.hazardClass,
        })
        .from(skus)
        .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
        .limit(1);
      const sku = skuRows[0];
      if (sku === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'SKU not found',
          `No SKU with id "${command.skuId}" exists in this tenant.`,
        );
      }
      if (sku.id !== line.skuId) {
        throw putawayValidation(`SKU "${command.skuId}" does not match the GRN line's SKU "${line.skuId}".`);
      }

      // ── story 10.2: conversion and the precision refusal, HERE ──────────
      // Behind the replay lookup and behind the SKU read, because the unit is
      // what says how precise this placement may be. `scaled` is the only
      // quantity anything below reads; `command.qty` is base units and is not
      // touched again.
      const scaled: PlacePutawayCommand = {
        ...command,
        qty: assertRecordableQuantity(command.qty, 'qty', sku.uom, uomPrecision(sku.uom)),
      };

      // ── the batch arm (batch-tracked SKUs) ──────────────────────────────
      let batchId: string | null = null;
      let batchCode: string | null = null;
      if (sku.batchTracked) {
        if (command.batchId === null) {
          throw putawayValidation(`SKU "${sku.code}" is batch-tracked — its placement needs a batch.`);
        }
        const batchRows = await tx
          .select({ id: batches.id, code: batches.code })
          .from(batches)
          .where(
            and(
              eq(batches.id, command.batchId),
              eq(batches.tenantId, command.tenantId),
              eq(batches.skuId, command.skuId),
            ),
          )
          .limit(1);
        const batch = batchRows[0];
        if (batch === undefined) {
          throw new ProblemException(
            'not-found',
            404,
            'Batch not found',
            `No batch with id "${command.batchId}" exists for SKU "${sku.code}" in this tenant.`,
          );
        }
        batchId = batch.id;
        batchCode = batch.code;
      } else if (command.batchId !== null) {
        throw putawayValidation(`SKU "${sku.code}" is not batch-tracked — its placement carries no batch.`);
      }
      // The batch identity must be the GRN line's — a batch from another line
      // of the same SKU would record the placement against the wrong line.
      if (line.batchId !== batchId) {
        throw putawayValidation(
          `Batch "${command.batchId}" is not GRN line "${command.grnLineId}"'s batch ("${line.batchId ?? 'none'}").`,
        );
      }

      // ── the serial arm (serial-tracked SKUs, the stock.adjustment mirror) ─
      // Shape backstops first (the stock.adjustment arms), then serial
      // identity resolves inside the command tx and must already exist — a
      // placement moves intaken stock, it creates none; the ledger's own
      // guards (duplicate-serial / serial-elsewhere / 404) are the
      // location-truth backstops at append time.
      let serials: readonly string[] = [];
      if (sku.serialTracked) {
        if (command.serials === undefined || command.serials.length === 0) {
          throw putawayValidation(
            `SKU "${sku.code}" is serial-tracked — its placement needs one serial per unit (${fromMilli(scaled.qty)}).`,
          );
        }
        if (new Set(command.serials).size !== command.serials.length) {
          throw putawayValidation(
            'serials contains duplicates — a serial-tracked placement writes one ledger event per serial unit; the same serial cannot appear twice.',
          );
        }
        // Story 10.1: an array length is a UNIT count, so the comparison is
        // made in units, never in milli-units. A serial-tracked SKU is pinned
        // to a 0-dp UoM at catalog entry, so this is always whole.
        if (command.serials.length !== fromMilli(scaled.qty)) {
          throw putawayValidation(
            `A serial-tracked placement writes one ledger event per serial unit — ${command.serials.length} serials cannot place ${fromMilli(scaled.qty)} units.`,
          );
        }
        serials = command.serials;
      } else if (command.serials !== undefined && command.serials.length > 0) {
        throw putawayValidation(`SKU "${sku.code}" is not serial-tracked — its placement carries no serials.`);
      }
      const serialRefs =
        serials.length === 0 ? [] : await resolveSerialRefsInTx(tx, command.tenantId, command.skuId, serials);

      // ── the receiving bin (the from-bin identity) ───────────────────────
      const receivingBin = await ensureReceivingBinInTx(tx, command.tenantId, command.warehouseId);

      // ── the remaining check (min(applied, receiving-bin on-hand)) ───────
      const remainingOnHand = await receivingBinOnHandInTx(
        tx,
        command.tenantId,
        command.warehouseId,
        receivingBin.binId,
        command.skuId,
        batchId,
      );
      const remaining = Math.min(line.appliedQty, remainingOnHand);
      if (scaled.qty > remaining) {
        throw putawayValidation(
          `Only ${fromMilli(remaining)} of this (sku, batch) remain in the Receiving bin for GRN line "${command.grnLineId}" — ${fromMilli(scaled.qty)} cannot be placed.`,
        );
      }

      // ── the target bin (server-side truth, mirrored on-device) ──────────
      // `for('update')` mutexes the capacity fill: the occupancy read below
      // runs before the append's advisory lock, so two concurrent placements
      // into the same bin would otherwise both pass capacity and then append
      // serially — over capacity. (The Receiving-bin drain side stays the
      // ledger's insufficiency guard; no existing path locks bin rows, so
      // bins-row → serial-lock → warehouse-lock stays acyclic.)
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
        })
        .from(bins)
        .where(
          and(
            eq(bins.id, command.toBinId),
            eq(bins.tenantId, command.tenantId),
            eq(bins.warehouseId, command.warehouseId),
          ),
        )
        .for('update')
        .limit(1);
      const targetBin = binRows[0];
      if (targetBin === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Bin not found',
          `No bin with id "${command.toBinId}" exists in this warehouse.`,
        );
      }
      if (targetBin.systemOwned) {
        throw putawayValidation(
          `Bin "${targetBin.code}" is a system bin (Receiving/QC-hold) — placements land in storage bins only.`,
        );
      }
      if (targetBin.retiredAt !== null) {
        // Story 3.6: a retired bin is operationally gone — the target-use
        // rejection (400, per the retired-bin matrix arm).
        throw binRetiredAsTarget(targetBin.code);
      }
      if (targetBin.blocked) {
        // FR-10: the rejection names the reason and the bin.
        throw binBlocked(targetBin.code);
      }
      // ── story 12-1: the class gate (FR-40) — after the structural arms,
      // before the capacity gates: a bin that cannot satisfy the SKU's storage
      // class is refused no matter how empty it is. 400
      // `bin-storage-mismatch` naming bin code, SKU code and BOTH classes —
      // device-fault, non-retryable. Same predicate, same position as
      // `candidateFitsSku`'s first gate (the SYNC HAZARD rule).
      if (!storageClassSatisfies(sku.storageClass, targetBin.storageClass)) {
        throw binStorageMismatch(
          targetBin.code,
          sku.code,
          targetBin.storageClass,
          sku.storageClass,
        );
      }
      // ── story 12-2: the hazard co-location gate (FR-41) — after the class
      // gate, before the load read, inside the bin-row `.for('update')` window
      // (a concurrent placement cannot slip an incompatible unit between the
      // scan and the write). Unlike the class rule this is SKU × SKU-in-bin:
      // the gate reads the TARGET bin's occupants' classes, so an empty bin
      // of the right class always takes hazard-capable stock. Null carries no
      // rule in either direction (the predicate's first arm). Own-sku pairs
      // are SKIPPED — the same-SKU-consolidation rule (an explosive may top
      // up its own bin), identical to merge's arm. 400
      // `bin-segregation-conflict` naming both SKU codes and both classes.
      const occupants = await occupantHazardClassesInTx(
        tx,
        command.tenantId,
        command.warehouseId,
        targetBin.id,
      );
      for (const occupant of occupants) {
        if (occupant.skuId === command.skuId) {
          continue;
        }
        if (!hazardClassesCompatible(sku.hazardClass, occupant.hazardClass)) {
          throw binSegregationConflict(
            targetBin.code,
            sku.code,
            sku.hazardClass,
            occupant.skuCode,
            occupant.hazardClass,
          );
        }
      }
      // ── the load read (the gates' shared input — one query) ─────────────
      // Story 11-5: `binOccupancyInTx` is now the load-read (units + weight +
      // volume), still inside the `.for('update')` window the unit gate
      // established. Every gate below fires on the SAME read.
      const load = await binOccupancyInTx(
        tx,
        command.tenantId,
        command.warehouseId,
        targetBin.id,
      );
      if (load.units + scaled.qty > targetBin.capacity) {
        // FR-10: the rejection names the capacity and the occupancy.
        throw binFull(targetBin.code, targetBin.capacity, load.units);
      }
      // ── story 11-5: the three new gates, AFTER the unit gate (the
      // conservative coexistence — a dimmed SKU counts toward both), ordered
      // weight → volume → dim fit. A bin without the matching limit skips the
      // gate (fail-open on missing attributes); a SKU without the attribute
      // contributes zero weight/volume.
      //
      // SYNC HAZARD: this arm list exists in THREE places that must never
      // diverge — here, `candidateFitsSku` (the suggestion + the task
      // derivation) and `mergeBin`'s target gates — because the suggestion
      // must never point at a bin the gates refuse. A fourth arm (the
      // spec's Epic 19/20 extension note predicts FR-71 ones) lands in all
      // three, in the same order.
      if (targetBin.maxWeightGrams !== null) {
        const weightLimit = BigInt(targetBin.maxWeightGrams) * BigInt(QUANTITY_SCALE);
        const weightAfter = load.weightLoad + BigInt(scaled.qty) * BigInt(sku.weightGrams ?? 0);
        if (weightAfter > weightLimit) {
          throw binOverweight(targetBin.code, targetBin.maxWeightGrams, weightAfter);
        }
      }
      if (targetBin.lengthMm !== null && targetBin.widthMm !== null && targetBin.heightMm !== null) {
        const binVolume = BigInt(targetBin.lengthMm * targetBin.widthMm * targetBin.heightMm);
        const perUnitVolume = (sku.lengthMm ?? 0) * (sku.widthMm ?? 0) * (sku.heightMm ?? 0);
        const volumeAfter = load.volumeLoad + BigInt(scaled.qty) * BigInt(perUnitVolume);
        if (volumeAfter > binVolume * BigInt(QUANTITY_SCALE)) {
          throw binVolumeExceeded(
            targetBin.code,
            targetBin.lengthMm * targetBin.widthMm * targetBin.heightMm,
            volumeAfter,
          );
        }
      }
      if (sku.lengthMm !== null && targetBin.lengthMm !== null && sku.lengthMm > targetBin.lengthMm) {
        throw binItemOversize(targetBin.code, 'length', sku.lengthMm, targetBin.lengthMm, sku.code);
      }
      if (sku.widthMm !== null && targetBin.widthMm !== null && sku.widthMm > targetBin.widthMm) {
        throw binItemOversize(targetBin.code, 'width', sku.widthMm, targetBin.widthMm, sku.code);
      }
      if (sku.heightMm !== null && targetBin.heightMm !== null && sku.heightMm > targetBin.heightMm) {
        throw binItemOversize(targetBin.code, 'height', sku.heightMm, targetBin.heightMm, sku.code);
      }

      // ── the suggestion (capacity-only v1, RE-DERIVED at placement) ──────
      const suggestion = await suggestBinInTx(
        tx,
        command.tenantId,
        command.warehouseId,
        command.skuId,
        scaled.qty,
        // Story 11-5: the same SKU attributes gate the suggestion — the
        // re-derivation never points at a bin the gates would refuse.
        // Story 12-1: the class rides with them (the class gate is
        // `candidateFitsSku`'s first gate).
        {
          weightGrams: sku.weightGrams,
          lengthMm: sku.lengthMm,
          widthMm: sku.widthMm,
          heightMm: sku.heightMm,
          storageClass: sku.storageClass,
          // Story 12-2 — the hazard class rides the walk; with `command.skuId`
          // (in hand at this call site) it lets `candidateFitsSku` skip the
          // moving SKU's own occupant pairs, so a top-up of the same SKU is
          // never refused for co-locating with itself.
          hazardClass: sku.hazardClass,
        },
      );
      const suggestedBinId = suggestion?.binId ?? null;
      if (suggestedBinId !== command.toBinId && command.reasonCode === null) {
        throw putawayValidation(
          `Placing into "${targetBin.code}" differs from the suggested bin — a reason code from ${JSON.stringify(PUTAWAY_MISMATCH_REASON_CODES)} is required.`,
        );
      }
      // The recorded reason: a stale reason on a match is STRIPPED, not
      // rejected — the server's re-derived suggestion legitimately differs
      // from the device's task-level suggestion (a stale snapshot), so a
      // target that equals the server's suggestion carries no reason.
      const recordedReason = suggestedBinId === command.toBinId ? null : command.reasonCode;

      // ── the movements (Receiving bin → target, one event per arm) ───────
      // AD-1: the row's placedAt is the DEVICE time (the GRN-note pattern:
      // device time + server recordedAt); the ledger's recordedAt and the
      // row's createdAt stay the server commit time.
      const recordedAt = nowIso();
      const placedAt = occurredAt;
      const referenceDoc = {
        kind: 'putaway' as const,
        grnId: command.grnId,
        grnLineId: command.grnLineId,
        ...(recordedReason === null ? {} : { reasonCode: recordedReason }),
        ...(suggestedBinId === null ? {} : { suggestedBinId }),
      };
      if (serialRefs.length > 0) {
        // Serial-tracked: lock the whole set tenant-wide in sorted order
        // BEFORE the first append (the stock.adjustment deadlock rule), then
        // one event per serial unit — magnitude 1 each with BOTH bin arms
        // carried (the qc.held two-arm convention: the fold +1s the target
        // and −1s the Receiving bin).
        await this.inventory.lockSerialsInTx(tx, command.tenantId, serialRefs);
        for (const serialRef of serialRefs) {
          await this.inventory.appendLedgerEventInTx(tx, {
            tenantId: command.tenantId,
            warehouseId: command.warehouseId,
            type: 'putaway.placed',
            skuId: command.skuId,
            // One serial is one whole unit — `QUANTITY_SCALE` milli-units.
            quantityDelta: signedQuantity(QUANTITY_SCALE),
            fromBinId: receivingBin.binId,
            toBinId: targetBin.id,
            // The batch arm rides the per-serial events too (the receiving
            // and adjustment per-serial events do) — a batch+serial-tracked
            // placement must drain the batch arm of the Receiving bin, or
            // the derived tasks keep promising moved stock.
            batchRef: batchId,
            serialRef,
            actorUserId: command.operatorUserId,
            occurredAt,
            recordedAt,
            referenceDoc,
          });
        }
      } else {
        // One event per batch arm: a batch-tracked placement carries its
        // batch identity; an untracked SKU moves on one `batchRef: null`
        // event. Both bin arms ride the single event (the fold is per
        // sku/batch/bin — one event, one transaction, both projections).
        await this.inventory.appendLedgerEventInTx(tx, {
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          type: 'putaway.placed',
          skuId: command.skuId,
          quantityDelta: signedQuantity(scaled.qty),
          fromBinId: receivingBin.binId,
          toBinId: targetBin.id,
          batchRef: batchId,
          serialRef: null,
          actorUserId: command.operatorUserId,
          occurredAt,
          recordedAt,
          referenceDoc,
        });
      }

      // ── the placement row (the decision record) ─────────────────────────
      const placementId = uuidv7();
      await tx.insert(putawayPlacements).values({
        id: placementId,
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        grnId: command.grnId,
        grnLineId: command.grnLineId,
        skuId: command.skuId,
        batchId,
        qty: scaled.qty,
        fromBinId: receivingBin.binId,
        toBinId: targetBin.id,
        suggestedBinId,
        reasonCode: recordedReason,
        placedBy: command.operatorUserId,
        placedAt,
        deviceId: command.deviceId,
      });

      const snapshot: PutawayPlacementSnapshot = {
        placement: {
          id: placementId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          grnId: command.grnId,
          grnCode: line.grnCode,
          grnLineId: command.grnLineId,
          skuId: command.skuId,
          skuCode: sku.code,
          batchId,
          batchCode,
          // Story 10.1: the snapshot IS the HTTP body (and the idempotent
          // replay's stored copy) — base units on the way out.
          qty: fromMilli(scaled.qty),
          fromBinId: receivingBin.binId,
          toBinId: targetBin.id,
          toBinCode: targetBin.code,
          suggestedBinId,
          suggestedBinCode: suggestion?.binCode ?? null,
          reasonCode: recordedReason,
          placedBy: command.operatorUserId,
          placedAt,
          deviceId: command.deviceId,
          createdAt: recordedAt,
        },
      };

      // ── in-transaction outbox append (AD-7) ─────────────────────────────
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'putaway.recorded',
        occurredAt: placedAt,
        payload: {
          placementId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          grnId: command.grnId,
          grnCode: line.grnCode,
          grnLineId: command.grnLineId,
          skuId: command.skuId,
          batchId,
          // The outbox contract is base units too (story 10.1).
          qty: fromMilli(scaled.qty),
          fromBinId: receivingBin.binId,
          toBinId: targetBin.id,
          suggestedBinId,
          reasonCode: recordedReason,
          placedBy: command.operatorUserId,
          placedAt,
        },
      });

      // ── the audit row ───────────────────────────────────────────────────
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.operatorUserId,
        action: 'putaway.placed',
        targetType: 'putaway_placement',
        targetId: placementId,
        reference: idempotencyKey,
        occurredAt: placedAt,
      });

      // ── device heartbeat + idempotency key (the invariant order's tail) ──
      await tx
        .update(devices)
        .set({ lastSeenAt: nowIso(), updatedAt: nowIso() })
        .where(eq(devices.id, command.deviceId));

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: unknown,
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({
        id: uuidv7(),
        tenantId,
        key: idempotencyKey,
        payloadHash,
        responseSnapshot: snapshot,
      });
    } catch (err) {
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        // Concurrent duplicate of the same idempotent request — the winner's
        // response is authoritative; this request carries no new state.
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

// ── shared derivation helpers (module-level, read-only) ──────────────────────

/** True when the value is inside the fixed mismatch-reason enum. */
export function isMismatchReason(value: string): value is PutawayMismatchReasonCode {
  return (PUTAWAY_MISMATCH_REASON_CODES as readonly string[]).includes(value);
}

/**
 * The capacity-only v1 suggestion (the recorded FR-10 deviation): among the
 * warehouse's storage bins — not blocked, not system-owned — with room for
 * the line's quantity (story 11-5: which fit the unit, weight, volume and
 * dim-fit gates together — `candidateFitsSku`), the LOWEST occupancy wins,
 * then bin code order. No velocity class, no zone affinity, no nightly job
 * (those ship with the deferred report story).
 */
export async function suggestBinInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  skuId: string,
  qty: number,
  skuAttrs: SkuPhysicalAttributes,
): Promise<{ binId: string; binCode: string; rationale: string } | null> {
  const candidates = await binCandidatesInTx(tx, tenantId, warehouseId);
  for (const candidate of candidates) {
    // Story 12-2: the hazard arm needs the moving SKU's identity to skip its
    // own occupant pairs (the same-SKU-consolidation rule).
    if (candidateFitsSku(candidate, skuAttrs, qty, skuId)) {
      const room = candidate.capacity - candidate.occupancy;
      return {
        binId: candidate.binId,
        binCode: candidate.binCode,
        // The rationale is operator-facing text: it speaks base units.
        rationale: `Lowest occupancy (${fromMilli(candidate.occupancy)}/${fromMilli(candidate.capacity)}) — room for ${fromMilli(room)}`,
      };
    }
  }
  return null;
}

export interface PutawayBinCandidate {
  readonly binId: string;
  readonly binCode: string;
  readonly capacity: number;
  readonly occupancy: number;
  // ── story 11-5: the bin's physical limits + current weight/volume load ───
  readonly lengthMm: number | null;
  readonly widthMm: number | null;
  readonly heightMm: number | null;
  readonly maxWeightGrams: number | null;
  readonly weightLoad: bigint;
  readonly volumeLoad: bigint;
  // ── story 12-1: the bin's storage class (FR-40) — the candidate list stays
  // SKU-agnostic (no WHERE arm); the class rule runs per candidate in
  // `candidateFitsSku`, against the SKU side carried in `SkuPhysicalAttributes`.
  readonly storageClass: string;
  // ── story 12-2: the bin's hazardous occupants as (skuId, hazardClass)
  // PAIRS — not a class list (a class-only aggregate cannot skip the moving
  // SKU's own pairs, and counts drained residue). Aggregated over `quantity >
  // 0` occupants with a non-null class (drained rows persist — `addToOnHand`
  // upserts, never deletes — so a stale class would refuse placements the
  // gate admits); the list stays SKU-agnostic (no WHERE arm — the projection
  // is richer, the rule still runs per-candidate on the SKU side).
  readonly occupants: readonly { readonly skuId: string; readonly hazardClass: string }[];
}

/**
 * The SKU side of the fit predicate — the static physical attributes a
 * placement or task-derivation read carries. The four physical fields are
 * nullable: a SKU without attributes contributes only units (fail-open on
 * missing attributes). `storageClass` (story 12-1) is NOT nullable — the
 * column is NOT NULL DEFAULT 'ambient', so every read has it.
 */
export interface SkuPhysicalAttributes {
  readonly weightGrams: number | null;
  readonly lengthMm: number | null;
  readonly widthMm: number | null;
  readonly heightMm: number | null;
  /** Story 12-1 — the SKU's class from the controlled vocabulary. */
  readonly storageClass: string;
  /**
   * Story 12-2 — the SKU's hazard class (FR-41), nullable: a null class
   * carries no rule in either direction of the segregation matrix.
   */
  readonly hazardClass: string | null;
}

/**
 * Story 11-5 — the ONE fit predicate all three suggestion consumers share
 * (the suggestion, the placement's re-derivation, the task derivation): a bin
 * fits a (SKU, qty) when every declared gate passes. Full when ANY declared
 * gate trips:
 *
 * - unit gate — occupancy + qty ≤ capacity (unchanged, always declared);
 * - weight gate — load + qty×weight ≤ maxWeightGrams × 1000 (milli-scaled:
 *   qty is milli-units and weight is grams, so the load is milli-grams);
 * - volume gate — load + qty×(l×w×h) ≤ (L×W×H) × 1000; binds only when the
 *   bin declares all three dims (a half-dimensioned bin cannot bound volume);
 * - dim fit — the SKU's dimension never exceeds the bin's same dimension,
 *   checked per-dimension, both sides present (oversize binds only when both
 *   sides are dimensioned).
 *
 * A SKU with no attributes contributes zero weight and zero volume, so the
 * three new gates pass wherever the unit gate passes — byte-identical to
 * pre-11.5 behavior. A dimmed SKU double-counts (units AND weight/volume) —
 * the deliberate conservative coexistence (see the spec's Design Notes).
 *
 * Story 12-1 adds the CLASS gate — FIRST, before the unit gate, because a
 * bin that cannot satisfy the SKU's storage class is refused no matter how
 * empty it is (FR-40). The rule is `storageClassSatisfies` — the ONE shared
 * predicate (the temperature hierarchy); no SQL copy exists, the candidate
 * list is SKU-agnostic. The same arm exists in the placement command's own
 * locked-row guard and `mergeBin`'s target loop — the SYNC HAZARD rule.
 *
 * Story 12-2 adds the HAZARD co-location arm (FR-41) — SECOND, after the
 * class gate: for each of the bin's hazardous-occupant PAIRS, skip the
 * moving SKU's OWN pair (`skuId === movingSkuId` — the same-SKU-consolidation
 * rule the placement and merge gates carry; an explosive may top up its own
 * bin) and refuse the candidate when any other occupant's class is
 * incompatible with the moving SKU's (`hazardClassesCompatible` — null
 * carries no rule in either direction, checked before the explosive
 * universal rule). The same arm exists in the placement command's own
 * locked-row guard and `mergeBin`'s target gate — the SYNC HAZARD rule.
 */
export function candidateFitsSku(
  candidate: PutawayBinCandidate,
  sku: SkuPhysicalAttributes,
  qtyMilli: number,
  movingSkuId: string,
): boolean {
  if (!storageClassSatisfies(sku.storageClass, candidate.storageClass)) {
    return false;
  }
  for (const occupant of candidate.occupants) {
    if (occupant.skuId === movingSkuId) {
      continue;
    }
    if (!hazardClassesCompatible(sku.hazardClass, occupant.hazardClass)) {
      return false;
    }
  }
  if (candidate.occupancy + qtyMilli > candidate.capacity) {
    return false;
  }
  if (candidate.maxWeightGrams !== null) {
    const weightLimit = BigInt(candidate.maxWeightGrams) * BigInt(QUANTITY_SCALE);
    const weightAfter = candidate.weightLoad + BigInt(qtyMilli) * BigInt(sku.weightGrams ?? 0);
    if (weightAfter > weightLimit) {
      return false;
    }
  }
  if (candidate.lengthMm !== null && candidate.widthMm !== null && candidate.heightMm !== null) {
    const binVolume = BigInt(
      candidate.lengthMm * candidate.widthMm * candidate.heightMm,
    );
    const perUnitVolume = (sku.lengthMm ?? 0) * (sku.widthMm ?? 0) * (sku.heightMm ?? 0);
    if (candidate.volumeLoad + BigInt(qtyMilli) * BigInt(perUnitVolume) > binVolume * BigInt(QUANTITY_SCALE)) {
      return false;
    }
  }
  if (sku.lengthMm !== null && candidate.lengthMm !== null && sku.lengthMm > candidate.lengthMm) {
    return false;
  }
  if (sku.widthMm !== null && candidate.widthMm !== null && sku.widthMm > candidate.widthMm) {
    return false;
  }
  if (sku.heightMm !== null && candidate.heightMm !== null && sku.heightMm > candidate.heightMm) {
    return false;
  }
  return true;
}

/**
 * The warehouse's putaway-eligible bins (not blocked, not system-owned, not
 * retired — Story 3.6), ranked lowest occupancy then bin code — the
 * suggestion's input order. Occupancy is the bin's total on-hand across
 * every SKU (capacity is shared base-UoM space), folded in one grouped query;
 * story 11-5 adds the bins' physical limits and the same load-read's
 * weight/volume sums, so the fit predicate can run per candidate.
 */
export async function binCandidatesInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
): Promise<PutawayBinCandidate[]> {
  const rows = await tx
    .select({
      binId: bins.id,
      binCode: bins.code,
      capacity: bins.capacity,
      lengthMm: bins.lengthMm,
      widthMm: bins.widthMm,
      heightMm: bins.heightMm,
      maxWeightGrams: bins.maxWeightGrams,
      // Story 12-1 — the class rides the candidate so the fit predicate can
      // rule per (SKU, bin); no WHERE arm, the list is SKU-agnostic.
      storageClass: bins.storageClass,
      // Story 12-2 — the bin's hazardous occupants as (skuId, hazardClass)
      // pairs, one aggregate through the join below (no second query, no
      // N+1). The FILTER carries `quantity > 0` (drained rows persist —
      // `addToOnHand` upserts, never deletes — and a stale class would
      // refuse placements the gate admits) and a non-null class (a null
      // carries no rule). Bins with no hazardous occupants aggregate to
      // '[]'.
      occupants: sql<string>`coalesce(jsonb_agg(jsonb_build_array(${stockOnHand.skuId}, ${skus.hazardClass})) filter (where ${stockOnHand.quantity} > 0 and ${skus.hazardClass} is not null), '[]'::jsonb)::text`,
      occupancy: sql<string>`coalesce(sum(${stockOnHand.quantity}), 0)::bigint`,
      weightLoad: sql<string>`coalesce(sum(${stockOnHand.quantity}::numeric * coalesce(${skus.weightGrams}, 0)), 0)::numeric`,
      volumeLoad: sql<string>`coalesce(sum(${stockOnHand.quantity}::numeric * (coalesce(${skus.lengthMm}, 0) * coalesce(${skus.widthMm}, 0) * coalesce(${skus.heightMm}, 0))), 0)::numeric`,
    })
    .from(bins)
    .leftJoin(
      stockOnHand,
      and(
        eq(stockOnHand.binId, bins.id),
        eq(stockOnHand.tenantId, tenantId),
        eq(stockOnHand.warehouseId, warehouseId),
      ),
    )
    .leftJoin(skus, eq(skus.id, stockOnHand.skuId))
    .where(
      and(
        eq(bins.tenantId, tenantId),
        eq(bins.warehouseId, warehouseId),
        eq(bins.blocked, false),
        eq(bins.systemOwned, false),
        // Story 3.6: a retired bin is operationally gone — it never suggests.
        isNull(bins.retiredAt),
      ),
    )
    .groupBy(
      bins.id,
      bins.code,
      bins.capacity,
      bins.lengthMm,
      bins.widthMm,
      bins.heightMm,
      bins.maxWeightGrams,
      bins.storageClass,
    )
    .orderBy(asc(sql`coalesce(sum(${stockOnHand.quantity}), 0)`), asc(bins.code));
  return rows.map((row) => ({
    binId: row.binId,
    binCode: row.binCode,
    capacity: row.capacity,
    lengthMm: row.lengthMm,
    widthMm: row.widthMm,
    heightMm: row.heightMm,
    maxWeightGrams: row.maxWeightGrams,
    storageClass: row.storageClass,
    // The aggregate is `::text`d jsonb — parsed at the boundary, mapped to
    // the pair objects the fit predicate walks.
    occupants: (JSON.parse(row.occupants) as [string, string][]).map(
      ([skuId, hazardClass]) => ({ skuId, hazardClass }),
    ),
    occupancy: Number(row.occupancy),
    weightLoad: BigInt(row.weightLoad ?? 0),
    volumeLoad: BigInt(row.volumeLoad ?? 0),
  }));
}

/**
 * One bin's load (story 11-5): the capacity gates' shared input, read in ONE
 * grouped query joined to `skus` — `stock_on_hand` is the authoritative bin
 * quantity (the projections' plain fold; no batch arm — `batch_on_hand` is a
 * per-batch breakdown folded beside it with the SAME magnitude, not a second
 * pool).
 *
 * - `units` — the milli-unit occupancy the unit gate has always compared.
 * - `weightLoad` — Σ(qty_milli × weight_grams), a MILLI-GRAM figure (a
 *   fractional quantity contributes a fractional load); compared against
 *   `max_weight_grams × QUANTITY_SCALE`.
 * - `volumeLoad` — Σ(qty_milli × l×w×h), milli-mm³ (1 mm³ = 1 milli-ml);
 *   compared against `(L×W×H) × QUANTITY_SCALE`.
 *
 * The weight/volume sums are `::numeric`, read as string, converted to
 * BigInt at the boundary — NOT `::bigint`: a milli-quantity past 2^53 times a
 * max-dimension SKU's per-unit volume (or a max-weight SKU) overflows an
 * int8 sum, and adversarial (huge-qty × max-attr) products are exactly the
 * rows a capacity gate exists to catch. A SKU with no attributes contributes
 * nothing to either load (fail-open on missing attributes).
 */
export interface BinLoad {
  readonly units: number;
  readonly weightLoad: bigint;
  readonly volumeLoad: bigint;
}

export async function binOccupancyInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  binId: string,
): Promise<BinLoad> {
  const rows = await tx
    .select({
      units: sql<string>`coalesce(sum(${stockOnHand.quantity}), 0)::bigint`,
      weightLoad: sql<string>`coalesce(sum(${stockOnHand.quantity}::numeric * coalesce(${skus.weightGrams}, 0)), 0)::numeric`,
      volumeLoad: sql<string>`coalesce(sum(${stockOnHand.quantity}::numeric * (coalesce(${skus.lengthMm}, 0) * coalesce(${skus.widthMm}, 0) * coalesce(${skus.heightMm}, 0))), 0)::numeric`,
    })
    .from(stockOnHand)
    // LEFT join, deliberately: the units sum must stay join-independent (the
    // pre-11.5 read summed stock_on_hand unconditionally), and this read must
    // agree with `binCandidatesInTx`'s LEFT join — the repo has no FKs, so an
    // inner join would silently drop a stock row from the UNITS gate too if
    // its sku row were ever missing (11-5 review triage #5). The coalesced
    // attributes make the load sums unaffected.
    .leftJoin(skus, eq(skus.id, stockOnHand.skuId))
    .where(
      and(
        eq(stockOnHand.tenantId, tenantId),
        eq(stockOnHand.warehouseId, warehouseId),
        eq(stockOnHand.binId, binId),
      ),
    );
  return {
    units: Number(rows[0]?.units ?? 0),
    weightLoad: BigInt(rows[0]?.weightLoad ?? 0),
    volumeLoad: BigInt(rows[0]?.volumeLoad ?? 0),
  };
}

/**
 * Story 12-2 — the hazard co-location read: one bin's DISTINCT hazardous
 * occupants as (skuId, skuCode, hazardClass) rows, `quantity > 0` and a
 * non-null class only (drained rows and null-class stock carry no rule).
 * The same join shape as `binOccupancyInTx` above — one grouped query, no
 * N+1. Consumed by the placement's co-location gate (inside the bin-row
 * `.for('update')` window, with the moving SKU's own pairs skipped at the
 * call site) and by `mergeBin`'s hazard gate (target occupants, moved
 * pairs skipped per moved SKU at the call site — the helper excludes
 * nothing, so both sites own their own-sku arm).
 */
export interface OccupantHazard {
  readonly skuId: string;
  readonly skuCode: string;
  readonly hazardClass: string;
}

export async function occupantHazardClassesInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  binId: string,
): Promise<readonly OccupantHazard[]> {
  const rows = await tx
    .select({
      skuId: stockOnHand.skuId,
      skuCode: skus.code,
      hazardClass: skus.hazardClass,
    })
    .from(stockOnHand)
    // INNER join deliberately: a hazardous class is a SKU attribute — a
    // stock row with no sku row cannot name a class, and the gates that
    // consume this read rule on pairs of named classes (contrast the
    // units-sum reads, which stay LEFT-joined for capacity truth).
    .innerJoin(skus, eq(skus.id, stockOnHand.skuId))
    .where(
      and(
        eq(stockOnHand.tenantId, tenantId),
        eq(stockOnHand.warehouseId, warehouseId),
        eq(stockOnHand.binId, binId),
        gt(stockOnHand.quantity, 0),
        isNotNull(skus.hazardClass),
      ),
    )
    .groupBy(stockOnHand.skuId, skus.code, skus.hazardClass);
  // The `isNotNull` filter above is the authority, but drizzle's inferred
  // row type stays `string | null` (no SQL-side narrowing) — the boundary
  // narrows it once, here.
  return rows.map((row) => ({
    skuId: row.skuId,
    skuCode: row.skuCode,
    hazardClass: row.hazardClass as string,
  }));
}

/**
 * Story 12-2 — the SKU-edit guard's grouped read: MANY bins' hazardous
 * occupants in ONE query (the single-bin read above runs per bin — too many
 * round-trips inside the edit's `.for('update')` window). One row per
 * (binId, skuId) — the group key widens with `binId`, so a (bin, binmate)
 * pair can never come back twice and the guard's party dedupe falls out of
 * the read. Same join shape and filters as the single-bin read, minus the
 * warehouse filter (a bin id is unique — the caller's bin set is the
 * authority: non-system stocked bins and non-system hold origins).
 */
export interface OccupantHazardPair {
  readonly binId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly hazardClass: string;
}

export async function binOccupantHazardPairsInTx(
  tx: TenantTx,
  tenantId: string,
  binIds: readonly string[],
): Promise<readonly OccupantHazardPair[]> {
  if (binIds.length === 0) {
    return [];
  }
  const rows = await tx
    .select({
      binId: stockOnHand.binId,
      skuId: stockOnHand.skuId,
      skuCode: skus.code,
      hazardClass: skus.hazardClass,
    })
    .from(stockOnHand)
    // The same deliberate INNER join as the single-bin read above.
    .innerJoin(skus, eq(skus.id, stockOnHand.skuId))
    .where(
      and(
        eq(stockOnHand.tenantId, tenantId),
        inArray(stockOnHand.binId, [...binIds]),
        gt(stockOnHand.quantity, 0),
        isNotNull(skus.hazardClass),
      ),
    )
    .groupBy(stockOnHand.binId, stockOnHand.skuId, skus.code, skus.hazardClass);
  // The `isNotNull` filter above is the authority — the same one-time
  // boundary narrowing as the single-bin read.
  return rows.map((row) => ({ ...row, hazardClass: row.hazardClass as string }));
}

/**
 * The Receiving bin's on-hand for one (sku, batch) — the task "remaining"'s
 * on-hand half: the batch arm's fold on a batch-tracked SKU, the plain fold
 * otherwise (both read from the projections — the ledger's derived state).
 */
export async function receivingBinOnHandInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  receivingBinId: string,
  skuId: string,
  batchId: string | null,
): Promise<number> {
  if (batchId !== null) {
    const rows = await tx
      .select({ quantity: batchOnHand.quantity })
      .from(batchOnHand)
      .where(
        and(
          eq(batchOnHand.tenantId, tenantId),
          eq(batchOnHand.warehouseId, warehouseId),
          eq(batchOnHand.skuId, skuId),
          eq(batchOnHand.binId, receivingBinId),
          eq(batchOnHand.batchId, batchId),
        ),
      )
      .limit(1);
    return rows[0]?.quantity ?? 0;
  }
  const rows = await tx
    .select({ quantity: stockOnHand.quantity })
    .from(stockOnHand)
    .where(
      and(
        eq(stockOnHand.tenantId, tenantId),
        eq(stockOnHand.warehouseId, warehouseId),
        eq(stockOnHand.skuId, skuId),
        eq(stockOnHand.binId, receivingBinId),
      ),
    )
    .limit(1);
  return rows[0]?.quantity ?? 0;
}

/**
 * Serials named by a placement, resolved to catalog identities inside the
 * command's transaction — order-preserving. A number the catalog has never
 * seen for the SKU is a 400 (a placement moves intaken stock; it never
 * creates serial identity).
 */
export async function resolveSerialRefsInTx(
  tx: TenantTx,
  tenantId: string,
  skuId: string,
  serialNumbers: readonly string[],
): Promise<string[]> {
  const distinct = [...new Set(serialNumbers)];
  const rows =
    distinct.length === 0
      ? []
      : await tx
          .select({ id: serials.id, serialNumber: serials.serialNumber })
          .from(serials)
          .where(
            and(
              eq(serials.tenantId, tenantId),
              eq(serials.skuId, skuId),
              inArray(serials.serialNumber, distinct),
            ),
          );
  const byNumber = new Map(rows.map((row) => [row.serialNumber, row.id]));
  const resolved: string[] = [];
  for (const serial of serialNumbers) {
    const id = byNumber.get(serial);
    if (id === undefined) {
      throw putawayValidation(`Serial "${serial}" does not exist for this SKU — a placement moves intaken stock only.`);
    }
    resolved.push(id);
  }
  return resolved;
}

function putawayValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid putaway placement', detail);
}

/** The full-bin rejection (FR-10): it names the bin, the capacity, the occupancy. */
export function binFull(binCode: string, capacity: number, occupancy: number): ProblemException {
  return new ProblemException(
    'bin-full',
    400,
    'Target bin is full',
    `Bin "${binCode}" holds ${fromMilli(occupancy)} of ${fromMilli(capacity)} — placing would exceed its capacity.`,
  );
}

// ── story 11-5: the weight/volume/dim-fit rejections (binFull's siblings) ────
// Same shape: 400, named problem code, a detail naming the bin and BOTH
// numbers (the load and the limit).

/**
 * Milli-units to operator-facing text for loads that are BigInt: the plain
 * `fromMilli` takes a number and throws past 2^53, and an adversarial load
 * (huge-quantity × max-attribute) is exactly the figure these messages name.
 */
function fromMilliText(milli: bigint): string {
  const negative = milli < 0n;
  const abs = negative ? -milli : milli;
  const whole = (abs / BigInt(QUANTITY_SCALE)).toString();
  // The pad width is `QUANTITY_DECIMALS`, not a literal — the scale is
  // defined by that one number, and a pad-3 copy beside it is exactly the
  // drift the constant exists to prevent (11-5 review triage #9).
  const frac = (abs % BigInt(QUANTITY_SCALE))
    .toString()
    .padStart(QUANTITY_DECIMALS, '0')
    .replace(/0+$/, '');
  const text = frac.length === 0 ? whole : `${whole}.${frac}`;
  return negative ? `-${text}` : text;
}

/** The over-weight rejection (FR-39): it names the bin, the limit, the load. */
export function binOverweight(
  binCode: string,
  limitGrams: number,
  loadMilli: bigint,
): ProblemException {
  return new ProblemException(
    'bin-overweight',
    400,
    'Target bin would exceed its weight capacity',
    `Bin "${binCode}" carries ${fromMilliText(loadMilli)} g of its ${limitGrams} g max weight — placing would exceed its weight capacity.`,
  );
}

/**
 * The over-volume rejection (FR-39): it names the bin, the limit, the load.
 * Operator-facing load is milli-mm³ ÷ 1000 = Σ(qty_base × l×w×h) mm³.
 */
export function binVolumeExceeded(
  binCode: string,
  limitMm3: number,
  loadMilli: bigint,
): ProblemException {
  return new ProblemException(
    'bin-volume-exceeded',
    400,
    'Target bin would exceed its volumetric capacity',
    `Bin "${binCode}" holds ${fromMilliText(loadMilli)} mm³ of its ${limitMm3} mm³ — placing would exceed its volumetric capacity.`,
  );
}

/**
 * The oversize-SKU rejection (FR-39): per-dimension — a SKU dimension is
 * larger than the same bin dimension, both sides present. It names the bin,
 * the dimension and both numbers, plus the offending SKU (a merge moves many
 * SKUs; the message must say which one does not fit).
 */
export function binItemOversize(
  binCode: string,
  dimension: 'length' | 'width' | 'height',
  skuMm: number,
  binMm: number,
  skuCode: string,
): ProblemException {
  return new ProblemException(
    'bin-item-oversize',
    400,
    'SKU does not fit the bin',
    `Bin "${binCode}" is too small for SKU "${skuCode}": the bin's ${dimension} is ${binMm} mm but the SKU's ${dimension} is ${skuMm} mm.`,
  );
}

/** The blocked-bin rejection (FR-10): it names the bin. */
export function binBlocked(binCode: string): ProblemException {
  return new ProblemException(
    'bin-blocked',
    400,
    'Target bin is blocked',
    `Bin "${binCode}" is blocked — placements into it are refused until it is unblocked.`,
  );
}

/**
 * The co-location rejection (FR-41, story 12-2): 400
 * `bin-segregation-conflict` naming the bin, BOTH SKU codes and BOTH
 * classes — device-fault, non-retryable. Wraps the hazard primitive's
 * `segregationConflict` (the one refusal factory for the placement/merge
 * family); `mergeBin` builds its merge-worded detail on the same factory.
 */
export function binSegregationConflict(
  binCode: string,
  incomingSkuCode: string,
  incomingClass: string | null,
  occupantSkuCode: string,
  occupantClass: string,
): ProblemException {
  return segregationConflict(
    `Bin "${binCode}" holds SKU "${occupantSkuCode}" (${occupantClass}) — SKU "${incomingSkuCode}" ` +
      `(${incomingClass ?? 'no hazard class'}) is segregated from it (FR-41).`,
  );
}

/**
 * The retired-bin target-use rejection (Story 3.6): 400 naming the bin —
 * a retired bin is operationally gone, referenced as a target (or source)
 * it always refuses.
 */
export function binRetiredAsTarget(binCode: string): ProblemException {
  return new ProblemException(
    'bin-retired',
    400,
    'Target bin is retired',
    `Bin "${binCode}" is retired — placements into it are refused; retirement is terminal.`,
  );
}

/**
 * The retired-bin SOURCE rejection (Story 3.6): the sibling of the target arm
 * above — a merge FROM a retired bin is refused, and the message names the
 * operation (a retired bin cannot be a merge source, not just a target).
 */
export function binRetiredAsSource(binCode: string): ProblemException {
  return new ProblemException(
    'bin-retired',
    400,
    'Source bin is retired',
    `Bin "${binCode}" is retired — merging from it is refused; retirement is terminal.`,
  );
}

function assertUtc(value: string, field: string): string {
  try {
    return assertUtcIso(value);
  } catch {
    throw new ProblemException(
      'validation-failed',
      400,
      `${field} must be a valid ISO-8601 UTC instant`,
      `${field} must be a Z-suffixed ISO-8601 UTC timestamp (got "${value}").`,
    );
  }
}