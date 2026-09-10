import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { InventoryModule } from '../inventory/inventory.module';
import { BinStateCommand } from './bin-state.command';
import { PutawayCommand } from './putaway.command';
import { PutawayFacade } from './putaway.facade';

/**
 * Putaway module (Story 3.5): directed putaway — the placement command and
 * the derived-task/placement reads. `putaway_placements` is module-exclusive
 * (the placement decision record); the stock itself moves only through the
 * ledger (`putaway.placed` movements via the inventory facade — a placement
 * is one movement from the system Receiving bin to the target bin, never a
 * direct `stock_on_hand` write), and the from-bin identity is ensured
 * through tenancy's receiving-bin helper (bin master data stays
 * tenancy-owned, AD-6).
 *
 * Imports `SharedModule` (the spine primitives) and `InventoryModule` (its
 * facade exports the in-transaction ledger passthroughs; it imports nothing
 * back, so no cycles). The task derivation reads the GRN lines and the
 * Receiving-bin projections read-only — every mutation runs through the
 * command's own invariant order.
 *
 * Story 3.6: bin operational state is OWNED here — the `blocked` toggle
 * re-homes from the tenancy module into `BinStateCommand` (the tenancy
 * controller keeps the URL and delegates; the FE contract is unchanged).
 */
@Module({
  imports: [SharedModule, InventoryModule],
  providers: [BinStateCommand, PutawayCommand, PutawayFacade],
  exports: [PutawayFacade, BinStateCommand],
})
export class PutawayModule {}