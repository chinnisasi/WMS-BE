/**
 * Kit composition store (Story 11.4 — the file-level in-tx seam, the
 * `handling-unit.store.ts` pattern).
 *
 * `kit_compositions` is CATALOG-owned: kit-ness is the PRESENCE of composition
 * rows, never a flag. `KitCommand` is the primary writer (AD-6); the catalog
 * import's `kit_components` resolution pass (Story 11.6) is the second
 * catalog-internal one, writing through these same guards. Every
 * other module's read of kit-ness goes through these functions — the inventory
 * module cannot take a DI edge on `CatalogModule` (catalog reaches tenancy,
 * tenancy reaches putaway, putaway reaches back there — the module-EVALUATION
 * cycle), and the established escape for exactly this is the file-level in-tx
 * helper (`ensureReceivingBinInTx`, `openQcHoldsForBinsInTx`); siblings that
 * CAN hold `CatalogFacade` (inbound, outbound) read the same functions through
 * its delegating methods. One implementation.
 *
 * Every function runs on the CALLER's transaction: the explosion reads the BOM
 * in the same transaction that accepts the order, and a GRN line's kit refusal
 * is decided against the same snapshot the GRN writes against.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { kitCompositions } from '../../shared/db/schema';

/** One composition row as the explosion consumes it (Story 11.4) — milli-units in. */
export interface KitCompositionLine {
  readonly componentSkuId: string;
  /** Per ONE kit, in the component's base UoM (milli-units). */
  readonly qty: number;
}

/**
 * The flat BOM of one kit, inside the caller's transaction (`createOrder`
 * phase 1). Empty when the sku id is unknown, foreign, or simply not a kit:
 * the CALLER decides what an empty composition means (a kit line with no rows
 * cannot exist — kit-ness is the rows — and a non-kit line explodes to
 * nothing).
 */
export async function getKitCompositionInTx(
  tx: TenantTx,
  tenantId: string,
  kitSkuId: string,
): Promise<KitCompositionLine[]> {
  return tx
    .select({ componentSkuId: kitCompositions.componentSkuId, qty: kitCompositions.qty })
    .from(kitCompositions)
    .where(and(eq(kitCompositions.tenantId, tenantId), eq(kitCompositions.kitSkuId, kitSkuId)))
    .orderBy(kitCompositions.id);
}

/**
 * Which of these SKUs are kits (the +stock guards' shared lookup): the subset
 * of `skuIds` carrying composition rows, preserving query order,
 * deduplicated.
 */
export async function getKitSkuIdsInTx(
  tx: TenantTx,
  tenantId: string,
  skuIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(skuIds)];
  if (ids.length === 0) {
    return [];
  }
  const rows = await tx
    .selectDistinctOn([kitCompositions.kitSkuId], { kitSkuId: kitCompositions.kitSkuId })
    .from(kitCompositions)
    .where(and(eq(kitCompositions.tenantId, tenantId), inArray(kitCompositions.kitSkuId, ids)));
  const kitSet = new Set(rows.map((row) => row.kitSkuId));
  return skuIds.filter((skuId) => kitSet.has(skuId));
}

/**
 * The FR-38 refusal, shared by both +stock writers (GRN lines, stock
 * adjustments): a kit SKU never receives or adjusts stock — its stock IS its
 * components'. One definition, two importers, so the wording cannot drift.
 */
export function kitCannotHoldStock(kind: string, codes: readonly string[]): ProblemException {
  const named = codes.map((code) => `"${code}"`).join(', ');
  return new ProblemException(
    'kit-cannot-hold-stock',
    409,
    'A kit SKU cannot hold stock',
    `${kind} names kit SKU(s) ${named} — a kit's stock IS its components'. Move stock on the component SKUs; the kit explodes into them at order acceptance.`,
  );
}