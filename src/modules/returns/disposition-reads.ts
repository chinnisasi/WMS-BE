import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  returnAuthorizationLines,
  returnAuthorizations,
  returnDispositions,
  returnHoldSettlements,
  returnReceiptLines,
  returnReceipts,
} from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { CursorPayload, Page } from '../../shared/primitives/pagination';
import { portalPageByCreatedAt } from '../../shared/primitives/portal-page';
import { encodeCursor } from '../../shared/primitives/pagination';
import { fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import type { CatalogFacade } from '../catalog/catalog.facade';
import type { RmaStatus, ReturnReasonCode } from './return-authorization.command';
import type { ReturnCondition } from './return-receipt.command';
import type { ReturnDispositionOutcome, ReturnDispositionReason } from './return-disposition.command';
import { EMPTY_SPLIT, lineSplitsInTx } from './disposition-split';

// ── the awaiting-disposition queue (web, returns.manage reads it) ────────────

/** One receipt line still awaiting a disposition — the web queue's card (base units). */
export interface AwaitingDispositionRow {
  readonly receiptLineId: string;
  readonly receiptCode: string;
  /** The receipt's business time (device time, canonical). */
  readonly receivedAt: string;
  readonly rmaId: string;
  readonly rmaCode: string;
  readonly orderReference: string | null;
  readonly clientId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly condition: ReturnCondition;
  readonly note: string | null;
  readonly batchCode: string | null;
  readonly serialNumber: string | null;
  readonly weightGrams: number | null;
  readonly receivedQty: number;
  readonly openQty: number;
  readonly onHoldQty: number;
  /** A14 — how many times the line was quarantined before, and the latest reason given. */
  readonly priorQuarantines: number;
  readonly lastReasonCode: string | null;
}

export interface AwaitingQuery {
  readonly warehouseId?: string | undefined;
  readonly clientId?: string | undefined;
  readonly after: CursorPayload | null;
  readonly limit: number;
}

/**
 * Story 4-7a — the awaiting-disposition queue: every receipt line with
 * `open_qty > 0`, OLDEST first (keyset `(created_at, id)` ASC on the
 * full-precision instant), optionally one warehouse's and one client's. The
 * filters are predicates in the query, before the limit — no short pages.
 * The partial index `return_receipt_lines_tenant_open_idx` serves the order.
 */
export async function awaitingDispositionsInTx(
  tx: TenantTx,
  catalog: CatalogFacade,
  tenantId: string,
  query: AwaitingQuery,
): Promise<Page<AwaitingDispositionRow>> {
  const rows = await tx
    .select({
      line: returnReceiptLines,
      createdAtText: sql<string>`${returnReceiptLines.createdAt}::text`,
      receiptCode: returnReceipts.code,
      receivedAt: returnReceipts.occurredAt,
      clientId: returnReceipts.clientId,
      warehouseId: returnReceipts.warehouseId,
      rmaId: returnReceipts.rmaId,
      rmaCode: returnAuthorizations.code,
      orderReference: returnAuthorizations.orderReference,
    })
    .from(returnReceiptLines)
    .innerJoin(
      returnReceipts,
      and(eq(returnReceipts.tenantId, returnReceiptLines.tenantId), eq(returnReceipts.id, returnReceiptLines.returnReceiptId)),
    )
    .innerJoin(
      returnAuthorizations,
      and(eq(returnAuthorizations.tenantId, returnReceipts.tenantId), eq(returnAuthorizations.id, returnReceipts.rmaId)),
    )
    .where(
      and(
        eq(returnReceiptLines.tenantId, tenantId),
        sql`${returnReceiptLines.openQty} > 0`,
        query.warehouseId === undefined ? undefined : eq(returnReceipts.warehouseId, query.warehouseId),
        query.clientId === undefined ? undefined : eq(returnReceipts.clientId, query.clientId),
        query.after === null
          ? undefined
          : sql`(${returnReceiptLines.createdAt}, ${returnReceiptLines.id}) > (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid)`,
      ),
    )
    .orderBy(asc(returnReceiptLines.createdAt), asc(returnReceiptLines.id))
    .limit(query.limit + 1);
  const kept = rows.slice(0, query.limit);
  const lines = kept.map((row) => row.line);
  const skuIds = [...new Set(lines.map((line) => line.skuId))];
  const facts = await catalog.skuFactsInTx(tx, tenantId, skuIds);
  const batchCodes = await catalog.batchCodesByIdsInTx(
    tx,
    tenantId,
    lines.flatMap((line) => (line.batchId === null ? [] : [line.batchId])),
  );
  const serialNumbers = await catalog.serialNumbersByIdsInTx(
    tx,
    tenantId,
    lines.flatMap((line) => (line.serialId === null ? [] : [line.serialId])),
  );
  const weights = new Map(
    (
      await catalog.handlingUnitsByIdsInTx(
        tx,
        tenantId,
        lines.flatMap((line) => (line.handlingUnitId === null ? [] : [line.handlingUnitId])),
      )
    ).map((unit) => [unit.id, unit.weightGrams]),
  );
  const splits = await lineSplitsInTx(
    tx,
    tenantId,
    lines.map((line) => line.id),
  );
  const items = kept.map((row): AwaitingDispositionRow => {
    const line = row.line;
    const sku = facts.get(line.skuId);
    const split = splits.get(line.id) ?? EMPTY_SPLIT;
    return {
      receiptLineId: line.id,
      receiptCode: row.receiptCode,
      receivedAt: canonicalInstant(row.receivedAt),
      rmaId: row.rmaId,
      rmaCode: row.rmaCode,
      orderReference: row.orderReference,
      clientId: row.clientId,
      warehouseId: row.warehouseId,
      skuId: line.skuId,
      skuCode: sku?.code ?? line.skuId,
      skuName: sku?.name ?? '',
      uom: sku?.uom ?? '',
      condition: line.condition as ReturnCondition,
      note: line.note,
      batchCode: line.batchId === null ? null : (batchCodes.get(line.batchId) ?? null),
      serialNumber: line.serialId === null ? null : (serialNumbers.get(line.serialId) ?? null),
      weightGrams: line.handlingUnitId === null ? null : (weights.get(line.handlingUnitId) ?? null),
      receivedQty: fromMilli(Number(line.qty)),
      openQty: fromMilli(Number(line.openQty)),
      onHoldQty: fromMilli(split.onHold),
      priorQuarantines: split.priorQuarantines,
      lastReasonCode: split.lastReasonCode,
    };
  });
  const last = kept.at(-1);
  return {
    items,
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? encodeCursor({ createdAt: fullPrecisionInstant(last.createdAtText), id: last.line.id })
        : null,
  };
}

/**
 * Story 4-7a (A14) — the RMA code of each named QC hold that is a return
 * hold (others are absent): the QC desk names the return without QC reading
 * a returns table (the api shell composes it).
 */
export async function rmaCodesByHoldIdsInTx(tx: TenantTx, tenantId: string, holdIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(holdIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ holdId: returnDispositions.qcHoldId, code: returnAuthorizations.code })
    .from(returnDispositions)
    .innerJoin(
      returnAuthorizations,
      and(eq(returnAuthorizations.tenantId, returnDispositions.tenantId), eq(returnAuthorizations.id, returnDispositions.rmaId)),
    )
    .where(and(eq(returnDispositions.tenantId, tenantId), inArray(returnDispositions.qcHoldId, ids)));
  return new Map(rows.map((row) => [row.holdId!, row.code]));
}

// ── the client portal (decision 11, A30) ─────────────────────────────────────

/** `?dispositionState=` — `awaiting` (anything open or on an unsettled hold) or `dispositioned`. */
export const PORTAL_DISPOSITION_STATES = ['awaiting', 'dispositioned'] as const;
export type PortalDispositionState = (typeof PORTAL_DISPOSITION_STATES)[number];

/** One of the client's return authorizations with its disposition totals (base units) — an exact allowlist. */
export interface PortalReturnRow {
  readonly id: string;
  readonly code: string;
  readonly status: RmaStatus;
  readonly orderId: string;
  readonly orderReference: string | null;
  readonly externalReference: string | null;
  readonly createdAt: string;
  readonly lineCount: number;
  readonly receivedTotal: number;
  readonly restockedTotal: number;
  readonly onHoldTotal: number;
  readonly failedInspectionTotal: number;
  readonly scrappedTotal: number;
  readonly openTotal: number;
}

export interface PortalReturnLine {
  readonly skuCode: string;
  readonly skuName: string;
  readonly authorizedQty: number;
  readonly receivedQty: number;
  readonly returnReasonCode: ReturnReasonCode;
  readonly restockedQty: number;
  readonly onHoldQty: number;
  readonly failedInspectionQty: number;
  readonly scrappedQty: number;
  readonly openQty: number;
}

export interface PortalReturnDisposition {
  readonly skuCode: string;
  readonly outcome: ReturnDispositionOutcome;
  readonly qty: number;
  readonly reasonCode: ReturnDispositionReason | null;
  readonly occurredAt: string;
}

export interface PortalReturnDetail extends PortalReturnRow {
  readonly lines: readonly PortalReturnLine[];
  readonly dispositions: readonly PortalReturnDisposition[];
}

interface Totals {
  received: number;
  restocked: number;
  scrapped: number;
  quarantined: number;
  settledHeld: number;
  failed: number;
  open: number;
}

const ZERO: Totals = { received: 0, restocked: 0, scrapped: 0, quarantined: 0, settledHeld: 0, failed: 0, open: 0 };

/**
 * The per-RMA-line totals of a set of authorizations, from the module's own
 * rows only, every query carrying `client_id = $client` on a client-scoped
 * returns table (the portal's second layer, beside the stamped transaction's
 * RLS). Keyed by RMA line id.
 */
async function rmaLineTotalsInTx(tx: TenantTx, tenantId: string, clientId: string, rmaIds: readonly string[]): Promise<Map<string, Totals>> {
  const out = new Map<string, Totals>();
  if (rmaIds.length === 0) return out;
  const get = (id: string): Totals => {
    let row = out.get(id);
    if (row === undefined) {
      row = { ...ZERO };
      out.set(id, row);
    }
    return row;
  };
  const opens = await tx
    .select({ rmaLineId: returnReceiptLines.rmaLineId, open: sql<string>`coalesce(sum(${returnReceiptLines.openQty}), 0)::bigint` })
    .from(returnReceiptLines)
    .innerJoin(
      returnReceipts,
      and(eq(returnReceipts.tenantId, returnReceiptLines.tenantId), eq(returnReceipts.id, returnReceiptLines.returnReceiptId)),
    )
    .where(and(eq(returnReceipts.tenantId, tenantId), eq(returnReceipts.clientId, clientId), inArray(returnReceipts.rmaId, [...rmaIds])))
    .groupBy(returnReceiptLines.rmaLineId);
  for (const row of opens) get(row.rmaLineId).open = Number(row.open);
  const dispositions = await tx
    .select({
      rmaLineId: returnReceiptLines.rmaLineId,
      restocked: sql<string>`coalesce(sum(${returnDispositions.qty}) filter (where ${returnDispositions.outcome} = 'restock'), 0)::bigint`,
      scrapped: sql<string>`coalesce(sum(${returnDispositions.qty}) filter (where ${returnDispositions.outcome} = 'scrap'), 0)::bigint`,
      quarantined: sql<string>`coalesce(sum(${returnDispositions.qty}) filter (where ${returnDispositions.outcome} = 'quarantine'), 0)::bigint`,
      settledHeld: sql<string>`coalesce(sum(${returnHoldSettlements.heldQty}), 0)::bigint`,
      failed: sql<string>`coalesce(sum(${returnHoldSettlements.failedQty}), 0)::bigint`,
    })
    .from(returnDispositions)
    .innerJoin(
      returnReceiptLines,
      and(eq(returnReceiptLines.tenantId, returnDispositions.tenantId), eq(returnReceiptLines.id, returnDispositions.returnReceiptLineId)),
    )
    // A6 — hold outcomes are read only through settlements keyed by the
    // client-scoped disposition rows, never by a caller-supplied hold id.
    .leftJoin(
      returnHoldSettlements,
      and(
        eq(returnHoldSettlements.tenantId, returnDispositions.tenantId),
        eq(returnHoldSettlements.dispositionId, returnDispositions.id),
        eq(returnHoldSettlements.clientId, clientId),
      ),
    )
    .where(
      and(eq(returnDispositions.tenantId, tenantId), eq(returnDispositions.clientId, clientId), inArray(returnDispositions.rmaId, [...rmaIds])),
    )
    .groupBy(returnReceiptLines.rmaLineId);
  for (const row of dispositions) {
    const totals = get(row.rmaLineId);
    totals.restocked = Number(row.restocked);
    totals.scrapped = Number(row.scrapped);
    totals.quarantined = Number(row.quarantined);
    totals.settledHeld = Number(row.settledHeld);
    totals.failed = Number(row.failed);
  }
  return out;
}

/** The `awaiting` predicate over `return_authorizations` (A30): an open line, or a quarantine with no settlement. */
function awaitingPredicate(tenantId: string, clientId: string) {
  return sql`(
    exists (
      select 1 from ${returnReceiptLines} l
      join ${returnReceipts} r on r.tenant_id = l.tenant_id and r.id = l.return_receipt_id
      where r.tenant_id = ${tenantId}::uuid and r.client_id = ${clientId}::uuid
        and r.rma_id = ${returnAuthorizations.id} and l.open_qty > 0
    )
    or exists (
      select 1 from ${returnDispositions} d
      where d.tenant_id = ${tenantId}::uuid and d.client_id = ${clientId}::uuid
        and d.rma_id = ${returnAuthorizations.id} and d.outcome = 'quarantine'
        and not exists (
          select 1 from ${returnHoldSettlements} s
          where s.tenant_id = d.tenant_id and s.disposition_id = d.id
        )
    )
  )`;
}

function toPortalRow(
  header: typeof returnAuthorizations.$inferSelect,
  lines: readonly (typeof returnAuthorizationLines.$inferSelect)[],
  totals: Map<string, Totals>,
): PortalReturnRow {
  const sum = (pick: (t: Totals) => number): number => lines.reduce((acc, line) => acc + pick(totals.get(line.id) ?? ZERO), 0);
  return {
    id: header.id,
    code: header.code,
    status: header.status as RmaStatus,
    orderId: header.orderId,
    orderReference: header.orderReference,
    externalReference: header.externalReference,
    createdAt: canonicalInstant(header.createdAt),
    lineCount: lines.length,
    receivedTotal: fromMilli(lines.reduce((acc, line) => acc + Number(line.receivedQty), 0)),
    restockedTotal: fromMilli(sum((t) => t.restocked)),
    onHoldTotal: fromMilli(sum((t) => t.quarantined - t.settledHeld)),
    failedInspectionTotal: fromMilli(sum((t) => t.failed)),
    scrappedTotal: fromMilli(sum((t) => t.scrapped)),
    openTotal: fromMilli(sum((t) => t.open)),
  };
}

async function linesOfInTx(
  tx: TenantTx,
  tenantId: string,
  rmaIds: readonly string[],
): Promise<(typeof returnAuthorizationLines.$inferSelect)[]> {
  if (rmaIds.length === 0) return [];
  return tx
    .select()
    .from(returnAuthorizationLines)
    .where(and(eq(returnAuthorizationLines.tenantId, tenantId), inArray(returnAuthorizationLines.rmaId, [...rmaIds])))
    .orderBy(asc(returnAuthorizationLines.rmaId), asc(returnAuthorizationLines.lineNo));
}

/**
 * Story 4-7a — the client's return authorizations, newest first (keyset
 * `(created_at, id)` DESC), each with its disposition totals. Runs in the
 * caller's CLIENT-STAMPED transaction (RLS) and carries
 * `return_authorizations.client_id = $client` (the predicate) — both layers.
 * `dispositionState` filters before the limit.
 */
export async function portalReturnsInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  query: { readonly before: CursorPayload | null; readonly limit: number; readonly dispositionState?: PortalDispositionState | undefined },
): Promise<Page<PortalReturnRow>> {
  const state =
    query.dispositionState === 'awaiting'
      ? awaitingPredicate(tenantId, clientId)
      : query.dispositionState === 'dispositioned'
        ? and(inArray(returnAuthorizations.status, ['partially_received', 'received']), sql`not ${awaitingPredicate(tenantId, clientId)}`)
        : undefined;
  const rows = await tx
    .select({ header: returnAuthorizations, createdAtText: sql<string>`${returnAuthorizations.createdAt}::text` })
    .from(returnAuthorizations)
    .where(
      and(
        eq(returnAuthorizations.tenantId, tenantId),
        eq(returnAuthorizations.clientId, clientId),
        state,
        query.before === null
          ? undefined
          : sql`(${returnAuthorizations.createdAt}, ${returnAuthorizations.id}) < (${query.before.createdAt}::timestamptz, ${query.before.id}::uuid)`,
      ),
    )
    .orderBy(desc(returnAuthorizations.createdAt), desc(returnAuthorizations.id))
    .limit(query.limit + 1);
  const kept = rows.slice(0, query.limit);
  const ids = kept.map((row) => row.header.id);
  const lines = await linesOfInTx(tx, tenantId, ids);
  const totals = await rmaLineTotalsInTx(tx, tenantId, clientId, ids);
  return portalPageByCreatedAt(
    rows.map((row) => ({ id: row.header.id, createdAtText: row.createdAtText, header: row.header })),
    query.limit,
    (row) =>
      toPortalRow(
        row.header,
        lines.filter((line) => line.rmaId === row.header.id),
        totals,
      ),
  );
}

/**
 * Story 4-7a — one of the client's authorizations: the row, per line what
 * was authorized, received, restocked, on hold, failed at inspection,
 * scrapped and still open, and the dispositions oldest first. Never a bin,
 * user, note or hold id. Null for an unknown id and for another client's
 * (the same 404).
 */
export async function portalReturnInTx(
  tx: TenantTx,
  catalog: CatalogFacade,
  tenantId: string,
  clientId: string,
  rmaId: string,
): Promise<PortalReturnDetail | null> {
  const headers = await tx
    .select()
    .from(returnAuthorizations)
    .where(and(eq(returnAuthorizations.tenantId, tenantId), eq(returnAuthorizations.clientId, clientId), eq(returnAuthorizations.id, rmaId)))
    .limit(1);
  const header = headers[0];
  if (header === undefined) return null;
  const lines = await linesOfInTx(tx, tenantId, [header.id]);
  const totals = await rmaLineTotalsInTx(tx, tenantId, clientId, [header.id]);
  const dispositions = await tx
    .select({
      skuId: returnDispositions.skuId,
      outcome: returnDispositions.outcome,
      qty: returnDispositions.qty,
      reasonCode: returnDispositions.reasonCode,
      occurredAt: returnDispositions.occurredAt,
    })
    .from(returnDispositions)
    .where(and(eq(returnDispositions.tenantId, tenantId), eq(returnDispositions.clientId, clientId), eq(returnDispositions.rmaId, header.id)))
    .orderBy(asc(returnDispositions.createdAt), asc(returnDispositions.id));
  const facts = await catalog.skuFactsInTx(tx, tenantId, [...new Set([...lines.map((line) => line.skuId), ...dispositions.map((d) => d.skuId)])]);
  const codeOf = (skuId: string): string => facts.get(skuId)?.code ?? '';
  return {
    ...toPortalRow(header, lines, totals),
    lines: lines.map((line) => {
      const t = totals.get(line.id) ?? ZERO;
      return {
        skuCode: codeOf(line.skuId),
        skuName: facts.get(line.skuId)?.name ?? '',
        authorizedQty: fromMilli(Number(line.authorizedQty)),
        receivedQty: fromMilli(Number(line.receivedQty)),
        returnReasonCode: line.reasonCode as ReturnReasonCode,
        restockedQty: fromMilli(t.restocked),
        onHoldQty: fromMilli(t.quarantined - t.settledHeld),
        failedInspectionQty: fromMilli(t.failed),
        scrappedQty: fromMilli(t.scrapped),
        openQty: fromMilli(t.open),
      };
    }),
    dispositions: dispositions.map((row) => ({
      skuCode: codeOf(row.skuId),
      outcome: row.outcome as ReturnDispositionOutcome,
      qty: fromMilli(Number(row.qty)),
      reasonCode: row.reasonCode as ReturnDispositionReason | null,
      occurredAt: canonicalInstant(row.occurredAt),
    })),
  };
}
