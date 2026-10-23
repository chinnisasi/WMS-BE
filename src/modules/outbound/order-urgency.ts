/**
 * Story 4-2a — the order header fields' vocabularies and the ONE urgency key.
 *
 * Dependency-free beyond `drizzle-orm`'s `sql` tag, so the order command, the
 * wave planner, the device snapshot reads and the tests all import one copy.
 *
 * The three mirrored layers (IMPLEMENTATION-GUIDE §4, amended by the 4-2a
 * design review A11): the TS tuples below, the NOT VALID CHECKs of migration
 * 0093 (`orders_order_type_check`, `orders_priority_check`,
 * `orders_cod_amount_paise_check`), and the API layer's
 * `@ApiProperty({ enum })`. The VALUE check lives in the order command, behind
 * the replay lookup — never in the DTO. `test/order-fields.spec.ts` pins each
 * tuple against its CHECK.
 */
import { sql, type SQL } from 'drizzle-orm';

/** The order type (operational only — tax treatment stays GSTIN-driven). */
export const ORDER_TYPES = ['b2b', 'b2c'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

/** The order priority. `normal` is the column default (and every pre-4-2a row). */
export const ORDER_PRIORITIES = ['normal', 'high', 'urgent'] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

/** Story 4-2a (A12) — what a portal client may set; `urgent` is the warehouse's call. */
export const PORTAL_ORDER_PRIORITIES = ['normal', 'high'] as const satisfies readonly OrderPriority[];

/**
 * The priority rank — urgent first. `orderPriorityRankSql` is its one SQL
 * twin; `test/order-fields.spec.ts` (A10) evaluates the CASE in Postgres for
 * every priority and compares it with this map.
 */
export const ORDER_PRIORITY_RANK: Readonly<Record<OrderPriority, number>> = { urgent: 0, high: 1, normal: 2 };

/** The rank an unknown stored value would get — last, never first (fail safe). */
const UNKNOWN_PRIORITY_RANK = 3;

/** The COD ceiling: ₹1 crore in paise (the CHECK's upper bound) — the shared money primitive's one copy. */
export { MAX_COD_AMOUNT_PAISE } from '../../shared/primitives/money';

/** The rank of a stored priority (an unknown value sorts after `normal`). */
export function orderPriorityRank(priority: string | null | undefined): number {
  return Object.prototype.hasOwnProperty.call(ORDER_PRIORITY_RANK, priority ?? '')
    ? ORDER_PRIORITY_RANK[priority as OrderPriority]
    : UNKNOWN_PRIORITY_RANK;
}

/** The SQL twin of `orderPriorityRank` over a priority column. */
export function orderPriorityRankSql(column: SQL): SQL {
  return sql`(case ${column} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end)`;
}

/** The columns the urgency key reads, as SQL fragments of the caller's query. */
export interface UrgencyColumns {
  readonly priority: SQL;
  readonly shipByDate: SQL;
  readonly createdAt: SQL;
  readonly id: SQL;
}

/** The urgency columns of an `orders` row under a raw-SQL alias (`o`). */
export function orderUrgencyColumns(alias: string): UrgencyColumns {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`orderUrgencyColumns: "${alias}" is not a plain SQL alias`);
  const col = (name: string): SQL => sql.raw(`${alias}.${name}`);
  return { priority: col('priority'), shipByDate: col('ship_by_date'), createdAt: col('created_at'), id: col('id') };
}

/**
 * Story 4-2a (A8) — the urgency key, as an ORDER BY list (no `order by`
 * keyword, so a caller can append its own tie-breaks):
 *   1. due first — `ship_by_date` set and on or before today (IST): overdue
 *      or due today;
 *   2. the priority rank (urgent, high, normal);
 *   3. `ship_by_date` ascending, nulls last;
 *   4. `created_at`;
 *   5. `id`.
 * `todayIst` is a `YYYY-MM-DD` IST date the caller computed from ITS clock
 * (the wave's `WAVE_CLOCK`, the snapshot's `generatedAt`).
 */
export function orderUrgencyOrderBy(todayIst: string, columns: UrgencyColumns): SQL {
  const { priority, shipByDate, createdAt, id } = columns;
  return sql`(${shipByDate} is not null and ${shipByDate} <= ${todayIst}::date) desc, ${orderPriorityRankSql(priority)} asc, ${shipByDate} asc nulls last, ${createdAt} asc, ${id} asc`;
}

/** What the TS comparator reads of an order. */
export interface UrgencyFacts {
  readonly priority: string | null | undefined;
  readonly shipByDate: string | null | undefined;
  /** Comparable as text: canonical ISO-8601 (or the driver's full-precision text). */
  readonly createdAt: string;
  readonly id: string;
}

function isDue(shipByDate: string | null | undefined, todayIst: string): boolean {
  return shipByDate !== null && shipByDate !== undefined && shipByDate <= todayIst;
}

/** Byte comparison (never locale): ISO dates and uuids order as text. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Story 4-2a (A8) — the TS twin of `orderUrgencyOrderBy`: negative when `a`
 * is more urgent. Pinned against the SQL order by `test/order-fields.spec.ts`.
 */
export function compareOrderUrgency(a: UrgencyFacts, b: UrgencyFacts, todayIst: string): number {
  const dueA = isDue(a.shipByDate, todayIst);
  const dueB = isDue(b.shipByDate, todayIst);
  if (dueA !== dueB) return dueA ? -1 : 1;
  const rank = orderPriorityRank(a.priority) - orderPriorityRank(b.priority);
  if (rank !== 0) return rank;
  const shipA = a.shipByDate ?? null;
  const shipB = b.shipByDate ?? null;
  if (shipA !== shipB) {
    if (shipA === null) return 1;
    if (shipB === null) return -1;
    return byteCompare(shipA, shipB);
  }
  const created = byteCompare(a.createdAt, b.createdAt);
  if (created !== 0) return created;
  return byteCompare(a.id, b.id);
}

/**
 * Story 4-2a (A1) — a picklist's (or a pack card's) urgency over several
 * orders: the most urgent priority and the earliest ship-by date. An empty
 * set reads `normal` / null.
 */
export function foldOrderUrgency(
  facts: readonly { readonly priority: string | null | undefined; readonly shipByDate: string | null | undefined }[],
): { priority: OrderPriority; shipByDate: string | null } {
  let priority: OrderPriority = 'normal';
  let shipByDate: string | null = null;
  for (const fact of facts) {
    const rank = orderPriorityRank(fact.priority);
    if (rank < ORDER_PRIORITY_RANK[priority]) priority = fact.priority as OrderPriority;
    const date = fact.shipByDate ?? null;
    if (date !== null && (shipByDate === null || date < shipByDate)) shipByDate = date;
  }
  return { priority, shipByDate };
}
