import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  bins,
  idempotencyKeys,
  orderLines,
  orders,
  picklistLines,
  picklists,
  wavePolicies,
  waves,
} from '../../shared/db/schema';
import type { Picklist, PicklistLine, Wave, WavePolicy } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import { WAVE_CLOCK } from './wave.clock';
import type { WaveClock } from './wave.clock';

// ── state machines + policy constants (the outbound module exclusively owns
// the wave/picklist state machines, AD-6 — the additive arms below are the
// module's registry, mirrored by the DB CHECKs in migration 0018) ───────────

/** The wave lifecycle arms shipped in story 4.2 (additive: 4.3/4.5 extend). */
export const WAVE_STATUSES = ['planned', 'released', 'cancelled'] as const;
export type WaveStatus = (typeof WAVE_STATUSES)[number];

/** The picklist lifecycle arms shipped in story 4.2. */
export const PICKLIST_STATUSES = ['planned', 'ready', 'cancelled'] as const;
export type PicklistStatus = (typeof PICKLIST_STATUSES)[number];

/** The pick-line arms shipped in story 4.2. */
export const PICKLIST_LINE_STATUSES = ['planned', 'unfulfillable', 'cancelled'] as const;
export type PicklistLineStatus = (typeof PICKLIST_LINE_STATUSES)[number];

/** How a policy shapes a wave's picklists. */
export const WAVE_GROUPINGS = ['single', 'batch'] as const;
export type WaveGrouping = (typeof WAVE_GROUPINGS)[number];

/**
 * The timezone every `cutoff_local_time` is compared in (the technical
 * decision, 2026-09-11). `warehouses` has no timezone column and the product
 * is India-only (GST invoicing, e-way bills, Indian carriers), so a
 * per-warehouse timezone would be speculative scope. When warehouses gain a
 * timezone, THIS CONSTANT is the single place to change.
 */
export const WAVE_CUTOFF_TIMEZONE = 'Asia/Kolkata';

/** `HH:MM`, 24-hour — the stored shape of a policy cutoff (DB CHECK mirrors it). */
const CUTOFF_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * The cap applied when a policy leaves `max_orders` null. A wave is a unit
 * of floor work, so "uncapped" is not an option the aggregate offers — the
 * policy either names its own cap or inherits this one.
 */
export const DEFAULT_WAVE_MAX_ORDERS = 200;

/** Upper bound a policy's own `max_orders` may be set to. */
const MAX_POLICY_MAX_ORDERS = 500;

/** Upper bound on an explicit order selection (a bounded IN list). */
const MAX_SELECTED_ORDERS = 500;

const MAX_POLICY_NAME_LENGTH = 120;
const MAX_POLICY_PRIORITY = 1000;

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
/** The one-open-wave-per-order backstop (the race's deterministic loser). */
const OPEN_ORDER_LINE_UNIQUE = 'picklist_lines_open_order_line_unique';
/** One policy name per warehouse. */
const POLICY_NAME_UNIQUE = 'wave_policies_warehouse_name_unique';

// ── command inputs ───────────────────────────────────────────────────────────

export interface CreateWavePolicyCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly name: string;
  readonly grouping: WaveGrouping;
  readonly priority?: number | undefined;
  readonly maxOrders?: number | undefined;
  /** `HH:MM` in Asia/Kolkata; omitted/null → release is always allowed. */
  readonly cutoffLocalTime?: string | undefined;
  /** Unvalidated carrier ref (no carriers table until 4.6 / Epic 7). */
  readonly carrierRef?: string | undefined;
}

export interface GenerateWaveCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly policyId: string;
  /**
   * The operator's explicit order selection. Omitted → every eligible
   * accepted order in the warehouse, oldest first, capped by the policy.
   */
  readonly orderIds?: readonly string[] | undefined;
}

export interface WaveTransitionCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly waveId: string;
}

// ── snapshots ────────────────────────────────────────────────────────────────

export interface WavePolicySnapshotBody {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly name: string;
  readonly grouping: WaveGrouping;
  readonly priority: number;
  readonly maxOrders: number | null;
  readonly cutoffLocalTime: string | null;
  readonly cutoffTimezone: string;
  readonly carrierRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WavePolicySnapshot {
  readonly policy: WavePolicySnapshotBody;
}

/** One pick line — a bin/batch SUGGESTION, never an allocation. */
export interface PicklistLineSnapshot {
  readonly id: string;
  readonly picklistId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly skuId: string;
  readonly binId: string | null;
  readonly binCode: string | null;
  readonly batchId: string | null;
  readonly reservationId: string | null;
  /** Units to draw at this bin (0 on an `unfulfillable` slice). */
  readonly qty: number;
  /** Uncovered units — non-zero only on an `unfulfillable` slice. */
  readonly shortfallQty: number;
  readonly sliceSeq: number;
  readonly walkSeq: number;
  readonly status: PicklistLineStatus;
  readonly createdAt: string;
}

export interface PicklistSnapshot {
  readonly id: string;
  readonly waveId: string;
  /** The single order this picklist serves; null on a batch picklist. */
  readonly orderId: string | null;
  readonly status: PicklistStatus;
  /** Distinct bin stops on this picklist's walk (unfulfillable lines are none). */
  readonly stopCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly PicklistLineSnapshot[];
}

export interface WaveSnapshot {
  readonly wave: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly policyId: string;
    readonly status: WaveStatus;
    readonly releasedAt: string | null;
    readonly cancelledAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly picklists: readonly PicklistSnapshot[];
  };
}

// ── planning shapes (internal) ───────────────────────────────────────────────

/** One drawable unit-bucket of the walk: a (bin, batch) slot in walk order. */
interface StockSlot {
  readonly binId: string;
  readonly binCode: string;
  readonly batchId: string | null;
  remaining: number;
}

/** One planned slice of one order line. */
interface PlannedSlice {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly skuId: string;
  readonly reservationId: string | null;
  readonly binId: string | null;
  readonly binCode: string | null;
  readonly batchId: string | null;
  readonly qty: number;
  readonly shortfallQty: number;
  readonly sliceSeq: number;
  readonly status: PicklistLineStatus;
}

/**
 * The wave commands (story 4.2): generation, release and cancellation of the
 * wave aggregate, plus the wave policies that shape it.
 *
 * Every command follows the 4.1 invariant order — `assertPermission` (fresh
 * DB role read) → idempotency replay → validation → writes (uuidv7) →
 * snapshot → in-tx outbox → audit → `writeIdempotencyKey` last — and the
 * terminal transitions are flip-first (one conditional UPDATE decides the
 * single winner; the winner's transaction alone carries the event and the
 * audit row).
 *
 * Unlike 4.1's create path, these commands need no multi-phase split: no
 * reservation is granted, committed or released anywhere in this story. A
 * wave carries each order line's EXISTING hold forward by id; the bin and
 * batch a pick line names are a suggestion re-derived at pick time (4.3),
 * never a bin-level allocation — a reservation binds to (tenant, warehouse,
 * sku, owner) and carries no bin, so a second, weaker claim here would make
 * two sources of truth for the same units. So each command is exactly ONE
 * tenant transaction, and the plan a generate commits is the stock it saw.
 */
@Injectable()
export class WaveCommandService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition at the command layer through the facades only
    // (AD-6): the reservation-state read and the per-bin/per-batch stock
    // reads ride the inventory facade; batch expiry (catalog-owned) rides
    // the catalog facade. This module writes no stock table and no ledger
    // event — picking is 4.3.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(WAVE_CLOCK) private readonly clock: WaveClock,
  ) {}

  // ── wave policies ──────────────────────────────────────────────────────────

  /**
   * `POST .../wave-policies` (waves.manage): the outbound module owns its own
   * policy table rather than reaching into an empty `carriers`/`channels`
   * shell. A policy must be creatable before a wave can reference one.
   */
  async createWavePolicy(
    command: CreateWavePolicyCommand,
    idempotencyKey: string,
  ): Promise<WavePolicySnapshot> {
    const name = command.name.trim();
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      name,
      grouping: command.grouping,
      priority: command.priority ?? null,
      maxOrders: command.maxOrders ?? null,
      cutoffLocalTime: command.cutoffLocalTime ?? null,
      carrierRef: command.carrierRef ?? null,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'waves.manage',
      );
      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return replay as WavePolicySnapshot;
      }

      // ── validation (400 before any write) ───────────────────────────────
      if (name.length === 0 || name.length > MAX_POLICY_NAME_LENGTH) {
        throw validationFailed(
          `A policy name is 1..${MAX_POLICY_NAME_LENGTH} characters (got ${name.length}).`,
        );
      }
      if (!(WAVE_GROUPINGS as readonly string[]).includes(command.grouping)) {
        throw validationFailed(`grouping is one of ${WAVE_GROUPINGS.join(', ')}.`);
      }
      const priority = command.priority ?? 0;
      if (!Number.isInteger(priority) || priority < 0 || priority > MAX_POLICY_PRIORITY) {
        throw validationFailed(`priority is an integer in 0..${MAX_POLICY_PRIORITY}.`);
      }
      const maxOrders = command.maxOrders ?? null;
      if (
        maxOrders !== null &&
        (!Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > MAX_POLICY_MAX_ORDERS)
      ) {
        throw validationFailed(
          `maxOrders is an integer in 1..${MAX_POLICY_MAX_ORDERS}, or absent (absent inherits the ${DEFAULT_WAVE_MAX_ORDERS}-order default).`,
        );
      }
      const cutoffLocalTime = command.cutoffLocalTime ?? null;
      if (cutoffLocalTime !== null && !CUTOFF_RE.test(cutoffLocalTime)) {
        throw validationFailed(
          `cutoffLocalTime is a 24-hour HH:MM wall clock in ${WAVE_CUTOFF_TIMEZONE} (got "${cutoffLocalTime}").`,
        );
      }
      // Non-HTTP callers skip the DTO's @IsUUID — the command is the
      // boundary that keeps a malformed id out of a uuid column (a raw
      // 22P02 surfaces as a 500, never an answer).
      if (!UUID_RE.test(command.warehouseId)) {
        throw validationFailed('warehouseId must be a uuid.');
      }
      const carrierRef = command.carrierRef ?? null;
      // Non-HTTP callers skip the DTO's @IsUUID — the command is the boundary
      // that keeps a bad ref out of the uuid column (a raw 22P02 is never an
      // answer). The ref stays UNVALIDATED beyond its shape: no carriers
      // table exists until 4.6 (the `orders.integration_id` precedent).
      if (carrierRef !== null && !UUID_RE.test(carrierRef)) {
        throw validationFailed('carrierRef must be a uuid.');
      }
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

      const policyId = uuidv7();
      try {
        await tx.insert(wavePolicies).values({
          id: policyId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          name,
          grouping: command.grouping,
          priority,
          maxOrders,
          cutoffLocalTime,
          carrierRef,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, POLICY_NAME_UNIQUE)) {
          throw new ProblemException(
            'conflict',
            409,
            'Wave policy name already used',
            `A wave policy named "${name}" already exists in this warehouse.`,
          );
        }
        throw err;
      }

      const rows = await tx.select().from(wavePolicies).where(eq(wavePolicies.id, policyId));
      const snapshot: WavePolicySnapshot = { policy: policySnapshot(rows[0]!) };

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'wave.policy-created',
        occurredAt: nowIso(),
        payload: { policy: snapshot.policy },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'wave.policy-created',
        targetType: 'wave_policy',
        targetId: policyId,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });
      await this.writeIdempotencyKey(
        tx,
        command.tenantId,
        idempotencyKey,
        payloadHash,
        snapshot,
      );
      return snapshot;
    });
  }

  // ── generation ─────────────────────────────────────────────────────────────

  /**
   * `POST .../waves` (waves.manage): gathers accepted orders by policy into
   * picklists — one per order (`single`) or ONE across the selection
   * (`batch`, grouped by bin so each bin is visited at most once) — and
   * plans each picklist's walk in `bins.code` ascending order.
   *
   * Generation is an operator-triggered command, not a scheduled job: every
   * acceptance criterion here is about grouping correctness, not timing, and
   * a job can be layered on later without changing the aggregate. A policy's
   * cutoff gates RELEASE, never generation — planning ahead of a cutoff is
   * the point.
   *
   * One order belongs to at most one OPEN wave. The partial unique index on
   * `picklist_lines` is the enforcement (not a pre-check): without it two
   * waves plan the same reserved units and the floor picks the same stock
   * twice, which the reservation cannot catch because both picks draw
   * against the same held quantity. The concurrent race therefore resolves
   * in the database — the loser re-reads the winning wave and is refused
   * 409 naming it.
   */
  async generateWave(
    command: GenerateWaveCommand,
    idempotencyKey: string,
  ): Promise<WaveSnapshot> {
    const selection =
      command.orderIds === undefined ? null : [...new Set(command.orderIds)].sort();
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      policyId: command.policyId,
      orderIds: selection,
    });

    try {
      return await withTenantTransaction(this.db, command.tenantId, async (tx) => {
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'waves.manage',
        );
        const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replay !== null) {
          return replay as WaveSnapshot;
        }

        // ── validation (400 before any write) ─────────────────────────────
        if (!UUID_RE.test(command.warehouseId)) {
          throw validationFailed('warehouseId must be a uuid.');
        }
        if (!UUID_RE.test(command.policyId)) {
          throw validationFailed('policyId must be a uuid.');
        }
        if (selection !== null) {
          if (selection.length === 0) {
            throw validationFailed('orderIds, when present, names at least one order.');
          }
          if (selection.length > MAX_SELECTED_ORDERS) {
            throw validationFailed(
              `orderIds names at most ${MAX_SELECTED_ORDERS} orders (got ${selection.length}).`,
            );
          }
          for (const orderId of selection) {
            if (!UUID_RE.test(orderId)) {
              throw validationFailed('Every entry of orderIds is a well-formed order id.');
            }
          }
        }
        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
        const policy = await this.loadPolicy(tx, command.tenantId, command.policyId);
        if (policy.warehouseId !== command.warehouseId) {
          throw policyNotFound(command.policyId);
        }

        // ── the eligible orders (and the refusals a selection can earn) ───
        const selectedOrderIds = await this.selectOrders(tx, command, policy, selection);

        // ── the lines that actually hold live stock ───────────────────────
        const lines = await tx
          .select()
          .from(orderLines)
          .where(
            and(
              eq(orderLines.tenantId, command.tenantId),
              inArray(orderLines.orderId, selectedOrderIds),
              sql`${orderLines.reservedQty} > 0`,
              sql`${orderLines.reservationId} is not null`,
            ),
          )
          .orderBy(asc(orderLines.orderId), asc(orderLines.createdAt), asc(orderLines.id));
        // A hold the journal no longer reports as `held` (released, expired,
        // or committed by a consuming flow) is not pickable stock — the
        // reservation journal is the truth, never the line's cached id.
        const holdIds = lines
          .map((line) => line.reservationId)
          .filter((id): id is string => id !== null);
        const heldIds = new Set(
          (await this.inventory.reservationsByIdsInTx(tx, command.tenantId, holdIds))
            .filter((row) => row.state === 'held')
            .map((row) => row.id),
        );
        const pickable = lines.filter(
          (line) => line.reservationId !== null && heldIds.has(line.reservationId),
        );
        if (pickable.length === 0) {
          throw noEligibleOrders(
            'No selected order holds a live reservation — a wave draws only accepted orders whose lines hold live holds.',
          );
        }
        // Keep the selection order (oldest order first). An order whose every
        // line lost its hold is REFUSED by name, never silently dropped: an
        // operator who names five orders and gets three picklists back has no
        // way to tell which two went missing, and every adjacent refusal here
        // names its order.
        const liveOrderIds = selectedOrderIds.filter((orderId) =>
          pickable.some((line) => line.orderId === orderId),
        );
        // Only an EXPLICIT selection earns this refusal: a sweep named no
        // order, so skipping a stale one is honest — refusing the whole wave
        // because one hold-less order sits in the warehouse would block
        // waving entirely.
        if (selection !== null && liveOrderIds.length !== selectedOrderIds.length) {
          const holdless = selectedOrderIds.filter((orderId) => !liveOrderIds.includes(orderId));
          throw noEligibleOrders(
            `Order(s) ${holdless.map((id) => `"${id}"`).join(', ')} hold no live reservation — ` +
              `their holds were released, expired or already consumed, so there is nothing to pick.`,
          );
        }

        // ── the plan: bin walk (bins.code asc) × FEFO within the bin ──────
        const slices = await this.planSlices(tx, command, pickable);

        // ── the writes ────────────────────────────────────────────────────
        const waveId = uuidv7();
        await tx.insert(waves).values({
          id: waveId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          policyId: policy.id,
          status: 'planned',
        });

        const groups: { picklistId: string; orderId: string | null; slices: PlannedSlice[] }[] =
          policy.grouping === 'batch'
            ? [{ picklistId: uuidv7(), orderId: null, slices: [...slices] }]
            : liveOrderIds.map((orderId) => ({
                picklistId: uuidv7(),
                orderId,
                slices: slices.filter((slice) => slice.orderId === orderId),
              }));

        await tx.insert(picklists).values(
          groups.map((group) => ({
            id: group.picklistId,
            tenantId: command.tenantId,
            warehouseId: command.warehouseId,
            waveId,
            orderId: group.orderId,
            status: 'planned',
          })),
        );

        const lineValues = groups.flatMap((group) =>
          sortWalk(group.slices).map((slice, walkSeq) => ({
            id: uuidv7(),
            tenantId: command.tenantId,
            picklistId: group.picklistId,
            waveId,
            orderId: slice.orderId,
            orderLineId: slice.orderLineId,
            skuId: slice.skuId,
            binId: slice.binId,
            binCode: slice.binCode,
            batchId: slice.batchId,
            reservationId: slice.reservationId,
            qty: slice.qty,
            shortfallQty: slice.shortfallQty,
            sliceSeq: slice.sliceSeq,
            walkSeq,
            status: slice.status,
          })),
        );
        try {
          await tx.insert(picklistLines).values(lineValues);
        } catch (err) {
          if (isUniqueViolationOn(err, OPEN_ORDER_LINE_UNIQUE)) {
            // A concurrent generate claimed one of these orders first. This
            // transaction rolls back whole (nothing written), and the winner
            // is re-read outside it — the deterministic loser outcome.
            throw new WaveClaimLostError(command.tenantId, liveOrderIds);
          }
          throw err;
        }

        const snapshot = await this.snapshotById(tx, command.tenantId, waveId);
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'wave.generated',
          occurredAt: nowIso(),
          payload: { wave: snapshot.wave },
        });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'wave.generated',
          targetType: 'wave',
          targetId: waveId,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });
        await this.writeIdempotencyKey(
          tx,
          command.tenantId,
          idempotencyKey,
          payloadHash,
          snapshot,
        );
        return snapshot;
      });
    } catch (err) {
      if (err instanceof WaveClaimLostError) {
        throw await this.claimConflict(err.tenantId, err.orderIds);
      }
      throw err;
    }
  }

  // ── release ────────────────────────────────────────────────────────────────

  /**
   * `POST .../waves/{id}/release` (waves.manage): the transition that makes
   * a wave the floor's work — the wave flips `planned → released` through
   * ONE conditional UPDATE, its picklists go `ready`, and the outbox event,
   * the audit row and the idempotency key commit WITH that flip (flip-first,
   * the 4.1 shape). The flip's winner alone emits them.
   *
   * Two things settle here, both with the flip:
   *   - a policy cutoff that has already passed in the Kolkata-local day
   *     refuses the release 409 `cutoff-passed` and writes nothing (the wave
   *     stays `planned`, re-releasable tomorrow);
   *   - an order cancelled after being planned onto this wave has its pick
   *     lines DELETED — a cancelled order's stock is not the floor's to
   *     pick, and its holds were already released by the cancellation. A
   *     picklist left with nothing to pick is cancelled rather than shipped
   *     to the floor empty.
   *
   * A replay under the original key re-serves the stored snapshot; a release
   * of an already-released wave under a NEW key is an idempotent no-op (200
   * snapshot, no second `wave.released` event).
   */
  async releaseWave(
    command: WaveTransitionCommand,
    idempotencyKey: string,
  ): Promise<WaveSnapshot> {
    // The action rides the hash: release and cancel would otherwise be
    // distinguished only by a field one of them happens to omit, so a key
    // reused across the two must 422 rather than replay the wrong outcome.
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      waveId: command.waveId,
      action: 'release',
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'waves.manage',
      );
      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return replay as WaveSnapshot;
      }

      const wave = await this.loadWaveForUpdate(tx, command.tenantId, command.waveId);
      if (wave.status === 'cancelled') {
        throw new ProblemException(
          'conflict',
          409,
          'Wave is cancelled',
          `Wave "${wave.id}" is cancelled — a cancelled wave is never released.`,
        );
      }
      if (wave.status === 'released') {
        // The idempotent no-op under a new key: no second event, no second
        // audit row. The key is recorded against the settled snapshot so the
        // replay contract holds for this caller too.
        const snapshot = await this.snapshotById(tx, command.tenantId, wave.id);
        await this.writeIdempotencyKey(
          tx,
          command.tenantId,
          idempotencyKey,
          payloadHash,
          snapshot,
        );
        return snapshot;
      }

      // ── the cutoff gate: nothing is written past it ────────────────────
      const policy = await this.loadPolicy(tx, command.tenantId, wave.policyId);
      if (policy.cutoffLocalTime !== null) {
        const nowLocal = localTimeOfDay(this.clock.now());
        if (nowLocal > policy.cutoffLocalTime) {
          throw new ProblemException(
            'cutoff-passed',
            409,
            'Wave policy cutoff has passed',
            `Policy "${policy.name}" cuts off at ${policy.cutoffLocalTime} ${WAVE_CUTOFF_TIMEZONE}; it is ${nowLocal} there now. The wave stays planned.`,
          );
        }
      }

      // ── flip first, then the dependent writes in the same commit ───────
      const updates = await tx
        .update(waves)
        .set({ status: 'released', releasedAt: nowIso(), updatedAt: nowIso() })
        .where(
          and(
            eq(waves.id, wave.id),
            eq(waves.tenantId, command.tenantId),
            eq(waves.status, 'planned'),
          ),
        )
        .returning();
      const winner = updates[0];

      if (winner !== undefined) {
        // An order cancelled while this wave was planned drops out of it
        // here: its pick lines leave the walk and the freed
        // `(order_line, slice)` claims leave the partial unique index.
        // They are FLIPPED, not deleted — `cancelWave` frees claims the same
        // way, and one disposal semantic beats two; the row also keeps the
        // record that those units were once planned onto this wave.
        await tx
          .update(picklistLines)
          .set({ status: 'cancelled', updatedAt: nowIso() })
          .where(
            and(
              eq(picklistLines.tenantId, command.tenantId),
              eq(picklistLines.waveId, wave.id),
              sql`${picklistLines.status} <> 'cancelled'`,
              sql`exists (select 1 from ${orders} o where o.id = ${picklistLines.orderId} and o.tenant_id = ${picklistLines.tenantId} and o.status <> 'accepted')`,
            ),
          );
        // A picklist with nothing PICKABLE left is not the floor's work: a
        // picklist whose every line is `unfulfillable` (no bin) would
        // otherwise read `ready` and reach the floor with zero stops.
        await tx
          .update(picklists)
          .set({ status: 'cancelled', updatedAt: nowIso() })
          .where(
            and(
              eq(picklists.tenantId, command.tenantId),
              eq(picklists.waveId, wave.id),
              eq(picklists.status, 'planned'),
              sql`not exists (
                select 1 from ${picklistLines} pl
                where pl.picklist_id = ${picklists.id}
                  and pl.status <> 'cancelled'
                  and pl.bin_id is not null
              )`,
            ),
          );
        await tx
          .update(picklists)
          .set({ status: 'ready', updatedAt: nowIso() })
          .where(
            and(
              eq(picklists.tenantId, command.tenantId),
              eq(picklists.waveId, wave.id),
              eq(picklists.status, 'planned'),
            ),
          );
      }

      const snapshot = await this.snapshotById(tx, command.tenantId, wave.id);
      if (winner !== undefined) {
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'wave.released',
          occurredAt: nowIso(),
          payload: { wave: snapshot.wave },
        });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'wave.released',
          targetType: 'wave',
          targetId: wave.id,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });
      }
      await this.writeIdempotencyKey(
        tx,
        command.tenantId,
        idempotencyKey,
        payloadHash,
        snapshot,
      );
      return snapshot;
    });
  }

  // ── cancellation ───────────────────────────────────────────────────────────

  /**
   * `POST .../waves/{id}/cancel` (waves.manage): a planned or released wave
   * is withdrawn — every picklist and every pick line flips `cancelled`,
   * which drops the lines out of the one-open-wave partial unique index and
   * makes the wave's orders eligible for waving again. No reservation moves
   * (the orders keep their holds — they are still accepted) and no stock
   * moves (nothing has been picked; picking arrives in 4.3).
   */
  async cancelWave(
    command: WaveTransitionCommand,
    idempotencyKey: string,
  ): Promise<WaveSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      waveId: command.waveId,
      action: 'cancel',
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'waves.manage',
      );
      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return replay as WaveSnapshot;
      }

      const wave = await this.loadWaveForUpdate(tx, command.tenantId, command.waveId);
      if (wave.status === 'cancelled') {
        const snapshot = await this.snapshotById(tx, command.tenantId, wave.id);
        await this.writeIdempotencyKey(
          tx,
          command.tenantId,
          idempotencyKey,
          payloadHash,
          snapshot,
        );
        return snapshot;
      }

      const updates = await tx
        .update(waves)
        .set({ status: 'cancelled', cancelledAt: nowIso(), updatedAt: nowIso() })
        .where(
          and(
            eq(waves.id, wave.id),
            eq(waves.tenantId, command.tenantId),
            inArray(waves.status, ['planned', 'released']),
          ),
        )
        .returning();
      const winner = updates[0];

      if (winner !== undefined) {
        // The lines stop claiming their orders in the same commit as the
        // flip — the partial unique index's predicate is `status <>
        // 'cancelled'`, so this IS what frees the orders.
        await tx
          .update(picklistLines)
          .set({ status: 'cancelled', updatedAt: nowIso() })
          .where(
            and(
              eq(picklistLines.tenantId, command.tenantId),
              eq(picklistLines.waveId, wave.id),
            ),
          );
        await tx
          .update(picklists)
          .set({ status: 'cancelled', updatedAt: nowIso() })
          .where(and(eq(picklists.tenantId, command.tenantId), eq(picklists.waveId, wave.id)));
      }

      const snapshot = await this.snapshotById(tx, command.tenantId, wave.id);
      if (winner !== undefined) {
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'wave.cancelled',
          occurredAt: nowIso(),
          payload: { wave: snapshot.wave },
        });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'wave.cancelled',
          targetType: 'wave',
          targetId: wave.id,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });
      }
      await this.writeIdempotencyKey(
        tx,
        command.tenantId,
        idempotencyKey,
        payloadHash,
        snapshot,
      );
      return snapshot;
    });
  }

  // ── selection ──────────────────────────────────────────────────────────────

  /**
   * The wave's order selection. An explicit selection earns precise
   * refusals (an unknown order 404s, a non-accepted order and an order
   * already on an open wave are named); an omitted selection sweeps every
   * eligible accepted order in the warehouse, oldest first.
   *
   * `FOR UPDATE` on the order rows keeps a cancellation from landing
   * between the eligibility read and the plan — the lock is taken in a
   * stable `(created_at, id)` order, which is also the order 4.1's cancel
   * path takes it in, so concurrent commands queue rather than deadlock.
   */
  private async selectOrders(
    tx: TenantTx,
    command: GenerateWaveCommand,
    policy: WavePolicy,
    selection: readonly string[] | null,
  ): Promise<string[]> {
    const cap = policy.maxOrders ?? DEFAULT_WAVE_MAX_ORDERS;

    if (selection !== null) {
      const rows = await tx
        .select({ id: orders.id, status: orders.status, warehouseId: orders.warehouseId })
        .from(orders)
        .where(and(eq(orders.tenantId, command.tenantId), inArray(orders.id, [...selection])))
        .orderBy(asc(orders.createdAt), asc(orders.id))
        .for('update');
      const found = new Map(rows.map((row) => [row.id, row]));
      for (const orderId of selection) {
        const row = found.get(orderId);
        if (row === undefined || row.warehouseId !== command.warehouseId) {
          throw new ProblemException(
            'not-found',
            404,
            'Order not found',
            `No order with id "${orderId}" exists in this warehouse.`,
          );
        }
        if (row.status !== 'accepted') {
          throw noEligibleOrders(
            `Order "${orderId}" is ${row.status} — a wave draws only accepted orders.`,
          );
        }
      }
      const claimed = await this.openClaims(tx, command.tenantId, [...selection]);
      const firstClaim = claimed[0];
      if (firstClaim !== undefined) {
        throw openWaveConflict(firstClaim.orderId, firstClaim.waveId);
      }
      if (selection.length > cap) {
        throw new ProblemException(
          'wave-cap-exceeded',
          422,
          'Selection exceeds the policy cap',
          `Policy "${policy.name}" waves at most ${cap} orders; the selection names ${selection.length}. Narrow the selection or raise the policy's maxOrders.`,
        );
      }
      // Oldest first — the same order the walk and the picklists are built in.
      return rows.map((row) => row.id);
    }

    const rows = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, command.tenantId),
          eq(orders.warehouseId, command.warehouseId),
          eq(orders.status, 'accepted'),
          sql`not exists (select 1 from ${picklistLines} pl where pl.tenant_id = ${orders.tenantId} and pl.order_id = ${orders.id} and pl.status <> 'cancelled')`,
        ),
      )
      .orderBy(asc(orders.createdAt), asc(orders.id))
      .limit(cap)
      .for('update');
    if (rows.length === 0) {
      throw noEligibleOrders(
        'No accepted order in this warehouse is free to wave — every one is already on an open wave, or none exists.',
      );
    }
    return rows.map((row) => row.id);
  }

  /** The open (non-cancelled) wave claims held over a set of orders. */
  private async openClaims(
    tx: TenantTx,
    tenantId: string,
    orderIds: readonly string[],
  ): Promise<{ orderId: string; waveId: string }[]> {
    if (orderIds.length === 0) {
      return [];
    }
    return tx
      .selectDistinct({ orderId: picklistLines.orderId, waveId: picklistLines.waveId })
      .from(picklistLines)
      .where(
        and(
          eq(picklistLines.tenantId, tenantId),
          inArray(picklistLines.orderId, [...orderIds]),
          sql`${picklistLines.status} <> 'cancelled'`,
        ),
      );
  }

  /** The concurrent-claim loser's outcome: re-read the winner, name it. */
  private async claimConflict(
    tenantId: string,
    orderIds: readonly string[],
  ): Promise<ProblemException> {
    const claims = await withTenantTransaction(this.db, tenantId, (tx) =>
      this.openClaims(tx, tenantId, orderIds),
    );
    const claim = claims[0];
    if (claim === undefined) {
      // The winner rolled back after all — the caller retries against a
      // settled state (4.1's dedup-loser precedent).
      return new ProblemException(
        'conflict',
        409,
        'Concurrent wave generation',
        'The same orders are being waved concurrently; retry to read the settled result.',
      );
    }
    return openWaveConflict(claim.orderId, claim.waveId);
  }

  // ── planning ───────────────────────────────────────────────────────────────

  /**
   * Plans every order line's slices against the warehouse's pickable stock.
   *
   * The walk is `bins.code` ascending. Bins carry no spatial data — no
   * aisle/rack/level/sequence column exists — and the grid generator's
   * `A-01-01` (aisle-bay-level) convention sorts naturally, so code order IS
   * the walk for grid-generated warehouses and is stable-but-arbitrary for
   * hand-created codes. This matches putaway's capacity-only v1 honesty; a
   * real `pick_sequence` needs a maintenance surface nobody has designed.
   *
   * Within one bin, batches rank FEFO (expiry ascending, nulls last) and
   * neither a blocked batch nor an expired one is ever suggested. A SKU with
   * no batch rows in a bin draws against the plain projection and its line
   * names no batch.
   *
   * The pool is consumed as it is planned, so two lines of the same SKU
   * never both claim the same units — that honesty is exactly what makes the
   * batch-vs-single stop-count inequality hold.
   */
  private async planSlices(
    tx: TenantTx,
    command: GenerateWaveCommand,
    lines: readonly (typeof orderLines.$inferSelect)[],
  ): Promise<PlannedSlice[]> {
    const skuIds = [...new Set(lines.map((line) => line.skuId))];

    // The warehouse's pickable bins, in walk order. The filter set is
    // putaway's (`binCandidatesInTx`): a blocked bin, a system-owned bin
    // (Receiving, QC hold) and a retired bin are all unpickable — which is
    // also why QC-held stock never plans: a hold MOVES it into the
    // system-owned QC bin.
    const pickableBins = await tx
      .select({ id: bins.id, code: bins.code })
      .from(bins)
      .where(
        and(
          eq(bins.tenantId, command.tenantId),
          eq(bins.warehouseId, command.warehouseId),
          eq(bins.blocked, false),
          eq(bins.systemOwned, false),
          isNull(bins.retiredAt),
        ),
      )
      .orderBy(asc(bins.code), asc(bins.id));
    const binCodes = new Map(pickableBins.map((bin) => [bin.id, bin.code]));
    const binRank = new Map(pickableBins.map((bin, index) => [bin.id, index]));

    // Stock composes through the facades only (AD-6).
    const [stock, batchStock, batchIdentities] = await Promise.all([
      this.inventory.stockByBinsInTx(tx, command.tenantId, command.warehouseId, skuIds),
      this.inventory.batchOnHandByBinsInTx(tx, command.tenantId, command.warehouseId, skuIds),
      this.catalog.getBatchesForSkusInTx(tx, command.tenantId, skuIds),
    ]);
    const now = this.clock.now().getTime();
    const batchById = new Map(batchIdentities.map((batch) => [batch.id, batch]));
    const drawableBatch = (batchId: string): boolean => {
      const batch = batchById.get(batchId);
      if (batch === undefined || batch.status !== 'active') {
        // A blocked batch is never drawn (epic-2 retro a13, draw side); an
        // identity the catalog does not know is not suggestible either.
        return false;
      }
      return batch.expiryDate === null || Date.parse(batch.expiryDate) >= now;
    };
    const expiryOf = (batchId: string): string | null => batchById.get(batchId)?.expiryDate ?? null;

    // The per-SKU walk: (bin in code order) × (batch in FEFO order).
    const pool = new Map<string, StockSlot[]>();
    for (const skuId of skuIds) {
      const slots: StockSlot[] = [];
      const plainRows = stock
        .filter((row) => row.skuId === skuId && binRank.has(row.binId))
        .sort((a, b) => binRank.get(a.binId)! - binRank.get(b.binId)!);
      for (const row of plainRows) {
        const binCode = binCodes.get(row.binId)!;
        const batchRows = batchStock.filter(
          (batch) => batch.skuId === skuId && batch.binId === row.binId,
        );
        if (batchRows.length === 0) {
          // An untracked SKU (or a bin whose batch projection is empty):
          // the plain projection row IS the drawable quantity.
          slots.push({ binId: row.binId, binCode, batchId: null, remaining: row.quantity });
          continue;
        }
        const drawable = batchRows
          .filter((batch) => drawableBatch(batch.batchId))
          // FEFO: expiry ASC, nulls LAST (a batch without expiry draws last).
          .sort((a, b) => {
            const left = expiryOf(a.batchId);
            const right = expiryOf(b.batchId);
            if (left === right) return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
            if (left === null) return 1;
            if (right === null) return -1;
            return left < right ? -1 : 1;
          });
        // What the batch projection accounts for in this bin — drawable or
        // not. Anything ABOVE it is batch-less stock the batch fold has not
        // (or cannot) attribute: it exists, it is pickable, and stranding it
        // would plan a shortfall against stock that is right there. It draws
        // with no batch suggestion and 4.3 re-derives one. Units held by a
        // blocked or expired batch are accounted for here and therefore
        // never resurface in this remainder — they stay undrawable.
        const accounted = batchRows.reduce((sum, batch) => sum + batch.quantity, 0);
        const uncovered = Math.max(0, row.quantity - accounted);
        // The bin's plain projection is the ceiling for the WHOLE bin, not
        // for each batch in it: two batches of 10 in a bin holding 10 plan
        // 10 drawable units, never 20. One fold maintains both projections
        // so they normally agree — this budget is what keeps a divergent one
        // from over-planning instead of trusting it.
        let binBudget = row.quantity - uncovered;
        for (const batch of drawable) {
          if (binBudget <= 0) break;
          const remaining = Math.min(batch.quantity, binBudget);
          binBudget -= remaining;
          slots.push({ binId: row.binId, binCode, batchId: batch.batchId, remaining });
        }
        if (uncovered > 0) {
          slots.push({ binId: row.binId, binCode, batchId: null, remaining: uncovered });
        }
      }
      pool.set(skuId, slots);
    }

    const planned: PlannedSlice[] = [];
    for (const line of lines) {
      // Every quantity a picklist names is the order line's `reserved_qty`,
      // never `qty`: a backordered line contributes only what acceptance
      // actually held.
      let need = line.reservedQty;
      let sliceSeq = 0;
      for (const slot of pool.get(line.skuId) ?? []) {
        if (need === 0) break;
        if (slot.remaining <= 0) continue;
        const take = Math.min(need, slot.remaining);
        slot.remaining -= take;
        need -= take;
        planned.push({
          orderId: line.orderId,
          orderLineId: line.id,
          skuId: line.skuId,
          reservationId: line.reservationId,
          binId: slot.binId,
          binCode: slot.binCode,
          batchId: slot.batchId,
          qty: take,
          shortfallQty: 0,
          sliceSeq,
          status: 'planned',
        });
        sliceSeq += 1;
      }
      if (need > 0) {
        // Reserved units with nowhere pickable to draw them from. The wave
        // still generates — the shortfall is named, not hidden, and 4.4's
        // short-pick re-planning is where it is resolved.
        planned.push({
          orderId: line.orderId,
          orderLineId: line.id,
          skuId: line.skuId,
          reservationId: line.reservationId,
          binId: null,
          binCode: null,
          batchId: null,
          qty: 0,
          shortfallQty: need,
          sliceSeq,
          status: 'unfulfillable',
        });
      }
    }
    return planned;
  }

  // ── shared pieces ──────────────────────────────────────────────────────────

  private async loadPolicy(tx: TenantTx, tenantId: string, policyId: string): Promise<WavePolicy> {
    const rows = await tx
      .select()
      .from(wavePolicies)
      .where(and(eq(wavePolicies.id, policyId), eq(wavePolicies.tenantId, tenantId)))
      .limit(1);
    const policy = rows[0];
    if (policy === undefined) {
      throw policyNotFound(policyId);
    }
    return policy;
  }

  private async loadWaveForUpdate(
    tx: TenantTx,
    tenantId: string,
    waveId: string,
  ): Promise<Wave> {
    // Both transitions load through here, so this is the single boundary
    // that keeps a malformed id off the `::uuid` cast for non-HTTP callers.
    if (!UUID_RE.test(waveId)) {
      throw validationFailed('waveId must be a uuid.');
    }
    const rows = await tx
      .select()
      .from(waves)
      .where(and(eq(waves.id, waveId), eq(waves.tenantId, tenantId)))
      .limit(1)
      .for('update');
    const wave = rows[0];
    if (wave === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'Wave not found',
        `No wave with id "${waveId}" exists in this tenant.`,
      );
    }
    return wave;
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<unknown | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (row === undefined) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return row.responseSnapshot;
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: unknown,
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({
        id: uuidv7(),
        tenantId,
        key: idempotencyKey,
        payloadHash,
        responseSnapshot: snapshot,
      });
    } catch (err) {
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        throw new ProblemException(
          'conflict',
          409,
          'Concurrent idempotent request',
          'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
        );
      }
      throw err;
    }
  }

  private async snapshotById(
    tx: TenantTx,
    tenantId: string,
    waveId: string,
  ): Promise<WaveSnapshot> {
    const rows = await tx
      .select()
      .from(waves)
      .where(and(eq(waves.id, waveId), eq(waves.tenantId, tenantId)))
      .limit(1);
    return this.snapshotOf(tx, rows[0]!);
  }

  /**
   * The wave + its picklists + their lines in WALK ORDER, as one snapshot —
   * the single serializer both the commands and the facade's reads compose
   * (no drift between what a write answers and what a read returns).
   */
  async snapshotOf(tx: TenantTx, wave: Wave): Promise<WaveSnapshot> {
    // The app-layer `WHERE tenant_id` stays authoritative and RLS is the
    // backstop, never the other way round (AD-3) — same as every other query
    // in this file.
    const lists = await tx
      .select()
      .from(picklists)
      .where(and(eq(picklists.tenantId, wave.tenantId), eq(picklists.waveId, wave.id)))
      .orderBy(asc(picklists.createdAt), asc(picklists.id));
    const lines =
      lists.length === 0
        ? []
        : await tx
            .select()
            .from(picklistLines)
            .where(
              and(eq(picklistLines.tenantId, wave.tenantId), eq(picklistLines.waveId, wave.id)),
            )
            .orderBy(asc(picklistLines.picklistId), asc(picklistLines.walkSeq), asc(picklistLines.id));
    return {
      wave: {
        id: wave.id,
        tenantId: wave.tenantId,
        warehouseId: wave.warehouseId,
        policyId: wave.policyId,
        status: wave.status as WaveStatus,
        releasedAt: wave.releasedAt === null ? null : canonicalInstant(wave.releasedAt),
        cancelledAt: wave.cancelledAt === null ? null : canonicalInstant(wave.cancelledAt),
        createdAt: canonicalInstant(wave.createdAt),
        updatedAt: canonicalInstant(wave.updatedAt),
        picklists: lists.map((list) =>
          picklistSnapshot(
            list,
            lines.filter((line) => line.picklistId === list.id),
          ),
        ),
      },
    };
  }
}

// ── serializers ──────────────────────────────────────────────────────────────

export function policySnapshot(row: WavePolicy): WavePolicySnapshotBody {
  return {
    id: row.id,
    tenantId: row.tenantId,
    warehouseId: row.warehouseId,
    name: row.name,
    grouping: row.grouping as WaveGrouping,
    priority: row.priority,
    maxOrders: row.maxOrders,
    cutoffLocalTime: row.cutoffLocalTime,
    // The comparison timezone rides the read so no client has to guess it.
    cutoffTimezone: WAVE_CUTOFF_TIMEZONE,
    carrierRef: row.carrierRef,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

export function picklistSnapshot(
  row: Picklist,
  lines: readonly PicklistLine[],
): PicklistSnapshot {
  const ordered = [...lines].sort((a, b) => a.walkSeq - b.walkSeq);
  return {
    id: row.id,
    waveId: row.waveId,
    orderId: row.orderId,
    status: row.status as PicklistStatus,
    // "Steps" in the acceptance criterion means DISTINCT BIN STOPS — a batch
    // picklist visits each bin once however many lines it picks there. A
    // cancelled line (its order was cancelled, or the wave was) is off the
    // walk and is not a stop.
    stopCount: new Set(
      ordered
        .filter((line) => line.binId !== null && line.status !== 'cancelled')
        .map((line) => line.binId),
    ).size,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
    lines: ordered.map(lineSnapshot),
  };
}

export function lineSnapshot(row: PicklistLine): PicklistLineSnapshot {
  return {
    id: row.id,
    picklistId: row.picklistId,
    orderId: row.orderId,
    orderLineId: row.orderLineId,
    skuId: row.skuId,
    binId: row.binId,
    binCode: row.binCode,
    batchId: row.batchId,
    reservationId: row.reservationId,
    qty: row.qty,
    shortfallQty: row.shortfallQty,
    sliceSeq: row.sliceSeq,
    walkSeq: row.walkSeq,
    status: row.status as PicklistLineStatus,
    createdAt: canonicalInstant(row.createdAt),
  };
}

// ── walk ordering ────────────────────────────────────────────────────────────

/**
 * The walk: `bins.code` ascending, so every line for one bin is contiguous
 * and the bin is visited ONCE — which is the whole batch-picklist promise.
 * Unfulfillable slices carry no bin and sort last (they are not stops).
 * Ties break deterministically (sku, order, slice) so a regenerated plan is
 * byte-identical.
 */
function sortWalk(slices: readonly PlannedSlice[]): PlannedSlice[] {
  return [...slices].sort((a, b) => {
    // U+FFFF sorts after every assignable code point: a bin-less
    // (unfulfillable) slice always lands at the end of the walk.
    const left = a.binCode ?? '\uFFFF';
    const right = b.binCode ?? '\uFFFF';
    if (left !== right) return left < right ? -1 : 1;
    if (a.skuId !== b.skuId) return a.skuId < b.skuId ? -1 : 1;
    if (a.orderId !== b.orderId) return a.orderId < b.orderId ? -1 : 1;
    if (a.orderLineId !== b.orderLineId) return a.orderLineId < b.orderLineId ? -1 : 1;
    return a.sliceSeq - b.sliceSeq;
  });
}

/**
 * The wall-clock `HH:MM` of an instant in `WAVE_CUTOFF_TIMEZONE` — the ONE
 * place local time enters the system (AD-9: everything stored is UTC; a
 * policy cutoff is a recurring local wall clock, not an instant).
 */
export function localTimeOfDay(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: WAVE_CUTOFF_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;
  if (hour === undefined || minute === undefined) {
    // A refusal gate must fail CLOSED. Defaulting to '00:00' here would
    // compare below every cutoff and wave every late release straight
    // through — the one failure mode this whole check exists to prevent.
    throw new Error(
      `Cannot read the wall clock in ${WAVE_CUTOFF_TIMEZONE} — the runtime's Intl data is incomplete.`,
    );
  }
  return `${hour}:${minute}`;
}

// ── outcomes ─────────────────────────────────────────────────────────────────

function validationFailed(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Wave validation failed', detail);
}

function policyNotFound(policyId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Wave policy not found',
    `No wave policy with id "${policyId}" exists in this warehouse.`,
  );
}

function noEligibleOrders(detail: string): ProblemException {
  return new ProblemException('no-eligible-orders', 422, 'No eligible orders to wave', detail);
}

function openWaveConflict(orderId: string, waveId: string): ProblemException {
  return new ProblemException(
    'conflict',
    409,
    'Order is already on an open wave',
    `Order "${orderId}" is already planned onto wave "${waveId}" — one order belongs to at most one open wave. Cancel that wave to re-wave the order.`,
  );
}

/**
 * The concurrent-claim-loser marker: thrown inside the generate transaction
 * (its rollback discards the whole plan) and resolved against the settled
 * winner outside it — the 4.1 `DedupLostError` shape.
 */
class WaveClaimLostError extends Error {
  constructor(
    readonly tenantId: string,
    readonly orderIds: readonly string[],
  ) {
    super('a concurrent generate claimed one of these orders first');
  }
}
