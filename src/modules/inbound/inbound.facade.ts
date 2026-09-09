import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { purchaseOrderLines, purchaseOrders, vendors } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { VendorCommand } from './vendors.command';
import type { CreateVendorCommand, VendorSnapshot } from './vendors.command';
import { PurchaseOrderCommand, lineSnapshot } from './po.command';
import type {
  AmendPoCommand,
  ClosePoCommand,
  ClosePoSnapshot,
  CreatePoCommand,
  PoStatus,
  PurchaseOrderLineSnapshot,
  PurchaseOrderSnapshot,
} from './po.command';

/** One vendor row of the vendor-list read. */
export interface VendorEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
}

/** One PO header row of the PO-list read (no lines — detail carries them). */
export interface PurchaseOrderEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly vendorId: string;
  readonly code: string;
  readonly status: PoStatus;
  readonly carriedFromPoId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListVendorsQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListPurchaseOrdersQuery {
  readonly status?: PoStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const DEFAULT_INBOUND_PAGE_SIZE = 50;

/**
 * The cursor is opaque to clients but crafted input is still possible — a
 * base64-valid payload with a non-uuid `id` would otherwise reach the
 * `::uuid` cast in SQL and surface as a 500 instead of a 400 (the same
 * `decodeCursorSafe` pattern as the tenancy/inventory reads; the shared
 * `UUID_RE` is retro A3's one matcher).
 */
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    // `Date.parse` alongside the shape regex: a shape-valid but impossible
    // instant (month 99) would otherwise reach the `::timestamptz` cast as a
    // 500 (the tenancy.service pattern).
    const malformedCursor =
      !UUID_RE.test(decoded.id) ||
      !CURSOR_INSTANT_RE.test(decoded.createdAt) ||
      Number.isNaN(Date.parse(decoded.createdAt));
    if (malformedCursor) {
      throw new Error('malformed cursor payload');
    }
    return decoded;
  } catch {
    throw new ProblemException(
      'invalid-cursor',
      400,
      'Malformed pagination cursor',
      'The cursor parameter is not a valid opaque page cursor.',
    );
  }
}

/**
 * The inbound module's public surface (Story 3.1): vendor master data and the
 * PO lifecycle — commands ride through the module's command services, reads
 * through here. Other modules (and the api shell) consume ONLY this facade;
 * the `vendors` / `purchase_orders` / `purchase_order_lines` tables are
 * module-exclusive.
 */
@Injectable()
export class InboundFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(VendorCommand) private readonly vendorCommand: VendorCommand,
    @Inject(PurchaseOrderCommand) private readonly poCommand: PurchaseOrderCommand,
  ) {}

  /** `vendor.created` — the vendor master data's first producer. */
  async createVendor(
    command: CreateVendorCommand,
    idempotencyKey: string,
  ): Promise<VendorSnapshot> {
    return this.vendorCommand.create(command, idempotencyKey);
  }

  /** The PO lifecycle's three mutations (create / amend / close). */
  async createPurchaseOrder(
    command: CreatePoCommand,
    idempotencyKey: string,
  ): Promise<PurchaseOrderSnapshot> {
    return this.poCommand.create(command, idempotencyKey);
  }

  async amendPurchaseOrder(
    command: AmendPoCommand,
    idempotencyKey: string,
  ): Promise<PurchaseOrderSnapshot> {
    return this.poCommand.amend(command, idempotencyKey);
  }

  async closePurchaseOrder(
    command: ClosePoCommand,
    idempotencyKey: string,
  ): Promise<ClosePoSnapshot> {
    return this.poCommand.close(command, idempotencyKey);
  }

  /**
   * Vendor-list read (Story 3.1): the tenant's vendors, newest first, keyset
   * cursor pagination. A read — never capability-gated.
   */
  async listVendors(tenantId: string, query: ListVendorsQuery = {}): Promise<Page<VendorEntry>> {
    // The route-level DTO already bounds `limit` (1..200) — pass it straight
    // through; clamping here would silently rewrite a bad request instead of
    // rejecting it.
    const pageSize = query.limit ?? DEFAULT_INBOUND_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: vendors.id,
          tenantId: vendors.tenantId,
          code: vendors.code,
          name: vendors.name,
          isDefault: vendors.isDefault,
          createdAt: vendors.createdAt,
        })
        .from(vendors)
        .where(
          and(
            eq(vendors.tenantId, tenantId),
            before === undefined
              ? undefined
              : sql`(${vendors.createdAt}, ${vendors.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(vendors.createdAt), desc(vendors.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        ...row,
        createdAt: canonicalInstant(row.createdAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * PO-list read (Story 3.1): one warehouse's purchase orders, keyset cursor
   * pagination, optionally narrowed to one status. POs are warehouse-scoped
   * (receiving and open-quantity tracking are per-warehouse) — the warehouse
   * must belong to the tenant (404 otherwise). A read — never gated; PO
   * headers only (the detail read carries the lines).
   */
  async listPurchaseOrders(
    tenantId: string,
    warehouseId: string,
    query: ListPurchaseOrdersQuery = {},
  ): Promise<Page<PurchaseOrderEntry>> {
    const pageSize = query.limit ?? DEFAULT_INBOUND_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await tx
        .select({
          id: purchaseOrders.id,
          tenantId: purchaseOrders.tenantId,
          warehouseId: purchaseOrders.warehouseId,
          vendorId: purchaseOrders.vendorId,
          code: purchaseOrders.code,
          status: purchaseOrders.status,
          carriedFromPoId: purchaseOrders.carriedFromPoId,
          createdAt: purchaseOrders.createdAt,
          updatedAt: purchaseOrders.updatedAt,
        })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, tenantId),
            eq(purchaseOrders.warehouseId, warehouseId),
            query.status === undefined ? undefined : eq(purchaseOrders.status, query.status),
            before === undefined
              ? undefined
              : sql`(${purchaseOrders.createdAt}, ${purchaseOrders.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        ...row,
        status: row.status as PoStatus,
        createdAt: canonicalInstant(row.createdAt),
        updatedAt: canonicalInstant(row.updatedAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * PO-detail read (Story 3.1): one PO with its lines — per line the
   * ordered / received-to-date / open quantities at all times (received
   * ships at 0 until 3.3's receipts land; open is always derived). The
   * existence check precedes the line query (the inventory.facade CHECKPOINT
   * 1 shape): an unknown or foreign PO id is a 404, not a detail miss.
   */
  async getPurchaseOrder(
    tenantId: string,
    poId: string,
  ): Promise<PurchaseOrderSnapshot['purchaseOrder'] | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const poRows = await tx
        .select()
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.tenantId, tenantId)))
        .limit(1);
      const po = poRows[0];
      if (po === undefined) {
        return null;
      }
      // Oldest first — the same order the commands' snapshots carry.
      const lines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.poId, po.id))
        .orderBy(asc(purchaseOrderLines.createdAt), asc(purchaseOrderLines.id));
      return {
        id: po.id,
        tenantId: po.tenantId,
        warehouseId: po.warehouseId,
        vendorId: po.vendorId,
        code: po.code,
        status: po.status as PoStatus,
        carriedFromPoId: po.carriedFromPoId,
        createdAt: canonicalInstant(po.createdAt),
        updatedAt: canonicalInstant(po.updatedAt),
        lines: lines.map(lineSnapshot),
      };
    });
  }
}

/**
 * Postgres returns `timestamptz` in its own text shape; the read contract is
 * ISO-8601 UTC (the repo-wide instant normalization).
 */
function canonicalInstant(value: string): string {
  return new Date(value).toISOString();
}

export type { PurchaseOrderLineSnapshot };