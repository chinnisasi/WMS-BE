import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { OutboundModule } from '../outbound/outbound.module';
import { InvoicingCommand } from './command';
import { InvoiceDeliveryHandler } from './delivery';
import { InvoicingFacade } from './facade';
import { InvoiceGenerator } from './generator';

/**
 * The invoicing module (story 8-1): owns `invoices`, `invoice_lines`,
 * `invoice_series` (module-exclusive writes — the architecture spec's
 * write-regex list) and reads `gst_state_codes` (global, migration-seeded).
 *
 * Imports `OutboundModule` (ONLY its facade export — the dispatch facts
 * read one-way; invoicing writes no outbound table) and `SharedModule` (the
 * DATABASE, OUTBOX_SINK, EVENT_BUS primitives). The tenancy party facts
 * come through the tenancy service's in-tx functions imported directly (no
 * DI cycle — the order.command precedent).
 *
 * The `order.dispatched → invoice auto-generation` flow is wired THROUGH
 * the event bus: dispatch.command appends `order.dispatched` in-tx; the
 * relay drains it; `InvoiceDeliveryHandler` subscribes and generates. The
 * manual `invoice.generate` command is the operator's generate/regenerate,
 * exported (with the facade) for the api shell's `InvoicingController`.
 */
@Module({
  imports: [SharedModule, OutboundModule],
  providers: [InvoiceGenerator, InvoicingCommand, InvoiceDeliveryHandler, InvoicingFacade],
  exports: [InvoicingFacade, InvoicingCommand, InvoiceGenerator],
})
export class InvoicingModule {}