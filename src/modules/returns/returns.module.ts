import { forwardRef, Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OutboundModule } from '../outbound/outbound.module';
import { ReturnAuthorizationCommand } from './return-authorization.command';
import { ReturnsFacade } from './returns.facade';

/**
 * Returns module (story 13-1, Epic 13 — the platform's first reverse flow).
 * Owns `return_authorizations` and `return_authorization_lines` exclusively
 * (pinned by `test/architecture.spec.ts`, which also pins that it reads no
 * sibling's table). It reads other modules ONLY through their facades: the
 * order facts through `OutboundFacade.orderInvoiceFactsInTx`, the order's
 * ledger events through `InventoryFacade.ledgerEventsByOrderRefInTx`, the SKU
 * facts and serial identities through `CatalogFacade`. 13-1 writes no ledger
 * event — an authorization moves no stock.
 *
 * Exports only its facade. Nothing imports this module back but the api shell
 * and the root composition, so there is no cycle. `forwardRef(catalog)`: the
 * catalog ↔ tenancy pattern every catalog importer follows.
 */
@Module({
  imports: [SharedModule, OutboundModule, InventoryModule, forwardRef(() => CatalogModule)],
  providers: [ReturnAuthorizationCommand, ReturnsFacade],
  exports: [ReturnsFacade],
})
export class ReturnsModule {}
