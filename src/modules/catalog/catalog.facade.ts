import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import { catalogImports, skus } from '../../shared/db/schema';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { ImportMode } from './import.command';

/** What other modules get from the catalog module (module boundary — AD-6). */
export interface CatalogImportSummary {
  readonly skuCount: number;
  readonly lastImport: {
    readonly id: string;
    readonly mode: ImportMode;
    readonly committedRows: number;
    readonly failedRows: number;
    readonly skippedRows: number;
    readonly createdAt: string;
  } | null;
}

/**
 * Catalog facade for the tenancy spine's setup checklist (Story 1.4): the
 * only cross-module surface — catalog tables stay module-exclusive. The
 * summary is read in one tenant-scoped transaction: the SKU count decides the
 * checklist's catalog step, the latest run's counts make the detail honest
 * ("last import X committed, Y failed").
 */
@Injectable()
export class CatalogFacade {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getImportSummary(tenantId: string): Promise<CatalogImportSummary> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const skuRows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(skus)
        .where(eq(skus.tenantId, tenantId));
      const lastRows = await tx
        .select({
          id: catalogImports.id,
          mode: catalogImports.mode,
          committedRows: catalogImports.committedRows,
          failedRows: catalogImports.failedRows,
          skippedRows: catalogImports.skippedRows,
          createdAt: catalogImports.createdAt,
        })
        .from(catalogImports)
        .where(eq(catalogImports.tenantId, tenantId))
        .orderBy(desc(catalogImports.createdAt), desc(catalogImports.id))
        .limit(1);
      const last = lastRows[0];
      return {
        skuCount: skuRows[0]?.n ?? 0,
        lastImport: last
          ? {
              id: last.id,
              mode: last.mode as ImportMode,
              committedRows: last.committedRows,
              failedRows: last.failedRows,
              skippedRows: last.skippedRows,
              createdAt: last.createdAt,
            }
          : null,
      };
    });
  }
}