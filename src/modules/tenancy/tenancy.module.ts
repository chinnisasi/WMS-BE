import { forwardRef, Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { InboundModule } from '../inbound/inbound.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MovementsModule } from '../movements/movements.module';
import { OutboundModule } from '../outbound/outbound.module';
import { PutawayModule } from '../putaway/putaway.module';
import { BinCommand } from './bin.command';
import { DeviceSessionGuard } from './device-session.guard';
import { EnrollmentCommand } from './enrollment.command';
import { RegistrationCommand } from './registration.command';
import { SignInCommand } from './sign-in.command';
import { SyncReportCommand } from './sync-report.command';
import { TenancyController } from './tenancy.controller';
import { TenancyService } from './tenancy.service';
import { TenantSessionGuard } from './tenant-session.guard';
import { UsersController } from './users.controller';
import { UsersCommand } from './users.command';
import { WarehouseCommand } from './warehouse.command';
import { ZoneCommand } from './zone.command';

/**
 * Tenancy module — tenants, users, warehouses, zones, bins, idempotency keys
 * (spine AD-6). `zones`/`bins` are the first warehouse-scoped tables
 * (`warehouse_id` alongside `tenant_id`); warehouse ownership is app-layer
 * (`assertWarehouseInTenant`), RLS stays single-dimension.
 *
 * Ownership discipline (architecture spine): this module exclusively owns
 * its tables and publishes domain events. Other modules communicate with it
 * only through its public interfaces and events — never its tables. The
 * exported facade is the command layer other stories consume (AD-10):
 * `TenancyService.requireActiveWarehouse` is the zero-warehouse invariant
 * guard for stock-record creation (Epic 2).
 *
 * Story 3.6 composition (one-way, no back-edges): the bin administration
 * commands consume the re-homed `BinStateCommand` (putaway owns bin
 * operational state) and the `InventoryFacade` (the ledger passthrough for
 * the merge movements) — both one-way imports.
 */
@Module({
  // forwardRef: catalog commands resolve the caller's role through the
  // TenancyService facade (Story 1.5), while this module consumes the
  // CatalogFacade for the checklist — one two-way spine dependency. Story
  // 5-6 adds the second: MovementsModule consumes TenancyModule (its
  // commands' entry reads), while the SyncReportCommand's AD-14 arms
  // re-execute the reported ops through the owning modules' facades
  // (inbound/putaway/outbound/compliance/movements — each exports only its
  // facade; Inbound/Outbound/Compliance/Movements are all in the tenancy
  // cycle now, wrapped forwardRef so no decorator touches a loading binding).
  imports: [
    SharedModule,
    forwardRef(() => CatalogModule),
    PutawayModule,
    InventoryModule,
    forwardRef(() => InboundModule),
    forwardRef(() => OutboundModule),
    forwardRef(() => ComplianceModule),
    forwardRef(() => MovementsModule),
  ],
  controllers: [TenancyController, UsersController],
  providers: [
    RegistrationCommand,
    SignInCommand,
    WarehouseCommand,
    ZoneCommand,
    BinCommand,
    UsersCommand,
    EnrollmentCommand,
    SyncReportCommand,
    TenancyService,
    TenantSessionGuard,
    DeviceSessionGuard,
  ],
  exports: [TenancyService, EnrollmentCommand, SyncReportCommand],
})
export class TenancyModule {}
