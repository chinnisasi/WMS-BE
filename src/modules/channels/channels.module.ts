import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OutboundModule } from '../outbound/outbound.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ChannelsCommandService } from './channels.command';
import { ChannelsFacade } from './channels.facade';
import { ChannelsIngestCommand } from './channels.ingest.command';
import { ChannelsPublishService } from './channels.publish';
import { ChannelAvailabilityDelivery } from './channel-availability.delivery';
import { ChannelWritebackDelivery } from './channel-writeback.delivery';

/**
 * Channels module (Story 7-1) — the sales-channel substrate: the adapter
 * registry (frozen provider set), the credential vault (`integrations`,
 * module-exclusive), the external-reference mappings (`channel_mappings`),
 * the standing buffers (NOT a table here — the inventory core's reservation
 * rows, reached through the inventory facade only), the availability-sync
 * publication through the transactional outbox, the delivery handler, and
 * the metering/breaker stamps.
 *
 * Ownership discipline (architecture spine): this module exclusively owns
 * `integrations`, `channel_mappings` and `integration_calls` and publishes
 * domain events. Other modules communicate with it only through
 * `ChannelsFacade` and events — never its tables. The inventory core owns
 * `reservations` writes: a standing buffer is a held row reached through
 * `InventoryFacade.applyChannelBuffer` / `releaseReservationInTx` (AD-13,
 * RN-1), and the sync's per-scope visible quantities are the core's
 * committed reads through `channelVisibleQuantity` (RN-6) — the sync
 * delivers, never computes.
 *
 * Imports: SharedModule (DATABASE, OUTBOX_SINK, EVENT_BUS) + the sibling
 * facades' modules (inventory, catalog, tenancy — one-way, no back-edges).
 * Story 7.2 adds `OutboundModule` (the ingest command resolves its facade —
 * the ONE order path; outbound imports nothing from channels, so the edge
 * stays one-way). `ChannelsFacade` is exported ALONE (the architecture test
 * fails any sibling that reaches past it, AD-6): the jobs shell's sync
 * worker and the api shell's controller consume it.
 */
@Module({
  imports: [SharedModule, InventoryModule, CatalogModule, OutboundModule, TenancyModule],
  providers: [
    ChannelsCommandService,
    ChannelsPublishService,
    ChannelsFacade,
    ChannelsIngestCommand,
    ChannelAvailabilityDelivery,
    ChannelWritebackDelivery,
  ],
  exports: [ChannelsFacade],
})
export class ChannelsModule {}