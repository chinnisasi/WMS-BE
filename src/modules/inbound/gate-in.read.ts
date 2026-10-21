import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  advanceShipmentNotices,
  gateInDocuments,
  gateIns,
  goodsReceiptNotes,
  purchaseOrders,
  type GateInDocumentRow,
  type GateInRow,
} from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { decodeCursor, encodeCursor } from '../../shared/primitives/pagination';
import type { Page } from '../../shared/primitives/pagination';
import { maskPhone } from '../../shared/primitives/phone';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import type { TransporterSnapshotV1 } from '../partners/partners.facade';
import type { GateInDocumentKind, GateInStatus, SealStatus } from './gate-in.command';

/**
 * Story 2-3a — the gate-in's read side: the view every surface returns, the
 * staff list and detail, the device snapshot's open set, and the two reads
 * the receiving command and the GRN list make of it. Pure reads on the
 * caller's transaction; the vocabularies are the command's (imported as
 * types only, so this file and the command never form a runtime cycle).
 */

/** A gate-in that is not gated out and gated in more than this many days ago reads as stale on the web (decision 15). */
export const STALE_OPEN_DAYS = 7;
/** The device snapshot offers open gate-ins gated in within this many days … */
export const DEVICE_OPEN_GATE_IN_DAYS = 7;
/** … at most this many, newest first (decision 15). */
export const MAX_DEVICE_OPEN_GATE_INS = 200;

const DAY_MS = 86_400_000;

/** How the driver's phone is rendered: in full (the detail, for a `gate.manage` holder) or masked (everywhere else). */
export type PhoneMode = 'full' | 'masked';

export interface GateInDocumentView {
  readonly id: string;
  readonly position: number;
  readonly kind: GateInDocumentKind;
  readonly number: string;
  /** The document's own date as typed — a calendar date `YYYY-MM-DD`, never an instant. */
  readonly documentDate: string;
  readonly ewayBillNo: string | null;
  readonly poId: string | null;
  readonly asnId: string | null;
}

/** The gate-in header every surface carries. */
export interface GateInHeaderView {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly status: GateInStatus;
  readonly handDelivery: boolean;
  readonly vehicleNo: string | null;
  readonly containerNo: string | null;
  readonly transporterPartnerId: string | null;
  readonly transporterName: string | null;
  readonly transporterSnapshot: TransporterSnapshotV1 | null;
  /** The frozen partner's name, else the typed name. */
  readonly transporterLabel: string;
  readonly lrNumber: string | null;
  readonly driverName: string | null;
  /** Masked (`98•••••345`) everywhere but the detail for a `gate.manage` holder (decision 10). */
  readonly driverPhone: string | null;
  readonly sealStatus: SealStatus;
  readonly sealNumber: string | null;
  readonly packagesDeclared: number | null;
  readonly packagesCounted: number | null;
  readonly dockDoor: string | null;
  readonly gatedInAt: string;
  readonly unloadStartedAt: string | null;
  readonly unloadEndedAt: string | null;
  readonly gatedOutAt: string | null;
  readonly recordedBy: string;
  readonly unloadStartedBy: string | null;
  readonly unloadEndedBy: string | null;
  readonly gatedOutBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A mutation's answer (and idempotency snapshot): the header plus its documents. */
export interface GateInView extends GateInHeaderView {
  readonly documents: readonly GateInDocumentView[];
}

export type PackagesFlag = 'short' | 'excess' | 'matches';

/** One row of the staff list. */
export interface GateInEntryView extends GateInHeaderView {
  readonly documentCount: number;
  /** GRNs linked to this visit — any client, including receipts linked after the gate-out. */
  readonly receiptCount: number;
  /** Counted against declared; null while either is missing (decision 11 — blank declared means no flag). */
  readonly packagesFlag: PackagesFlag | null;
  /** `|declared − counted|` beside a flag; null without one. */
  readonly packagesDifference: number | null;
  /** Not gated out and gated in more than `STALE_OPEN_DAYS` days ago. */
  readonly staleOpen: boolean;
}

export interface GateInDetailDocumentView extends GateInDocumentView {
  readonly poCode: string | null;
  readonly asnCode: string | null;
}

export interface GateInReceiptView {
  readonly id: string;
  readonly code: string;
  readonly clientId: string | null;
  readonly document: { readonly kind: 'po' | 'asn' | 'blind'; readonly code: string | null };
}

export interface GateInDetailView extends GateInEntryView {
  readonly documents: readonly GateInDetailDocumentView[];
  readonly receipts: readonly GateInReceiptView[];
}

/** The device snapshot's open gate-in (decision 15). */
export interface OpenGateInView {
  readonly id: string;
  readonly code: string;
  readonly vehicleNo: string | null;
  readonly handDelivery: boolean;
  readonly transporterLabel: string;
  readonly dockDoor: string | null;
  readonly status: GateInStatus;
  readonly sealStatus: SealStatus;
  readonly unloadStartedAt: string | null;
  readonly documents: readonly { readonly kind: GateInDocumentKind; readonly number: string }[];
}

export function transporterLabelOf(row: Pick<GateInRow, 'transporterSnapshot' | 'transporterName'>): string {
  const snapshot = row.transporterSnapshot as TransporterSnapshotV1 | null;
  return snapshot?.name ?? row.transporterName ?? '';
}

/** Counted against declared (decision 8 — flagged, never blocked; decision 11 — undeclared means no flag). */
export function packagesFlagOf(
  declared: number | null,
  counted: number | null,
): { flag: PackagesFlag | null; difference: number | null } {
  if (declared === null || counted === null) return { flag: null, difference: null };
  if (counted === declared) return { flag: 'matches', difference: 0 };
  return { flag: counted < declared ? 'short' : 'excess', difference: Math.abs(declared - counted) };
}

const instantOrNull = (value: string | null): string | null => (value === null ? null : canonicalInstant(value));

export function gateInHeaderView(row: GateInRow, phone: PhoneMode): GateInHeaderView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    warehouseId: row.warehouseId,
    code: row.code,
    status: row.status as GateInStatus,
    handDelivery: row.handDelivery,
    vehicleNo: row.vehicleNo,
    containerNo: row.containerNo,
    transporterPartnerId: row.transporterPartnerId,
    transporterName: row.transporterName,
    transporterSnapshot: (row.transporterSnapshot ?? null) as TransporterSnapshotV1 | null,
    transporterLabel: transporterLabelOf(row),
    lrNumber: row.lrNumber,
    driverName: row.driverName,
    driverPhone: phone === 'full' ? row.driverPhone : maskPhone(row.driverPhone),
    sealStatus: row.sealStatus as SealStatus,
    sealNumber: row.sealNumber,
    packagesDeclared: row.packagesDeclared,
    packagesCounted: row.packagesCounted,
    dockDoor: row.dockDoor,
    gatedInAt: canonicalInstant(row.gatedInAt),
    unloadStartedAt: instantOrNull(row.unloadStartedAt),
    unloadEndedAt: instantOrNull(row.unloadEndedAt),
    gatedOutAt: instantOrNull(row.gatedOutAt),
    recordedBy: row.recordedBy,
    unloadStartedBy: row.unloadStartedBy,
    unloadEndedBy: row.unloadEndedBy,
    gatedOutBy: row.gatedOutBy,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

function documentView(row: GateInDocumentRow): GateInDocumentView {
  return {
    id: row.id,
    position: row.position,
    kind: row.kind as GateInDocumentKind,
    number: row.number,
    documentDate: row.documentDate,
    ewayBillNo: row.ewayBillNo,
    poId: row.poId,
    asnId: row.asnId,
  };
}

/** The gate-in row (unlocked), or null — an unknown or non-uuid id reads as absent, never a cast 500. */
export async function gateInRowInTx(tx: TenantTx, tenantId: string, gateInId: string): Promise<GateInRow | null> {
  if (!UUID_RE.test(gateInId)) return null;
  const rows = await tx
    .select()
    .from(gateIns)
    .where(and(eq(gateIns.tenantId, tenantId), eq(gateIns.id, gateInId)))
    .limit(1);
  return rows[0] ?? null;
}

async function documentsOfInTx(tx: TenantTx, tenantId: string, gateInId: string): Promise<GateInDocumentRow[]> {
  return tx
    .select()
    .from(gateInDocuments)
    .where(and(eq(gateInDocuments.tenantId, tenantId), eq(gateInDocuments.gateInId, gateInId)))
    .orderBy(asc(gateInDocuments.position));
}

/** A mutation's answer, read back on the caller's transaction — the phone masked (a stored snapshot never holds it in full). */
export async function gateInViewInTx(tx: TenantTx, row: GateInRow): Promise<GateInView> {
  const documents = await documentsOfInTx(tx, row.tenantId, row.id);
  return { ...gateInHeaderView(row, 'masked'), documents: documents.map(documentView) };
}

/**
 * The outbox payload's gate-in: the view WITHOUT the driver's phone
 * (decision 10 — personal data is never copied into an event).
 */
export function outboxGateIn(view: GateInView): Omit<GateInView, 'driverPhone'> {
  const { driverPhone, ...rest } = view;
  void driverPhone;
  return rest;
}

// ── the staff list ────────────────────────────────────────────────────────────

export interface ListGateInsQuery {
  readonly warehouseId: string;
  readonly statuses?: readonly GateInStatus[] | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const DEFAULT_GATE_IN_PAGE_SIZE = 50;

const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeGateInCursor(cursor: string): { gatedInAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    if (!UUID_RE.test(decoded.id) || !CURSOR_INSTANT_RE.test(decoded.createdAt) || Number.isNaN(Date.parse(decoded.createdAt))) {
      throw new Error('malformed cursor payload');
    }
    return { gatedInAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new ProblemException('invalid-cursor', 400, 'Malformed pagination cursor', 'The cursor parameter is not a valid opaque page cursor.');
  }
}

/**
 * One warehouse's gate-ins, newest `gated_in_at` first (keyset on
 * `(gated_in_at, id)`, the cursor at full precision). The filters run on the
 * user-entered `gated_in_at` (decision 14 lets the desk correct it). Every
 * client — a truck can carry several. The per-row counts fold over the
 * page's ids only. The phone is always masked here.
 */
export async function listGateInsInTx(
  tx: TenantTx,
  tenantId: string,
  query: ListGateInsQuery,
  nowMs: number,
): Promise<Page<GateInEntryView>> {
  const pageSize = query.limit ?? DEFAULT_GATE_IN_PAGE_SIZE;
  const after = query.cursor === undefined ? undefined : decodeGateInCursor(query.cursor);
  const rows = await tx
    .select({ row: gateIns, gatedInAtText: sql<string>`${gateIns.gatedInAt}::text` })
    .from(gateIns)
    .where(
      and(
        eq(gateIns.tenantId, tenantId),
        eq(gateIns.warehouseId, query.warehouseId),
        query.statuses === undefined || query.statuses.length === 0 ? undefined : inArray(gateIns.status, [...query.statuses]),
        after === undefined
          ? undefined
          : sql`(${gateIns.gatedInAt}, ${gateIns.id}) < (${after.gatedInAt}::timestamptz, ${after.id}::uuid)`,
      ),
    )
    .orderBy(desc(gateIns.gatedInAt), desc(gateIns.id))
    .limit(pageSize + 1);
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const entries = await entriesOfInTx(tx, tenantId, page.map((entry) => entry.row), 'masked', nowMs);
  const last = page.at(-1);
  return {
    items: entries,
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({ createdAt: fullPrecisionInstant(last.gatedInAtText), id: last.row.id })
        : null,
  };
}

async function entriesOfInTx(
  tx: TenantTx,
  tenantId: string,
  rows: readonly GateInRow[],
  phone: PhoneMode,
  nowMs: number,
): Promise<GateInEntryView[]> {
  const ids = rows.map((row) => row.id);
  const documentCounts = new Map<string, number>();
  const receiptCounts = new Map<string, number>();
  if (ids.length > 0) {
    const docs = await tx
      .select({ gateInId: gateInDocuments.gateInId, n: sql<number>`count(*)::int` })
      .from(gateInDocuments)
      .where(and(eq(gateInDocuments.tenantId, tenantId), inArray(gateInDocuments.gateInId, ids)))
      .groupBy(gateInDocuments.gateInId);
    for (const doc of docs) documentCounts.set(doc.gateInId, doc.n);
    const receipts = await tx
      .select({ gateInId: goodsReceiptNotes.gateInId, n: sql<number>`count(*)::int` })
      .from(goodsReceiptNotes)
      .where(and(eq(goodsReceiptNotes.tenantId, tenantId), inArray(goodsReceiptNotes.gateInId, ids)))
      .groupBy(goodsReceiptNotes.gateInId);
    for (const receipt of receipts) {
      if (receipt.gateInId !== null) receiptCounts.set(receipt.gateInId, receipt.n);
    }
  }
  return rows.map((row) => {
    const { flag, difference } = packagesFlagOf(row.packagesDeclared, row.packagesCounted);
    return {
      ...gateInHeaderView(row, phone),
      documentCount: documentCounts.get(row.id) ?? 0,
      receiptCount: receiptCounts.get(row.id) ?? 0,
      packagesFlag: flag,
      packagesDifference: difference,
      staleOpen: row.status !== 'gated_out' && Date.parse(canonicalInstant(row.gatedInAt)) < nowMs - STALE_OPEN_DAYS * DAY_MS,
    };
  });
}

/**
 * One gate-in's detail: the list entry plus its documents (each with the PO
 * or ASN code it covers) and its receipts with their client. The phone is in
 * full only when the caller holds `gate.manage` (`phone`). Null when absent.
 */
export async function gateInDetailInTx(
  tx: TenantTx,
  tenantId: string,
  gateInId: string,
  phone: PhoneMode,
  nowMs: number,
): Promise<GateInDetailView | null> {
  const row = await gateInRowInTx(tx, tenantId, gateInId);
  if (row === null) return null;
  const [entry] = await entriesOfInTx(tx, tenantId, [row], phone, nowMs);
  const documentRows = await tx
    .select({ document: gateInDocuments, poCode: purchaseOrders.code, asnCode: advanceShipmentNotices.asnCode })
    .from(gateInDocuments)
    .leftJoin(purchaseOrders, and(eq(purchaseOrders.tenantId, gateInDocuments.tenantId), eq(purchaseOrders.id, gateInDocuments.poId)))
    .leftJoin(
      advanceShipmentNotices,
      and(eq(advanceShipmentNotices.tenantId, gateInDocuments.tenantId), eq(advanceShipmentNotices.id, gateInDocuments.asnId)),
    )
    .where(and(eq(gateInDocuments.tenantId, tenantId), eq(gateInDocuments.gateInId, row.id)))
    .orderBy(asc(gateInDocuments.position));
  const receiptRows = await tx
    .select({
      id: goodsReceiptNotes.id,
      code: goodsReceiptNotes.code,
      clientId: goodsReceiptNotes.clientId,
      poId: goodsReceiptNotes.poId,
      asnId: goodsReceiptNotes.asnId,
      poCode: purchaseOrders.code,
      asnCode: advanceShipmentNotices.asnCode,
    })
    .from(goodsReceiptNotes)
    .leftJoin(purchaseOrders, and(eq(purchaseOrders.tenantId, goodsReceiptNotes.tenantId), eq(purchaseOrders.id, goodsReceiptNotes.poId)))
    .leftJoin(
      advanceShipmentNotices,
      and(eq(advanceShipmentNotices.tenantId, goodsReceiptNotes.tenantId), eq(advanceShipmentNotices.id, goodsReceiptNotes.asnId)),
    )
    .where(and(eq(goodsReceiptNotes.tenantId, tenantId), eq(goodsReceiptNotes.gateInId, row.id)))
    .orderBy(asc(goodsReceiptNotes.createdAt), asc(goodsReceiptNotes.id));
  return {
    ...entry!,
    documents: documentRows.map(({ document, poCode, asnCode }) => ({ ...documentView(document), poCode, asnCode })),
    receipts: receiptRows.map((receipt) => ({
      id: receipt.id,
      code: receipt.code,
      clientId: receipt.clientId,
      document:
        receipt.poId !== null
          ? { kind: 'po' as const, code: receipt.poCode }
          : receipt.asnId !== null
            ? { kind: 'asn' as const, code: receipt.asnCode }
            : { kind: 'blind' as const, code: null },
    })),
  };
}

// ── the device snapshot ───────────────────────────────────────────────────────

/**
 * The device's open gate-ins (decision 15): not gated out, gated in within
 * the last `DEVICE_OPEN_GATE_IN_DAYS` days, at most `MAX_DEVICE_OPEN_GATE_INS`,
 * newest first — an `…InTx` passthrough on the snapshot's own transaction
 * (inbound Gotcha 2: the snapshot never nests a connection).
 */
export async function openGateInsInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  nowMs: number,
): Promise<OpenGateInView[]> {
  const since = new Date(nowMs - DEVICE_OPEN_GATE_IN_DAYS * DAY_MS).toISOString();
  const rows = await tx
    .select()
    .from(gateIns)
    .where(
      and(
        eq(gateIns.tenantId, tenantId),
        eq(gateIns.warehouseId, warehouseId),
        ne(gateIns.status, 'gated_out'),
        sql`${gateIns.gatedInAt} >= ${since}::timestamptz`,
      ),
    )
    .orderBy(desc(gateIns.gatedInAt), desc(gateIns.id))
    .limit(MAX_DEVICE_OPEN_GATE_INS);
  const documents =
    rows.length === 0
      ? []
      : await tx
          .select({ gateInId: gateInDocuments.gateInId, kind: gateInDocuments.kind, number: gateInDocuments.number })
          .from(gateInDocuments)
          .where(and(eq(gateInDocuments.tenantId, tenantId), inArray(gateInDocuments.gateInId, rows.map((row) => row.id))))
          .orderBy(asc(gateInDocuments.gateInId), asc(gateInDocuments.position));
  const byGateIn = new Map<string, { kind: GateInDocumentKind; number: string }[]>();
  for (const doc of documents) {
    const list = byGateIn.get(doc.gateInId) ?? [];
    list.push({ kind: doc.kind as GateInDocumentKind, number: doc.number });
    byGateIn.set(doc.gateInId, list);
  }
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    vehicleNo: row.vehicleNo,
    handDelivery: row.handDelivery,
    transporterLabel: transporterLabelOf(row),
    dockDoor: row.dockDoor,
    status: row.status as GateInStatus,
    sealStatus: row.sealStatus as SealStatus,
    // Decision 17 — the dock counts blind: the declared figure never reaches the device.
    unloadStartedAt: instantOrNull(row.unloadStartedAt),
    documents: byGateIn.get(row.id) ?? [],
  }));
}

// ── the receipt link ──────────────────────────────────────────────────────────

/** Why a receipt naming a gate-in booked unlinked — a closed vocabulary. */
export const GATE_IN_LINK_REASONS = ['unknown', 'other-warehouse'] as const;
export type GateInLinkReason = (typeof GATE_IN_LINK_REASONS)[number];

export interface GateInLinkNotLinked {
  readonly status: 'not-linked';
  readonly reason: GateInLinkReason;
}

/**
 * Story 2-3a — the receipt's gate-in link, resolved by a PLAIN read (no lock:
 * the GRN reads the gate-in before its PO/ASN lock, and nothing locks a
 * gate-in and then a document, so no cycle). It NEVER refuses (decision 5 —
 * a queued receipt's 4xx would drop real goods to review over a wrong visit
 * id): an unknown or non-uuid id, or another warehouse's gate-in, answers
 * `not-linked` with its reason and the receipt books unlinked. A `gated_out`
 * gate-in links (the dock may sync after the truck left).
 */
export async function resolveGateInLinkInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  gateInId: string,
): Promise<{ readonly linked: { readonly id: string; readonly code: string } | null; readonly notLinked: GateInLinkNotLinked | null }> {
  const row = typeof gateInId === 'string' ? await gateInRowInTx(tx, tenantId, gateInId) : null;
  if (row === null) return { linked: null, notLinked: { status: 'not-linked', reason: 'unknown' } };
  if (row.warehouseId !== warehouseId) return { linked: null, notLinked: { status: 'not-linked', reason: 'other-warehouse' } };
  return { linked: { id: row.id, code: row.code }, notLinked: null };
}

/** The GRN list's gate-in column: each linked gate-in's code and vehicle (one read over the page's ids). */
export async function gateInLabelsInTx(
  tx: TenantTx,
  tenantId: string,
  gateInIds: readonly string[],
): Promise<Map<string, { readonly code: string; readonly vehicleNo: string | null }>> {
  const distinct = [...new Set(gateInIds)];
  if (distinct.length === 0) return new Map();
  const rows = await tx
    .select({ id: gateIns.id, code: gateIns.code, vehicleNo: gateIns.vehicleNo })
    .from(gateIns)
    .where(and(eq(gateIns.tenantId, tenantId), inArray(gateIns.id, distinct)));
  return new Map(rows.map((row) => [row.id, { code: row.code, vehicleNo: row.vehicleNo }]));
}
