import { forwardRef, Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CatalogController } from './catalog.controller';
import { CatalogFacade } from './catalog.facade';
import { ImportCommand } from './import.command';
import { SkuCommand } from './sku.command';

/**
 * Catalog module (Story 1.4) — SKUs, UoM conversions, import runs, import
 * errors. Ownership discipline (architecture spine): this module exclusively
 * owns its tables (`skus`, `uom_conversions`, `catalog_imports`,
 * `catalog_import_errors`) and publishes domain events. Other modules
 * communicate with it only through the facade and events — never its tables.
 *
 * The exported surface is the facade only: `TenancyModule` imports this
 * module so the setup checklist can read `CatalogFacade.getImportSummary`
 * (catalog step done when ≥ 1 SKU exists, honest detail). The EVENT_BUS token
 * is shared infrastructure provided by `SharedModule` (moved there in 1.4 —
 * catalog is the first cross-module event emitter).
 *
 * Story 1.5: the gating direction is the reverse — catalog commands read the
 * caller's role through the `TenancyService.getMemberRole` facade (catalog
 * never touches tenancy tables). That creates the first two-way module
 * dependency, wired with `forwardRef` on both sides (Nest's documented cycle
 * escape; both providers resolve through proxies at request time).
 */
@Module({
  imports: [SharedModule, forwardRef(() => TenancyModule)],
  controllers: [CatalogController],
  providers: [ImportCommand, SkuCommand, CatalogFacade],
  exports: [CatalogFacade],
})
export class CatalogModule {}