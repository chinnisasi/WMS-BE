import { forwardRef, Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { InboundModule } from '../inbound/inbound.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MovementsModule } from '../movements/movements.module';
import { OutboundModule } from '../outbound/outbound.module';
import { PutawayModule } from '../putaway/putaway.module';
import { AdjustmentSubmission } from './adjustment-submission';
import { AuditExportCommand } from './audit-export.command';
import { AuditExportRunner } from './audit-export.runner';
import { AUDIT_EXPORT_STORE, PostgresAuditExportStore } from './audit-export.store';
import { BinCommand } from './bin.command';
import { BinLabelsService } from './bin-labels';
import { DeviceSessionGuard } from './device-session.guard';
import { EnrollmentCommand } from './enrollment.command';
import { RegistrationCommand } from './registration.command';
import { SignInCommand } from './sign-in.command';
import { SecondFactorCommand } from './second-factor.command';
import { PasswordResetCommand } from './password-reset.command';
import { SessionCommand } from './session.command';
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
    SecondFactorCommand,
    PasswordResetCommand,
    SessionCommand,
    WarehouseCommand,
    ZoneCommand,
    BinCommand,
    // Story 2-10a — bin labels (a read: ZPL / PDF rendering).
    BinLabelsService,
    UsersCommand,
    EnrollmentCommand,
    SyncReportCommand,
    // Story 3-2b — the one stock-adjustment submission path (the HTTP route,
    // web or handheld, and the review queue's Apply of a `stock.adjust` op).
    AdjustmentSubmission,
    // Story 9-3b — the async audit export: the request command, the worker's
    // runner, and the file store port (Postgres until 9-3c's object storage).
    AuditExportCommand,
    AuditExportRunner,
    { provide: AUDIT_EXPORT_STORE, useClass: PostgresAuditExportStore },
    TenancyService,
    TenantSessionGuard,
    DeviceSessionGuard,
  ],
  exports: [TenancyService, EnrollmentCommand, SyncReportCommand, AdjustmentSubmission],
})
export class TenancyModule {}
