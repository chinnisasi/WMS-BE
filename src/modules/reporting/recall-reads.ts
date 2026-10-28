import type { TenantTx } from '../../shared/db/tenant-scope';
import { csvCell, csvTypedCell, UTF8_BOM } from '../../shared/export/csv';
import type { ExportCell } from '../../shared/export/cells';
import { buildXlsxWorkbook } from '../../shared/export/xlsx';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { normaliseLotCode } from '../../shared/primitives/lot-code';
import { UUID_RE } from '../../shared/primitives/ids';
import type { Page } from '../../shared/primitives/pagination';
import { istDateOf } from '../../shared/primitives/time';
import { assertClientInTenantInTx } from '../clients/clients.facade';
import { warehouseCodesOfTenantInTx } from '../tenancy/tenancy.service';
import type { RecallLotFigures, RecallMode, RecallStatus } from '../recalls/recalls.facade';
import { CSV_CONTENT_TYPE } from './registers';
import {
  closeLotOf,
  endRow,
  eventRowsPageInTx,
  heldOrders,
  metaRows,
  onHandByWarehouse,
  RECALL_REPORT_COLUMNS,
  recallReportRows,
  timeToReportSeconds,
  type PreparedRecall,
  type RecallHeldOrderEntry,
  type RecallOnHandEntry,
  type RecallTraceSources,
  type RecallWalkCursor,
} from './recall-trace';

/**
 * Story 3-7a — the recall reads' shapes and their builders (the facade opens
 * the transactions, takes the slots and arms the deadlines; this file shapes
 * what it read). Every portal shape is an exact key allowlist rebuilt key by
 * key (guide §7e), never a spread of the staff view.
 */

export const RECALL_FORMATS = ['csv', 'xlsx'] as const;
export type RecallReportFormat = (typeof RECALL_FORMATS)[number];

/** A10 — the XLSX is built whole and capped; beyond it the CSV (streamed, uncapped) is the file. */
export const RECALL_XLSX_MAX_ROWS = 200_000;
/** A10 — the CSV's whole-read deadline (re-armed before every statement). */
export const RECALL_REPORT_DEADLINE_MS = 60_000;
/** The detail and paged reads' whole-read deadline. */
export const RECALL_READ_DEADLINE_MS = 15_000;
/** The most candidates one lot-code search answers. */
export const RECALL_CANDIDATES_MAX = 200;

export function invalidRecallQuery(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid recall request', detail);
}

export function recallNotFound(recallId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Recall not found', `No recall with id "${recallId}" exists in this tenant.`);
}

// ── the staff detail ─────────────────────────────────────────────────────────

export interface RecallLotView {
  readonly batchId: string;
  readonly batchCode: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly expiryDate: string | null;
  /** The batch's status now (`active` | `blocked`), its block reason, and whether it has expired. */
  readonly status: string;
  readonly blockedReason: string | null;
  readonly expired: boolean;
  readonly blockedByRecall: boolean;
  readonly released: boolean;
  readonly figures: RecallLotFigures;
  readonly adjustedOutByReason: Readonly<Record<string, number>>;
  readonly closeFigures: RecallLotFigures | null;
  readonly closeAdjustedOutByReason: Readonly<Record<string, number>> | null;
  readonly overrideReason: string | null;
  readonly dispositionNote: string | null;
}

export interface RecallPlannedPickView {
  readonly picklistLineId: string;
  readonly orderId: string;
  readonly orderLabel: string;
  readonly warehouseCode: string;
  readonly binCode: string;
  readonly skuCode: string;
  readonly quantity: number;
}

export interface RecallDetailView {
  readonly recall: {
    readonly id: string;
    readonly code: string;
    readonly mode: RecallMode;
    readonly status: RecallStatus;
    readonly clientId: string;
    readonly clientCode: string;
    readonly clientName: string;
    readonly reasonNote: string;
    readonly externalRef: string | null;
    readonly openedAt: string;
    readonly openedBy: string;
    readonly openedByName: string | null;
    readonly closedAt: string | null;
    readonly closedBy: string | null;
    readonly closedByName: string | null;
    readonly closeNote: string | null;
    readonly evidenceRef: string | null;
    readonly acknowledgedUnaccounted: boolean | null;
    readonly firstReportAt: string | null;
    readonly timeToReportSeconds: number | null;
  };
  readonly asOf: string;
  readonly lots: readonly RecallLotView[];
  readonly onHandByWarehouse: readonly RecallOnHandEntry[];
  readonly heldOrders: readonly RecallHeldOrderEntry[];
  readonly plannedPicks: readonly RecallPlannedPickView[];
}

function lotViews(prepared: PreparedRecall): RecallLotView[] {
  const released = new Set(prepared.recall.header.releasedBatchIds ?? []);
  return prepared.lots.map((lot) => {
    const closed = closeLotOf(prepared, lot.batchId);
    return {
      batchId: lot.batchId,
      batchCode: lot.batchCode,
      skuId: lot.skuId,
      skuCode: lot.skuCode,
      skuName: lot.skuName,
      uom: lot.uom,
      expiryDate: lot.expiryDate,
      status: lot.view?.status ?? 'active',
      blockedReason: lot.view?.blockedReason ?? null,
      expired: lot.view?.expired ?? false,
      blockedByRecall: lot.blockedByRecall,
      released: released.has(lot.batchId),
      figures: prepared.state.figures.get(lot.batchId)!,
      adjustedOutByReason: prepared.state.adjustedOutByReason.get(lot.batchId) ?? {},
      closeFigures: closed?.figures ?? null,
      closeAdjustedOutByReason: closed?.adjustedOutByReason ?? null,
      overrideReason: closed?.overrideReason ?? null,
      dispositionNote: closed?.dispositionNote ?? null,
    };
  });
}

export function recallDetailView(prepared: PreparedRecall): RecallDetailView {
  const header = prepared.recall.header;
  const summary = header.closeSummary;
  const lotsBySku = new Map(prepared.lots.map((lot) => [lot.skuId, lot]));
  return {
    recall: {
      id: header.id,
      code: header.code,
      mode: header.mode,
      status: header.status,
      clientId: header.clientId,
      clientCode: prepared.clientCode,
      clientName: prepared.clientName,
      reasonNote: header.reasonNote,
      externalRef: header.externalRef,
      openedAt: header.openedAt,
      openedBy: header.openedBy,
      openedByName: prepared.actorNames.get(header.openedBy) ?? null,
      closedAt: header.closedAt,
      closedBy: header.closedBy,
      closedByName: header.closedBy === null ? null : (prepared.actorNames.get(header.closedBy) ?? null),
      closeNote: header.closeNote,
      evidenceRef: summary?.evidenceRef ?? null,
      acknowledgedUnaccounted: summary?.acknowledgedUnaccounted ?? null,
      firstReportAt: header.firstReportAt,
      timeToReportSeconds: timeToReportSeconds(prepared),
    },
    asOf: prepared.asOf,
    lots: lotViews(prepared),
    onHandByWarehouse: onHandByWarehouse(prepared),
    heldOrders: heldOrders(prepared),
    plannedPicks: prepared.plannedTasks.map((task) => ({
      picklistLineId: task.picklistLineId,
      orderId: task.orderId,
      orderLabel: prepared.state.orders.get(task.orderId)?.orderLabel ?? task.orderId.slice(-8),
      warehouseCode: prepared.state.warehouses.get(task.warehouseId) ?? task.warehouseId,
      binCode: prepared.state.onHandRows.find((row) => row.binId === task.binId)?.binCode ?? task.binId,
      skuCode: lotsBySku.get(task.skuId)?.skuCode ?? task.skuId,
      quantity: task.quantity,
    })),
  };
}

// ── the portal detail (an exact allowlist — A11) ─────────────────────────────

export interface PortalRecallDetailView {
  readonly id: string;
  readonly code: string;
  readonly mode: RecallMode;
  readonly status: RecallStatus;
  readonly externalRef: string | null;
  readonly reasonNote: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closeNote: string | null;
  readonly lots: readonly {
    readonly batchId: string;
    readonly batchCode: string;
    readonly skuCode: string;
    readonly skuName: string;
    readonly uom: string;
    readonly expiryDate: string | null;
    readonly figures: RecallLotFigures;
    readonly closeFigures: RecallLotFigures | null;
  }[];
  readonly onHandByWarehouse: readonly { readonly warehouseCode: string; readonly role: string; readonly batchCode: string; readonly quantity: number }[];
  readonly heldOrders: readonly { readonly orderLabel: string; readonly clientOrderRef: string | null; readonly batchCode: string; readonly quantity: number }[];
}

export function portalRecallDetailView(prepared: PreparedRecall): PortalRecallDetailView {
  const header = prepared.recall.header;
  return {
    id: header.id,
    code: header.code,
    mode: header.mode,
    status: header.status,
    externalRef: header.externalRef,
    reasonNote: header.reasonNote,
    openedAt: header.openedAt,
    closedAt: header.closedAt,
    closeNote: header.closeNote,
    lots: prepared.lots.map((lot) => ({
      batchId: lot.batchId,
      batchCode: lot.batchCode,
      skuCode: lot.skuCode,
      skuName: lot.skuName,
      uom: lot.uom,
      expiryDate: lot.expiryDate,
      figures: prepared.state.figures.get(lot.batchId)!,
      closeFigures: closeLotOf(prepared, lot.batchId)?.figures ?? null,
    })),
    onHandByWarehouse: onHandByWarehouse(prepared).map((entry) => ({
      warehouseCode: entry.warehouseCode,
      role: entry.role,
      batchCode: entry.batchCode,
      quantity: entry.quantity,
    })),
    heldOrders: heldOrders(prepared).map((entry) => ({
      orderLabel: entry.orderLabel,
      clientOrderRef: entry.clientOrderRef,
      batchCode: entry.batchCode,
      quantity: entry.quantity,
    })),
  };
}

// ── the paged lists (staff) ──────────────────────────────────────────────────

export interface RecallBinEntry {
  readonly warehouseCode: string;
  readonly binCode: string;
  readonly role: string;
  readonly batchCode: string;
  readonly skuCode: string;
  readonly quantity: number;
}

/** The bin list (staff only — A11 keeps bins off the portal), paged by a keyset over the sorted rows. */
export function recallBinsPage(prepared: PreparedRecall, cursor: string | undefined, limit: number): Page<RecallBinEntry> {
  const lots = new Map(prepared.lots.map((lot) => [lot.batchId, lot]));
  const rows = prepared.state.onHandRows.map((row) => ({
    key: `${row.warehouseId}|${row.role === 'storage' ? '0' : '1'}|${row.binCode}|${row.batchId}`,
    entry: {
      warehouseCode: prepared.state.warehouses.get(row.warehouseId) ?? row.warehouseId,
      binCode: row.binCode,
      role: row.role,
      batchCode: lots.get(row.batchId)?.batchCode ?? row.batchId,
      skuCode: lots.get(row.batchId)?.skuCode ?? row.skuId,
      quantity: row.quantity,
    },
  }));
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let after: string | null = null;
  if (cursor !== undefined) {
    const decoded = decodeWalk<{ k?: unknown } | null>(cursor);
    if (typeof decoded !== 'object' || decoded === null || typeof decoded.k !== 'string') {
      throw new ProblemException('invalid-cursor', 400, 'Invalid cursor', 'The cursor is not one this list issued.');
    }
    after = decoded.k;
  }
  const start = after === null ? 0 : rows.findIndex((row) => row.key > after);
  const from = start === -1 ? rows.length : start;
  const page = rows.slice(from, from + limit);
  const more = from + limit < rows.length;
  return { items: page.map((row) => row.entry), nextCursor: more ? encodeWalk({ k: page.at(-1)!.key }) : null };
}

export interface RecallShipmentEntry {
  readonly orderId: string;
  readonly orderLabel: string;
  readonly clientOrderRef: string | null;
  readonly channelOrderRef: string | null;
  readonly consigneeLegalName: string | null;
  readonly consigneeGstin: string | null;
  readonly destinationCity: string | null;
  readonly destinationState: string | null;
  readonly destinationPincode: string | null;
  readonly warehouseCode: string;
  readonly batchCode: string;
  readonly skuCode: string;
  readonly quantity: number;
  readonly dispatchedAt: string | null;
  readonly carrier: string | null;
  readonly awb: string | null;
  readonly duringRecall: boolean;
}

export interface RecallReceiptEntry {
  readonly grnCode: string;
  readonly document: string | null;
  readonly vendorName: string | null;
  readonly warehouseCode: string;
  readonly batchCode: string;
  readonly skuCode: string;
  readonly quantity: number;
  readonly receivedAt: string;
  readonly duringRecall: boolean;
}

function encodeWalk(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeWalk<T>(cursor: string): T {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    throw new ProblemException('invalid-cursor', 400, 'Invalid cursor', 'The cursor is not one this list issued.');
  }
}

function walkCursorOf(cursor: string | undefined): RecallWalkCursor {
  if (cursor === undefined) return { lot: 0, after: null };
  const raw = decodeWalk<{ l?: unknown; s?: unknown; w?: unknown } | null>(cursor);
  if (typeof raw !== 'object' || raw === null || typeof raw.l !== 'number' || !Number.isInteger(raw.l) || raw.l < 0 || raw.l > 10_000) {
    throw new ProblemException('invalid-cursor', 400, 'Invalid cursor', 'The cursor is not one this list issued.');
  }
  if (raw.s === undefined) return { lot: raw.l, after: null };
  if (typeof raw.s !== 'number' || !Number.isInteger(raw.s) || raw.s < 0 || raw.s > 2_147_483_647 || typeof raw.w !== 'string' || !UUID_RE.test(raw.w)) {
    throw new ProblemException('invalid-cursor', 400, 'Invalid cursor', 'The cursor is not one this list issued.');
  }
  return { lot: raw.l, after: { seq: raw.s, warehouseId: raw.w } };
}

function walkCursorText(next: RecallWalkCursor | null): string | null {
  if (next === null) return null;
  return encodeWalk(next.after === null ? { l: next.lot } : { l: next.lot, s: next.after.seq, w: next.after.warehouseId });
}

export async function recallShipmentsPageInTx(
  tx: TenantTx,
  sources: RecallTraceSources,
  prepared: PreparedRecall,
  cursor: string | undefined,
  limit: number,
): Promise<Page<RecallShipmentEntry>> {
  const page = await eventRowsPageInTx(tx, sources, prepared, 'dispatched', walkCursorOf(cursor), limit);
  return {
    items: page.rows.map((row) => ({
      orderId: row.order?.orderId ?? '',
      orderLabel: row.order?.orderLabel ?? '',
      clientOrderRef: row.order?.clientOrderRef ?? null,
      channelOrderRef: row.order?.channelOrderRef ?? null,
      consigneeLegalName: row.order?.consigneeLegalName ?? null,
      consigneeGstin: row.order?.consigneeGstin ?? null,
      destinationCity: row.order?.destinationCity ?? null,
      destinationState: row.order?.destinationState ?? null,
      destinationPincode: row.order?.destinationPincode ?? null,
      warehouseCode: row.warehouseCode,
      batchCode: row.lot.batchCode,
      skuCode: row.lot.skuCode,
      quantity: row.quantity,
      dispatchedAt: row.dispatchedAt,
      carrier: row.carrier,
      awb: row.awb,
      duringRecall: row.duringRecall,
    })),
    nextCursor: walkCursorText(page.next),
  };
}

export async function recallReceiptsPageInTx(
  tx: TenantTx,
  sources: RecallTraceSources,
  prepared: PreparedRecall,
  cursor: string | undefined,
  limit: number,
): Promise<Page<RecallReceiptEntry>> {
  const page = await eventRowsPageInTx(tx, sources, prepared, 'received', walkCursorOf(cursor), limit);
  return {
    items: page.rows.map((row) => ({
      grnCode: row.grnCode ?? '',
      document: row.document,
      vendorName: row.vendorName,
      warehouseCode: row.warehouseCode,
      batchCode: row.lot.batchCode,
      skuCode: row.lot.skuCode,
      quantity: row.quantity,
      receivedAt: row.event.recordedAt,
      duringRecall: row.duringRecall,
    })),
    nextCursor: walkCursorText(page.next),
  };
}

// ── the candidates ───────────────────────────────────────────────────────────

export interface RecallCandidateView {
  readonly batchId: string;
  readonly batchCode: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly status: string;
  readonly blockedReason: string | null;
  readonly expiryDate: string | null;
  readonly match: 'exact' | 'normalised';
  /** Base units on hand across the tenant (IN-TRANSIT included). */
  readonly onHand: number;
  /** The open recall naming THIS batch (any mode), null when none. */
  readonly onRecall: { readonly recallId: string; readonly code: string; readonly mode: RecallMode } | null;
  /** An open recall of the client naming another batch of the same normalised code, when this one is on none (A14). */
  readonly sameCodeOnOpenRecall: string | null;
}

export async function recallCandidatesInTx(
  tx: TenantTx,
  sources: RecallTraceSources,
  tenantId: string,
  clientId: string,
  code: string,
): Promise<{ normalisedCode: string; truncated: boolean; items: RecallCandidateView[] }> {
  const normalised = normaliseLotCode(code);
  if (normalised === '') throw invalidRecallQuery('code must hold at least one letter or digit.');
  await assertClientInTenantInTx(tx, tenantId, clientId);
  // One past the cap, so a code matching more than the list shows says so (never a silently short checklist).
  const fetched = await sources.catalog.batchesByNormalisedCodeInTx(tx, tenantId, clientId, code, RECALL_CANDIDATES_MAX + 1);
  const truncated = fetched.length > RECALL_CANDIDATES_MAX;
  const rows = fetched.slice(0, RECALL_CANDIDATES_MAX);
  const open = await sources.recalls.openRecallLinesOfClientInTx(tx, tenantId, clientId);
  const onHand = new Map<string, number>();
  if (rows.length > 0) {
    const warehouses = [...(await warehouseCodesOfTenantInTx(tx, tenantId)).keys()];
    for (const row of await sources.inventory.batchOnHandForRecallInTx(tx, tenantId, warehouses, rows.map((r) => r.skuId), rows.map((r) => r.batchId))) {
      onHand.set(row.batchId, Math.round(((onHand.get(row.batchId) ?? 0) + row.quantity) * 1000) / 1000);
    }
  }
  return {
    normalisedCode: normalised,
    truncated,
    items: rows.map((row) => {
      // An open LIVE recall naming the batch wins over a mock one (a drill
      // never hides the recall that actually blocks it); and only a LIVE
      // recall steers "add it to RCL-x" — a drill is never the place for a
      // real lot.
      const mine = open.filter((line) => line.batchId === row.batchId);
      const own = mine.find((line) => line.mode === 'live') ?? mine[0];
      const same =
        own === undefined
          ? open.find((line) => line.mode === 'live' && normaliseLotCode(line.batchCode) === normalised)
          : undefined;
      return {
        batchId: row.batchId,
        batchCode: row.code,
        skuId: row.skuId,
        skuCode: row.skuCode,
        skuName: row.skuName,
        uom: row.uom,
        status: row.status,
        blockedReason: row.blockedReason,
        expiryDate: row.expiryDate,
        match: row.match,
        onHand: onHand.get(row.batchId) ?? 0,
        onRecall: own === undefined ? null : { recallId: own.recallId, code: own.recallCode, mode: own.mode },
        sameCodeOnOpenRecall: same?.recallCode ?? null,
      };
    }),
  };
}

// ── the report file ──────────────────────────────────────────────────────────

/** What the route writes before the first byte, and the sink it streams to. */
export interface RecallReportSink {
  /**
   * Called ONCE, before any header or byte: the download's audit row runs
   * here (A10), then the route writes its headers. A refusal thrown here
   * still reaches the problem filter as problem+json.
   */
  begin(file: { readonly filename: string; readonly contentType: string; readonly rowCount: number | null; readonly length: number | null }): Promise<void>;
  /** Writes one chunk, resolving once the socket can take more (backpressure). */
  write(chunk: Buffer): Promise<void>;
}

/** A code made safe for a filename: letters, digits and `-` only. */
function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

export function recallReportFilename(prepared: PreparedRecall, format: RecallReportFormat): string {
  return `recall-${slug(prepared.recall.header.code)}-${slug(prepared.clientCode)}-asof-${istDateOf(prepared.asOf)}.${format}`;
}

function csvLine(cells: readonly ExportCell[]): string {
  return `${cells.map((value, index) => csvTypedCell(RECALL_REPORT_COLUMNS[index]!, value)).join(',')}\r\n`;
}

/** Lines buffered per socket write. */
const CSV_FLUSH_LINES = 500;

/**
 * The CSV, STREAMED (A10 — uncapped): the header, the meta rows, every
 * section, and the `end` row with the count of every row before it. The
 * caller's REPEATABLE READ transaction is open throughout, so the file is
 * one snapshot. `begin` runs first, before a byte; a failure after it can
 * only cut the file short (the route destroys the socket), never corrupt it.
 */
export async function streamRecallCsvInTx(
  tx: TenantTx,
  sources: RecallTraceSources,
  prepared: PreparedRecall,
  sink: RecallReportSink,
  pageSize?: number,
): Promise<number> {
  await sink.begin({ filename: recallReportFilename(prepared, 'csv'), contentType: CSV_CONTENT_TYPE, rowCount: null, length: null });
  let buffered: string[] = [`${UTF8_BOM}${RECALL_REPORT_COLUMNS.map((column) => csvCell(column.header)).join(',')}\r\n`];
  let count = 0;
  const flush = async (): Promise<void> => {
    if (buffered.length === 0) return;
    const chunk = Buffer.from(buffered.join(''), 'utf8');
    buffered = [];
    await sink.write(chunk);
  };
  for (const row of metaRows(prepared)) {
    buffered.push(csvLine(row));
    count += 1;
  }
  for await (const row of recallReportRows(tx, sources, prepared, pageSize)) {
    buffered.push(csvLine(row));
    count += 1;
    if (buffered.length >= CSV_FLUSH_LINES) await flush();
  }
  buffered.push(csvLine(endRow(count)));
  await flush();
  return count;
}

/**
 * The XLSX, built WHOLE before the first header (capped at
 * `RECALL_XLSX_MAX_ROWS` trace rows — past it 422 `report-too-large`:
 * "download the CSV"): a "Recall" sheet of the meta fields, and a "Trace"
 * sheet of every other row in the same schema (no `end` row — a built file
 * cannot be cut short).
 */
export async function buildRecallXlsxInTx(
  tx: TenantTx,
  sources: RecallTraceSources,
  prepared: PreparedRecall,
  maxRows: number,
  pageSize?: number,
): Promise<{ body: Buffer; rowCount: number; filename: string }> {
  let rowCount = 0;
  // Each trace row goes straight to the streaming writer (never held as
  // cells); the cap is checked as rows arrive, and the refusal discards the
  // half-built workbook before any header.
  async function* capped(): AsyncGenerator<ExportCell[]> {
    for await (const row of recallReportRows(tx, sources, prepared, pageSize)) {
      rowCount += 1;
      if (rowCount > maxRows) {
        throw new ProblemException(
          'report-too-large',
          422,
          'Report too large',
          `The recall report has more than ${maxRows.toLocaleString('en-IN')} rows — download the CSV, which carries every row.`,
          { maxRows },
        );
      }
      yield row;
    }
  }
  const metaField = RECALL_REPORT_COLUMNS.findIndex((column) => column.header === 'meta_field');
  const metaValue = RECALL_REPORT_COLUMNS.findIndex((column) => column.header === 'meta_value');
  const meta = metaRows(prepared).map((row) => [row[metaField]!, row[metaValue]!]);
  const body = await buildXlsxWorkbook([
    { name: 'Recall', columns: [{ header: 'field', kind: 'text' }, { header: 'value', kind: 'text' }], rows: meta },
    { name: 'Trace', columns: RECALL_REPORT_COLUMNS, rows: capped() },
  ]);
  return { body, rowCount, filename: recallReportFilename(prepared, 'xlsx') };
}
