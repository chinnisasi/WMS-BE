import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { addIsoDays, isIsoDate, istMidnightOf } from '../../shared/primitives/time';
// The ONE dispatched-order predicate — billing's invoiced count reads it too,
// so `ordersDispatched` here equals what the client is invoiced for.
import { dispatchedOrderEventsPredicate } from '../inventory/inventory.facade';
import { countingSinceInTx, n, nf, ratio, rowsOf, ts } from './sql';

/**
 * Story 21-8 — per-client service reporting (CAP-10): dock-to-stock, pick
 * accuracy and dispatch timeliness for ONE client over an inclusive IST date
 * period. One read (`ReportingFacade.serviceReport` / `portalServiceReport`)
 * behind two routes, so the operator and the client see the same figures.
 *
 * Decision 6 (`kpis.ts`) covers these reads: read-only SQL over the owning
 * modules' tables. Every query inner-joins a CLIENT-POLICIED table (`skus`,
 * `orders` or `ledger_events`) AND carries `client_id = $client` — the two
 * layers a portal read needs (RLS under the portal stamp, plus the explicit
 * predicate; `test/client-isolation.spec.ts` proves the first alone).
 *
 * Every window is `[IST midnight of from, min(IST midnight after to, asOf))`
 * on server-stamped columns only.
 */

/** The fixed timeliness target (human decision 1) — a per-client target is PENDING. */
export const SERVICE_TARGET_HOURS = 24;
/** The longest period one report covers, inclusive (the metering read's bound). */
export const MAX_SERVICE_REPORT_DAYS = 366;
/** The WHOLE read's budget, in ONE transaction: each statement runs under the time left of it; a 57014 is a 503. */
export const SERVICE_STATEMENT_TIMEOUT_MS = 5000;

export interface ServiceReportScope {
  readonly tenantId: string;
  readonly clientId: string;
  /** Null: every warehouse of the tenant. */
  readonly warehouseId: string | null;
}

export interface ServiceWindow {
  /** `istMidnightOf(from)`. */
  readonly from: string;
  /** `max(from, min(istMidnightOf(to + 1), asOf))` — an empty window when `from` is in the future. */
  readonly to: string;
  readonly asOf: string;
  /**
   * Epoch ms the WHOLE read must finish by (start + `SERVICE_STATEMENT_TIMEOUT_MS`).
   * Every figure statement re-arms the transaction-local `statement_timeout`
   * to the time left (`armServiceDeadline`), so the budget bounds the read,
   * not each statement.
   */
  readonly deadlineAt: number;
}

export interface ServiceDockToStock {
  /** Median minutes, GRN recorded → placement recorded, over placements in the window; null with none. */
  readonly medianMinutes: number | null;
  readonly placements: number;
}

export interface ServicePickAccuracy {
  /** (linesDispatched − linesShortPicked) ÷ linesDispatched, 0–1 to 4 dp; null with no line dispatched. */
  readonly accuracy: number | null;
  readonly linesDispatched: number;
  readonly linesShortPicked: number;
  readonly packFailures: number;
  readonly packFailuresCountingSince: string | null;
}

export interface ServiceDispatchTimeliness {
  readonly ordersDispatched: number;
  readonly onTime: number;
  readonly onTimeRate: number | null;
  readonly medianMinutes: number | null;
  readonly lateNotDispatched: number;
}

export interface ServiceFigures {
  readonly dockToStock: ServiceDockToStock;
  readonly pickAccuracy: ServicePickAccuracy;
  readonly dispatchTimeliness: ServiceDispatchTimeliness;
}

export interface ServiceReport extends ServiceFigures {
  readonly from: string;
  readonly to: string;
  readonly warehouseId: string | null;
  readonly asOf: string;
  readonly targetHours: number;
}

function invalidPeriod(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid report period', detail);
}

/**
 * The period rules — `assertMeteringPeriod`'s detail strings (billing),
 * with the report's own title. Checked in the facade, before anything reads,
 * so both routes refuse identically.
 */
export function assertServicePeriod(fromDate: string, toDate: string): void {
  if (!isIsoDate(fromDate)) throw invalidPeriod(`from must be a real calendar date YYYY-MM-DD (got "${fromDate}").`);
  if (!isIsoDate(toDate)) throw invalidPeriod(`to must be a real calendar date YYYY-MM-DD (got "${toDate}").`);
  if (fromDate > toDate) throw invalidPeriod(`from (${fromDate}) is after to (${toDate}).`);
  const days = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_SERVICE_REPORT_DAYS) {
    throw invalidPeriod(`A period covers at most ${MAX_SERVICE_REPORT_DAYS} days (got ${days}, ${fromDate} → ${toDate}).`);
  }
}

/** The read's window. The caller has already run `assertServicePeriod`. */
export function serviceWindow(fromDate: string, toDate: string, now: Date, deadlineAt: number): ServiceWindow {
  const asOf = now.toISOString();
  const from = istMidnightOf(fromDate);
  const periodEnd = istMidnightOf(addIsoDays(toDate, 1));
  const capped = periodEnd < asOf ? periodEnd : asOf;
  // A `from` after today: an empty window, never an inverted one.
  return { from, to: capped < from ? from : capped, asOf, deadlineAt };
}

/**
 * Re-arms the transaction-local `statement_timeout` to the read's time left
 * (at least 1 ms), so the next statement cannot outlive the whole-read budget.
 */
export async function armServiceDeadline(tx: TenantTx, deadlineAt: number): Promise<void> {
  const timeoutMs = Math.max(1, deadlineAt - Date.now());
  await tx.execute(sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`);
}

function warehouseFilter(column: SQL, warehouseId: string | null): SQL {
  return warehouseId === null ? sql`` : sql` and ${column} = ${warehouseId}::uuid`;
}

/**
 * Dock-to-stock — the 9-1 tile's SQL, sliced by client through the SKU:
 * placements recorded in the window, negative intervals excluded.
 */
async function dockToStockInTx(tx: TenantTx, scope: ServiceReportScope, window: ServiceWindow): Promise<ServiceDockToStock> {
  const rows = await rowsOf<{ median: number | string | null; placements: string }>(
    tx,
    sql`select
          percentile_cont(0.5) within group (order by extract(epoch from (pp.created_at - g.created_at)) / 60.0) as median,
          count(*)::bigint as placements
        from putaway_placements pp
        join goods_receipt_notes g on g.id = pp.grn_id and g.tenant_id = pp.tenant_id
        join skus s on s.id = pp.sku_id and s.tenant_id = pp.tenant_id and s.client_id = ${scope.clientId}::uuid
        where pp.tenant_id = ${scope.tenantId}::uuid${warehouseFilter(sql`pp.warehouse_id`, scope.warehouseId)}
          and pp.created_at >= ${ts(window.from)}
          and pp.created_at < ${ts(window.to)}
          and pp.created_at >= g.created_at`,
  );
  return { medianMinutes: nf(rows[0]?.median), placements: n(rows[0]?.placements) };
}

/**
 * The dispatched orders — billing's predicate (an order counts in the window
 * of its FIRST dispatch), one row per order with `min(recorded_at)` as its
 * dispatch instant, inner-joined to the client's `orders` row — and from the
 * same CTE, the pick-accuracy lines (one `dispatch.dispatched` event per
 * order line) and the timeliness figures.
 */
async function dispatchedInTx(
  tx: TenantTx,
  scope: ServiceReportScope,
  window: ServiceWindow,
): Promise<{ ordersDispatched: number; onTime: number; medianMinutes: number | null; linesDispatched: number; linesShortPicked: number }> {
  const predicate = dispatchedOrderEventsPredicate(
    {
      tenantId: scope.tenantId,
      clientId: scope.clientId,
      warehouseIds: scope.warehouseId === null ? undefined : [scope.warehouseId],
    },
    window.from,
    window.to,
  );
  const target = sql`make_interval(hours => ${SERVICE_TARGET_HOURS}::int)`;
  const rows = await rowsOf<{
    orders_dispatched: string;
    on_time: string;
    median_minutes: number | string | null;
    lines_dispatched: string;
    lines_short: string;
  }>(
    tx,
    sql`with ev as (
          select le.reference_doc ->> 'orderId' as order_id,
                 le.reference_doc ->> 'orderLineId' as order_line_id,
                 le.recorded_at
          from ledger_events le
          where ${predicate}
        ),
        dispatched as (
          select ev.order_id, min(ev.recorded_at) as dispatched_at, o.created_at as received_at
          from ev
          join orders o on o.tenant_id = ${scope.tenantId}::uuid and o.id = ev.order_id::uuid
            and o.client_id = ${scope.clientId}::uuid
          group by ev.order_id, o.created_at
        ),
        lines as (
          -- DISTINCT order lines: one event per line is the dispatch command's
          -- shape, not a constraint, so the count never relies on it.
          select distinct ev.order_line_id from ev join dispatched d on d.order_id = ev.order_id
        )
        select
          (select count(*) from dispatched)::bigint as orders_dispatched,
          (select count(*) from dispatched where dispatched_at - received_at <= ${target})::bigint as on_time,
          (select percentile_cont(0.5) within group (
             order by greatest(extract(epoch from (dispatched_at - received_at)), 0) / 60.0)
           from dispatched) as median_minutes,
          (select count(*) from lines)::bigint as lines_dispatched,
          (select count(*) from lines l
            where exists (
              select 1 from picklist_lines pl
              where pl.tenant_id = ${scope.tenantId}::uuid
                and pl.order_line_id = l.order_line_id::uuid
                and pl.reason_code is not null
            ))::bigint as lines_short`,
  );
  const row = rows[0];
  return {
    ordersDispatched: n(row?.orders_dispatched),
    onTime: n(row?.on_time),
    medianMinutes: nf(row?.median_minutes),
    linesDispatched: n(row?.lines_dispatched),
    linesShortPicked: n(row?.lines_short),
  };
}

/** Failed pack verifications recorded in the window for the client's orders. */
async function packFailuresInTx(tx: TenantTx, scope: ServiceReportScope, window: ServiceWindow): Promise<number> {
  const rows = await rowsOf<{ n: string }>(
    tx,
    sql`select count(*)::bigint as n
        from pack_verification_failures f
        join orders o on o.tenant_id = f.tenant_id and o.id = f.order_id and o.client_id = ${scope.clientId}::uuid
        where f.tenant_id = ${scope.tenantId}::uuid${warehouseFilter(sql`f.warehouse_id`, scope.warehouseId)}
          and f.created_at >= ${ts(window.from)}
          and f.created_at < ${ts(window.to)}`,
  );
  return n(rows[0]?.n);
}

/**
 * The backlog (decision 5): orders received in the window, not cancelled,
 * received more than the target ago, with no `dispatch.dispatched` event as
 * of `asOf` (the 0039 `orderId` partial index carries the probe).
 */
async function lateNotDispatchedInTx(tx: TenantTx, scope: ServiceReportScope, window: ServiceWindow): Promise<number> {
  const rows = await rowsOf<{ n: string }>(
    tx,
    sql`select count(*)::bigint as n
        from orders o
        where o.tenant_id = ${scope.tenantId}::uuid
          and o.client_id = ${scope.clientId}::uuid${warehouseFilter(sql`o.warehouse_id`, scope.warehouseId)}
          and o.created_at >= ${ts(window.from)}
          and o.created_at < ${ts(window.to)}
          and o.status <> 'cancelled'
          and o.created_at <= ${ts(window.asOf)} - make_interval(hours => ${SERVICE_TARGET_HOURS}::int)
          and not exists (
            select 1 from ledger_events le
            where le.reference_doc ? 'orderId'
              and le.reference_doc ->> 'orderId' = o.id::text
              and le.tenant_id = o.tenant_id
              and le.client_id = o.client_id
              and le.type = 'dispatch.dispatched'
              and le.recorded_at < ${ts(window.asOf)}
          )`,
  );
  return n(rows[0]?.n);
}

/** Every figure of the report, inside the caller's (single, timed) transaction. */
export async function readServiceFiguresInTx(tx: TenantTx, scope: ServiceReportScope, window: ServiceWindow): Promise<ServiceFigures> {
  await armServiceDeadline(tx, window.deadlineAt);
  const dock = await dockToStockInTx(tx, scope, window);
  await armServiceDeadline(tx, window.deadlineAt);
  const dispatched = await dispatchedInTx(tx, scope, window);
  await armServiceDeadline(tx, window.deadlineAt);
  const packFailures = await packFailuresInTx(tx, scope, window);
  await armServiceDeadline(tx, window.deadlineAt);
  const lateNotDispatched = await lateNotDispatchedInTx(tx, scope, window);
  await armServiceDeadline(tx, window.deadlineAt);
  const countingSince = await countingSinceInTx(tx);
  return {
    dockToStock: dock,
    pickAccuracy: {
      accuracy: ratio(dispatched.linesDispatched - dispatched.linesShortPicked, dispatched.linesDispatched),
      linesDispatched: dispatched.linesDispatched,
      linesShortPicked: dispatched.linesShortPicked,
      packFailures,
      packFailuresCountingSince: countingSince,
    },
    dispatchTimeliness: {
      ordersDispatched: dispatched.ordersDispatched,
      onTime: dispatched.onTime,
      onTimeRate: ratio(dispatched.onTime, dispatched.ordersDispatched),
      medianMinutes: dispatched.medianMinutes,
      lateNotDispatched,
    },
  };
}
