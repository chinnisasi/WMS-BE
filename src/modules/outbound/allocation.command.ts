import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, orderLines, orders, picklistLines, skus } from '../../shared/db/schema';
import type { Order, OrderLine } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
import { istDateOf, nowIso } from '../../shared/primitives/time';
import { SYSTEM_ACTOR_ID } from '../../shared/primitives/audit';
import { needsOf } from '../../shared/primitives/licence';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { ReservationSnapshot } from '../inventory/inventory.facade';
// Licence enforcement through compliance's FREE functions (never its Nest
// module — compliance forward-references outbound; guide §7h).
import { licenceCoverageInTx, licenceEnforcedInTx, licenceToday } from '../compliance/licence-enforcement';
import { getClientsInTx } from '../clients/clients.facade';
import { orderUrgencyOrderBy } from './order-urgency';
import { ORDER_LINE_OWNER_TYPE, grantKitBlock, grantLineHold } from './reserve-line';
import { orderLabelOf } from './follow-on';

/**
 * Story 4-2c — the backorder allocation: a backordered line with no hold is
 * RE-RESERVED when stock exists, by one core run three ways — the sweep job
 * (`BackorderAllocationWorker` → `sweepBackorders`), a best-effort attempt
 * right after a short dispatch commits (for the follow-on it opened), and the
 * staff verb `POST …/orders/{id}/allocate` (`allocateOrder`).
 *
 * ── the phases (outbound.md `createOrder` step 2 — a grant cannot nest) ────
 *
 * 1. **Read** (one tenant transaction, no lock): the order must be
 *    `accepted` with no open wave claim; each LEAF line's journal holds BY
 *    OWNER decide its fate (A1) — a `committed` hold (picked) or a `held`
 *    hold the line points at (it already holds — no top-up) makes it
 *    ineligible; a `held` hold the line does NOT point at is an orphan (a
 *    crashed allocation, a concurrent allocator's grant, a short pick's
 *    re-grant behind a cancelled wave) and is ADOPTED (A2); otherwise it is
 *    granted. A kit is eligible whole or not at all. The SKU status and the
 *    licence coverage are read (A6).
 * 2. **Grants**, outside any transaction, through acceptance's own path
 *    (`reserve-line.ts`): `min(qty, ATP)` for a plain line (an INACTIVE
 *    SKU's line only when ATP covers it in full — `sku-inactive` otherwise),
 *    the all-or-nothing block for a kit. A 409 the bounded re-probes do not
 *    absorb is a race loss for that line (`contended`); a 503 aborts the run
 *    and releases every fresh grant.
 * 3. **Write** (one tenant transaction): the order `FOR UPDATE`; the verb
 *    replays again under the lock; eligibility re-checked (status, open
 *    claim, licences); each line written CONDITIONALLY on the reservation id
 *    phase 1 read, so a concurrent winner's write is never overwritten; the
 *    `order.allocated` outbox and audit rows when anything was granted; the
 *    verb's key last. After the commit, every grant NO line of the order
 *    references is released (A2) — a hold a concurrent winner wrote to the
 *    line is never released by the loser.
 *
 * `order_lines.status` is NEVER changed (decision 5): it is the acceptance-
 * time fact SM-4 and the `backordered` filter read.
 *
 * Two sweep workers are safe: the adopt rule, the conditional write and
 * "release only what nothing references" under the order lock (A5).
 */

export const ALLOCATE_COMMAND_KIND = 'outbound.order.allocate';

/** Why an eligible line was not granted this run (A6, A2). */
export const ALLOCATION_SKIP_REASONS = ['sku-inactive', 'licence-not-covered', 'contended'] as const;
export type AllocationSkipReason = (typeof ALLOCATION_SKIP_REASONS)[number];

/** Who ran the allocation. */
export type AllocationEntry = 'manual' | 'job' | 'dispatch';

/** The job's clock — exported and mutable so a suite can cross IST midnight (guide §7c). */
export const backorderAllocationClock = { now: (): Date => new Date() };

/** A5 — the sweep's bounds per tenant per tick (plain fields on the service; suites shrink them). */
export const BACKORDER_ALLOCATION_SCAN_CAP = 500;
export const BACKORDER_ALLOCATION_BATCH = 50;

export interface AllocateOrderCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly orderId: string;
}

export interface AllocatedLineResult {
  readonly orderLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  /** Ordered, base units. */
  readonly qty: number;
  /** What the line now holds, base units. */
  readonly reservedQty: number;
}

export interface StillShortLineResult {
  readonly orderLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  /** Still awaiting stock, base units. */
  readonly shortQty: number;
}

export interface SkippedLineResult {
  readonly orderLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly reason: AllocationSkipReason;
}

export interface AllocationResult {
  readonly orderId: string;
  readonly warehouseId: string;
  readonly allocated: readonly AllocatedLineResult[];
  readonly stillShort: readonly StillShortLineResult[];
  readonly skipped: readonly SkippedLineResult[];
}

/** The verb's response and stored snapshot. */
export interface AllocateOrderSnapshot {
  readonly allocation: AllocationResult;
}

/** One core run's outcome (the job and the after-dispatch attempt). */
export type AllocationOutcome =
  | { readonly kind: 'allocated'; readonly result: AllocationResult; readonly unitsReservedMilli: number; readonly grantedAny: boolean }
  | { readonly kind: 'not-eligible'; readonly reason: string };

/** The sweep's per-tenant report (one log line). */
export interface BackorderSweepReport {
  readonly scanned: number;
  readonly allocatedOrders: number;
  /** Base units reserved this tick. */
  readonly unitsReserved: number;
  /** Orders scanned that still wait for stock after this tick. */
  readonly stillShortOrders: number;
  /** Age of the oldest order still waiting, ms (null when none). */
  readonly oldestWaitingMs: number | null;
}

/** ATP known to be exhausted this tick, per `${warehouseId}:${skuId}` (A5). */
export type AtpExhaustedCache = Set<string>;

interface PlainPlan {
  readonly line: OrderLine;
  readonly adopt: ReservationSnapshot | null;
  readonly wholeOnly: boolean;
}

interface KitPlan {
  readonly parent: OrderLine;
  readonly children: readonly { readonly line: OrderLine; readonly adopt: ReservationSnapshot | null }[];
}

interface Phase1 {
  readonly order: Order;
  readonly plain: readonly PlainPlan[];
  readonly kits: readonly KitPlan[];
  readonly skipped: SkippedLineResult[];
  readonly skuCode: ReadonlyMap<string, string>;
}

/** A released hold's reserved-counter restore, applied after the commit. */
interface Restore {
  readonly warehouseId: string;
  readonly skuId: string;
  /** Milli-units. */
  readonly units: number;
}

interface Granted {
  readonly line: OrderLine;
  readonly hold: ReservationSnapshot;
  /** An adopted orphan (not granted by this run). */
  readonly adopted: boolean;
}

@Injectable()
export class AllocationCommandService {
  private readonly logger = new Logger('BackorderAllocation');
  /** A5 — plain fields so a suite can shrink them (the `ReportingFacade.auditRead` precedent). */
  scanCap = BACKORDER_ALLOCATION_SCAN_CAP;
  batch = BACKORDER_ALLOCATION_BATCH;
  /** Code review C4 — per tenant, where the next tick's candidate window starts (in-process; a second worker keeps its own). */
  readonly scanOffsets = new Map<string, number>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  /**
   * `POST …/orders/{orderId}/allocate` — "Allocate now" (A7). `orders.manage`
   * → replay → the order (404) → `accepted` (else 409 `order-not-accepted`)
   * → no open wave claim (else 409 `order-on-open-wave`, naming the wave) →
   * the grants (a store failure is 503, every fresh grant released) → the
   * write. Nothing eligible, or nothing granted, is 200 with an empty
   * `allocated` — the key stored, no audit row (an `AUDIT_NO_OP_ARMS` arm).
   */
  async allocateOrder(command: AllocateOrderCommand, idempotencyKey: string): Promise<AllocateOrderSnapshot> {
    const payloadHash = hashCommandPayload({
      // The discriminator (outbound Gotcha 8): `{tenantId, orderId}` alone is
      // the cancel's hash.
      command: ALLOCATE_COMMAND_KIND,
      tenantId: command.tenantId,
      orderId: command.orderId,
    });
    const first = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'orders.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return { replayed, plan: null };
      const order = await this.readOrder(tx, command.tenantId, command.orderId);
      if (order === null) throw orderNotFound(command.orderId);
      await this.assertEligibleForVerb(tx, order);
      return { replayed: null, plan: await this.planInTx(tx, order) };
    });
    if (first.replayed !== null) return first.replayed;
    const plan = first.plan!;
    const grants = await this.grantPhase(plan, null);
    const written = await this.writePhase(plan, grants, {
      entry: 'manual',
      actorUserId: command.actorUserId,
      key: { value: idempotencyKey, payloadHash },
    });
    await this.applyRestores(command.tenantId, written.restores);
    if (written.kind === 'replayed') return written.snapshot;
    if (written.kind === 'refused') throw written.error;
    return { allocation: written.result };
  }

  /**
   * The core run for the job and the after-dispatch attempt: no actor, no
   * key; the audit row is `SYSTEM_ACTOR_ID`'s, only when something was
   * granted (A5). Never throws a refusal — an order that is not eligible
   * answers `not-eligible`; a store failure propagates (the caller logs).
   */
  async allocateOrderCore(
    tenantId: string,
    orderId: string,
    options: { readonly entry: 'job' | 'dispatch'; readonly exhausted?: AtpExhaustedCache },
  ): Promise<AllocationOutcome> {
    const plan = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const order = await this.readOrder(tx, tenantId, orderId);
      if (order === null) return { reason: 'not-found' };
      const refusal = await this.eligibilityRefusal(tx, order);
      if (refusal !== null) return { reason: codeOf(refusal) };
      return this.planInTx(tx, order);
    });
    if ('reason' in plan) return { kind: 'not-eligible', reason: plan.reason };
    const grants = await this.grantPhase(plan, options.exhausted ?? null);
    const written = await this.writePhase(plan, grants, { entry: options.entry, actorUserId: SYSTEM_ACTOR_ID, key: null });
    await this.applyRestores(tenantId, written.restores);
    if (written.kind !== 'written') {
      return { kind: 'not-eligible', reason: written.kind === 'refused' ? written.code : 'replayed' };
    }
    return {
      kind: 'allocated',
      result: written.result,
      unitsReservedMilli: written.unitsReservedMilli,
      grantedAny: written.result.allocated.length > 0,
    };
  }

  /**
   * The sweep for one tenant (A5): the eligible orders by the 4-2a urgency key
   * (today = the job clock's IST date), at most `scanCap` scanned and `batch`
   * ALLOCATED per tick. ATP known exhausted is cached per (warehouse, SKU),
   * so out-of-stock orders at the head of the key cost one probe per SKU and
   * never starve one with stock behind them. System work: no key; the outbox
   * event and the system audit row are the record. One log line per tenant.
   */
  async sweepBackorders(tenantId: string): Promise<BackorderSweepReport> {
    const now = backorderAllocationClock.now();
    const todayIst = istDateOf(now.toISOString());
    // Code review C4 — a ROTATING window: a tick that scanned its whole cap
    // without filling the batch starts the next tick where it stopped, so
    // more than `scanCap` waiting orders ahead (out of stock, fully held) can
    // never starve one behind them; a tick that filled the batch, or reached
    // the end, starts the next at the head again (urgency first).
    const offset = this.scanOffsets.get(tenantId) ?? 0;
    const candidates = await withTenantTransaction(this.db, tenantId, (tx) => this.candidatesInTx(tx, tenantId, todayIst, this.scanCap, offset));
    const exhausted: AtpExhaustedCache = new Set();
    let allocatedOrders = 0;
    let unitsMilli = 0;
    let stillShort = 0;
    let oldest: number | null = null;
    let scanned = 0;
    for (const candidate of candidates) {
      if (allocatedOrders >= this.batch) break;
      scanned += 1;
      let outcome: AllocationOutcome;
      try {
        outcome = await this.allocateOrderCore(tenantId, candidate.id, { entry: 'job', exhausted });
      } catch (err) {
        // One order's failure (a store outage, a transient fault) never
        // stops the sweep's other orders; the next tick retries it.
        this.logger.error(
          `Backorder allocation of order ${candidate.id} (tenant ${tenantId}) failed — retried next tick: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (outcome.kind !== 'allocated') continue;
      if (outcome.grantedAny) {
        allocatedOrders += 1;
        unitsMilli += outcome.unitsReservedMilli;
      }
      if (outcome.result.stillShort.length > 0 || outcome.result.skipped.length > 0) {
        stillShort += 1;
        const age = now.getTime() - Date.parse(candidate.createdAt);
        oldest = oldest === null || age > oldest ? age : oldest;
      }
    }
    const filledBatch = allocatedOrders >= this.batch;
    this.scanOffsets.set(tenantId, !filledBatch && candidates.length >= this.scanCap ? offset + candidates.length : 0);
    const report: BackorderSweepReport = {
      scanned,
      allocatedOrders,
      unitsReserved: fromMilli(unitsMilli),
      stillShortOrders: stillShort,
      oldestWaitingMs: oldest,
    };
    if (scanned > 0) {
      this.logger.log(
        `backorder allocation tenant=${tenantId} scanned=${report.scanned} allocatedOrders=${report.allocatedOrders} ` +
          `unitsReserved=${report.unitsReserved} stillShortOrders=${report.stillShortOrders} ` +
          `oldestWaitingMs=${report.oldestWaitingMs ?? 'none'}`,
      );
    }
    return report;
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  /**
   * The sweep's candidates (A18): `accepted` orders with no open wave claim
   * and a leaf line a run could act on — one holding nothing
   * (`reservation_id is null or reserved_qty = 0`), one last written longer
   * ago than a hold's TTL (its 7-day hold may have expired — an allocation's
   * write resets it), or one whose pick line was cancelled after the line was
   * last written (a short pick's re-grant may be waiting to be adopted). A
   * fully held order is not rescanned every tick. Driven by
   * `orders_accepted_tenant_warehouse_idx`; ordered by the urgency key; the
   * wait measured from the chain's ROOT (code review C14).
   */
  private async candidatesInTx(tx: TenantTx, tenantId: string, todayIst: string, limit: number, offset: number): Promise<{ id: string; createdAt: string }[]> {
    const rows = (await tx.execute(backorderCandidatesSql(tenantId, todayIst, limit, offset))) as unknown as { id: string; createdAtMs: string }[];
    return rows.map((row) => ({ id: row.id, createdAt: new Date(Number(row.createdAtMs)).toISOString() }));
  }

  private async readOrder(tx: TenantTx, tenantId: string, orderId: string, lock = false): Promise<Order | null> {
    const query = tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** The open wave claim (a non-cancelled pick line) of the order, or null. */
  private async openClaimInTx(tx: TenantTx, order: Order): Promise<string | null> {
    const rows = await tx
      .select({ waveId: picklistLines.waveId })
      .from(picklistLines)
      .where(and(eq(picklistLines.tenantId, order.tenantId), eq(picklistLines.orderId, order.id), sql`${picklistLines.status} <> 'cancelled'`))
      .limit(1);
    return rows[0]?.waveId ?? null;
  }

  /** The verb's named refusal when the order cannot be allocated, or null. */
  private async eligibilityRefusal(tx: TenantTx, order: Order): Promise<ProblemException | null> {
    if (order.status !== 'accepted') {
      return new ProblemException(
        'order-not-accepted',
        409,
        'Order is not awaiting stock',
        `Order ${orderLabelOf(order)} reads "${order.status}" — only an accepted order is allocated.`,
      );
    }
    const waveId = await this.openClaimInTx(tx, order);
    if (waveId !== null) {
      return new ProblemException(
        'order-on-open-wave',
        409,
        'Order is on an open wave',
        `Order ${orderLabelOf(order)} is on open wave ${waveId} — cancel the wave to re-plan it, or let it be picked.`,
        { waveId },
      );
    }
    return null;
  }

  private async assertEligibleForVerb(tx: TenantTx, order: Order): Promise<void> {
    const refusal = await this.eligibilityRefusal(tx, order);
    if (refusal !== null) throw refusal;
  }

  /** Phase 1 — what each leaf line's journal says, the SKU facts and the licence check. */
  private async planInTx(tx: TenantTx, order: Order): Promise<Phase1> {
    const lines = await tx
      .select()
      .from(orderLines)
      .where(and(eq(orderLines.tenantId, order.tenantId), eq(orderLines.orderId, order.id)))
      .orderBy(asc(orderLines.createdAt), asc(orderLines.id));
    const parentIds = new Set(lines.map((line) => line.parentLineId).filter((id): id is string => id !== null));
    const leaves = lines.filter((line) => !parentIds.has(line.id));
    const leafIds = leaves.map((line) => line.id);
    const held = await this.inventory.heldReservationsByOwnerInTx(tx, order.tenantId, order.warehouseId, ORDER_LINE_OWNER_TYPE, leafIds);
    const committed = await this.inventory.committedReservationsByOwnerInTx(tx, order.tenantId, order.warehouseId, ORDER_LINE_OWNER_TYPE, leafIds);
    const heldByOwner = new Map(held.map((hold) => [hold.ownerId, hold]));
    const committedOwners = new Set(committed.map((hold) => hold.ownerId));
    const nowMs = Date.now();

    // A1 — a leaf line's fate from its owner's journal rows.
    type Fate = { kind: 'ineligible' } | { kind: 'grant' } | { kind: 'adopt'; hold: ReservationSnapshot };
    const fateOf = (line: OrderLine): Fate => {
      if (committedOwners.has(line.id)) return { kind: 'ineligible' }; // picked
      const hold = heldByOwner.get(line.id);
      if (hold === undefined) return { kind: 'grant' };
      if (line.reservationId === hold.id && line.reservedQty > 0) return { kind: 'ineligible' }; // it holds — no top-up
      // A held hold past its deadline is the reaper's next row, not stock to adopt.
      if (hold.expiresAt !== null && Date.parse(hold.expiresAt) <= nowMs) return { kind: 'ineligible' };
      return { kind: 'adopt', hold };
    };

    const skuIds = [...new Set(lines.map((line) => line.skuId))];
    const skuRows =
      skuIds.length === 0
        ? []
        : await tx
            .select({ id: skus.id, code: skus.code, status: skus.status, foodCategory: skus.foodCategory, drugSchedules: skus.drugSchedules })
            .from(skus)
            .where(and(eq(skus.tenantId, order.tenantId), inArray(skus.id, skuIds)));
    const skuById = new Map(skuRows.map((row) => [row.id, row]));
    const skuCode = new Map(skuRows.map((row) => [row.id, row.code]));

    const plain: PlainPlan[] = [];
    const kits: KitPlan[] = [];
    for (const line of lines) {
      if (line.parentLineId !== null) continue;
      if (!parentIds.has(line.id)) {
        const fate = fateOf(line);
        if (fate.kind === 'ineligible') continue;
        plain.push({
          line,
          adopt: fate.kind === 'adopt' ? fate.hold : null,
          // A6 — an inactive SKU sells existing stock only: granted in full or not at all.
          wholeOnly: skuById.get(line.skuId)?.status !== 'active',
        });
        continue;
      }
      const children = lines.filter((child) => child.parentLineId === line.id);
      const fates = children.map((child) => ({ line: child, fate: fateOf(child) }));
      if (fates.some((entry) => entry.fate.kind === 'ineligible')) continue; // a kit is eligible whole or not at all
      kits.push({
        parent: line,
        children: fates.map((entry) => ({ line: entry.line, adopt: entry.fate.kind === 'adopt' ? entry.fate.hold : null })),
      });
    }

    // A6 — licences: with the switch on, every SKU of the order must be
    // covered at the warehouse today; otherwise the order is skipped whole.
    const skipped: SkippedLineResult[] = [];
    if ((plain.length > 0 || kits.length > 0) && !(await this.licencesCoverInTx(tx, order, skuRows))) {
      for (const entry of plain) skipped.push(skippedOf(entry.line, 'licence-not-covered', skuCode));
      for (const kit of kits) for (const child of kit.children) skipped.push(skippedOf(child.line, 'licence-not-covered', skuCode));
      return { order, plain: [], kits: [], skipped, skuCode };
    }
    return { order, plain, kits, skipped, skuCode };
  }

  private async licencesCoverInTx(
    tx: TenantTx,
    order: Order,
    skuRows: readonly { code: string; foodCategory: string | null; drugSchedules: readonly string[] }[],
  ): Promise<boolean> {
    const goods = skuRows.filter((sku) => needsOf(sku).length > 0);
    if (goods.length === 0 || !(await licenceEnforcedInTx(tx, order.tenantId))) return true;
    const client = (await getClientsInTx(tx, order.tenantId, [order.clientId])).get(order.clientId);
    const uncovered = await licenceCoverageInTx(tx, {
      tenantId: order.tenantId,
      warehouseId: order.warehouseId,
      date: licenceToday(),
      parties: goods.map((sku) => ({
        clientId: order.clientId,
        // A missing client row reads as NOT the tenant's own (fail closed).
        systemOwned: client?.systemOwned ?? false,
        skuCode: sku.code,
        needs: needsOf(sku),
      })),
    });
    return uncovered.length === 0;
  }

  // ── phase 2 ─────────────────────────────────────────────────────────────────

  private async grantPhase(
    plan: Phase1,
    exhausted: AtpExhaustedCache | null,
  ): Promise<{ granted: Granted[]; skipped: SkippedLineResult[] }> {
    const { order } = plan;
    const scope = { tenantId: order.tenantId, warehouseId: order.warehouseId };
    const cacheKey = (skuId: string): string => `${order.warehouseId}:${skuId}`;
    const granted: Granted[] = [];
    const skipped: SkippedLineResult[] = [...plan.skipped];
    // Code review C24/C25 — a "fresh" grant may be a concurrent allocator's
    // hold (the grant is owner-idempotent), so it is released only UNDER THE
    // ORDER LOCK and only when no line references it.
    const release = async (holds: readonly ReservationSnapshot[], cause: string): Promise<void> => {
      await this.releaseUnreferencedUnderLock(order, holds, cause);
    };
    try {
      for (const entry of plan.plain) {
        if (entry.adopt !== null) {
          // Code review C27 — an inactive SKU's line takes an orphan only when
          // it covers the line in full (the sell-down rule).
          if (entry.wholeOnly && entry.adopt.quantity < entry.line.qty) {
            skipped.push(skippedOf(entry.line, 'sku-inactive', plan.skuCode));
            continue;
          }
          granted.push({ line: entry.line, hold: entry.adopt, adopted: true });
          continue;
        }
        if (exhausted?.has(cacheKey(entry.line.skuId)) === true) continue;
        let hold: ReservationSnapshot | null;
        try {
          hold = await grantLineHold(this.inventory, {
            ...scope,
            skuId: entry.line.skuId,
            quantity: entry.line.qty,
            ownerId: entry.line.id,
            wholeOnly: entry.wholeOnly,
          });
        } catch (err) {
          if (!isRaceLoss(err)) throw err;
          // A2 — a concurrent allocator is granting this same owner: adopt
          // the hold it settled on (the grant is owner-idempotent), so whichever
          // run reaches the order lock first writes it to the line. None (it
          // was another quantity, or already released) → contended this run.
          const settled = await this.heldOfOwner(order, entry.line.id);
          if (settled === null) {
            skipped.push(skippedOf(entry.line, 'contended', plan.skuCode));
            continue;
          }
          granted.push({ line: entry.line, hold: settled, adopted: true });
          continue;
        }
        if (hold === null) {
          // Code review C3 — an inactive SKU's whole-only miss proves nothing
          // about ATP for a smaller line, so it never marks the SKU exhausted.
          if (entry.wholeOnly) skipped.push(skippedOf(entry.line, 'sku-inactive', plan.skuCode));
          else exhausted?.add(cacheKey(entry.line.skuId));
          continue;
        }
        if (hold.quantity < entry.line.qty) exhausted?.add(cacheKey(entry.line.skuId));
        granted.push({ line: entry.line, hold, adopted: false });
      }
      for (const kit of plan.kits) {
        // Code review C1 — an adopted component must cover its whole quantity
        // (a kit never half-holds): a PARTIAL orphan is released (nothing
        // references it — the line does not point at it) and the component is
        // granted afresh with its siblings.
        const partialOrphans = kit.children.filter((child) => child.adopt !== null && child.adopt.quantity < child.line.qty);
        if (partialOrphans.length > 0) {
          await release(partialOrphans.map((child) => child.adopt!), 'kit-partial-orphan');
        }
        const children = kit.children.map((child) =>
          child.adopt !== null && child.adopt.quantity < child.line.qty ? { line: child.line, adopt: null } : child,
        );
        const toGrant = children.filter((child) => child.adopt === null);
        if (toGrant.some((child) => exhausted?.has(cacheKey(child.line.skuId)) === true)) continue;
        let fresh: ReservationSnapshot[] | null;
        try {
          fresh = await grantKitBlock(
            this.inventory,
            scope,
            toGrant.map((child) => ({ skuId: child.line.skuId, quantity: child.line.qty, ownerId: child.line.id })),
            (partial) => release(partial, 'kit-backorder'),
          );
        } catch (err) {
          if (isRaceLoss(err)) {
            for (const child of children) skipped.push(skippedOf(child.line, 'contended', plan.skuCode));
            continue;
          }
          throw err;
        }
        if (fresh === null) continue;
        const freshByOwner = new Map(fresh.map((hold) => [hold.ownerId, hold]));
        for (const child of children) {
          const hold = child.adopt ?? freshByOwner.get(child.line.id)!;
          granted.push({ line: child.line, hold, adopted: child.adopt !== null });
        }
      }
    } catch (err) {
      // A store failure (503) or any other fault: nothing is written; every
      // FRESH grant goes back (an adopted orphan stays for the next run).
      await release(granted.filter((entry) => !entry.adopted).map((entry) => entry.hold), 'abort');
      throw err;
    }
    return { granted, skipped };
  }

  /** The owner's live `held` hold, read in a transaction of its own (between phases — never nested). */
  private async heldOfOwner(order: Order, ownerId: string): Promise<ReservationSnapshot | null> {
    const held = await withTenantTransaction(this.db, order.tenantId, (tx) =>
      this.inventory.heldReservationsByOwnerInTx(tx, order.tenantId, order.warehouseId, ORDER_LINE_OWNER_TYPE, [ownerId]),
    );
    return held[0] ?? null;
  }

  // ── phase 3 ─────────────────────────────────────────────────────────────────

  private async writePhase(
    plan: Phase1,
    grants: { granted: Granted[]; skipped: SkippedLineResult[] },
    who: {
      readonly entry: AllocationEntry;
      readonly actorUserId: string;
      readonly key: { readonly value: string; readonly payloadHash: string } | null;
    },
  ): Promise<
    | { kind: 'written'; result: AllocationResult; unitsReservedMilli: number; restores: Restore[] }
    | { kind: 'replayed'; snapshot: AllocateOrderSnapshot; restores: Restore[] }
    | { kind: 'refused'; code: string; error: ProblemException; restores: Restore[] }
  > {
    const { order } = plan;
    const all = grants.granted.map((entry) => entry.hold);
    try {
      return await withTenantTransaction(this.db, order.tenantId, async (tx) => {
        const locked = await this.readOrder(tx, order.tenantId, order.id, true);
        // A2 — a same-key duplicate parked on the lock serves the winner's answer.
        if (who.key !== null) {
          const replayed = await this.replay(tx, order.tenantId, who.key.value, who.key.payloadHash);
          if (replayed !== null) {
            return { kind: 'replayed' as const, snapshot: replayed, restores: await this.releaseInTx(tx, order, await this.unreferencedInTx(tx, order, all)) };
          }
        }
        const refusal = locked === null ? orderNotFound(order.id) : await this.eligibilityRefusal(tx, locked);
        if (refusal !== null) {
          return { kind: 'refused' as const, code: codeOf(refusal), error: refusal, restores: await this.releaseInTx(tx, order, await this.unreferencedInTx(tx, order, all)) };
        }
        // A2 — a plain line this run could not grant (a concurrent allocator
        // took the ATP first) may now carry THAT allocator's hold: read under
        // the lock (its grant phase finished before it could park here), the
        // hold is adopted, so whichever run writes first writes the same hold.
        const ungranted = plan.plain
          .map((entry) => entry.line)
          .filter((line) => !grants.granted.some((entry) => entry.line.id === line.id));
        const lateHolds =
          ungranted.length === 0
            ? []
            : await this.inventory.heldReservationsByOwnerInTx(tx, order.tenantId, order.warehouseId, ORDER_LINE_OWNER_TYPE, ungranted.map((line) => line.id));
        const lateByOwner = new Map(lateHolds.map((hold) => [hold.ownerId, hold]));
        const adoptedLate: Granted[] = ungranted
          .filter((line) => lateByOwner.has(line.id) && lateByOwner.get(line.id)!.id !== line.reservationId)
          .map((line) => ({ line, hold: lateByOwner.get(line.id)!, adopted: true }));
        const lateIds = new Set(adoptedLate.map((entry) => entry.line.id));
        // A6 — the licence re-check under the lock (the switch or a SKU may have changed).
        let granted = [...grants.granted, ...adoptedLate];
        const skipped = grants.skipped.filter((line) => !lateIds.has(line.orderLineId));
        if (granted.length > 0) {
          const skuRows = await tx
            .select({ code: skus.code, foodCategory: skus.foodCategory, drugSchedules: skus.drugSchedules })
            .from(skus)
            .where(and(eq(skus.tenantId, order.tenantId), inArray(skus.id, [...new Set(granted.map((entry) => entry.line.skuId))])));
          if (!(await this.licencesCoverInTx(tx, locked!, skuRows))) {
            for (const entry of granted) skipped.push(skippedOf(entry.line, 'licence-not-covered', plan.skuCode));
            granted = [];
          }
        }
        // Code review C24–C26 — every hold about to be written is re-read
        // under the lock: one another run released (an abort that took it for
        // its own), or one past its deadline, is never written to a line.
        const nowMs = Date.now();
        const live = new Map(
          (granted.length === 0 ? [] : await this.inventory.reservationsByIdsInTx(tx, order.tenantId, granted.map((entry) => entry.hold.id))).map((row) => [row.id, row]),
        );
        granted = granted.filter((entry) => {
          const row = live.get(entry.hold.id);
          const usable = row !== undefined && row.state === 'held' && (row.expiresAt === null || Date.parse(row.expiresAt) > nowMs);
          if (!usable) skipped.push(skippedOf(entry.line, 'contended', plan.skuCode));
          return usable;
        });
        // The conditional write: only where the line still names what phase 1
        // read — a concurrent allocator's write is never overwritten.
        const allocated: AllocatedLineResult[] = [];
        let unitsReservedMilli = 0;
        const updatedAt = nowIso();
        for (const entry of granted) {
          const written = await tx
            .update(orderLines)
            .set({ reservedQty: entry.hold.quantity, reservationId: entry.hold.id, updatedAt })
            .where(
              and(
                eq(orderLines.tenantId, order.tenantId),
                eq(orderLines.id, entry.line.id),
                entry.line.reservationId === null
                  ? sql`${orderLines.reservationId} is null`
                  : eq(orderLines.reservationId, entry.line.reservationId),
                eq(orderLines.reservedQty, entry.line.reservedQty),
              ),
            )
            .returning({ id: orderLines.id });
          if (written.length === 0) {
            skipped.push(skippedOf(entry.line, 'contended', plan.skuCode));
            continue;
          }
          allocated.push({
            orderLineId: entry.line.id,
            skuId: entry.line.skuId,
            skuCode: plan.skuCode.get(entry.line.skuId) ?? entry.line.skuId,
            qty: fromMilli(entry.line.qty),
            reservedQty: fromMilli(entry.hold.quantity),
          });
          unitsReservedMilli += entry.hold.quantity;
        }
        const allocatedIds = new Set(allocated.map((line) => line.orderLineId));
        const skippedIds = new Set(skipped.map((line) => line.orderLineId));
        const holdOf = new Map(granted.map((entry) => [entry.line.id, entry.hold.quantity]));
        // Every eligible leaf line that did not end fully reserved.
        const stillShort: StillShortLineResult[] = [];
        const eligibleLeaves = [...plan.plain.map((entry) => entry.line), ...plan.kits.flatMap((kit) => kit.children.map((child) => child.line))];
        for (const line of eligibleLeaves) {
          if (skippedIds.has(line.id) && !allocatedIds.has(line.id)) continue;
          const reserved = allocatedIds.has(line.id) ? (holdOf.get(line.id) ?? 0) : 0;
          if (reserved < line.qty) {
            stillShort.push({
              orderLineId: line.id,
              skuId: line.skuId,
              skuCode: plan.skuCode.get(line.skuId) ?? line.skuId,
              shortQty: fromMilli(line.qty - reserved),
            });
          }
        }
        const result: AllocationResult = { orderId: order.id, warehouseId: order.warehouseId, allocated, stillShort, skipped };
        if (allocated.length > 0) {
          await this.outbox.append(tx, {
            messageId: uuidv7(),
            tenantId: order.tenantId,
            type: 'order.allocated',
            occurredAt: updatedAt,
            payload: { allocation: result, entry: who.entry },
          });
          await tx.insert(auditEvents).values({
            id: uuidv7(),
            tenantId: order.tenantId,
            actorUserId: who.actorUserId,
            action: 'order.allocated',
            targetType: 'order',
            targetId: order.id,
            // The verb: the key; the job and the after-dispatch attempt: no
            // key (system work — the replenishment-sweep precedent).
            reference: who.key?.value ?? null,
            occurredAt: updatedAt,
          });
        }
        const snapshot: AllocateOrderSnapshot = { allocation: result };
        if (who.key !== null) {
          await this.writeIdempotencyKey(tx, order.tenantId, who.key.value, who.key.payloadHash, snapshot);
        }
        return {
          kind: 'written' as const,
          result,
          unitsReservedMilli,
          restores: await this.releaseInTx(tx, order, await this.unreferencedInTx(tx, order, all)),
        };
      });
    } catch (err) {
      // The write transaction failed: every FRESH grant goes back — under the
      // lock, and only when no line references it (one may be a concurrent
      // allocator's hold); an adopted orphan stays for the next run.
      await this.releaseUnreferencedUnderLock(
        order,
        grants.granted.filter((entry) => !entry.adopted).map((entry) => entry.hold),
        'write-failed',
      );
      throw err;
    }
  }

  /**
   * The journal half of releasing `holds` INSIDE the caller's transaction
   * (which holds the order lock); the counter restores are applied after the
   * commit (`applyRestores` — journal first, mirror second). A hold someone
   * else already ended is skipped (the facade's conditional release throws a
   * JS-level 409 the transaction survives — guide §1, 4-2b A5).
   */
  private async releaseInTx(tx: TenantTx, order: Order, holds: readonly ReservationSnapshot[]): Promise<Restore[]> {
    const restores: Restore[] = [];
    for (const hold of holds) {
      try {
        await this.inventory.releaseReservationInTx(tx, order.tenantId, hold.id);
        restores.push({ warehouseId: hold.warehouseId, skuId: hold.skuId, units: hold.quantity });
      } catch (err) {
        if (err instanceof ProblemException && err.getStatus() === 409) continue; // already ended (a cancel, the reaper)
        throw err;
      }
    }
    return restores;
  }

  /**
   * Code review C24/C25 — release the grants no line references, deciding
   * and releasing under the order lock in one transaction, so a concurrent
   * allocator can neither write a hold this releases nor have its written
   * hold released. Never throws (logged; a hold left over expires by TTL).
   */
  private async releaseUnreferencedUnderLock(order: Order, holds: readonly ReservationSnapshot[], cause: string): Promise<void> {
    if (holds.length === 0) return;
    try {
      const restores = await withTenantTransaction(this.db, order.tenantId, async (tx) => {
        await this.readOrder(tx, order.tenantId, order.id, true);
        return this.releaseInTx(tx, order, await this.unreferencedInTx(tx, order, holds));
      });
      await this.applyRestores(order.tenantId, restores);
    } catch (err) {
      this.logger.error(
        `Allocation ${cause}: releasing ${holds.length} grant(s) of order ${order.id} failed — ${err instanceof Error ? err.message : String(err)} (left to their TTL)`,
      );
    }
  }

  /** After the commit — the reserved-counter mirror of released holds; never throws. */
  private async applyRestores(tenantId: string, restores: readonly Restore[]): Promise<void> {
    for (const restore of restores) {
      try {
        await this.inventory.restoreReservedUnits(tenantId, restore.warehouseId, restore.skuId, restore.units);
      } catch (err) {
        this.logger.error(
          `Allocation: counter restore failed (sku ${restore.skuId}, ${restore.units} milli) — reserved over-counts until the next rebuild: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** A2 — the grants no line of the order references (read under the order lock). */
  private async unreferencedInTx(tx: TenantTx, order: Order, holds: readonly ReservationSnapshot[]): Promise<ReservationSnapshot[]> {
    if (holds.length === 0) return [];
    const rows = await tx
      .select({ reservationId: orderLines.reservationId })
      .from(orderLines)
      .where(and(eq(orderLines.tenantId, order.tenantId), eq(orderLines.orderId, order.id)));
    const referenced = new Set(rows.map((row) => row.reservationId).filter((id): id is string => id !== null));
    const seen = new Set<string>();
    return holds.filter((hold) => {
      if (referenced.has(hold.id) || seen.has(hold.id)) return false;
      seen.add(hold.id);
      return true;
    });
  }

  // ── idempotency (the 4.1 shape) ───────────────────────────────────────────────

  private async replay(tx: TenantTx, tenantId: string, key: string, payloadHash: string): Promise<AllocateOrderSnapshot | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot as AllocateOrderSnapshot;
  }

  private async writeIdempotencyKey(tx: TenantTx, tenantId: string, key: string, payloadHash: string, snapshot: unknown): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key, payloadHash, responseSnapshot: snapshot });
    } catch (err) {
      if (isUniqueViolationOn(err, 'idempotency_keys_tenant_id_key_unique')) {
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
}

/**
 * The sweep's candidate read (A18) — exported so a suite can `EXPLAIN` the
 * REAL query (the plan rides `orders_accepted_tenant_warehouse_idx`).
 */
export function backorderCandidatesSql(tenantId: string, todayIst: string, limit: number, offset = 0): SQL {
  return sql`
      select o.id as "id",
             (extract(epoch from coalesce((select r.created_at from orders r where r.tenant_id = o.tenant_id and r.id = o.follow_on_root_order_id), o.created_at)) * 1000)::bigint::text as "createdAtMs"
      from orders o
      where o.tenant_id = ${tenantId}::uuid
        and o.status = 'accepted'
        and not exists (
          select 1 from picklist_lines pl
          where pl.tenant_id = o.tenant_id and pl.order_id = o.id and pl.status <> 'cancelled')
        and exists (
          select 1 from order_lines ol
          where ol.tenant_id = o.tenant_id and ol.order_id = o.id
            and not exists (select 1 from order_lines c where c.tenant_id = ol.tenant_id and c.parent_line_id = ol.id)
            and (
              ol.reservation_id is null or ol.reserved_qty = 0
              or ol.updated_at <= now() - interval '7 days'
              or exists (
                select 1 from picklist_lines cl
                where cl.tenant_id = ol.tenant_id and cl.order_line_id = ol.id and cl.status = 'cancelled' and cl.updated_at > ol.updated_at)
            )
        )
      order by ${orderUrgencyOrderBy(todayIst, {
        priority: sql`o.priority`,
        shipByDate: sql`o.ship_by_date`,
        createdAt: sql`o.created_at`,
        id: sql`o.id`,
      })}
      limit ${limit}::int offset ${offset}::int
  `;
}

function skippedOf(line: OrderLine, reason: AllocationSkipReason, codes: ReadonlyMap<string, string>): SkippedLineResult {
  return { orderLineId: line.id, skuId: line.skuId, skuCode: codes.get(line.skuId) ?? line.skuId, reason };
}

function codeOf(error: ProblemException): string {
  const response = error.getResponse();
  return typeof response === 'object' && response !== null ? String((response as { code?: unknown }).code ?? 'conflict') : 'conflict';
}

/** A 409 from the grant the bounded re-probes did not absorb (a concurrent owner grant of another quantity). */
function isRaceLoss(err: unknown): boolean {
  return err instanceof ProblemException && err.getStatus() === 409;
}

function orderNotFound(orderId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Order not found', `No order with id "${orderId}" exists in this tenant.`);
}
