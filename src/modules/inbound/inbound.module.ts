import { forwardRef, Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { ReceiptPhotoCommand } from './receipt-photo.command';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PutawayModule } from '../putaway/putaway.module';
import { PartnersModule } from '../partners/partners.module';
import { PurchaseOrderCommand } from './po.command';
import { AsnCommand } from './asn.command';
import { AsnImportCommand } from './asn-import.command';
import { InboundFacade } from './inbound.facade';
import { ReceivingCommand } from './receiving.command';
import { ReceivingFacade } from './receiving.facade';
import { QcCommand } from './qc.command';
import { QcFacade } from './qc.facade';
import { GateInCommand } from './gate-in.command';
import { GateInFacade } from './gate-in.facade';

/**
 * Inbound module (Story 3.1): the purchase-order lifecycle — the upstream
 * half of receiving. Story 1-3 moved the vendor master data to the partners
 * module (`business_partners`, read here only through `partners.facade.ts`).
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
// forwardRef(catalog): story 5-6 made TenancyModule import this module (the
// sync-report apply arm), closing a third catalog → tenancy → inbound →
// catalog cycle; the decorator must not touch the loading binding eagerly
// (the catalog↔tenancy pattern).
@Module({
  // Story 2-5a — AttachmentsModule (the file store, the sanitizer, the
  // records seam): it imports no sibling module, so no cycle.
  imports: [SharedModule, forwardRef(() => CatalogModule), InventoryModule, PutawayModule, PartnersModule, AttachmentsModule],
  providers: [
    PurchaseOrderCommand,
    // Story 21-6 — the advance shipment notice lifecycle.
    AsnCommand,
    // The ASN import (2026-10-17) — the shared ASN checks, per group of a file.
    AsnImportCommand,
    InboundFacade,
    ReceivingCommand,
    ReceivingFacade,
    QcCommand,
    QcFacade,
    // Story 2-3a — the gate-in (an inbound vehicle visit).
    GateInCommand,
    GateInFacade,
    // Story 2-5a — damage photos on a receipt line.
    ReceiptPhotoCommand,
  ],
  exports: [InboundFacade, ReceivingFacade, QcFacade, GateInFacade],
})
export class InboundModule {}
