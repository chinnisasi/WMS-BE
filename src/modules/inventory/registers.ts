import { sql, type SQL } from 'drizzle-orm';
import { skuOfClient } from '../../shared/db/client-filter';
import { rearmTxDeadline } from '../../shared/db/tx-deadline';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
import { fullPrecisionInstant } from '../../shared/primitives/time';
import type { LedgerReferenceDoc } from './ledger-registry';

/**
 * Story 5-3a — the inventory reads behind the operational registers
 * (`reporting/registers.ts`), delegated to by `InventoryFacade`. Read-only,
 * inside the caller's transaction; each statement re-arms the caller's
 * whole-read deadline first (`rearmTxDeadline` — a no-op for a caller with
 * none). Quantities leave here in BASE units (`fromMilli`), the read-model
 * rule; ids leave as text. Batch facts (code, dates) are catalog's — the
 * caller looks them up through `CatalogFacade` by `batchId`.
 *
 * Every read takes a row `limit` (the register cap + 1) and stops there: the
 * caller refuses a register over its cap, never truncates one.
 */

export interface RegisterScope {
  readonly tenantId: string;
  readonly warehouseId: string;
  /** Null: every client. Otherwise the SKU's client (stock, ageing) or the event's own (ledger). */
  readonly clientId: string | null;
}

export interface RegisterWindow {
  /** Inclusive lower bound on `created_at`, an ISO instant. */
  readonly from: string;
  /** Exclusive upper bound on `created_at`, an ISO instant. */
  readonly to: string;
}

/** An ISO-8601 UTC instant with milliseconds, rendered by Postgres (never the session zone). */
function iso(column: SQL): SQL {
  return sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** The event's OWN `client_id` (the ledger — a column of its own, the 1-5a own-column rule). */
function clientPredicate(column: SQL, clientId: string | null): SQL {
  return clientId === null ? sql`` : sql` and ${column} = ${clientId}::uuid`;
}

/** A projection row's client through its SKU — the shared 1-5a predicate (`client-filter.ts`). */
function skuClientPredicate(skuColumn: SQL, scope: RegisterScope): SQL {
  return scope.clientId === null ? sql`` : sql` and ${skuOfClient(skuColumn, scope.tenantId, scope.clientId)}`;
}

// ── stock on hand — bin × batch, as of now ──────────────────────────────────

export interface StockRegisterRow {
  readonly zoneCode: string | null;
  readonly binCode: string;
  /** `bins.system_owned` — RECEIVING, QC-HOLD, IN-TRANSIT, RETURNS … are listed and flagged. */
  readonly systemBin: boolean;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly hsn: string | null;
  readonly clientId: string;
  readonly uom: string;
  /** Null on the untracked arm. */
  readonly batchId: string | null;
  /** Base units. */
  readonly quantity: number;
}

/**
 * ONE statement (a consistent snapshot): the batch arm is `batch_on_hand`;
 * the untracked arm is `stock_on_hand` of SKUs that are NOT batch-tracked —
 * a batch-tracked SKU's bin total is the sum of its batch rows, so taking
 * both arms for it would count it twice (design review B3). Non-zero rows
 * only (both quantities are CHECKed `>= 0`). A kit holds no stock, so it
 * never appears; a serial-tracked SKU is one row per bin; catch weight is
 * units only. Ordered storage bins first, then system bins, by bin code
 * (`COLLATE "C"`), SKU code, batch.
 */
export async function stockOnHandRegisterInTx(tx: TenantTx, scope: RegisterScope, limit: number): Promise<StockRegisterRow[]> {
  await rearmTxDeadline(tx);
  const rows = (await tx.execute(sql`
    select r.zone_code as "zoneCode", r.bin_code as "binCode", r.system_owned as "systemBin",
           r.sku_id as "skuId", r.sku_code as "skuCode", r.sku_name as "skuName", r.hsn as "hsn",
           r.client_id as "clientId", r.uom as "uom", r.batch_id as "batchId", r.quantity as "quantity"
    from (
      select z.code as zone_code, b.code as bin_code, b.system_owned, k.id::text as sku_id, k.code as sku_code,
             k.name as sku_name, k.hsn, k.client_id::text as client_id, k.uom, bo.batch_id::text as batch_id,
             bo.quantity::text as quantity
      from batch_on_hand bo
      join skus k on k.tenant_id = bo.tenant_id and k.id = bo.sku_id
      join bins b on b.tenant_id = bo.tenant_id and b.id = bo.bin_id and b.warehouse_id = bo.warehouse_id
      left join zones z on z.tenant_id = b.tenant_id and z.id = b.zone_id
      where bo.tenant_id = ${scope.tenantId}::uuid and bo.warehouse_id = ${scope.warehouseId}::uuid
        and bo.quantity > 0${skuClientPredicate(sql`bo.sku_id`, scope)}
      union all
      select z.code, b.code, b.system_owned, k.id::text, k.code, k.name, k.hsn, k.client_id::text, k.uom,
             null::text, s.quantity::text
      from stock_on_hand s
      join skus k on k.tenant_id = s.tenant_id and k.id = s.sku_id and k.batch_tracked = false
      join bins b on b.tenant_id = s.tenant_id and b.id = s.bin_id and b.warehouse_id = s.warehouse_id
      left join zones z on z.tenant_id = b.tenant_id and z.id = b.zone_id
      where s.tenant_id = ${scope.tenantId}::uuid and s.warehouse_id = ${scope.warehouseId}::uuid
        and s.quantity > 0${skuClientPredicate(sql`s.sku_id`, scope)}
    ) r
    order by r.system_owned, r.bin_code collate "C", r.sku_code collate "C", r.batch_id nulls first
    limit ${limit}::int
  `)) as unknown as (Omit<StockRegisterRow, 'quantity'> & { quantity: string })[];
  return rows.map((row) => ({ ...row, quantity: fromMilli(Number(row.quantity)) }));
}

// ── batch ageing — bin × batch with stock, as of now ─────────────────────────

export interface BatchAgeingRegisterRow {
  readonly binCode: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly clientId: string;
  readonly uom: string;
  readonly batchId: string;
  /** Base units. */
  readonly quantity: number;
}

/**
 * ONE statement: every `batch_on_hand` row with stock. The caller adds the
 * batch facts (expiry, mfg, first appearance) through `CatalogFacade` and
 * sorts by expiry — the dates are catalog's, never joined here.
 */
export async function batchAgeingRegisterInTx(tx: TenantTx, scope: RegisterScope, limit: number): Promise<BatchAgeingRegisterRow[]> {
  await rearmTxDeadline(tx);
  const rows = (await tx.execute(sql`
    select b.code as "binCode", k.id::text as "skuId", k.code as "skuCode", k.name as "skuName",
           k.client_id::text as "clientId", k.uom as "uom", bo.batch_id::text as "batchId", bo.quantity::text as "quantity"
    from batch_on_hand bo
    join skus k on k.tenant_id = bo.tenant_id and k.id = bo.sku_id
    join bins b on b.tenant_id = bo.tenant_id and b.id = bo.bin_id and b.warehouse_id = bo.warehouse_id
    where bo.tenant_id = ${scope.tenantId}::uuid and bo.warehouse_id = ${scope.warehouseId}::uuid
      and bo.quantity > 0${skuClientPredicate(sql`bo.sku_id`, scope)}
    order by k.code collate "C", b.code collate "C", bo.batch_id
    limit ${limit}::int
  `)) as unknown as (Omit<BatchAgeingRegisterRow, 'quantity'> & { quantity: string })[];
  return rows.map((row) => ({ ...row, quantity: fromMilli(Number(row.quantity)) }));
}

// ── the ledger — every event in a window ─────────────────────────────────────

export interface LedgerRegisterRow {
  readonly id: string;
  /** `created_at` — the period's basis, ISO. */
  readonly createdAt: string;
  readonly recordedAt: string;
  readonly occurredAt: string;
  readonly type: string;
  readonly skuId: string;
  readonly skuCode: string;
  /** The event's own `client_id` (the SKU's at append — 21-2b). */
  readonly clientId: string;
  readonly uom: string;
  readonly fromBinCode: string | null;
  readonly toBinCode: string | null;
  /** `batch_ref` — a batch id (text); null when the event carries no batch arm. */
  readonly batchId: string | null;
  /** SIGNED base units. */
  readonly quantity: number;
  readonly referenceDoc: LedgerReferenceDoc;
  readonly actorUserId: string;
}

/** The keyset page size of the ledger walk (one statement per page). */
export const LEDGER_REGISTER_PAGE = 5000;

/**
 * Every event of the warehouse (and, filtered, of the client — the event's own
 * `client_id`) whose `created_at` is in `[from, to)`, oldest first. Walks the
 * existing `(tenant_id, warehouse_id, created_at, id)` keyset (the
 * `(tenant_id, client_id, warehouse_id, created_at, id)` one when filtered,
 * 0081) one page per statement, with a FULL-precision cursor (a transaction's
 * events share one `now()` to the microsecond). The caller runs it inside a
 * REPEATABLE READ transaction, so every page reads one snapshot.
 */
export async function ledgerRegisterInTx(
  tx: TenantTx,
  scope: RegisterScope & RegisterWindow,
  limit: number,
  pageSize: number = LEDGER_REGISTER_PAGE,
): Promise<LedgerRegisterRow[]> {
  const out: LedgerRegisterRow[] = [];
  let after: { createdAt: string; id: string } | null = null;
  while (out.length < limit) {
    const page = Math.min(pageSize, limit - out.length);
    await rearmTxDeadline(tx);
    const cursor: SQL = after === null ? sql`` : sql` and (le.created_at, le.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`;
    const rows = (await tx.execute(sql`
      select le.id::text as "id", le.created_at::text as "createdAtText", ${iso(sql`le.created_at`)} as "createdAt",
             ${iso(sql`le.recorded_at`)} as "recordedAt", ${iso(sql`le.occurred_at`)} as "occurredAt",
             le.type as "type", le.sku_id::text as "skuId", k.code as "skuCode", le.client_id::text as "clientId", k.uom as "uom",
             fb.code as "fromBinCode", tb.code as "toBinCode", le.batch_ref as "batchId",
             le.quantity_delta::text as "quantity", le.reference_doc as "referenceDoc", le.actor_user_id::text as "actorUserId"
      from ledger_events le
      join skus k on k.tenant_id = le.tenant_id and k.id = le.sku_id
      left join bins fb on fb.tenant_id = le.tenant_id and fb.id = le.from_bin_id
      left join bins tb on tb.tenant_id = le.tenant_id and tb.id = le.to_bin_id
      where le.tenant_id = ${scope.tenantId}::uuid and le.warehouse_id = ${scope.warehouseId}::uuid${clientPredicate(sql`le.client_id`, scope.clientId)}
        and le.created_at >= ${scope.from}::timestamptz and le.created_at < ${scope.to}::timestamptz${cursor}
      order by le.created_at, le.id
      limit ${page}::int
    `)) as unknown as (Omit<LedgerRegisterRow, 'quantity'> & { quantity: string; createdAtText: string })[];
    for (const row of rows) {
      // A raw read may hand jsonb back as text — parse it once here.
      const referenceDoc = (typeof row.referenceDoc === 'string' ? JSON.parse(row.referenceDoc) : row.referenceDoc) as LedgerReferenceDoc;
      out.push({
        id: row.id,
        createdAt: row.createdAt,
        recordedAt: row.recordedAt,
        occurredAt: row.occurredAt,
        type: row.type,
        skuId: row.skuId,
        skuCode: row.skuCode,
        clientId: row.clientId,
        uom: row.uom,
        fromBinCode: row.fromBinCode,
        toBinCode: row.toBinCode,
        batchId: row.batchId,
        quantity: fromMilli(Number(row.quantity)),
        referenceDoc,
        actorUserId: row.actorUserId,
      });
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < page) break;
    after = { createdAt: fullPrecisionInstant(last.createdAtText), id: last.id };
  }
  return out;
}

// ── the first dispatch of each order ─────────────────────────────────────────

export interface FirstDispatch {
  readonly orderId: string;
  /** The first `dispatch.dispatched` event's `recorded_at` (by `(recorded_at, id)`). */
  readonly dispatchedAt: string;
  readonly carrierName: string | null;
  readonly trackingNumber: string | null;
}

/**
 * Each order's FIRST `dispatch.dispatched` event (an order whose lines
 * dispatched in two goes counts its first), with that event's carrier and
 * tracking reference. The query states `reference_doc ? 'orderId'` beside
 * the equality so the planner can use 0039's PARTIAL
 * `ledger_events_order_ref_idx` (IMPLEMENTATION-GUIDE §9 — an `->>` equality
 * alone does not imply the predicate; pinned by an EXPLAIN in
 * `test/registers.spec.ts`). The ids travel as ONE bound text[] parameter.
 */
export async function firstDispatchByOrderInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, FirstDispatch>> {
  const ids = [...new Set(orderIds)].filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase());
  if (ids.length === 0) return new Map();
  await rearmTxDeadline(tx);
  const rows = (await tx.execute(firstDispatchQuery(tenantId, ids))) as unknown as FirstDispatch[];
  return new Map(rows.map((row) => [row.orderId, row]));
}

/** The statement itself — exported so the EXPLAIN test plans the REAL query, never a copy. */
export function firstDispatchQuery(tenantId: string, orderIds: readonly string[]): SQL {
  return sql`
    select distinct on (le.reference_doc ->> 'orderId')
           le.reference_doc ->> 'orderId' as "orderId",
           ${iso(sql`le.recorded_at`)} as "dispatchedAt",
           le.reference_doc ->> 'carrierName' as "carrierName",
           le.reference_doc ->> 'trackingNumber' as "trackingNumber"
    from ledger_events le
    where le.reference_doc ? 'orderId'
      and (le.reference_doc ->> 'orderId') = any(${sql.param([...orderIds])}::text[])
      and le.tenant_id = ${tenantId}::uuid
      and le.type = 'dispatch.dispatched'
    order by le.reference_doc ->> 'orderId', le.recorded_at, le.id
  `;
}
