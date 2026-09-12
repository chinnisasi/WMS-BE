import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { orders, wavePolicies, waves } from '../../shared/db/schema';
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
import { WaveCommandService, policySnapshot } from './wave.command';
import { PickCommandService } from './pick.command';
import type { PickSnapshot, PickTask, RecordPickCommand } from './pick.command';
import type {
  CreateWavePolicyCommand,
  GenerateWaveCommand,
  WaveGrouping,
  WavePolicySnapshot,
  WavePolicySnapshotBody,
  WaveSnapshot,
  WaveStatus,
  WaveTransitionCommand,
} from './wave.command';

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

/** One header row of the wave-list read (no picklists — detail carries them). */
export interface WaveEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly policyId: string;
  readonly status: WaveStatus;
  readonly releasedAt: string | null;
  readonly cancelledAt: string | null;
  /** Picklists on this wave (the list's at-a-glance size, no N+1 detail read). */
  readonly picklistCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
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
    @Inject(WaveCommandService) private readonly waveCommand: WaveCommandService,
    @Inject(PickCommandService) private readonly pickCommand: PickCommandService,
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

  // ── waves and picklists (Story 4.2) ───────────────────────────────────────

  /** `POST .../outbound/wave-policies` — the rule a wave is generated under. */
  async createWavePolicy(
    command: CreateWavePolicyCommand,
    idempotencyKey: string,
  ): Promise<WavePolicySnapshot> {
    return this.waveCommand.createWavePolicy(command, idempotencyKey);
  }

  /** `POST .../outbound/waves` — gathers accepted orders into picklists. */
  async generateWave(command: GenerateWaveCommand, idempotencyKey: string): Promise<WaveSnapshot> {
    return this.waveCommand.generateWave(command, idempotencyKey);
  }

  /** `POST .../outbound/waves/{id}/release` — makes the wave the floor's work. */
  async releaseWave(command: WaveTransitionCommand, idempotencyKey: string): Promise<WaveSnapshot> {
    return this.waveCommand.releaseWave(command, idempotencyKey);
  }

  /** `POST .../outbound/waves/{id}/cancel` — frees its orders to be re-waved. */
  async cancelWave(command: WaveTransitionCommand, idempotencyKey: string): Promise<WaveSnapshot> {
    return this.waveCommand.cancelWave(command, idempotencyKey);
  }

  /**
   * Wave-detail read (Story 4.2): one wave with its picklists and every pick
   * line in WALK ORDER (`bins.code` ascending — bins carry no spatial data).
   * The existence check precedes the picklist query (the CHECKPOINT 1
   * shape): an unknown or foreign wave id is null → the api layer 404s.
   */
  async getWave(tenantId: string, waveId: string): Promise<WaveSnapshot['wave'] | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(waves)
        .where(and(eq(waves.id, waveId), eq(waves.tenantId, tenantId)))
        .limit(1);
      const wave = rows[0];
      if (wave === undefined) {
        return null;
      }
      // One serializer for reads and writes alike (the `snapshotOf` rule).
      return (await this.waveCommand.snapshotOf(tx, wave)).wave;
    });
  }

  /**
   * Warehouse-scoped wave list (Story 4.2): keyset cursor pagination over
   * `(created_at, id)` from day one (offset pagination is banned — UX-DR25),
   * newest first, headers only — the detail read carries the picklists. A
   * read — never capability-gated; the warehouse must belong to the tenant.
   */
  async listWaves(
    tenantId: string,
    warehouseId: string,
    query: ListOrdersQuery = {},
  ): Promise<Page<WaveEntry>> {
    const pageSize = query.limit ?? DEFAULT_OUTBOUND_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await tx
        .select({
          id: waves.id,
          tenantId: waves.tenantId,
          warehouseId: waves.warehouseId,
          policyId: waves.policyId,
          status: waves.status,
          releasedAt: waves.releasedAt,
          cancelledAt: waves.cancelledAt,
          createdAt: waves.createdAt,
          updatedAt: waves.updatedAt,
          // Table-qualified by hand: an unqualified `id` inside this
          // correlated subquery is ambiguous, and Postgres resolves an
          // ambiguous name against the INNER from list — `pl.id` — which
          // silently counts nothing rather than erroring. Naming `waves.id`
          // says which one is meant. (The `where`-clause fragments elsewhere
          // in this story pass drizzle column references instead, which
          // render qualified; verified against the pinned 0.45.2.)
          picklistCount: sql<number>`(
            select count(*)::int from picklists pl where pl.wave_id = waves.id
          )`,
        })
        .from(waves)
        .where(
          and(
            eq(waves.tenantId, tenantId),
            eq(waves.warehouseId, warehouseId),
            before === undefined
              ? undefined
              : sql`(${waves.createdAt}, ${waves.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(waves.createdAt), desc(waves.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        ...row,
        status: row.status as WaveStatus,
        releasedAt: row.releasedAt === null ? null : canonicalInstant(row.releasedAt),
        cancelledAt: row.cancelledAt === null ? null : canonicalInstant(row.cancelledAt),
        createdAt: canonicalInstant(row.createdAt),
        updatedAt: canonicalInstant(row.updatedAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * Warehouse-scoped wave-policy list (Story 4.2): the same keyset shape —
   * a policy must be discoverable to be referenced by a generate call.
   */
  async listWavePolicies(
    tenantId: string,
    warehouseId: string,
    query: ListOrdersQuery = {},
  ): Promise<Page<WavePolicySnapshotBody & { readonly grouping: WaveGrouping }>> {
    const pageSize = query.limit ?? DEFAULT_OUTBOUND_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await tx
        .select()
        .from(wavePolicies)
        .where(
          and(
            eq(wavePolicies.tenantId, tenantId),
            eq(wavePolicies.warehouseId, warehouseId),
            before === undefined
              ? undefined
              : sql`(${wavePolicies.createdAt}, ${wavePolicies.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(wavePolicies.createdAt), desc(wavePolicies.id))
        .limit(pageSize + 1);
      return buildPage(rows.map(policySnapshot), pageSize);
    });
  }

  // ── picking (Story 4.3) ───────────────────────────────────────────────────

  /**
   * `POST .../outbound/picks` (device-gated, `picks.execute`): one
   * scan-verified pick — the `pick.picked` ledger draw and the reservation's
   * `held → committed` settlement in ONE transaction.
   */
  async recordPick(command: RecordPickCommand, idempotencyKey: string): Promise<PickSnapshot> {
    return this.pickCommand.recordPick(command, idempotencyKey);
  }

  /**
   * The device's pick tasks (AD-4): the still-pickable lines of every ready
   * picklist on a released wave in the warehouse, in walk order — composed
   * into the sealed device catalog snapshot additively (the `putawayTasks`
   * precedent). The bin and batch each task names are advisory suggestions,
   * re-derived server-side at pick time.
   *
   * In-tx ONLY, deliberately: the snapshot composes bins, putaway tasks and
   * pick tasks in ONE tenant transaction. A pool-opening sibling would
   * reserve a SECOND connection while the outer one is held, and postgres.js
   * queues connection requests with no timeout, so enough concurrent
   * snapshots deadlock the pool permanently — which is exactly what a
   * convenience wrapper here invited last time.
   */
  async getPickTasksInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
  ): Promise<PickTask[]> {
    return this.pickCommand.getPickTasksInTx(tx, tenantId, warehouseId);
  }

  /**
   * The same read in its OWN tenant transaction — what the api shell calls
   * when it joins this arm onto the device catalog snapshot. One transaction,
   * one pooled connection, taken AFTER the snapshot's own has been released:
   * the shell composes the two facades sequentially rather than nesting, so
   * neither read can queue behind the other.
   */
  async getPickTasks(tenantId: string, warehouseId: string): Promise<PickTask[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getPickTasksInTx(tx, tenantId, warehouseId),
    );
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
