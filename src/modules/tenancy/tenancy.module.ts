import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { EVENT_BUS, LoggingEventBus } from './event-bus';
import { RegistrationCommand } from './registration.command';
import { SignInCommand } from './sign-in.command';
import { TenancyController } from './tenancy.controller';
import { TenancyService } from './tenancy.service';
import { TenantSessionGuard } from './tenant-session.guard';
import { WarehouseCommand } from './warehouse.command';

/**
 * Tenancy module — tenants, users, warehouses, idempotency keys (spine AD-6).
 *
 * Ownership discipline (architecture spine): this module exclusively owns
 * its tables and publishes domain events. Other modules communicate with it
 * only through its public interfaces and events — never its tables. The
 * exported facade is the command layer other stories consume (AD-10):
 * `TenancyService.requireActiveWarehouse` is the zero-warehouse invariant
 * guard for stock-record creation (Epic 2).
 */
@Module({
  imports: [SharedModule],
  controllers: [TenancyController],
  providers: [
    { provide: EVENT_BUS, useClass: LoggingEventBus },
    RegistrationCommand,
    SignInCommand,
    WarehouseCommand,
    TenancyService,
    TenantSessionGuard,
  ],
  exports: [TenancyService],
})
export class TenancyModule {}