import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrderCommandService } from './order.command';
import { OutboundFacade } from './outbound.facade';

/**
 * Outbound module (Story 4.1): the order aggregate and its state machine —
 * manual order entry and (adapter-ready) idempotent ingestion through ONE
 * create path, acceptance reserving ATP per line through Epic 2's
 * reservation machinery, cancellation releasing every open hold. `orders`
 * and `order_lines` are module-exclusive; the only stock truth stays the
 * inventory module's reservation journal (this module writes no stock
 * tables, no ledger events — the holds ride `InventoryFacade`).
 *
 * Imports `SharedModule` (the spine primitives — DATABASE, OUTBOX_SINK) and
 * `InventoryModule` (it exports only its facade; it imports nothing back
 * into outbound, so no cycle). The tenancy helpers the command uses at
 * entry (`assertPermission`, `getMemberRoleIn`, `assertWarehouseInTenant`)
 * are the shared command-entry pattern's file-level functions.
 */
@Module({
  imports: [SharedModule, InventoryModule],
  providers: [OrderCommandService, OutboundFacade],
  exports: [OutboundFacade],
})
export class OutboundModule {}