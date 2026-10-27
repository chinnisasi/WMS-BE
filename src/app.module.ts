import { Module } from '@nestjs/common';
import { ApiModule } from './api/api.module';
import { SharedModule } from './shared/shared.module';
import { BillingModule } from './modules/billing/billing.module';
import { CarriersModule } from './modules/carriers/carriers.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ClientsModule } from './modules/clients/clients.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { InboundModule } from './modules/inbound/inbound.module';
import { InvoicingModule } from './modules/invoicing/invoicing.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { MovementsModule } from './modules/movements/movements.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { MailModule } from './modules/mail/mail.module';
import { OutboundModule } from './modules/outbound/outbound.module';
import { PartnersModule } from './modules/partners/partners.module';
import { PutawayModule } from './modules/putaway/putaway.module';
import { ReplenishmentModule } from './modules/replenishment/replenishment.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { ClientWebhooksModule } from './modules/client-webhooks/client-webhooks.module';
import { RecallsModule } from './modules/recalls/recalls.module';
import { JobsModule } from './jobs/jobs.module';

/**
 * Root of the modular monolith: the api shell, the jobs shell, and the 13
 * spine modules (ARCHITECTURE-SPINE.md §Structural Seed). Modules own their
 * tables exclusively and communicate only through interfaces and domain
 * events.
 *
 * Import order matters: spine modules register their routes before the api
 * shell, whose NotFoundController catch-all (`{*path}`) must map last.
 */
@Module({
  imports: [
    SharedModule,
    TenancyModule,
    ClientsModule,
    BillingModule,
    CatalogModule,
    InventoryModule,
    // Story 1-3 — the business partner master (before inbound, whose PO guard reads it).
    PartnersModule,
    InboundModule,
    PutawayModule,
    OutboundModule,
    InvoicingModule,
    MovementsModule,
    ReplenishmentModule,
    ChannelsModule,
    ComplianceModule,
    CarriersModule,
    NotificationsModule,
    // Story 5-1a — the email queue and its sender.
    MailModule,
    // Story 3-7a — the batch recall (before reporting, which reads it).
    RecallsModule,
    ReportingModule,
    // Story 13-1 — return authorizations (Epic 13's first module).
    ReturnsModule,
    // Story 5-2a — client webhooks (the queue, the sender, the staff surface).
    ClientWebhooksModule,
    JobsModule,
    ApiModule,
  ],
})
export class AppModule {}
