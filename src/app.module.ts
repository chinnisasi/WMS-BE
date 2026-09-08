import { Module } from '@nestjs/common';
import { ApiModule } from './api/api.module';
import { SharedModule } from './shared/shared.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { ConflictsModule } from './modules/conflicts/conflicts.module';
import { InboundModule } from './modules/inbound/inbound.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { MovesModule } from './modules/moves/moves.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OutboundModule } from './modules/outbound/outbound.module';
import { ReplenishmentModule } from './modules/replenishment/replenishment.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SettingsModule } from './modules/settings/settings.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { JobsModule } from './jobs/jobs.module';

/**
 * Root of the modular monolith: the api shell, the jobs shell, and the 13
 * spine modules. Modules own their tables exclusively and communicate only
 * through interfaces and domain events.
 */
@Module({
  imports: [
    SharedModule,
    ApiModule,
    JobsModule,
    TenancyModule,
    CatalogModule,
    InventoryModule,
    InboundModule,
    OutboundModule,
    MovesModule,
    ConflictsModule,
    ReplenishmentModule,
    ChannelsModule,
    ComplianceModule,
    NotificationsModule,
    ReportsModule,
    SettingsModule,
  ],
})
export class AppModule {}