import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { warehouses } from '../../shared/db/schema';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { withTenantTransaction } from './tenant-scope';

/** What other modules get from the tenancy spine (module boundary — AD-6). */
export interface ActiveWarehouse {
  readonly warehouseId: string;
  readonly code: string;
  readonly name: string;
}

export const DEFAULT_WAREHOUSE_PAGE_SIZE = 50;
export const MAX_WAREHOUSE_PAGE_SIZE = 200;

/**
 * Tenancy facade for other spine modules and the api shell. Modules never
 * touch tenancy tables directly — they call this service (or consume its
 * domain events).
 */
@Injectable()
export class TenancyService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Zero-warehouse invariant guard (consumed by Epic 2 stock-record
   * creation): a tenant with zero warehouses cannot create stock records —
   * no orphan inventory.
   */
  async requireActiveWarehouse(tenantId: string): Promise<ActiveWarehouse> {
    const rows = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select({
          warehouseId: warehouses.id,
          code: warehouses.code,
          name: warehouses.name,
        })
        .from(warehouses)
        .where(eq(warehouses.tenantId, tenantId))
        .orderBy(desc(warehouses.createdAt), desc(warehouses.id))
        .limit(1),
    );
    const active = rows[0];
    if (!active) {
      throw new ProblemException(
        'no-active-warehouse',
        422,
        'Tenant has no active warehouse',
        'Create a warehouse before recording stock — no stock record may exist without one.',
      );
    }
    return active;
  }

  /**
   * Warehouses for the web switcher: cursor-paginated (opaque keyset on
   * created_at + id — offset pagination is banned), tenant-scoped on both
   * the app path and the RLS session setting.
   */
  async listWarehouses(
    tenantId: string,
    cursor?: string,
    limit: number = DEFAULT_WAREHOUSE_PAGE_SIZE,
  ): Promise<
    Page<{ id: string; tenantId: string; code: string; name: string; createdAt: string }>
  > {
    const pageSize = Math.min(Math.max(Math.trunc(limit) || DEFAULT_WAREHOUSE_PAGE_SIZE, 1), MAX_WAREHOUSE_PAGE_SIZE);
    const before = cursor === undefined ? undefined : decodeCursorSafe(cursor);
    const rows = await withTenantTransaction(this.db, tenantId, (tx) => {
      const scope = eq(warehouses.tenantId, tenantId);
      const query = tx
        .select({
          id: warehouses.id,
          tenantId: warehouses.tenantId,
          code: warehouses.code,
          name: warehouses.name,
          createdAt: warehouses.createdAt,
        })
        .from(warehouses)
        .where(
          before
            ? and(
                scope,
                sql`(${warehouses.createdAt}, ${warehouses.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
              )
            : scope,
        )
        .orderBy(desc(warehouses.createdAt), desc(warehouses.id))
        .limit(pageSize + 1);
      return query;
    });
    const page = buildPage(rows, pageSize);
    return { items: page.items, nextCursor: page.nextCursor };
  }
}

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    return decodeCursor(cursor);
  } catch {
    throw new ProblemException(
      'invalid-cursor',
      400,
      'Malformed pagination cursor',
      'The cursor parameter is not a valid opaque page cursor.',
    );
  }
}