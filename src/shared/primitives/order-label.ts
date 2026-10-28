import { sql, type SQL } from 'drizzle-orm';

/**
 * Story 4-1b, amended by 4-2c (A10) — the ONE order label rule, wherever an
 * order is named: `clientOrderRef ?? externalEventId ?? <the ROOT's short id>`,
 * then `-BO{seq}` on a backorder follow-on. A shared primitive so the
 * file-level readers that may import only `shared/` (the client wind-down)
 * name orders by the same rule as the commands. The web's `orderLabel`
 * (wms-fe `lib/orders.ts`) is the third copy, pinned by its own tests.
 */
/** The fields the order label reads. */
export interface OrderLabelFields {
  readonly id: string;
  readonly clientOrderRef?: string | null | undefined;
  readonly externalEventId?: string | null | undefined;
  readonly followOnSeq?: number | null | undefined;
  readonly followOnRootOrderId?: string | null | undefined;
}

/** `-BO{seq}` for a follow-on, '' for a root. */
export function followOnLabelSuffix(seq: number | null | undefined): string {
  return seq === null || seq === undefined ? '' : `-BO${seq}`;
}

/**
 * The order label — ONE rule wherever an order is named (4-1b, amended by
 * 4-2c A10): `clientOrderRef ?? externalEventId ?? <the ROOT's short id>`,
 * then `-BO{seq}` on a follow-on. The short id is the root's last eight
 * characters (a follow-on of an unnamed order reads `a1b2c3d4-BO2`, never its
 * own id's tail).
 */
export function orderLabelOf(order: OrderLabelFields): string {
  const root = order.followOnRootOrderId ?? order.id;
  return `${order.clientOrderRef ?? order.externalEventId ?? root.slice(-8)}${followOnLabelSuffix(order.followOnSeq)}`;
}

/** The same rule in SQL over an `orders` alias (`o`, or the bare table when '') — pinned against `orderLabelOf`. */
export function orderLabelSql(alias: string): SQL {
  const p = alias === '' ? '' : `${alias}.`;
  return sql.raw(
    `(coalesce(${p}client_order_ref, ${p}external_event_id, right(coalesce(${p}follow_on_root_order_id, ${p}id)::text, 8))` +
      ` || case when ${p}follow_on_seq is null then '' else '-BO' || ${p}follow_on_seq::text end)`,
  );
}

/** A10 — a printed follow-on label searched as typed: `1042-BO1` finds the chain by `1042`. */
const LABEL_SUFFIX_RE = /-BO\d+$/;

/** The reference stripped of a trailing `-BO{n}`, or null when it carries none. */
export function stripFollowOnSuffix(reference: string): string | null {
  if (!LABEL_SUFFIX_RE.test(reference)) return null;
  const stripped = reference.replace(LABEL_SUFFIX_RE, '');
  return stripped === '' ? null : stripped;
}
