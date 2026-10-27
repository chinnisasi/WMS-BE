import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InboundModule } from '../inbound/inbound.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OutboundModule } from '../outbound/outbound.module';
import { RecallsModule } from '../recalls/recalls.module';
import { ReportingFacade } from './reporting.facade';

/**
 * Reporting module (story 9-1): the operational dashboard's read model.
 *
 * Owns NO tables. Its tiles read the owning modules' tables directly,
 * read-only — decision 6, the one named exception to AD-6's facade rule,
 * guarded by `test/architecture.spec.ts` (reporting writes nothing; nothing
 * but the api shell imports it). See `kpis.ts` for the exception's terms.
 * The audit trail and exports (9-3) join this module later.
 *
 * Story 5-3a — the operational registers are NOT a read-model exception:
 * they read through the owning modules' facades, so this module imports
 * inventory, inbound, outbound and catalog (nothing imports reporting back,
 * so no forward reference is needed).
 *
 * Story 3-7a — the batch recall's detail, trace and report read the recall
 * document through `RecallsFacade` (recalls imports nothing back).
 */
@Module({
  imports: [SharedModule, InventoryModule, InboundModule, OutboundModule, CatalogModule, RecallsModule],
  providers: [ReportingFacade],
  exports: [ReportingFacade],
})
export class ReportingModule {}
