import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { InboundModule } from '../inbound/inbound.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OutboundModule } from '../outbound/outbound.module';
import { BillingFacade } from './billing.facade';
import { MeteringService } from './metering';
import { RateCardCommand } from './rate-card.command';
import { StorageSnapshotService } from './storage-snapshot';

/**
 * Billing module (story 21-3 stands it up with rate cards; story 21-4 adds
 * metering and the daily storage snapshots; client invoices 21-5 join it).
 * Owns `rate_cards`, `rate_card_lines`, `storage_snapshots` and
 * `storage_snapshot_progress` exclusively. Reads the client entity only
 * through `clients.facade.ts` (and locks its row there for the dated
 * transitions), and the ledger, the GRN lines and the picks only through the
 * inventory, inbound and outbound facades (AD-6) — it writes no other
 * module's table. Exposes its reads through `BillingFacade` / the file-level
 * `…InTx` functions in `billing.facade.ts`. (Inventory, inbound and outbound
 * import nothing back, so there is no cycle.)
 */
@Module({
  imports: [SharedModule, InventoryModule, InboundModule, OutboundModule],
  providers: [RateCardCommand, BillingFacade, MeteringService, StorageSnapshotService],
  exports: [RateCardCommand, BillingFacade],
})
export class BillingModule {}
