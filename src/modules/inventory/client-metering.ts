import { sql, type SQL } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { warehouseFilter } from '../../shared/db/warehouse-filter';
import type { KeysetWindow } from '../../shared/primitives/pagination';

/**
 * Story 21-4 — the ledger reads client billing meters from (AD-25: billing is
 * a projection over the ledger; it reads it ONLY through `InventoryFacade`,
 * which delegates here). Every read is over `ledger_events.client_id` — the
 * client stamped on the event from the SKU at append (21-2b). 0061's
 * `(tenant_id, client_id, warehouse_id, recorded_at)` index serves the fold
 * and the scope discovery; `(tenant_id, client_id, type, recorded_at)` the
 * dispatched-order count.
 *
 * Instants are `recorded_at` (the server stamp, never the device's
 * `occurred_at`), half-open `[from, to)`.
 */

/** One client's events in one warehouse — the storage fold's scope. */
export interface ClientWarehouseScope {
  readonly tenantId: string;
  readonly clientId: string;
  readonly warehouseId: string;
}

/**
 * One client across every warehouse — the handling counts' scope. Story 21-5:
 * an optional `warehouseIds` narrows it to a set of warehouses (a client
 * invoice meters each supplying GSTIN over ITS warehouses only). Absent =
 * every warehouse, and the predicate is byte-identical to 21-4's; an EMPTY
 * list matches nothing.
 */
export interface ClientScope {
  readonly tenantId: string;
  readonly clientId: string;
  readonly warehouseIds?: readonly string[] | undefined;
}

/** One IST day's net on-hand movement of one base UoM, in milli-units. */
export interface ClientDayDelta {
  /** The IST calendar day (`YYYY-MM-DD`) the events' `recorded_at` falls on. */
  readonly day: string;
  /** The SKU's base UoM (immutable on the SKU). */
  readonly uom: string;
  /** Signed milli-units — a BigInt: a warehouse-wide sum can pass 2⁵³. */
  readonly deltaMilli: bigint;
}

/**
 * THE fold rule (the ledger's own replay, `foldLedgerInTx`): an event counts
 * `+|δ|` when it carries only a destination bin, `−|δ|` when it carries only a
 * source bin, and 0 otherwise. So a relocation (putaway, bin merge, QC hold
 * and release, a same-warehouse transfer leg) nets to zero, a pick is a draw,
 * and pack / dispatch / excursion events (both bins null) count nothing — for
 * every registered type, without naming one. Per-warehouse on-hand at instant
 * `T` is this sum over the events with `recorded_at < T`.
 */
export const ON_HAND_FOLD_TERM: SQL = sql`case
  when le.to_bin_id is not null and le.from_bin_id is null then abs(le.quantity_delta)
  when le.from_bin_id is not null and le.to_bin_id is null then -abs(le.quantity_delta)
  else 0::bigint
end`;

/**
 * The IST calendar day of an event's `recorded_at`, as `YYYY-MM-DD` text
 * (UTC+05:30 year-round — no zone database involved).
 */
const IST_DAY_OF_RECORDED_AT: SQL = sql`to_char((le.recorded_at at time zone 'UTC') + interval '330 minutes', 'YYYY-MM-DD')`;

/**
 * The storage fold, bucketed: per (IST day, base UoM) the net on-hand
 * movement of one client in one warehouse, over `[fromInstant, toInstant)`
 * (`fromInstant` null = from genesis). ONE grouped query; the caller carries a
 * running total forward day by day.
 */
export async function clientOnHandFoldByDayInTx(
  tx: TenantTx,
  scope: ClientWarehouseScope,
  fromInstant: string | null,
  toInstant: string,
): Promise<ClientDayDelta[]> {
  const lower = fromInstant === null ? sql`` : sql`and le.recorded_at >= ${fromInstant}::timestamptz`;
  const rows = (await tx.execute(sql`
    select ${IST_DAY_OF_RECORDED_AT} as "day", s.uom as "uom", sum(${ON_HAND_FOLD_TERM})::text as "deltaMilli"
    from ledger_events le
    join skus s on s.tenant_id = le.tenant_id and s.id = le.sku_id
    where le.tenant_id = ${scope.tenantId}::uuid
      and le.client_id = ${scope.clientId}::uuid
      and le.warehouse_id = ${scope.warehouseId}::uuid
      ${lower}
      and le.recorded_at < ${toInstant}::timestamptz
    group by 1, 2
    order by 1, 2
  `)) as unknown as { day: string; uom: string; deltaMilli: string }[];
  // postgres.js hands a numeric/bigint aggregate back as text — BigInt it.
  return rows.map((row) => ({ day: row.day, uom: row.uom, deltaMilli: BigInt(row.deltaMilli) }));
}

/**
 * Which warehouses each of these clients has ANY ledger event in — the
 * snapshot job's scope discovery. An EXISTS probe per (client, warehouse) on
 * the 0061 index's `(tenant_id, client_id, warehouse_id)` prefix: it stops at
 * the first event, never scans a client's history. Ordered (client, warehouse).
 */
export async function clientWarehousesWithEventsInTx(
  tx: TenantTx,
  tenantId: string,
  clientIds: readonly string[],
): Promise<{ clientId: string; warehouseId: string }[]> {
  const distinct = [...new Set(clientIds)];
  if (distinct.length === 0) return [];
  // The ids travel as ONE bound uuid[] parameter — never concatenated into text.
  const rows = (await tx.execute(sql`
    select c.id as "clientId", w.id as "warehouseId"
    from unnest(${sql.param(distinct)}::uuid[]) as c(id)
    cross join warehouses w
    where w.tenant_id = ${tenantId}::uuid
      and exists (
        select 1 from ledger_events le
        where le.tenant_id = ${tenantId}::uuid and le.client_id = c.id and le.warehouse_id = w.id
      )
    order by c.id, w.id
  `)) as unknown as { clientId: string; warehouseId: string }[];
  return rows.map((row) => ({ clientId: row.clientId, warehouseId: row.warehouseId }));
}

/**
 * One client's on-hand per base UoM in one warehouse at instant `toInstant`
 * — the fold from genesis, grouped by uom only (the drift check's
 * genesis-sum: it must equal the watermark's running total).
 */
export async function clientOnHandAtInTx(
  tx: TenantTx,
  scope: ClientWarehouseScope,
  toInstant: string,
): Promise<Map<string, bigint>> {
  const rows = (await tx.execute(sql`
    select s.uom as "uom", sum(${ON_HAND_FOLD_TERM})::text as "milli"
    from ledger_events le
    join skus s on s.tenant_id = le.tenant_id and s.id = le.sku_id
    where le.tenant_id = ${scope.tenantId}::uuid
      and le.client_id = ${scope.clientId}::uuid
      and le.warehouse_id = ${scope.warehouseId}::uuid
      and le.recorded_at < ${toInstant}::timestamptz
    group by 1
  `)) as unknown as { uom: string; milli: string }[];
  return new Map(rows.map((row) => [row.uom, BigInt(row.milli)]));
}

/** The earliest `recorded_at` of one client's events in one warehouse (null = none). */
export async function firstEventInstantInTx(tx: TenantTx, scope: ClientWarehouseScope): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select le.recorded_at as "recordedAt"
    from ledger_events le
    where le.tenant_id = ${scope.tenantId}::uuid
      and le.client_id = ${scope.clientId}::uuid
      and le.warehouse_id = ${scope.warehouseId}::uuid
    order by le.recorded_at asc
    limit 1
  `)) as unknown as { recordedAt: string | Date }[];
  const row = rows[0];
  return row === undefined ? null : new Date(row.recordedAt).toISOString();
}

/**
 * The dispatched-order events of one client in `[from, to)` whose order was
 * FIRST dispatched in that window — the ONE predicate behind the `per_order`
 * count and (21-5) its dispute drill-down. `dispatch.dispatched` is emitted
 * once per order LINE, and an order's lines can dispatch on different days;
 * attributing each order to its first dispatch event means an order whose
 * lines straddle a card boundary or a period end is counted exactly once.
 * An order never mixes clients (21-2b), so the event's client is the
 * order's. Alias `le`; the earlier-dispatch probe rides 0039's
 * `reference_doc->>'orderId'` partial index (hence the `? 'orderId'` qual).
 */
export function dispatchedOrderEventsPredicate(scope: ClientScope, from: string, to: string): SQL {
  // Story 21-5: the warehouse narrowing filters the OUTER (window) events
  // only — the "no earlier dispatch" probe stays across every warehouse, so
  // an order is still attributed to its first dispatch, wherever that was.
  return sql`le.tenant_id = ${scope.tenantId}::uuid
    and le.client_id = ${scope.clientId}::uuid
    and le.type = 'dispatch.dispatched'
    and le.recorded_at >= ${from}::timestamptz
    and le.recorded_at < ${to}::timestamptz${warehouseFilter(sql`le.warehouse_id`, scope.warehouseIds)}
    and not exists (
      select 1 from ledger_events earlier
      where earlier.reference_doc ? 'orderId'
        and earlier.reference_doc ->> 'orderId' = le.reference_doc ->> 'orderId'
        and earlier.tenant_id = le.tenant_id
        and earlier.client_id = le.client_id
        and earlier.type = 'dispatch.dispatched'
        and earlier.recorded_at < ${from}::timestamptz
    )`;
}

/** Distinct orders FIRST dispatched for one client in `[from, to)`, across warehouses. */
export async function countDispatchedOrdersInTx(
  tx: TenantTx,
  scope: ClientScope,
  from: string,
  to: string,
): Promise<number> {
  const rows = (await tx.execute(sql`
    select count(distinct le.reference_doc ->> 'orderId')::bigint as "n"
    from ledger_events le
    where ${dispatchedOrderEventsPredicate(scope, from, to)}
  `)) as unknown as { n: string | number }[];
  return Number(rows[0]?.n ?? 0);
}

/** Story 21-5b — one order of the dispatched-order drill: its FIRST dispatch event in the window. */
export interface DispatchedOrderRecordRow {
  /** The first event's id — the keyset tiebreaker. */
  readonly eventId: string;
  /** The first event's `recorded_at::text` — the raw Postgres text. */
  readonly recordedAt: string;
  readonly warehouseId: string;
  readonly orderId: string;
  /** The order's dispatch events in this window (and warehouse set) — one per order line shipped. */
  readonly lines: number;
  /** The first event's carrier arms (absent on a dispatch with no carrier recorded). */
  readonly carrierName: string | null;
  readonly trackingNumber: string | null;
  readonly actorId: string;
}

/**
 * Story 21-5b — the `per_order` dispute drill: one row per order the
 * `per_order` count counts, on the SAME predicate
 * (`dispatchedOrderEventsPredicate`). The order is represented by its first
 * dispatch event in the window — `DISTINCT ON (orderId)` ordered by
 * `(recorded_at, id)`; by the predicate's global "no earlier dispatch" probe
 * that is the order's first dispatch anywhere, so an order is billed and
 * drilled exactly once. `lines` counts the order's matching events (a window
 * function, evaluated before the DISTINCT ON). Ascending on the first event's
 * `(recorded_at, id)`, keyset-paged after `window.after`.
 */
export async function dispatchedOrderRecordsInTx(
  tx: TenantTx,
  scope: ClientScope,
  from: string,
  to: string,
  window: KeysetWindow,
): Promise<DispatchedOrderRecordRow[]> {
  const after =
    window.after === null ? sql`` : sql`where (f.recorded_at, f.id) > (${window.after.createdAt}::timestamptz, ${window.after.id}::uuid)`;
  const rows = (await tx.execute(sql`
    select f.id as "eventId", f.recorded_at::text as "recordedAt", f.warehouse_id as "warehouseId", f.order_id as "orderId",
      f.lines::text as "lines", f.carrier_name as "carrierName", f.tracking_number as "trackingNumber", f.actor_user_id as "actorId"
    from (
      select distinct on (le.reference_doc ->> 'orderId')
        le.id, le.recorded_at, le.warehouse_id, le.reference_doc ->> 'orderId' as order_id,
        count(*) over (partition by le.reference_doc ->> 'orderId') as lines,
        le.reference_doc ->> 'carrierName' as carrier_name,
        le.reference_doc ->> 'trackingNumber' as tracking_number,
        le.actor_user_id
      from ledger_events le
      where ${dispatchedOrderEventsPredicate(scope, from, to)}
      order by le.reference_doc ->> 'orderId', le.recorded_at, le.id
    ) f
    ${after}
    order by f.recorded_at, f.id
    limit ${window.limit}
  `)) as unknown as (Omit<DispatchedOrderRecordRow, 'lines'> & { lines: string })[];
  return rows.map((row) => ({ ...row, lines: Number(row.lines) }));
}

/** Story 21-5b — one SKU's on-hand in a storage breakdown (milli-units, signed). */
export interface ClientSkuOnHand {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly milli: bigint;
}

/**
 * Story 21-5b — the storage drill's per-SKU breakdown of ONE (day,
 * warehouse): one client's on-hand per SKU of one base UoM at `toInstant`,
 * folded from genesis with `ON_HAND_FOLD_TERM` on `le.client_id` (the event's
 * stamp — the snapshot's own grouping). Rows whose on-hand is not zero —
 * NEGATIVE ones included (the sum must equal the snapshot, and a negative
 * SKU is part of it). Ordered by SKU code.
 */
export async function clientOnHandBySkuAtInTx(
  tx: TenantTx,
  scope: ClientWarehouseScope,
  uom: string,
  toInstant: string,
): Promise<ClientSkuOnHand[]> {
  const rows = (await tx.execute(sql`
    select s.id as "skuId", s.code as "skuCode", s.name as "skuName", sum(${ON_HAND_FOLD_TERM})::text as "milli"
    from ledger_events le
    join skus s on s.tenant_id = le.tenant_id and s.id = le.sku_id
    where le.tenant_id = ${scope.tenantId}::uuid
      and le.client_id = ${scope.clientId}::uuid
      and le.warehouse_id = ${scope.warehouseId}::uuid
      and s.uom = ${uom}
      and le.recorded_at < ${toInstant}::timestamptz
    group by s.id, s.code, s.name
    having sum(${ON_HAND_FOLD_TERM}) <> 0
    order by s.code, s.id
  `)) as unknown as { skuId: string; skuCode: string; skuName: string; milli: string }[];
  return rows.map((row) => ({ skuId: row.skuId, skuCode: row.skuCode, skuName: row.skuName, milli: BigInt(row.milli) }));
}
