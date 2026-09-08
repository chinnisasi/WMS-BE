import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
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
 */
@Module({
  imports: [SharedModule],
  controllers: [CatalogController],
  providers: [ImportCommand, SkuCommand, CatalogFacade],
  exports: [CatalogFacade],
})
export class CatalogModule {}