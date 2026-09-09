import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { VendorCommand } from './vendors.command';
import { PurchaseOrderCommand } from './po.command';
import { InboundFacade } from './inbound.facade';

/**
 * Inbound module (Story 3.1): vendor master data and the purchase-order
 * lifecycle — the upstream half of receiving. `vendors`,
 * `purchase_orders`, and `purchase_order_lines` are module-exclusive; the
 * only stock truth stays the inventory module's ledger (a PO is not stock —
 * this module writes no ledger events, no stock tables).
 *
 * Imports `SharedModule` only (the spine primitives — DATABASE, OUTBOX_SINK —
 * and nothing else); the tenancy helpers the commands use at entry
 * (`assertPermission`, `getMemberRoleIn`, `assertWarehouseInTenant`) are the
 * shared command-entry pattern's file-level functions.
 */
@Module({
  imports: [SharedModule],
  providers: [VendorCommand, PurchaseOrderCommand, InboundFacade],
  exports: [InboundFacade],
})
export class InboundModule {}