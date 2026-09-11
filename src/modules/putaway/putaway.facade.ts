import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  batches,
  batchOnHand,
  bins,
  goodsReceiptLines,
  goodsReceiptNotes,
  putawayPlacements,
  skus,
  stockOnHand,
  zones,
} from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { RECEIVING_BIN_CODE } from '../tenancy/receiving-bin';
import { canonicalInstant } from '../../shared/primitives/time';
import { PutawayCommand } from './putaway.command';
import type {
  ListPlacementsQuery,
  PutawayPlacementEntry,
  PutawayPlacementSnapshot,
  PlacePutawayCommand,
} from './putaway.command';
import { binCandidatesInTx } from './putaway.command';

export const DEFAULT_PUTAWAY_PAGE_SIZE = 50;

/**
 * The cursor is opaque to clients but crafted input is still possible — a
 * base64-valid payload with a non-uuid `id` would otherwise reach the
 * `::uuid` cast in SQL and surface as a 500 instead of a 400 (the shared
 * `decodeCursorSafe` pattern of the other read facades).
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

/** One derived putaway task — the inbox's (and snapshot's) unit of work. */
export interface PutawayTask {
  readonly grnId: string;
  readonly grnCode: string;
  readonly grnLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly batchId: string | null;
  readonly batchCode: string | null;
  /** min(line applied, receiving-bin on-hand for that sku/batch) — the placeable units. */
  readonly qty: number;
  readonly suggestedBin: { readonly binId: string; readonly binCode: string } | null;
  /** The one-line capacity-only rationale (FR-10 v1). */
  readonly rationale: string;
}

/** One bin of the snapshot's bins payload (blocked/system bins INCLUDED — the device needs them to reject a scan against them). */
export interface PutawayBinSummary {
  readonly id: string;
  readonly code: string;
  readonly zoneId: string;
  readonly zoneCode: string;
  readonly type: string;
  readonly capacity: number;
  readonly blocked: boolean;
  readonly systemOwned: boolean;
}

/**
 * The putaway module's public surface (Story 3.5): the api shell's only seam
 * to the placement command and reads — `putaway_placements` is a
 * module-exclusive table. The task derivation reads the GRN lines and the
 * receiving-bin projections (read-only composition; every stock write stays
 * behind the inventory facade) and bakes the capacity-only v1 suggestion in.
 */
@Injectable()
export class PutawayFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PutawayCommand) private readonly putaway: PutawayCommand,
  ) {}

  /** `putaway.place` — the device-authenticated idempotent placement command. */
  async placePutaway(
    command: PlacePutawayCommand,
    idempotencyKey: string,
  ): Promise<PutawayPlacementSnapshot> {
    return this.putaway.placePutaway(command, idempotencyKey);
  }

  /**
   * Placements-list read (the web read-only surface — web never places):
   * one warehouse's (or the tenant's) placements, newest first, keyset
   * cursor pagination, with the GRN code and the SKU/batch/bin codes joined
   * for the report surface. A read — never capability-gated.
   */
  async listPlacements(
    tenantId: string,
    query: ListPlacementsQuery = {},
  ): Promise<Page<PutawayPlacementEntry>> {
    const pageSize = query.limit ?? DEFAULT_PUTAWAY_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    const suggestedBins = alias(bins, 'suggested_bins');
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if (query.warehouseId !== undefined) {
        await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      }
      const rows = await tx
        .select({
          id: putawayPlacements.id,
          tenantId: putawayPlacements.tenantId,
          warehouseId: putawayPlacements.warehouseId,
          grnId: putawayPlacements.grnId,
          grnCode: goodsReceiptNotes.code,
          grnLineId: putawayPlacements.grnLineId,
          skuId: putawayPlacements.skuId,
          skuCode: skus.code,
          batchId: putawayPlacements.batchId,
          batchCode: batches.code,
          qty: putawayPlacements.qty,
          fromBinId: putawayPlacements.fromBinId,
          toBinId: putawayPlacements.toBinId,
          toBinCode: bins.code,
          suggestedBinId: putawayPlacements.suggestedBinId,
          suggestedBinCode: suggestedBins.code,
          reasonCode: putawayPlacements.reasonCode,
          placedBy: putawayPlacements.placedBy,
          placedAt: putawayPlacements.placedAt,
          deviceId: putawayPlacements.deviceId,
          createdAt: putawayPlacements.createdAt,
        })
        .from(putawayPlacements)
        .innerJoin(goodsReceiptNotes, eq(goodsReceiptNotes.id, putawayPlacements.grnId))
        .innerJoin(skus, eq(skus.id, putawayPlacements.skuId))
        .leftJoin(batches, eq(batches.id, putawayPlacements.batchId))
        .innerJoin(bins, eq(bins.id, putawayPlacements.toBinId))
        .leftJoin(suggestedBins, eq(suggestedBins.id, putawayPlacements.suggestedBinId))
        .where(
          and(
            eq(putawayPlacements.tenantId, tenantId),
            query.warehouseId === undefined
              ? undefined
              : eq(putawayPlacements.warehouseId, query.warehouseId),
            before === undefined
              ? undefined
              : sql`(${putawayPlacements.createdAt}, ${putawayPlacements.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(putawayPlacements.createdAt), desc(putawayPlacements.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        ...row,
        batchCode: row.batchCode ?? null,
        suggestedBinCode: row.suggestedBinCode ?? null,
        reasonCode: row.reasonCode ?? null,
        placedAt: canonicalInstant(row.placedAt),
        createdAt: canonicalInstant(row.createdAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * The derived putaway tasks (FR-10): one task per GRN line whose applied
   * stock still sits in the warehouse's system Receiving bin — remaining is
   * the per-line `min(line.appliedQty, receiving-bin on-hand for that
   * (sku, batch))` (completion is approximate when two GRNs carry the same
   * (sku, batch) — the fold attributes stock to no line); each task names
   * the capacity-only v1 suggestion (the lowest-occupancy eligible bin) or
   * null when no bin fits. Derived on every read — there is no claim/state
   * table in v1.
   */
  async getPutawayTasks(tenantId: string, warehouseId: string): Promise<readonly PutawayTask[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getPutawayTasksInTx(tx, tenantId, warehouseId),
    );
  }

  /**
   * The same derivation inside the CALLER's transaction (story 4.3): the
   * device catalog snapshot composes this beside its other reads in ONE
   * tenant transaction — the `reservationsByIdsInTx` / `stockByBinsInTx`
   * shape. Opening a nested transaction from inside the snapshot's own would
   * reserve a SECOND pooled connection while the first is held, and enough
   * concurrent snapshots then deadlock the pool with no timeout.
   */
  async getPutawayTasksInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
  ): Promise<readonly PutawayTask[]> {
    {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);

      // The receiving bin (the from-bin identity) — read-only here: a
      // warehouse that has never received anything has no bin and no tasks.
      const receivingBinRows = await tx
        .select({ id: bins.id })
        .from(bins)
        .where(
          and(
            eq(bins.tenantId, tenantId),
            eq(bins.warehouseId, warehouseId),
            eq(bins.code, RECEIVING_BIN_CODE),
            eq(bins.systemOwned, true),
          ),
        )
        .limit(1);
      const receivingBin = receivingBinRows[0];
      if (receivingBin === undefined) {
        return [];
      }

      // The applied GRN lines of the warehouse, oldest receipt first.
      const lineRows = await tx
        .select({
          grnId: goodsReceiptLines.grnId,
          grnCode: goodsReceiptNotes.code,
          grnLineId: goodsReceiptLines.id,
          skuId: goodsReceiptLines.skuId,
          batchId: goodsReceiptLines.batchId,
          appliedQty: goodsReceiptLines.appliedQty,
          lineCreatedAt: goodsReceiptLines.createdAt,
        })
        .from(goodsReceiptLines)
        .innerJoin(goodsReceiptNotes, eq(goodsReceiptNotes.id, goodsReceiptLines.grnId))
        .where(
          and(
            eq(goodsReceiptNotes.tenantId, tenantId),
            eq(goodsReceiptNotes.warehouseId, warehouseId),
            // A GRN's lines are immutable once recorded; every recorded GRN's
            // applied stock is putaway work until it lands in a storage bin.
            sql`${goodsReceiptLines.appliedQty} > 0`,
          ),
        )
        .orderBy(asc(goodsReceiptNotes.code), asc(goodsReceiptLines.createdAt), asc(goodsReceiptLines.id));
      if (lineRows.length === 0) {
        return [];
      }

      // Identity codes (sku + batch) for the task cards.
      const skuIds = [...new Set(lineRows.map((row) => row.skuId))];
      const skuRows = await tx
        .select({ id: skus.id, code: skus.code, batchTracked: skus.batchTracked })
        .from(skus)
        .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, skuIds)));
      const skuById = new Map(skuRows.map((row) => [row.id, row]));
      const batchIds = [
        ...new Set(lineRows.map((row) => row.batchId).filter((id): id is string => id !== null)),
      ];
      const batchRows =
        batchIds.length === 0
          ? []
          : await tx
              .select({ id: batches.id, code: batches.code })
              .from(batches)
              .where(and(eq(batches.tenantId, tenantId), inArray(batches.id, batchIds)));
      const batchCodeById = new Map(batchRows.map((row) => [row.id, row.code]));

      // The Receiving bin's on-hand (the projections, read-only) — the
      // remaining-quantity half.
      const plainRows = await tx
        .select({ skuId: stockOnHand.skuId, quantity: stockOnHand.quantity })
        .from(stockOnHand)
        .where(
          and(
            eq(stockOnHand.tenantId, tenantId),
            eq(stockOnHand.warehouseId, warehouseId),
            eq(stockOnHand.binId, receivingBin.id),
          ),
        );
      const plainBySku = new Map(plainRows.map((row) => [row.skuId, row.quantity]));
      const batchRowsOnHand = await tx
        .select({ skuId: batchOnHand.skuId, batchId: batchOnHand.batchId, quantity: batchOnHand.quantity })
        .from(batchOnHand)
        .where(
          and(
            eq(batchOnHand.tenantId, tenantId),
            eq(batchOnHand.warehouseId, warehouseId),
            eq(batchOnHand.binId, receivingBin.id),
          ),
        );
      const bySkuBatch = new Map(batchRowsOnHand.map((row) => [`${row.skuId}:${row.batchId}`, row.quantity]));

      // The suggestion candidates (capacity-only v1) — one read for the page.
      const candidates = await binCandidatesInTx(tx, tenantId, warehouseId);

      const tasks: PutawayTask[] = [];
      for (const row of lineRows) {
        const sku = skuById.get(row.skuId);
        if (sku === undefined) {
          continue; // the GRN line's SKU is gone from the catalog — nothing to place
        }
        const onHand =
          row.batchId !== null
            ? (bySkuBatch.get(`${row.skuId}:${row.batchId}`) ?? 0)
            : (plainBySku.get(row.skuId) ?? 0);
        const remaining = Math.min(row.appliedQty, onHand);
        if (remaining <= 0) {
          continue; // already placed (or the stock moved elsewhere) — no task
        }
        const fit = candidates.find((candidate) => candidate.occupancy + remaining <= candidate.capacity);
        tasks.push({
          grnId: row.grnId,
          grnCode: row.grnCode,
          grnLineId: row.grnLineId,
          skuId: row.skuId,
          skuCode: sku.code,
          batchId: row.batchId,
          batchCode: row.batchId === null ? null : (batchCodeById.get(row.batchId) ?? null),
          qty: remaining,
          suggestedBin: fit === undefined ? null : { binId: fit.binId, binCode: fit.binCode },
          rationale:
            fit === undefined
              ? 'No storage bin has room for these units'
              : `Lowest occupancy (${fit.occupancy}/${fit.capacity}) — room for ${fit.capacity - fit.occupancy}`,
        });
      }
      return tasks;
    }
  }

  /**
   * The warehouse's bins for the snapshot (blocked/system bins INCLUDED —
   * the device needs them to reject a scan against them, verifying
   * pre-queue; the server re-gates at replay either way). Story 3.6:
   * retired bins are EXCLUDED — a retired bin is operationally gone and the
   * device never targets it; the sealed snapshot shape is unchanged (the
   * staleness model covers a lingering merged/retired row in a stale cache,
   * the server re-gate rejects it).
   */
  async getBinSummaries(tenantId: string, warehouseId: string): Promise<readonly PutawayBinSummary[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getBinSummariesInTx(tx, tenantId, warehouseId),
    );
  }

  /**
   * The same read inside the CALLER's transaction (story 4.3) — the device
   * catalog snapshot's in-tx passthrough. See `getPutawayTasksInTx` for why
   * the snapshot must not nest transactions.
   */
  async getBinSummariesInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
  ): Promise<readonly PutawayBinSummary[]> {
    {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await tx
        .select({
          id: bins.id,
          code: bins.code,
          zoneId: bins.zoneId,
          zoneCode: zones.code,
          type: bins.type,
          capacity: bins.capacity,
          blocked: bins.blocked,
          systemOwned: bins.systemOwned,
        })
        .from(bins)
        .innerJoin(zones, eq(zones.id, bins.zoneId))
        .where(
          and(
            eq(bins.tenantId, tenantId),
            eq(bins.warehouseId, warehouseId),
            isNull(bins.retiredAt),
          ),
        )
        .orderBy(asc(bins.code));
      return rows;
    }
  }
}