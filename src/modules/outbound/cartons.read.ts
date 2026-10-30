/**
 * Story 4-5a — the pack and carton reads (A9, A11, A48, D4).
 *
 * `packRecordOfOrderInTx` is THE pack read every consumer builds on: the cartons
 * read, the packing documents (A12), the handover and the re-carton. It returns
 * the order's live pack, else its latest stored pack by seq (a cancelled order
 * shows its `cancelled` pack — A48), else the VIRTUAL pack of an order packed
 * before 4-5a (A9): pack 1, one carton holding the `pack.packed` events'
 * per-SKU quantities, the measurements from those docs, no frozen parties. No
 * row is ever materialised for a virtual pack (A34).
 *
 * Quantities in the record are milli-units; the views convert at the edge.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { auditEvents, orderCartonLines, orderCartons, orderPacks, skus } from '../../shared/db/schema';
import type { LedgerEvent, OrderCarton, OrderPack } from '../../shared/db/schema';
import { cartonCode } from '../../shared/primitives/carton-code';
import { canonicalInstant } from '../../shared/primitives/time';
import { fromMilli, toMilli } from '../../shared/primitives/quantity';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { MAX_WEIGHT_GRAMS } from './pack.command';
import { shipmentWeightOf, type CartonDimensions, type CartonTotalsTarget, type OrderPackStatus } from './cartons';
import type { PackDocumentPartiesV1 } from './order-packs';

/** One SKU in one carton of the record (milli-units). */
export interface PackRecordLine {
  readonly skuId: string;
  readonly qty: number;
  readonly handlingUnitIds: readonly string[] | null;
}

export interface PackRecordCarton {
  /** Null on a virtual pack's carton (no row). */
  readonly id: string | null;
  readonly seq: number;
  readonly code: string;
  readonly weightGrams: number | null;
  readonly dimensionsMm: CartonDimensions | null;
  /** Milli-units. */
  readonly unitCount: number;
  readonly lines: readonly PackRecordLine[];
  readonly handoverId: string | null;
  readonly handoverScannedAt: string | null;
}

/** A pack, stored or virtual (A9). */
export interface PackRecord {
  /** Null on a virtual pack. */
  readonly id: string | null;
  readonly seq: number;
  readonly status: OrderPackStatus;
  /** True for the virtual pack of an order packed before 4-5a. */
  readonly legacy: boolean;
  /** The frozen parties; null on a virtual pack (the documents print the live ones with the note). */
  readonly parties: PackDocumentPartiesV1 | null;
  readonly partiesFrozenAt: string | null;
  readonly cartonCount: number;
  /** The true Σ (≤ 200,000,000) — use `shipmentWeightOf` before it flows into a shipment (A33). */
  readonly grossWeightGrams: number | null;
  /** The physical pack (A47 — a re-carton copies it). */
  readonly packedAt: string;
  readonly packedBy: string;
  /** The row's own instant — a re-carton's "Re-packed" time when `seq > 1`; the pack time on a virtual pack. */
  readonly createdAt: string;
  readonly cartons: readonly PackRecordCarton[];
}

/** One pack in the cartons read's history. */
export interface PackHistoryRecord {
  readonly seq: number;
  readonly status: OrderPackStatus;
  readonly cartonCount: number;
  readonly endedAt: string | null;
  readonly endedBy: string | null;
  readonly endReason: string | null;
}

/** The order facts the pack read needs. */
export interface PackOrderFacts {
  readonly id: string;
  readonly warehouseId: string;
  readonly status: string;
}

/** The ledger feed `InventoryFacade.ledgerEventsByOrderRefInTx` returns, as a callback (outbound reads no ledger table). */
export type OrderLedgerEventsReader = (
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  orderId: string,
) => Promise<readonly LedgerEvent[]>;

interface PackDocRef {
  readonly kind?: string;
  readonly packedQty?: number;
  readonly weightGrams?: number;
  readonly lengthMm?: number;
  readonly widthMm?: number;
  readonly heightMm?: number;
  readonly handlingUnitIds?: readonly string[];
}

function sortById<T extends { readonly skuId: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => (left.skuId < right.skuId ? -1 : left.skuId > right.skuId ? 1 : 0));
}

/**
 * A9 — the virtual pack of an order packed before 4-5a, from its `pack.packed`
 * events; null when there are none. Zero-quantity entries are dropped (A36).
 */
export function virtualPackOf(
  orderId: string,
  orderStatus: string,
  events: readonly LedgerEvent[],
): PackRecord | null {
  const packed = events.filter((event) => event.type === 'pack.packed');
  if (packed.length === 0) return null;
  const qtyBySku = new Map<string, number>();
  const idsBySku = new Map<string, string[]>();
  let weightGrams: number | null = null;
  let dimensionsMm: CartonDimensions | null = null;
  for (const event of packed) {
    const doc = event.referenceDoc as PackDocRef;
    const qty = toMilli(doc.packedQty ?? 0);
    qtyBySku.set(event.skuId, (qtyBySku.get(event.skuId) ?? 0) + qty);
    if (doc.handlingUnitIds !== undefined && doc.handlingUnitIds.length > 0) {
      idsBySku.set(event.skuId, [...(idsBySku.get(event.skuId) ?? []), ...doc.handlingUnitIds]);
    }
    if (weightGrams === null && typeof doc.weightGrams === 'number') weightGrams = doc.weightGrams;
    if (dimensionsMm === null && typeof doc.lengthMm === 'number' && typeof doc.widthMm === 'number' && typeof doc.heightMm === 'number') {
      dimensionsMm = { lengthMm: doc.lengthMm, widthMm: doc.widthMm, heightMm: doc.heightMm };
    }
  }
  const lines = sortById(
    [...qtyBySku.entries()]
      .filter(([, qty]) => qty !== 0)
      .map(([skuId, qty]) => {
        const ids = idsBySku.get(skuId);
        return { skuId, qty, handlingUnitIds: ids === undefined ? null : [...ids].sort() };
      }),
  );
  const first = [...packed].sort((left, right) => (left.occurredAt < right.occurredAt ? -1 : left.occurredAt > right.occurredAt ? 1 : 0))[0]!;
  const packedAt = canonicalInstant(first.occurredAt);
  return {
    id: null,
    seq: 1,
    // A48 — a virtual pack's status follows the order.
    status: orderStatus === 'cancelled' ? 'cancelled' : 'live',
    legacy: true,
    parties: null,
    partiesFrozenAt: null,
    cartonCount: 1,
    grossWeightGrams: weightGrams,
    packedAt,
    packedBy: first.actorUserId,
    createdAt: packedAt,
    cartons: [
      {
        id: null,
        seq: 1,
        code: cartonCode(orderId, 1, 1),
        weightGrams,
        dimensionsMm,
        unitCount: lines.reduce((sum, line) => sum + line.qty, 0),
        lines,
        handoverId: null,
        handoverScannedAt: null,
      },
    ],
  };
}

function dimensionsOfRow(row: OrderCarton): CartonDimensions | null {
  return row.lengthMm === null || row.widthMm === null || row.heightMm === null
    ? null
    : { lengthMm: row.lengthMm, widthMm: row.widthMm, heightMm: row.heightMm };
}

function instantOrNull(value: string | null): string | null {
  return value === null ? null : canonicalInstant(value);
}

/** The stored pack row with its cartons and lines, as a record. */
async function storedPackRecordInTx(tx: TenantTx, tenantId: string, pack: OrderPack): Promise<PackRecord> {
  const cartonRows = await tx
    .select()
    .from(orderCartons)
    .where(and(eq(orderCartons.tenantId, tenantId), eq(orderCartons.packId, pack.id)))
    .orderBy(asc(orderCartons.seq));
  const lineRows =
    cartonRows.length === 0
      ? []
      : await tx
          .select()
          .from(orderCartonLines)
          .where(and(eq(orderCartonLines.tenantId, tenantId), inArray(orderCartonLines.cartonId, cartonRows.map((row) => row.id))));
  const linesByCarton = new Map<string, PackRecordLine[]>();
  for (const line of lineRows) {
    const list = linesByCarton.get(line.cartonId) ?? [];
    list.push({
      skuId: line.skuId,
      qty: Number(line.qty),
      handlingUnitIds: line.handlingUnitIds === null ? null : [...(line.handlingUnitIds as string[])],
    });
    linesByCarton.set(line.cartonId, list);
  }
  return {
    id: pack.id,
    seq: pack.seq,
    status: pack.status as OrderPackStatus,
    legacy: false,
    parties: pack.documentParties as PackDocumentPartiesV1,
    partiesFrozenAt: canonicalInstant(pack.partiesFrozenAt),
    cartonCount: pack.cartonCount,
    grossWeightGrams: pack.grossWeightGrams,
    packedAt: canonicalInstant(pack.packedAt),
    packedBy: pack.packedBy,
    createdAt: canonicalInstant(pack.createdAt),
    cartons: cartonRows.map((row) => ({
      id: row.id,
      seq: row.seq,
      code: row.code,
      weightGrams: row.weightGrams,
      dimensionsMm: dimensionsOfRow(row),
      unitCount: Number(row.unitCount),
      lines: sortById(linesByCarton.get(row.id) ?? []),
      handoverId: row.handoverId,
      handoverScannedAt: instantOrNull(row.handoverScannedAt),
    })),
  };
}

/**
 * The order's pack (A48): the live pack, else the latest stored pack by seq,
 * else the virtual pack (A9), else null (never packed). The ledger feed is
 * read only when no pack is stored.
 */
export async function packRecordOfOrderInTx(
  tx: TenantTx,
  tenantId: string,
  order: PackOrderFacts,
  ledgerEvents: OrderLedgerEventsReader,
): Promise<PackRecord | null> {
  const rows = await tx
    .select()
    .from(orderPacks)
    .where(and(eq(orderPacks.tenantId, tenantId), eq(orderPacks.orderId, order.id)))
    .orderBy(desc(orderPacks.seq));
  const chosen = rows.find((row) => row.status === 'live') ?? rows[0];
  if (chosen !== undefined) return storedPackRecordInTx(tx, tenantId, chosen);
  return virtualPackOf(order.id, order.status, await ledgerEvents(tx, tenantId, order.warehouseId, order.id));
}

/** The end of a re-cartoned legacy order's virtual pack 1, from the `order.recartoned` audit row that ended it. */
async function virtualPackEndInTx(
  tx: TenantTx,
  tenantId: string,
  orderId: string,
): Promise<{ endedAt: string | null; endedBy: string | null; endReason: string | null } | null> {
  const [row] = await tx
    .select({ occurredAt: auditEvents.occurredAt, actorUserId: auditEvents.actorUserId, changes: auditEvents.changes })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.targetType, 'order'),
        eq(auditEvents.targetId, orderId),
        eq(auditEvents.action, 'order.recartoned'),
        sql`${auditEvents.changes}->>'previousPackSeq' = '1'`,
      ),
    )
    .orderBy(asc(auditEvents.occurredAt))
    .limit(1);
  if (row === undefined) return null;
  const changes = (row.changes ?? {}) as { reason?: unknown };
  return {
    endedAt: instantOrNull(row.occurredAt),
    endedBy: row.actorUserId,
    endReason: typeof changes.reason === 'string' ? changes.reason : null,
  };
}

/** The order's pack history, newest first: every stored pack, and the virtual pack 1 of a re-cartoned legacy order. */
export async function packHistoryOfOrderInTx(
  tx: TenantTx,
  tenantId: string,
  order: PackOrderFacts,
  ledgerEvents: OrderLedgerEventsReader,
): Promise<PackHistoryRecord[]> {
  const rows = await tx
    .select()
    .from(orderPacks)
    .where(and(eq(orderPacks.tenantId, tenantId), eq(orderPacks.orderId, order.id)))
    .orderBy(desc(orderPacks.seq));
  const history: PackHistoryRecord[] = rows.map((row) => ({
    seq: row.seq,
    status: row.status as OrderPackStatus,
    cartonCount: row.cartonCount,
    endedAt: instantOrNull(row.endedAt),
    endedBy: row.endedBy,
    endReason: row.endReason,
  }));
  if (!rows.some((row) => row.seq === 1)) {
    const virtual = virtualPackOf(order.id, order.status, await ledgerEvents(tx, tenantId, order.warehouseId, order.id));
    if (virtual !== null) {
      const superseded = rows.length > 0;
      // A virtual pack has no row to carry its end: the re-carton that ended it (the one whose
      // previous pack was 1) recorded its instant, actor and reason on its audit row.
      const ended = superseded ? await virtualPackEndInTx(tx, tenantId, order.id) : null;
      history.push({
        seq: 1,
        status: superseded ? 'superseded' : virtual.status,
        cartonCount: 1,
        endedAt: ended?.endedAt ?? null,
        endedBy: ended?.endedBy ?? null,
        endReason: ended?.endReason ?? null,
      });
    }
  }
  return history;
}

/** A pack's per-SKU totals and case ids — the target a re-carton must match (A8 step 8). */
export function packTotalsOf(record: PackRecord): CartonTotalsTarget {
  const totals = new Map<string, number>();
  const ids = new Map<string, string[]>();
  for (const carton of record.cartons) {
    for (const line of carton.lines) {
      totals.set(line.skuId, (totals.get(line.skuId) ?? 0) + line.qty);
      if (line.handlingUnitIds !== null && line.handlingUnitIds.length > 0) {
        ids.set(line.skuId, [...(ids.get(line.skuId) ?? []), ...line.handlingUnitIds]);
      }
    }
  }
  const handlingUnitIdsBySku = new Map<string, readonly string[]>();
  for (const [skuId, list] of ids) handlingUnitIdsBySku.set(skuId, [...list].sort());
  return { totals, handlingUnitIdsBySku };
}

// ── the live packs of several orders (the handover, 4-9a) ──────────────────

/** D4 — what the handover and the candidates read merge over the ledger measurement. */
export interface LivePackFacts {
  readonly packId: string;
  readonly packSeq: number;
  readonly cartonCount: number;
  /** The gross only when it fits a shipment (A33); else null. */
  readonly weightGrams: number | null;
  /** Only for a one-carton pack with dimensions (A39). */
  readonly dimensionsMm: CartonDimensions | null;
}

/**
 * D4 / A39 — the STORED live packs of several orders (a virtual pack has no
 * row; the caller falls back to the ledger measurement for it).
 */
export async function livePackFactsOfOrdersInTx(
  tx: TenantTx,
  tenantId: string,
  orderIds: readonly string[],
): Promise<Map<string, LivePackFacts>> {
  const facts = new Map<string, LivePackFacts>();
  if (orderIds.length === 0) return facts;
  const packs = await tx
    .select()
    .from(orderPacks)
    .where(and(eq(orderPacks.tenantId, tenantId), inArray(orderPacks.orderId, [...orderIds]), eq(orderPacks.status, 'live')));
  const onePackIds = packs.filter((pack) => pack.cartonCount === 1).map((pack) => pack.id);
  const single =
    onePackIds.length === 0
      ? []
      : await tx
          .select()
          .from(orderCartons)
          .where(and(eq(orderCartons.tenantId, tenantId), inArray(orderCartons.packId, onePackIds)));
  const singleByPack = new Map(single.map((row) => [row.packId, row]));
  for (const pack of packs) {
    const only = singleByPack.get(pack.id);
    facts.set(pack.orderId, {
      packId: pack.id,
      packSeq: pack.seq,
      cartonCount: pack.cartonCount,
      weightGrams: shipmentWeightOf(pack.grossWeightGrams, MAX_WEIGHT_GRAMS),
      dimensionsMm: only === undefined ? null : dimensionsOfRow(only),
    });
  }
  return facts;
}

/** Decision 10 — one live carton, for 4-9a's loading sheet and freight weight. */
export interface LiveCartonFacts {
  readonly id: string;
  readonly seq: number;
  readonly code: string;
  readonly weightGrams: number | null;
  readonly dimensionsMm: CartonDimensions | null;
  readonly handoverId: string | null;
  readonly handoverScannedAt: string | null;
}

/** Decision 10 — the stored live cartons of several orders, by order id, each list in seq order. */
export async function liveCartonsOfOrdersInTx(
  tx: TenantTx,
  tenantId: string,
  orderIds: readonly string[],
): Promise<Map<string, { readonly packSeq: number; readonly cartons: readonly LiveCartonFacts[] }>> {
  const result = new Map<string, { packSeq: number; cartons: LiveCartonFacts[] }>();
  if (orderIds.length === 0) return result;
  const rows = await tx
    .select({ carton: orderCartons, packSeq: orderPacks.seq })
    .from(orderCartons)
    .innerJoin(orderPacks, and(eq(orderPacks.id, orderCartons.packId), eq(orderPacks.tenantId, orderCartons.tenantId)))
    .where(and(eq(orderCartons.tenantId, tenantId), inArray(orderCartons.orderId, [...orderIds]), eq(orderPacks.status, 'live')))
    .orderBy(asc(orderCartons.orderId), asc(orderCartons.seq));
  for (const { carton, packSeq } of rows) {
    const entry = result.get(carton.orderId) ?? { packSeq, cartons: [] };
    entry.cartons.push({
      id: carton.id,
      seq: carton.seq,
      code: carton.code,
      weightGrams: carton.weightGrams,
      dimensionsMm: dimensionsOfRow(carton),
      handoverId: carton.handoverId,
      handoverScannedAt: instantOrNull(carton.handoverScannedAt),
    });
    result.set(carton.orderId, entry);
  }
  return result;
}

// ── the cartons read's view (A11, A36) ─────────────────────────────────────

export interface PackCartonLineView {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  /** Base units. */
  readonly qty: number;
  readonly handlingUnitIds: readonly string[] | null;
  /**
   * Catch weight — each case as a person finds it: `code`, the case label's barcode text (a case
   * label encodes its handling-unit id), and its receipt weight. Absent when the reader is not given.
   */
  readonly handlingUnits?: readonly CartonCaseView[];
}

export interface CartonCaseView {
  readonly id: string;
  readonly code: string;
  /** Null when the case is no longer on record. */
  readonly weightGrams: number | null;
}

/** The catalog seam for a case's weight (`CatalogFacade.handlingUnitsByIdsInTx` — outbound reads no catalog table). */
export type CaseFactsReader = (
  tx: TenantTx,
  tenantId: string,
  ids: readonly string[],
) => Promise<readonly { readonly id: string; readonly weightGrams: number }[]>;

export interface UomTotalView {
  readonly uom: string;
  /** Base units. */
  readonly qty: number;
}

export interface PackCartonView {
  readonly seq: number;
  readonly code: string;
  readonly weightGrams: number | null;
  readonly dimensionsMm: CartonDimensions | null;
  readonly lineCount: number;
  /** A36 — per UoM, never a cross-UoM unit total. */
  readonly totals: readonly UomTotalView[];
  readonly lines: readonly PackCartonLineView[];
}

export interface PackView {
  readonly packSeq: number;
  readonly status: OrderPackStatus;
  readonly legacy: boolean;
  readonly partiesFrozen: boolean;
  readonly cartonCount: number;
  readonly grossWeightGrams: number | null;
  readonly packedAt: string;
  readonly packedBy: string;
  readonly cartons: readonly PackCartonView[];
}

/** SKU code, name and UoM by id (one read). */
export async function skuFactsByIdInTx(
  tx: TenantTx,
  tenantId: string,
  skuIds: readonly string[],
): Promise<Map<string, { readonly code: string; readonly name: string; readonly uom: string }>> {
  if (skuIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: skus.id, code: skus.code, name: skus.name, uom: skus.uom })
    .from(skus)
    .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, [...new Set(skuIds)])));
  return new Map(rows.map((row) => [row.id, { code: row.code, name: row.name, uom: row.uom }]));
}

/** Per-UoM totals of some lines (base units), sorted by UoM. */
export function uomTotalsOf(lines: readonly { readonly uom: string; readonly qty: number }[]): UomTotalView[] {
  const milli = new Map<string, number>();
  for (const line of lines) milli.set(line.uom, (milli.get(line.uom) ?? 0) + toMilli(line.qty));
  return [...milli.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([uom, qty]) => ({ uom, qty: fromMilli(qty) }));
}

export async function packViewInTx(tx: TenantTx, tenantId: string, record: PackRecord, caseFacts?: CaseFactsReader): Promise<PackView> {
  const facts = await skuFactsByIdInTx(
    tx,
    tenantId,
    record.cartons.flatMap((carton) => carton.lines.map((line) => line.skuId)),
  );
  const caseIds = record.cartons.flatMap((carton) => carton.lines.flatMap((line) => line.handlingUnitIds ?? []));
  const caseWeights =
    caseFacts === undefined || caseIds.length === 0
      ? null
      : new Map((await caseFacts(tx, tenantId, caseIds)).map((unit) => [unit.id, unit.weightGrams] as const));
  return {
    packSeq: record.seq,
    status: record.status,
    legacy: record.legacy,
    partiesFrozen: record.parties !== null,
    cartonCount: record.cartonCount,
    grossWeightGrams: record.grossWeightGrams,
    packedAt: record.packedAt,
    packedBy: record.packedBy,
    cartons: record.cartons.map((carton) => {
      const lines: PackCartonLineView[] = carton.lines.map((line) => {
        const sku = facts.get(line.skuId);
        return {
          skuId: line.skuId,
          skuCode: sku?.code ?? line.skuId,
          skuName: sku?.name ?? line.skuId,
          uom: sku?.uom ?? '',
          qty: fromMilli(line.qty),
          handlingUnitIds: line.handlingUnitIds,
          ...(caseWeights === null || line.handlingUnitIds === null
            ? {}
            : { handlingUnits: line.handlingUnitIds.map((id) => ({ id, code: id, weightGrams: caseWeights.get(id) ?? null })) }),
        };
      });
      return {
        seq: carton.seq,
        code: carton.code,
        weightGrams: carton.weightGrams,
        dimensionsMm: carton.dimensionsMm,
        lineCount: lines.length,
        totals: uomTotalsOf(lines),
        lines,
      };
    }),
  };
}

/** 409 `order-not-packed` — the order has no pack to print or re-split (A8 step 5, A11, A13, A14). */
export function orderNotPacked(label: string, status: string, detail?: string): ProblemException {
  return new ProblemException(
    'order-not-packed',
    409,
    'Order is not packed',
    detail ?? `Order ${label} reads "${status.replace(/_/g, ' ')}" — it has no live pack here.`,
    { orderStatus: status },
  );
}
