import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { RECEIVING_BIN_CODE } from '../tenancy/receiving-bin';
import type { ReportingWindow } from './window';
import type { IntegrationCallStatus } from '../../shared/db/schema';
// The ONE connection-health rule, through the channels facade specifier.
import { connectionHealth } from '../channels/channels.facade';

/**
 * Story 9-1 — the dashboard tiles, one function per tile.
 *
 * ── Decision 6: the named read-only exception ──────────────────────────────
 * Everywhere else a module reads a sibling's state only through its facade
 * (AD-6). Reporting is the one exception, by human decision: each tile is
 * ONE read-only SQL statement (or two) over the owning modules' tables,
 * because routing ten aggregate counts through ten facades would mean ten
 * bespoke "count my rows in this window" methods whose only consumer is this
 * file — and a facade per count is a second definition of the KPI that can
 * drift from this one. The exception is bounded and GUARDED
 * (`test/architecture.spec.ts`):
 *   - nothing under `src/modules/reporting` writes any table (no
 *     insert/update/delete, Drizzle or raw);
 *   - nothing but the api shell imports the reporting module.
 * A tile reads; it never decides anything another module would.
 *
 * ── The definitions ─────────────────────────────────────────────────────────
 * Each figure names its SOURCE and carries a `drill`: the list route (and
 * exact query) that shows the rows behind it. `reconciles: true` is a
 * promise checked by `test/reporting.spec.ts`: paging that drill to
 * exhaustion yields exactly the figure. Rates, medians and ratios say
 * `reconciles: false` and still name their source list. Windows are
 * server-stamped columns only (see `window.ts`).
 *
 * ── The 21-8 hook ───────────────────────────────────────────────────────────
 * Every tile takes a `ReportingScope` whose `clientId` is `null` today
 * (the operator shape: the whole warehouse). Story 21-8 slices by client by
 * giving it a value; the tiles reading `orders` / `ledger_events` then add a
 * `client_id` predicate. No tile may assume it is always null.
 */

export interface ReportingScope {
  readonly tenantId: string;
  readonly warehouseId: string;
  /** Always null in 9-1 — the client slice is story 21-8's. */
  readonly clientId: null;
}

export interface Drill {
  /** The API route (under `/api/v1`) whose rows are behind the figure, ids filled in. */
  readonly apiPath: string;
  /** The exact query to send it. Every windowed drill carries `to = asOf`. */
  readonly query: Readonly<Record<string, string>>;
  /** True: paging `apiPath?query` to exhaustion yields exactly `value`. */
  readonly reconciles: boolean;
}

export interface Figure {
  /** The number; null when the tile is unavailable or the figure has no data (an empty median/ratio). */
  readonly value: number | null;
  readonly drill: Drill;
}

/** A figure over two windows: today (IST, so far) and the 7-day window it is part of. */
export interface WindowedFigure {
  readonly today: Figure;
  readonly d7: Figure;
}

export type TileState = 'ok' | 'unavailable';

export interface DockToStockTile {
  readonly state: TileState;
  /** Median minutes from the GRN's `created_at` to the placement's `created_at`, over placements in the window. */
  readonly medianMinutes: WindowedFigure;
  /** Live: GRN lines whose applied stock still sits in Receiving (the putaway task derivation). */
  readonly awaitingPutaway: Figure;
}

export interface PickRateTile {
  readonly state: TileState;
  /** `picks` rows (one per pick line — a serial draw is still one line). */
  readonly pickLines: WindowedFigure;
  /** `picks` rows in the last hour. */
  readonly lastHour: Figure;
}

export interface ShortPicksTile {
  readonly state: TileState;
  /** `picklist_lines` flipped to `short` in the window — zero-unit shorts included. */
  readonly shortLines: WindowedFigure;
}

export interface GrnVariancesTile {
  readonly state: TileState;
  /** Over-receipts requested in the window. */
  readonly overReceipts: WindowedFigure;
  /** Live: over-receipts still pending a decision. */
  readonly pendingOverReceipts: Figure;
  /** Blind GRNs (no purchase order) recorded in the window — flagged for PO matching. */
  readonly blindGrns: WindowedFigure;
}

export interface OrderAccuracyTile {
  readonly state: TileState;
  /** SM-3: (short lines + failed pack verifications) × 1000 ÷ dispatched lines; null with no dispatched line. */
  readonly defectsPer1000: WindowedFigure;
  readonly shortLines: WindowedFigure;
  readonly packFailures: WindowedFigure;
  /** Distinct order lines with a `dispatch.dispatched` event recorded in the window. */
  readonly dispatchedLines: WindowedFigure;
  /** When the failed-verification fact began to be recorded (0058) — null if the stamp is missing. */
  readonly countingSince: string | null;
}

export interface OversellTile {
  readonly state: TileState;
  /** SM-4: ingested orders accepted in the window with at least one backordered line (per order). */
  readonly backorderedOrders: WindowedFigure;
  /** Channel orders refused under the reject policy in the window — oversell prevented. */
  readonly prevented: WindowedFigure;
  readonly countingSince: string | null;
}

export interface ExpiryAlertsTile {
  readonly state: TileState;
  /** Live: open `expiry_upcoming` alerts. */
  readonly openExpiryUpcoming: Figure;
  /** Live: open `aged` alerts. */
  readonly openAged: Figure;
  /** Alerts of either kind raised in the window. */
  readonly raised: WindowedFigure;
}

export const SYNC_HEALTH_STATES = ['ok', 'degraded', 'error'] as const;
export type SyncHealthState = (typeof SYNC_HEALTH_STATES)[number];
/**
 * Why a connection is not `ok`, most severe first. The breaker / last-error /
 * lag arms are `/channels`' own rule (`connectionHealth`, reused — never
 * re-derived); the dashboard adds only the arms `/channels` cannot know:
 * a disconnected row, an unset ingest warehouse, and ingest failures.
 */
export const SYNC_HEALTH_REASONS = [
  'disconnected',
  'ingest-warehouse-unset',
  'breaker-open',
  'breaker-half-open',
  'last-delivery-failed',
  'never-synced',
  'sync-lag',
  'ingest-failures',
] as const;
export type SyncHealthReason = (typeof SYNC_HEALTH_REASONS)[number];

export interface SyncConnectionHealth {
  readonly integrationId: string;
  readonly provider: string;
  /** `connected` or `disconnected` (a disconnected row is always `error`). */
  readonly status: string;
  readonly health: SyncHealthState;
  readonly reason: SyncHealthReason | null;
  /** `now − last_synced_at` in seconds, as-is; null when it never synced. */
  readonly lagSeconds: number | null;
  /** Genuine `order-ingest` failures in the 24 h before `asOf` (see `INGEST_CALL_OUTCOMES`). */
  readonly ingestFailures24h: number;
}

export interface SyncHealthTile {
  readonly state: TileState;
  /** Channel connections (connected or disconnected) ingesting into this warehouse, or with no ingest warehouse set. */
  readonly connections: readonly SyncConnectionHealth[] | null;
  readonly drill: Drill;
}

export interface DispatchPipelineTile {
  readonly state: TileState;
  /** Live: orders `accepted` (waiting to be picked and packed). */
  readonly accepted: Figure;
  /** Live: orders `ready_to_dispatch` (packed). */
  readonly readyToDispatch: Figure;
  /** Live: shipments labelled but not yet on a manifest. */
  readonly labelledNotManifested: Figure;
  /** Distinct orders with a `dispatch.dispatched` event recorded in the window. */
  readonly ordersDispatched: WindowedFigure;
}

export interface Sm8Tile {
  readonly state: TileState;
  /** E-way bills queued in the window for this warehouse's invoices, excluding dismissed bills and voided invoices. */
  readonly eligible: WindowedFigure;
  /** Of those, generated through the gateway. */
  readonly gatewayGenerated: WindowedFigure;
  /** SM-8: gatewayGenerated ÷ eligible (0–1); null with none eligible. Reads 0 until a live gateway adapter exists. */
  readonly gatewayShare: WindowedFigure;
  /** Invoices of this warehouse issued in the window. */
  readonly invoicesIssued: WindowedFigure;
  /** Secondary: the share (0–1) of those with no `manual` rate-source line; null with none issued. */
  readonly noManualPricingShare: WindowedFigure;
}

export interface OverviewTiles {
  readonly dockToStock: DockToStockTile;
  readonly pickRate: PickRateTile;
  readonly shortPicks: ShortPicksTile;
  readonly grnVariances: GrnVariancesTile;
  readonly orderAccuracy: OrderAccuracyTile;
  readonly oversell: OversellTile;
  readonly expiryAlerts: ExpiryAlertsTile;
  readonly syncHealth: SyncHealthTile;
  readonly dispatchPipeline: DispatchPipelineTile;
  readonly sm8: Sm8Tile;
}

export type TileName = keyof OverviewTiles;

export interface TileContext {
  readonly scope: ReportingScope;
  readonly window: ReportingWindow;
}

/**
 * One tile: `run` reads (inside the runner's read transaction, under its
 * statement timeout); `unavailable` builds the same shape with every value
 * null and every drill still present — a tile is a number or `unavailable`,
 * and even an unavailable tile names where its rows live.
 */
export interface TileDefinition<K extends TileName = TileName> {
  readonly name: K;
  run(tx: TenantTx, ctx: TileContext): Promise<OverviewTiles[K]>;
  unavailable(ctx: TileContext): OverviewTiles[K];
}

// ── drills ────────────────────────────────────────────────────────────────────

function warehousePath(scope: ReportingScope, suffix: string): string {
  return `/tenants/${scope.tenantId}/warehouses/${scope.warehouseId}/${suffix}`;
}

function tenantPath(scope: ReportingScope, suffix: string): string {
  return `/tenants/${scope.tenantId}/${suffix}`;
}

const DRILL = {
  ledger: (s: ReportingScope) => warehousePath(s, 'inventory/events'),
  putawayTasks: (s: ReportingScope) => tenantPath(s, 'putaway/tasks'),
  picklistLines: (s: ReportingScope) => warehousePath(s, 'outbound/picklist-lines'),
  packFailures: (s: ReportingScope) => warehousePath(s, 'outbound/pack-failures'),
  refusals: (s: ReportingScope) => warehousePath(s, 'outbound/backorder-refusals'),
  orders: (s: ReportingScope) => warehousePath(s, 'outbound/orders'),
  overReceipts: (s: ReportingScope) => tenantPath(s, 'receiving/over-receipts'),
  goodsReceipts: (s: ReportingScope) => tenantPath(s, 'receiving/goods-receipts'),
  batchAlerts: (s: ReportingScope) => tenantPath(s, 'replenishment/batch-alerts'),
  channels: (s: ReportingScope) => tenantPath(s, 'channels/connections'),
  ewayBills: (s: ReportingScope) => tenantPath(s, 'eway/bills'),
  invoices: (s: ReportingScope) => tenantPath(s, 'invoices'),
};

function drill(apiPath: string, query: Record<string, string>, reconciles: boolean): Drill {
  return { apiPath, query, reconciles };
}

/** A windowed figure's two drills — the same list and filters, today's and the 7-day `from`. */
function windowed(
  ctx: TileContext,
  apiPath: string,
  query: Record<string, string>,
  reconciles: boolean,
  values: { readonly today: number | null; readonly d7: number | null } | null,
): WindowedFigure {
  return {
    today: {
      value: values?.today ?? null,
      drill: drill(apiPath, { ...query, from: ctx.window.todayFrom, to: ctx.window.asOf }, reconciles),
    },
    d7: {
      value: values?.d7 ?? null,
      drill: drill(apiPath, { ...query, from: ctx.window.d7From, to: ctx.window.asOf }, reconciles),
    },
  };
}

function live(apiPath: string, query: Record<string, string>, reconciles: boolean, value: number | null): Figure {
  return { value, drill: drill(apiPath, query, reconciles) };
}

// ── SQL helpers ───────────────────────────────────────────────────────────────

/** The per-statement ceiling: no tile statement runs longer than this. */
export const TILE_STATEMENT_TIMEOUT_MS = 1500;

/**
 * The runner's overall deadline (epoch ms) for each tile transaction it
 * opened. Every tile statement re-arms the transaction-local
 * `statement_timeout` to `min(1500 ms, time left)` first, so no tile outlives
 * the overview's deadline by more than a round trip.
 */
export const TILE_TX_DEADLINES = new WeakMap<object, number>();

async function rowsOf<T>(tx: TenantTx, query: SQL): Promise<T[]> {
  const deadlineAt = TILE_TX_DEADLINES.get(tx);
  if (deadlineAt !== undefined) {
    const timeoutMs = Math.max(1, Math.min(TILE_STATEMENT_TIMEOUT_MS, deadlineAt - Date.now()));
    await tx.execute(sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`);
  }
  return (await tx.execute(query)) as unknown as T[];
}

/** `count(*)::bigint` arrives as a STRING through postgres.js (the int8 boundary) — coerce here. */
function n(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/** A nullable float aggregate (a median) — null stays null ("no data"), never 0. */
function nf(value: string | number | null | undefined, decimals = 1): number | null {
  if (value === null || value === undefined) return null;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

/** A ratio, null when the denominator is zero ("no data", never a fake 0). */
function ratio(numerator: number, denominator: number, decimals = 4): number | null {
  if (denominator === 0) return null;
  const factor = 10 ** decimals;
  return Math.round((numerator / denominator) * factor) / factor;
}

function ts(value: string): SQL {
  return sql`${value}::timestamptz`;
}

interface WindowCounts {
  readonly today: string;
  readonly d7: string;
}

function counts(row: WindowCounts | undefined): { today: number; d7: number } {
  return { today: n(row?.today), d7: n(row?.d7) };
}

/**
 * When the 0058 facts began to be recorded. `app_metadata` is
 * infrastructure (no tenant, no RLS); the value is a JSON string holding a
 * timestamptz rendering, normalized to canonical ISO here.
 */
async function countingSinceInTx(tx: TenantTx): Promise<string | null> {
  const rows = await rowsOf<{ value: unknown }>(
    tx,
    sql`select value from app_metadata where key = 'reporting_facts_since' limit 1`,
  );
  const raw = rows[0]?.value;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ── the shared counts (two tiles read each) ───────────────────────────────────

async function shortLineCounts(tx: TenantTx, ctx: TileContext): Promise<{ today: number; d7: number }> {
  const { scope, window } = ctx;
  const rows = await rowsOf<WindowCounts>(
    tx,
    sql`select
          count(*) filter (where pl.updated_at >= ${ts(window.todayFrom)})::bigint as today,
          count(*)::bigint as d7
        from picklist_lines pl
        join picklists p on p.id = pl.picklist_id and p.tenant_id = pl.tenant_id
        where pl.tenant_id = ${scope.tenantId}::uuid
          and p.warehouse_id = ${scope.warehouseId}::uuid
          and pl.status = 'short'
          and pl.updated_at >= ${ts(window.d7From)}
          and pl.updated_at < ${ts(window.asOf)}`,
  );
  return counts(rows[0]);
}

function shortLinesFigure(ctx: TileContext, values: { today: number; d7: number } | null): WindowedFigure {
  return windowed(ctx, DRILL.picklistLines(ctx.scope), { status: 'short' }, true, values);
}

// ── 1. dock-to-stock ──────────────────────────────────────────────────────────

const dockToStock: TileDefinition<'dockToStock'> = {
  name: 'dockToStock',
  async run(tx, ctx) {
    const { scope, window } = ctx;
    // Server-stamped on both ends (GRN `created_at` → placement `created_at`);
    // a negative interval (clock skew between two writers) is excluded rather
    // than counted as instant putaway.
    const medians = await rowsOf<{ today: number | null; d7: number | null }>(
      tx,
      sql`select
            percentile_cont(0.5) within group (order by extract(epoch from (pp.created_at - g.created_at)) / 60.0)
              filter (where pp.created_at >= ${ts(window.todayFrom)}) as today,
            percentile_cont(0.5) within group (order by extract(epoch from (pp.created_at - g.created_at)) / 60.0) as d7
          from putaway_placements pp
          join goods_receipt_notes g on g.id = pp.grn_id and g.tenant_id = pp.tenant_id
          where pp.tenant_id = ${scope.tenantId}::uuid
            and pp.warehouse_id = ${scope.warehouseId}::uuid
            and pp.created_at >= ${ts(window.d7From)}
            and pp.created_at < ${ts(window.asOf)}
            and pp.created_at >= g.created_at`,
    );
    // The putaway task derivation (`PutawayFacade.getPutawayTasksInTx`) in
    // one statement: a GRN line with applied units whose (sku, batch) still
    // has stock in the warehouse's system Receiving bin — remaining =
    // min(applied, on-hand there) > 0.
    const awaiting = await rowsOf<{ n: string }>(
      tx,
      sql`select count(*)::bigint as n
          from goods_receipt_lines l
          join goods_receipt_notes g on g.id = l.grn_id and g.tenant_id = l.tenant_id
          join skus s on s.id = l.sku_id and s.tenant_id = l.tenant_id
          cross join lateral (
            select b.id from bins b
            where b.tenant_id = g.tenant_id and b.warehouse_id = g.warehouse_id
              and b.code = ${RECEIVING_BIN_CODE} and b.system_owned
            limit 1
          ) rb
          where g.tenant_id = ${scope.tenantId}::uuid
            and g.warehouse_id = ${scope.warehouseId}::uuid
            and l.applied_qty > 0
            and least(
              l.applied_qty,
              coalesce(
                case when l.batch_id is null
                  then (select sum(soh.quantity) from stock_on_hand soh
                        where soh.tenant_id = g.tenant_id and soh.warehouse_id = g.warehouse_id
                          and soh.bin_id = rb.id and soh.sku_id = l.sku_id)
                  else (select sum(boh.quantity) from batch_on_hand boh
                        where boh.tenant_id = g.tenant_id and boh.warehouse_id = g.warehouse_id
                          and boh.bin_id = rb.id and boh.sku_id = l.sku_id and boh.batch_id = l.batch_id)
                end,
                0)
            ) > 0`,
    );
    return dockShape(ctx, {
      today: nf(medians[0]?.today),
      d7: nf(medians[0]?.d7),
      awaiting: n(awaiting[0]?.n),
    });
  },
  unavailable: (ctx) => dockShape(ctx, null),
};

function dockShape(
  ctx: TileContext,
  values: { today: number | null; d7: number | null; awaiting: number } | null,
): DockToStockTile {
  return {
    state: values === null ? 'unavailable' : 'ok',
    medianMinutes: windowed(
      ctx,
      DRILL.ledger(ctx.scope),
      { type: 'putaway.placed' },
      false,
      values === null ? null : { today: values.today, d7: values.d7 },
    ),
    awaitingPutaway: live(
      DRILL.putawayTasks(ctx.scope),
      { warehouseId: ctx.scope.warehouseId },
      true,
      values?.awaiting ?? null,
    ),
  };
}

// ── 2. pick rate ──────────────────────────────────────────────────────────────

function pickRateShape(ctx: TileContext, values: { today: number; d7: number; lastHour: number } | null): PickRateTile {
  const ledger = DRILL.ledger(ctx.scope);
  return {
    state: values === null ? 'unavailable' : 'ok',
    // The ledger names the movements behind the lines, but it is NOT the same
    // count: `pick.picked` is one event per (sku, batch) arm and per serial
    // unit, a line is one `picks` row. Hence `reconciles: false`.
    pickLines: windowed(ctx, ledger, { type: 'pick.picked' }, false, values),
    lastHour: live(
      ledger,
      { type: 'pick.picked', from: ctx.window.lastHourFrom, to: ctx.window.asOf },
      false,
      values?.lastHour ?? null,
    ),
  };
}

const pickRate: TileDefinition<'pickRate'> = {
  name: 'pickRate',
  async run(tx, ctx) {
    const { scope, window } = ctx;
    const rows = await rowsOf<WindowCounts & { last_hour: string }>(
      tx,
      sql`select
            count(*) filter (where created_at >= ${ts(window.todayFrom)})::bigint as today,
            count(*)::bigint as d7,
            count(*) filter (where created_at >= ${ts(window.lastHourFrom)})::bigint as last_hour
          from picks
          where tenant_id = ${scope.tenantId}::uuid
            and warehouse_id = ${scope.warehouseId}::uuid
            and created_at >= ${ts(window.d7From)}
            and created_at < ${ts(window.asOf)}`,
    );
    return pickRateShape(ctx, { ...counts(rows[0]), lastHour: n(rows[0]?.last_hour) });
  },
  unavailable: (ctx) => pickRateShape(ctx, null),
};

// ── 3. short picks ────────────────────────────────────────────────────────────

const shortPicks: TileDefinition<'shortPicks'> = {
  name: 'shortPicks',
  async run(tx, ctx) {
    return { state: 'ok', shortLines: shortLinesFigure(ctx, await shortLineCounts(tx, ctx)) };
  },
  unavailable: (ctx) => ({ state: 'unavailable', shortLines: shortLinesFigure(ctx, null) }),
};

// ── 4. GRN variances ──────────────────────────────────────────────────────────

function grnShape(
  ctx: TileContext,
  values: { over: { today: number; d7: number }; pending: number; blind: { today: number; d7: number } } | null,
): GrnVariancesTile {
  const w = ctx.scope.warehouseId;
  return {
    state: values === null ? 'unavailable' : 'ok',
    overReceipts: windowed(ctx, DRILL.overReceipts(ctx.scope), { warehouseId: w }, true, values?.over ?? null),
    pendingOverReceipts: live(
      DRILL.overReceipts(ctx.scope),
      { warehouseId: w, status: 'pending', to: ctx.window.asOf },
      true,
      values?.pending ?? null,
    ),
    blindGrns: windowed(
      ctx,
      DRILL.goodsReceipts(ctx.scope),
      // Story 21-6: the drill pages the `blind` filter (blind = a reason,
      // not an absent PO — an ASN receipt has neither PO nor reason).
      { warehouseId: w, blind: 'true' },
      true,
      values?.blind ?? null,
    ),
  };
}

const grnVariances: TileDefinition<'grnVariances'> = {
  name: 'grnVariances',
  async run(tx, ctx) {
    const { scope, window } = ctx;
    // `requested_at` is server time (stamped at the GRN's own commit).
    const over = await rowsOf<WindowCounts & { pending: string }>(
      tx,
      sql`select
            count(*) filter (where requested_at >= ${ts(window.todayFrom)} and requested_at < ${ts(window.asOf)})::bigint as today,
            count(*) filter (where requested_at >= ${ts(window.d7From)} and requested_at < ${ts(window.asOf)})::bigint as d7,
            count(*) filter (where status = 'pending' and requested_at < ${ts(window.asOf)})::bigint as pending
          from over_receipts
          where tenant_id = ${scope.tenantId}::uuid
            and warehouse_id = ${scope.warehouseId}::uuid
            and (status = 'pending' or requested_at >= ${ts(window.d7From)})`,
    );
    const blind = await rowsOf<WindowCounts>(
      tx,
      sql`select
            count(*) filter (where created_at >= ${ts(window.todayFrom)})::bigint as today,
            count(*)::bigint as d7
          from goods_receipt_notes
          where tenant_id = ${scope.tenantId}::uuid
            and warehouse_id = ${scope.warehouseId}::uuid
            and blind_reason_code is not null
            and created_at >= ${ts(window.d7From)}
            and created_at < ${ts(window.asOf)}`,
    );
    return grnShape(ctx, { over: counts(over[0]), pending: n(over[0]?.pending), blind: counts(blind[0]) });
  },
  unavailable: (ctx) => grnShape(ctx, null),
};

// ── 5. order accuracy (SM-3) ──────────────────────────────────────────────────

interface AccuracyValues {
  readonly short: { today: number; d7: number };
  readonly failures: { today: number; d7: number };
  readonly dispatched: { today: number; d7: number };
  readonly countingSince: string | null;
}

function per1000(defects: number, dispatched: number): number | null {
  if (dispatched === 0) return null;
  return Math.round((defects * 1000 * 10) / dispatched) / 10;
}

function accuracyShape(ctx: TileContext, values: AccuracyValues | null): OrderAccuracyTile {
  const ledger = DRILL.ledger(ctx.scope);
  return {
    state: values === null ? 'unavailable' : 'ok',
    defectsPer1000: windowed(
      ctx,
      ledger,
      { type: 'dispatch.dispatched' },
      false,
      values === null
        ? null
        : {
            today: per1000(values.short.today + values.failures.today, values.dispatched.today),
            d7: per1000(values.short.d7 + values.failures.d7, values.dispatched.d7),
          },
    ),
    shortLines: shortLinesFigure(ctx, values?.short ?? null),
    packFailures: windowed(ctx, DRILL.packFailures(ctx.scope), {}, true, values?.failures ?? null),
    // One `dispatch.dispatched` event per order line, so the event count of
    // the drill IS the distinct line count.
    dispatchedLines: windowed(ctx, ledger, { type: 'dispatch.dispatched' }, true, values?.dispatched ?? null),
    countingSince: values?.countingSince ?? null,
  };
}

async function dispatchedCounts(
  tx: TenantTx,
  ctx: TileContext,
  key: 'orderLineId' | 'orderId',
): Promise<{ today: number; d7: number }> {
  const { scope, window } = ctx;
  // `recorded_at` — the server stamp (the 0058 index's last column).
  const rows = await rowsOf<WindowCounts>(
    tx,
    sql`select
          count(distinct reference_doc ->> ${key}) filter (where recorded_at >= ${ts(window.todayFrom)})::bigint as today,
          count(distinct reference_doc ->> ${key})::bigint as d7
        from ledger_events
        where tenant_id = ${scope.tenantId}::uuid
          and warehouse_id = ${scope.warehouseId}::uuid
          and type = 'dispatch.dispatched'
          and recorded_at >= ${ts(window.d7From)}
          and recorded_at < ${ts(window.asOf)}`,
  );
  return counts(rows[0]);
}

const orderAccuracy: TileDefinition<'orderAccuracy'> = {
  name: 'orderAccuracy',
  async run(tx, ctx) {
    const { scope, window } = ctx;
    const short = await shortLineCounts(tx, ctx);
    const failures = await rowsOf<WindowCounts>(
      tx,
      sql`select
            count(*) filter (where created_at >= ${ts(window.todayFrom)})::bigint as today,
            count(*)::bigint as d7
          from pack_verification_failures
          where tenant_id = ${scope.tenantId}::uuid
            and warehouse_id = ${scope.warehouseId}::uuid
            and created_at >= ${ts(window.d7From)}
            and created_at < ${ts(window.asOf)}`,
    );
    const dispatched = await dispatchedCounts(tx, ctx, 'orderLineId');
    return accuracyShape(ctx, {
      short,
      failures: counts(failures[0]),
      dispatched,
      countingSince: await countingSinceInTx(tx),
    });
  },
  unavailable: (ctx) => accuracyShape(ctx, null),
};

// ── 6. oversell (SM-4) ────────────────────────────────────────────────────────

function oversellShape(
  ctx: TileContext,
  values: { backordered: { today: number; d7: number }; prevented: { today: number; d7: number }; countingSince: string | null } | null,
): OversellTile {
  return {
    state: values === null ? 'unavailable' : 'ok',
    backorderedOrders: windowed(
      ctx,
      DRILL.orders(ctx.scope),
      { source: 'ingested', backordered: 'true' },
      true,
      values?.backordered ?? null,
    ),
    prevented: windowed(ctx, DRILL.refusals(ctx.scope), {}, true, values?.prevented ?? null),
    countingSince: values?.countingSince ?? null,
  };
}

const oversell: TileDefinition<'oversell'> = {
  name: 'oversell',
  async run(tx, ctx) {
    const { scope, window } = ctx;
    // Per ORDER (`exists`), so a kit whose parent and children all
    // backordered counts once. `order_lines.status = 'backordered'` is set
    // only at acceptance, so the window is the order's `created_at`.
    const backordered = await rowsOf<WindowCounts>(
      tx,
      sql`select
            count(*) filter (where o.created_at >= ${ts(window.todayFrom)})::bigint as today,
            count(*)::bigint as d7
          from orders o
          where o.tenant_id = ${scope.tenantId}::uuid
            and o.warehouse_id = ${scope.warehouseId}::uuid
            and o.source = 'ingested'
            and o.created_at >= ${ts(window.d7From)}
            and o.created_at < ${ts(window.asOf)}
            and exists (
              select 1 from order_lines ol
              where ol.tenant_id = o.tenant_id and ol.order_id = o.id and ol.status = 'backordered'
            )`,
    );
    const prevented = await rowsOf<WindowCounts>(
      tx,
      sql`select
            count(*) filter (where r.created_at >= ${ts(window.todayFrom)})::bigint as today,
            count(*)::bigint as d7
          from ingest_backorder_refusals r
          where r.tenant_id = ${scope.tenantId}::uuid
            and r.warehouse_id = ${scope.warehouseId}::uuid
            and r.created_at >= ${ts(window.d7From)}
            and r.created_at < ${ts(window.asOf)}
            -- A refused event the channel later redelivered and we ACCEPTED
            -- (stock arrived) was not prevented — it became an order. The
            -- drill list applies the same exclusion.
            and not exists (
              select 1 from orders o
              where o.tenant_id = r.tenant_id and o.integration_id = r.integration_id
                and o.external_event_id = r.external_event_id
            )`,
    );
    return oversellShape(ctx, {
      backordered: counts(backordered[0]),
      prevented: counts(prevented[0]),
      countingSince: await countingSinceInTx(tx),
    });
  },
  unavailable: (ctx) => oversellShape(ctx, null),
};

// ── 7. expiry alerts ──────────────────────────────────────────────────────────

function expiryShape(
  ctx: TileContext,
  values: { upcoming: number; aged: number; raised: { today: number; d7: number } } | null,
): ExpiryAlertsTile {
  const path = DRILL.batchAlerts(ctx.scope);
  const w = ctx.scope.warehouseId;
  return {
    state: values === null ? 'unavailable' : 'ok',
    openExpiryUpcoming: live(
      path,
      { warehouseId: w, kind: 'expiry_upcoming', status: 'open', to: ctx.window.asOf },
      true,
      values?.upcoming ?? null,
    ),
    openAged: live(path, { warehouseId: w, kind: 'aged', status: 'open', to: ctx.window.asOf }, true, values?.aged ?? null),
    raised: windowed(ctx, path, { warehouseId: w }, true, values?.raised ?? null),
  };
}

const expiryAlerts: TileDefinition<'expiryAlerts'> = {
  name: 'expiryAlerts',
  async run(tx, ctx) {
    const { scope, window } = ctx;
    const rows = await rowsOf<WindowCounts & { upcoming: string; aged: string }>(
      tx,
      sql`select
            count(*) filter (where status = 'open' and kind = 'expiry_upcoming')::bigint as upcoming,
            count(*) filter (where status = 'open' and kind = 'aged')::bigint as aged,
            count(*) filter (where created_at >= ${ts(window.todayFrom)})::bigint as today,
            count(*) filter (where created_at >= ${ts(window.d7From)})::bigint as d7
          from batch_alerts
          where tenant_id = ${scope.tenantId}::uuid
            and warehouse_id = ${scope.warehouseId}::uuid
            and created_at < ${ts(window.asOf)}
            and (status = 'open' or created_at >= ${ts(window.d7From)})`,
    );
    return expiryShape(ctx, { upcoming: n(rows[0]?.upcoming), aged: n(rows[0]?.aged), raised: counts(rows[0]) });
  },
  unavailable: (ctx) => expiryShape(ctx, null),
};

// ── 8. sync health ────────────────────────────────────────────────────────────

/**
 * Every metered call status, classified for the sync tile: is it a GENUINE
 * ingest failure? A `Record` over the whole union, so a status added to
 * `INTEGRATION_CALL_STATUSES` fails the BUILD until someone classifies it.
 * Not failures: successes (`ok`, `accepted`, `backordered`, `replayed`), a
 * policy refusal (`rejected` — an oversell PREVENTED, counted by the oversell
 * tile), and cancellation outcomes that settled (`released`, `ignored`).
 */
export const INGEST_CALL_OUTCOMES: Readonly<Record<IntegrationCallStatus, 'failure' | 'not-failure'>> = {
  ok: 'not-failure',
  failed: 'failure',
  accepted: 'not-failure',
  backordered: 'not-failure',
  replayed: 'not-failure',
  rejected: 'not-failure',
  conflict: 'failure',
  unmapped: 'failure',
  'validation-failed': 'failure',
  'warehouse-unset': 'failure',
  'config-invalid': 'failure',
  'verification-failed': 'failure',
  'actor-unprivileged': 'failure',
  'item-unresolved': 'failure',
  released: 'not-failure',
  ignored: 'not-failure',
  'cancellation-unresolved': 'failure',
};

const INGEST_FAILURE_STATUSES = (Object.keys(INGEST_CALL_OUTCOMES) as IntegrationCallStatus[]).filter(
  (status) => INGEST_CALL_OUTCOMES[status] === 'failure',
);

/** One connection's health: the dashboard-only arms first, then `/channels`' own rule. */
export function syncConnectionHealth(row: {
  readonly status: string;
  readonly ingestWarehouseId: string | null;
  readonly breakerState: string;
  readonly lastError: string | null;
  readonly lastSyncedAt: string | null;
  readonly ingestFailures24h: number;
}): { health: SyncHealthState; reason: SyncHealthReason | null; lagSeconds: number | null } {
  const shared = connectionHealth(row);
  const lagSeconds = shared.syncLagMs === null ? null : Math.floor(shared.syncLagMs / 1000);
  if (row.status !== 'connected') return { health: 'error', reason: 'disconnected', lagSeconds };
  if (row.ingestWarehouseId === null) return { health: 'error', reason: 'ingest-warehouse-unset', lagSeconds };
  if (shared.health !== 'ok') {
    // The arm `connectionHealth` took, named in its own order.
    const reason: SyncHealthReason =
      row.breakerState === 'open'
        ? 'breaker-open'
        : row.breakerState === 'half-open'
          ? 'breaker-half-open'
          : row.lastError !== null
            ? 'last-delivery-failed'
            : shared.syncLagMs === null
              ? 'never-synced'
              : 'sync-lag';
    return { health: shared.health, reason, lagSeconds };
  }
  if (row.ingestFailures24h > 0) return { health: 'degraded', reason: 'ingest-failures', lagSeconds };
  return { health: 'ok', reason: null, lagSeconds };
}

function syncShape(ctx: TileContext, connections: readonly SyncConnectionHealth[] | null): SyncHealthTile {
  return {
    state: connections === null ? 'unavailable' : 'ok',
    connections,
    drill: drill(DRILL.channels(ctx.scope), {}, false),
  };
}

const syncHealth: TileDefinition<'syncHealth'> = {
  name: 'syncHealth',
  async run(tx, ctx) {
    const { scope, window } = ctx;
    const rows = await rowsOf<{
      id: string;
      provider: string;
      status: string;
      ingest_warehouse_id: string | null;
      breaker_state: string;
      last_error: string | null;
      last_synced_at: string | null;
      failures: string;
    }>(
      tx,
      sql`select
            i.id, i.provider, i.status, i.ingest_warehouse_id, i.breaker_state, i.last_error,
            i.last_synced_at::text as last_synced_at,
            (select count(*) from integration_calls c
              where c.tenant_id = i.tenant_id and c.integration_id = i.id
                and c.kind = 'order-ingest'
                and c.status in (${sql.join(INGEST_FAILURE_STATUSES.map((s) => sql`${s}`), sql`, `)})
                and c.at >= ${ts(window.last24hFrom)}
                and c.at < ${ts(window.asOf)})::bigint as failures
          from integrations i
          where i.tenant_id = ${scope.tenantId}::uuid
            and (i.ingest_warehouse_id = ${scope.warehouseId}::uuid or i.ingest_warehouse_id is null)
          order by i.provider, i.id`,
    );
    return syncShape(
      ctx,
      rows.map((row) => {
        const failures = n(row.failures);
        const verdict = syncConnectionHealth({
          status: row.status,
          ingestWarehouseId: row.ingest_warehouse_id,
          breakerState: row.breaker_state,
          lastError: row.last_error,
          lastSyncedAt: row.last_synced_at === null ? null : new Date(row.last_synced_at).toISOString(),
          ingestFailures24h: failures,
        });
        return {
          integrationId: row.id,
          provider: row.provider,
          status: row.status,
          ...verdict,
          ingestFailures24h: failures,
        };
      }),
    );
  },
  unavailable: (ctx) => syncShape(ctx, null),
};

// ── 9. dispatch pipeline ──────────────────────────────────────────────────────

function pipelineShape(
  ctx: TileContext,
  values: { accepted: number; ready: number; labelled: number; dispatched: { today: number; d7: number } } | null,
): DispatchPipelineTile {
  const orders = DRILL.orders(ctx.scope);
  return {
    state: values === null ? 'unavailable' : 'ok',
    accepted: live(orders, { status: 'accepted', to: ctx.window.asOf }, true, values?.accepted ?? null),
    readyToDispatch: live(orders, { status: 'ready_to_dispatch', to: ctx.window.asOf }, true, values?.ready ?? null),
    // No list of labelled-but-unmanifested shipments exists; the packed
    // orders are the closest list (a labelled order is a packed one).
    labelledNotManifested: live(orders, { status: 'ready_to_dispatch', to: ctx.window.asOf }, false, values?.labelled ?? null),
    ordersDispatched: windowed(ctx, DRILL.ledger(ctx.scope), { type: 'dispatch.dispatched' }, false, values?.dispatched ?? null),
  };
}

const dispatchPipeline: TileDefinition<'dispatchPipeline'> = {
  name: 'dispatchPipeline',
  async run(tx, ctx) {
    const { scope, window } = ctx;
    const statuses = await rowsOf<{ accepted: string; ready: string }>(
      tx,
      sql`select
            count(*) filter (where status = 'accepted')::bigint as accepted,
            count(*) filter (where status = 'ready_to_dispatch')::bigint as ready
          from orders
          where tenant_id = ${scope.tenantId}::uuid
            and warehouse_id = ${scope.warehouseId}::uuid
            and status in ('accepted', 'ready_to_dispatch')
            and created_at < ${ts(window.asOf)}`,
    );
    const labelled = await rowsOf<{ n: string }>(
      tx,
      sql`select count(*)::bigint as n
          from shipments
          where tenant_id = ${scope.tenantId}::uuid
            and warehouse_id = ${scope.warehouseId}::uuid
            and status = 'labelled'`,
    );
    return pipelineShape(ctx, {
      accepted: n(statuses[0]?.accepted),
      ready: n(statuses[0]?.ready),
      labelled: n(labelled[0]?.n),
      dispatched: await dispatchedCounts(tx, ctx, 'orderId'),
    });
  },
  unavailable: (ctx) => pipelineShape(ctx, null),
};

// ── 10. SM-8 ──────────────────────────────────────────────────────────────────

interface Sm8Values {
  readonly eligible: { today: number; d7: number };
  readonly gateway: { today: number; d7: number };
  readonly issued: { today: number; d7: number };
  readonly noManual: { today: number; d7: number };
}

function sm8Shape(ctx: TileContext, values: Sm8Values | null): Sm8Tile {
  const w = ctx.scope.warehouseId;
  const bills = DRILL.ewayBills(ctx.scope);
  const invoices = DRILL.invoices(ctx.scope);
  return {
    state: values === null ? 'unavailable' : 'ok',
    // The bill list cannot exclude dismissed bills (no "not dismissed"
    // filter), so the eligible count names its list without reconciling.
    eligible: windowed(ctx, bills, { warehouseId: w }, false, values?.eligible ?? null),
    // A `gateway` source exists only on a generated bill (the 0056 CHECK),
    // and no code path writes a `voided` invoice today, so the gateway drill
    // reconciles exactly.
    gatewayGenerated: windowed(ctx, bills, { warehouseId: w, source: 'gateway' }, true, values?.gateway ?? null),
    gatewayShare: windowed(
      ctx,
      bills,
      { warehouseId: w, source: 'gateway' },
      false,
      values === null
        ? null
        : {
            today: ratio(values.gateway.today, values.eligible.today),
            d7: ratio(values.gateway.d7, values.eligible.d7),
          },
    ),
    invoicesIssued: windowed(ctx, invoices, { warehouseId: w }, true, values?.issued ?? null),
    noManualPricingShare: windowed(
      ctx,
      invoices,
      { warehouseId: w },
      false,
      values === null
        ? null
        : {
            today: ratio(values.noManual.today, values.issued.today),
            d7: ratio(values.noManual.d7, values.issued.d7),
          },
    ),
  };
}

const sm8: TileDefinition<'sm8'> = {
  name: 'sm8',
  async run(tx, ctx) {
    const { scope, window } = ctx;
    // A bill carries no warehouse — it is this warehouse's through its invoice.
    const bills = await rowsOf<WindowCounts & { gw_today: string; gw_d7: string }>(
      tx,
      sql`select
            count(*) filter (where e.created_at >= ${ts(window.todayFrom)})::bigint as today,
            count(*)::bigint as d7,
            count(*) filter (where e.created_at >= ${ts(window.todayFrom)} and e.status = 'generated' and e.source = 'gateway')::bigint as gw_today,
            count(*) filter (where e.status = 'generated' and e.source = 'gateway')::bigint as gw_d7
          from eway_bills e
          join invoices i on i.id = e.invoice_id and i.tenant_id = e.tenant_id
          where e.tenant_id = ${scope.tenantId}::uuid
            and i.warehouse_id = ${scope.warehouseId}::uuid
            and e.status <> 'dismissed'
            and i.status <> 'voided'
            and e.created_at >= ${ts(window.d7From)}
            and e.created_at < ${ts(window.asOf)}`,
    );
    const invoiceRows = await rowsOf<WindowCounts & { nm_today: string; nm_d7: string }>(
      tx,
      sql`select
            count(*) filter (where i.issued_at >= ${ts(window.todayFrom)})::bigint as today,
            count(*)::bigint as d7,
            count(*) filter (where i.issued_at >= ${ts(window.todayFrom)} and not exists (
              select 1 from invoice_lines il
              where il.tenant_id = i.tenant_id and il.invoice_id = i.id and il.rate_source = 'manual'
            ))::bigint as nm_today,
            count(*) filter (where not exists (
              select 1 from invoice_lines il
              where il.tenant_id = i.tenant_id and il.invoice_id = i.id and il.rate_source = 'manual'
            ))::bigint as nm_d7
          from invoices i
          where i.tenant_id = ${scope.tenantId}::uuid
            and i.warehouse_id = ${scope.warehouseId}::uuid
            and i.issued_at >= ${ts(window.d7From)}
            and i.issued_at < ${ts(window.asOf)}`,
    );
    return sm8Shape(ctx, {
      eligible: counts(bills[0]),
      gateway: { today: n(bills[0]?.gw_today), d7: n(bills[0]?.gw_d7) },
      issued: counts(invoiceRows[0]),
      noManual: { today: n(invoiceRows[0]?.nm_today), d7: n(invoiceRows[0]?.nm_d7) },
    });
  },
  unavailable: (ctx) => sm8Shape(ctx, null),
};

/** The ten tiles, in the order the runner starts them (and the Overview shows them). */
export const TILES: readonly TileDefinition[] = [
  dockToStock,
  pickRate,
  shortPicks,
  grnVariances,
  orderAccuracy,
  oversell,
  expiryAlerts,
  syncHealth,
  dispatchPipeline,
  sm8,
] as readonly TileDefinition[];
