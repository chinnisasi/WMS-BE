import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  bins,
  skus,
  transferOrderLines,
  transferOrders,
  warehouses,
  type TransferOrder,
  type TransferOrderLine,
} from '../../shared/db/schema';
import { fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant } from '../../shared/primitives/time';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { InventoryFacade } from '../inventory/inventory.facade';
import {
  TransferService,
  transferLegEventsInTx,
  type TransferConfirmSnapshot,
  type TransferLegEventSnapshot,
  type TransferOrderSnapshot,
} from './transfer.command';

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

export interface ListTransfersQuery {
  readonly status?: string | undefined;
  readonly sourceWarehouseId?: string | undefined;
  readonly destWarehouseId?: string | undefined;
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
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // One-way: the facade consumes the commands; the commands never see it.
    @Inject(TransferService) private readonly commands: TransferService,
    // The epoch read for the task cards (the same-tx capture the pick
    // command's task read established) and — nothing else; every stock write
    // already went through the command's facade passthroughs.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

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
    // Both legs' events, in order (source chain first, then dest), each
    // carrying `referenceDoc {kind:'transfer', transferId}` — the epic AC's
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
}

export type { TransferOrderSnapshot, TransferConfirmSnapshot, TransferLegEventSnapshot };
export type { TransferOrder, TransferOrderLine };