import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { InboundModule } from '../inbound/inbound.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OutboundModule } from '../outbound/outbound.module';
import { InvoicingModule } from '../invoicing/invoicing.module';
import { BillingFacade } from './billing.facade';
import { ClientInvoiceService } from './client-invoices';
import { InvoiceRecordsService } from './invoice-records';
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
 *
 * Story 21-5 adds the client invoices (`client_invoices`,
 * `client_invoice_lines`, `client_invoice_series` — `ClientInvoiceService`):
 * it imports `InvoicingModule` for TWO facade reads only (the per-GSTIN
 * e-invoicing flag and the CBIC state-code list — invoicing imports nothing
 * back) and reads the supplier facts through tenancy's in-tx seam.
 *
 * Story 21-5b adds the dispute drill-down (`InvoiceRecordsService`): a line's
 * records through the inbound, outbound and inventory facades' row reads
 * (beside their counts, on the same predicates), the actors' emails through
 * tenancy's in-tx seam, and its own storage snapshots.
 */
@Module({
  imports: [SharedModule, InventoryModule, InboundModule, OutboundModule, InvoicingModule],
  providers: [RateCardCommand, BillingFacade, MeteringService, StorageSnapshotService, ClientInvoiceService, InvoiceRecordsService],
  exports: [RateCardCommand, BillingFacade, ClientInvoiceService, InvoiceRecordsService],
})
export class BillingModule {}
