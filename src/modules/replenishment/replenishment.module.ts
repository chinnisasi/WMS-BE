import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InboundModule } from '../inbound/inbound.module';
import { ReplenishmentCommand } from './replenishment.command';
import { ReplenishmentSweep } from './replenishment.sweep';
import { ReplenishmentFacade } from './replenishment.facade';

/**
 * Replenishment module (story 6.1 — the spine placeholder populated): owns
 * `reorder_policies`, `reorder_breaches`, and `suggested_pos` (FR-22's
 * reorder points, breach alerts, and suggested POs). It is a CONSUMER of
 * derived state, never a second balance book — ATP is read only through the
 * inventory facade, the tenant-wide SKU defaults only through the catalog
 * facade, and the real PO only through the inbound facade's in-tx mint
 * (the submit arm). Commands on `ReplenishmentCommand`, the worker's sweep on
 * `ReplenishmentSweep`, everything else through `ReplenishmentFacade` — the
 * seam the architecture test pins.
 */
@Module({
  imports: [SharedModule, InventoryModule, CatalogModule, InboundModule],
  providers: [ReplenishmentCommand, ReplenishmentSweep, ReplenishmentFacade],
  exports: [ReplenishmentFacade],
})
export class ReplenishmentModule {}
