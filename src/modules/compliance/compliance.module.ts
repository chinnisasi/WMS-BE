import { forwardRef, Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InboundModule } from '../inbound/inbound.module';
import { OutboundModule } from '../outbound/outbound.module';
import { ExcursionCommand } from './excursion.command';
import { ExcursionFacade } from './excursion.facade';
import { ColdChainFacade } from './cold-chain.facade';
import { LicenceCommand } from './licence.command';
import { LicenceFacade } from './licence.facade';

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
 * Story 12-6 (FR-45) adds the cold-chain read: `ColdChainFacade` reconstructs
 * a dispatched order's storage trace from the ledger alone, composing the
 * inventory facade's ledger feeds with the outbound facade's order-identity
 * read — hence the `OutboundModule` import (it exports only its facade and
 * imports nothing back into compliance, so no cycle).
 *
 * Imports `SharedModule` (the spine primitives — DATABASE, OUTBOX_SINK) plus
 * `InventoryModule`, `InboundModule` and `OutboundModule` (all export only
 * their facades; none imports back into compliance directly — but story 5-6
 * made TenancyModule import this module (the sync-report apply arm), closing
 * catalog → tenancy → compliance → {inbound, outbound} → catalog cycles, so
 * the in-cycle imports are lazy decorators (the catalog↔tenancy pattern).
 *
 * Story 1-6c adds the drug and FSSAI licences: `LicenceFacade` (the master's
 * writes through `LicenceCommand`, the list, the coverage gaps and the expiry
 * sweep — exported for the api shell and the jobs shell's
 * `LicenceExpiryWorker`). It owns `licences` and READS the clients,
 * warehouses, SKU, stock and inbound-document tables directly — no new module
 * import (tenancy imports this module, so catalog or tenancy would cycle).
 */
@Module({
  imports: [SharedModule, InventoryModule, forwardRef(() => InboundModule), forwardRef(() => OutboundModule)],
  providers: [ExcursionCommand, ExcursionFacade, ColdChainFacade, LicenceCommand, LicenceFacade],
  exports: [ExcursionFacade, ColdChainFacade, LicenceFacade],
})
export class ComplianceModule {}
