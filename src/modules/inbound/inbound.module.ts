import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PutawayModule } from '../putaway/putaway.module';
import { VendorCommand } from './vendors.command';
import { PurchaseOrderCommand } from './po.command';
import { InboundFacade } from './inbound.facade';
import { ReceivingCommand } from './receiving.command';
import { ReceivingFacade } from './receiving.facade';
import { QcCommand } from './qc.command';
import { QcFacade } from './qc.facade';

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
 *
 * Story 3.5 (additive): the device snapshot composes the putaway decision
 * fields (bins + derived putaway tasks) through `PutawayFacade` — the module
 * imports `PutawayModule` (it exports only its facade; it imports nothing
 * back into inbound, so still no cycles).
 *
 * Story 4.3 deliberately does NOT import `OutboundModule` for the snapshot's
 * `pickTasks`: the api shell composes that field across the two facades
 * instead (the AD-6 cross-facade-at-the-shell pattern story 2.4 established).
 * An inbound → outbound module edge buys nothing here and drags the whole
 * outbound graph into this module's initialization.
 */
@Module({
  imports: [SharedModule, CatalogModule, InventoryModule, PutawayModule],
  providers: [
    VendorCommand,
    PurchaseOrderCommand,
    InboundFacade,
    ReceivingCommand,
    ReceivingFacade,
    QcCommand,
    QcFacade,
  ],
  exports: [InboundFacade, ReceivingFacade, QcFacade],
})
export class InboundModule {}