import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { goodsReceiptLines, goodsReceiptNotes, qcHolds, skus } from '../../shared/db/schema';
import { fromMilli } from '../../shared/primitives/quantity';
import { InventoryFacade } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import type { UserRole } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { canonicalInstant } from '../../shared/primitives/time';
import { openQcHoldsForBinsInTx, QcCommand } from './qc.command';
import type {
  HoldScopeInTxCommand,
  PlaceQcHoldCommand,
  QcHoldKind,
  QcHoldSnapshot,
  ReleaseQcHoldCommand,
  ReleaseReceiptHoldsCommand,
  ReleaseReceiptHoldsSnapshot,
} from './qc.command';
import type { TenantTx } from '../../shared/db/tenant-scope';

/** One QC-hold row of the holds-list read (the release/hold history cards). */
export interface QcHoldEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  /** The origin bin — captured at hold time; release returns the stock here. */
  readonly binId: string;
  readonly reason: string;
  readonly status: 'open' | 'released';
  readonly heldBy: string;
  readonly heldAt: string;
  readonly releasedBy: string | null;
  readonly releasedAt: string | null;
  /** Row creation time (the keyset cursor field) — part of the read contract. */
  readonly createdAt: string;
  /** Story 1-2b — `manual` or `receipt` (QC on receipt). */
  readonly kind: QcHoldKind;
  /** Story 1-2b — a receipt hold's GRN line / GRN / code (null on a manual hold). */
  readonly grnLineId?: string;
  readonly grnId: string | null;
  readonly grnCode: string | null;
  readonly overReceiptId: string | null;
  /** Story 1-2b — the held SKU's client. */
  readonly clientId: string;
  /** Story 1-2b — the one batch the hold moved (null when untracked or several). */
  readonly batchId: string | null;
  readonly batchCode: string | null;
  /** Story 1-2b — Σ of the hold's own `qc.held` events, base units. */
  readonly heldQty: number;
}

export interface ListQcHoldsQuery {
  readonly warehouseId?: string | undefined;
  readonly status?: 'open' | 'released' | undefined;
  /** Story 1-2b — only one GRN's receipt holds. */
  readonly grnId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const DEFAULT_QC_PAGE_SIZE = 50;

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
 * The inbound module's QC-hold surface (Story 3.4): the api shell's only seam
 * to the hold/release commands and the holds-list read — `qc_holds` is an
 * inbound-module-exclusive table. The movements ride the inventory facade
 * inside the command; this facade only passes commands through and reads its
 * own module's table.
 */
@Injectable()
export class QcFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QcCommand) private readonly qc: QcCommand,
    // Story 1-2b — the holds list's held quantity (the ledger) and batch code.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  /** `qc-holds.place` — the Ops Manager quarantine command (`qc.manage`). */
  async placeHold(command: PlaceQcHoldCommand, idempotencyKey: string): Promise<QcHoldSnapshot> {
    return this.qc.placeHold(command, idempotencyKey);
  }

  /** `qc-holds/:id/release` — the Ops Manager release command (`qc.manage`). */
  async releaseHold(command: ReleaseQcHoldCommand, idempotencyKey: string): Promise<QcHoldSnapshot> {
    return this.qc.releaseHold(command, idempotencyKey);
  }

  /** Story 1-2b — `qc-holds/release-receipt`: every open receipt hold of one GRN (`qc.manage`). */
  async releaseReceiptHolds(
    command: ReleaseReceiptHoldsCommand,
    idempotencyKey: string,
  ): Promise<ReleaseReceiptHoldsSnapshot> {
    return this.qc.releaseReceiptHolds(command, idempotencyKey);
  }

  /**
   * Story 12-5 — the in-transaction hold core (the `holdScopeInTx` command
   * method, extracted from `placeHold`) exposed to the one composing sibling:
   * the excursion command quarantines each affected (sku, bin) scope through
   * this so the hold semantics keep exactly one implementation. Runs inside
   * the CALLER's transaction; the caller owns authority, replay and the
   * idempotency commit marker, and passes its fresh role read for the 12-3
   * secure-bin gate plus the audit row's reference value.
   */
  async holdScopeInTx(
    tx: TenantTx,
    command: HoldScopeInTxCommand,
    role: UserRole,
    auditReference: string,
  ): Promise<QcHoldSnapshot> {
    return this.qc.holdScopeInTx(tx, command, role, auditReference);
  }

  /**
   * The open holds riding the named bins, inside the caller's transaction —
   * the file-level `openQcHoldsForBinsInTx` helper surfaced through the
   * facade so the excursion command can SKIP already-held scopes (a scope
   * under an open hold is already out of ATP, not a 409) without reaching
   * into `qc_holds` itself.
   */
  async openHoldsForBinsInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    binIds: readonly string[],
  ): Promise<readonly { binId: string; holdId: string; skuId: string }[]> {
    return openQcHoldsForBinsInTx(tx, tenantId, warehouseId, binIds);
  }

  /**
   * Holds-list read: the tenant's QC holds, newest first, warehouse- and
   * status-filterable. A read — never capability-gated (the placing/release
   * mutations are; the surface hides the buttons behind `qc.manage`).
   */
  async listQcHolds(tenantId: string, query: ListQcHoldsQuery = {}): Promise<Page<QcHoldEntry>> {
    const pageSize = query.limit ?? DEFAULT_QC_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if (query.warehouseId !== undefined) {
        await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      }
      const rows = await tx
        .select({
          hold: qcHolds,
          grnId: goodsReceiptLines.grnId,
          grnCode: goodsReceiptNotes.code,
          clientId: skus.clientId,
        })
        .from(qcHolds)
        .innerJoin(skus, eq(skus.id, qcHolds.skuId))
        .leftJoin(goodsReceiptLines, eq(goodsReceiptLines.id, qcHolds.grnLineId))
        .leftJoin(goodsReceiptNotes, eq(goodsReceiptNotes.id, goodsReceiptLines.grnId))
        .where(
          and(
            eq(qcHolds.tenantId, tenantId),
            query.warehouseId === undefined
              ? undefined
              : eq(qcHolds.warehouseId, query.warehouseId),
            query.status === undefined ? undefined : eq(qcHolds.status, query.status),
            query.grnId === undefined ? undefined : eq(goodsReceiptLines.grnId, query.grnId),
            before === undefined
              ? undefined
              : sql`(${qcHolds.createdAt}, ${qcHolds.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(qcHolds.createdAt), desc(qcHolds.id))
        .limit(pageSize + 1);
      // Story 1-2b — the held quantity and batch, from each hold's OWN
      // `qc.held` events (one grouped read over the page's ids, never per
      // row) through the inventory facade; the batch code through catalog's.
      const totals = await this.inventory.qcHeldTotalsInTx(
        tx,
        tenantId,
        [...new Set(rows.map((row) => row.hold.warehouseId))],
        rows.map((row) => row.hold.id),
      );
      const singleBatch = (holdId: string): string | null => {
        const refs = totals.get(holdId)?.batchRefs ?? [];
        return refs.length === 1 ? (refs[0] ?? null) : null;
      };
      const batchIds = [...new Set(rows.map((row) => singleBatch(row.hold.id)).filter((id): id is string => id !== null))];
      const batchCodes = await this.catalog.batchCodesByIdsInTx(tx, tenantId, batchIds);
      const items = rows.map(({ hold: row, grnId, grnCode, clientId }) => {
        const batchId = singleBatch(row.id);
        return {
          id: row.id,
          tenantId: row.tenantId,
          warehouseId: row.warehouseId,
          skuId: row.skuId,
          binId: row.binId,
          reason: row.reason,
          status: row.status as QcHoldEntry['status'],
          heldBy: row.heldBy,
          heldAt: canonicalInstant(row.heldAt),
          releasedBy: row.releasedBy,
          releasedAt: row.releasedAt === null ? null : canonicalInstant(row.releasedAt),
          createdAt: canonicalInstant(row.createdAt),
          kind: row.kind as QcHoldKind,
          ...(row.grnLineId === null ? {} : { grnLineId: row.grnLineId }),
          grnId: grnId ?? null,
          grnCode: grnCode ?? null,
          overReceiptId: row.overReceiptId,
          clientId,
          batchId,
          batchCode: batchId === null ? null : (batchCodes.get(batchId) ?? null),
          // Read model — base units (story 10.1).
          heldQty: fromMilli(totals.get(row.id)?.quantity ?? 0),
        };
      });
      return buildPage(items, pageSize);
    });
  }
}