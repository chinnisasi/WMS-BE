import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InboundModule } from '../inbound/inbound.module';
import { ExcursionCommand } from './excursion.command';
import { ExcursionFacade } from './excursion.facade';

/**
 * Compliance module — temperature excursions (Story 12-5, FR-44): the
 * excursion command records a °C reading against a bin, quarantines every
 * affected (sku, bin) scope through the inbound module's ONE QC-hold
 * implementation (its extracted in-tx core), appends one ZERO-delta
 * `excursion.recorded` ledger event per affected scope through the inventory
 * facade, and owns the `temperature_excursions` review-queue table —
 * module-exclusive; the quarantine and the ledger both ride other modules'
 * facades (AD-6). `resolve` is a review-status flip (`review.decide`); stock
 * disposition stays the existing `qc.manage` release / `stock.adjust` verbs.
 *
 * Imports `SharedModule` (the spine primitives — DATABASE, OUTBOX_SINK) plus
 * `InventoryModule` and `InboundModule` (both export only their facades;
 * neither imports back into compliance, so no cycles).
 */
@Module({
  imports: [SharedModule, InventoryModule, InboundModule],
  providers: [ExcursionCommand, ExcursionFacade],
  exports: [ExcursionFacade],
})
export class ComplianceModule {}