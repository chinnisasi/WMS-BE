/**
 * Story 4-5a — the pack's document header and its cartons, written inside the
 * pack and re-carton transactions (A1–A3, A6, A8).
 *
 * `order_packs` freezes the parties the packing documents print
 * (`document_parties`, guide §7q): the brand (`ClientPartySnapshotV1`) and the
 * warehouse (`documentWarehousePartyOf` — no contact name, no phone, A45). The
 * consignee is the order's own destination, which never changes (4-2a
 * decision 6), so it is not frozen here.
 *
 * Writes only; the reads live in `cartons.read.ts`.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { orderCartonLines, orderCartons, orderPacks } from '../../shared/db/schema';
import type { OrderPack } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { cartonCode } from '../../shared/primitives/carton-code';
import type { PackageType } from '../../shared/primitives/freight';
import { documentWarehousePartyOf, type DocumentWarehouseParty } from '../../shared/documents/parties';
import { getWarehouseCodeInTx, invoicePartyFactsInTx } from '../tenancy/tenancy.service';
import { clientPartySnapshotOf, getClientInTx, type ClientPartySnapshotV1 } from '../clients/clients.facade';
import { grossWeightOf, type AggregatedCarton, type CartonDimensions, type OrderPackSource } from './cartons';

/** `order_packs.document_parties` — `order_packs_parties_shape` (0117) checks `v`, `client`, `warehouse`. */
export interface PackDocumentPartiesV1 {
  readonly v: 1;
  readonly client: ClientPartySnapshotV1;
  readonly warehouse: DocumentWarehouseParty;
}

/**
 * The parties a pack freezes, read now (A6 step 1). The warehouse is mapped key
 * by key through `documentWarehousePartyOf`, so the origin contact and phone
 * never enter it (A45).
 */
export async function documentPartiesInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  warehouseId: string,
): Promise<PackDocumentPartiesV1> {
  const client = clientPartySnapshotOf(await getClientInTx(tx, tenantId, clientId));
  const facts = await invoicePartyFactsInTx(tx, tenantId, warehouseId);
  const code = await getWarehouseCodeInTx(tx, tenantId, warehouseId);
  const warehouse = documentWarehousePartyOf({
    code,
    name: facts.warehouseName,
    gstin: facts.warehouseGstin,
    originAddress: facts.originAddress,
  });
  return { v: 1, client, warehouse };
}

/** One carton line to write: a SKU, its milli-units and (catch-weight only) its sorted case ids. */
export interface CartonLineWrite {
  readonly skuId: string;
  /** Milli-units. */
  readonly qty: number;
  readonly handlingUnitIds: readonly string[] | null;
}

/** One carton to write, in body order. */
export interface CartonWrite {
  readonly seq: number;
  readonly weightGrams: number | null;
  readonly dimensionsMm: CartonDimensions | null;
  readonly lines: readonly CartonLineWrite[];
  /** Story 4-9a (A4) — `carton` | `pallet`; absent is a carton. */
  readonly packageType?: PackageType;
  readonly innerCount?: number | null;
}

/** An aggregated body carton as a write: its SKUs sorted by id, each with its sorted ids. */
export function cartonWriteOf(carton: AggregatedCarton): CartonWrite {
  return {
    seq: carton.seq,
    weightGrams: carton.weightGrams,
    dimensionsMm: carton.dimensionsMm,
    packageType: carton.packageType,
    innerCount: carton.innerCount,
    lines: [...carton.totals.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([skuId, qty]) => ({ skuId, qty, handlingUnitIds: carton.handlingUnitIdsBySku.get(skuId) ?? null })),
  };
}

export interface InsertPackInput {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly clientId: string;
  readonly orderId: string;
  readonly seq: number;
  readonly source: OrderPackSource;
  readonly deviceId: string | null;
  readonly packedBy: string;
  readonly packedAt: string;
  readonly parties: unknown;
  readonly partiesFrozenAt: string;
  /** The command's one clock (A47): `created_at` / `updated_at` of every row. */
  readonly now: string;
  readonly cartons: readonly CartonWrite[];
}

/** One written carton, as the snapshot and the outbox name it. */
export interface WrittenCarton {
  readonly id: string;
  readonly seq: number;
  readonly code: string;
  readonly weightGrams: number | null;
  readonly dimensionsMm: CartonDimensions | null;
  /** Milli-units. */
  readonly unitCount: number;
  readonly lines: readonly CartonLineWrite[];
  readonly packageType: PackageType;
  readonly innerCount: number | null;
}

export interface WrittenPack {
  readonly id: string;
  readonly seq: number;
  readonly grossWeightGrams: number | null;
  readonly cartons: readonly WrittenCarton[];
}

/** Rows per multi-row insert — far below the 65,535 bind-parameter ceiling at ≤ 17 columns. */
const INSERT_CHUNK_ROWS = 500;

/**
 * Write a pack, its cartons and their lines. Every row carries every key
 * (outbound Gotcha 18: a multi-row insert whose rows differ in keys sends
 * DEFAULT for the missing ones), inserted in chunks.
 */
export async function insertPackInTx(tx: TenantTx, input: InsertPackInput): Promise<WrittenPack> {
  const packId = uuidv7();
  const grossWeightGrams = grossWeightOf(input.cartons);
  await tx.insert(orderPacks).values({
    id: packId,
    tenantId: input.tenantId,
    warehouseId: input.warehouseId,
    clientId: input.clientId,
    orderId: input.orderId,
    seq: input.seq,
    status: 'live',
    cartonCount: input.cartons.length,
    grossWeightGrams,
    documentParties: input.parties,
    partiesFrozenAt: input.partiesFrozenAt,
    source: input.source,
    deviceId: input.deviceId,
    packedBy: input.packedBy,
    packedAt: input.packedAt,
    endedAt: null,
    endedBy: null,
    endReason: null,
    createdAt: input.now,
    updatedAt: input.now,
  });

  const written: WrittenCarton[] = input.cartons.map((carton) => ({
    id: uuidv7(),
    seq: carton.seq,
    code: cartonCode(input.orderId, input.seq, carton.seq),
    weightGrams: carton.weightGrams,
    dimensionsMm: carton.dimensionsMm,
    unitCount: carton.lines.reduce((sum, line) => sum + line.qty, 0),
    lines: carton.lines,
    packageType: carton.packageType ?? 'carton',
    innerCount: carton.innerCount ?? null,
  }));
  const cartonRows = written.map((carton) => ({
    id: carton.id,
    tenantId: input.tenantId,
    warehouseId: input.warehouseId,
    clientId: input.clientId,
    orderId: input.orderId,
    packId,
    packSeq: input.seq,
    seq: carton.seq,
    code: carton.code,
    weightGrams: carton.weightGrams,
    lengthMm: carton.dimensionsMm?.lengthMm ?? null,
    widthMm: carton.dimensionsMm?.widthMm ?? null,
    heightMm: carton.dimensionsMm?.heightMm ?? null,
    unitCount: carton.unitCount,
    lineCount: carton.lines.length,
    handoverId: null,
    handoverScannedAt: null,
    packageType: carton.packageType,
    innerCount: carton.innerCount,
    createdAt: input.now,
  }));
  for (let at = 0; at < cartonRows.length; at += INSERT_CHUNK_ROWS) {
    await tx.insert(orderCartons).values(cartonRows.slice(at, at + INSERT_CHUNK_ROWS));
  }
  const lineRows = written.flatMap((carton) =>
    carton.lines.map((line) => ({
      id: uuidv7(),
      tenantId: input.tenantId,
      clientId: input.clientId,
      orderId: input.orderId,
      cartonId: carton.id,
      skuId: line.skuId,
      qty: line.qty,
      handlingUnitIds: line.handlingUnitIds === null ? null : [...line.handlingUnitIds],
      createdAt: input.now,
    })),
  );
  for (let at = 0; at < lineRows.length; at += INSERT_CHUNK_ROWS) {
    await tx.insert(orderCartonLines).values(lineRows.slice(at, at + INSERT_CHUNK_ROWS));
  }
  return { id: packId, seq: input.seq, grossWeightGrams, cartons: written };
}

/** The order's live pack, locked `FOR UPDATE` (A8 step 6, A10) — lock only, no status guard (guide §1). */
export async function lockLivePackInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<OrderPack | null> {
  const rows = await tx
    .select()
    .from(orderPacks)
    .where(and(eq(orderPacks.tenantId, tenantId), eq(orderPacks.orderId, orderId), eq(orderPacks.status, 'live')))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/** The live packs of several orders, `FOR SHARE` in order-id order (the handover, A21). */
export async function shareLockLivePacksInTx(
  tx: TenantTx,
  tenantId: string,
  orderIds: readonly string[],
): Promise<Map<string, OrderPack>> {
  if (orderIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(orderPacks)
    .where(and(eq(orderPacks.tenantId, tenantId), inArray(orderPacks.orderId, [...orderIds]), eq(orderPacks.status, 'live')))
    .orderBy(asc(orderPacks.orderId))
    .for('share');
  return new Map(rows.map((row) => [row.orderId, row]));
}

/** End the live pack (`superseded` with a reason, or `cancelled`), conditional on `live`. Returns false when it was not live. */
export async function endLivePackInTx(
  tx: TenantTx,
  input: {
    readonly tenantId: string;
    readonly packId: string;
    readonly status: 'superseded' | 'cancelled';
    readonly endedAt: string;
    readonly endedBy: string;
    readonly endReason: string | null;
  },
): Promise<boolean> {
  const ended = await tx
    .update(orderPacks)
    .set({
      status: input.status,
      endedAt: input.endedAt,
      endedBy: input.endedBy,
      endReason: input.status === 'superseded' ? input.endReason : null,
      updatedAt: input.endedAt,
    })
    .where(and(eq(orderPacks.id, input.packId), eq(orderPacks.tenantId, input.tenantId), eq(orderPacks.status, 'live')))
    .returning({ id: orderPacks.id });
  return ended.length === 1;
}

/** The highest stored pack seq of an order (0 when none) — a re-carton writes the next. */
export async function maxPackSeqInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<number> {
  const rows = await tx
    .select({ seq: sql<number | null>`max(${orderPacks.seq})` })
    .from(orderPacks)
    .where(and(eq(orderPacks.tenantId, tenantId), eq(orderPacks.orderId, orderId)));
  const value = rows[0]?.seq;
  return value === null || value === undefined ? 0 : Number(value);
}
