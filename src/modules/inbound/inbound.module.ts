import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { VendorCommand } from './vendors.command';
import { PurchaseOrderCommand } from './po.command';
import { InboundFacade } from './inbound.facade';
import { ReceivingCommand } from './receiving.command';
import { ReceivingFacade } from './receiving.facade';

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
 *
 * Story 3.3 adds the receipt half: `goods_receipt_notes`, `goods_receipt_lines`,
 * and `over_receipts` are this module's tables. The `ReceivingCommand`
 * composes cross-module through the facades only (AD-6) — batch identity via
 * `CatalogFacade`, ledger events via `InventoryFacade` — so the module
 * imports `CatalogModule` and `InventoryModule` (both export only their
 * facades; neither imports back into inbound, so no cycles).
 */
@Module({
  imports: [SharedModule, CatalogModule, InventoryModule],
  providers: [VendorCommand, PurchaseOrderCommand, InboundFacade, ReceivingCommand, ReceivingFacade],
  exports: [InboundFacade, ReceivingFacade],
})
export class InboundModule {}