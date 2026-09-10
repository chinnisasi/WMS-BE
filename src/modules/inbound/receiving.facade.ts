import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  goodsReceiptLines,
  goodsReceiptNotes,
  overReceipts,
  purchaseOrderLines,
  purchaseOrders,
} from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { PutawayFacade } from '../putaway/putaway.facade';
import { ReceivingCommand } from './receiving.command';
import type {
  DecideOverReceiptCommand,
  GoodsReceiptSnapshot,
  OverReceiptDecisionSnapshot,
  SubmitGoodsReceiptCommand,
} from './receiving.command';
import { CatalogFacade } from '../catalog/catalog.facade';
import type { PurchaseOrderLineSnapshot } from './po.command';
import { lineSnapshot } from './po.command';
import type { OverReceiptEntry } from './receiving.command';
import { canonicalInstant } from '../inventory/ledger.service';

/** One GRN header row of the GRN-list read (line counts + unit sums ride along). */
export interface GoodsReceiptEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly poId: string | null;
  readonly blindReasonCode: string | null;
  readonly status: string;
  readonly recordedBy: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly createdAt: string;
  readonly lineCount: number;
  readonly totalUnits: number;
  readonly appliedUnits: number;
}

export interface ListGoodsReceiptsQuery {
  readonly warehouseId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListOverReceiptsQuery {
  readonly status?: 'pending' | 'approved' | 'rejected' | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The device catalog snapshot (AD-4): the sealed offline decision surface. */
export interface CatalogSnapshot {
  readonly generatedAt: string;
  readonly warehouseId: string;
  readonly skus: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly barcode: string;
    readonly uom: string;
    readonly batchTracked: boolean;
    readonly serialTracked: boolean;
  }[];
  readonly openPurchaseOrders: readonly {
    readonly id: string;
    readonly code: string;
    readonly warehouseId: string;
    readonly vendorId: string;
    readonly lines: readonly PurchaseOrderLineSnapshot[];
  }[];
  // ── Story 3.5 (additive): the putaway decision fields ────────────────────
  /** Every bin of the warehouse (blocked/system bins INCLUDED — the device needs them to reject a scan against them pre-queue). */
  readonly bins: readonly {
    readonly id: string;
    readonly code: string;
    readonly zoneId: string;
    readonly zoneCode: string;
    readonly type: string;
    readonly capacity: number;
    readonly blocked: boolean;
    readonly systemOwned: boolean;
  }[];
  /** The derived putaway tasks (suggestions baked in are advisory — the server re-derives and re-gates at placement). */
  readonly putawayTasks: readonly {
    readonly grnId: string;
    readonly grnCode: string;
    readonly grnLineId: string;
    readonly skuId: string;
    readonly skuCode: string;
    readonly batchId: string | null;
    readonly batchCode: string | null;
    /** min(applied, receiving-bin on-hand) — the placeable units. */
    readonly qty: number;
    readonly suggestedBin: { readonly binId: string; readonly binCode: string } | null;
    readonly rationale: string;
  }[];
}

export const DEFAULT_RECEIVING_PAGE_SIZE = 50;

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

/**
 * The receiving module's public surface (Story 3.3): the api shell's only
 * seam to the receipt commands and reads — `goods_receipt_notes`,
 * `goods_receipt_lines`, and `over_receipts` are module-exclusive tables.
 */
@Injectable()
export class ReceivingFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ReceivingCommand) private readonly receiving: ReceivingCommand,
    // The device snapshot composes catalog identity + inbound open POs +
    // (Story 3.5, additive) the putaway decision fields — catalog through its
    // facade (its tables stay module-exclusive), the PO lines through this
    // module's own tables, bins + putaway tasks through the putaway facade.
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(PutawayFacade) private readonly putaway: PutawayFacade,
  ) {}

  /** `grn.submit` — the device-authenticated whole-GRN command. */
  async submitGoodsReceipt(
    command: SubmitGoodsReceiptCommand,
    idempotencyKey: string,
  ): Promise<GoodsReceiptSnapshot> {
    return this.receiving.submitGoodsReceipt(command, idempotencyKey);
  }

  /** The over-receipt decision (review.decide — approve applies, reject trails). */
  async decideOverReceipt(
    command: DecideOverReceiptCommand,
    idempotencyKey: string,
  ): Promise<OverReceiptDecisionSnapshot> {
    return this.receiving.decideOverReceipt(command, idempotencyKey);
  }

  /**
   * GRN-list read (the Inbound surface): one warehouse's (or the tenant's)
   * goods receipt notes, newest first, keyset cursor pagination, with the
   * per-GRN line count and unit sums folded in a second query (the page's
   * rows only — no full-table aggregate). A read — never capability-gated.
   */
  async listGoodsReceipts(
    tenantId: string,
    query: ListGoodsReceiptsQuery = {},
  ): Promise<Page<GoodsReceiptEntry>> {
    const pageSize = query.limit ?? DEFAULT_RECEIVING_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if (query.warehouseId !== undefined) {
        await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      }
      const rows = await tx
        .select({
          id: goodsReceiptNotes.id,
          tenantId: goodsReceiptNotes.tenantId,
          warehouseId: goodsReceiptNotes.warehouseId,
          code: goodsReceiptNotes.code,
          poId: goodsReceiptNotes.poId,
          blindReasonCode: goodsReceiptNotes.blindReasonCode,
          status: goodsReceiptNotes.status,
          recordedBy: goodsReceiptNotes.recordedBy,
          occurredAt: goodsReceiptNotes.occurredAt,
          recordedAt: goodsReceiptNotes.recordedAt,
          createdAt: goodsReceiptNotes.createdAt,
        })
        .from(goodsReceiptNotes)
        .where(
          and(
            eq(goodsReceiptNotes.tenantId, tenantId),
            query.warehouseId === undefined
              ? undefined
              : eq(goodsReceiptNotes.warehouseId, query.warehouseId),
            before === undefined
              ? undefined
              : sql`(${goodsReceiptNotes.createdAt}, ${goodsReceiptNotes.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(goodsReceiptNotes.createdAt), desc(goodsReceiptNotes.id))
        .limit(pageSize + 1);
      const ids = rows.map((row) => row.id);
      const aggregates =
        ids.length === 0
          ? new Map<string, { lineCount: number; totalUnits: number; appliedUnits: number }>()
          : new Map(
              (
                await tx
                  .select({
                    grnId: goodsReceiptLines.grnId,
                    lineCount: sql<number>`count(*)::int`,
                    // bigint, not int4: a per-GRN sum of max-qty lines
                    // overflows int4, and that must not brick the list read.
                    totalUnits: sql<string>`coalesce(sum(${goodsReceiptLines.qty}), 0)::bigint`,
                    appliedUnits: sql<string>`coalesce(sum(${goodsReceiptLines.appliedQty}), 0)::bigint`,
                  })
                  .from(goodsReceiptLines)
                  .where(inArray(goodsReceiptLines.grnId, ids))
                  .groupBy(goodsReceiptLines.grnId)
              ).map((row) => [
                row.grnId,
                {
                  lineCount: row.lineCount,
                  totalUnits: row.totalUnits,
                  appliedUnits: row.appliedUnits,
                },
              ]),
            );
      const items = rows.map((row) => ({
        ...row,
        lineCount: aggregates.get(row.id)?.lineCount ?? 0,
        // int8 arrives as text through postgres.js; the contract is a number.
        totalUnits: Number(aggregates.get(row.id)?.totalUnits ?? 0),
        appliedUnits: Number(aggregates.get(row.id)?.appliedUnits ?? 0),
        occurredAt: canonicalInstant(row.occurredAt),
        recordedAt: canonicalInstant(row.recordedAt),
        createdAt: canonicalInstant(row.createdAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * Over-receipt-list read (the Conflicts & Reviews queue): the tenant's
   * over-receipts, newest first, status-filterable, with the GRN code joined
   * for the approval cards. A read — never capability-gated (the deciding
   * mutations are; the surface hides behind `review.decide`).
   */
  async listOverReceipts(
    tenantId: string,
    query: ListOverReceiptsQuery = {},
  ): Promise<Page<OverReceiptEntry>> {
    const pageSize = query.limit ?? DEFAULT_RECEIVING_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          overReceipt: overReceipts,
          grnCode: goodsReceiptNotes.code,
        })
        .from(overReceipts)
        .innerJoin(goodsReceiptNotes, eq(goodsReceiptNotes.id, overReceipts.grnId))
        .where(
          and(
            eq(overReceipts.tenantId, tenantId),
            query.status === undefined ? undefined : eq(overReceipts.status, query.status),
            before === undefined
              ? undefined
              : sql`(${overReceipts.createdAt}, ${overReceipts.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(overReceipts.createdAt), desc(overReceipts.id))
        .limit(pageSize + 1);
      const items = rows.map(({ overReceipt: row, grnCode }) => ({
        id: row.id,
        tenantId: row.tenantId,
        warehouseId: row.warehouseId,
        grnId: row.grnId,
        grnCode,
        grnLineId: row.grnLineId,
        poId: row.poId,
        poLineId: row.poLineId,
        skuId: row.skuId,
        excessQty: row.excessQty,
        status: row.status as OverReceiptEntry['status'],
        requestedBy: row.requestedBy,
        requestedAt: canonicalInstant(row.requestedAt),
        decidedBy: row.decidedBy,
        decidedAt: row.decidedAt === null ? null : canonicalInstant(row.decidedAt),
        createdAt: canonicalInstant(row.createdAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * The device catalog snapshot (AD-4): the sealed offline decision surface —
   * every SKU's scan identity plus the warehouse's open POs with per-line
   * ordered / received / open quantities. Composed for a badge-in device
   * while online; the server gate at replay stays the authority (a stale
   * cache mirrors, never overrides).
   */
  async getCatalogSnapshot(tenantId: string, warehouseId: string): Promise<CatalogSnapshot> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      // Catalog identity through the catalog facade (module-exclusive tables);
      // it opens its own tenant transaction, so this composition reads the
      // POs in one tx and the SKUs beside it (a read snapshot, not a gate).
      const skus = await this.catalog.getSkuSummaries(tenantId);
      const poRows = await tx
        .select({
          id: purchaseOrders.id,
          code: purchaseOrders.code,
          warehouseId: purchaseOrders.warehouseId,
          vendorId: purchaseOrders.vendorId,
        })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, tenantId),
            eq(purchaseOrders.warehouseId, warehouseId),
            eq(purchaseOrders.status, 'open'),
          ),
        )
        .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id));
      const lineRows =
        poRows.length === 0
          ? []
          : await tx
              .select()
              .from(purchaseOrderLines)
              .where(inArray(purchaseOrderLines.poId, poRows.map((po) => po.id)))
              .orderBy(purchaseOrderLines.createdAt, purchaseOrderLines.id);
      const linesByPo = new Map<string, PurchaseOrderLineSnapshot[]>();
      for (const line of lineRows) {
        const list = linesByPo.get(line.poId) ?? [];
        list.push(lineSnapshot(line));
        linesByPo.set(line.poId, list);
      }
      // Story 3.5 (additive): the putaway decision fields ride the same
      // snapshot — the bins (for the wrong-bin/blocked pre-queue checks) and
      // the derived tasks (suggestions advisory; the server re-gates).
      const [binSummaries, putawayTasks] = await Promise.all([
        this.putaway.getBinSummaries(tenantId, warehouseId),
        this.putaway.getPutawayTasks(tenantId, warehouseId),
      ]);
      return {
        generatedAt: new Date().toISOString(),
        warehouseId,
        skus,
        openPurchaseOrders: poRows.map((po) => ({
          id: po.id,
          code: po.code,
          warehouseId: po.warehouseId,
          vendorId: po.vendorId,
          lines: linesByPo.get(po.id) ?? [],
        })),
        bins: binSummaries,
        putawayTasks: putawayTasks.map((task) => ({ ...task })),
      };
    });
  }
}