import { forwardRef, Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CatalogModule } from '../catalog/catalog.module';
import { BinCommand } from './bin.command';
import { DeviceSessionGuard } from './device-session.guard';
import { EnrollmentCommand } from './enrollment.command';
import { RegistrationCommand } from './registration.command';
import { SignInCommand } from './sign-in.command';
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
 */
@Module({
  // forwardRef: catalog commands resolve the caller's role through the
  // TenancyService facade (Story 1.5), while this module consumes the
  // CatalogFacade for the checklist — the only two-way spine dependency.
  imports: [SharedModule, forwardRef(() => CatalogModule)],
  controllers: [TenancyController, UsersController],
  providers: [
    RegistrationCommand,
    SignInCommand,
    WarehouseCommand,
    ZoneCommand,
    BinCommand,
    UsersCommand,
    EnrollmentCommand,
    TenancyService,
    TenantSessionGuard,
    DeviceSessionGuard,
  ],
  exports: [TenancyService, EnrollmentCommand],
})
export class TenancyModule {}