import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { bins, clients, countTasks, countVariances, skus, stockTakes, zones, type StockTakeStatus } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { fromMilli } from '../../shared/primitives/quantity';
import { fullPrecisionInstant } from '../../shared/primitives/time';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import type { Page } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { ROLE_CAPABILITIES } from '../tenancy/permissions';
import type { InventoryFacade } from '../inventory/inventory.facade';
import { openVarianceDigestOf, stockTakeSummary, type StockTakeCommand, type StockTakeSummary } from './stock-take.command';

/**
 * Story 3-5b — the stock take's reads (the facade delegates here): the list,
 * the dashboard detail, the variance table (GATED — expected beside counted,
 * like the count-task detail) and the report rows. All on the caller's
 * transaction.
 */

export const DEFAULT_STOCK_TAKE_PAGE_SIZE = 50;
export const DEFAULT_STOCK_TAKE_VARIANCE_PAGE_SIZE = 100;

export interface ListStockTakesQuery {
  readonly warehouseId?: string | undefined;
  readonly status?: StockTakeStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface StockTakeProgress {
  readonly bins: number;
  /** Bins with a completed count and no pending task. */
  readonly counted: number;
  /** Pending tasks (recounts included). */
  readonly pending: number;
}

export interface StockTakeListEntry {
  readonly stockTake: StockTakeSummary;
  readonly progress: StockTakeProgress;
}

export interface StockTakeDetail {
  readonly stockTake: StockTakeSummary;
  readonly totals: StockTakeProgress & {
    /** Pending recount tasks (an auto-recount or a requested one). */
    readonly recountPending: number;
    /** Bins with at least one open variance. */
    readonly withVariance: number;
    readonly openVariances: number;
    /** Open variances over their frozen threshold stamp — the post needs the owner. */
    readonly overThreshold: number;
    /** Handheld writes admitted on the take's bins after the freeze (A1). */
    readonly deviceWrites: number;
  };
  readonly zones: readonly {
    readonly zoneId: string;
    readonly zoneCode: string;
    readonly bins: number;
    readonly counted: number;
    readonly pending: number;
    readonly withVariance: number;
  }[];
  /** Bins counted whose live epoch moved since (the close refuses until recounted); up to 50. */
  readonly recountRequiredBins: readonly { readonly binId: string; readonly binCode: string }[];
  readonly recountRequiredCount: number;
  /** The close's approval token (A2) over the open variances. */
  readonly openVarianceDigest: string;
}

export interface StockTakeVarianceEntry {
  readonly id: string;
  readonly taskId: string;
  readonly binId: string;
  readonly binCode: string;
  readonly zoneCode: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string | null;
  readonly clientId: string;
  /** Base units. */
  readonly expectedQuantity: number;
  readonly countedQuantity: number;
  readonly delta: number;
  readonly status: string;
  readonly thresholdQuantity: number | null;
  /** |delta| over the frozen stamp — owner-only (5-4 invariant 10). */
  readonly overThreshold: boolean;
  readonly epochConflict: boolean;
  /** The variance belongs to its bin's latest take task (false once superseded). */
  readonly latest: boolean;
  /** A batch-, serial- or catch-weight-tracked SKU (A7) — cannot be posted until 3-5d. */
  readonly needsLotCount: boolean;
  /** The close's refusal code, once closed and left unposted; null otherwise. */
  readonly unpostedCode: string | null;
}

export interface StockTakeVariancesQuery {
  readonly status?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface StockTakeReportRow {
  readonly binCode: string;
  readonly zoneCode: string;
  readonly skuCode: string;
  readonly skuName: string | null;
  readonly clientId: string;
  readonly expectedMilli: number;
  readonly countedMilli: number | null;
  readonly countedAt: string | null;
  readonly outcome: string;
}

function invalidCursor(): ProblemException {
  return new ProblemException('invalid-cursor', 400, 'Malformed pagination cursor', 'The cursor parameter is not a valid opaque page cursor.');
}

/** The gated reads' capability check (the count-task detail's rule). */
export async function assertCanReadCountDetailInTx(tx: TenantTx, tenantId: string, actorUserId: string): Promise<void> {
  const role = await getMemberRoleIn(tx, tenantId, actorUserId);
  if (!ROLE_CAPABILITIES[role].has('counts.manage') && !ROLE_CAPABILITIES[role].has('variances.resolve')) {
    throw new ProblemException(
      'role-denied',
      403,
      'Role lacks the required capability',
      `Role "${role}" includes neither "counts.manage" nor "variances.resolve" — the stock take's variances show expected quantities, which the counter does not see.`,
    );
  }
}

export async function loadStockTakeInTx(tx: TenantTx, tenantId: string, id: string): Promise<typeof stockTakes.$inferSelect> {
  const rows = await tx.select().from(stockTakes).where(and(eq(stockTakes.tenantId, tenantId), eq(stockTakes.id, id))).limit(1);
  if (rows[0] === undefined) {
    throw new ProblemException('not-found', 404, 'Stock take not found', 'No stock take with this id exists in this tenant.');
  }
  return rows[0];
}

/** Per-take progress, one grouped read for a page of takes. */
async function progressOf(tx: TenantTx, tenantId: string, takes: readonly { id: string; binCount: number }[]): Promise<Map<string, StockTakeProgress>> {
  const result = new Map<string, StockTakeProgress>();
  if (takes.length === 0) return result;
  const rows = (await tx.execute(sql`
    select t.stock_take_id as "takeId",
           count(*) filter (where t.status = 'pending')::int as "pending",
           count(distinct t.bin_id) filter (where t.status = 'completed'
             and not exists (select 1 from count_tasks p where p.tenant_id = t.tenant_id and p.stock_take_id = t.stock_take_id and p.bin_id = t.bin_id and p.status = 'pending'))::int as "counted"
      from count_tasks t
     where t.tenant_id = ${tenantId}::uuid
       and t.stock_take_id in (${sql.join(takes.map((take) => sql`${take.id}::uuid`), sql`, `)})
     group by t.stock_take_id
  `)) as unknown as { takeId: string; pending: number; counted: number }[];
  const byTake = new Map(rows.map((row) => [row.takeId, row]));
  for (const take of takes) {
    const row = byTake.get(take.id);
    result.set(take.id, { bins: take.binCount, counted: Number(row?.counted ?? 0), pending: Number(row?.pending ?? 0) });
  }
  return result;
}

export async function listStockTakesInTx(tx: TenantTx, tenantId: string, query: ListStockTakesQuery): Promise<Page<StockTakeListEntry>> {
  const pageSize = query.limit ?? DEFAULT_STOCK_TAKE_PAGE_SIZE;
  let before: { createdAt: string; id: string } | undefined;
  if (query.cursor !== undefined) {
    try {
      before = decodeCursor(query.cursor);
      if (!UUID_RE.test(before.id) || Number.isNaN(Date.parse(before.createdAt))) throw new Error('malformed');
    } catch {
      throw invalidCursor();
    }
  }
  if (query.warehouseId !== undefined) await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
  const rows = await tx
    .select({ row: stockTakes, startedAtText: sql<string>`${stockTakes.startedAt}::text` })
    .from(stockTakes)
    .where(
      and(
        eq(stockTakes.tenantId, tenantId),
        query.warehouseId === undefined ? undefined : eq(stockTakes.warehouseId, query.warehouseId),
        query.status === undefined ? undefined : eq(stockTakes.status, query.status),
        before === undefined
          ? undefined
          : sql`(${stockTakes.startedAt}, ${stockTakes.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
      ),
    )
    .orderBy(desc(stockTakes.startedAt), desc(stockTakes.id))
    .limit(pageSize + 1);
  const page = buildPage(
    rows.map((wrapped) => ({ createdAt: fullPrecisionInstant(wrapped.startedAtText), id: wrapped.row.id, row: wrapped.row })),
    pageSize,
  );
  const progress = await progressOf(tx, tenantId, page.items.map((item) => item.row));
  return {
    items: page.items.map((item) => ({ stockTake: stockTakeSummary(item.row), progress: progress.get(item.row.id)! })),
    nextCursor: page.nextCursor,
  };
}

export async function getStockTakeInTx(
  tx: TenantTx,
  tenantId: string,
  id: string,
  inventory: InventoryFacade,
  commands: StockTakeCommand,
): Promise<StockTakeDetail> {
  const take = await loadStockTakeInTx(tx, tenantId, id);
  const progress = (await progressOf(tx, tenantId, [take])).get(take.id)!;

  const zoneRows = (await tx.execute(sql`
    with take_bins as (
      select distinct t.bin_id from count_tasks t where t.tenant_id = ${tenantId}::uuid and t.stock_take_id = ${take.id}::uuid
    )
    select z.id as "zoneId", z.code as "zoneCode",
           count(*)::int as "bins",
           count(*) filter (where exists (select 1 from count_tasks c where c.tenant_id = ${tenantId}::uuid and c.stock_take_id = ${take.id}::uuid and c.bin_id = tb.bin_id and c.status = 'completed')
                            and not exists (select 1 from count_tasks p where p.tenant_id = ${tenantId}::uuid and p.stock_take_id = ${take.id}::uuid and p.bin_id = tb.bin_id and p.status = 'pending'))::int as "counted",
           count(*) filter (where exists (select 1 from count_tasks p where p.tenant_id = ${tenantId}::uuid and p.stock_take_id = ${take.id}::uuid and p.bin_id = tb.bin_id and p.status = 'pending'))::int as "pending",
           count(*) filter (where exists (select 1 from count_variances v join count_tasks vt on vt.tenant_id = v.tenant_id and vt.id = v.task_id
                                           where v.tenant_id = ${tenantId}::uuid and vt.stock_take_id = ${take.id}::uuid and v.bin_id = tb.bin_id and v.status = 'open'))::int as "withVariance"
      from take_bins tb
      join bins b on b.tenant_id = ${tenantId}::uuid and b.id = tb.bin_id
      join zones z on z.tenant_id = b.tenant_id and z.id = b.zone_id
     group by z.id, z.code
     order by z.code collate "C"
  `)) as unknown as { zoneId: string; zoneCode: string; bins: number; counted: number; pending: number; withVariance: number }[];

  const recountPendingRows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(countTasks)
    .where(and(eq(countTasks.tenantId, tenantId), eq(countTasks.stockTakeId, take.id), eq(countTasks.status, 'pending'), eq(countTasks.origin, 'recount')));
  const open = await commands.openVariancesInTx(tx, tenantId, take.id);
  const frozen = await inventory.frozenBinsInTx(tx, tenantId, take.warehouseId);
  // The released bins' writes live on the take; the still-frozen ones on their rows.
  let deviceWrites = Number(take.deviceWrites);
  for (const entry of frozen.values()) if (entry.stockTakeId === take.id) deviceWrites += entry.deviceWrites;
  const moved = take.status === 'counting' ? await commands.movedBinsInTx(tx, tenantId, take) : [];
  const movedBins = [...moved].sort((a, b) => (a.binCode < b.binCode ? -1 : a.binCode > b.binCode ? 1 : 0));
  return {
    stockTake: stockTakeSummary(take),
    totals: {
      ...progress,
      recountPending: Number(recountPendingRows[0]?.n ?? 0),
      withVariance: new Set(open.map((row) => row.binId)).size,
      openVariances: open.length,
      overThreshold: open.filter((row) => row.thresholdQuantityMilli !== null && Math.abs(row.deltaMilli) > row.thresholdQuantityMilli).length,
      deviceWrites,
    },
    zones: zoneRows.map((row) => ({
      zoneId: row.zoneId,
      zoneCode: row.zoneCode,
      bins: Number(row.bins),
      counted: Number(row.counted),
      pending: Number(row.pending),
      withVariance: Number(row.withVariance),
    })),
    recountRequiredBins: movedBins.slice(0, 50).map((state) => ({ binId: state.binId, binCode: state.binCode })),
    recountRequiredCount: movedBins.length,
    openVarianceDigest: openVarianceDigestOf(open),
  };
}

/** The variance table's cursor: (bin code, variance id). */
function encodeVarianceCursor(binCode: string, id: string): string {
  return Buffer.from(JSON.stringify({ b: binCode, id }), 'utf8').toString('base64url');
}

function decodeVarianceCursor(cursor: string): { binCode: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { b?: unknown; id?: unknown };
    if (typeof parsed.b !== 'string' || parsed.b.length === 0 || parsed.b.length > 200 || typeof parsed.id !== 'string' || !UUID_RE.test(parsed.id)) {
      throw new Error('malformed');
    }
    return { binCode: parsed.b, id: parsed.id };
  } catch {
    throw invalidCursor();
  }
}

export async function listStockTakeVariancesInTx(
  tx: TenantTx,
  tenantId: string,
  id: string,
  query: StockTakeVariancesQuery,
): Promise<Page<StockTakeVarianceEntry>> {
  const take = await loadStockTakeInTx(tx, tenantId, id);
  const pageSize = query.limit ?? DEFAULT_STOCK_TAKE_VARIANCE_PAGE_SIZE;
  const after = query.cursor === undefined ? undefined : decodeVarianceCursor(query.cursor);
  const rows = await tx
    .select({
      row: countVariances,
      binCode: bins.code,
      zoneCode: zones.code,
      skuCode: skus.code,
      skuName: skus.name,
      clientId: skus.clientId,
      tracked: sql<boolean>`(${skus.batchTracked} or ${skus.serialTracked} or ${skus.catchWeightTracked})`,
      latest: sql<boolean>`not exists (select 1 from count_tasks n where n.tenant_id = ${countTasks.tenantId} and n.stock_take_id = ${countTasks.stockTakeId} and n.bin_id = ${countTasks.binId} and n.id <> ${countTasks.id} and n.created_at > ${countTasks.createdAt} and n.status <> 'cancelled')`,
    })
    .from(countVariances)
    .innerJoin(countTasks, and(eq(countTasks.tenantId, countVariances.tenantId), eq(countTasks.id, countVariances.taskId)))
    .innerJoin(bins, and(eq(bins.tenantId, countVariances.tenantId), eq(bins.id, countVariances.binId)))
    .innerJoin(zones, and(eq(zones.tenantId, bins.tenantId), eq(zones.id, bins.zoneId)))
    .innerJoin(skus, and(eq(skus.tenantId, countVariances.tenantId), eq(skus.id, countVariances.skuId)))
    .where(
      and(
        eq(countVariances.tenantId, tenantId),
        eq(countTasks.stockTakeId, take.id),
        query.status === undefined ? undefined : eq(countVariances.status, query.status),
        after === undefined
          ? undefined
          : sql`(${bins.code} COLLATE "C", ${countVariances.id}) > (${after.binCode} COLLATE "C", ${after.id}::uuid)`,
      ),
    )
    .orderBy(sql`${bins.code} COLLATE "C"`, asc(countVariances.id))
    .limit(pageSize + 1);
  const unposted = new Map((take.unposted ?? []).map((entry) => [entry.varianceId, entry.code]));
  const items = rows.slice(0, pageSize).map((wrapped) => {
    const row = wrapped.row;
    return {
      id: row.id,
      taskId: row.taskId,
      binId: row.binId,
      binCode: wrapped.binCode,
      zoneCode: wrapped.zoneCode,
      skuId: row.skuId,
      skuCode: wrapped.skuCode,
      skuName: wrapped.skuName,
      clientId: wrapped.clientId,
      expectedQuantity: fromMilli(row.expectedQuantity),
      countedQuantity: fromMilli(row.countedQuantity),
      delta: fromMilli(row.deltaMilli),
      status: row.status,
      thresholdQuantity: row.thresholdQuantityMilli === null ? null : fromMilli(row.thresholdQuantityMilli),
      overThreshold: row.thresholdQuantityMilli !== null && Math.abs(row.deltaMilli) > row.thresholdQuantityMilli,
      epochConflict: row.epochConflict,
      latest: wrapped.latest === true,
      needsLotCount: wrapped.tracked === true,
      unpostedCode: unposted.get(row.id) ?? null,
    };
  });
  const last = rows.length > pageSize ? rows[pageSize - 1] : undefined;
  return { items, nextCursor: last === undefined ? null : encodeVarianceCursor(last.binCode, last.row.id) };
}

/**
 * The report rows (A10): every line of each bin's latest COMPLETED take task,
 * optionally one client's SKUs, with the outcome as of `closed_at` —
 * `matched | adjusted | recounted | unposted:<code> | open` (a variance resolved after the
 * close reads `unposted:<code> (resolved later)`). Counted bins only.
 */
export async function stockTakeReportRowsInTx(
  tx: TenantTx,
  tenantId: string,
  take: typeof stockTakes.$inferSelect,
  clientId: string | null,
): Promise<StockTakeReportRow[]> {
  if (clientId !== null) {
    const found = await tx.select({ id: clients.id }).from(clients).where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId))).limit(1);
    if (found[0] === undefined) {
      throw new ProblemException('not-found', 404, 'Client not found', `No client with id "${clientId}" exists in this tenant.`);
    }
  }
  const rows = (await tx.execute(sql`
    with latest as (
      select distinct on (t.bin_id) t.id, t.bin_id, t.completed_at
        from count_tasks t
       where t.tenant_id = ${tenantId}::uuid and t.stock_take_id = ${take.id}::uuid and t.status = 'completed'
       order by t.bin_id, t.completed_at desc, t.id desc
    )
    select b.code as "binCode", z.code as "zoneCode", s.code as "skuCode", s.name as "skuName", s.client_id as "clientId",
           l.expected_quantity_milli as "expected", l.counted_quantity_milli as "counted",
           lt.completed_at::text as "countedAt",
           v.id as "varianceId", v.status as "varianceStatus", v.resolved_at::text as "resolvedAt"
      from latest lt
      join count_task_lines l on l.tenant_id = ${tenantId}::uuid and l.task_id = lt.id
      join skus s on s.tenant_id = l.tenant_id and s.id = l.sku_id
      join bins b on b.tenant_id = l.tenant_id and b.id = lt.bin_id
      join zones z on z.tenant_id = b.tenant_id and z.id = b.zone_id
      left join count_variances v on v.tenant_id = l.tenant_id and v.task_id = lt.id and v.sku_id = l.sku_id
     where ${clientId === null ? sql`true` : sql`s.client_id = ${clientId}::uuid`}
     order by b.code collate "C", s.code collate "C", l.sku_id
  `)) as unknown as {
    binCode: string;
    zoneCode: string;
    skuCode: string;
    skuName: string | null;
    clientId: string;
    expected: string | number;
    counted: string | number | null;
    countedAt: string | null;
    varianceId: string | null;
    varianceStatus: string | null;
    resolvedAt: string | null;
  }[];
  const unposted = new Map((take.unposted ?? []).map((entry) => [entry.varianceId, entry.code]));
  const closedAt = take.closedAt === null ? null : Date.parse(take.closedAt);
  return rows.map((row) => {
    let outcome: string;
    if (row.varianceId === null) {
      outcome = 'matched';
    } else {
      const resolvedMs = row.resolvedAt === null ? null : Date.parse(row.resolvedAt);
      const resolvedByClose = resolvedMs !== null && (closedAt === null || resolvedMs <= closedAt);
      if (row.varianceStatus === 'adjusted' && resolvedByClose) {
        outcome = 'adjusted';
      } else if (row.varianceStatus === 'recounted') {
        // The bin's latest count was superseded by a recount still pending.
        outcome = 'recounted';
      } else if (unposted.has(row.varianceId)) {
        outcome = `unposted:${unposted.get(row.varianceId)!}${row.varianceStatus === 'open' ? '' : ' (resolved later)'}`;
      } else {
        outcome = 'open';
      }
    }
    return {
      binCode: row.binCode,
      zoneCode: row.zoneCode,
      skuCode: row.skuCode,
      skuName: row.skuName,
      clientId: row.clientId,
      expectedMilli: Number(row.expected),
      countedMilli: row.counted === null ? null : Number(row.counted),
      countedAt: row.countedAt === null ? null : fullPrecisionInstant(row.countedAt),
      outcome,
    };
  });
}
