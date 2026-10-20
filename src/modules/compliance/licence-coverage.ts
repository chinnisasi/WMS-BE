import { and, eq, sql } from 'drizzle-orm';
import { licences } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import {
  LICENCE_NEEDS,
  NEED_COVERED_BY,
  clientLicenceCovers,
  licenceFacts,
  needsOf,
  siteLicenceCovers,
  type LicenceKind,
  type LicenceNeed,
} from '../../shared/primitives/licence';

/**
 * Story 1-6c's coverage-gaps read, in the caller's transaction — moved out of
 * `licence.facade.ts` by 1-6d so the facade and the policy command
 * (`licence-policy.command.ts`, which counts the gaps) share it without a
 * file-level import cycle.
 */

/** One missing licence where drug or food goods are (decision 2). */
export interface CoverageGap {
  /** `client` — the brand's licence is missing for this site; `site` — the site's own. */
  readonly holder: 'client' | 'site';
  /** The client of a client gap; absent on a site gap. */
  readonly clientId?: string;
  readonly warehouseId: string;
  readonly need: LicenceNeed;
  /** The kinds that would close it (the web words the gap from these). */
  readonly coveredBy: readonly LicenceKind[];
  /** Distinct SKUs needing it there (on hand, or on an open PO or ASN). */
  readonly skuCount: number;
}

export interface CoverageGaps {
  readonly asOfDate: string;
  readonly gaps: readonly CoverageGap[];
}

/** The SKU goods filter — a drug schedule, or food (1-6b `isFood`). Kept beside `needsOf`, which decides the needs. */
const GOODS_FILTER = sql`(cardinality(s.drug_schedules) > 0 or (s.food_category is not null and s.food_category <> 'non-food'))`;

/**
 * The coverage gaps on `asOfDate`, in the caller's transaction (story 1-6c's
 * read; 1-6d's policy switch counts them — `gapCount` is `gaps.length`, the
 * same unit as the list). See `LicenceFacade.coverageGaps`.
 */
export async function coverageGapsInTx(tx: TenantTx, tenantId: string, asOfDate: string): Promise<CoverageGaps> {
  const goods = (await tx.execute(sql`
    with goods as (
      select s.client_id, soh.warehouse_id, s.id as sku_id
        from stock_on_hand soh
        join skus s on s.id = soh.sku_id and s.tenant_id = soh.tenant_id
       where soh.tenant_id = ${tenantId} and soh.quantity > 0 and ${GOODS_FILTER}
      union
      select s.client_id, po.warehouse_id, s.id
        from purchase_orders po
        join purchase_order_lines pol on pol.po_id = po.id and pol.tenant_id = po.tenant_id
        join skus s on s.id = pol.sku_id and s.tenant_id = pol.tenant_id
       where po.tenant_id = ${tenantId} and po.status = 'open' and pol.status = 'open'
         and pol.received_qty < pol.ordered_qty and ${GOODS_FILTER}
      union
      select s.client_id, a.warehouse_id, s.id
        from advance_shipment_notices a
        join asn_lines al on al.asn_id = a.id and al.tenant_id = a.tenant_id
        join skus s on s.id = al.sku_id and s.tenant_id = al.tenant_id
       where a.tenant_id = ${tenantId} and a.status in ('announced', 'partially_received') and ${GOODS_FILTER}
    )
    select g.client_id as "clientId", g.warehouse_id as "warehouseId", g.sku_id as "skuId",
           c.system_owned as "systemOwned", s.food_category as "foodCategory", s.drug_schedules as "drugSchedules"
      from goods g
      join clients c on c.id = g.client_id and c.tenant_id = ${tenantId} and c.status <> 'departed'
      join skus s on s.id = g.sku_id and s.tenant_id = ${tenantId}
     order by g.warehouse_id, g.client_id, g.sku_id
  `)) as unknown as {
    clientId: string;
    warehouseId: string;
    skuId: string;
    systemOwned: boolean;
    foodCategory: string | null;
    drugSchedules: string[];
  }[];

  const active = await tx
    .select()
    .from(licences)
    .where(and(eq(licences.tenantId, tenantId), eq(licences.status, 'active')));
  const facts = active.map(licenceFacts);

  // (client, site, need) → SKUs, and (site, need) → SKUs.
  const clientNeeds = new Map<string, { clientId: string; warehouseId: string; need: LicenceNeed; skus: Set<string> }>();
  const siteNeeds = new Map<string, { warehouseId: string; need: LicenceNeed; skus: Set<string> }>();
  for (const row of goods) {
    for (const need of needsOf({ foodCategory: row.foodCategory, drugSchedules: row.drugSchedules })) {
      if (!row.systemOwned) {
        const key = `${row.clientId}|${row.warehouseId}|${need}`;
        const entry = clientNeeds.get(key) ?? { clientId: row.clientId, warehouseId: row.warehouseId, need, skus: new Set() };
        entry.skus.add(row.skuId);
        clientNeeds.set(key, entry);
      }
      const siteKey = `${row.warehouseId}|${need}`;
      const site = siteNeeds.get(siteKey) ?? { warehouseId: row.warehouseId, need, skus: new Set() };
      site.skus.add(row.skuId);
      siteNeeds.set(siteKey, site);
    }
  }

  const gaps: CoverageGap[] = [];
  for (const entry of siteNeeds.values()) {
    if (!facts.some((licence) => siteLicenceCovers(licence, entry.warehouseId, entry.need, asOfDate))) {
      gaps.push({ holder: 'site', warehouseId: entry.warehouseId, need: entry.need, coveredBy: NEED_COVERED_BY[entry.need], skuCount: entry.skus.size });
    }
  }
  for (const entry of clientNeeds.values()) {
    if (!facts.some((licence) => clientLicenceCovers(licence, entry.clientId, entry.warehouseId, entry.need, asOfDate))) {
      gaps.push({
        holder: 'client',
        clientId: entry.clientId,
        warehouseId: entry.warehouseId,
        need: entry.need,
        coveredBy: NEED_COVERED_BY[entry.need],
        skuCount: entry.skus.size,
      });
    }
  }
  const needRank = (need: LicenceNeed): number => LICENCE_NEEDS.indexOf(need);
  gaps.sort(
    (a, b) =>
      compare(a.warehouseId, b.warehouseId) ||
      compare(a.holder === 'site' ? '' : (a.clientId ?? ''), b.holder === 'site' ? '' : (b.clientId ?? '')) ||
      needRank(a.need) - needRank(b.need),
  );
  return { asOfDate, gaps };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
