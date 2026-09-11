import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CatalogModule } from '../catalog/catalog.module';
import { OrderCommandService } from './order.command';
import { WaveCommandService } from './wave.command';
import { WAVE_CLOCK, SystemWaveClock } from './wave.clock';
import { OutboundFacade } from './outbound.facade';

/**
 * Outbound module (Story 4.1): the order aggregate and its state machine —
 * manual order entry and (adapter-ready) idempotent ingestion through ONE
 * create path, acceptance reserving ATP per line through Epic 2's
 * reservation machinery, cancellation releasing every open hold. `orders`
 * and `order_lines` are module-exclusive; the only stock truth stays the
 * inventory module's reservation journal (this module writes no stock
 * tables, no ledger events — the holds ride `InventoryFacade`).
 *
 * Imports `SharedModule` (the spine primitives — DATABASE, OUTBOX_SINK) and
 * `InventoryModule` (it exports only its facade; it imports nothing back
 * into outbound, so no cycle). The tenancy helpers the command uses at
 * entry (`assertPermission`, `getMemberRoleIn`, `assertWarehouseInTenant`)
 * are the shared command-entry pattern's file-level functions.
 *
 * Story 4.2 adds the wave aggregate (`wave_policies`, `waves`, `picklists`,
 * `picklist_lines`) — module-exclusive in exactly the same way. The wave
 * planner composes per-bin / per-batch stock through `InventoryFacade` and
 * batch expiry through `CatalogFacade` (AD-6 — it writes neither module's
 * tables, and journals no pick movement: picking is 4.3). `CatalogModule`
 * imports `SharedModule` and `forwardRef(TenancyModule)` only, so this new
 * edge introduces no cycle. `WAVE_CLOCK` is the injectable "now" a policy
 * cutoff is compared against (the e2e suite stubs it on both sides of a
 * boundary rather than sleeping until 16:30 IST).
 */
@Module({
  imports: [SharedModule, InventoryModule, CatalogModule],
  providers: [
    OrderCommandService,
    WaveCommandService,
    { provide: WAVE_CLOCK, useClass: SystemWaveClock },
    OutboundFacade,
  ],
  exports: [OutboundFacade],
})
export class OutboundModule {}
