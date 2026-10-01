import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { SharedModule, AUTH_DATABASE } from '../shared/shared.module';
import type { Database } from '../shared/db/db';
import { OUTBOX_RELAY } from '../shared/events/outbox.seam';
import type { OutboxRelay } from '../shared/events/outbox.seam';
import { InventoryModule } from '../modules/inventory/inventory.module';
import { InventoryFacade } from '../modules/inventory/inventory.facade';
import { MovementsModule } from '../modules/movements/movements.module';
import { MovementsFacade, MAX_SCHEDULED_TASKS_PER_TICK } from '../modules/movements/transfer.facade';
import { ReplenishmentModule } from '../modules/replenishment/replenishment.module';
import { ReplenishmentFacade, MAX_REPLENISHMENT_SCOPES_PER_TICK } from '../modules/replenishment/replenishment.facade';

/** Per-cycle drain bound (AD-17): a cycle publishes at most this many rows. */
export const DEFAULT_OUTBOX_DRAIN_LIMIT = 100;

/**
 * The relay's poll interval, in milliseconds, from `OUTBOX_RELAY_POLL_MS`.
 * The worker is env-gated OFF when the variable is unset (or `0`) — tests
 * call `relay.drain()` directly and must not race a background drain for the
 * same rows. A deployment that wants delivery sets e.g. `2000`; any value
 * that is not a positive integer fails the boot loudly.
 */
export function parseOutboxPollMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `OUTBOX_RELAY_POLL_MS must be a non-negative integer of milliseconds (got "${raw}")`,
    );
  }
  return parsed;
}

/**
 * The reconciliation worker's poll interval, in milliseconds, from
 * `OUTBOX_RECONCILE_POLL_MS` — the same env-gate conventions as the relay
 * (unset/`0` is OFF; a non-negative integer is required or the boot fails
 * loudly; tests drive `reconcileNext()` directly).
 */
export function parseReconcilePollMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `OUTBOX_RECONCILE_POLL_MS must be a non-negative integer of milliseconds (got "${raw}")`,
    );
  }
  return parsed;
}

/**
 * The reservation reaper's poll interval, in milliseconds, from
 * `RESERVATION_REAPER_POLL_MS` — the same env-gate conventions as the relay
 * and reconciliation workers (unset/`0` is OFF; a non-negative integer is
 * required or the boot fails loudly; tests drive the facade's
 * `expireDueReservations()` directly).
 */
export function parseReservationReaperPollMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `RESERVATION_REAPER_POLL_MS must be a non-negative integer of milliseconds (got "${raw}")`,
    );
  }
  return parsed;
}

/**
 * The count scheduler's poll interval, in milliseconds, from
 * `COUNT_SCHEDULER_POLL_MS` — the same env-gate conventions as the relay /
 * reconciliation / reaper workers (unset/`0` is OFF — a deployment that
 * schedules cycle counts sets e.g. `3600000`; a non-negative integer is
 * required or the boot fails loudly; tests drive the facade's
 * `generateScheduledCountTasks()` directly).
 */
export function parseCountSchedulerPollMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `COUNT_SCHEDULER_POLL_MS must be a non-negative integer of milliseconds (got "${raw}")`,
    );
  }
  return parsed;
}

/**
 * The replenishment scheduler's poll interval, in milliseconds, from
 * `REPLENISHMENT_SCHEDULER_POLL_MS` — the same env-gate conventions as the
 * sibling workers (unset/`0` is OFF — a deployment that alerts on breaches
 * sets e.g. `60000` for FR-22's frozen ≤5-min bound with headroom; a
 * non-negative integer is required or the boot fails loudly; tests drive
 * the facade's `sweepScope()` and the worker's tick directly).
 */
export function parseReplenishmentPollMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `REPLENISHMENT_SCHEDULER_POLL_MS must be a non-negative integer of milliseconds (got "${raw}")`,
    );
  }
  return parsed;
}

// Story 10.4: the full-pass knob's parse helper is defined in
// `modules/inventory/reconcile.ts` and re-exported here beside
// `parseReconcilePollMs` so this worker shell's env-parse surface stays in
// one place. The DEFINITION cannot live here: the inventory module would
// have to import this file back to consume it, and that cycle breaks the
// NestJS boot under CJS (`Cannot access 'InvModule' before initialization`,
// verified — inventory.module loads before jobs.module in app.module.ts).
export {
  DEFAULT_RECONCILE_FULL_PASS_EVERY,
  parseReconcileFullPassEvery,
} from '../modules/inventory/reconcile';

/**
 * The outbox relay worker (story outbox-relay): an interval poll loop over
 * `OutboxRelay.drain()`. Sheddable twice over (AD-17): a cycle still in
 * flight makes the next tick skip, and `drain` itself sheds via its
 * session-level advisory lock when another relay instance holds the cycle.
 *
 * Delivery is at-least-once and the bus only logs today; failures surface in
 * the relay's logs and in `outbox_messages.attempts/next_attempt_at/
 * last_error` (IN-07 reads them later).
 */
@Injectable()
export class OutboxRelayWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('OutboxRelayWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(@Inject(OUTBOX_RELAY) private readonly relay: OutboxRelay) {
    this.pollMs = parseOutboxPollMs(process.env.OUTBOX_RELAY_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off (tests, or a deployment that drains elsewhere)
    }
    this.logger.log(`Outbox relay worker started (poll every ${this.pollMs}ms)`);
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // Never hold the process open on the timer alone: shutdown hooks end it.
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      const published = await this.relay.drain(DEFAULT_OUTBOX_DRAIN_LIMIT);
      if (published.length > 0) {
        this.logger.log(`Outbox relay drained ${published.length} message(s)`);
      }
    } catch (error) {
      this.logger.error(`Outbox relay drain failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}

/**
 * The reconciliation worker (story 2.2): an interval poll loop over
 * `InventoryFacade.reconcileNext()` — one (tenant, warehouse) partition per
 * tick, oldest-checkpoint-first. The mirror of `OutboxRelayWorker`: env-gated
 * OFF when `OUTBOX_RECONCILE_POLL_MS` is unset/`0` (tests drive
 * `reconcileNext()` directly and must not race a background cycle), shed via
 * the in-process `running` flag (one cycle at a time), `unref`'d timer, and a
 * shutdown hook. A failing cycle is logged and retried on the next tick —
 * detection must fail loudly, never silently.
 */
@Injectable()
export class ReconciliationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ReconciliationWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(@Inject(InventoryFacade) private readonly inventory: InventoryFacade) {
    this.pollMs = parseReconcilePollMs(process.env.OUTBOX_RECONCILE_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off (tests, or a deployment that reconciles elsewhere)
    }
    this.logger.log(`Reconciliation worker started (poll every ${this.pollMs}ms)`);
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // Never hold the process open on the timer alone: shutdown hooks end it.
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      const report = await this.inventory.reconcileNext();
      if (report !== null) {
        this.logger.log(
          `Reconciliation cycle tenant=${report.tenantId} warehouse=${report.warehouseId} ` +
            `watermark=${report.watermark} ` +
            (report.advanced
              ? `advanced (from ${report.previousSeq ?? 'none'})`
              : `divergences=${report.divergences.length}`),
        );
      }
    } catch (error) {
      this.logger.error(
        `Reconciliation cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}

/**
 * The reservation reaper (story 2.3): an interval poll loop over
 * `InventoryFacade.expireDueReservations()` — expires every held reservation
 * past its TTL (serialized conditional UPDATE, exactly one terminal winner)
 * and restores its reserved counter. The mirror of `ReconciliationWorker`:
 * env-gated OFF when `RESERVATION_REAPER_POLL_MS` is unset/`0` (tests drive
 * the facade directly), shed via the in-process `running` flag, `unref`'d
 * timer, and a shutdown hook. A failing cycle is logged and retried on the
 * next tick — expiry is Postgres-driven; Valkey key TTLs are a backstop only.
 */
@Injectable()
export class ReservationReaper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ReservationReaper');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(@Inject(InventoryFacade) private readonly inventory: InventoryFacade) {
    this.pollMs = parseReservationReaperPollMs(process.env.RESERVATION_REAPER_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off (tests, or a deployment that reaps elsewhere)
    }
    this.logger.log(`Reservation reaper started (poll every ${this.pollMs}ms)`);
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // Never hold the process open on the timer alone: shutdown hooks end it.
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      const expired = await this.inventory.expireDueReservations();
      if (expired > 0) {
        this.logger.log(`Reservation reaper expired ${expired} hold(s) past TTL`);
      }
    } catch (error) {
      this.logger.error(
        `Reservation reaper cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}

/**
 * The count scheduler worker (Story 5-3): an interval poll loop over
 * `MovementsFacade.generateScheduledCountTasks(tenantId, warehouseId, …)` —
 * one tick enumerates every (tenant, warehouse) that owns at least one ABC
 * policy cross-tenant (the reaper's `expireDue` read shape — an AUTH
 * connection, read-only), then generates that warehouse's due tasks in ONE
 * tenant transaction each (the matrix's all-or-nothing batch; a failing
 * warehouse is logged and retried next tick — the reaper's per-row
 * precedent). Env-gated OFF when `COUNT_SCHEDULER_POLL_MS` is unset/`0`
 * (tests drive the facade directly), shed via the in-process `running`
 * flag, `unref`'d timer, and a shutdown hook.
 */
@Injectable()
export class CountSchedulerWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('CountSchedulerWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    // The cross-tenant DUE enumeration read (BYPASSRLS — the reaper's
    // `authDb` precedent); every WRITE stays on the facade's tenant
    // transactions.
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(MovementsFacade) private readonly movements: MovementsFacade,
  ) {
    this.pollMs = parseCountSchedulerPollMs(process.env.COUNT_SCHEDULER_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off (tests, or a deployment that schedules elsewhere)
    }
    this.logger.log(`Count scheduler worker started (poll every ${this.pollMs}ms)`);
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // Never hold the process open on the timer alone: shutdown hooks end it.
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      // The cross-tenant enumeration (read-only — the reaper's
      // auth-time/connection shape): every warehouse owning at least one
      // policy, distinct. RLS scopes nothing here — the connection carries
      // BYPASSRLS precisely for these context-free reads.
      const scopes = (await this.authDb.execute(sql`
        select distinct on (tenant_id, warehouse_id)
          tenant_id as "tenantId", warehouse_id as "warehouseId"
        from count_policies
        order by tenant_id asc, warehouse_id asc
      `)) as unknown as { tenantId: string; warehouseId: string }[];
      let created = 0;
      for (const scope of scopes) {
        // One warehouse = one tenant transaction — all-or-nothing per
        // warehouse (the matrix's "partial failure → whole tick rolls
        // back", at the RLS boundary). A poison warehouse (a repeatedly
        // failing tx) must not starve the rest — log and retry next tick,
        // the reaper's per-row rationale.
        try {
          const taskIds = await this.movements.generateScheduledCountTasks(
            scope.tenantId,
            scope.warehouseId,
            MAX_SCHEDULED_TASKS_PER_TICK,
          );
          created += taskIds.length;
        } catch (error) {
          this.logger.error(
            `Count scheduler could not generate tasks for warehouse ${scope.warehouseId} — skipped this cycle: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (created > 0) {
        this.logger.log(`Count scheduler generated ${created} count task(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Count scheduler cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}

/**
 * The replenishment scheduler worker (stories 6.1 + 6.2): an interval poll
 * loop over the per-scope entries of `ReplenishmentFacade` — the breach sweep
 * (`sweepScope`) and, beside it on the SAME tick, the expiry/aging scan
 * (`scanScope`) — FR-22's detection loop and FR-23's, one scheduler. One tick
 * enumerates every (tenant, warehouse) scope that OWNS a reorder state or a
 * batch alert source, cross-tenant, as THREE queries (the spec's "queries,
 * not one guess"): the per-warehouse policy scopes, the warehouses of every
 * tenant carrying any SKU default > 0 (a tenant configuring only the
 * tenant-wide SKU columns must still be swept against each of its
 * warehouses), and every warehouse carrying batch on-hand on a batch-tracked
 * SKU UNION an open batch alert (the consumed-warehouse arm). The tick's
 * scope loop carries a per-tick cap
 * (`MAX_REPLENISHMENT_SCOPES_PER_TICK`, the count scheduler's
 * `MAX_SCHEDULED_TASKS_PER_TICK` precedent) with a truncation log line — and
 * the truncating ticks ROTATE the window (a head-only slice would starve the
 * enumerated tail forever, the order being deterministic), so scopes past the
 * cap are delayed a few ticks, never forgotten, and the frozen ≤5-min
 * visibility bound stays honest at scope counts larger
 * than one tick can carry. Each scope is all-or-nothing per evaluation (the
 * sweep's and the scan's own transactions; the scan has its OWN catch — a
 * failing sweep never skips the scan); a poison scope is logged and retried
 * next tick — a failure never starves the rest, and a Valkey-down ATP read
 * skips its sweep rather than ever reading 0. Env-gated OFF when
 * `REPLENISHMENT_SCHEDULER_POLL_MS` is unset/`0` (tests drive the facades
 * directly and one plumbing test drives
 * `tick()` itself), shed via the in-process `running` flag, `unref`'d timer,
 * and a shutdown hook.
 */
@Injectable()
export class ReplenishmentSchedulerWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ReplenishmentSchedulerWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** The truncating ticks' rotating-window offset (advances one scope per truncated tick). */
  private tickOffset = 0;

  constructor(
    // The cross-tenant scope enumeration read (BYPASSRLS — the count
    // scheduler's `authDb` precedent); every WRITE stays on the facade's
    // tenant transactions.
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(ReplenishmentFacade) private readonly replenishment: ReplenishmentFacade,
  ) {
    this.pollMs = parseReplenishmentPollMs(process.env.REPLENISHMENT_SCHEDULER_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off (tests, or a deployment that sweeps elsewhere)
    }
    this.logger.log(`Replenishment scheduler worker started (poll every ${this.pollMs}ms)`);
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // Never hold the process open on the timer alone: shutdown hooks end it.
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * The tick, exposed for the plumbing test (the worker drives the facades;
   * the test owns the enums). Package-private would be truer — the count
   * scheduler's test drove the bootstrap timer instead; this keeps the tick
   * directly callable.
   */
  async tick(): Promise<void> {
    if (this.running) {
      return; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      // ── the three scope queries (6.1's "two queries, not one guess", plus
      // 6.2's third: the expiry scan rides the SAME tick — "a scope, a query,
      // and one call") ──
      // 1. every warehouse owning a per-warehouse reorder policy;
      const policyScopes = (await this.authDb.execute(sql`
        select distinct on (tenant_id, warehouse_id)
          tenant_id as "tenantId", warehouse_id as "warehouseId"
        from reorder_policies
        order by tenant_id asc, warehouse_id asc
      `)) as unknown as { tenantId: string; warehouseId: string }[];
      // 2. every warehouse of every tenant carrying at least one SKU with a
      //    tenant-wide default > 0 (reorder point OR qty — a point of 0 with
      //    a qty is not an alert source, but the scope's SKUs all reading an
      //    effective point of 0 short-circuits inside the sweep anyway).
      const defaultScopes = (await this.authDb.execute(sql`
        select distinct w.tenant_id as "tenantId", w.id as "warehouseId"
        from skus s
        join warehouses w on w.tenant_id = s.tenant_id
        where s.reorder_point > 0 or s.reorder_qty > 0
        order by w.tenant_id asc, w.id asc
      `)) as unknown as { tenantId: string; warehouseId: string }[];
      // 3. every warehouse carrying batch on-hand on a BATCH-TRACKED SKU
      //    (the expiry scan's alert sources — the projection's positive rows
      //    are the only scopes a batch alert can detect against), UNION every
      //    warehouse with an OPEN batch alert — the consumed-warehouse arm:
      //    once a warehouse's LAST positive batch row is gone its on-hand
      //    query would never name it again, and the auto-resolve of its open
      //    alerts (on-hand 0) would never run. The union keeps them swept
      //    until every alert settles. The dedupe map below absorbs any
      //    overlap with queries 1-2.
      const batchScopes = (await this.authDb.execute(sql`
        select tenant_id as "tenantId", warehouse_id as "warehouseId" from (
          select bo.tenant_id, bo.warehouse_id
          from batch_on_hand bo
          join skus s on s.tenant_id = bo.tenant_id and s.id = bo.sku_id
          where bo.quantity > 0 and s.batch_tracked
          union
          select a.tenant_id, a.warehouse_id
          from batch_alerts a
          where a.status = 'open'
        ) scopes
        order by tenant_id asc, warehouse_id asc
      `)) as unknown as { tenantId: string; warehouseId: string }[];

      // Deduped union, deterministic order (policy scopes first — a
      // configured override is the sharpest alert source — then defaults,
      // then batch-scope sources).
      const scopes = new Map<string, { tenantId: string; warehouseId: string }>();
      for (const scope of [...policyScopes, ...defaultScopes, ...batchScopes]) {
        scopes.set(`${scope.tenantId}|${scope.warehouseId}`, scope);
      }
      const ordered = [...scopes.values()];

      // The per-tick scope cap with a ROTATING window: the enumeration is
      // deterministically ordered, so a head-only slice would carry the SAME
      // head every tick and starve everything past the cap forever. Each
      // truncating tick instead carries a wrap-around window starting one
      // scope further than the last — every scope is swept within
      // ⌈ordered.length / cap⌉ ticks, and the truncation stays LOUDLY
      // quantified (the frozen ≤5-min bound stays known, not overrun).
      const carried =
        ordered.length <= MAX_REPLENISHMENT_SCOPES_PER_TICK
          ? ordered
          : this.rotatingWindow(ordered, MAX_REPLENISHMENT_SCOPES_PER_TICK);
      if (ordered.length > carried.length) {
        this.logger.warn(
          `Replenishment scheduler carried ${carried.length} of ${ordered.length} scope(s) this tick ` +
            `— the rotating window advances each tick until every scope is swept`,
        );
      }

      for (const scope of carried) {
        // One scope = each evaluation's own tenant transactions —
        // all-or-nothing per phase. A poison scope (a repeatedly failing tx,
        // or a Valkey down mid-ATP) must not starve the rest — log and retry
        // next tick, the count scheduler's per-scope rationale.
        try {
          await this.replenishment.sweepScope(scope.tenantId, scope.warehouseId);
        } catch (error) {
          this.logger.error(
            `Replenishment scheduler could not sweep warehouse ${scope.warehouseId} — skipped this cycle: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // The expiry/aging scan rides the SAME tick, its OWN catch: a sweep
        // failure (a Valkey down) must not skip the expiry scan — the two
        // evaluations share a scope, never a failure domain.
        try {
          await this.replenishment.scanScope(scope.tenantId, scope.warehouseId);
        } catch (error) {
          this.logger.error(
            `Replenishment scheduler could not scan warehouse ${scope.warehouseId} for expiry/aging — skipped this cycle: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Replenishment scheduler cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * The cap's rotating window — `cap` entries of the deterministically-ordered
   * enumeration, starting at this worker's tick offset and wrapping around the
   * cycle, the offset advancing one scope per TRUNCATED tick. Over
   * ⌈length / cap⌉ + length ticks every scope is swept (in fact the whole
   * cycle is covered once the offset has advanced `length - cap + 1` times),
   * so scopes past the cap are delayed, never starved — the head-only slice
   * this replaced never swept them at all.
   */
  private rotatingWindow(
    ordered: readonly { tenantId: string; warehouseId: string }[],
    cap: number,
  ): { tenantId: string; warehouseId: string }[] {
    const start = this.tickOffset % ordered.length;
    const window: { tenantId: string; warehouseId: string }[] = [];
    for (let i = 0; i < cap && i < ordered.length; i += 1) {
      const scope = ordered[(start + i) % ordered.length];
      if (scope !== undefined) {
        window.push(scope);
      }
    }
    this.tickOffset = (this.tickOffset + 1) % ordered.length;
    return window;
  }
}

/**
 * jobs shell — background/relay workers (outbox relay, reconciliation,
 * reservation reaper, count scheduler, replenishment scheduler, import
 * batches, notifications dispatch). The event bus + outbox seams live in
 * shared/events and are provided by SharedModule. All workers are env-gated
 * OFF unless `OUTBOX_RELAY_POLL_MS` / `OUTBOX_RECONCILE_POLL_MS` /
 * `RESERVATION_REAPER_POLL_MS` / `COUNT_SCHEDULER_POLL_MS` /
 * `REPLENISHMENT_SCHEDULER_POLL_MS` is set (tests exercise `drain()` /
 * `reconcileNext()` / `expireDueReservations()` /
 * `generateScheduledCountTasks()` / `sweepScope()` directly, plus one
 * plumbing test driving `ReplenishmentSchedulerWorker.tick()` itself).
 */
@Module({
  imports: [SharedModule, InventoryModule, MovementsModule, ReplenishmentModule],
  providers: [
    OutboxRelayWorker,
    ReconciliationWorker,
    ReservationReaper,
    CountSchedulerWorker,
    ReplenishmentSchedulerWorker,
  ],
  exports: [],
})
export class JobsModule {}
