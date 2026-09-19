import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { handlingUnits, orders, picks, skus, wavePolicies, waves } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
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
import { PackCommandService } from './pack.command';
import type { PackOrderCommand, PackSnapshot } from './pack.command';
import { DispatchCommandService } from './dispatch.command';
import type { DispatchOrderCommand, DispatchSnapshot } from './dispatch.command';
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

/**
 * The device's pack bench unit of work (story 10.7, additive): ONE
 * fully-picked order's per-SKU picked totals — the dataset the bench
 * pre-verifies its scan against, offline. A pack task exists per (order,
 * SKU) that actually moved units; the shape mirrors what
 * `PackCommandService.assertScanMatchesPicked` compares (`picks` grouped by
 * (order, sku), base units at the edge), so the device's exact-match gate
 * verifies against the same numbers the server will.
 */
export interface PackTask {
  readonly orderId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  /** What the order actually had PICKED, in base units (a whole count at the bench). */
  readonly pickedQty: number;
  /**
   * Story 10.3: the SKU is handled by unit — the bench must scan each
   * case's label and the count must equal `pickedQty`, never a typed quantity.
   */
  readonly catchWeightTracked: boolean;
}

/**
 * One `active` handling unit of the warehouse (story 10.7, additive): the
 * id + skuId pair the bench resolves a catch-weight case label against,
 * offline. Active-only self-prunes — a unit flips to `packed` at pack —
 * so the array is bounded by received-not-yet-packed stock. DELIBERATELY
 * uncapped: a unit the snapshot omits is a real case the bench would refuse
 * to scan (its unknown-id gate), so an artificial ceiling here would
 * queue-and-die a legitimate scan — the exact hole this array exists to close.
 */
export interface CatalogHandlingUnit {
  readonly id: string;
  readonly skuId: string;
}

/** The snapshot's pack arm, read in ONE transaction (one consistent read). */
export interface PackWorkRead {
  readonly packTasks: readonly PackTask[];
  readonly handlingUnits: readonly CatalogHandlingUnit[];
}

export const DEFAULT_OUTBOUND_PAGE_SIZE = 50;

/**
 * The cap on the snapshot's pack tasks (the `MAX_SNAPSHOT_PICK_TASKS`
 * precedent), truncated on ORDER boundaries so no order is ever
 * half-delivered — a bench that saw one SKU of a two-SKU order could never
 * reach the exact match its commit gate requires.
 */
export const MAX_SNAPSHOT_PACK_TASKS = 500;

/**
 * Caps an over-read at `max`, cutting only on GROUP boundaries (the rows
 * arrive ordered by group; `keyOf` names the group a row belongs to). A
 * half-delivered group is exactly what the cap must never emit — the pack
 * bench's exact-match gate needs EVERY SKU of an order, so the order
 * straddling the ceiling is dropped whole (the `truncateToWholePicklists`
 * shape, extracted parameterized by the group key so the boundary is
 * unit-testable without seeding five hundred pack lines — review W8/W9,
 * story 10.7).
 *
 * The one exception, and the reason this is a named function: when a SINGLE
 * group occupies the entire ceiling on its own, dropping it whole would hand
 * the devices an empty snapshot while packable work exists. There, a
 * truncated group beats no group — the group is kept at the ceiling,
 * TRUNCATED (never "returned as it is": the rows past the ceiling are cut,
 * and the device's exact-match gate simply never sees a count it cannot
 * reconcile against a snapshot that omits them). Pure.
 */
export function truncateToWholeGroups<T>(
  overRead: readonly T[],
  max: number,
  keyOf: (row: T) => string,
): T[] {
  if (overRead.length <= max) {
    return [...overRead];
  }
  const kept = overRead.slice(0, max);
  const straddling = keyOf(kept[kept.length - 1]!);
  // The cut fell inside `straddling` only if that group also has a row
  // beyond the ceiling (the pick precedent's `overRead[max]` check — NOT the
  // over-read's last row: a straddling order followed by other orders still
  // straddles).
  if (keyOf(overRead[max]!) !== straddling) {
    return kept;
  }
  const whole = kept.filter((row) => keyOf(row) !== straddling);
  // Never hand back nothing while packable work exists.
  return whole.length === 0 ? kept : whole;
}

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
    @Inject(PackCommandService) private readonly packCommand: PackCommandService,
    @Inject(DispatchCommandService) private readonly dispatchCommand: DispatchCommandService,
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

  // ── packing (Story 4.5) ───────────────────────────────────────────────────

  /**
   * `POST .../outbound/orders/{orderId}/pack` (`pack.execute`): verifies the
   * parcel's scanned contents against what the order actually had PICKED,
   * journals one zero-quantity `pack.packed` event per order line, flips the
   * order to `ready_to_dispatch` and returns the packing-slip payload — all
   * in ONE transaction. A discrepancy is refused before anything is written.
   */
  async packOrder(command: PackOrderCommand, idempotencyKey: string): Promise<PackSnapshot> {
    return this.packCommand.packOrder(command, idempotencyKey);
  }

  // ── dispatch (Story 4.6) ──────────────────────────────────────────────────

  /**
   * `POST .../outbound/orders/{orderId}/dispatch` (`dispatch.execute`): the
   * order's TERMINAL transition. The `ready_to_dispatch → dispatched` flip,
   * one zero-quantity `dispatch.dispatched` event per order line, and the
   * retirement of every `committed` hold the order owns to `released` — the
   * transition that finally restores the reserved counter and corrects ATP —
   * all in ONE transaction. The optional free-text carrier and tracking
   * reference ride the events' reference doc.
   */
  async dispatchOrder(
    command: DispatchOrderCommand,
    idempotencyKey: string,
  ): Promise<DispatchSnapshot> {
    return this.dispatchCommand.dispatchOrder(command, idempotencyKey);
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
   * The device's pack bench work (story 10.7, AD-4): the packable orders'
   * per-SKU picked totals plus every active handling unit of the warehouse —
   * composed into the sealed device catalog snapshot additively (the
   * `pickTasks` precedent).
   *
   * The PACKABLE predicate mirrors `packOrder`'s own guards, read-only: an
   * `accepted` order in the warehouse whose pick plan has at least one
   * `picklist_lines` row, none still `planned`, and not every one
   * `cancelled` (the command's whole-withdrawn FLOOR clause — a wave-cancelled
   * order was never picked and stays re-wavable), and which actually moved
   * units (`sum(picks.qty) > 0` — `picks` rows are strictly positive, so the
   * grouped rows below imply it). The completeness is deliberately
   * LINE-STATUS based, never `picks`-based: a zero-unit short pick writes no
   * picks row (the command's own header documents why). Per-SKU `pickedQty`
   * comes from the SAME grouped-`picks` read the command verifies against —
   * one roll-up, so the snapshot cannot tell the bench a different number
   * than the server will verify against.
   *
   * A READ of the catalog-owned `handling_units` table from this module:
   * reads are precedented (`pick.command.ts` joins `skus` directly) — the
   * architecture test's exclusive-writer rule binds WRITES only, and this
   * module writes none (the `active → packed` flip stays in
   * `handling-unit.store.ts` through the catalog facade).
   *
   * In-tx ONLY, deliberately (the `getPickTasksInTx` reason verbatim): the
   * snapshot composes its parts in ONE tenant transaction — a pool-opening
   * sibling would reserve a second connection while the outer one is held,
   * and postgres.js queues connection requests with no timeout.
   */
  async getPackTasksInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
  ): Promise<PackWorkRead> {
    // The packable predicate: `picks` joined to its order (which carries the
    // warehouse scope and the accepted status), with the line-status arms as
    // correlated EXISTS fragments — the same shape the wave-list read's
    // `picklistCount` subquery uses. `picks_tenant_order_idx` serves the
    // grouped read; the subqueries ride `picklist_lines_tenant_order_idx`.
    const overRead = await tx
      .select({
        orderId: picks.orderId,
        orderCreatedAt: orders.createdAt,
        skuId: picks.skuId,
        skuCode: skus.code,
        skuName: skus.name,
        catchWeightTracked: skus.catchWeightTracked,
        // Story 10.1: `::bigint` — an int4 sum overflows at ~2.1M base units;
        // int8 comes back as a string and `Number(...)` is the boundary
        // coercion, exactly as the pack command's own verification query does.
        pickedQty: sql<string>`sum(${picks.qty})::bigint`,
      })
      .from(picks)
      .innerJoin(orders, and(eq(orders.id, picks.orderId), eq(orders.tenantId, picks.tenantId)))
      .innerJoin(skus, eq(skus.id, picks.skuId))
      .where(
        and(
          eq(picks.tenantId, tenantId),
          eq(orders.warehouseId, warehouseId),
          eq(orders.status, 'accepted'),
          sql`exists (select 1 from picklist_lines pl where pl.tenant_id = ${picks.tenantId} and pl.order_id = ${picks.orderId})`,
          sql`not exists (select 1 from picklist_lines pl where pl.tenant_id = ${picks.tenantId} and pl.order_id = ${picks.orderId} and pl.status = 'planned')`,
          sql`exists (select 1 from picklist_lines pl where pl.tenant_id = ${picks.tenantId} and pl.order_id = ${picks.orderId} and pl.status <> 'cancelled')`,
        ),
      )
      // Primary key columns ride the group by so Postgres's functional
      // dependency admits the other selected columns without listing them.
      .groupBy(picks.orderId, orders.id, picks.skuId, skus.id)
      .orderBy(asc(orders.createdAt), asc(orders.id), asc(skus.code), asc(picks.skuId))
      .limit(MAX_SNAPSHOT_PACK_TASKS + 1);

    // Whole-order truncation — `truncateToWholeGroups`, keyed by order. The
    // over-read is `MAX_SNAPSHOT_PACK_TASKS + 1` so the function can see
    // whether the ceiling fell inside an order.
    const rows = truncateToWholeGroups(overRead, MAX_SNAPSHOT_PACK_TASKS, (row) => row.orderId);

    const packTasks: PackTask[] = rows.map((row) => ({
      orderId: row.orderId,
      skuId: row.skuId,
      skuCode: row.skuCode,
      skuName: row.skuName,
      // Base units at the response edge (story 10.1) — the count the bench's
      // exact-match gate compares against.
      pickedQty: fromMilli(Number(row.pickedQty)),
      catchWeightTracked: row.catchWeightTracked,
    }));

    // Active units, id + skuId only (the bench resolves labels, nothing more).
    // Uncapped — see `CatalogHandlingUnit` for why a cap would queue-and-die
    // legitimate scans. Ordered by id so a re-serialized cache cannot change
    // the list the device reasons over.
    const units = await tx
      .select({ id: handlingUnits.id, skuId: handlingUnits.skuId })
      .from(handlingUnits)
      .where(
        and(
          eq(handlingUnits.tenantId, tenantId),
          eq(handlingUnits.warehouseId, warehouseId),
          eq(handlingUnits.status, 'active'),
        ),
      )
      .orderBy(asc(handlingUnits.id));

    return { packTasks, handlingUnits: units };
  }

  /**
   * The same read in its OWN tenant transaction — what the api shell calls
   * when it joins this arm onto the device catalog snapshot. One transaction,
   * one pooled connection, taken AFTER the snapshot's own has been released:
   * the shell composes the facades sequentially rather than nesting, so
   * neither read can queue behind the other.
   */
  async getPackTasks(tenantId: string, warehouseId: string): Promise<PackWorkRead> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getPackTasksInTx(tx, tenantId, warehouseId),
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
