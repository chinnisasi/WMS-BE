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
import {
  approvedExcessByLine,
  binCandidatesInTx,
  dedicatedClientLabelsInTx,
  failedReceiptQtyByLine,
  openReceiptHoldQtyByLine,
  pickPutawayCandidate,
  putawayRationale,
  receivingSerialsByLineInTx,
  type PutawayBinCandidate,
} from './putaway.command';
import { QUANTITY_SCALE, fromMilli } from '../../shared/primitives/quantity';
import { InventoryFacade } from '../inventory/inventory.facade';
import { SEGREGATION_PROFILE_COLUMNS } from '../../shared/primitives/segregation';

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
  /**
   * Story 2-6a (A14) — a serial-tracked task only: the line's `applied`
   * serials still located in the Receiving bin, in capture order. `qty` is
   * `min(remaining, their count)`; a task at 0 is dropped.
   */
  readonly serialNumbers?: readonly string[];
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
  /**
   * Story 3-3b (decision 12, A7) — why the bin is blocked (null while
   * active): the handheld names it on its pre-queue refusals ("A-01 is
   * blocked (damaged) — pick another bin"). Additive; the device reads it
   * `?? null` from a snapshot cached before 3-3b.
   */
  readonly blockedReason: string | null;
  readonly systemOwned: boolean;
  /**
   * Story 12.8 (UX-DR29): the bin's storage class — the other half of the
   * device's offline conformance mirror. It rides the snapshot beside the
   * SKU arm's class (catalog facade) so the device can refuse a
   * non-conforming placement or draw in its own Rejected banner, offline,
   * in under 500 ms. Never null on the wire: the column defaults to
   * `ambient` (0035_storage_class.sql), so every bin reads a class.
   */
  readonly storageClass: string;
  /**
   * Story 1-5b: the bin's dedicated client (null = shared). The device's
   * offline mirror of the client gate refuses another client's SKU before
   * queueing; the server re-gates at placement either way.
   */
  readonly dedicatedClientId: string | null;
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
    // Story 2-6a (A14) — the serials located in Receiving (the ledger is the
    // only source of serial location).
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
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
            // Story 1-5a: through the placed SKU (already inner-joined).
            query.clientId === undefined ? undefined : eq(skus.clientId, query.clientId),
            before === undefined
              ? undefined
              : sql`(${putawayPlacements.createdAt}, ${putawayPlacements.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(putawayPlacements.createdAt), desc(putawayPlacements.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        ...row,
        // Story 10.1: a read model hands out BASE units; the domain below
        // keeps milli-units.
        qty: fromMilli(row.qty),
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
   * the per-line `min(line.appliedQty + approved over-receipt excess (story
   * 21-9), receiving-bin on-hand for that
   * (sku, batch))` (completion is approximate when two GRNs carry the same
   * (sku, batch) — the fold attributes stock to no line); each task names
   * the capacity-only v1 suggestion (the lowest-occupancy eligible bin) or
   * null when no bin fits. Derived on every read — there is no claim/state
   * table in v1.
   */
  async getPutawayTasks(
    tenantId: string,
    warehouseId: string,
    // Story 1-5a — the staff client filter, a named option.
    options: { readonly clientId?: string | undefined } = {},
  ): Promise<readonly PutawayTask[]> {
    const clientId = options.clientId;
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const tasks = await this.getPutawayTasksInTx(tx, tenantId, warehouseId);
      if (clientId === undefined || tasks.length === 0) return tasks;
      // Story 1-5a: the web list's client filter, by each task's SKU. Applied
      // AFTER the derivation, at this wrapper only — the device snapshot and
      // the KPIs call the InTx derivation and stay unfiltered, and each task
      // is derived independently, so a filtered task is identical to its
      // unfiltered self.
      const owned = await tx
        .select({ id: skus.id })
        .from(skus)
        .where(
          and(
            eq(skus.tenantId, tenantId),
            eq(skus.clientId, clientId),
            inArray(skus.id, [...new Set(tasks.map((task) => task.skuId))]),
          ),
        );
      const ownedIds = new Set(owned.map((row) => row.id));
      return tasks.filter((task) => ownedIds.has(task.skuId));
    });
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

    // The GRN lines of the warehouse with putaway work, oldest receipt
    // first. Story 21-9 (decision 4): a line's putaway quantity is its
    // `applied_qty` PLUS every APPROVED over-receipt excess of that line —
    // approval puts the excess into the Receiving bin as a further
    // `grn.received`, and GRN lines stay immutable, so the approval rows are
    // summed beside them (one aggregate for the warehouse, never per line).
    const approvedExcess = approvedExcessByLine(tx, tenantId, warehouseId);
    // Story 1-2b (§7f amended): minus the units of the line still on an OPEN
    // receipt QC hold — they sit in the QC-HOLD bin, not Receiving, and
    // become work again when the hold is released. A pooled (sku, batch)
    // held line therefore shows no task while an earlier unheld line of the
    // same (sku, batch) keeps its own.
    const receiptHeld = openReceiptHoldQtyByLine(tx, tenantId, warehouseId);
    // Story 2-8a (§7f amended): minus the units that FAILED an inspection of
    // the line's receipt hold — they went to DAMAGED. Passed units returned
    // to Receiving and stay work.
    const receiptFailed = failedReceiptQtyByLine(tx, tenantId, warehouseId);
    const putawayQty = sql<string>`(${goodsReceiptLines.appliedQty} + coalesce(${approvedExcess.excessQty}, 0) - coalesce(${receiptHeld.heldQty}, 0) - coalesce(${receiptFailed.failedQty}, 0))::bigint`;
    const lineRows = (
      await tx
        .select({
          grnId: goodsReceiptLines.grnId,
          grnCode: goodsReceiptNotes.code,
          grnLineId: goodsReceiptLines.id,
          skuId: goodsReceiptLines.skuId,
          batchId: goodsReceiptLines.batchId,
          putawayQty,
          lineCreatedAt: goodsReceiptLines.createdAt,
        })
        .from(goodsReceiptLines)
        .innerJoin(goodsReceiptNotes, eq(goodsReceiptNotes.id, goodsReceiptLines.grnId))
        .leftJoin(approvedExcess, eq(approvedExcess.grnLineId, goodsReceiptLines.id))
        .leftJoin(receiptHeld, eq(receiptHeld.grnLineId, goodsReceiptLines.id))
        .leftJoin(receiptFailed, eq(receiptFailed.grnLineId, goodsReceiptLines.id))
        .where(
          and(
            eq(goodsReceiptNotes.tenantId, tenantId),
            eq(goodsReceiptNotes.warehouseId, warehouseId),
            // A GRN's lines are immutable once recorded; every recorded GRN's
            // applied (and approved-excess) stock is putaway work until it
            // lands in a storage bin.
            sql`${putawayQty} > 0`,
          ),
        )
        .orderBy(asc(goodsReceiptNotes.code), asc(goodsReceiptLines.createdAt), asc(goodsReceiptLines.id))
    ).map((row) => ({ ...row, putawayQty: Number(row.putawayQty) }));
    if (lineRows.length === 0) {
      return [];
    }

    // Identity codes (sku + batch) for the task cards.
    const skuIds = [...new Set(lineRows.map((row) => row.skuId))];
    const skuRows = await tx
      .select({
        id: skus.id,
        code: skus.code,
        batchTracked: skus.batchTracked,
        // Story 2-6a (A14) — a serial task carries its serials.
        serialTracked: skus.serialTracked,
        // Story 11-5: the task-derivation fit consumes the same attributes —
        // the suggestion never points at a bin the gates would refuse.
        weightGrams: skus.weightGrams,
        lengthMm: skus.lengthMm,
        widthMm: skus.widthMm,
        heightMm: skus.heightMm,
        // Story 12-1 — the class the class gate rules on (the row object is
        // passed straight to `candidateFitsSku`, so the shape must match).
        storageClass: skus.storageClass,
        // Story 12-2 / 1-6b — the segregation profile the co-location arm
        // rules on (an empty profile carries no rule).
        ...SEGREGATION_PROFILE_COLUMNS,
        // Story 1-5b — the client: the client gate and the own-client
        // preference of the shared ranking.
        clientId: skus.clientId,
      })
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

    // ── story 2-6a (A14): a serial-tracked line's own serials ───────────
    // Receiving is POOLED per (sku, batch), so `min(putaway qty, on-hand)`
    // cannot tell whose units are left: a serial line's task is bounded by
    // ITS booked (`applied`) serials still located in Receiving (the
    // ledger's latest event per serial — `serialsLocatedInBinInTx`), and it
    // carries their numbers so the handheld verifies each scan offline. A
    // line with no serial rows (received before 2-6a) keeps the pooled
    // bound and no list (the handheld refuses it, as before).
    const serialLineIds = lineRows
      .filter((row) => skuById.get(row.skuId)?.serialTracked === true)
      .map((row) => row.grnLineId);
    const serialNumbersByLine = await receivingSerialsByLineInTx(tx, this.inventory, {
      tenantId,
      receivingBinId: receivingBin.id,
      lines: lineRows.filter((row) => serialLineIds.includes(row.grnLineId)).map((row) => ({ grnLineId: row.grnLineId, skuId: row.skuId })),
    });

    const picked: {
      row: (typeof lineRows)[number];
      sku: (typeof skuRows)[number];
      remaining: number;
      fit: PutawayBinCandidate | null;
      serialNumbers: readonly string[] | null;
    }[] = [];
    for (const row of lineRows) {
      const sku = skuById.get(row.skuId);
      if (sku === undefined) {
        continue; // the GRN line's SKU is gone from the catalog — nothing to place
      }
      const onHand =
        row.batchId !== null
          ? (bySkuBatch.get(`${row.skuId}:${row.batchId}`) ?? 0)
          : (plainBySku.get(row.skuId) ?? 0);
      let remaining = Math.min(row.putawayQty, onHand);
      const lineSerials = serialNumbersByLine.get(row.grnLineId) ?? null;
      let serialNumbers: readonly string[] | null = null;
      if (lineSerials !== null) {
        // Whole units only: a serial SKU has a 0-dp UoM (catalog entry).
        const units = Math.min(Math.floor(remaining / QUANTITY_SCALE), lineSerials.length);
        remaining = units * QUANTITY_SCALE;
        serialNumbers = lineSerials.slice(0, units);
      }
      if (remaining <= 0) {
        continue; // already placed (or the stock moved elsewhere) — no task
      }
      // Story 11-5: the same fit predicate the suggestion and the placement
      // re-derivation use — a SKU without attributes still fits wherever the
      // unit gate passes (fail-open on missing attributes). Story 12-2: the
      // line's SKU id rides in so the hazard arm can skip its own occupant
      // pairs (the same-SKU-consolidation rule). Story 1-5b: the ONE shared
      // ranking (`pickPutawayCandidate`, own-client preference) — the
      // placement re-derives exactly this, so a followed suggestion needs no
      // mismatch reason.
      const fit = pickPutawayCandidate(candidates, sku, remaining, row.skuId, { preferOwn: true });
      picked.push({ row, sku, remaining, fit, serialNumbers });
    }
    // Story 1-5b: the dedicated clients' labels for the rationale — one read.
    const labels = await dedicatedClientLabelsInTx(
      tx,
      tenantId,
      picked.map((entry) => entry.fit).filter((fit): fit is PutawayBinCandidate => fit !== null),
    );
    const tasks: PutawayTask[] = picked.map(({ row, sku, remaining, fit, serialNumbers }) => ({
      grnId: row.grnId,
      grnCode: row.grnCode,
      grnLineId: row.grnLineId,
      skuId: row.skuId,
      skuCode: sku.code,
      batchId: row.batchId,
      batchCode: row.batchId === null ? null : (batchCodeById.get(row.batchId) ?? null),
      // Read model + operator-facing text — base units (story 10.1).
      qty: fromMilli(remaining),
      suggestedBin: fit === null ? null : { binId: fit.binId, binCode: fit.binCode },
      rationale: fit === null ? 'No conforming storage bin has room for these units' : putawayRationale(fit, labels),
      // Story 2-6a — present only on a serial line that captured serials.
      ...(serialNumbers === null ? {} : { serialNumbers }),
    }));
    return tasks;
  }

  /**
   * The warehouse's bins for the snapshot (blocked/system bins INCLUDED —
   * the device needs them to reject a scan against them, verifying
   * pre-queue; the server re-gates at replay either way). Story 3.6:
   * retired bins are EXCLUDED — a retired bin is operationally gone and the
   * device never targets it; the sealed snapshot shape is unchanged (the
   * staleness model covers a lingering merged/retired row in a stale cache,
   * the server re-gate rejects it).
   *
   * In-tx ONLY (story 4.3): the device catalog snapshot is this read's only
   * consumer and it composes every part in ONE tenant transaction. See
   * `getPutawayTasksInTx` for why the snapshot must not nest transactions.
   */
  async getBinSummariesInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
  ): Promise<readonly PutawayBinSummary[]> {
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
        // Story 3-3b — the reason the handheld names on its refusals.
        blockedReason: bins.blockedReason,
        systemOwned: bins.systemOwned,
        // Story 12.8 (UX-DR29): the class rides beside the type — the
        // device's offline conformance mirror reads both arms (bin here, SKU
        // on the catalog facade) beside the fields it already gates on.
        storageClass: bins.storageClass,
        // Story 1-5b: the dedicated client (null = shared) — the device
        // refuses another client's SKU into it before queueing.
        dedicatedClientId: bins.dedicatedClientId,
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
    // Read model — capacity leaves in base units (story 10.1).
    return rows.map((row) => ({ ...row, capacity: fromMilli(row.capacity) }));
  }
}

