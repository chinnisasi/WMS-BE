/**
 * Story 1-4b — SKU deactivation: the takes-work guard and the order create's
 * phase-3 status read. Re-exported through `catalog.facade.ts`; siblings
 * import them from there.
 *
 * Both take the SKU rows `FOR KEY SHARE` in id order. A plain `UPDATE` of
 * `status` takes only `NO KEY UPDATE`, which does not conflict with `KEY
 * SHARE`, so the status command locks `FOR UPDATE` explicitly (the partners
 * gotcha): a deactivation and a work-creating write serialise — the writer
 * commits first, or it re-reads `inactive` and is refused. Kit create and the
 * GRN lock SKU rows `FOR UPDATE` in id order too, so the same order avoids a
 * deadlock against them.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { kitCompositions, skus, type SkuStatus } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * 409 `sku-inactive`, naming the codes (sorted, de-duplicated) in
 * `extensions.skuCodes`. `detail` overrides the default sentence (the order
 * create's sell-down refusal names the available quantity).
 */
export function skuInactive(skuCodes: readonly string[], detail?: string): ProblemException {
  const codes = [...new Set(skuCodes)].sort();
  return new ProblemException(
    'sku-inactive',
    409,
    'SKU inactive',
    detail ??
      `${codes.length === 1 ? 'SKU' : 'SKUs'} ${codes.map((code) => `"${code}"`).join(', ')} ${
        codes.length === 1 ? 'is' : 'are'
      } inactive — an inactive SKU takes no new POs, ASNs, kits or channel mappings. Reactivate it first.`,
    { skuCodes: codes },
  );
}

/**
 * The guard every path that creates new inbound, kit composition or channel
 * mapping work for a SKU runs, after replay and dedup and at decision 13's
 * position (SKU 404 → client checks → `sku-inactive` → anything later).
 * Locks the named SKU rows `FOR KEY SHARE` in id order and throws 409
 * `sku-inactive` naming every inactive one. An id that names no SKU of the
 * tenant is ignored — the caller's own 404 ran first.
 */
export async function assertSkusTakeWorkInTx(
  tx: TenantTx,
  tenantId: string,
  skuIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(skuIds)].sort();
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: skus.id, code: skus.code, status: skus.status })
    .from(skus)
    .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, ids)))
    .orderBy(asc(skus.id))
    .for('key share');
  const inactive = rows.filter((row) => row.status !== 'active');
  if (inactive.length > 0) {
    throw skuInactive(inactive.map((row) => row.code));
  }
}

/** One SKU's status and kit-ness as `lockSkuStatusesInTx` read it under the lock. */
export interface LockedSkuStatus {
  readonly code: string;
  readonly status: SkuStatus;
  readonly isKit: boolean;
  /** Story 1-6d — the goods attributes the licence re-check reads (1-6a's columns), under the same lock. */
  readonly foodCategory: string | null;
  readonly drugSchedules: readonly string[];
}

/**
 * The order create's phase-3 re-read: the named SKU rows `FOR KEY SHARE` in
 * id order, with their status and whether each is a kit NOW. Kit create locks
 * the kit SKU `FOR UPDATE`, so a composition committed after phase 1 is seen
 * here (the PENDING kit race), and a deactivation committed after phase 1 is
 * seen too. An unknown id is absent. Story 1-6d: the goods attributes ride
 * the same read, so the order's licence re-check sees an edit since phase 1.
 */
export async function lockSkuStatusesInTx(
  tx: TenantTx,
  tenantId: string,
  skuIds: readonly string[],
): Promise<Map<string, LockedSkuStatus>> {
  const ids = [...new Set(skuIds)].sort();
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: skus.id, code: skus.code, status: skus.status, foodCategory: skus.foodCategory, drugSchedules: skus.drugSchedules })
    .from(skus)
    .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, ids)))
    .orderBy(asc(skus.id))
    .for('key share');
  const kitRows = await tx
    .selectDistinctOn([kitCompositions.kitSkuId], { kitSkuId: kitCompositions.kitSkuId })
    .from(kitCompositions)
    .where(and(eq(kitCompositions.tenantId, tenantId), inArray(kitCompositions.kitSkuId, ids)));
  const kits = new Set(kitRows.map((row) => row.kitSkuId));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        code: row.code,
        status: row.status as SkuStatus,
        isKit: kits.has(row.id),
        foodCategory: row.foodCategory,
        drugSchedules: row.drugSchedules,
      },
    ]),
  );
}

/** One line's SKU and quantity, as `skusGainingInbound` compares them. */
export interface InboundLineQty {
  readonly skuId: string;
  /** Milli-units (a stored line). */
  readonly qtyMilli: number;
}

/**
 * Story 1-4b decision 9 — the SKUs a replacement line set ADDS inbound for,
 * judged by SKU against the document's stored lines: a SKU the stored lines
 * do not carry, or one whose total requested quantity is above its stored
 * total (a raise is new inbound; a lowering is not). A kept line re-pointed
 * to another SKU is caught because the new SKU's total rises. The request is
 * in BASE units (`requestedBase`) — compared at milli scale without the
 * precision refusal, which runs later in the command; a non-finite value
 * never compares as a raise (the command's own validation refuses it).
 * Feed the result to `assertSkusTakeWorkInTx`.
 */
export function skusGainingInbound(
  stored: readonly InboundLineQty[],
  requested: readonly { readonly skuId: string; readonly qtyBase: number }[],
): string[] {
  const storedBySku = new Map<string, number>();
  for (const line of stored) storedBySku.set(line.skuId, (storedBySku.get(line.skuId) ?? 0) + line.qtyMilli);
  const requestedBySku = new Map<string, number>();
  for (const line of requested) {
    requestedBySku.set(line.skuId, (requestedBySku.get(line.skuId) ?? 0) + Math.round(line.qtyBase * 1000));
  }
  return [...requestedBySku]
    .filter(([skuId, milli]) => !storedBySku.has(skuId) || milli > storedBySku.get(skuId)!)
    .map(([skuId]) => skuId);
}
