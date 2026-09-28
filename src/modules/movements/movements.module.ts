import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { InventoryModule } from '../inventory/inventory.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CountService } from './count.command';
import { TransferService } from './transfer.command';
import { MovementsFacade } from './transfer.facade';

/**
 * Movements module — the cross-warehouse stock-motion spine (Story 5-1, the
 * module's first occupant: Transfer Orders).
 *
 * Ownership discipline (architecture spine): this module exclusively owns
 * its tables (`transfer_orders`, `transfer_order_lines`) and publishes domain
 * events. Other modules communicate with it only through `MovementsFacade` —
 * never its tables. It writes NO stock table itself: every leg is a ledger
 * event appended through the inventory facade's in-transaction passthroughs
 * (`appendLedgerEventInTx`), so the ledger stays the PROJECTION_OWNER and the
 * hash chain carries the transfer legs like every other movement.
 *
 * Imports `InventoryModule` (the facade one-way — inventory imports nothing
 * back) and `TenancyModule` (the session guards the api shell composes with
 * the controller). Exports ONLY the facade.
 */
@Module({
  imports: [SharedModule, InventoryModule, TenancyModule],
  providers: [TransferService, CountService, MovementsFacade],
  exports: [MovementsFacade],
})
export class MovementsModule {}