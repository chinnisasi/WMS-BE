import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ingestBackorderRefusals,
  packVerificationFailures,
  picklistLines,
  picklists,
} from '../../shared/db/schema';
import type { PackFailureEntry as PackFailureEntryPath } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { encodeCursor } from '../../shared/primitives/pagination';
import type { Page } from '../../shared/primitives/pagination';
import { fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import type { PicklistLineStatus } from './wave.command';

/**
 * Story 9-1 — the three outbound list reads the operational dashboard drills
 * into: failed pack verifications, channel orders refused under the reject
 * policy, and picklist lines by status over a window. Each is keyset-paged
 * newest first, its `from`/`to` window on the SAME column its keyset walks,
 * and its cursor carries the column's FULL-precision instant — rows written
 * in one transaction share one `now()` to the microsecond (a wave plans all
 * its lines at once), and a millisecond-truncated cursor would skip the tail
 * of that tie group. Paging a drill to exhaustion must yield exactly the
 * tile's count; a skipped row breaks that promise silently.
 *
 * Reads, never capability-gated; the caller asserts the warehouse first.
 */

export interface WindowFilter {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: { readonly createdAt: string; readonly id: string } | undefined;
  readonly limit: number;
}

/** One divergent SKU of a failed verification, in BASE units (the read model). */
export interface PackFailureMismatchEntry {
  readonly skuId: string;
  readonly skuCode: string;
  readonly pickedQty: number;
  readonly scannedQty: number;
}

export interface PackFailureEntry {
  readonly id: string;
  readonly warehouseId: string;
  readonly orderId: string;
  readonly entry: PackFailureEntryPath;
  readonly actorUserId: string;
  readonly mismatch: readonly PackFailureMismatchEntry[];
  readonly createdAt: string;
}

export interface BackorderRefusalLineEntry {
  readonly skuId: string;
  readonly requestedQty: number;
  readonly availableQty: number;
}

export interface BackorderRefusalEntry {
  readonly id: string;
  readonly warehouseId: string;
  readonly integrationId: string;
  readonly externalEventId: string;
  readonly lines: readonly BackorderRefusalLineEntry[];
  readonly createdAt: string;
}

export interface PicklistLineEntry {
  readonly id: string;
  readonly picklistId: string;
  readonly waveId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly skuId: string;
  readonly binId: string | null;
  readonly binCode: string | null;
  readonly qty: number;
  readonly shortfallQty: number;
  readonly reasonCode: string | null;
  readonly status: PicklistLineStatus;
  readonly createdAt: string;
  /** The last transition — for a terminal status (`picked`, `short`, `cancelled`) the flip time. */
  readonly updatedAt: string;
}

function pageFrom<T>(
  rows: readonly { readonly keyText: string; readonly id: string; readonly entry: T }[],
  limit: number,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map((row) => row.entry),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ createdAt: fullPrecisionInstant(last.keyText), id: last.id })
        : null,
  };
}

interface StoredMismatch {
  readonly skuId: string;
  readonly skuCode: string;
  readonly pickedMilli: number;
  readonly scannedMilli: number;
}

export async function listPackFailuresInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  filter: WindowFilter,
): Promise<Page<PackFailureEntry>> {
  const t = packVerificationFailures;
  const rows = await tx
    .select({ row: t, keyText: sql<string>`${t.createdAt}::text` })
    .from(t)
    .where(
      and(
        eq(t.tenantId, tenantId),
        eq(t.warehouseId, warehouseId),
        filter.from === undefined ? undefined : sql`${t.createdAt} >= ${filter.from}::timestamptz`,
        filter.to === undefined ? undefined : sql`${t.createdAt} < ${filter.to}::timestamptz`,
        filter.cursor === undefined
          ? undefined
          : sql`(${t.createdAt}, ${t.id}) < (${filter.cursor.createdAt}::timestamptz, ${filter.cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(filter.limit + 1);
  return pageFrom(
    rows.map(({ row, keyText }) => ({
      keyText,
      id: row.id,
      entry: {
        id: row.id,
        warehouseId: row.warehouseId,
        orderId: row.orderId,
        entry: row.entry as PackFailureEntryPath,
        actorUserId: row.actorUserId,
        // Stored in milli-units; the read model speaks base units (story 10.1).
        mismatch: (row.mismatch as readonly StoredMismatch[]).map((line) => ({
          skuId: line.skuId,
          skuCode: line.skuCode,
          pickedQty: fromMilli(line.pickedMilli),
          scannedQty: fromMilli(line.scannedMilli),
        })),
        createdAt: canonicalInstant(row.createdAt),
      },
    })),
    filter.limit,
  );
}

interface StoredRefusalLine {
  readonly skuId: string;
  readonly requestedMilli: number;
  readonly availableMilli: number;
}

export async function listBackorderRefusalsInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  filter: WindowFilter,
): Promise<Page<BackorderRefusalEntry>> {
  const t = ingestBackorderRefusals;
  const rows = await tx
    .select({ row: t, keyText: sql<string>`${t.createdAt}::text` })
    .from(t)
    .where(
      and(
        eq(t.tenantId, tenantId),
        eq(t.warehouseId, warehouseId),
        // A refused event later redelivered and ACCEPTED became an order —
        // it was not prevented (the oversell tile excludes it identically).
        sql`not exists (select 1 from orders o where o.tenant_id = ${t.tenantId} and o.integration_id = ${t.integrationId} and o.external_event_id = ${t.externalEventId})`,
        filter.from === undefined ? undefined : sql`${t.createdAt} >= ${filter.from}::timestamptz`,
        filter.to === undefined ? undefined : sql`${t.createdAt} < ${filter.to}::timestamptz`,
        filter.cursor === undefined
          ? undefined
          : sql`(${t.createdAt}, ${t.id}) < (${filter.cursor.createdAt}::timestamptz, ${filter.cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(filter.limit + 1);
  return pageFrom(
    rows.map(({ row, keyText }) => ({
      keyText,
      id: row.id,
      entry: {
        id: row.id,
        warehouseId: row.warehouseId,
        integrationId: row.integrationId,
        externalEventId: row.externalEventId,
        lines: (row.lines as readonly StoredRefusalLine[]).map((line) => ({
          skuId: line.skuId,
          requestedQty: fromMilli(line.requestedMilli),
          availableQty: fromMilli(line.availableMilli),
        })),
        createdAt: canonicalInstant(row.createdAt),
      },
    })),
    filter.limit,
  );
}

/**
 * Picklist lines of one warehouse (through `picklists` — the line carries no
 * warehouse of its own), optionally by status, windowed on `updated_at` (for
 * a terminal status the flip time — what "short-picked today" means) and
 * keyset-paged on the immutable `(created_at, id)`. A zero-unit short pick writes no `picks` row
 * and no ledger event — this table is the only place it exists.
 */
export async function listPicklistLinesInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  filter: WindowFilter & { readonly status?: PicklistLineStatus | undefined },
): Promise<Page<PicklistLineEntry>> {
  const l = picklistLines;
  const rows = await tx
    // Keyset on the IMMUTABLE `(created_at, id)`; the window stays on
    // `updated_at` (the flip time). Paging on a mutable column would skip or
    // repeat a row whose `updated_at` moved between pages.
    .select({ row: l, keyText: sql<string>`${l.createdAt}::text` })
    .from(l)
    .innerJoin(picklists, and(eq(picklists.id, l.picklistId), eq(picklists.tenantId, l.tenantId)))
    .where(
      and(
        eq(l.tenantId, tenantId),
        eq(picklists.warehouseId, warehouseId),
        filter.status === undefined ? undefined : eq(l.status, filter.status),
        filter.from === undefined ? undefined : sql`${l.updatedAt} >= ${filter.from}::timestamptz`,
        filter.to === undefined ? undefined : sql`${l.updatedAt} < ${filter.to}::timestamptz`,
        filter.cursor === undefined
          ? undefined
          : sql`(${l.createdAt}, ${l.id}) < (${filter.cursor.createdAt}::timestamptz, ${filter.cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(l.createdAt), desc(l.id))
    .limit(filter.limit + 1);
  return pageFrom(
    rows.map(({ row, keyText }) => ({
      keyText,
      id: row.id,
      entry: {
        id: row.id,
        picklistId: row.picklistId,
        waveId: row.waveId,
        orderId: row.orderId,
        orderLineId: row.orderLineId,
        skuId: row.skuId,
        binId: row.binId,
        binCode: row.binCode,
        qty: fromMilli(row.qty),
        shortfallQty: fromMilli(row.shortfallQty),
        reasonCode: row.reasonCode,
        status: row.status as PicklistLineStatus,
        createdAt: canonicalInstant(row.createdAt),
        updatedAt: canonicalInstant(row.updatedAt),
      },
    })),
    filter.limit,
  );
}
