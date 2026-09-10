import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
import { signedQuantity } from '../../shared/primitives/quantity';
import { assertUtcIso, nowIso } from '../../shared/primitives/time';
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
  /** The placed quantity in base UoM — a positive integer (partial placements allowed). */
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
 * The line-quantity ceiling: `putaway_placements.qty` is int4, so a larger
 * (but typable) quantity must be a 400, never an insert-time 500.
 */
export const MAX_PLACEMENT_QTY = 2_147_483_647;

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
      if (!Number.isInteger(command.qty) || command.qty < 1) {
        throw putawayValidation(`Placement quantity must be a positive integer (got ${command.qty}).`);
      }
      if (command.qty > MAX_PLACEMENT_QTY) {
        throw putawayValidation(`Placement quantity must be at most ${MAX_PLACEMENT_QTY} (got ${command.qty}).`);
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
        .select({ id: skus.id, code: skus.code, batchTracked: skus.batchTracked, serialTracked: skus.serialTracked })
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
            `SKU "${sku.code}" is serial-tracked — its placement needs one serial per unit (${command.qty}).`,
          );
        }
        if (new Set(command.serials).size !== command.serials.length) {
          throw putawayValidation(
            'serials contains duplicates — a serial-tracked placement writes one ledger event per serial unit; the same serial cannot appear twice.',
          );
        }
        if (command.serials.length !== command.qty) {
          throw putawayValidation(
            `A serial-tracked placement writes one ledger event per serial unit — ${command.serials.length} serials cannot place ${command.qty} units.`,
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
      if (command.qty > remaining) {
        throw putawayValidation(
          `Only ${remaining} of this (sku, batch) remain in the Receiving bin for GRN line "${command.grnLineId}" — ${command.qty} cannot be placed.`,
        );
      }

      // ── the target bin (server-side truth, mirrored on-device) ──────────
      const binRows = await tx
        .select({ id: bins.id, code: bins.code, capacity: bins.capacity, blocked: bins.blocked, systemOwned: bins.systemOwned })
        .from(bins)
        .where(
          and(
            eq(bins.id, command.toBinId),
            eq(bins.tenantId, command.tenantId),
            eq(bins.warehouseId, command.warehouseId),
          ),
        )
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
      if (targetBin.blocked) {
        // FR-10: the rejection names the reason and the bin.
        throw binBlocked(targetBin.code);
      }
      const occupancy = await binOccupancyInTx(
        tx,
        command.tenantId,
        command.warehouseId,
        targetBin.id,
      );
      if (occupancy + command.qty > targetBin.capacity) {
        // FR-10: the rejection names the capacity and the occupancy.
        throw binFull(targetBin.code, targetBin.capacity, occupancy);
      }

      // ── the suggestion (capacity-only v1, RE-DERIVED at placement) ──────
      const suggestion = await suggestBinInTx(
        tx,
        command.tenantId,
        command.warehouseId,
        command.skuId,
        command.qty,
      );
      const suggestedBinId = suggestion?.binId ?? null;
      if (suggestedBinId !== command.toBinId && command.reasonCode === null) {
        throw putawayValidation(
          `Placing into "${targetBin.code}" differs from the suggested bin — a reason code from ${JSON.stringify(PUTAWAY_MISMATCH_REASON_CODES)} is required.`,
        );
      }

      // ── the movements (Receiving bin → target, one event per arm) ───────
      const placedAt = nowIso();
      const referenceDoc = {
        kind: 'putaway' as const,
        grnId: command.grnId,
        grnLineId: command.grnLineId,
        ...(command.reasonCode === null ? {} : { reasonCode: command.reasonCode }),
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
            quantityDelta: signedQuantity(1),
            fromBinId: receivingBin.binId,
            toBinId: targetBin.id,
            batchRef: null,
            serialRef,
            actorUserId: command.operatorUserId,
            occurredAt,
            recordedAt: placedAt,
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
          quantityDelta: signedQuantity(command.qty),
          fromBinId: receivingBin.binId,
          toBinId: targetBin.id,
          batchRef: batchId,
          serialRef: null,
          actorUserId: command.operatorUserId,
          occurredAt,
          recordedAt: placedAt,
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
        qty: command.qty,
        fromBinId: receivingBin.binId,
        toBinId: targetBin.id,
        suggestedBinId,
        reasonCode: command.reasonCode,
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
          qty: command.qty,
          fromBinId: receivingBin.binId,
          toBinId: targetBin.id,
          toBinCode: targetBin.code,
          suggestedBinId,
          suggestedBinCode: suggestion?.binCode ?? null,
          reasonCode: command.reasonCode,
          placedBy: command.operatorUserId,
          placedAt,
          deviceId: command.deviceId,
          createdAt: placedAt,
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
          qty: command.qty,
          fromBinId: receivingBin.binId,
          toBinId: targetBin.id,
          suggestedBinId,
          reasonCode: command.reasonCode,
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
 * the line's quantity (current occupancy + qty ≤ capacity), the LOWEST
 * occupancy wins, then bin code order. No velocity class, no zone affinity,
 * no nightly job (those ship with the deferred report story).
 */
export async function suggestBinInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  skuId: string,
  qty: number,
): Promise<{ binId: string; binCode: string; rationale: string } | null> {
  const candidates = await binCandidatesInTx(tx, tenantId, warehouseId);
  for (const candidate of candidates) {
    if (candidate.occupancy + qty <= candidate.capacity) {
      const room = candidate.capacity - candidate.occupancy;
      return {
        binId: candidate.binId,
        binCode: candidate.binCode,
        rationale: `Lowest occupancy (${candidate.occupancy}/${candidate.capacity}) — room for ${room}`,
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
}

/**
 * The warehouse's putaway-eligible bins (not blocked, not system-owned),
 * ranked lowest occupancy then bin code — the suggestion's input order.
 * Occupancy is the bin's total on-hand across every SKU (capacity is shared
 * base-UoM space), folded in one grouped query.
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
      occupancy: sql<string>`coalesce(sum(${stockOnHand.quantity}), 0)::bigint`,
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
    .where(
      and(
        eq(bins.tenantId, tenantId),
        eq(bins.warehouseId, warehouseId),
        eq(bins.blocked, false),
        eq(bins.systemOwned, false),
      ),
    )
    .groupBy(bins.id, bins.code, bins.capacity)
    .orderBy(asc(sql`coalesce(sum(${stockOnHand.quantity}), 0)`), asc(bins.code));
  return rows.map((row) => ({
    binId: row.binId,
    binCode: row.binCode,
    capacity: row.capacity,
    occupancy: Number(row.occupancy),
  }));
}

/** One bin's total on-hand across every SKU (the capacity gate's input). */
export async function binOccupancyInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  binId: string,
): Promise<number> {
  const rows = await tx
    .select({ occupancy: sql<string>`coalesce(sum(${stockOnHand.quantity}), 0)::bigint` })
    .from(stockOnHand)
    .where(
      and(
        eq(stockOnHand.tenantId, tenantId),
        eq(stockOnHand.warehouseId, warehouseId),
        eq(stockOnHand.binId, binId),
      ),
    );
  return Number(rows[0]?.occupancy ?? 0);
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
    `Bin "${binCode}" holds ${occupancy} of ${capacity} — placing would exceed its capacity.`,
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