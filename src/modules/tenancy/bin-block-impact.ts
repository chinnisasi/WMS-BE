import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { bins } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
import { CatalogFacade } from '../catalog/catalog.facade';
import { getClientLabelsInTx } from '../clients/clients.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import { MovementsFacade } from '../movements/transfer.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import { binNotFound } from './bin.errors';
import { assertPermission } from './permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from './tenancy.service';

/** One client's share of a block's impact (A13). Base units. */
export interface BinBlockImpactClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly units: number;
  readonly skuCount: number;
  readonly plannedPickLines: number;
}

/** `GET …/bins/{binId}/block-impact` (decision 11, A13). Base units. */
export interface BinBlockImpact {
  readonly binId: string;
  readonly onHandUnits: number;
  readonly skuCount: number;
  readonly plannedPickLines: number;
  readonly plannedPickUnits: number;
  readonly openCountLines: number;
  readonly byClient: readonly BinBlockImpactClient[];
}

/**
 * Story 3-3b (decision 11, A13) — what blocking a bin would take out of
 * service: the on-hand that stops being promised, the planned pick stops
 * that will need a Skip and a re-plan, the open count lines, and per client
 * whose stock and storefronts the block hits.
 *
 * Composed from the owning modules' facade reads on ONE transaction —
 * inventory `stockArmsInBinsInTx`, outbound `plannedPickLinesInBinInTx`,
 * movements `openCountLinesInBinInTx`, catalog `skuClientIdsInTx` and the
 * clients labels. Advisory and read-only: the block itself is never refused
 * for open work. Gated on `bin.block` (the people who may block are the ones
 * who need the preview), authority first, before any 404.
 */
@Injectable()
export class BinBlockImpactService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(MovementsFacade) private readonly movements: MovementsFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  async impact(tenantId: string, actorUserId: string, warehouseId: string, binId: string): Promise<BinBlockImpact> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, actorUserId), 'bin.block');
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      if (!UUID_RE.test(binId)) throw binNotFound();
      const found = await tx
        .select({ id: bins.id })
        .from(bins)
        .where(and(eq(bins.tenantId, tenantId), eq(bins.warehouseId, warehouseId), eq(bins.id, binId)))
        .limit(1);
      if (found[0] === undefined) throw binNotFound();

      const [arms, planned, openCountLines] = [
        await this.inventory.stockArmsInBinsInTx(tx, tenantId, warehouseId, [binId]),
        await this.outbound.plannedPickLinesInBinInTx(tx, tenantId, binId),
        await this.movements.openCountLinesInBinInTx(tx, tenantId, warehouseId, binId),
      ];

      // Per SKU, in milli-units (one arm per batch — summed).
      const onHandBySku = new Map<string, number>();
      for (const arm of arms) onHandBySku.set(arm.skuId, (onHandBySku.get(arm.skuId) ?? 0) + Number(arm.quantity));
      const linesBySku = new Map(planned.map((row) => [row.skuId, row.lines] as const));

      const skuIds = [...new Set([...onHandBySku.keys(), ...linesBySku.keys()])];
      const clientBySku = await this.catalog.skuClientIdsInTx(tx, tenantId, skuIds);
      const labels = await getClientLabelsInTx(tx, tenantId, [...new Set(clientBySku.values())]);

      const perClient = new Map<string, { milli: number; skus: Set<string>; lines: number }>();
      const entry = (clientId: string) => {
        let row = perClient.get(clientId);
        if (row === undefined) {
          row = { milli: 0, skus: new Set(), lines: 0 };
          perClient.set(clientId, row);
        }
        return row;
      };
      for (const [skuId, milli] of onHandBySku) {
        const clientId = clientBySku.get(skuId);
        if (clientId === undefined) continue;
        const row = entry(clientId);
        row.milli += milli;
        row.skus.add(skuId);
      }
      for (const [skuId, lines] of linesBySku) {
        const clientId = clientBySku.get(skuId);
        if (clientId === undefined) continue;
        entry(clientId).lines += lines;
      }

      const byClient = [...perClient.entries()]
        .map(([clientId, row]) => ({
          clientId,
          clientName: labels.get(clientId) ?? clientId,
          units: fromMilli(row.milli),
          skuCount: row.skus.size,
          plannedPickLines: row.lines,
        }))
        .sort((a, b) => b.units - a.units || a.clientName.localeCompare(b.clientName) || a.clientId.localeCompare(b.clientId));

      const onHandMilli = [...onHandBySku.values()].reduce((sum, n) => sum + n, 0);
      return {
        binId,
        onHandUnits: fromMilli(onHandMilli),
        skuCount: onHandBySku.size,
        plannedPickLines: planned.reduce((sum, row) => sum + row.lines, 0),
        plannedPickUnits: fromMilli(planned.reduce((sum, row) => sum + row.units, 0)),
        openCountLines,
        byClient,
      };
    });
  }
}
