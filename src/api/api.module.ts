import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { EchoController } from './echo.controller';
import { InventoryController } from './inventory.controller';
import { OpenApiController } from './openapi.controller';
import { NotFoundController } from './not-found.controller';
import { OpenApiDocumentHolder } from './openapi-document.holder';
import { InventoryModule } from '../modules/inventory/inventory.module';
import { CatalogModule } from '../modules/catalog/catalog.module';
import { TenancyModule } from '../modules/tenancy/tenancy.module';

/**
 * api shell: the only HTTP surface of the monolith. Story 1.1 exposes
 * health, echo, and the versioned OpenAPI document — nothing else.
 * Story 2.1 wires the inventory surface (adjustment command + event
 * timeline read) here; stock state is consumed only through
 * `InventoryFacade`.
 *
 * Story 2.4: the adjustment's batch/serial arms compose cross-facade at the
 * api layer (AD-6 — inventory imports nothing cross-module), so the shell
 * also imports `CatalogModule` (batch/serial identity ensure + expiry) and
 * `TenancyModule` (the fail-closed capability assert that must run BEFORE
 * any identity creation). Both modules are spine-singletons already imported
 * by the root — no new module instances, no duplicate routes.
 */
@Module({
  imports: [InventoryModule, CatalogModule, TenancyModule],
  controllers: [
    HealthController,
    EchoController,
    InventoryController,
    OpenApiController,
    NotFoundController,
  ],
  providers: [OpenApiDocumentHolder],
})
export class ApiModule {}
