import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { goodsReceiptLines, goodsReceiptNotes, qcHolds, qcInspectionLines, qcInspections, skus } from '../../shared/db/schema';
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
import { canonicalInstant, istDateOf } from '../../shared/primitives/time';
import { compareBatchIds, compareInspectionLines, openQcHoldsForBinsInTx, QcCommand } from './qc.command';
import type {
  HoldScopeInTxCommand,
  InspectQcHoldCommand,
  InspectQcHoldSnapshot,
  QcFailReason,
  QcHoldStatus,
  QcInspectionOutcome,
  QcInspectionSnapshot,
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
  readonly status: QcHoldStatus;
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
  /** Story 2-8a — an inspected hold's failed units (to DAMAGED), base units; null otherwise. */
  readonly failedQuantity: number | null;
}

/** Story 2-8a — one batch arm a hold moved into QC (the detail read). */
export interface QcHeldArmEntry {
  readonly batchId: string | null;
  readonly batchCode: string | null;
  /** IST calendar date (YYYY-MM-DD) or null. */
  readonly expiryDate: string | null;
  /** Base units. */
  readonly quantity: number;
}

/** Story 2-8a — `GET …/qc-holds/:holdId`. */
export interface QcHoldDetail {
  readonly qcHold: QcHoldEntry;
  readonly arms: readonly QcHeldArmEntry[];
  readonly inspection: QcInspectionSnapshot | null;
}

export interface ListQcHoldsQuery {
  readonly warehouseId?: string | undefined;
  /** Story 2-8a — `inspected` added; `closed` = released or inspected. */
  readonly status?: QcHoldStatus | 'closed' | undefined;
  /** Story 1-2b — only one GRN's receipt holds. */
  readonly grnId?: string | undefined;
  /** Story 1-5a — only holds on one client's SKUs (every kind, manual holds included). */
  readonly clientId?: string | undefined;
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
  private readonly logger = new Logger(QcFacade.name);

  /**
   * Story 2-8a — an `inspected` hold whose inspection record is missing or
   * incomplete is a data fault, never a clean hold: answering `inspection:
   * null` or "0 fail" would hide units that went to DAMAGED. Logged with the
   * hold id; `500 data-fault` (the return-receipt precedent).
   */
  private inspectionFault(holdId: string, what: string): ProblemException {
    this.logger.error(`QC hold ${holdId} is inspected but ${what} — the inspection record is inconsistent`);
    return new ProblemException(
      'data-fault',
      500,
      'QC inspection data is inconsistent',
      `QC hold "${holdId}" is inspected but ${what}.`,
    );
  }

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

  /** Story 2-8a — `qc-holds/:id/inspect`: the inspection outcome (`qc.manage`). */
  async inspectHold(command: InspectQcHoldCommand, idempotencyKey: string): Promise<InspectQcHoldSnapshot> {
    return this.qc.inspectHold(command, idempotencyKey);
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
            query.status === undefined
              ? undefined
              : query.status === 'closed'
                ? ne(qcHolds.status, 'open')
                : eq(qcHolds.status, query.status),
            query.grnId === undefined ? undefined : eq(goodsReceiptLines.grnId, query.grnId),
            // Story 1-5a: through the held SKU (already inner-joined) — a
            // manual hold names no GRN line, so never through the receipt.
            query.clientId === undefined ? undefined : eq(skus.clientId, query.clientId),
            before === undefined
              ? undefined
              : sql`(${qcHolds.createdAt}, ${qcHolds.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(qcHolds.createdAt), desc(qcHolds.id))
        .limit(pageSize + 1);
      const items = await this.entriesInTx(tx, tenantId, rows);
      return buildPage(items, pageSize);
    });
  }

  /**
   * Story 2-8a — `GET …/qc-holds/:holdId`: one hold (the list row's shape),
   * the batch arms it moved (its own `qc.held` events, with each batch's code
   * and expiry through the catalog facade — never a cross-module join) and,
   * once inspected, the inspection with its lines. A read (any member).
   */
  async getQcHold(tenantId: string, holdId: string): Promise<QcHoldDetail> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
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
        .where(and(eq(qcHolds.tenantId, tenantId), eq(qcHolds.id, holdId)))
        .limit(1);
      if (rows[0] === undefined) {
        throw new ProblemException('not-found', 404, 'QC hold not found', `No QC hold with id "${holdId}" exists in this tenant.`);
      }
      const [entry] = await this.entriesInTx(tx, tenantId, rows);
      const hold = rows[0].hold;
      const events = await this.inventory.qcHeldArmsInTx(tx, tenantId, hold.warehouseId, hold.id);
      const held = new Map<string | null, number>();
      for (const event of events) held.set(event.batchRef, (held.get(event.batchRef) ?? 0) + event.quantity);
      const batchIds = [...held.keys()].filter((id): id is string => id !== null);
      const facts = await this.catalog.batchFactsByIdsInTx(tx, tenantId, batchIds);
      const arms = [...held]
        .sort(([a], [b]) => compareBatchIds(a, b))
        .map(([batchId, quantity]) => {
          const fact = batchId === null ? undefined : facts.get(batchId);
          return {
            batchId,
            batchCode: fact?.code ?? null,
            expiryDate: fact?.expiryDate === undefined || fact.expiryDate === null ? null : istDateOf(fact.expiryDate),
            quantity: fromMilli(quantity),
          };
        });
      let inspection: QcInspectionSnapshot | null = null;
      if (hold.status === 'inspected') {
        if (hold.releasedBy === null || hold.releasedAt === null) {
          throw this.inspectionFault(hold.id, 'carries no closer (released_by / released_at)');
        }
        const found = await tx
          .select({ id: qcInspections.id, note: qcInspections.note })
          .from(qcInspections)
          .where(and(eq(qcInspections.tenantId, tenantId), eq(qcInspections.holdId, hold.id)))
          .limit(1);
        if (found[0] === undefined) {
          throw this.inspectionFault(hold.id, 'has no qc_inspections row');
        }
        const lineRows = await tx
          .select({
            batchId: qcInspectionLines.batchId,
            outcome: qcInspectionLines.outcome,
            failReason: qcInspectionLines.failReason,
            quantity: qcInspectionLines.quantity,
          })
          .from(qcInspectionLines)
          .where(and(eq(qcInspectionLines.tenantId, tenantId), eq(qcInspectionLines.inspectionId, found[0].id)));
        if (lineRows.length === 0) {
          throw this.inspectionFault(hold.id, 'its inspection has no lines');
        }
        const lines = lineRows
          .map((line) => ({
            batchId: line.batchId,
            outcome: line.outcome as QcInspectionOutcome,
            failReason: line.failReason as QcFailReason | null,
            quantity: line.quantity,
          }))
          .sort(compareInspectionLines);
        const total = (outcome: QcInspectionOutcome): number =>
          lines.filter((line) => line.outcome === outcome).reduce((sum, line) => sum + line.quantity, 0);
        inspection = {
          id: found[0].id,
          holdId: hold.id,
          note: found[0].note,
          inspectedBy: hold.releasedBy,
          inspectedAt: canonicalInstant(hold.releasedAt),
          passedQuantity: fromMilli(total('passed')),
          failedQuantity: fromMilli(total('failed')),
          lines: lines.map((line) => ({ ...line, quantity: fromMilli(line.quantity) })),
        };
      }
      return { qcHold: entry!, arms, inspection };
    });
  }

  /**
   * The list row of each hold (shared by the list and the detail): the held
   * quantity and batch from each hold's OWN `qc.held` events (one grouped
   * read, never per row) through the inventory facade, the batch code
   * through catalog's, and (2-8a) an inspected hold's failed units from this
   * module's own inspection rows.
   */
  private async entriesInTx(
    tx: TenantTx,
    tenantId: string,
    rows: readonly { hold: typeof qcHolds.$inferSelect; grnId: string | null; grnCode: string | null; clientId: string }[],
  ): Promise<QcHoldEntry[]> {
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
    const inspectedIds = rows.filter((row) => row.hold.status === 'inspected').map((row) => row.hold.id);
    const failedByHold = new Map<string, number>();
    if (inspectedIds.length > 0) {
      const failed = await tx
        .select({
          holdId: qcInspections.holdId,
          failed: sql<string | null>`sum(${qcInspectionLines.quantity}) filter (where ${qcInspectionLines.outcome} = 'failed')::bigint`,
        })
        .from(qcInspections)
        .innerJoin(
          qcInspectionLines,
          and(eq(qcInspectionLines.tenantId, qcInspections.tenantId), eq(qcInspectionLines.inspectionId, qcInspections.id)),
        )
        .where(and(eq(qcInspections.tenantId, tenantId), inArray(qcInspections.holdId, inspectedIds)))
        .groupBy(qcInspections.holdId);
      for (const row of failed) failedByHold.set(row.holdId, Number(row.failed ?? 0));
      // An inspected hold with no inspection, or one with no lines, has no
      // row here: a data fault, never "0 fail".
      for (const row of rows) {
        if (row.hold.status !== 'inspected') continue;
        if (row.hold.releasedBy === null || row.hold.releasedAt === null) {
          throw this.inspectionFault(row.hold.id, 'carries no closer (released_by / released_at)');
        }
        if (!failedByHold.has(row.hold.id)) {
          throw this.inspectionFault(row.hold.id, 'has no inspection lines');
        }
      }
    }
    return rows.map(({ hold: row, grnId, grnCode, clientId }) => {
      const batchId = singleBatch(row.id);
      return {
        id: row.id,
        tenantId: row.tenantId,
        warehouseId: row.warehouseId,
        skuId: row.skuId,
        binId: row.binId,
        reason: row.reason,
        status: row.status as QcHoldStatus,
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
        failedQuantity: row.status === 'inspected' ? fromMilli(failedByHold.get(row.id) ?? 0) : null,
      };
    });
  }
}
