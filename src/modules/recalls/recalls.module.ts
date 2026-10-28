import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OutboundModule } from '../outbound/outbound.module';
import { RecallCommand } from './recall.command';
import { RecallsFacade } from './recalls.facade';

/**
 * Story 3-7a — the recalls module: the batch recall document
 * (`batch_recalls`, `batch_recall_lines` — written only here) and its
 * commands. It depends on the catalog (block / unblock, the batch locks),
 * inventory and outbound (the figures) facades, and on the clients and
 * tenancy file-level helpers; NOTHING imports this module back — catalog,
 * outbound and inbound read recall lines through the free-function seam
 * `open-recall-lines.ts` (guide §7h), and the clients status command
 * composes `client-wind-down.ts`. Exports only the facade.
 */
@Module({
  imports: [SharedModule, CatalogModule, InventoryModule, OutboundModule],
  providers: [RecallCommand, RecallsFacade],
  exports: [RecallsFacade],
})
export class RecallsModule {}
