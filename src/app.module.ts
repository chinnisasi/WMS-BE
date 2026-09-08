import { Module } from '@nestjs/common';
import { ApiModule } from './api/api.module';
import { SharedModule } from './shared/shared.module';
import { CarriersModule } from './modules/carriers/carriers.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { InboundModule } from './modules/inbound/inbound.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { MovementsModule } from './modules/movements/movements.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OutboundModule } from './modules/outbound/outbound.module';
import { PutawayModule } from './modules/putaway/putaway.module';
import { ReplenishmentModule } from './modules/replenishment/replenishment.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
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
    CatalogModule,
    InventoryModule,
    InboundModule,
    PutawayModule,
    OutboundModule,
    MovementsModule,
    ReplenishmentModule,
    ChannelsModule,
    ComplianceModule,
    CarriersModule,
    NotificationsModule,
    ReportingModule,
    JobsModule,
    ApiModule,
  ],
})
export class AppModule {}
