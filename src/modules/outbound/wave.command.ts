import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
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
import { canonicalInstant, istDateOf, nowIso } from '../../shared/primitives/time';
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
import { buildStockPool, pickableBinsInTx } from './replan';
import { allocationPoliciesInTx, DEFAULT_ALLOCATION_POLICY } from '../clients/clients.facade';
import {
  consigneeMinimumDays,
  meetsConsigneeShelfLife,
  type AllocationRule,
  type ConsigneeArm,
  type ShortfallCause,
} from '../../shared/primitives/batch-allocation';
// Story 4-3b — the consignee shelf-life rule resolves through the partners
// seam (decision 2: the order's consignee GSTIN ⋈ the client's consignee link).
import { consigneeRuleKey, consigneeShelfLifeRulesInTx, partnerNamesInTx } from '../partners/partners.facade';
import type { BatchFacts } from '../catalog/catalog.facade';
import { WAVE_CLOCK } from './wave.clock';
import type { WaveClock } from './wave.clock';
import { fromMilli } from '../../shared/primitives/quantity';
import {
  compareOrderUrgency,
  foldOrderUrgency,
  orderUrgencyOrderBy,
  type OrderPriority,
} from './order-urgency';

// ── state machines + policy constants (the outbound module exclusively owns
// the wave/picklist state machines, AD-6 — the additive arms below are the
// module's registry, mirrored by the DB CHECKs in migration 0018) ───────────

/** The wave lifecycle arms shipped in story 4.2 (additive: 4.3/4.5 extend). */
export const WAVE_STATUSES = ['planned', 'released', 'cancelled'] as const;
export type WaveStatus = (typeof WAVE_STATUSES)[number];

/** The picklist lifecycle arms shipped in story 4.2. */
export const PICKLIST_STATUSES = ['planned', 'ready', 'cancelled'] as const;
export type PicklistStatus = (typeof PICKLIST_STATUSES)[number];

/**
 * The pick-line arms: 4.2 shipped `planned` / `unfulfillable` / `cancelled`;
 * story 4.3 appends `picked` and story 4.4 appends `short` (additive — the
 * DB CHECKs in migrations 0019 and 0022 mirror them). Both deliberately sit
 * OUTSIDE `'cancelled'`, so the line stays inside the
 * `picklist_lines_open_order_line_unique` partial index: dropping out of it
 * would free the order to be re-waved while its units were being picked, and
 * the second wave would plan the same reserved stock.
 *
 * `short` is TERMINAL — a short-picked stop is never re-picked. The
 * remainder, when it can be re-planned at all, lives on a NEW slice with its
 * own id, reservation and walk position; this line stays the honest record of
 * what happened at that bin (`qty` planned, `shortfall_qty` never drawn,
 * `reason_code` why) — the SM-3 signal.
 */
export const PICKLIST_LINE_STATUSES = ['planned', 'unfulfillable', 'picked', 'short', 'cancelled'] as const;
export type PicklistLineStatus = (typeof PICKLIST_LINE_STATUSES)[number];

/**
 * "This slice actually drew units through the ledger" — the predicate BOTH
 * cancel paths key on, kept in one place so they can never drift apart.
 *
 * A `picked` line always drew its whole quantity. A `short` line drew
 * `qty - shortfall_qty`, which is ZERO on the report of an empty bin: nothing
 * left that shelf, so nothing about it should stop an order being cancelled
 * or stop its order line being waved again once stock arrives. Keying either
 * path on `status = 'short'` alone would strand a zero-unit report forever
 * inside `picklist_lines_open_order_line_unique`.
 */
export function picklistLineDrewUnits(): SQL {
  return sql`(${picklistLines.status} = 'picked' or (${picklistLines.status} = 'short' and ${picklistLines.shortfallQty} < ${picklistLines.qty}))`;
}

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

/**
 * Story 9-2b — the event the cutoff sweep raises when a PLANNED wave is
 * inside the at-risk window of its policy cutoff (once per wave per IST
 * date). Payload `{waveId, warehouseId, cutoffLocalTime, istDate}`. The
 * notifications module queues the at-risk push from it.
 */
export const WAVE_CUTOFF_AT_RISK_EVENT = 'wave.cutoff_at_risk';

/**
 * The at-risk window, in minutes before the cutoff — the web's
 * `AT_RISK_THRESHOLD_MINUTES` (wms-fe `lib/outbound-waves.ts`), so the amber
 * chip and the push agree: `0 < minutes to cutoff <= 60`.
 */
export const CUTOFF_AT_RISK_MINUTES = 60;

/** `HH:MM` → minutes past midnight. */
function minutesOfDay(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** What one cutoff sweep did. */
export interface CutoffSweepResult {
  /** The waves whose `wave.cutoff_at_risk` was raised by this call. */
  readonly raised: readonly string[];
}

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
  /**
   * Uncovered units — non-zero on an `unfulfillable` slice (nothing pickable
   * was ever found) and on a `short` one (story 4.4: the operator drew fewer
   * units than the stop planned, so `qty - shortfallQty` is what moved).
   */
  readonly shortfallQty: number;
  /** Story 4.4: why a `short` line came up short; null on every other line. */
  readonly reasonCode: string | null;
  readonly sliceSeq: number;
  readonly walkSeq: number;
  readonly status: PicklistLineStatus;
  readonly createdAt: string;
  /**
   * Story 4-3a — the suggested batch's code, its expiry (IST date) and the
   * date its lot was first received (IST date), plus the allocation policy
   * the line was planned under (frozen; both null on a pre-4-3a line).
   * OPTIONAL: a `WaveSnapshot` stored before 4-3a (a generate, release or
   * cancel replay) lacks them; every fresh read carries them.
   */
  readonly batchCode?: string | null;
  readonly batchExpiryDate?: string | null;
  readonly batchReceivedOn?: string | null;
  readonly allocationRule?: AllocationRule | null;
  readonly minOutboundShelfLifeDays?: number | null;
  /**
   * Story 4-3b — the consignee shelf-life rule the line was planned under
   * (frozen): the consignee's display name, its effective minimum in IST
   * days (null on an UNJUDGEABLE line — a percent rule over a SKU with no
   * total shelf life), the percent it was set with, and the SKU's total shelf
   * life the percent was converted from (frozen with it, A2). All
   * null when no consignee rule applied. `shortfallCause` names why an
   * `unfulfillable` slice was left short (A6; null = no stock at all).
   * OPTIONAL: a `WaveSnapshot` stored before 4-3b lacks them.
   */
  readonly consigneeName?: string | null;
  readonly consigneeMinShelfLifeDays?: number | null;
  readonly consigneeMinShelfLifePercent?: number | null;
  readonly consigneeShelfLifeBaseDays?: number | null;
  readonly shortfallCause?: ShortfallCause | null;
}

export interface PicklistSnapshot {
  readonly id: string;
  readonly waveId: string;
  /** The single order this picklist serves; null on a batch picklist. */
  readonly orderId: string | null;
  readonly status: PicklistStatus;
  /** Distinct bin stops on this picklist's walk (unfulfillable lines are none). */
  readonly stopCount: number;
  /**
   * Story 4-2a (A1) — the most urgent priority and the earliest ship-by date
   * among the orders of the picklist's NON-cancelled lines. Optional: a wave
   * snapshot stored before 4-2a (a generate or release replay) lacks them.
   */
  readonly priority?: OrderPriority | null;
  readonly shipByDate?: string | null;
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

/** One planned slice of one order line. */
export interface PlannedSlice {
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
  /** Story 4-3a — the SKU's client policy this slice was planned under (frozen on the line). */
  readonly allocationRule: AllocationRule;
  readonly minOutboundShelfLifeDays: number | null;
  /** Story 4-3b — the consignee rule this slice was planned under (frozen; all null when none). */
  readonly consigneePartnerId: string | null;
  readonly consigneeMinShelfLifeDays: number | null;
  readonly consigneeMinShelfLifePercent: number | null;
  /** Story 4-3b (A2) — the SKU total shelf life the percent was converted from (frozen; null without a percent or a base). */
  readonly consigneeShelfLifeBaseDays: number | null;
  /** Story 4-3b (A6) — why an `unfulfillable` slice is short (null = no stock at all). */
  readonly shortfallCause: ShortfallCause | null;
}

/**
 * Story 4-3a (A7) — Postgres binds at most 65,535 parameters per statement and
 * a multi-row insert binds one per column per row, so the picklist-line
 * insert is chunked at `floor(maxBindParams / columnCount)` rows (23 columns
 * → 2,849 since 4-3b's five consignee keys; every row carries every key, A5). The wave's order cap bounds orders, not rows (lines per order and
 * slices per line are unbounded). Mutable for the chunk-failure test only.
 */
export const picklistLineInsertTuning: { maxBindParams: number; onChunk?: ((rows: number) => void) | undefined } = { maxBindParams: 65_535 };

export function bindChunkRows(columnCount: number, maxBindParams = picklistLineInsertTuning.maxBindParams): number {
  return Math.max(1, Math.floor(maxBindParams / columnCount));
}

/**
 * The `picklist_lines` insert rows of a generated wave, in walk order per
 * group. Story 4-3b (A5): EVERY row carries EVERY column key (null when no
 * rule applies) — `bindChunkRows` derives the chunk size from the first
 * row's key count, so a row missing a key would undercount it. Pure; pinned
 * by `test/consignee-shelf-life-primitives.spec.ts`.
 */
export function picklistLineValues(
  tenantId: string,
  waveId: string,
  groups: readonly { readonly picklistId: string; readonly slices: readonly PlannedSlice[] }[],
) {
  return groups.flatMap((group) =>
    sortWalk(group.slices).map((slice, walkSeq) => ({
      id: uuidv7(),
      tenantId,
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
      // Story 4-3a — the policy FROZEN on the line (decision 7).
      allocationRule: slice.allocationRule,
      minOutboundShelfLifeDays: slice.minOutboundShelfLifeDays,
      // Story 4-3b (A5) — every row carries every key (null when no
      // rule applies): `bindChunkRows` counts the FIRST row's keys.
      consigneePartnerId: slice.consigneePartnerId,
      consigneeMinShelfLifeDays: slice.consigneeMinShelfLifeDays,
      consigneeMinShelfLifePercent: slice.consigneeMinShelfLifePercent,
      consigneeShelfLifeBaseDays: slice.consigneeShelfLifeBaseDays,
      shortfallCause: slice.shortfallCause,
    })),
  );
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

        // ── story 4-2a (A9): plan in SELECTION order ─────────────────────
        // `selectOrders` returns the orders by the urgency key; `planSlices`
        // consumes the stock pool destructively, so the order lines are
        // planned in that order and the urgent order draws the first-FEFO
        // stock (an all-normal, no-ship-by selection is oldest first, as
        // before). Within one order the lines keep their (created_at, id)
        // order. This replaces the old `orderId` order deliberately.
        const selectionRank = new Map(selectedOrderIds.map((orderId, index) => [orderId, index]));
        const planningOrder = [...pickable].sort(
          (a, b) => selectionRank.get(a.orderId)! - selectionRank.get(b.orderId)!,
        );

        // ── the plan: stock ranked by the client rule (4-3a), walked by bin ─
        const slices = await this.planSlices(tx, command, planningOrder);

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

        const lineValues = picklistLineValues(command.tenantId, waveId, groups);
        // Story 4-3a (A7) — chunked by the real bind arithmetic, every chunk
        // in THIS transaction: a claim lost in any chunk rolls the whole
        // plan back (nothing persists) and maps to `WaveClaimLostError`.
        const chunkRows = bindChunkRows(Object.keys(lineValues[0] ?? { id: null }).length);
        for (let start = 0; start < lineValues.length; start += chunkRows) {
          const chunk = lineValues.slice(start, start + chunkRows);
          picklistLineInsertTuning.onChunk?.(chunk.length);
          try {
            await tx.insert(picklistLines).values(chunk);
          } catch (err) {
            if (isUniqueViolationOn(err, OPEN_ORDER_LINE_UNIQUE)) {
              // A concurrent generate claimed one of these orders first. This
              // transaction rolls back whole (nothing written), and the winner
              // is re-read outside it — the deterministic loser outcome.
              throw new WaveClaimLostError(command.tenantId, liveOrderIds);
            }
            throw err;
          }
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
        //
        // Story 4.5 audit: this predicate used to read `status <> 'accepted'`
        // — a deny-list that, the moment the order machine grew a third arm,
        // would have swept a `ready_to_dispatch` order's lines too, flipping
        // already-PICKED lines to `cancelled` and dropping them out of
        // `picklist_lines_open_order_line_unique` — freeing the order to be
        // re-waved against units that had physically left the bin, the exact
        // hazard 0019 documents. It is now the `cancelled` allow-list it
        // always meant, so the drop says what it does and no future arm
        // joins it by accident.
        await tx
          .update(picklistLines)
          .set({ status: 'cancelled', updatedAt: nowIso() })
          .where(
            and(
              eq(picklistLines.tenantId, command.tenantId),
              eq(picklistLines.waveId, wave.id),
              sql`${picklistLines.status} <> 'cancelled'`,
              sql`exists (select 1 from ${orders} o where o.id = ${picklistLines.orderId} and o.tenant_id = ${picklistLines.tenantId} and o.status = 'cancelled')`,
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

  // ── the cutoff sweep (story 9-2b) ──────────────────────────────────────────

  /**
   * Raises `wave.cutoff_at_risk` for every PLANNED wave of the tenant whose
   * policy cutoff is `0 < r <= 60` minutes away in `WAVE_CUTOFF_TIMEZONE`
   * (read off `WAVE_CLOCK` through `localTimeOfDay` — the release gate's own
   * clock and wall-clock helper, so the sweep and the gate agree on the
   * minute), at most once per wave per IST date. One tenant transaction:
   * select the candidates, then per wave a CONDITIONAL marker write —
   * `cutoff_risk_alerted_on = <IST date> WHERE status = 'planned' AND
   * cutoff_risk_alerted_on IS DISTINCT FROM <IST date> RETURNING` — and the
   * event only when that write returned the row. A concurrent sweep (or a
   * second tick) finds the marker set and raises nothing; a released or
   * cancelled wave is never a candidate. A system sweep: no actor, no audit
   * row, no idempotency key (the replenishment sweep's posture).
   *
   * At the cutoff minute itself `r = 0` — release is still allowed, but the
   * warning would be moot, so nothing is raised; a cutoff that already
   * passed today (`r < 0`) raises nothing either.
   */
  async sweepCutoffRisk(tenantId: string): Promise<CutoffSweepResult> {
    const now = this.clock.now();
    const nowMinutes = minutesOfDay(localTimeOfDay(now));
    const istDate = istDateOf(now.toISOString());
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const candidates = await tx
        .select({
          id: waves.id,
          warehouseId: waves.warehouseId,
          cutoffLocalTime: wavePolicies.cutoffLocalTime,
        })
        .from(waves)
        .innerJoin(wavePolicies, and(eq(wavePolicies.id, waves.policyId), eq(wavePolicies.tenantId, waves.tenantId)))
        .where(
          and(
            eq(waves.tenantId, tenantId),
            eq(waves.status, 'planned'),
            sql`${wavePolicies.cutoffLocalTime} is not null`,
            sql`${waves.cutoffRiskAlertedOn} is distinct from ${istDate}::date`,
          ),
        )
        .orderBy(asc(waves.id));
      const raised: string[] = [];
      for (const candidate of candidates) {
        const cutoff = candidate.cutoffLocalTime;
        if (cutoff === null || !CUTOFF_RE.test(cutoff)) continue;
        const remaining = minutesOfDay(cutoff) - nowMinutes;
        if (remaining <= 0 || remaining > CUTOFF_AT_RISK_MINUTES) continue;
        const marked = await tx
          .update(waves)
          .set({ cutoffRiskAlertedOn: istDate })
          .where(
            and(
              eq(waves.id, candidate.id),
              eq(waves.tenantId, tenantId),
              eq(waves.status, 'planned'),
              sql`${waves.cutoffRiskAlertedOn} is distinct from ${istDate}::date`,
            ),
          )
          .returning({ id: waves.id });
        if (marked.length === 0) continue;
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId,
          type: WAVE_CUTOFF_AT_RISK_EVENT,
          occurredAt: now.toISOString(),
          payload: {
            waveId: candidate.id,
            warehouseId: candidate.warehouseId,
            cutoffLocalTime: cutoff,
            istDate,
          },
        });
        raised.push(candidate.id);
      }
      return { raised };
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
        //
        // Story 4.3: a `picked` line is NOT freed. Its units have physically
        // left the bin through a `pick.picked` ledger draw and its hold is
        // committed; dropping it out of the partial index would let a second
        // wave plan the same reserved units against stock that is already
        // gone. The picked slices stay claimed; the rest of the wave is
        // withdrawn as before.
        //
        // Story 4.4: a `short` line that actually DREW units is not freed
        // either — those units have left the bin exactly as a picked line's
        // have. A ZERO-unit short report is a different case: nothing moved,
        // so keeping its claim would wedge the order line out of every future
        // wave even after stock arrives. `picklistLineDrewUnits` is the one
        // predicate both cancel paths key on.
        //
        // Story 4.5, DEFENSIVE: the disposal is additionally scoped to the
        // order statuses whose lines may still be withdrawn. The consequence
        // is unreachable today — only non-drawing lines flip, and a
        // `ready_to_dispatch` order cannot be re-waved, so no packed order's
        // lines can be sitting on an open wave — but without the clause this
        // statement is free to flip lines a `pack.packed` event has already
        // journalled, which is the same trap `releaseWave`'s drop carried
        // until this story narrowed it, and 4.6's `dispatched` arm would walk
        // straight into it.
        //
        // An ALLOW-LIST, like every other order-status guard this story
        // audited, so a new arm must be admitted deliberately rather than
        // inheriting withdrawal by default. `cancelled` rides it beside
        // `accepted`: a cancelled order's lines are exactly what a wave
        // cancel is meant to free, and dropping them would leave `planned`
        // rows holding `picklist_lines_open_order_line_unique` forever.
        await tx
          .update(picklistLines)
          .set({ status: 'cancelled', updatedAt: nowIso() })
          .where(
            and(
              eq(picklistLines.tenantId, command.tenantId),
              eq(picklistLines.waveId, wave.id),
              sql`not ${picklistLineDrewUnits()}`,
              sql`exists (select 1 from ${orders} o where o.id = ${picklistLines.orderId} and o.tenant_id = ${picklistLines.tenantId} and o.status in ('accepted','cancelled'))`,
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
   * eligible accepted order in the warehouse. Both return the orders by the
   * story 4-2a urgency key (due first, priority, ship-by, then oldest).
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
    // Story 4-2a (A8) — the urgency key's "today" is the wave's own clock.
    const todayIst = istDateOf(this.clock.now().toISOString());

    if (selection !== null) {
      const rows = await tx
        .select({
          id: orders.id,
          status: orders.status,
          warehouseId: orders.warehouseId,
          priority: orders.priority,
          shipByDate: orders.shipByDate,
          createdAt: orders.createdAt,
        })
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
        // Story 4.5 audit: the guard is an ALLOW-LIST on `accepted`, not a
        // deny-list on `cancelled`, so the new `ready_to_dispatch` arm is
        // excluded here for free — a packed order is named and refused
        // rather than re-waved against units that have already left their
        // bins. Keep it an allow-list: 4.6's arms inherit the same refusal.
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
      // Story 4-2a (A8) — the locked read above keeps the (created_at, id)
      // lock order; the selection is returned by the urgency key, the order
      // the slices and the picklists are built in.
      return [...rows].sort((a, b) => compareOrderUrgency(a, b, todayIst)).map((row) => row.id);
    }

    // ── the sweep (story 4-2a, A8): read by urgency, lock in (created_at, id)
    // A single `… order by <urgency> limit cap for update` would lock rows in
    // URGENCY order — not the (created_at, id) order `cancelOrder` and every
    // other sweep lock them in — and two commands locking overlapping rows in
    // different orders deadlock. So the sweep is two statements:
    //   1. an UNLOCKED candidate read by the urgency key, `limit cap * 2`
    //      (the slack absorbs candidates claimed before the lock);
    //   2. a LOCKED re-read of exactly those ids in (created_at, id) order,
    //      re-stating the eligibility predicate (a cancelled or packed
    //      candidate fails it and is skipped), then a fresh open-claim read
    //      (READ COMMITTED: a fresh statement sees a concurrent wave that
    //      committed while this one waited for the lock).
    // Then the first `cap` still eligible, in urgency order. A candidate lost
    // in between only makes the wave smaller. When candidates existed but
    // NONE survived, the candidate read runs once more; still none → the
    // claim-lost 409 (the winner named, or retry) — never the 422, which
    // means "nothing to wave".
    const eligible = and(
      eq(orders.tenantId, command.tenantId),
      eq(orders.warehouseId, command.warehouseId),
      // Story 4.5 audit: the auto-selection filter is the same allow-list
      // as the explicit path above — a `ready_to_dispatch` (packed) order
      // is simply not swept, with no new clause needed.
      eq(orders.status, 'accepted'),
      sql`not exists (select 1 from ${picklistLines} pl where pl.tenant_id = ${orders.tenantId} and pl.order_id = ${orders.id} and pl.status <> 'cancelled')`,
      // Story 4-2c (A4) — only an order with a line that HOLDS something: a
      // hold-less (wholly backordered) order — a follow-on awaiting stock, or
      // an order accepted with nothing reserved — has nothing to plan, and a
      // follow-on inherits its ship-by, so without this the overdue hold-less
      // orders sort first and crowd every reserved order out of the
      // `cap * 2` candidate read. Table-qualified by hand (Gotcha 9). The
      // backorder allocation reserves such an order; then it waves.
      sql`exists (select 1 from order_lines ol where ol.tenant_id = ${orders.tenantId} and ol.order_id = ${orders.id} and ol.reserved_qty > 0 and ol.reservation_id is not null)`,
    );
    const urgency = orderUrgencyOrderBy(todayIst, {
      priority: sql`${orders.priority}`,
      shipByDate: sql`${orders.shipByDate}`,
      createdAt: sql`${orders.createdAt}`,
      id: sql`${orders.id}`,
    });
    let lastCandidates: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const candidates = (
        await tx.select({ id: orders.id }).from(orders).where(eligible).orderBy(urgency).limit(cap * 2)
      ).map((row) => row.id);
      if (candidates.length === 0) {
        if (attempt === 0) {
          throw noEligibleOrders(
            'No accepted order in this warehouse is free to wave — every one is already on an open wave, holds no stock yet (it is awaiting stock — the backorder allocation reserves it when stock arrives), or none exists.',
          );
        }
        // Every candidate was claimed while this sweep waited — a lost race.
        throw new WaveClaimLostError(command.tenantId, lastCandidates);
      }
      lastCandidates = candidates;
      const locked = await tx
        .select({ id: orders.id, priority: orders.priority, shipByDate: orders.shipByDate, createdAt: orders.createdAt })
        .from(orders)
        .where(and(eligible, inArray(orders.id, candidates)))
        .orderBy(asc(orders.createdAt), asc(orders.id))
        .for('update');
      const claimedNow = new Set(
        (await this.openClaims(tx, command.tenantId, locked.map((row) => row.id))).map((claim) => claim.orderId),
      );
      const kept = locked
        .filter((row) => !claimedNow.has(row.id))
        .sort((a, b) => compareOrderUrgency(a, b, todayIst))
        .slice(0, cap);
      if (kept.length > 0) return kept.map((row) => row.id);
    }
    throw new WaveClaimLostError(command.tenantId, lastCandidates);
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
   * Story 4-3a — a SKU's stock is ranked WAREHOUSE-WIDE by its client's
   * allocation rule (`fefo` / `fifo`, `rankSlots`), and a batch that is not
   * allocatable (blocked, expired, or below the client's minimum remaining
   * shelf life at the wave clock) is never suggested. Every slice is stamped
   * with the client's rule and minimum, read ONCE for the whole plan (A10).
   * A SKU with no batch rows in a bin draws against the plain projection and
   * its line names no batch (walk order, as before).
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
    // system-owned QC bin. Shared with story 4.4's re-plan lookup so the two
    // can never disagree about what "pickable" means.
    const binOrder = await pickableBinsInTx(tx, command.tenantId, command.warehouseId);

    // Stock composes through the facades only (AD-6). Story 12-1: the lines'
    // storage classes join the read — the pool filter needs them (FR-40), and
    // the wave planner previously read no SKU rows at all.
    const [stock, batchStock, batchIdentities, skuClasses, skuClients] = await Promise.all([
      this.inventory.stockByBinsInTx(tx, command.tenantId, command.warehouseId, skuIds),
      this.inventory.batchOnHandByBinsInTx(tx, command.tenantId, command.warehouseId, skuIds),
      // Story 4-3a — the intake facts carry `createdAt` (FIFO's anchor).
      this.catalog.getBatchIntakesForSkusInTx(tx, command.tenantId, skuIds),
      this.catalog.getSkuStorageClassesInTx(tx, command.tenantId, skuIds),
      this.catalog.skuClientIdsInTx(tx, command.tenantId, skuIds),
    ]);
    // Story 4-3a (A10) — every distinct client's policy in ONE read, so every
    // line of the wave carries the values of that one read.
    const policies = await allocationPoliciesInTx(tx, command.tenantId, [...new Set(skuClients.values())]);
    const policyOfSku = (skuId: string) => {
      const clientId = skuClients.get(skuId);
      return (clientId === undefined ? undefined : policies.get(clientId)) ?? DEFAULT_ALLOCATION_POLICY;
    };

    // The per-SKU walk: (bin in code order) × (batch in FEFO order). Pure,
    // shared with the re-plan lookup (`replan.ts`), and consumed
    // DESTRUCTIVELY below so two lines of the same SKU never both claim the
    // same units — that honesty is what makes the batch-vs-single stop-count
    // inequality hold. Story 12-1: the walk skips bins that do not satisfy
    // the SKU's storage class, so a line whose only stock sits in
    // non-conforming bins plans `unfulfillable` — never a pick that always
    // refuses at the bin.
    // ONE clock reading for the whole plan: the client minimum (the pool) and
    // the consignee arm (below) judge on the same instant, so a plan across
    // IST midnight never judges the two on different dates.
    const planAt = this.clock.now().getTime();
    const pool = buildStockPool({
      skuIds,
      binOrder,
      skuClassById: skuClasses,
      stock,
      batchStock,
      batchIdentities,
      at: planAt,
      policyOf: (skuId) => {
        const policy = policyOfSku(skuId);
        return { allocationRule: policy.allocationRule, minDays: policy.minOutboundShelfLifeDays };
      },
    });

    // ── story 4-3b: the consignee shelf-life rule, per order line ───────
    // Each order's consignee resolves from its GSTIN at plan time (decision
    // 2): ONE partners read for every order of the wave, ONE catalog read
    // for every SKU's total shelf life and tracking (frozen Boundaries' "one
    // read per plan"). Both the client policy and the consignee link key on
    // `orders.client_id`; AD-23 makes it every line's SKU client (A11).
    const orderIds = [...new Set(lines.map((line) => line.orderId))];
    const [orderFacts, skuShelfLife] = await Promise.all([
      orderIds.length === 0
        ? Promise.resolve([] as { id: string; clientId: string; consigneeGstin: string | null }[])
        : tx
            .select({ id: orders.id, clientId: orders.clientId, consigneeGstin: orders.consigneeGstin })
            .from(orders)
            .where(and(eq(orders.tenantId, command.tenantId), inArray(orders.id, orderIds))),
      this.catalog.skuShelfLifeFactsInTx(tx, command.tenantId, skuIds),
    ]);
    const orderById = new Map(orderFacts.map((row) => [row.id, row]));
    for (const line of lines) {
      const order = orderById.get(line.orderId);
      const skuClient = skuClients.get(line.skuId);
      // A SKU the catalog cannot attribute is a mismatch too (fail closed).
      if (order === undefined || skuClient === undefined || skuClient !== order.clientId) {
        throw new Error(
          `wave plan: order ${line.orderId} is attributed to client ${order?.clientId ?? '(missing)'} but its line ${line.id}'s SKU belongs to client ${skuClient ?? '(missing)'} — AD-23 says they are one client (story 4-3b A11).`,
        );
      }
    }
    const consigneeRules = await consigneeShelfLifeRulesInTx(
      tx,
      command.tenantId,
      orderFacts.flatMap((row) =>
        row.consigneeGstin === null || row.consigneeGstin.trim() === ''
          ? []
          : [{ clientId: row.clientId, gstin: row.consigneeGstin }],
      ),
    );
    const batchById = new Map(batchIdentities.map((batch) => [batch.id, batch]));

    const planned: PlannedSlice[] = [];
    for (const line of lines) {
      const policy = policyOfSku(line.skuId);
      // Story 4-3b — the line's consignee arm: only on a batch-tracked SKU
      // (an untracked SKU has no lot identity, so nothing to judge — A1),
      // and only when the order's consignee resolves to a rule.
      const order = orderById.get(line.orderId)!;
      const rule =
        order.consigneeGstin === null || order.consigneeGstin.trim() === ''
          ? undefined
          : consigneeRules.get(consigneeRuleKey(order.clientId, order.consigneeGstin));
      const skuFacts = skuShelfLife.get(line.skuId);
      const batchTracked = skuFacts?.batchTracked ?? false;
      const consignee: ConsigneeArm | null =
        rule === undefined || !batchTracked ? null : consigneeMinimumDays(rule, skuFacts?.shelfLifeDays ?? null);
      const frozen = {
        consigneePartnerId: consignee === null ? null : rule!.partnerId,
        consigneeMinShelfLifeDays: consignee === null ? null : consignee.days,
        consigneeMinShelfLifePercent: consignee === null ? null : rule!.minShelfLifePercent,
        // A2 — the base the percent was converted from, FROZEN beside it.
        consigneeShelfLifeBaseDays:
          consignee === null || rule!.minShelfLifePercent === null ? null : (skuFacts?.shelfLifeDays ?? null),
      };
      // Every quantity a picklist names is the order line's `reserved_qty`,
      // never `qty`: a backordered line contributes only what acceptance
      // actually held.
      let need = line.reservedQty;
      let sliceSeq = 0;
      // A6 — the client-allocatable units the consignee arm kept from THIS
      // line (they stay in the pool for later lines).
      let consigneeSkipped = 0;
      for (const slot of pool.get(line.skuId) ?? []) {
        if (need === 0) break;
        if (slot.remaining <= 0) continue;
        // Story 4-3b — a slot whose units do not meet the line's consignee
        // rule is skipped, never consumed (decision 5: shortfall, not warn).
        // The batch facts come from the map the pool was built from (A12).
        if (
          consignee !== null &&
          !meetsConsigneeShelfLife(
            { batchId: slot.batchId, expiryDate: slot.batchId === null ? null : (batchById.get(slot.batchId)?.expiryDate ?? null) },
            batchTracked,
            planAt,
            consignee,
          )
        ) {
          consigneeSkipped += slot.remaining;
          continue;
        }
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
          allocationRule: policy.allocationRule,
          minOutboundShelfLifeDays: policy.minOutboundShelfLifeDays,
          ...frozen,
          shortfallCause: null,
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
          allocationRule: policy.allocationRule,
          minOutboundShelfLifeDays: policy.minOutboundShelfLifeDays,
          ...frozen,
          // A6 — the cause is the consignee's only when client-allocatable
          // stock WOULD have covered more of the line than the rule allowed;
          // otherwise there was simply no stock (null, as before).
          shortfallCause:
            consignee === null || consigneeSkipped === 0
              ? null
              : consignee.judgeable
                ? 'consignee-shelf-life'
                : 'consignee-unjudgeable',
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
    // Story 4-2a (A1) — each picklist's urgency: its non-cancelled lines'
    // orders, folded to the most urgent priority and the earliest ship-by.
    const lineOrderIds = [
      ...new Set(lines.filter((line) => line.status !== 'cancelled').map((line) => line.orderId)),
    ];
    const urgencyByOrder = new Map(
      (lineOrderIds.length === 0
        ? []
        : await tx
            .select({ id: orders.id, priority: orders.priority, shipByDate: orders.shipByDate })
            .from(orders)
            .where(and(eq(orders.tenantId, wave.tenantId), inArray(orders.id, lineOrderIds)))
      ).map((row) => [row.id, row]),
    );
    // Story 4-3a (A19) — the suggested batches' facts, read ONCE per snapshot.
    const batchFacts = await this.catalog.batchFactsByIdsInTx(
      tx,
      wave.tenantId,
      lines.flatMap((line) => (line.batchId === null ? [] : [line.batchId])),
    );
    // Story 4-3b — the consignees' display names (A10), read ONCE per
    // snapshot and only when a line carries a consignee rule. The percent's
    // base is the line's own frozen column (A2), never the live catalog.
    const consigneeLines = lines.filter((line) => line.consigneePartnerId !== null);
    const consignee: ConsigneeSnapshotFacts = {
      names:
        consigneeLines.length === 0
          ? new Map<string, string>()
          : await partnerNamesInTx(tx, wave.tenantId, consigneeLines.map((line) => line.consigneePartnerId!)),
    };
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
            urgencyByOrder,
            batchFacts,
            consignee,
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

/** Story 4-3b — what a line snapshot needs to print its consignee rule, read once per wave snapshot. */
export interface ConsigneeSnapshotFacts {
  readonly names: ReadonlyMap<string, string>;
}

const NO_CONSIGNEE_FACTS: ConsigneeSnapshotFacts = { names: new Map() };

export function picklistSnapshot(
  row: Picklist,
  lines: readonly PicklistLine[],
  urgencyByOrder: ReadonlyMap<string, { readonly priority: string; readonly shipByDate: string | null }>,
  batchFacts: ReadonlyMap<string, BatchFacts> = new Map(),
  consignee: ConsigneeSnapshotFacts = NO_CONSIGNEE_FACTS,
): PicklistSnapshot {
  const ordered = [...lines].sort((a, b) => a.walkSeq - b.walkSeq);
  const urgency = foldOrderUrgency(
    [...new Set(ordered.filter((line) => line.status !== 'cancelled').map((line) => line.orderId))]
      .map((orderId) => urgencyByOrder.get(orderId))
      .filter((fact): fact is { readonly priority: string; readonly shipByDate: string | null } => fact !== undefined),
  );
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
    priority: urgency.priority,
    shipByDate: urgency.shipByDate,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
    lines: ordered.map((line) => lineSnapshot(line, batchFacts, consignee)),
  };
}

export function lineSnapshot(
  row: PicklistLine,
  batchFacts: ReadonlyMap<string, BatchFacts> = new Map(),
  consignee: ConsigneeSnapshotFacts = NO_CONSIGNEE_FACTS,
): PicklistLineSnapshot {
  const batch = row.batchId === null ? undefined : batchFacts.get(row.batchId);
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
    // Story 10.1: `lineSnapshot` is the module's only picklist-line read
    // shape — base units leave here, milli-units stay in the columns.
    qty: fromMilli(row.qty),
    shortfallQty: fromMilli(row.shortfallQty),
    reasonCode: row.reasonCode,
    sliceSeq: row.sliceSeq,
    walkSeq: row.walkSeq,
    status: row.status as PicklistLineStatus,
    createdAt: canonicalInstant(row.createdAt),
    // Story 4-3a — what the wave detail prints: the batch, its expiry and its
    // lot's first receipt (IST dates), and the frozen policy.
    batchCode: batch?.code ?? null,
    batchExpiryDate: batch?.expiryDate == null ? null : istDateOf(batch.expiryDate),
    batchReceivedOn: batch === undefined ? null : istDateOf(batch.createdAt),
    allocationRule: (row.allocationRule as AllocationRule | null) ?? null,
    minOutboundShelfLifeDays: row.minOutboundShelfLifeDays,
    // Story 4-3b — the frozen consignee rule and the shortfall cause.
    consigneeName: row.consigneePartnerId === null ? null : (consignee.names.get(row.consigneePartnerId) ?? null),
    consigneeMinShelfLifeDays: row.consigneeMinShelfLifeDays,
    consigneeMinShelfLifePercent: row.consigneeMinShelfLifePercent,
    consigneeShelfLifeBaseDays: row.consigneeShelfLifeBaseDays,
    shortfallCause: (row.shortfallCause as ShortfallCause | null) ?? null,
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
