import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { orders } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { canonicalInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { OrderCommandService } from './order.command';
import type {
  CancelOrderCommand,
  CreateOrderCommand,
  OrderSnapshot,
  OrderSource,
  OrderStatus,
} from './order.command';

/** One header row of the order-list read (no lines — detail carries them). */
export interface OrderEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly status: OrderStatus;
  readonly source: OrderSource;
  readonly integrationId: string | null;
  readonly externalEventId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListOrdersQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const DEFAULT_OUTBOUND_PAGE_SIZE = 50;

/**
 * The cursor is opaque to clients but crafted input is still possible — a
 * base64-valid payload with a non-uuid `id` would otherwise reach the
 * `::uuid` cast in SQL and surface as a 500 instead of a 400 (the
 * `decodeCursorSafe` pattern; the shared `UUID_RE` is retro A3's one
 * matcher).
 */
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
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
 * The outbound module's public surface (Story 4.1): the ONLY way any other
 * module — or the api shell — consumes order state. The `orders` /
 * `order_lines` tables are module-exclusive; the architecture test fails
 * any write from outside this module. Stock composition stays the inventory
 * facade's (the reservation holds are read through `reservationsByIdsInTx`).
 */
@Injectable()
export class OutboundFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OrderCommandService) private readonly orderCommand: OrderCommandService,
  ) {}

  /** `POST .../outbound/orders` — manual entry and (adapter-ready) ingestion. */
  async createOrder(command: CreateOrderCommand, idempotencyKey: string): Promise<OrderSnapshot> {
    return this.orderCommand.createOrder(command, idempotencyKey);
  }

  /** `POST .../outbound/orders/{id}/cancel` — releases every open hold. */
  async cancelOrder(command: CancelOrderCommand, idempotencyKey: string): Promise<OrderSnapshot> {
    return this.orderCommand.cancelOrder(command, idempotencyKey);
  }

  /**
   * Order-detail read (Story 4.1): one order with its lines — per line the
   * ordered / reserved / derived shortfall quantities and the hold's live
   * journal state (read through the inventory facade inside this
   * transaction). The existence check precedes the line query (the
   * inventory.facade CHECKPOINT 1 shape): an unknown or foreign order id is
   * null → the api layer 404s.
   */
  async getOrder(tenantId: string, orderId: string): Promise<OrderSnapshot['order'] | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
        .limit(1);
      const order = rows[0];
      if (order === undefined) {
        return null;
      }
      return (await this.snapshotOf(tx, order)).order;
    });
  }

  /**
   * Warehouse-scoped order list (Story 4.1): keyset cursor pagination over
   * `(created_at, id)` (offset pagination is banned — UX-DR25), newest
   * first, headers only — the detail read carries the lines. A read —
   * never capability-gated; the warehouse must belong to the tenant (404
   * otherwise).
   */
  async listOrders(
    tenantId: string,
    warehouseId: string,
    query: ListOrdersQuery = {},
  ): Promise<Page<OrderEntry>> {
    const pageSize = query.limit ?? DEFAULT_OUTBOUND_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await tx
        .select({
          id: orders.id,
          tenantId: orders.tenantId,
          warehouseId: orders.warehouseId,
          status: orders.status,
          source: orders.source,
          integrationId: orders.integrationId,
          externalEventId: orders.externalEventId,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
        })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.warehouseId, warehouseId),
            before === undefined
              ? undefined
              : sql`(${orders.createdAt}, ${orders.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        ...row,
        status: row.status as OrderStatus,
        source: row.source as OrderSource,
        createdAt: canonicalInstant(row.createdAt),
        updatedAt: canonicalInstant(row.updatedAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * The order + lines as one snapshot (the in-tx seam `OrderCommandService`
   * composes for writes; the detail read composes the same shape for reads —
   * one serializer, no drift between the two).
   */
  private async snapshotOf(
    tx: TenantTx,
    order: typeof orders.$inferSelect,
  ): Promise<OrderSnapshot> {
    return this.orderCommand.snapshotOf(tx, order);
  }
}
