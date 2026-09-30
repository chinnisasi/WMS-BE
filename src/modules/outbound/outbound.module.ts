import { forwardRef, Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CarriersModule } from '../carriers/carriers.module';
import { OrderCommandService } from './order.command';
import { WaveCommandService } from './wave.command';
import { PickCommandService } from './pick.command';
import { PackCommandService } from './pack.command';
import { DispatchCommandService } from './dispatch.command';
import { ShipmentCommandService } from './shipment.command';
import { ManifestCommandService } from './manifest.command';
import { RateService } from './rate.service';
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
 *
 * Story 4.3 adds the pick command (`picks` — module-exclusive in the same
 * way). It is the module's FIRST stock-moving path: the `pick.picked` ledger
 * draw and the reservation's `held → committed` settlement commit in ONE
 * transaction through `InventoryFacade`'s in-tx passthroughs
 * (`appendLedgerEventInTx`, `lockSerialsInTx`, `commitReservationInTx`) — it
 * still writes no inventory table itself (AD-6). The batch a pick draws is
 * re-derived FEFO in the scanned bin through `CatalogFacade`.
 *
 * Story 4.5 adds the pack command. It writes no new table: the verification
 * is a read of `picklist_lines` (completeness) and `picks` (quantities), the
 * record is one zero-quantity `pack.packed` ledger event per order line
 * through `appendLedgerEventInTx`, and the only relational write is the
 * order's own `accepted → ready_to_dispatch` flip — a state machine this
 * module exclusively owns (AD-6).
 *
 * Story 4.6 adds the dispatch command — the state machine's TERMINAL
 * transition, and the story that closes Epic 2's open loop: besides the
 * `ready_to_dispatch → dispatched` flip and one zero-quantity
 * `dispatch.dispatched` event per order line, it retires every `committed`
 * hold the order still owns to `released` through
 * `retireCommittedReservationInTx`, which is what finally takes the shipped
 * units off the reserved counter and corrects ATP. It writes no new table and
 * no inventory table (AD-6); the Valkey mirror rides `restoreReservedUnits`
 * after the commit, journal-first (4.4's ordering).
 *
 * Story 4.6c adds the label + manifest commands and their tables
 * (`shipments`, `manifests` — module-exclusive). The label command generates
 * the adapter label through `CarriersFacade`'s IN-TX passthroughs
 * (`resolveConnectionInTx`, `openCredentialForAdapterUseInTx`) inside its own
 * transaction — the pool-nesting rule (never call a facade method that opens
 * its own transaction from inside a held one) — and the outbound module
 * imports NOTHING else from carriers (the facade-only import the
 * architecture guard pins). The manifest command closes labelled shipments
 * for one connection; the dispatch command auto-stamps a labelled
 * shipment's carrier/tracking when the caller sends no free text.
 *
 * Story 4.6d adds the rate-shopping READ (`rate.service.ts`): one quoted-or-
 * refused item per live carrier connection, aggregated from the order's
 * lines × the SKU catalog's weights, recomputed per request and never
 * stored. It reuses the same facade seam (`rateThroughAdapter`,
 * `openCredentialForAdapterUseInTx`) and enumerates the connections through
 * `listConnections` BEFORE its own transaction opens (the same rule).
 */
// forwardRef(catalog): story 5-6 made TenancyModule import this module (the
// sync-report apply arm), closing a catalog → tenancy → outbound → catalog
// cycle through compliance too; the decorator must not touch the loading
// binding eagerly (the catalog↔tenancy pattern).
@Module({
  imports: [SharedModule, InventoryModule, forwardRef(() => CatalogModule), CarriersModule],
  providers: [
    OrderCommandService,
    WaveCommandService,
    PickCommandService,
    PackCommandService,
    DispatchCommandService,
    ShipmentCommandService,
    ManifestCommandService,
    RateService,
    { provide: WAVE_CLOCK, useClass: SystemWaveClock },
    OutboundFacade,
  ],
  exports: [OutboundFacade],
})
export class OutboundModule {}
