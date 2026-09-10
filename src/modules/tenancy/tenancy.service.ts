import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { bins, users, warehouses, zones } from '../../shared/db/schema';
import type { UserRole } from '../../shared/db/schema';
// Constructor param is a type here but must stay a value import: Nest DI needs
// the runtime class token for decorator metadata (eslint rule bends for it).
 
import { CatalogFacade } from '../catalog/catalog.facade';
import type { Page } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';

/** What other modules get from the tenancy spine (module boundary — AD-6). */
export interface ActiveWarehouse {
  readonly warehouseId: string;
  readonly code: string;
  readonly name: string;
}

export const DEFAULT_WAREHOUSE_PAGE_SIZE = 50;
export const MAX_WAREHOUSE_PAGE_SIZE = 200;

export type ZoneRow = {
  id: string;
  tenantId: string;
  warehouseId: string;
  code: string;
  name: string;
  createdAt: string;
};

export type BinRow = {
  id: string;
  tenantId: string;
  warehouseId: string;
  zoneId: string;
  code: string;
  capacity: number;
  type: string;
  blocked: boolean;
  /** Story 3.6 — the retirement pair (null while the bin is live). */
  retiredAt: string | null;
  retiredBy: string | null;
  /** The Receiving/QC-hold system bins (never blockable/mergeable/retirable). */
  systemOwned: boolean;
  createdAt: string;
};

export type SetupChecklistStepKey = 'warehouse' | 'bins' | 'catalog' | 'users';

export interface SetupChecklistStep {
  readonly key: SetupChecklistStepKey;
  readonly label: string;
  readonly done: boolean;
  readonly detail: string;
  /** Deep link for the Continue affordance — `/settings` in this story. */
  readonly href: string;
}

export interface SetupChecklist {
  readonly steps: readonly SetupChecklistStep[];
}

/**
 * Warehouse ownership inside a command transaction (Story 1.3 — the new
 * warehouse-scoping pattern): the parent warehouse must exist **in this
 * tenant** before any zone/bin write. RLS already scopes to the tenant; this
 * catches a foreign or nonexistent warehouse as 404 `not-found` — warehouse
 * scoping is app-layer, RLS stays single-dimension (`tenant_isolation`).
 */
export async function assertWarehouseInTenant(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.id, warehouseId), eq(warehouses.tenantId, tenantId)))
    .limit(1);
  if (rows.length === 0) {
    throw warehouseNotFound();
  }
}

function warehouseNotFound(): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Warehouse not found',
    'No warehouse with this id exists in this tenant.',
  );
}

/**
 * The role of one tenant member, read **inside the caller's tenant
 * transaction** when `tx` is given (the command-service-entry pattern of
 * Story 1.5 — the DB read *is* the epoch, so a role change applies to the
 * user's next command without re-login). Without `tx`, its own tenant-scoped
 * transaction is opened. Catalog and other foreign modules call the
 * `TenancyService.getMemberRole` facade; they never touch tenancy tables.
 *
 * A missing member row fails closed: the caller has no role and no
 * capabilities (`role-denied` names it).
 */
export async function getMemberRoleIn(
  tx: TenantTx,
  tenantId: string,
  userId: string,
): Promise<UserRole> {
  const rows = await tx
    .select({ role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
    .limit(1);
  const role = rows[0]?.role;
  if (role === undefined) {
    throw new ProblemException(
      'role-denied',
      403,
      'Role lacks the required capability',
      'The caller is not a member of this tenant (role "none").',
    );
  }
  return role;
}

/**
 * Tenancy facade for other spine modules and the api shell. Modules never
 * touch tenancy tables directly — they call this service (or consume its
 * domain events).
 */
@Injectable()
export class TenancyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // forwardRef: the catalog module resolves TenancyService for its own
    // command-entry role lookups (Story 1.5) while this facade consumes the
    // CatalogFacade — the first two-way spine module dependency.
    @Inject(forwardRef(() => CatalogFacade))
    private readonly catalogFacade: CatalogFacade,
  ) {}

  /**
   * Role lookup for other modules' command services (Story 1.5 — the
   * facade-provided role read; foreign modules must not read tenancy
   * tables). Callers with their own tenant transaction pass it in so the
   * authority read shares the mutation's transaction; otherwise a fresh
   * tenant-scoped transaction is opened. See `getMemberRoleIn`.
   */
  async getMemberRole(tenantId: string, userId: string, tx?: TenantTx): Promise<UserRole> {
    if (tx) {
      return getMemberRoleIn(tx, tenantId, userId);
    }
    return withTenantTransaction(this.db, tenantId, (inner) =>
      getMemberRoleIn(inner, tenantId, userId),
    );
  }

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

  /**
   * Zones of one warehouse (Story 1.3): the warehouse must belong to the
   * tenant (404 otherwise), keyset cursor pagination on (created_at, id),
   * tenant-scoped on both the app path and the RLS session setting.
   */
  async listZones(
    tenantId: string,
    warehouseId: string,
    cursor?: string,
    limit: number = DEFAULT_WAREHOUSE_PAGE_SIZE,
  ): Promise<Page<ZoneRow>> {
    const pageSize = clampPageSize(limit);
    const before = cursor === undefined ? undefined : decodeCursorSafe(cursor);
    const rows = await withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const scope = and(eq(zones.tenantId, tenantId), eq(zones.warehouseId, warehouseId));
      return tx
        .select({
          id: zones.id,
          tenantId: zones.tenantId,
          warehouseId: zones.warehouseId,
          code: zones.code,
          name: zones.name,
          createdAt: zones.createdAt,
        })
        .from(zones)
        .where(
          before
            ? and(
                scope,
                sql`(${zones.createdAt}, ${zones.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
              )
            : scope,
        )
        .orderBy(desc(zones.createdAt), desc(zones.id))
        .limit(pageSize + 1);
    });
    const page = buildPage(rows, pageSize);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  /**
   * Bins of one zone (Story 1.3): the zone must belong to the warehouse
   * (404 otherwise), keyset cursor pagination on (created_at, id). Created
   * bins are immediately listed — no dormant state.
   */
  async listBins(
    tenantId: string,
    warehouseId: string,
    zoneId: string,
    cursor?: string,
    limit: number = DEFAULT_WAREHOUSE_PAGE_SIZE,
  ): Promise<Page<BinRow>> {
    const pageSize = clampPageSize(limit);
    const before = cursor === undefined ? undefined : decodeCursorSafe(cursor);
    const rows = await withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const scope = and(
        eq(bins.tenantId, tenantId),
        eq(bins.warehouseId, warehouseId),
        eq(bins.zoneId, zoneId),
      );
      return tx
        .select({
          id: bins.id,
          tenantId: bins.tenantId,
          warehouseId: bins.warehouseId,
          zoneId: bins.zoneId,
          code: bins.code,
          capacity: bins.capacity,
          type: bins.type,
          blocked: bins.blocked,
          // Story 3.6: retired bins STAY listed (the zone bin list is the
          // master-data view — the FE flags them with `retiredAt`; the
          // device snapshot is the surface that excludes them).
          retiredAt: bins.retiredAt,
          retiredBy: bins.retiredBy,
          systemOwned: bins.systemOwned,
          createdAt: bins.createdAt,
        })
        .from(bins)
        .where(
          before
            ? and(
                scope,
                sql`(${bins.createdAt}, ${bins.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
              )
            : scope,
        )
        .orderBy(desc(bins.createdAt), desc(bins.id))
        .limit(pageSize + 1);
    });
    const page = buildPage(rows, pageSize);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  /**
   * The per-tenant setup checklist (Story 1.3, catalog step wired to the
   * catalog facade in 1.4), **computed on read** — no stored step rows to go
   * stale: the flags derive from counts. Catalog aggregates through the
   * catalog module's facade (module tables stay exclusive); the users step
   * (Story 1.5) counts non-Owner users — invited or active, the team is
   * "invited" once at least one non-owner user exists.
   */
  async computeSetupChecklist(tenantId: string): Promise<SetupChecklist> {
    const counts = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const warehouseRows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(warehouses)
        .where(eq(warehouses.tenantId, tenantId));
      const binRows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(bins)
        .where(eq(bins.tenantId, tenantId));
      const memberRows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), ne(users.role, 'owner')));
      return {
        warehouses: warehouseRows[0]?.n ?? 0,
        bins: binRows[0]?.n ?? 0,
        members: memberRows[0]?.n ?? 0,
      };
    });
    const catalog = await this.catalogFacade.getImportSummary(tenantId);

    const warehouseDone = counts.warehouses >= 1;
    const binsDone = counts.bins >= 1;
    const catalogDone = catalog.skuCount >= 1;
    const usersDone = counts.members >= 1;
    const catalogDetail = catalogDone
      ? `Done · ${catalog.skuCount} SKUs · last import ${catalog.lastImport?.committedRows ?? 0} committed, ${catalog.lastImport?.failedRows ?? 0} failed`
      : catalog.lastImport !== null
        ? `Pending · 0 SKUs · last import ${catalog.lastImport.committedRows} committed, ${catalog.lastImport.failedRows} failed`
        : 'No SKUs yet — import your catalog below.';
    return {
      steps: [
        {
          key: 'warehouse',
          label: 'Create your first warehouse',
          done: warehouseDone,
          detail: warehouseDone
            ? `Done · ${counts.warehouses} warehouse${counts.warehouses === 1 ? '' : 's'} created`
            : 'No warehouses yet — create one below.',
          href: '/settings',
        },
        {
          key: 'bins',
          label: 'Define zones and bins',
          done: binsDone,
          detail: binsDone
            ? `Done · ${counts.bins} bin${counts.bins === 1 ? '' : 's'} defined`
            : 'No bins yet — generate a grid or add bins manually.',
          href: '/settings',
        },
        {
          key: 'catalog',
          label: 'Import your catalog',
          done: catalogDone,
          detail: catalogDetail,
          href: '/settings',
        },
        {
          key: 'users',
          label: 'Invite users and roles',
          done: usersDone,
          detail: usersDone
            ? `Done · ${counts.members} team member${counts.members === 1 ? '' : 's'} invited`
            : 'No team members yet — invite your first user below.',
          href: '/settings',
        },
      ],
    };
  }
}

function clampPageSize(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit) || DEFAULT_WAREHOUSE_PAGE_SIZE, 1), MAX_WAREHOUSE_PAGE_SIZE);
}

/**
 * The cursor is opaque to clients but crafted input is still possible — a
 * base64-valid payload with a non-uuid `id` would otherwise reach the
 * `::uuid` cast in SQL and surface as a 500 instead of a 400.
 */
function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  let decoded: { createdAt: string; id: string };
  try {
    decoded = decodeCursor(cursor);
  } catch {
    throw new ProblemException(
      'invalid-cursor',
      400,
      'Malformed pagination cursor',
      'The cursor parameter is not a valid opaque page cursor.',
    );
  }
  if (!UUID_RE.test(decoded.id) || Number.isNaN(Date.parse(decoded.createdAt))) {
    throw new ProblemException(
      'invalid-cursor',
      400,
      'Malformed pagination cursor',
      'The cursor parameter is not a valid opaque page cursor.',
    );
  }
  return decoded;
}