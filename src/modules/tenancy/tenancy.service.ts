import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { bins, tenants, users, warehouses, zones } from '../../shared/db/schema';
import type { UserRole } from '../../shared/db/schema';
// Constructor param is a type here but must stay a value import: Nest DI needs
// the runtime class token for decorator metadata (eslint rule bends for it).
 
import { CatalogFacade } from '../catalog/catalog.facade';
import type { Page } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { addressFromColumns } from '../../shared/primitives/address';
import type { AddressSnapshot } from '../../shared/primitives/address';
import { fromMilli } from '../../shared/primitives/quantity';
import { GSTIN_RE, gstinPrefixProblem, normalizeGstinInput } from '../../shared/primitives/gstin';

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
  /** Story 11-5 — the optional physical capacity (raw integers, null = unconstrained). */
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  maxWeightGrams: number | null;
  /** Story 12-1 — the controlled-vocabulary storage class (FR-40). */
  storageClass: string;
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
/**
 * Story 21-4 — the member's client (AD-23 persona arm): null for the
 * tenant's own staff, set for a client-portal user. Null for an unknown
 * user too (the caller's role read refuses those).
 */
export async function getMemberClientIdIn(tx: TenantTx, tenantId: string, userId: string): Promise<string | null> {
  const rows = await tx
    .select({ clientId: users.clientId })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
    .limit(1);
  return rows[0]?.clientId ?? null;
}

/**
 * Story 21-7 — the portal's per-request re-read of its user (the guard, and
 * `portal/me`): the user's client and status (plus its id, email and role
 * for `portal/me`), read by tenant AND id inside the caller's tenant
 * transaction. Null for an unknown user. (The status rides along so the
 * guard needs one query, not `getMemberClientIdIn` plus a second read.)
 */
export interface MemberPortalFacts {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly status: string;
  readonly clientId: string | null;
}

export async function getMemberPortalFactsIn(
  tx: TenantTx,
  tenantId: string,
  userId: string,
): Promise<MemberPortalFacts | null> {
  const rows = await tx
    .select({ id: users.id, email: users.email, role: users.role, status: users.status, clientId: users.clientId })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
    .limit(1);
  return rows[0] ?? null;
}

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
 * The invoice's party facts (story 8-1, read INSIDE the caller's generate
 * transaction so the document snapshots who stood where at issuance): the
 * tenant (name + default GSTIN) and the dispatch's origin warehouse
 * (name + warehouse GSTIN + origin address). A READ of tenancy tables by the
 * invoicing module through this exported seam — the `getMemberRoleIn`
 * precedent; the invoicing module never imports a tenancy table itself.
 */
export interface InvoicePartyFacts {
  readonly tenantName: string;
  readonly tenantGstin: string | null;
  readonly warehouseName: string;
  readonly warehouseGstin: string | null;
  readonly originAddress: AddressSnapshot | null;
}

export async function invoicePartyFactsInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
): Promise<InvoicePartyFacts> {
  await assertWarehouseInTenant(tx, tenantId, warehouseId);
  const tenantRows = await tx
    .select({ name: tenants.name, gstin: tenants.gstin })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const tenant = tenantRows[0];
  if (tenant === undefined) {
    // Fail closed: the RLS scope already guarantees membership, so this is
    // unreachable in practice — but a missing tenant row cannot resolve a
    // seller name, and generation must not invent one.
    throw new ProblemException(
      'not-found',
      404,
      'Tenant not found',
      'The tenant row backing this invoice could not be read.',
    );
  }
  const warehouseRows = await tx
    .select({
      name: warehouses.name,
      gstin: warehouses.gstin,
      originContactName: warehouses.originContactName,
      originPhone: warehouses.originPhone,
      originLine1: warehouses.originLine1,
      originLine2: warehouses.originLine2,
      originCity: warehouses.originCity,
      originState: warehouses.originState,
      originPincode: warehouses.originPincode,
    })
    .from(warehouses)
    .where(and(eq(warehouses.id, warehouseId), eq(warehouses.tenantId, tenantId)))
    .limit(1);
  const warehouse = warehouseRows[0]!;
  return {
    tenantName: tenant.name,
    tenantGstin: tenant.gstin,
    warehouseName: warehouse.name,
    warehouseGstin: warehouse.gstin,
    originAddress: addressFromColumns({
      contactName: warehouse.originContactName,
      phone: warehouse.originPhone,
      line1: warehouse.originLine1,
      line2: warehouse.originLine2,
      city: warehouse.originCity,
      state: warehouse.originState,
      pincode: warehouse.originPincode,
    }),
  };
}

/**
 * Story 21-5 — the supplier facts a 3PL client invoice needs: the tenant's
 * name and default GSTIN, and EVERY warehouse of the tenant with its code,
 * name, GSTIN and origin address (the `origin_*` columns). Billing groups the
 * warehouses by supplying GSTIN (`warehouses.gstin ?? tenants.gstin`) and
 * prints the supplier address from the group's warehouse — a READ of tenancy
 * tables through this exported seam (the `invoicePartyFactsInTx`
 * precedent); billing never imports a tenancy table. Warehouses ordered by
 * code (the supplier-address pick is "the lowest-code warehouse with a full
 * address").
 */
export interface ClientInvoiceWarehouseFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly gstin: string | null;
  /** The raw origin columns — any may be null on a pre-11.1 row. */
  readonly origin: {
    readonly contactName: string | null;
    readonly phone: string | null;
    readonly line1: string | null;
    readonly line2: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly pincode: string | null;
  };
}

export interface ClientInvoiceSupplierFacts {
  readonly tenantName: string;
  readonly tenantGstin: string | null;
  readonly warehouses: readonly ClientInvoiceWarehouseFacts[];
}

/**
 * Story 21-5b — the emails of a set of the tenant's users (the dispute
 * drill names each record's actor): userId → email, read inside the
 * caller's transaction through this exported seam (the
 * `clientInvoiceSupplierFactsInTx` precedent — billing never imports a
 * tenancy table). An id that is not a user of this tenant is simply absent
 * (the caller shows `null`); malformed ids are skipped, never bound.
 */
export async function userEmailsInTx(tx: TenantTx, tenantId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  const distinct = [...new Set(userIds)].filter((id) => UUID_RE.test(id));
  if (distinct.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    select u.id as "id", u.email as "email"
    from users u
    where u.tenant_id = ${tenantId}::uuid and u.id = any(${sql.param(distinct)}::uuid[])
  `)) as unknown as { id: string; email: string }[];
  return new Map(rows.map((row) => [row.id, row.email]));
}

export async function clientInvoiceSupplierFactsInTx(tx: TenantTx, tenantId: string): Promise<ClientInvoiceSupplierFacts> {
  const tenantRows = await tx
    .select({ name: tenants.name, gstin: tenants.gstin })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const tenant = tenantRows[0];
  if (tenant === undefined) {
    throw new ProblemException('not-found', 404, 'Tenant not found', 'The tenant row backing this invoice could not be read.');
  }
  const rows = await tx
    .select({
      id: warehouses.id,
      code: warehouses.code,
      name: warehouses.name,
      gstin: warehouses.gstin,
      contactName: warehouses.originContactName,
      phone: warehouses.originPhone,
      line1: warehouses.originLine1,
      line2: warehouses.originLine2,
      city: warehouses.originCity,
      state: warehouses.originState,
      pincode: warehouses.originPincode,
    })
    .from(warehouses)
    .where(eq(warehouses.tenantId, tenantId))
    .orderBy(asc(warehouses.code), asc(warehouses.id));
  return {
    tenantName: tenant.name,
    tenantGstin: tenant.gstin,
    warehouses: rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      gstin: row.gstin,
      origin: {
        contactName: row.contactName,
        phone: row.phone,
        line1: row.line1,
        line2: row.line2,
        city: row.city,
        state: row.state,
        pincode: row.pincode,
      },
    })),
  };
}

/**
 * Every GSTIN the tenant is registered under (story 8-2b): the tenant's own
 * and each warehouse's, distinct and sorted. The e-way GSTIN settings accept
 * only these. A read — invoicing writes no tenancy table.
 */
export async function tenantGstinsInTx(tx: TenantTx, tenantId: string): Promise<string[]> {
  const tenantRows = await tx.select({ gstin: tenants.gstin }).from(tenants).where(eq(tenants.id, tenantId));
  const warehouseRows = await tx
    .select({ gstin: warehouses.gstin })
    .from(warehouses)
    .where(eq(warehouses.tenantId, tenantId));
  const all = [...tenantRows, ...warehouseRows]
    .map((row) => row.gstin)
    .filter((gstin): gstin is string => gstin !== null);
  return [...new Set(all)].sort();
}

/**
 * The GSTIN's canonical storage form (story 8-1): trim + uppercase, with a
 * whitespace-only value treated as absent (the `line2` idiom). Null stays
 * null — optional everywhere. Shape-validated here so the non-HTTP caller
 * paths (adapters, seeds) cannot write a 15-character-violating value either
 * (`orders.consignee_gstin` rides the same helper from the create-order
 * command); the migration CHECK is the storage-layer backstop.
 *
 * Story 8-1d: the two-digit prefix must also be a GST REGISTRATION state
 * code (`isGstinStateCode` — the pure constant, so this stays synchronous
 * and DB-free for registration, which runs outside any transaction). Every
 * caller invokes it BEHIND its replay lookup, so a key committed before
 * this rule still replays.
 */
export function normalizeGstin(raw: string | null | undefined): string | null {
  const value = normalizeGstinInput(raw);
  if (value === null) return null;
  if (!GSTIN_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      'GSTIN validation failed',
      `gstin must be a 15-character GSTIN (two digits, thirteen alphanumeric characters; got "${value}").`,
    );
  }
  const prefixProblem = gstinPrefixProblem(value);
  if (prefixProblem !== null) {
    throw new ProblemException(
      'validation-failed',
      400,
      'GSTIN validation failed',
      `gstin ${prefixProblem} (got "${value}") — a GSTIN begins with the two-digit code of the state it is registered in.`,
    );
  }
  return value;
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
    Page<{
      id: string;
      tenantId: string;
      code: string;
      name: string;
      /** The origin address (story 11-1); null on a pre-11.1 warehouse row. */
      origin: AddressSnapshot | null;
      /** Story 8-1 — the warehouse GSTIN; null when none was given. */
      gstin: string | null;
      createdAt: string;
    }>
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
          originContactName: warehouses.originContactName,
          originPhone: warehouses.originPhone,
          originLine1: warehouses.originLine1,
          originLine2: warehouses.originLine2,
          originCity: warehouses.originCity,
          originState: warehouses.originState,
          originPincode: warehouses.originPincode,
          gstin: warehouses.gstin,
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
    return {
      items: page.items.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        code: row.code,
        name: row.name,
        origin: addressFromColumns({
          contactName: row.originContactName,
          phone: row.originPhone,
          line1: row.originLine1,
          line2: row.originLine2,
          city: row.originCity,
          state: row.originState,
          pincode: row.originPincode,
        }),
        gstin: row.gstin,
        createdAt: row.createdAt,
      })),
      nextCursor: page.nextCursor,
    };
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
          // Story 11-5: the physical capacity echoes raw (no fromMilli —
          // attributes are facts, not quantities).
          lengthMm: bins.lengthMm,
          widthMm: bins.widthMm,
          heightMm: bins.heightMm,
          maxWeightGrams: bins.maxWeightGrams,
          storageClass: bins.storageClass,
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
    // Story 10.1: a read model hands out BASE units; the column holds milli.
    const page = buildPage(
      rows.map((row) => ({ ...row, capacity: fromMilli(row.capacity) })),
      pageSize,
    );
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