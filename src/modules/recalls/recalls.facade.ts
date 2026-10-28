import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, or, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { batchRecallLines, batchRecalls, type BatchRecallLineRow, type BatchRecallRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { rearmTxDeadline } from '../../shared/db/tx-deadline';
import { UUID_RE } from '../../shared/primitives/ids';
import { fullPrecisionInstant } from '../../shared/primitives/time';
import { InventoryFacade } from '../inventory/inventory.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import {
  RecallCommand,
  type AddRecallBatchesCommand,
  type CloseRecallCommand,
  type OpenRecallCommand,
  type RecallMode,
  type RecallSnapshot,
  type RecallStatus,
} from './recall.command';
import { recallLiveStateInTx, type RecallLiveState, type RecallLotRef } from './recall-figures';
import type { CloseSummaryV1 } from './close-summary';

export { RECALL_EVIDENCE_MAX, RECALL_LOCK_TIMEOUT_MS, RECALL_MAX_LOTS, RECALL_MODES, RECALL_NOTE_MAX, RECALL_REF_MAX, RECALL_STATUSES } from './recall.command';
export type { AddRecallBatchesCommand, CloseRecallCommand, OpenRecallCommand, RecallLotSnapshot, RecallMode, RecallSnapshot, RecallStatus } from './recall.command';
export { RECALL_FIGURE_NAMES } from './recall-figures';
export type { RecallFigureName, RecallHeldLine, RecallLiveState, RecallLotFigures, RecallLotRef } from './recall-figures';
export type { CloseSummaryLot, CloseSummaryV1 } from './close-summary';

/** A recall's header as the reads compose it (instants canonical ISO). */
export interface RecallHeader {
  readonly id: string;
  readonly code: string;
  readonly clientId: string;
  readonly mode: RecallMode;
  readonly status: RecallStatus;
  readonly reasonNote: string;
  readonly externalRef: string | null;
  readonly openedAt: string;
  readonly openedBy: string;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly closeNote: string | null;
  readonly closeSummary: CloseSummaryV1 | null;
  readonly releasedBatchIds: readonly string[] | null;
  readonly firstReportAt: string | null;
  readonly createdAt: string;
}

export interface RecallLine {
  readonly batchId: string;
  readonly skuId: string;
  readonly batchCode: string;
  readonly blockedByRecall: boolean;
}

export interface RecallWithLines {
  readonly header: RecallHeader;
  readonly lines: readonly RecallLine[];
}

export interface RecallListQuery {
  readonly clientId?: string | undefined;
  readonly status?: RecallStatus | undefined;
  readonly mode?: RecallMode | undefined;
  readonly externalRef?: string | undefined;
  /** One recall by its code, exactly (`RCL-000001`) — a link resolves to its recall. */
  readonly code?: string | undefined;
  /** `createdAtFullPrecision|id` of the last row of the previous page. */
  readonly after?: { readonly createdAt: string; readonly id: string } | undefined;
  readonly limit: number;
}

export interface RecallListRow extends RecallHeader {
  readonly lotCount: number;
  /** The raw `created_at` text (full precision) — the keyset cursor's half. */
  readonly createdAtText: string;
}

function canonical(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function headerOf(row: BatchRecallRow): RecallHeader {
  return {
    id: row.id,
    code: row.code,
    clientId: row.clientId,
    mode: row.mode as RecallMode,
    status: row.status as RecallStatus,
    reasonNote: row.reasonNote,
    externalRef: row.externalRef,
    openedAt: canonical(row.openedAt)!,
    openedBy: row.openedBy,
    closedAt: canonical(row.closedAt),
    closedBy: row.closedBy,
    closeNote: row.closeNote,
    closeSummary: (row.closeSummary as CloseSummaryV1 | null) ?? null,
    releasedBatchIds: row.releasedBatchIds,
    firstReportAt: canonical(row.firstReportAt),
    createdAt: canonical(row.createdAt)!,
  };
}

function lineOf(row: BatchRecallLineRow): RecallLine {
  return { batchId: row.batchId, skuId: row.skuId, batchCode: row.batchCode, blockedByRecall: row.blockedByRecall };
}

/**
 * Story 3-7a — the recalls module's seam: the three commands and download
 * audit (`RecallCommand`) and the in-transaction reads reporting composes
 * the recall's detail, trace and report from (AD-6 — reporting never names
 * these tables). The live figures have ONE definition (`recall-figures.ts`),
 * read here for the detail and the report and by the close for its frozen
 * summary. Nothing imports this module back (catalog, inventory, outbound,
 * inbound and clients reach recall lines only through the free-function
 * seam `open-recall-lines.ts`), so there is no cycle.
 */
@Injectable()
export class RecallsFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RecallCommand) private readonly command: RecallCommand,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
  ) {}

  // ── commands ─────────────────────────────────────────────────────────────

  /** `POST …/inventory/recalls` — see `RecallCommand.open`. */
  async openRecall(command: OpenRecallCommand, idempotencyKey: string): Promise<RecallSnapshot> {
    return this.command.open(command, idempotencyKey);
  }

  /** `POST …/inventory/recalls/{recallId}/batches` — see `RecallCommand.addBatches`. */
  async addRecallBatches(command: AddRecallBatchesCommand, idempotencyKey: string): Promise<RecallSnapshot> {
    return this.command.addBatches(command, idempotencyKey);
  }

  /** `POST …/inventory/recalls/{recallId}/close` — see `RecallCommand.close`. */
  async closeRecall(command: CloseRecallCommand, idempotencyKey: string): Promise<RecallSnapshot> {
    return this.command.close(command, idempotencyKey);
  }

  /** The staff report download's audit row, in its own transaction (A10). */
  async recordReportDownload(tenantId: string, recallId: string, actorUserId: string, format: 'csv' | 'xlsx', rowCount: number | null): Promise<void> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.command.recordReportDownloadInTx(tx, { tenantId, recallId, actorUserId, clientId: null, format, rowCount }),
    );
  }

  /**
   * The PORTAL report download's audit row (A10): the same write, in a
   * transaction stamped with the session's client AND a `client_id = $client`
   * predicate, so another client's recall is the same 404 as an unknown one.
   * Listed beside the portal reads (`test/architecture.spec.ts`) because the
   * portal route calls it — an audit side-effect of a read, never a command.
   */
  async portalRecordReportDownload(tenantId: string, clientId: string, actorUserId: string, recallId: string, format: 'csv' | 'xlsx', rowCount: number | null): Promise<void> {
    return withTenantTransaction(
      this.db,
      tenantId,
      (tx) => this.command.recordReportDownloadInTx(tx, { tenantId, recallId, actorUserId, clientId, format, rowCount }),
      { clientId },
    );
  }

  // ── reads (in the caller's transaction; each statement re-arms its deadline) ─

  /** One recall and its lines, or null when unknown — and, with `clientId`, when another client's (the same null). */
  async recallInTx(tx: TenantTx, tenantId: string, recallId: string, clientId: string | null): Promise<RecallWithLines | null> {
    if (!UUID_RE.test(recallId)) return null;
    await rearmTxDeadline(tx);
    const rows = await tx
      .select()
      .from(batchRecalls)
      .where(
        and(
          eq(batchRecalls.tenantId, tenantId),
          eq(batchRecalls.id, recallId.toLowerCase()),
          ...(clientId === null ? [] : [eq(batchRecalls.clientId, clientId)]),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    await rearmTxDeadline(tx);
    // The lines are reached ONLY through their recall (tenant-only RLS on the
    // lines; the recall row above carries the client predicate and stamp).
    const lines = await tx
      .select({ line: batchRecallLines })
      .from(batchRecallLines)
      .innerJoin(batchRecalls, and(eq(batchRecalls.tenantId, batchRecallLines.tenantId), eq(batchRecalls.id, batchRecallLines.recallId)))
      .where(
        and(
          eq(batchRecallLines.tenantId, tenantId),
          eq(batchRecallLines.recallId, row.id),
          ...(clientId === null ? [] : [eq(batchRecalls.clientId, clientId)]),
        ),
      )
      .orderBy(asc(batchRecallLines.batchCode), asc(batchRecallLines.batchId));
    return { header: headerOf(row), lines: lines.map((entry) => lineOf(entry.line)) };
  }

  /**
   * A page of recalls, newest first (`(created_at, id)` descending — the
   * `(tenant_id[, client_id], created_at, id)` indexes), filtered by client,
   * status, mode or the brand's reference. `clientId` is the filter on the
   * staff list and the session's client on the portal (the caller stamps).
   */
  async listRecallsInTx(tx: TenantTx, tenantId: string, query: RecallListQuery): Promise<RecallListRow[]> {
    await rearmTxDeadline(tx);
    const filters: SQL[] = [eq(batchRecalls.tenantId, tenantId)];
    if (query.clientId !== undefined) filters.push(eq(batchRecalls.clientId, query.clientId));
    if (query.status !== undefined) filters.push(eq(batchRecalls.status, query.status));
    if (query.mode !== undefined) filters.push(eq(batchRecalls.mode, query.mode));
    if (query.externalRef !== undefined) filters.push(eq(batchRecalls.externalRef, query.externalRef));
    if (query.code !== undefined) filters.push(eq(batchRecalls.code, query.code));
    if (query.after !== undefined) {
      filters.push(
        or(
          lt(batchRecalls.createdAt, query.after.createdAt),
          and(eq(batchRecalls.createdAt, query.after.createdAt), lt(batchRecalls.id, query.after.id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(batchRecalls)
      .where(and(...filters))
      .orderBy(desc(batchRecalls.createdAt), desc(batchRecalls.id))
      .limit(query.limit);
    if (rows.length === 0) return [];
    await rearmTxDeadline(tx);
    const counts = await tx
      .select({ recallId: batchRecallLines.recallId, batchId: batchRecallLines.batchId })
      .from(batchRecallLines)
      .where(and(eq(batchRecallLines.tenantId, tenantId), inArray(batchRecallLines.recallId, rows.map((row) => row.id))));
    const lotCount = new Map<string, number>();
    for (const line of counts) lotCount.set(line.recallId, (lotCount.get(line.recallId) ?? 0) + 1);
    return rows.map((row) => ({ ...headerOf(row), lotCount: lotCount.get(row.id) ?? 0, createdAtText: fullPrecisionInstant(row.createdAt) }));
  }

  /** Every line of one client's OPEN recalls (any mode), with its recall's code — the candidates' "same code on an open recall" flag. */
  async openRecallLinesOfClientInTx(tx: TenantTx, tenantId: string, clientId: string): Promise<(RecallLine & { recallId: string; recallCode: string; mode: RecallMode })[]> {
    await rearmTxDeadline(tx);
    const rows = await tx
      .select({ line: batchRecallLines, recallCode: batchRecalls.code, mode: batchRecalls.mode })
      .from(batchRecallLines)
      .innerJoin(batchRecalls, and(eq(batchRecalls.tenantId, batchRecallLines.tenantId), eq(batchRecalls.id, batchRecallLines.recallId)))
      .where(and(eq(batchRecallLines.tenantId, tenantId), eq(batchRecalls.clientId, clientId), eq(batchRecalls.status, 'open')))
      .orderBy(asc(batchRecalls.code), asc(batchRecallLines.batchCode));
    return rows.map((row) => ({ ...lineOf(row.line), recallId: row.line.recallId, recallCode: row.recallCode, mode: row.mode as RecallMode }));
  }

  /** The live figures and the on-hand / held rows of a recall's lots (`recall-figures.ts` — the ONE definition). */
  async recallLiveStateInTx(tx: TenantTx, tenantId: string, clientId: string, lots: readonly RecallLotRef[]): Promise<RecallLiveState> {
    return recallLiveStateInTx(tx, { inventory: this.inventory, outbound: this.outbound }, tenantId, clientId, lots);
  }
}
