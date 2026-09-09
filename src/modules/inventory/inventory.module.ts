import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { ValkeyModule } from '../../shared/valkey/valkey.module';
import { LedgerService } from './ledger.service';
import { LEDGER_ANCHOR_STORE, PostgresLedgerAnchorStore } from './anchor-store';
import { InventoryFacade } from './inventory.facade';
import { StockAdjustmentCommand } from './inventory.command';
import { ReconciliationService } from './reconcile';
import { ReservationService } from './reservation.service';

/**
 * Inventory module — the append-only ledger core and its derived
 * quantities (Story 2.1). `ledger_events` is the only stock truth: every
 * movement is one immutable, hash-chained, registry-registered event
 * committed in the same transaction as its `stock_on_hand` projection.
 * Other modules communicate with it ONLY through the exported
 * `InventoryFacade` (and the domain events it publishes) — never its
 * tables; the architecture test (`test/architecture.spec.ts`) fails any
 * stock-table write from outside this module.
 *
 * Imports `SharedModule` only (the module depends on the spine
 * primitives — DATABASE, EVENT_BUS — and nothing else); the tenancy
 * helpers it uses at command entry (`assertPermission`,
 * `getMemberRoleIn`, `assertWarehouseInTenant`) are the shared
 * command-entry pattern's file-level functions.
 *
 * Outbox delivery is split to its own spec (deferred-work.md) — the
 * `LoggingEventBus` from SharedModule stays the delivery seam untouched.
 */
@Module({
  imports: [SharedModule, ValkeyModule],
  providers: [
    LedgerService,
    // The anchor target is a seam: this Postgres implementation appends to
    // `ledger_anchors` (append-only by the migration trigger); a real
    // external WORM store swaps in behind the interface.
    { provide: LEDGER_ANCHOR_STORE, useClass: PostgresLedgerAnchorStore },
    StockAdjustmentCommand,
    // Continuous replay-reconciliation (Story 2.2) — background work driven
    // by the jobs shell's `ReconciliationWorker` through the facade; no HTTP
    // surface.
    ReconciliationService,
    // Atomic reservations (Story 2.3) — grant/commit/release + ATP through
    // the pre-declared-keys Valkey scripts, journalled to Postgres; consumed
    // through the facade (reads become HTTP in 2.5, order wiring in Epic 4).
    ReservationService,
    InventoryFacade,
  ],
  exports: [InventoryFacade],
})
export class InventoryModule {}
