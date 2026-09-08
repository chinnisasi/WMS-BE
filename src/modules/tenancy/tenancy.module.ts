import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CatalogModule } from '../catalog/catalog.module';
import { BinCommand } from './bin.command';
import { RegistrationCommand } from './registration.command';
import { SignInCommand } from './sign-in.command';
import { TenancyController } from './tenancy.controller';
import { TenancyService } from './tenancy.service';
import { TenantSessionGuard } from './tenant-session.guard';
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
  imports: [SharedModule, CatalogModule],
  controllers: [TenancyController],
  providers: [
    RegistrationCommand,
    SignInCommand,
    WarehouseCommand,
    ZoneCommand,
    BinCommand,
    TenancyService,
    TenantSessionGuard,
  ],
  exports: [TenancyService],
})
export class TenancyModule {}