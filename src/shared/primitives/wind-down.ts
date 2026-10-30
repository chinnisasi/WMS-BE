/**
 * Story 1-2a — the client wind-down check's vocabulary. A client departs only
 * once nothing is left open for it; each module that owns a blocker exports a
 * file-level `clientWindDownBlockersInTx(tx, tenantId, clientId)` returning
 * these, and `ClientsCommand.updateStatus` composes them on departure. The
 * type lives here (shared), so a blocker file imports nothing from
 * `modules/clients` — the dependency stays one-way (pinned by
 * `test/architecture.spec.ts`).
 */
import type { SQL } from 'drizzle-orm';
import type { TenantTx } from '../db/tenant-scope';

/** Every blocker kind, in the order the refusal lists them. */
export const WIND_DOWN_BLOCKER_KINDS = [
  'stock',
  'open-purchase-orders',
  'open-asns',
  'pending-over-receipts',
  'open-orders',
  'open-rmas',
  // Story 2-8b — open returns to vendor (draft or picked): the units are
  // claimed for a shipment the departure would orphan.
  'open-vendor-returns',
  // Story 4-7c — open returns to client (draft or picked): the units are
  // claimed for a shipment back to the brand the departure would orphan.
  'open-client-returns',
  // Story 3-7a (A16) — open LIVE recalls of its goods (a mock never blocks).
  'open-recalls',
  'pending-adjustments',
  'open-counts',
  'open-review-items',
  'unsettled-invoices',
  // Story 5-5a (A15) — ad-hoc charges not yet billed: pending ones, and
  // approved ones on no issued, disputed or settled invoice. A departing
  // client is billed for its extras.
  'unbilled-charges',
  // Decision 9 — any channel mapping of its SKUs (the owner unmaps first).
  'channel-mappings',
] as const;
export type WindDownBlockerKind = (typeof WIND_DOWN_BLOCKER_KINDS)[number];

/** The most document codes a blocker names (the rest are only counted). */
export const WIND_DOWN_MAX_CODES = 5;

/** One reason a client cannot depart yet. `codes` names up to five of them. */
export interface WindDownBlocker {
  readonly kind: WindDownBlockerKind;
  readonly count: number;
  readonly codes?: readonly string[];
}

/**
 * The blocker for one kind from a count and its (already capped, sorted)
 * codes — or nothing when the count is zero. `codes` is omitted when the
 * kind names none.
 */
export function windDownBlocker(
  kind: WindDownBlockerKind,
  count: number | string,
  codes?: readonly string[],
): WindDownBlocker[] {
  const n = Number(count);
  if (n === 0) {
    return [];
  }
  return [codes === undefined ? { kind, count: n } : { kind, count: n, codes: codes.slice(0, WIND_DOWN_MAX_CODES) }];
}

/**
 * One blocker read: a raw query answering one row `{ n, codes }` — `n` a
 * `::bigint` count (postgres.js returns it as a string, converted here at the
 * boundary, IMPLEMENTATION-GUIDE §2) and `codes` an optional `text[]`
 * (already ordered and capped by the query, or null).
 */
export async function windDownBlockerInTx(
  tx: TenantTx,
  kind: WindDownBlockerKind,
  query: SQL,
  withCodes: boolean,
): Promise<WindDownBlocker[]> {
  const [row] = (await tx.execute(query)) as unknown as { n: string | number; codes?: string[] | null }[];
  const codes = row?.codes ?? [];
  return windDownBlocker(kind, row?.n ?? 0, withCodes ? codes.filter((code) => code !== null) : undefined);
}
