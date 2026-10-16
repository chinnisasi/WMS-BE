import { forwardRef, Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OutboundModule } from '../outbound/outbound.module';
import { ReturnAuthorizationCommand } from './return-authorization.command';
import { ReturnReceiptCommand } from './return-receipt.command';
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
 * Story 13-2 adds `ReturnReceiptCommand` (`return.receive`, the device op) and
 * two more tables it owns exclusively (`return_receipts`,
 * `return_receipt_lines`). It reaches tenancy only through tenancy's exported
 * in-transaction helpers — the device and role guard, the RETURNS bin
 * ensure, the server-raised review row, the user emails — and inventory's
 * ledger and catalog's handling units only through their facades. Tenancy
 * never imports returns.
 *
 * Exports only its facade. Nothing imports this module back but the api shell
 * and the root composition, so there is no cycle. `forwardRef(catalog)`: the
 * catalog ↔ tenancy pattern every catalog importer follows.
 */
@Module({
  imports: [SharedModule, OutboundModule, InventoryModule, forwardRef(() => CatalogModule)],
  providers: [ReturnAuthorizationCommand, ReturnReceiptCommand, ReturnsFacade],
  exports: [ReturnsFacade],
})
export class ReturnsModule {}
